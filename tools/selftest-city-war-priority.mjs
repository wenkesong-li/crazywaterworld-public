// 城战优先级回归：隔离账号、假客户端、真实协议，不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-city-priority-'));
const previousDataDir = process.env.CW_DATA_DIR;
const previousResourceDir = process.env.CW_RESOURCE_DIR;
process.env.CW_DATA_DIR = path.join(directory, 'data');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
fs.mkdirSync(process.env.CW_DATA_DIR);
const { warForgeFixture, warForgeSettings } = await import('./fixtures/war-forge.mjs');
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { readCityWar, planCityWar, cityWarReservedFleets, refreshCityWarReservations } = await import('../src/city-war.mjs');
const { reserveDispatch, dispatchReservationReason } = await import('../src/fleet-availability.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { createChallengeRun } = await import('../src/challenge-automation.mjs');

const realNow = Date.now;
let sequence = 0;
const results = [];
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false }); console.error('失败：' + name + '\n' + error.stack); }
};
const ledger = () => createUsageLedger('模拟城战优先级账号', { file: path.join(directory, 'usage-' + (++sequence) + '.json') });
const read = (f, settings) => readCityWar(f.client, f.protocol, f.config, f.player, settings.cityWar, { mapLoader: f.mapLoader });
const preview = async (f, settings) => planCityWar(await read(f, settings), settings);
const multilateral = f => {
  f.state.war.declarations.push({ attackGuildIdx: 9, defenceGuildIdx: 8, cityId: 2 });
  f.state.cities.find(city => city.id === 2).attackFleetNum = 1;
};
const mapFile = path.join(directory, 'map.json');
fs.writeFileSync(mapFile, JSON.stringify([null, null, null, null, null, [[null, null, {
  mapInfo: { width: 10, height: 10, tileWidth: 100, tileHeight: 75 },
  cityInfo: { 1: { gridIdx: 0 }, 2: { gridIdx: 1 }, 3: { gridIdx: 10 } },
  mapData: Array(100).fill(0),
}]]]));

// 首杀与城战在同一假连接、同一完整 runLoop 中竞争一队。所有新增
// 请求/响应也经过实际 protobuf 编解码，不能用未声明写操作掩盖失败。
async function dispatchRound({ beforeWar = false, unknownCounts = false, openingRead = 0, reserve = true } = {}) {
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger(), challengeRun = createChallengeRun();
    const start = Math.floor(clock / 1000) + (beforeWar || openingRead ? 5 : -60);
    f.state.war.startTime = start;
    f.state.war.endTime = start + 3600;
    if (unknownCounts) multilateral(f);
    settings.forge.enabled = false;
    Object.assign(settings.cityWar, { fleetIds: ['1远征船'], autoRepair: false, reserveDuringWar: reserve });
    Object.assign(settings.pirateHunt, {
      enabled: true, fleetIds: ['1远征船'], types: ['1'], maxLevel: 3,
      minDurabilityPercent: 80, petrolReserve: 0, fuelBudget: 3000,
    });
    f.config.resources = { mapFiles: { 1: mapFile } };
    f.config.tables.WorldPirateCfg = { data: [1, 2, 3].map(level => ({ season: 1, type: 1, level, showName: '模拟海盗', power: 1 })) };
    f.config.tables['1_SeasonTaskCfg'] = { data: [{ season: 1, stage: 1, maxPirateLevel: 3 }] };
    f.config.tables.WorldParamCfg.data.push({ paramName: '打野怪消耗汽油', paramValue: 300 });
    const request = f.client.request, send = f.client.sendWatch;
    let pirateReads = 0;
    const trace = [];
    const wire = (name, body) => f.protocol[name].decode(f.protocol[name].encode(body).finish());
    f.client.request = async (name, body = {}, response = name.replace(/Request$/, 'Response')) => {
      wire(name, body);
      if (name === 'PirateKillRecordRequest' && ++pirateReads === openingRead) clock = (start + 1) * 1000;
      trace.push({ name, time: Math.floor(clock / 1000) });
      if (name === 'SeasonTaskStageRequest') return wire(response, { stage: 1 });
      if (name === 'PirateKillRecordRequest') return wire(response, { records: [{ type: 1, maxKilledLevel: 0 }] });
      if (name === 'AllPirateRequest') return wire(response, { pirates: [{ uid: 201, type: 1, level: 1, cityId: 2, gridIdx: 22 }] });
      return request(name, body, response);
    };
    f.client.sendWatch = async (name, body) => {
      wire(name, body);
      trace.push({ name, time: Math.floor(clock / 1000), write: true });
      if (name === 'ChallengePirateRequest') {
        f.client.writes.push({ name, body });
        f.state.fuel -= 300;
        Object.assign(f.state.fleets[0], { state: 2, targetGridIdx: 22, targetCityId: 2 });
        f.client.emit('message', { name: 'SCMyFleetUpdate', body: wire('SCMyFleetUpdate', { fleets: [f.state.fleets[0]] }) });
        return;
      }
      return send(name, body);
    };
    await runLoop(f.client, f.protocol, {
      config: f.config, player: f.player, rounds: 1, allowMutate: true,
      getSettings: () => settings, usageLedger: usage, isEnabled: () => false, challengeRun,
    });
    return { writes: f.client.writes, trace, pirateReads, start, settings, usage: usage.snapshot(), pirate: challengeRun.pirate.state };
  } finally { Date.now = realNow; }
}

