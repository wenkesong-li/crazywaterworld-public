import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUsageLedger, defaultSettings, validateSettings } from '../src/automation-settings.mjs';
import { readSiliconMining, planSiliconMining, planSiliconMaintenance, previewSiliconEventRecall, recallSiliconForEvent, runSiliconMining, watchSiliconMining, siliconInWindow, siliconInterval } from '../src/silicon-mining.mjs';
import { fleetRecordReason, fleetDispatchView, bridgeFleetReservations, reserveDispatch } from '../src/fleet-availability.mjs';
import { registerFleetReservations } from '../src/fleet-reservations.mjs';
import { pendingPetrol } from '../src/dispatch-preview.mjs';
import { siliconFixture, siliconSettings } from './fixtures/silicon.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-')), results = []; let seq = 0;
const usage = f => createUsageLedger('虚构硅矿账号', { file: path.join(dir, String(++seq) + '.json'), now: () => Date.now() + f.client.serverClockOffsetMs });
const read = (f, s, ledger) => readSiliconMining(f.client, f.protocol, f.config, f.player, { settings: s, ledger });
const plan = async (f, s, ledger) => planSiliconMining(await read(f, s, ledger), s, ledger, f.client);
const run = (f, s, ledger, options = {}) => runSiliconMining(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger, enabled: () => true, ...options });
const hunt = (s, players = ['名单目标'], retreat = 'never', index = 0) => Object.assign(s.silicon.fleets[index], { huntEnabled: true, huntPlayers: players, huntRetreat: retreat, emptyOnly: false });
function startMineReturn(f, id = '1远征船', gridId = 5000) {
  f.returnFleet(id);
  const time = Math.floor((Date.now() + f.client.serverClockOffsetMs) / 1000);
  Object.assign(f.state.fleets.find(fleet => fleet.buildingId === id), {
    state: 2, startGridIdx: gridId, targetGridIdx: 700, cityId: 7, targetCityId: 7, moveStartTs: time, moveEndTs: time + 180,
  });
}
const test = async (name, body) => { try { await body(); results.push(true); console.log('通过：' + name); } catch (error) { results.push(false); console.error('失败：' + name + '\n' + error.stack); } };
try {
  await test('新配置默认禁用，三舰队参数可独立校验及保留', () => {
    const defaults = defaultSettings(); assert.equal(defaults.silicon.enabled, false); assert(defaults.silicon.fleets.every(fleet => !fleet.enabled));
    const s = siliconSettings(); s.silicon.fleets[1].safePlayers = ['盟友']; assert.deepEqual(validateSettings(s).silicon.fleets[1].safePlayers, ['盟友']);
    for (const invalid of [['RED'], ['BLUE', 'BLUE'], 'BLUE']) {
      s.silicon.fleets[1].tiers = invalid; assert.throws(() => validateSettings(s));
    }
  });
  await test('读状态和预览无写入；协议真实往返保留大整数角色', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), snapshot = await read(f, s, ledger);
    assert.equal(snapshot.reason, ''); assert.match(snapshot.playerId, /^90071992548/); assert.equal(snapshot.mines.length, 3);
    const p = planSiliconMining(snapshot, s, ledger, f.client); assert.equal(p.actions[0].request, 'ChipMineSendFleetRequest'); assert.equal(p.actions[0].body.gridId, 5000);
    assert.equal(f.client.writes.length, 0); assert.equal(Object.keys(ledger.keyRecords()).length, 0); assert.equal(snapshot.reward.myRewardTimes, 0);
  });
  await test('实际赛季开放与合服门控，不按图片仅等级放行', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); f.player.worldId = 1001001;
    await run(f, s, ledger); assert.equal(f.client.reads.length, 0); assert.equal(f.client.writes.length, 0);
    f.player.worldId = 3001001; f.state.merge.matchMaking = true; await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
  });
  await test('三舰队选择独立空位，确认派遣共享舰队锁和汽油', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); for (const row of s.silicon.fleets) row.enabled = true;
    await run(f, s, ledger); assert.equal(f.client.writes.length, 3); assert.equal(new Set(f.client.writes.map(write => write.body.index)).size, 3);
    assert.equal(ledger.snapshot().counters.siliconPetrol, 1500); assert.match(fleetRecordReason(ledger.keyRecords(), '1远征船', '3001001'), /硅矿/);
    assert.equal(fleetRecordReason(ledger.keyRecords(), '1远征船', '4001001'), '');
    assert(fleetDispatchView(f.client, s, ledger, f.state.fleets, '3001001')[0].intents.some(row => row.key === 'silicon'));
    await run(f, s, ledger); assert.equal(f.client.writes.length, 3);
  });
  await test('未知结果跨重连和跨日保留预算，不把空闲当作未派遣', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); f.unknown = true; await run(f, s, ledger);
    assert.equal(f.client.writes.length, 1); assert.equal(pendingPetrol(ledger), 500); assert.equal(ledger.snapshot().uncertain, 1);
    f.client.serverClockOffsetMs += 86400000; f.state.reward.rewardResetTime += 86400; await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(pendingPetrol(ledger), 500);
  });
  await test('未知结果占住同一矿位，其他舰队不重复撞位', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[1].enabled = true; f.unknown = true;
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.body.index), [0, 1]); assert.equal(pendingPetrol(ledger), 1000);
  });
  await test('发送前关闭或切换设置取消；明确拒绝取消预算', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); let count = 0;
    f.beforeRead = name => { if (name === 'ChipMineListRequest' && ++count === 2) s.silicon.enabled = false; };
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0); assert.equal(ledger.snapshot().counters.siliconPetrol ?? 0, 0);
    f.beforeRead = null; s.silicon.enabled = true; f.reject = true; await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(ledger.snapshot().uncertain, 0);
  });
  await test('达到自定日上限停止派遣并在服务器允许后撤回', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.dailyRewardLimit = 2; f.state.reward.myRewardTimes = 2; f.occupy('1远征船', 5000, 0, 0);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
    f.state.positions[5000][0].player.rewardTimes = 1; await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].name, 'ChipMineRetreatRequest');
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
  });
  await test('三日服务器奖励上限无视自定0无限，依旧停止并撤回', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); f.state.reward.myRewardTimes = 100; f.occupy('1远征船', 5000, 0, 1);
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest']);
  });
  await test('日奖励计数保存增量，首次基线保守，切换配置不清零', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].enabled = false; f.state.reward.myRewardTimes = 20;
    await run(f, s, ledger); assert.equal((await read(f, s, ledger)).dailyRewards, 20);
    f.state.reward.myRewardTimes = 22; await run(f, s, ledger); assert.equal((await read(f, s, ledger)).dailyRewards, 22);
    f.client.serverClockOffsetMs += 86400000; f.state.reward.rewardResetTime += 86400; f.state.reward.myRewardTimes = 3;
    await run(f, s, ledger); assert.equal((await read(f, s, ledger)).dailyRewards, 3);
  });
  await test('时段支持跨午夜，时段外撤回而非新派遣', async () => {
    const night = Date.parse('2026-11-14T15:30:00Z') / 1000;
    assert(siliconInWindow(['23:00-02:00'], night)); assert(!siliconInWindow(['03:00-04:00'], night));
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); const minute = Math.floor(((Date.now() / 1000 + 28800) % 86400) / 60); const a = (Math.floor(minute / 60) + 3) % 24;
    s.silicon.windows = [String(a).padStart(2, '0') + ':00-' + String((a + 1) % 24).padStart(2, '0') + ':00']; f.occupy('1远征船', 5000, 0, 1);
    await run(f, s, ledger); assert.equal(f.client.writes[0]?.name, 'ChipMineRetreatRequest');
  });
  await test('空位优先；只空位与低矿始终不攻击；安全名单和战力过滤有效', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); f.enemy(0); f.enemy(1, '安全玩家', 800); f.enemy(2, '强者', 2000);
    s.silicon.fleets[0].emptyOnly = true;
    assert.equal((await plan(f, s, ledger)).actions.length, 0);
    s.silicon.fleets[0].emptyOnly = false; s.silicon.fleets[0].safePlayers = ['敌方船长']; s.silicon.fleets[0].safeGuilds = ['9']; f.state.positions[5000][1].player.guildIdx = 9;
    assert.equal((await plan(f, s, ledger)).actions.length, 0);
    s.silicon.fleets[0].safePlayers = []; assert.equal((await plan(f, s, ledger)).actions[0].opponent.nickname, '敌方船长');
    f.state.positions[5000].pop(); assert.equal((await plan(f, s, ledger)).actions[0].opponent, null);
    s.silicon.fleets[0].tiers = ['BLUE']; for (let i = 0; i < 3; i++) f.enemy(i, '低矿敌人' + i, 10, 8, 3000);
    assert.equal((await plan(f, s, ledger)).actions.length, 0);
  });
  await test('多选等级任一有空位即派遣，未选等级和空选均不派遣', async () => {
    for (const openGrid of [4000, 5000]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), fleet = s.silicon.fleets[0];
      fleet.tiers = ['PURPLE', 'ORANGE']; fleet.emptyOnly = true;
      const fullGrid = openGrid === 4000 ? 5000 : 4000;
      for (let i = 0; i < 3; i++) f.enemy(i, '占矿玩家' + i, 900, 8, fullGrid);
      await run(f, s, ledger);
      assert.deepEqual(f.client.writes.map(write => write.body.gridId), [openGrid]);
    }
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    s.silicon.fleets[0].tiers = [];
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
  });
  await test('混选时初等矿只占空位，中等矿仍可抢占', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    s.silicon.fleets[0].tiers = ['BLUE', 'PURPLE'];
    for (let i = 0; i < 3; i++) {
      f.enemy(i, '初等玩家' + i, 999, 8, 3000);
      f.enemy(i, '中等玩家' + i, 800, 8, 4000);
    }
    await run(f, s, ledger);
    assert.deepEqual(f.client.writes.map(write => write.body.gridId), [4000]);
  });
  await test('服务器全局30次与每舰日抢占限制同时生效', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].emptyOnly = false; for (let i = 0; i < 3; i++) f.enemy(i, '敌人' + i);
    f.state.fightTimes = 30; assert.equal((await plan(f, s, ledger)).actions.length, 0);
    f.state.fightTimes = 29; s.silicon.fleets[1].enabled = true; s.silicon.fleets[1].emptyOnly = false;
    assert.equal((await plan(f, s, ledger)).actions.length, 1);
    f.unknown = true; await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
  });
  await test('每舰同敌失败次数跨轮持久化，返回未占领即停止重复攻击', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].emptyOnly = false; for (let i = 0; i < 3; i++) f.enemy(i, '敌人' + i, 900 - i * 100);
    await run(f, s, ledger); assert.equal(f.client.writes[0].body.index, 0); f.returnFleet('1远征船'); await run(f, s, ledger);
    assert.equal(f.client.writes.length, 2); assert.equal(f.client.writes[1].body.index, 1);
    assert(Object.values(ledger.keyRecords()['silicon-state:3001001'].details.failures).includes(1));
  });
  await test('追击仅筛选已验证击败且当前在游戏黑名单中的玩家', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].emptyOnly = false; s.silicon.fleets[0].pursuit = true;
    f.state.reward.rewardResetTime = Math.floor(Date.now() / 1000) + 3 * 86400 - 60; f.enemy(0, '黑名单目标', 800);
    assert.equal((await plan(f, s, ledger)).actions.length, 0);
    const target = f.state.positions[5000][0].player, opponentHash = createHash('sha256').update(JSON.stringify([target.nickname.toLocaleLowerCase(), target.guildIdx])).digest('hex').slice(0, 24);
    const t = ledger.reserve({}, {}, {}, { uniqueKey: 'silicon-state:3001001', details: { defeated: { [opponentHash]: { nickname: target.nickname, guildIdx: 8 } } } }); ledger.confirm(t);
    f.state.blacklist.push({ playerId: '9007199254840999', nickname: '黑名单目标', avatar: {} }); assert.equal((await plan(f, s, ledger)).actions[0]?.opponent.nickname, '黑名单目标');
    s.silicon.fleets[0].emptyOnly = true; assert.equal((await plan(f, s, ledger)).actions[0]?.opponent, null);
  });
  await test('真实战报胜利才录入击败记录，不能把占领空位当胜利', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].emptyOnly = false; for (let i = 0; i < 3; i++) f.enemy(i, '战报敌人' + i, 900 - i * 100);
    await run(f, s, ledger); f.occupy('1远征船'); f.state.reports = [{ uid: 123, type: 11, win: true, mySide: 0, createTime: Math.floor(Date.now() / 1000), chipWar: { fleetId: '1远征船', color: 5 } }];
    f.state.reportDetails['123'] = { battles: [{ win: true, leftCamp: { player: { nickname: f.player.nickname } }, rightCamp: { player: { nickname: '战报敌人0' } } }] };
    await run(f, s, ledger); assert.equal(Object.keys(ledger.keyRecords()['silicon-state:3001001'].details.defeated).length, 1);
  });
  await test('旧汽油日预算/保留量不拦截派遣，全局待确认占用仍扣除', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.petrolReserve = 49900; s.silicon.dailyPetrolLimit = 1;
    assert.equal((await plan(f, s, ledger)).actions.length, 1);
    const ticket = ledger.reserve({ treasurePetrol: 49900 }, {}, {}, { uniqueKey: 'test-shared:1', details: {} }); assert.equal((await plan(f, s, ledger)).actions.length, 0);
    ledger.cancel(ticket); await run(f, s, ledger); assert.equal(f.client.writes[0].name, 'ChipMineSendFleetRequest');
  });
  await test('派遣确认早于库存扣减时，本轮维修不会再次花费已用汽油', async () => {
    for (const fuel of [500, 900]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); f.state.fuel = fuel;
      Object.assign(s.silicon.fleets[1], { enabled: true, autoRepair: true }); f.state.fleets[1].durability = 1800;
      f.beforeRead = name => name === 'AllItemRequest' ? { items: [{ itemId: '汽油', num: fuel }] } : undefined;
      await run(f, s, ledger);
      assert.deepEqual(f.client.writes.map(row => row.name), fuel === 500 ? ['ChipMineSendFleetRequest'] : ['ChipMineSendFleetRequest', 'RepairFleetRequest']);
      assert.equal(f.state.fuel, 0); assert.equal(ledger.confirmedCounters().siliconPetrol, fuel);
    }
  });
  await test('同轮未知派遣费用只扣一次，明确拒绝后余额可用于维修', async () => {
    for (const status of ['unknown', 'rejected']) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), fuel = status === 'unknown' ? 900 : 500;
      f.state.fuel = fuel; Object.assign(s.silicon.fleets[1], { enabled: true, autoRepair: true }); f.state.fleets[1].durability = 1800;
      f.beforeRead = name => name === 'AllItemRequest' ? { items: [{ itemId: '汽油', num: fuel }] } : undefined;
      const send = f.client.sendWatch; f.client.sendWatch = async (name, ...args) => {
        f.unknown = name === 'ChipMineSendFleetRequest' && status === 'unknown'; f.reject = name === 'ChipMineSendFleetRequest' && status === 'rejected';
        return send(name, ...args);
      };
      await run(f, s, ledger);
      assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineSendFleetRequest', 'RepairFleetRequest']);
      assert.equal(ledger.confirmedCounters().siliconPetrol, 400); assert.equal(ledger.pendingCounters().siliconPetrol ?? 0, status === 'unknown' ? 500 : 0);
      assert.equal(f.state.fuel, fuel - 400);
    }
  });
  await test('提前召回只读预览、在途防重与临发送前改期或矿位变化', async () => {
    for (const change of ['unknown', 'rescheduled', 'leftMine', 'disabled']) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
      s.silicon.enabled = false;
      Object.assign(s.cityWar, { enabled: true, recallSilicon: true, recallLeadMinutes: 1, fleetIds: ['1远征船'] });
      f.occupy('1远征船',5000,0,1);
      const start = Math.floor(Date.now()/1000) + 45, source = 'cityWar';
      const previous = ledger.keyRecords();
      const preview = await previewSiliconEventRecall(f.client, f.protocol, f.config, f.player, s, ledger, source, start, f.state.fleets);
      assert.deepEqual(preview.actions.map(a => a.request), ['ChipMineRetreatRequest']);
      assert.deepEqual(f.client.writes, []); assert.deepEqual(ledger.keyRecords(), previous);
      const recall = () => recallSiliconForEvent(f.client, f.protocol, f.config, f.player, { source, fleetIds: s.cityWar.fleetIds,
        getSettings: () => s, enabled: () => true, recallCurrent: () => s.cityWar.recallSilicon, ledger, report() {},
        verifyStart: async () => {
          if (change === 'leftMine') f.state.fleets[0].curGridIdx++;
          if (change === 'disabled') s.cityWar.recallSilicon = false;
          return change !== 'rescheduled';
        } });
      f.unknown = true; await recall(); await recall();
      assert.equal(f.client.writes.length, change === 'unknown' ? 1 : 0, change);
      assert.equal(!!ledger.keyRecords()['silicon-retreat:3001001:1'], change === 'unknown');
    }
  });
  await test('提前窗口内自动占矿避开所选舰队，窗口结束后恢复', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    s.silicon.fleets[1].enabled = true;
    await run(f, s, ledger, { heldForEvent: id => id === '1远征船' });
    assert.deepEqual(f.client.writes.map(w => w.body.fleetId), ['2远征船']);
    await run(f, s, ledger, { heldForEvent: () => false });
    assert.deepEqual(f.client.writes.map(w => w.body.fleetId), ['2远征船','1远征船']);
  });
  await test('旧硅矿维修加速配置只会触发普通维修，预览与挂机均不为维修花钻', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    Object.assign(s.silicon.fleets[0], { autoRepair: true, repairSpeedUp: true, repairDailyDiamonds: 1000,
      marchSpeedUp: true, marchDailyDiamonds: 1000, returnSpeedUp: true, returnDailyDiamonds: 1000 });
    s.resources.allowDiamonds = true; f.state.fleets[0].durability = 0;
    await run(f, s, ledger);
    assert.equal(await planSiliconMaintenance(f.client, f.protocol, f.config, s, ledger, await read(f, s, ledger)), null);
    await run(f, s, ledger);
    assert.deepEqual(f.client.writes.map(row => row.name), ['RepairFleetRequest']);
    assert.equal(ledger.snapshot().counters.diamonds ?? 0, 0);
    assert(ledger.confirmedCounters().siliconPetrol > 0);
  });
  await test('去程加速遵守钻石总开关和本队去程预算，按新行军结束时间确认', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].marchSpeedUp = true; await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
    s.resources.allowDiamonds = true; s.silicon.fleets[0].marchDailyDiamonds = 30; await run(f, s, ledger); assert.equal(f.client.writes.at(-1).name, 'SpeedUpFleetRequest');
    await run(f, s, ledger); assert.equal(f.client.writes.length, 2); assert.equal(ledger.snapshot().counters.diamonds, 30);
  });
  await test('推送唤醒和普通/追击检查间隔', () => {
    const f = siliconFixture(), s = siliconSettings(), watcher = watchSiliconMining(f.client); let wake = 0; watcher.subscribe(() => wake++);
    f.client.emit('message', { name: 'SCChipMine', body: { chipMines: [] } }); assert.equal(wake, 1); assert.equal(watchSiliconMining(f.client), watcher);
    assert.equal(siliconInterval(s), 600000); s.silicon.fleets[0].pursuit = true; s.silicon.fleets[0].emptyOnly = false; assert.equal(siliconInterval(s), 120000);
  });
  await test('硅矿去程和回城分别计费，已达领奖上限的自然返航仍按回城目标加速', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), fleet = s.silicon.fleets[0];
    Object.assign(fleet, { marchSpeedUp: true, marchDailyDiamonds: 30, returnSpeedUp: true, returnDailyDiamonds: 90, returnTargetSeconds: 95 });
    s.resources.allowDiamonds = true;
    await run(f, s, ledger); await run(f, s, ledger);
    assert.equal(ledger.confirmedCounters().siliconMarchDiamonds1, 30);
    startMineReturn(f); f.state.reward.myRewardTimes = f.state.reward.maxRewardTimes;
    const before = ledger.keyRecords(), writes = f.client.writes.length;
    const step = await planSiliconMaintenance(f.client, f.protocol, f.config, s, ledger, await read(f, s, ledger));
    assert.equal(step.mode, 'return'); assert.equal(step.cost, 30); assert.match(step.label, /回城/);
    assert.equal(f.client.writes.length, writes); assert.deepEqual(ledger.keyRecords(), before);
    await run(f, s, ledger); await run(f, s, ledger);
    assert.equal(ledger.confirmedCounters().siliconReturnDiamonds1, 30);
    assert.equal(ledger.confirmedCounters().siliconDiamonds, 60);
  });
  await test('主动撤回可确认本矿返航，立即回城不花钻，结果未知不重发', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    Object.assign(s.silicon.fleets[0], { returnSpeedUp: true, returnDailyDiamonds: 60 });
    s.resources.allowDiamonds = true; s.silicon.dailyRewardLimit = 1; f.state.reward.myRewardTimes = 1;
    f.occupy('1远征船', 5000, 0, 1);
    f.afterWrite = name => { if (name === 'ChipMineRetreatRequest') { startMineReturn(f); f.unknown = true; } };
    await run(f, s, ledger); await run(f, s, ledger);
    assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest','SpeedUpFleetRequest']);
    assert.equal(ledger.pendingCounters().siliconReturnDiamonds1, 30);
    f.returnFleet('1远征船'); await run(f, s, ledger);
    assert.equal(ledger.confirmedCounters().siliconReturnDiamonds1 ?? 0, 0);
    assert.equal(ledger.pendingCounters().diamonds, 30);
  });
  await test('其他行军、错误矿格、未开启回城及发送前换航程均不花钻', async () => {
    for (const kind of ['manual','otherGrid','otherCity','cargo','disabled','zero','changed','global']) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
      if (kind !== 'manual') await run(f, s, ledger);
      startMineReturn(f); const fleet = f.state.fleets[0];
      Object.assign(s.silicon.fleets[0], { returnSpeedUp: kind !== 'disabled', returnDailyDiamonds: kind === 'zero' ? 0 : 60 });
      s.resources.allowDiamonds = true;
      if (kind === 'global') s.resources.diamondDailyLimit = 29;
      if (kind === 'otherCity') fleet.targetCityId++;
      if (kind === 'otherGrid') fleet.startGridIdx++;
      if (kind === 'cargo') fleet.treasureLootUid = 1;
      if (kind === 'changed') f.beforeRead = name => { if (name === 'AllResourceRequest') fleet.targetGridIdx++; };
      await run(f, s, ledger);
      assert.equal(f.client.writes.filter(w => w.name === 'SpeedUpFleetRequest').length, 0, kind);
      assert.equal(ledger.snapshot().counters.diamonds ?? 0, 0, kind);
    }
  });
  await test('第一队预算用尽后第二队仍可去程加速，不受旧维修用量挤占', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
    s.resources.allowDiamonds = true;
    for (const fleet of s.silicon.fleets.slice(0,2)) Object.assign(fleet, { enabled: true, marchSpeedUp: true, marchDailyDiamonds: 30 });
    ledger.confirm(ledger.reserve({ diamonds: 90, siliconDiamonds: 90, siliconRepairDiamonds1: 90 }));
    await run(f, s, ledger); await run(f, s, ledger); await run(f, s, ledger);
    assert.equal(ledger.confirmedCounters().siliconMarchDiamonds1, 30);
    assert.equal(ledger.confirmedCounters().siliconMarchDiamonds2, 30);
    assert.equal(ledger.confirmedCounters().siliconRepairDiamonds1, 90);
  });
  await test('旧版待确认维修加速继续核对费用，归队后不补发', async () => {
    for (const early of [false, true]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f);
      s.silicon.fleets[0].autoRepair = true; s.silicon.fleets[0].minDurabilityPercent = 100;
      f.state.fleets[0].durability = 1000; await run(f, s, ledger);
      const repair = f.state.fleets[0].repairing;
      const key = 'silicon-speed:3001001:1:repair:' + repair.startTs;
      ledger.reserve({ diamonds: 90, siliconDiamonds: 90, siliconRepairDiamonds1: 90 }, {}, {}, {
        uniqueKey: key, details: { kind: 'siliconSpeed', worldId: '3001001', buildingId: '1远征船',
          repair: true, repairStartTs: repair.startTs, beforeEnd: repair.endTs, targetDurability: 2000 } });
      if (!early) f.client.serverClockOffsetMs += 1200000;
      f.returnFleet('1远征船'); f.state.fleets[0].durability = 2000;
      await run(f, s, ledger);
      assert.equal(ledger.confirmedCounters().diamonds ?? 0, early ? 90 : 0);
      assert.equal(ledger.pendingCounters().diamonds ?? 0, early ? 0 : 90);
      if (!early) assert.equal(ledger.keyRecords()[key].expired, true);
      assert.equal(f.client.writes.filter(row => row.name === 'SpeedUpRepairRequest').length, 0);
    }
  });
  await test('读不到原矿位时不能拿空闲回包释放未知撤回记录', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.dailyRewardLimit = 1; f.state.reward.myRewardTimes = 1; f.occupy('1远征船', 5000, 0, 1); f.unknown = true;
    await run(f, s, ledger); f.returnFleet('1远征船'); f.beforeRead = (name, body) => { if (name === 'ChipMineRequest' && body.gridId === 5000) throw Error('模拟目标矿位不可读取'); };
    await run(f, s, ledger); assert.equal(ledger.keyRecords()['silicon-retreat:3001001:1'].confirmed, false); assert.equal(f.client.writes.length, 1);
  });
  await test('舰队最终复查期间关闭加速子开关会释放未发送预算', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); s.silicon.fleets[0].marchSpeedUp = true;
    await run(f, s, ledger); s.resources.allowDiamonds = true; s.silicon.fleets[0].marchDailyDiamonds = 1000;
    let afterRuby = false; f.beforeRead = name => { if (name === 'AllResourceRequest') afterRuby = true; if (name === 'MyFleetsRequest' && afterRuby) s.silicon.fleets[0].marchSpeedUp = false; };
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(ledger.snapshot().counters.diamonds ?? 0, 0);
  });
  await test('追杀配置缺省关闭、兼容旧三舰队配置并拒绝非法名单和策略', () => {
    const s = siliconSettings();
    for (const row of s.silicon.fleets) { assert.equal(row.huntEnabled, false); assert.deepEqual(row.huntPlayers, []); assert.equal(row.huntRetreat, 'never'); }
    const legacy = structuredClone(s);
    for (const row of legacy.silicon.fleets) { delete row.huntEnabled; delete row.huntPlayers; delete row.huntRetreat; }
    assert.deepEqual(validateSettings(legacy).silicon.fleets, s.silicon.fleets);
    hunt(s, ['第一目标', 'Second Target'], 'onTarget');
    const validated = validateSettings(s); assert.deepEqual(validated.silicon.fleets[0].huntPlayers, ['第一目标', 'Second Target']); assert.equal(validated.silicon.fleets[1].huntEnabled, false);
    for (const invalid of [{ huntEnabled: 'true' }, { huntPlayers: [] }, { huntPlayers: ['重复', '重复'] }, { huntPlayers: ['Captain', 'CAPTAIN'] }, { huntPlayers: ['含\n换行'] }, { huntPlayers: [''] }, { huntRetreat: 'always' }]) {
      const broken = structuredClone(s); Object.assign(broken.silicon.fleets[0], invalid); assert.throws(() => validateSettings(broken), JSON.stringify(invalid));
    }
  });
  await test('名单完整昵称忽略大小写，目标优先于空位且不需要黑名单或历史胜利', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['Captain Target']);
    f.enemy(1, ' captain target ', 800); f.enemy(2, 'Captain Target 2', 900);
    const p = await plan(f, s, ledger); assert.equal(p.actions.length, 1); assert.equal(p.actions[0].index, 1); assert.equal(p.actions[0].opponent.nickname, ' captain target ');
    assert.equal(f.client.writes.length, 0); assert.equal(f.state.blacklist.length, 0);
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => [row.name, row.body.index]), [['ChipMineSendFleetRequest', 1]]);
    assert.equal(ledger.snapshot().counters.siliconAttacks1, 1); assert.equal(ledger.snapshot().counters.siliconPetrol, 500);
  });
  await test('追杀不会攻击名字仅部分相同或名单外玩家，无目标时可占空位', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标']);
    f.enemy(0, '名单目标甲', 100); f.enemy(1, '甲名单目标', 100); f.enemy(2, '其他船长', 100);
    assert.equal((await plan(f, s, ledger)).actions.length, 0);
    f.state.positions[5000].pop(); const p = await plan(f, s, ledger); assert.equal(p.actions[0].index, 2); assert.equal(p.actions[0].opponent, null);
    s.silicon.fleets[0].huntPlayers = []; assert.equal((await plan(f, s, ledger)).actions[0]?.opponent, null);
    s.silicon.fleets[0].huntEnabled = false; f.enemy(2, '其他船长', 100); assert((await plan(f, s, ledger)).actions[0].opponent);
  });
  await test('显式追杀名单覆盖旧追击窗口筛选，普通追击关闭名单后仍保持原规则', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); const policy = hunt(s); policy.pursuit = true; f.enemy(0, '名单目标', 800);
    f.state.reward.rewardResetTime = Math.floor(Date.now() / 1000) + 3 * 86400 - 60;
    assert.equal((await plan(f, s, ledger)).actions[0]?.opponent?.nickname, '名单目标');
    policy.huntEnabled = false; assert.equal((await plan(f, s, ledger)).actions.length, 0);
    policy.huntEnabled = true; f.state.reward.rewardResetTime -= 3600; assert.equal((await plan(f, s, ledger)).actions[0]?.opponent?.nickname, '名单目标');
  });
  await test('每舰独立追杀名单，多个舰队不会派往同一个目标矿位', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s); hunt(s, ['第二目标'], 'never', 1); s.silicon.fleets[1].enabled = true;
    f.enemy(0, '名单目标', 700); f.enemy(1, '第二目标', 800);
    const p = await plan(f, s, ledger); assert.deepEqual(p.actions.map(row => row.opponent?.nickname), ['名单目标', '第二目标']);
    s.silicon.fleets[1].huntPlayers = ['名单目标']; const shared = await plan(f, s, ledger);
    assert.equal(shared.actions.filter(row => row.opponent).length, 1); assert.equal(new Set(shared.actions.map(row => row.gridId + ':' + row.index)).size, shared.actions.length);
    f.unknown = true; await run(f, s, ledger); assert.equal(f.client.writes.filter(row => row.body.index === 0).length, 1);
  });
  await test('追杀目标仍受安全名单、同盟、战力、耐久、编队和次数限制', async () => {
    const cases = [
      ['安全玩家', (f, s, p) => { p.safePlayers = ['名单目标']; }],
      ['安全联盟', (f, s, p) => { p.safeGuilds = ['8']; }],
      ['同盟玩家', f => { f.state.positions[5000][0].player.guildIdx = 7; }],
      ['超出战力', f => { f.state.positions[5000][0].player.power = 1001; }],
      ['耐久不足', f => { f.state.fleets[0].durability = 0; }],
      ['缺少编队', f => { f.state.buildings[0].fleet.formation.heroPositions = []; }],
      ['归属不符', f => { f.state.fleets[0].owner.playerId = '9007199254840999'; }],
      ['服务器次数耗尽', f => { f.state.fightTimes = f.state.maxFightTimes; }],
      ['舰队每日次数耗尽', (f, s, p, ledger) => { p.dailyAttackLimit = 1; ledger.confirm(ledger.reserve({ siliconAttacks1: 1 }, {}, {})); }],
      ['只占空位', (f, s, p) => { p.emptyOnly = true; }],
      ['初等矿不抢占', (f, s, p) => { p.tiers = ['BLUE']; f.state.positions[3000] = f.state.positions[5000]; }],
    ];
    for (const [label, mutate] of cases) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), policy = hunt(s); f.enemy(0, '名单目标', 900); f.enemy(1, '其他甲', 100); f.enemy(2, '其他乙', 100);
      mutate(f, s, policy, ledger); assert.equal((await plan(f, s, ledger)).actions.length, 0, label);
    }
  });
  await test('追杀失败上限会阻止再次攻击，不能改名单绕过持久失败记录', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), policy = hunt(s); f.enemy(0, '名单目标', 900); f.enemy(1, '其他甲', 100); f.enemy(2, '其他乙', 100);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1); f.returnFleet('1远征船'); await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
    policy.huntPlayers = ['其他甲', '名单目标']; policy.safePlayers = ['其他甲']; await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
  });
  await test('采一次即撤先等首次奖励，撤回和重新出击分轮执行', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'afterReward'); f.occupy('1远征船', 5000, 0, 0); f.enemy(1, '名单目标', 800);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
    f.state.positions[5000].find(row => row.player.fleetId).player.rewardTimes = 1;
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest']);
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest', 'ChipMineSendFleetRequest']); assert.equal(f.client.writes[1].body.index, 1);
  });
  await test('采一次即撤不依赖发现目标，关闭追杀或保持采集时不自动撤', async () => {
    for (const [enabled, retreat, expected] of [[true, 'afterReward', 1], [false, 'afterReward', 0], [true, 'never', 0]]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), policy = hunt(s, ['未出现目标'], retreat); policy.huntEnabled = enabled; f.occupy('1远征船', 5000, 0, 1);
      await run(f, s, ledger); assert.equal(f.client.writes.length, expected); if (expected) assert.equal(f.client.writes[0].name, 'ChipMineRetreatRequest');
    }
  });
  await test('发现目标先撤再打：无目标继续采集，首奖之前等待，返港后重新选目标', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 0);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0); f.enemy(1, '名单目标', 800);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0); f.state.positions[5000].find(row => row.player.fleetId).player.rewardTimes = 1;
    f.afterWrite = name => { if (name === 'ChipMineRetreatRequest') Object.assign(f.state.fleets[0], { state: 2, curGridIdx: 5000, targetGridIdx: 0, moveEndTs: Math.floor(Date.now() / 1000) + 60 }); };
    await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest']);
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
    f.returnFleet('1远征船'); f.afterWrite = null; await run(f, s, ledger); assert.equal(f.client.writes.at(-1).name, 'ChipMineSendFleetRequest'); assert.equal(f.client.writes.at(-1).body.index, 1);
  });
  await test('发现目标撤回仍检查攻击预算和保护条件，不为不可攻击目标放弃矿位', async () => {
    const cases = [
      ['安全玩家', (f, s, p) => { p.safePlayers = ['名单目标']; }],
      ['同盟', f => { f.state.positions[5000][1].player.guildIdx = 7; }],
      ['敌方过强', f => { f.state.positions[5000][1].player.power = 2000; }],
      ['只占空位', (f, s, p) => { p.emptyOnly = true; }],
      ['实际汽油不足', f => { f.state.fuel = 499; }],
      ['共享待确认汽油', (f, s, p, ledger) => { ledger.reserve({ treasurePetrol: 49900 }, {}, {}, { uniqueKey: 'shared-hunt', details: {} }); }],
      ['抢占次数耗尽', f => { f.state.fightTimes = 30; }],
      ['低耐久', f => { f.state.fleets[0].durability = 0; }],
      ['缺少编队', f => { f.state.buildings[0].fleet.formation.heroPositions = []; }],
    ];
    for (const [label, mutate] of cases) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f), policy = hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800);
      mutate(f, s, policy, ledger); await run(f, s, ledger); assert.equal(f.client.writes.length, 0, label);
    }
  });
  await test('发送前名单目标消失或关闭追杀时取消撤回', async () => {
    for (const removeTarget of [true, false]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800); let reads = 0;
      f.beforeRead = name => { if (name === 'ChipMineListRequest' && ++reads === 2) { if (removeTarget) f.state.positions[5000] = f.state.positions[5000].filter(row => row.player.fleetId); else s.silicon.fleets[0].huntEnabled = false; } };
      await run(f, s, ledger); assert.equal(f.client.writes.length, 0); assert.equal(ledger.snapshot().uncertain, 0);
    }
  });
  await test('发送前同矿位换成名单外玩家时不攻击，返港后也不会沿用旧目标', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800);
    await run(f, s, ledger); assert.equal(f.client.writes[0]?.name, 'ChipMineRetreatRequest');
    let reads = 0; f.beforeRead = name => { if (name === 'ChipMineListRequest' && ++reads === 2) f.state.positions[5000][0].player.nickname = '无关船长'; };
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(ledger.snapshot().counters.siliconAttacks1 ?? 0, 0);
    f.beforeRead = null; await run(f, s, ledger); assert.equal(f.client.writes.length, 2); assert.equal(f.client.writes[1].body.index, 0); assert.equal(ledger.snapshot().counters.siliconAttacks1 ?? 0, 0);
  });
  await test('采矿舰队状态或归属与矿位不一致时不发撤回请求', async () => {
    for (const mutate of [f => { f.state.fleets[0].state = 2; }, f => { f.state.fleets[0].curGridIdx = 4000; }, f => { f.state.fleets[0].owner.playerId = '9007199254840999'; }]) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'afterReward'); f.occupy('1远征船', 5000, 0, 1); mutate(f);
      await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
    }
  });
  await test('原矿详情校验失败时不撤回，即使部分响应仍带己方矿位', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'afterReward'); f.occupy('1远征船', 5000, 0, 1);
    f.state.positions[5000].push({ index: 1, player: { nickname: '数据异常', guildIdx: 8, power: -1, rewardTimes: 1 } });
    await run(f, s, ledger); assert.equal(f.client.writes.length, 0);
  });
  await test('未知追杀撤回跨重启保留，原矿不可读时不能靠空闲状态再次出击', async () => {
    const f = siliconFixture(), s = siliconSettings(), file = path.join(dir, 'hunt-restart.json'); hunt(s, ['名单目标'], 'onTarget');
    const reopen = () => createUsageLedger('虚构追杀重启账号', { file, now: () => Date.now() + f.client.serverClockOffsetMs }); let ledger = reopen();
    f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800); f.unknown = true;
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(ledger.keyRecords()['silicon-retreat:3001001:1'].confirmed, false);
    ledger = reopen(); await run(f, s, ledger); assert.equal(f.client.writes.length, 1);
    f.returnFleet('1远征船'); f.beforeRead = (name, body) => { if (name === 'ChipMineRequest' && body.gridId === 5000) throw Error('原矿暂时不可读取'); };
    await run(f, s, ledger); assert.equal(f.client.writes.length, 1); assert.equal(ledger.keyRecords()['silicon-retreat:3001001:1'].confirmed, false);
    f.beforeRead = null; f.unknown = false; await run(f, s, ledger); assert.equal(f.client.writes.length, 2); assert.equal(f.client.writes[1].name, 'ChipMineSendFleetRequest');
  });
  await test('追杀按两分钟扫描，关闭追杀恢复普通间隔，停用舰队不触发高频读取', () => {
    const s = siliconSettings(), policy = hunt(s); assert.equal(siliconInterval(s), 120000);
    policy.huntEnabled = false; assert.equal(siliconInterval(s), 600000); policy.huntEnabled = true; policy.enabled = false; assert.equal(siliconInterval(s), 600000);
  });
  await test('发现目标撤回避让其他未知任务、维修预留和旧情报占用', async () => {
    const cases = [
      ['其他未确认持久任务', (f, s, ledger) => { ledger.reserve({}, {}, {}, { uniqueKey: 'radar-send:3001001:1', details: { kind: 'radarSend', worldId: '3001001', buildingId: '1远征船', active: true } }); }],
      ['已确认但不匹配本矿的旧采矿记录', (f, s, ledger) => { ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: 'silicon:3001001:1', details: { kind: 'siliconDispatch', worldId: '3001001', buildingId: '1远征船', gridId: 4000, index: 0, active: true } })); }],
      ['战后维修优先预留', f => { reserveDispatch(f.client, 'maintenance', ['1远征船']); }],
      ['旧情报锁', f => { registerFleetReservations(f.client, 'radar', id => id === '1远征船'); }],
    ];
    for (const [label, hold] of cases) {
      const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800);
      hold(f, s, ledger); await run(f, s, ledger); assert.equal(f.client.writes.length, 0, label);
    }
  });
  await test('已确认本矿采矿锁及共享桥接不会阻止自己的追杀撤回', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['名单目标'], 'onTarget'); f.occupy('1远征船', 5000, 0, 1); f.enemy(1, '名单目标', 800);
    ledger.confirm(ledger.reserve({ siliconPetrol: 500 }, {}, {}, { uniqueKey: 'silicon:3001001:1', details: { kind: 'siliconDispatch', worldId: '3001001', buildingId: '1远征船', gridId: 5000, index: 0, active: true, occupied: true } }));
    bridgeFleetReservations(f.client, () => s, ledger, '3001001'); await run(f, s, ledger);
    assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest']); assert.equal(ledger.snapshot().counters.siliconPetrol, 500);
  });
  await test('多舰追杀撤回共用后续汽油和抢占额度，返航跨轮跨重启继续保留意向', async () => {
    const limits = [
      ['余额只够一次', (f, s) => { f.state.fuel = 500; }],
      ['抢占额度只剩一次', (f, s) => { f.state.fightTimes = 29; }],
    ];
    for (const [label, limit] of limits) {
      const f = siliconFixture(), s = siliconSettings(), file = path.join(dir, 'return-hunt-' + (++seq) + '.json');
      const reopen = () => createUsageLedger('虚构多舰返航账号', { file, now: () => Date.now() + f.client.serverClockOffsetMs }); let ledger = reopen();
      hunt(s, ['第一目标'], 'onTarget'); hunt(s, ['第二目标'], 'onTarget', 1); s.silicon.fleets[1].enabled = true;
      f.state.mines.find(row => row.gridId === 5000).positionNum = 4;
      f.occupy('1远征船', 5000, 0, 1); f.occupy('2远征船', 5000, 1, 1); f.enemy(2, '第一目标', 800); f.enemy(3, '第二目标', 800); limit(f, s);
      assert.deepEqual((await plan(f, s, ledger)).actions.map(row => row.buildingId), ['1远征船'], label);
      f.afterWrite = (name, body) => { if (name === 'ChipMineRetreatRequest') Object.assign(f.state.fleets.find(row => row.buildingId === body.fleetId), { state: 2, curGridIdx: 5000, targetGridIdx: 0, moveEndTs: Math.floor(Date.now() / 1000) + 60 }); };
      await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.body.fleetId), ['1远征船'], label);
      const record = ledger.keyRecords()['silicon-retreat:3001001:1']; assert.equal(record.confirmed, true, label); assert.equal(record.details.huntTarget.opponent.nickname, '第一目标', label);
      assert.equal(ledger.snapshot().counters.siliconPetrol ?? 0, 0, label); assert.equal(ledger.snapshot().counters.siliconAttacks1 ?? 0, 0, label); assert.equal(pendingPetrol(ledger), 0, label);
      ledger = reopen(); await run(f, s, ledger); assert.equal(f.client.writes.length, 1, label); assert(ledger.hasKey('silicon-retreat:3001001:1'), label);
      f.returnFleet('1远征船'); f.afterWrite = null; await run(f, s, ledger);
      assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineRetreatRequest', 'ChipMineSendFleetRequest'], label); assert.equal(f.client.writes[1].body.index, 2, label);
      assert.equal(ledger.hasKey('silicon-retreat:3001001:1'), false, label); assert.equal(ledger.snapshot().counters.siliconPetrol, 500, label); assert.equal(ledger.snapshot().counters.siliconAttacks1, 1, label);
    }
  });
  await test('追杀返航持续占住目标，其他采矿舰队不会为同一目标一起撤回', async () => {
    const f = siliconFixture(), s = siliconSettings(), ledger = usage(f); hunt(s, ['共享目标'], 'onTarget'); hunt(s, ['共享目标'], 'onTarget', 1); s.silicon.fleets[1].enabled = true;
    f.occupy('1远征船', 5000, 0, 1); f.occupy('2远征船', 5000, 1, 1); f.enemy(2, '共享目标', 800);
    assert.equal((await plan(f, s, ledger)).actions.length, 1);
    f.afterWrite = name => { if (name === 'ChipMineRetreatRequest') Object.assign(f.state.fleets[0], { state: 2, curGridIdx: 5000, targetGridIdx: 0, moveEndTs: Math.floor(Date.now() / 1000) + 60 }); };
    await run(f, s, ledger); await run(f, s, ledger); assert.deepEqual(f.client.writes.map(row => row.body.fleetId), ['1远征船']);
    assert.equal(ledger.keyRecords()['silicon-retreat:3001001:1'].details.huntTarget.index, 2); assert.equal((await plan(f, s, ledger)).actions.length, 0);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`硅矿离线检查：${results.filter(Boolean).length}/${results.length}`); if (results.some(passed => !passed)) process.exitCode = 1;
