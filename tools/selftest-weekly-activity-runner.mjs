import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { weeklyActionClient, weeklyForgeRecipes, weeklyActivityActionSettings, runWeeklyActivity } from '../src/weekly-activity-runner.mjs';
import { weeklyExecutionSettings } from '../src/weekly-activity.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { planBaseAutomation } from '../src/base-automation.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';
import { getConfig } from '../src/config.mjs';
import { antiqueFixture, antiqueSettings } from './fixtures/antique.mjs';
import { planWorld } from '../src/world.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-weekly-runner-'));
let serial = 0;
const ledger = () => createUsageLedger('weekly-' + ++serial, { file: path.join(directory, serial + '.json') });
const check = async (name, work) => { await work(); console.log('通过：' + name); };
const activitySettings = (settings, kind, config) => weeklyActivityActionSettings({ kind, settings: weeklyExecutionSettings(settings, kind) }, config);

try {
  await check('写入前再次核对积分，达标后停写且允许完成状态回读', async () => {
    const client = new EventEmitter(), writes = [];
    client.request = async function (name) { assert.equal(this, client); if (name === 'FinishWorkerOrderRequest') writes.push(name); return {}; };
    client.sendWatch = async name => { writes.push(name); };
    let score = 0, checks = 0;
    const scope = weeklyActionClient(client, async name => {
      checks++; assert.equal(name, 'FinishWorkerOrderRequest');
      if (score >= 100) throw Error('已达积分');
    });
    await scope.client.request('FinishWorkerOrderRequest', {});
    score = 100;
    await assert.rejects(scope.client.request('FinishWorkerOrderRequest', {}), error => error.notSent && /积分/.test(error.message));
    await scope.client.request('OnWaterRequest', {});
    assert.equal(scope.enabled(), false); assert.equal(checks, 2); assert.equal(writes.length, 1);
    const same = weeklyActionClient(client, async () => {});
    assert.equal(scope.client, same.client, '复用代理避免每轮重复注册推送监听');
    let called = 0; same.client.on('event', () => called++); client.emit('event'); assert.equal(called, 1);
    same.close();
    await assert.rejects(same.client.sendWatch('PetBreedRequest', {}), error => error.notSent === true);
  });

  await check('真实装备配方排序只改变已选配方顺序，未知品质后置', () => {
    const f = warForgeFixture(), ids = ['1002', '1001', '9999'];
    assert.deepEqual(weeklyForgeRecipes(ids, f.config, 'asc'), ['1001', '1002', '9999']);
    assert.deepEqual(weeklyForgeRecipes(ids, f.config, 'desc'), ['1002', '1001', '9999']);
    assert.deepEqual(ids, ['1002', '1001', '9999']);
  });

  await check('普通培育关闭时活动独立培育，品质排序仍遵守所选物种及最高品质', () => {
    const settings = defaultSettings(); settings.factory.demandFirst = false;
    Object.assign(settings.pet, { species: ['1'], quality: 'PURPLE' });
    const config = { tables: {
      PetBreedCfg: { data: ['BLUE', 'PURPLE', 'ORANGE'].map((quality, index) => ({ petId: quality, spId: 1, season: 1, quality, cost: [['gene', index + 1]] })) },
      PetSpeciesCfg: { data: [{ spId: 1, name: '海兽' }] },
    } };
    const snapshot = { now: 100, player: { worldId: 2000001 }, notes: [], choices: [], pets: [], raids: [],
      world: { buildings: [{ buildingId: '1宠物培育室', type: '宠物培育室', level: 1, petBreed: { maxQLength: 1, breedQ: [], maturePets: [] } }],
        stock: new Map([['gene', 10]]), factories: [], stockCap: 1000 } };
    assert.equal(planBaseAutomation(snapshot, config, settings).actions.length, 0);
    const plan = order => planBaseAutomation(snapshot, config, activitySettings(settings, 'pet', config), {}, { petQualityOrder: order }).actions.find(step => step.kind === 'petBreed');
    assert.equal(plan().body.petId, 'BLUE'); assert.equal(plan('asc').body.petId, 'BLUE'); assert.equal(plan('desc').body.petId, 'PURPLE');
    settings.pet.species = []; assert.equal(plan(), undefined, '活动不能把空物种范围扩大为所有物种');
  });

  await check('普通农田收种关闭时活动可收种，自定义目标与加速权限仍生效', () => {
    const settings = defaultSettings();
    Object.assign(settings.farm, { customPlant: true, crops: [{ id: '小麦', target: 0 }, { id: '玉米', target: 10 }] });
    const config = { tables: { FarmlandPlantCfg: { data: ['小麦', '玉米'].map(id => ({ id, material: [id + '种子', 1], produceNum: 1, time: 60 })) } } };
    const stock = new Map([['小麦种子', 5], ['玉米种子', 5]]);
    const plots = ['1农田', '2农田'].map(buildingId => ({ buildingId, type: '农田', level: 1, factory: null, farm: null, product: [], buildStartTime: 0, buildFinishTime: 0 }));
    plots[1].farm = { productId: '玉米', ripeTime: 9000 };
    const snapshot = { now: 10000, serverNow: 10000, player: { level: 36 }, have: id => stock.get(id) ?? 0, stock,
      buildings: plots, factories: [], orders: [], notes: [], weekOrder: new Map(), cargoOrder: new Map(), orderCheckError: '',
      orderOfTheDay: { orderNum: 0, rewardedNum: 0 }, stockCap: 50, factorySlots: 1, population: 100, futurePopulation: 100, maxPopulation: 1000,
      autoFarming: false, autoProduceEndTime: 0, autoProduceForever: false, cropIds: new Set(['小麦', '玉米']), floaters: [], fleets: [] };
    assert.equal(planWorld(snapshot, { config, settings }).actions.length, 0);
    const effective = activitySettings(settings, 'farm', config);
    const plan = planWorld(snapshot, { config, settings: effective });
    assert(plan.actions.some(step => step.request === 'FarmHarvestRequest'));
    const planted = plan.actions.find(step => step.request === 'FarmPlantRequest');
    assert.equal(planted?.body.args[0].productId, '玉米');
    assert(!plan.actions.some(step => step.request === 'FarmSpeedUpRequest'));
    settings.farm.crops = [];
    assert(!planWorld(snapshot, { config, settings: activitySettings(settings, 'farm', config) }).actions.some(step => step.request === 'FarmPlantRequest'));
  });

  const forge = () => {
    const f = warForgeFixture(), settings = warForgeSettings();
    settings.weeklyActivity ??= {};
    Object.assign(settings.weeklyActivity, { enabled: true, forgeEnabled: true, forgeStop: 'score', forgeScore: 60, forgeQualityOrder: 'asc' });
    f.player.worldId = f.protocol.PlayerInfo.decode(f.protocol.PlayerInfo.encode({ worldId: '2000001' }).finish()).worldId;
    f.config.tables.ModuleOpenCfg.data.push({ moduleId: '每日跨服比拼', playerLevel: 20 });
    f.config.tables.BuildingUnlockCfg.data.push({ buildingId: '2装备厂', buildingType: '装备厂', playerLevel: 17 });
    f.state.buildings.push({ buildingId: '2装备厂', level: 1, auto: false });
    settings.forge.buildingIds.push('2装备厂');
    const request = f.client.request, send = f.client.sendWatch;
    let score = 0, infoCalls = 0;
    const settleTime = Math.floor(Date.now() / 1000) + 3600;
    f.client.request = async (name, ...args) => {
      if (name === 'CrossRankInfoRequest') {
        infoCalls++; f.onInfo?.(infoCalls);
        const value = { subjectId: 2, roomLevel: 1, grouping: false, settleTime,
          rankList: [{ playerId: f.player.playerId, score, rank: 1, nickname: '测试角色', level: 40, avatar: {} }] };
        return f.protocol.CrossRankInfoResponse.decode(f.protocol.CrossRankInfoResponse.encode(value).finish());
      }
      return request(name, ...args);
    };
    f.client.sendWatch = async (name, body, ...args) => {
      if (name === 'MakeEquipRequest') f.state.factory = f.state.buildings.find(row => row.buildingId === body.buildingId);
      const value = await send(name, body, ...args);
      if (name === 'MakeEquipRequest') score += 60;
      return value;
    };
    const usage = ledger(), reports = [];
    return { ...f, settings, usage, reports,
      run: () => runWeeklyActivity(f.client, f.protocol, f.config, f.player, { getSettings: () => settings, ledger: usage, report: row => reports.push(row) }),
      infoCalls: () => infoCalls };
  };

  await check('完整周活动执行：首座锻造获分后不向第二座下单，保留成功账本', async () => {
    const f = forge();
    const result = await f.run();
    assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest'], JSON.stringify(result));
    assert.equal(f.usage.snapshot().counters.forgeStarts, 1);
    assert.equal(f.usage.pendingCounters().forgeStarts ?? 0, 0);
    assert(f.infoCalls() >= 3, '初始、首个写入、第二个写入均复查活动');
    assert(f.reports.some(row => /已达目标积分/.test(row.error ?? row.reason ?? '')));
    await f.run(); assert.equal(f.client.writes.length, 1, '后续轮次已达标不重复下单');
  });

  await check('全天模式为两座已选工厂分别下单', async () => {
    const f = forge(); f.settings.weeklyActivity.forgeStop = 'allDay';
    await f.run(); assert.deepEqual(f.client.writes.map(row => row.body.buildingId), ['1装备厂', '2装备厂']);
    assert.equal(f.usage.snapshot().counters.forgeStarts, 2);
  });

  await check('普通锻造总控、领取及续产全关时，活动日仍领取并制造且不改保存值', async () => {
    const f = forge(); f.settings.weeklyActivity.forgeStop = 'allDay';
    Object.assign(f.settings.forge, { enabled: false, collect: false, craft: false, buildingIds: ['1装备厂'] });
    f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 60, equipId: '测试武器', star: 2 };
    const before = structuredClone(f.settings);
    await f.run();
    assert.deepEqual(f.client.writes.map(row => row.name), ['PickMadeEquipRequest', 'MakeEquipRequest'], JSON.stringify(f.reports));
    assert.deepEqual(f.settings, before);
    assert.equal(f.usage.snapshot().counters.forgeStarts, 1);
  });

  await check('普通藏品总控及升星套装开关全关时，活动按已选品质养成', async () => {
    const f = antiqueFixture(), settings = antiqueSettings();
    Object.assign(settings.weeklyActivity, { enabled: true, antiqueEnabled: true, antiqueStop: 'allDay' });
    Object.assign(settings.antique, { enabled: false, star: false, suit: false, targetStar: 1, starQualities: ['BLUE'], suitQualities: ['BLUE'] });
    f.config.tables.ModuleOpenCfg.data.push({ moduleId: '每日跨服比拼', playerLevel: 20 });
    f.state.antiques = [{ id: '蓝藏1', star: 0 }, { id: '蓝藏2', star: 0 }, { id: '红藏1', star: 0 }];
    for (const id of ['蓝藏1碎片', '蓝藏2碎片', '红藏1碎片', '蓝藏品经验']) f.client.setItem(id, 100);
    const player = { playerId: '9007199254747991', worldId: 2000001, level: 40 };
    const request = f.client.request;
    f.client.request = async (name, ...args) => name === 'CrossRankInfoRequest'
      ? { subjectId: 4, roomLevel: 1, grouping: false, settleTime: Math.floor(Date.now() / 1000) + 3600, rankList: [] }
      : request(name, ...args);
    const before = structuredClone(settings);
    await runWeeklyActivity(f.client, f.protocol, f.config, player, { getSettings: () => settings, ledger: ledger() });
    assert(f.client.writes.some(row => row.name === 'AntiqueStarUpRequest'));
    assert(f.client.writes.some(row => row.name === 'AntiqueSuitLevelUpRequest'));
    assert(f.client.writes.every(row => ['AntiqueStarUpRequest', 'AntiqueSuitLevelUpRequest'].includes(row.name)));
    assert.equal(f.state.antiques.find(row => row.id === '红藏1').star, 0);
    assert.deepEqual(settings, before);
  });

  await check('普通英雄总控和升星关闭时，活动只对名单内英雄升星', async () => {
    const settings = defaultSettings();
    Object.assign(settings.weeklyActivity, { enabled: true, heroEnabled: true, heroStop: 'allDay' });
    Object.assign(settings.heroes, { heroIds: ['甲'], targetStar: 1 });
    const config = { tables: {
      ModuleOpenCfg: { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }] },
      HeroCfg: { data: ['甲', '乙'].map(id => ({ id, quality: 'RED', universalItemId: '万能碎片' })) },
      HeroStarCfg: { data: [{ star: 0, maxSkillLevel: [] }, { star: 1, consumeRed: 2, maxSkillLevel: [] }] },
    } };
    const player = { playerId: '9007199254747992', worldId: 2000001, level: 40 };
    const heroes = ['甲', '乙'].map(heroId => ({ heroId, star: 0, level: 1, skillLevels: [] }));
    const stock = new Map([['甲碎片', 10], ['乙碎片', 10]]), writes = [];
    const client = new EventEmitter(); client.connected = true;
    client.request = async (name, body) => {
      if (name === 'CrossRankInfoRequest') return { subjectId: 5, roomLevel: 1, grouping: false, settleTime: Math.floor(Date.now() / 1000) + 3600, rankList: [] };
      if (name === 'AllHeroRequest') return { heroes: structuredClone(heroes) };
      if (name === 'AllItemRequest') return { items: [...stock].map(([itemId, num]) => ({ itemId, num })) };
      assert.equal(name, 'HeroStarUpRequest'); assert.equal(body.heroId, '甲'); assert.equal(body.universal, false);
      writes.push(body.heroId); stock.set('甲碎片', stock.get('甲碎片') - 2);
      return { nextStar: ++heroes[0].star };
    };
    const before = structuredClone(settings), reports = [];
    await runWeeklyActivity(client, { HeroStarUpRequest: true }, config, player, { getSettings: () => settings, ledger: ledger(), report: entry => reports.push(entry) });
    assert.deepEqual(writes, ['甲'], JSON.stringify(reports)); assert.equal(heroes[1].star, 0);
    assert.deepEqual(settings, before);
  });

  await check('完整基地订单执行：使用真实FinishWorkerOrder请求且积分达标只交一单', async () => {
    const settings = defaultSettings(), config = getConfig();
    settings.weeklyActivity ??= {};
    Object.assign(settings.weeklyActivity, { enabled: true, orderEnabled: true, orderStop: 'score', orderScore: 25 });
    const names = ['CrossRankInfo', 'OnWater', 'AllItem', 'AllResource', 'WeekInfo', 'WeekOrderInfo', 'FinishWorkerOrder'];
    const protocol = Object.fromEntries(names.flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
    const client = new EventEmitter(); client.connected = true;
    const player = { playerId: '9170000000001001', worldId: 2000001, level: 37 }, writes = [], reports = [];
    let stock = 20, score = 0;
    let orders = [1, 2].map(index => ({ index, workerId: index, textId: 0, isSpecial: false, refreshTime: 0, requirements: [{ id: '木材', num: 3 }] }));
    const settleTime = Math.floor(Date.now() / 1000) + 3600;
    client.request = async (name, body) => {
      if (name === 'CrossRankInfoRequest') return { grouping: false, roomLevel: 1, subjectId: 1, settleTime, rankList: [{ playerId: player.playerId, score }] };
      if (name === 'OnWaterRequest') return { building: [], workerOrder: structuredClone(orders) };
      if (name === 'AllItemRequest') return { items: [{ itemId: '木材', num: stock }] };
      if (name === 'AllResourceRequest') return { list: [] };
      if (name === 'WeekInfoRequest') return { activityTime: [] };
      assert.equal(name, 'FinishWorkerOrderRequest'); writes.push(body.index);
      stock -= 3; score += 25; orders = orders.filter(row => row.index !== body.index);
      return { reward: { asset: [{ id: 'GOLD', type: 0, num: 100 }] } };
    };
    const usage = ledger();
    await runWeeklyActivity(client, protocol, config, player, { getSettings: () => settings, ledger: usage, report: row => reports.push(row) });
    assert.deepEqual(writes, [1], JSON.stringify(reports));
    assert.equal(stock, 17); assert.equal(usage.snapshot().counters.residentOrders, 1);
    assert.equal(usage.pendingCounters().residentOrders ?? 0, 0);
    assert(reports.some(row => /已达目标积分/.test(row.error ?? row.reason ?? '')));
  });

  await check('关闭周活动不读取和发送任何请求', async () => {
    const settings = defaultSettings(), client = { connected: true, request() { assert.fail('关闭不能发请求'); } };
    const result = await runWeeklyActivity(client, {}, {}, {}, { getSettings: () => settings });
    assert.equal(result.kind, null);
  });
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