try {
  await check('巨轮和城战按各自服务器时刻提前召回选中矿队，采矿开关关闭也可执行', async () => {
    for (const [source, scenario] of [['treasure','ready'],['cityWar','ready'],['cityWar','firstReward'],
      ['treasure','rescheduled'], ['cityWar','disabled'], ['treasure','noTime'], ['cityWar','mining']]) {
      const base = Date.UTC(2026,10,20,3);
      let clock = base;
      Date.now = () => clock;
      try {
        const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger(), retreats = [];
        f.client.serverClockOffsetMs = 7000;
        const start = (base + 7000) / 1000 + 70;
        f.state.stats.nextRefreshTime = scenario === 'noTime' ? 0 : start;
        f.state.targets = [];
        f.state.war = { startTime: start, endTime: start + 3600, declarations: [] };
        f.config.resources = { mapFiles: { 1: mapFile } };
        f.config.tables.GameplayOpenCfg.data.push({ gameplay: '芯片', openDays: [1] });
        f.config.tables.WorldParamCfg.data.push({ paramName: '采集硅矿消耗汽油', paramValue: 500 });
        f.config.tables.ChipMineCfg = { data: [{ quality: 'ORANGE', qualityIndex: 5, name: '测试硅矿' }] };
        settings.forge.enabled = settings.cityWar.reserveDuringWar = settings.cityWar.autoRepair = false;
        settings.cityWar.enabled = source === 'cityWar';
        settings.treasure.enabled = settings.treasure.autoJoin = source === 'treasure';
        Object.assign(settings[source], { recallSilicon: scenario !== 'disabled', recallLeadMinutes: 1, checkEverySeconds: 300, fleetIds: ['1远征船'] });
        if (scenario === 'mining') {
          settings.silicon.enabled = settings.silicon.fleets[0].enabled = true;
          settings.fleetDispatch.priority = ['silicon','cityWar'];
        }
        const reward = { myRewardTimes: 1, rewardResetTime: start + 3600, maxRewardTimes: 100 };
        const positions = f.state.fleets.slice(0,2).map((fleet, index) => {
          Object.assign(fleet, { state: 5, curGridIdx: 5000, chipWar: { rewardTs: scenario === 'firstReward' ? start - 45 : start + 900 } });
          return { index, player: { fleetId: fleet.buildingId, avatar: {}, nickname: f.player.nickname, guildIdx: 7, power: 1000, rewardTimes: 1 } };
        });
        const request = f.client.request, send = f.client.sendWatch;
        f.client.request = async (name, body = {}, reply = name.replace(/Request$/, 'Response')) => {
          let response;
          if (name === 'ChipMineRequest' && scenario === 'rescheduled') f.state.stats.nextRefreshTime = start + 3600;
          if (name === 'ChipMineRequest' && scenario === 'firstReward') positions.forEach(p => { p.player.rewardTimes = Number(clock - base >= 25000); });
          if (name === 'ChipMineListRequest') response = { chipMines: [{ color: 5, gridId: 5000, occupiedNum: positions.length, positionNum: 3 }] };
          else if (name === 'ChipMineRewardRequest') response = { rewardInfo: reward };
          else if (name === 'ChipMineRequest') response = { occupiedPositions: positions, occupiedNum: positions.length, positionNum: 3, fightTimes: 0, maxFightTimes: 30, rewardInfo: reward };
          else return request(name, body, reply);
          return f.protocol[reply].decode(f.protocol[reply].encode(response).finish());
        };
        f.client.sendWatch = async (name, body) => {
          if (name !== 'ChipMineRetreatRequest') return send(name, body);
          retreats.push([body.fleetId, clock - base]);
          positions.splice(positions.findIndex(p => p.player.fleetId === body.fleetId),1);
          Object.assign(f.state.fleets[0], { state: 2, startGridIdx: 5000, targetGridIdx: 700, targetCityId: 1,
            chipWar: null, moveStartTs: start - 60, moveEndTs: start - 20 });
        };
        await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 2, everyMs: 70000,
          allowMutate: true, getSettings: () => settings, usageLedger: usage, isEnabled: () => false,
          sleep: async ms => { assert(ms > 0); clock += ms;
            if (retreats.length && (scenario === 'mining' || clock - base >= 50000)) {
              Object.assign(f.state.fleets[0], { state: 1, targetGridIdx: 0, curGridIdx: 0 });
              if (scenario === 'mining') f.client.emit('message', { name: 'SCMyFleetUpdate', body: { fleets: [f.state.fleets[0]] } });
            } } });
        const shouldRecall = ['ready','firstReward','mining'].includes(scenario);
        assert.deepEqual(retreats, shouldRecall ? [['1远征船', scenario === 'firstReward' ? 25000 : 10000]] : [], source + scenario);
        assert.deepEqual(positions.map(p => p.player.fleetId), shouldRecall ? ['2远征船'] : ['1远征船','2远征船']);
        assert(!usage.hasKey('silicon-retreat:' + f.player.worldId + ':1'), '开战时已归队的矿队必须解除占用');
      } finally { Date.now = realNow; }
    }
  });
  await check('主轮跨开战和货轮刷新时按优先级接续，轮间分别按刷新和停战时间扫描', async () => {
    for (const reserve of [false, true]) {
      const hour = Date.UTC(2026, 10, 20, 2), base = hour - 12000;
      let clock = base, queueSlot = 0, inQueue = false;
      Date.now = () => clock;
      try {
        const f = warForgeFixture(), settings = warForgeSettings(), trace = [];
        f.config.resources = { mapFiles: { 1: mapFile } };
        f.client.serverClockOffsetMs = 7000;
        f.state.targets = [];
        f.state.war = { startTime: hour / 1000, endTime: hour / 1000 + 7, declarations: [] };
        f.state.stats.nextRefreshTime = hour / 1000;
        settings.forge.enabled = false;
        settings.loop.dailies = settings.dailies.enabled = settings.schedule.freeGold = true;
        Object.assign(settings.treasure, { enabled: true, autoJoin: true, follow: false, autoRepair: false, checkEverySeconds: 300 });
        Object.assign(settings.cityWar, { autoRepair: false, reserveDuringWar: reserve, checkEverySeconds: 300 });
        settings.fleetDispatch.priority = ['treasure', 'cityWar'];
        f.beforeRead = name => {
          assert(inQueue);
          if (name === 'WarDeclarationRequest') trace.push(['war', clock - base, queueSlot]);
          if (name === 'TreasureLootStatsRequest') {
            trace.push(['ship', clock - base, queueSlot]);
            if (clock - base === 7000) f.state.stats.nextRefreshTime = hour / 1000 + 4;
          }
          if (name === 'DailyTaskInfoRequest' && clock === base) {
            trace.push(['daily', 0, queueSlot]);
            clock += 7000;
            if (reserve) for (let i = 0; i < 5; i++) f.client.emit('message', { name: 'SCTreasureLootRefresh', body: {} });
          }
        };
        await runLoop(f.client, f.protocol, {
          config: f.config, player: f.player, rounds: 2, everyMs: 14000, allowMutate: true,
          usageLedger: ledger(), getSettings: () => settings, isEnabled: key => key === 'freeGold',
          schedule: async work => {
            assert(!inQueue); inQueue = true; queueSlot++;
            try { return await work(); } finally { inQueue = false; }
          },
          sleep: async ms => { assert(!inQueue && ms > 0); clock += ms; },
        });
        const order = reserve ? ['war', 'ship'] : ['ship', 'war'];
        assert.deepEqual(trace.map(([task, at]) => [task, at]), [
          ...order.map(task => [task, 0]), ['daily', 0], ...order.map(task => [task, 7000]),
          ['ship', 9000], ['war', 12000],
        ]);
        assert(trace[3][2] > trace[2][2], '耗时日常完成后让出队列，优先检查到期业务');
        assert.deepEqual(f.client.writes, []);
      } finally { Date.now = realNow; }
    }
  });
  await check('主轮业务未返回时货轮和宣战推送触发只读扫描，写操作等待串行复核', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    f.config.resources = { mapFiles: { 1: mapFile } };
    settings.forge.enabled = settings.cityWar.autoRepair = false;
    settings.loop.dailies = settings.dailies.enabled = settings.schedule.freeGold = true;
    Object.assign(settings.treasure, { enabled: true, autoJoin: true, autoRepair: false });
    f.state.targets = []; f.state.war.declarations = [];
    let insideRead = false, waiting = false, finish;
    const seen = [];
    const scanned = new Promise(resolve => { finish = resolve; });
    f.client.interleaveRead = async work => {
      assert(!insideRead);
      insideRead = true;
      try { return await work(); } finally { insideRead = false; finish(); }
    };
    f.beforeRead = async name => {
      if (insideRead) { assert(waiting); seen.push(name); }
      if (name !== 'DailyTaskInfoRequest') return;
      waiting = true;
      for (const event of ['SCWarDeclaration', 'SCTreasureLootRefresh', 'SCTreasureLootRefresh']) {
        f.client.emit('message', { name: event, body: {} });
      }
      let limit;
      try {
        await Promise.race([scanned, new Promise((_, reject) => {
          limit = setTimeout(() => reject(Error('只读扫描仍在等待主轮结束')), 2000);
        })]);
      } finally { clearTimeout(limit); waiting = false; }
    };
    await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
      getSettings: () => settings, usageLedger: ledger(), isEnabled: key => key === 'freeGold' });
    assert.deepEqual(seen.sort(), ['TreasureLootListRequest', 'TreasureLootStatsRequest', 'WarDeclarationRequest']);
    assert.deepEqual(f.client.writes, []);
  });
  await check('城战休战时等待开战，时段变更推送提前重排，战时恢复固定扫描', async () => {
    const base = Date.UTC(2026, 10, 20, 2), stop = new AbortController();
    let clock = base;
    Date.now = () => clock;
    try {
      const f = warForgeFixture(), settings = warForgeSettings(), waits = [], reads = [];
      f.config.resources = { mapFiles: { 1: mapFile } };
      settings.forge.enabled = settings.cityWar.autoRepair = false;
      f.state.war = { startTime: base / 1000 + 900, endTime: base / 1000 + 1800, declarations: [] };
      f.beforeRead = name => { if (name === 'WarDeclarationRequest') reads.push(clock - base); };
      await runLoop(f.client, f.protocol, {
        config: f.config, player: f.player, rounds: 0, everyMs: 3600000, allowMutate: true, stop: stop.signal,
        getSettings: () => settings, usageLedger: ledger(), isEnabled: () => false,
        sleep: async ms => {
          waits.push(ms);
          if (waits.length === 1) {
            clock += 20000;
            f.state.war.startTime = clock / 1000 + 60;
            f.client.emit('message', { name: 'SCCityWarTime', body: f.state.war });
          } else if (waits.length === 2) clock += ms;
          else stop.abort();
        },
      });
      assert.deepEqual(waits, [900000, 60000, 15000]);
      assert.deepEqual(reads, [0, 20000, 80000]);
    } finally { Date.now = realNow; }
  });
  await check('维修加速补满后同轮刷新占用并接续城战，不再等15秒检查周期',async()=>{
    let clock=Math.floor(realNow()/1000)*1000;Date.now=()=>clock;
    const stop=new AbortController();
    try{
      const f=warForgeFixture(),settings=warForgeSettings(),usage=ledger();f.client.setMaxListeners(32);
      settings.forge.enabled=false;Object.assign(settings.cityWar,{fleetIds:['1远征船'],nativeCommissionLimit:0,checkEverySeconds:15});
      settings.resources.allowDiamonds=true;
      Object.assign(settings.fleetSpeed.fleets[0],{repair:true,repairDailyDiamonds:100});
      f.config.resources={mapFiles:{1:mapFile}};f.config.tables.SpeedUpRubyCfg={data:[{minute:0,fleet:10},{minute:60,fleet:20}]};
      Object.assign(f.state.fleets[0],{state:4,durability:1900,repairing:{startTs:clock/1000-100,endTs:clock/1000+121,endDura:2000}});
      const send=f.client.sendWatch;let repairedAt=null,dispatchedAt=null,sleeps=0;
      f.client.sendWatch=async(name,body)=>{
        if(name==='SpeedUpRepairRequest'){
          f.protocol[name].decode(f.protocol[name].encode(body).finish());f.client.writes.push({name,body});f.finishRepair(body.buildingId);repairedAt=clock;return;
        }
        await send(name,body);if(name==='MoveFleetsToCityRequest')dispatchedAt=clock;
      };
      await runLoop(f.client,f.protocol,{config:f.config,player:f.player,rounds:0,everyMs:60000,stop:stop.signal,
        allowMutate:true,isEnabled:()=>false,getSettings:()=>settings,usageLedger:usage,
        sleep:async ms=>{clock+=ms;if(++sleeps>12)stop.abort();},
        onStep:entry=>{if(entry.step?.kind==='cityDispatch'&&entry.status==='confirmed')stop.abort();}});
      assert(repairedAt!==null);assert.equal(dispatchedAt,repairedAt,'维修已确认后应当同轮派遣');
      assert.equal(f.client.writes.filter(w=>w.name==='SpeedUpRepairRequest').length,1);
    }finally{stop.abort();Date.now=realNow;}
  });
  await check('多联盟进攻人数未知仍预留城战舰队，不能借给首杀', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    multilateral(f);
    const snapshot = await read(f, settings), plan = planCityWar(snapshot, settings);
    assert.equal(snapshot.targets[0].alliedCount, null);
    assert.equal(plan.actions.length, 0);
    assert.deepEqual(plan.reservedFleetIds, ['1远征船', '2远征船']);
    assert.deepEqual(plan.reservedFleetIds, cityWarReservedFleets(snapshot, settings));
  });

  await check('在途舰队未同步时继续保留城战预留', async () => {
    const f = warForgeFixture(), settings = warForgeSettings(), request = f.client.request;
    f.client.request = async (...args) => {
      const value = await request(...args);
      if (args[0] === 'WorldInfoRequest') value.fleets = undefined;
      return value;
    };
    const snapshot = await read(f, settings), plan = planCityWar(snapshot, settings);
    assert.equal(snapshot.targets[0].transitCount, null);
    assert.equal(plan.actions.length, 0);
    assert.deepEqual(plan.reservedFleetIds, ['1远征船', '2远征船']);
  });

  await check('进攻与防守目标人数均未知时按分工保留两队', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    settings.cityWar.defenceFleetIds = ['2远征船'];
    multilateral(f);
    Object.assign(f.state.cities.find(city => city.id === 3), {
      guildIdx: 7, battlePoints: [{ index: 0, rightFighter: { guildIdx: 9, isNpc: false } }],
    });
    f.state.war.declarations.push({ attackGuildIdx: 8, defenceGuildIdx: 7, cityId: 3 });
    const snapshot = await read(f, settings), plan = planCityWar(snapshot, settings);
    assert(snapshot.targets.every(target => target.alliedCount === null));
    assert.equal(plan.actions.length, 0);
    assert.deepEqual(plan.reservedFleetIds, ['1远征船', '2远征船']);
  });

  await check('人数未知时只预留有对应职责目标的舰队', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    settings.cityWar.defenceFleetIds = ['2远征船'];
    multilateral(f);
    assert.deepEqual((await preview(f, settings)).reservedFleetIds, ['1远征船']);
  });

  await check('没有对应宣战或指定城市不匹配时不预留闲置舰队', async () => {
    for (const change of [
      (f) => { f.state.war.declarations = []; },
      (_f, settings) => { settings.cityWar.defenceFleetIds = ['1远征船', '2远征船']; },
      (_f, settings) => { settings.cityWar.targetMode = 'selected'; settings.cityWar.cityRefs = ['1:3']; },
    ]) {
      const f = warForgeFixture(), settings = warForgeSettings();
      change(f, settings);
      assert.deepEqual((await preview(f, settings)).reservedFleetIds, []);
    }
  });

  await check('城战未开始或已经结束时不预留空闲舰队', async () => {
    for (const state of ['before', 'after']) {
      const f = warForgeFixture(), settings = warForgeSettings(), now = Math.floor(Date.now() / 1000);
      Object.assign(f.state.war, state === 'before' ? { startTime: now + 3600, endTime: now + 7200 } : { startTime: now - 7200, endTime: now - 3600 });
      assert.deepEqual((await preview(f, settings)).reservedFleetIds, []);
    }
  });

  await check('关闭城战或关闭时段预留时不强占其它玩法舰队', async () => {
    for (const field of ['enabled', 'reserveDuringWar']) {
      const f = warForgeFixture(), settings = warForgeSettings();
      settings.cityWar[field] = false;
      multilateral(f);
      assert.deepEqual((await preview(f, settings)).reservedFleetIds, []);
    }
  });

  await check('原生委任额度为零时直接接续并保留所选城战舰队', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    f.config.tables.VipLevelCfg.data.find(row => row.level === 3).effects = [];
    const plan = await preview(f, settings);
    assert.deepEqual(plan.actions.map(step => step.buildingId), ['1远征船', '2远征船']);
    assert.deepEqual(plan.nativeOffFleetIds, []);
    assert.deepEqual(plan.reservedFleetIds, ['1远征船', '2远征船']);
  });

  await check('共享预留读取横跨开战时刻时按完成时间保留舰队且不派城战', async () => {
    let clock = realNow(); Date.now = () => clock;
    try {
      const f = warForgeFixture(), settings = warForgeSettings(), offset = 120000;
      f.client.serverClockOffsetMs = offset;
      const start = Math.floor((clock + offset) / 1000) + 5;
      f.config.resources = { mapFiles: { 1: mapFile } };
      f.state.war.startTime = start; f.state.war.endTime = start + 3600;
      f.beforeRead = async name => { if (name === 'WorldInfoRequest') clock = (start + 1) * 1000 - offset; };
      await refreshCityWarReservations(f.client, f.protocol, f.config, f.player, () => settings);
      assert.match(dispatchReservationReason(f.client, settings, 'pirateHunt', '1远征船'), /城战/);
      assert.deepEqual(f.client.writes, []);
    } finally { Date.now = realNow; }
  });

  await check('共享预留读取横跨结束时刻时释放旧城战意向', async () => {
    let clock = realNow(); Date.now = () => clock;
    try {
      const f = warForgeFixture(), settings = warForgeSettings(), end = Math.floor(clock / 1000) + 5;
      f.config.resources = { mapFiles: { 1: mapFile } };
      f.state.war.endTime = end;
      reserveDispatch(f.client, 'cityWar', ['1远征船']);
      f.beforeRead = async name => { if (name === 'WorldInfoRequest') clock = (end + 1) * 1000; };
      await refreshCityWarReservations(f.client, f.protocol, f.config, f.player, () => settings);
      assert.equal(dispatchReservationReason(f.client, settings, 'pirateHunt', '1远征船'), '');
      assert.deepEqual(f.client.writes, []);
    } finally { Date.now = realNow; }
  });

  await check('共享预留检查中设置被替换时标记未发送且不派遣', async () => {
    const f = warForgeFixture(); let settings = warForgeSettings();
    f.config.resources = { mapFiles: { 1: mapFile } };
    f.beforeRead = async name => { if (name === 'WarDeclarationRequest') settings = structuredClone(settings); };
    await assert.rejects(refreshCityWarReservations(f.client, f.protocol, f.config, f.player, () => settings), error => {
      assert.equal(error.notSent, true); return /设置或连接已变化/.test(error.message);
    });
    assert.deepEqual(f.client.writes, []);
  });

  await check('共享预留检查中连接断开时标记未发送且不派遣', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    f.config.resources = { mapFiles: { 1: mapFile } };
    f.beforeRead = async name => { if (name === 'WarDeclarationRequest') f.client.connected = false; };
    await assert.rejects(refreshCityWarReservations(f.client, f.protocol, f.config, f.player, () => settings), error => {
      assert.equal(error.notSent, true); return /设置或连接已变化/.test(error.message);
    });
    assert.deepEqual(f.client.writes, []);
  });

  await check('关闭城战时段预留会真正清除旧意向，重新打开前不残留', async () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    f.config.resources = { mapFiles: { 1: mapFile } };
    reserveDispatch(f.client, 'cityWar', ['1远征船']);
    settings.cityWar.reserveDuringWar = false;
    await refreshCityWarReservations(f.client, f.protocol, f.config, f.player, () => settings);
    // 临时恢复开关仅用于检测缓存是否已清除，不能只依赖关闭开关时的读取门控。
    settings.cityWar.reserveDuringWar = true;
    assert.equal(dispatchReservationReason(f.client, settings, 'pirateHunt', '1远征船'), '');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.client.writes, []);
  });

  await check('完整挂机在正常城战窗口只派城战，不派首杀', async () => {
    const result = await dispatchRound();
    assert.equal(result.settings.fleetDispatch.priority[0], 'cityWar');
    assert(result.writes.some(row => row.name === 'MoveFleetsToCityRequest'));
    assert(!result.writes.some(row => row.name === 'ChallengePirateRequest'));
    assert.equal(result.usage.counters.piratePetrol ?? 0, 0);
  });

  await check('完整挂机遇多联盟人数未知时等待，不派首杀且不扣汽油', async () => {
    const result = await dispatchRound({ unknownCounts: true });
    assert.deepEqual(result.writes, []);
    assert.equal(result.usage.counters.piratePetrol ?? 0, 0);
    assert.equal(result.usage.uncertain, 0);
  });

  await check('首次首杀读取期间进入城战时段时重新预留并取消派遣', async () => {
    const result = await dispatchRound({ openingRead: 1 });
    assert(result.trace.some(row => row.name === 'PirateKillRecordRequest' && row.time >= result.start));
    assert(!result.writes.some(row => row.name === 'ChallengePirateRequest'));
    assert.match(result.pirate.reason, /城战/);
    assert.equal(result.usage.counters.piratePetrol ?? 0, 0);
    assert.equal(result.usage.uncertain, 0);
  });

  await check('最终复核读取期间进入城战时段时发送前再次预留', async () => {
    const result = await dispatchRound({ openingRead: 2 });
    assert(result.pirateReads >= 2, '必须到达 startPirateHunt 的第二次实际目标读取');
    assert(!result.writes.some(row => row.name === 'ChallengePirateRequest'));
    assert.match(result.pirate.reason, /城战/);
    assert.equal(result.usage.counters.piratePetrol ?? 0, 0);
    assert.equal(result.usage.uncertain, 0);
  });

  await check('城战开始前仍允许空闲舰队首杀', async () => {
    const result = await dispatchRound({ beforeWar: true });
    assert.equal(result.writes.filter(row => row.name === 'ChallengePirateRequest').length, 1);
    assert.equal(result.usage.counters.piratePetrol, 300);
  });

  await check('用户关闭时段预留后，未知城战目标不拦其它合法派遣', async () => {
    const result = await dispatchRound({ unknownCounts: true, reserve: false });
    assert.equal(result.writes.filter(row => row.name === 'ChallengePirateRequest').length, 1);
    assert.equal(result.usage.counters.piratePetrol, 300);
  });
} finally {
  Date.now = realNow;
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  if (previousResourceDir === undefined) delete process.env.CW_RESOURCE_DIR;
  else process.env.CW_RESOURCE_DIR = previousResourceDir;
  const resolved = path.resolve(directory), tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('cw-city-priority-')) throw new Error('拒绝清理意外测试目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}
const passed = results.filter(result => result.passed).length;
console.log('城战预留与优先级专项 ' + passed + '/' + results.length + ' 通过');
if (passed !== results.length) process.exitCode = 1;
