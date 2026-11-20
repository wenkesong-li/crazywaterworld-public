// 真实协议只读夹具：军备竞赛独立参与，普通锻造保留自己的启停规则。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { previewEquipmentForge } from '../src/equipment-forge-preview.mjs';
import { nativeForgeKey } from '../src/equipment-forge-native.mjs';
import { runLoop } from '../src/loop.mjs';
import { weeklyForgeRecipes } from '../src/weekly-activity-runner.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';

function fixture() {
  const f = warForgeFixture(), settings = warForgeSettings();
  f.player.worldId = f.protocol.PlayerInfo.decode(f.protocol.PlayerInfo.encode({ worldId: '2000001' }).finish()).worldId;
  f.config.tables.ModuleOpenCfg.data.push({ moduleId: '每日跨服比拼', playerLevel: 20 });
  Object.assign(settings.weeklyActivity, { enabled: true, forgeEnabled: true, forgeStop: 'allDay' });
  const rank = { subjectId: 2, roomLevel: 1, grouping: false, settleTime: Math.floor(Date.now() / 1000) + 3600,
    rankList: [{ playerId: f.player.playerId, score: 0, rank: 1, nickname: '测试角色', level: 40, avatar: {} }] };
  const request = f.client.request;
  let weeklyReads = 0;
  f.client.request = async (name, ...args) => {
    if (name !== 'CrossRankInfoRequest') return request(name, ...args);
    weeklyReads++;
    if (f.weeklyError) throw f.weeklyError;
    return f.protocol.CrossRankInfoResponse.decode(f.protocol.CrossRankInfoResponse.encode(rank).finish());
  };
  const identity = { worldId: String(f.player.worldId), playerId: String(f.player.playerId) };
  return { ...f, settings, rank, weeklyReads: () => weeklyReads,
    failWeekly(error) { f.weeklyError = error; },
    ownedNative(buildingId = '1装备厂') {
      return { [nativeForgeKey(identity, buildingId)]: { confirmed: true,
        details: { ...identity, kind: 'forgeNative', buildingId, isOn: true } } };
    },
    async preview(options = {}) {
      const before = structuredClone(settings), optionsBefore = structuredClone(options);
      const result = await previewEquipmentForge(f.client, f.protocol, f.config, f.player, settings, options);
      assert.equal(result.snapshot.reason, '');
      assert.equal(f.client.writes.length, 0, '预览不得开启原生、领取或制造装备');
      assert.deepEqual(settings, before, '活动执行不能改写用户保存的设置');
      assert.deepEqual(options, optionsBefore, '预览不能修改用量或持久任务记录');
      return result.plan;
    },
  };
}

function assertHeld(plan, reason) {
  assert.deepEqual(plan.actions, []);
  assert.match(plan.notes.join('；'), /军备竞赛装备打造暂不执行/);
  assert.match(plan.notes.join('；'), reason);
  assert(plan.factories.length > 0);
  for (const factory of plan.factories) {
    assert.match(factory.reason, /军备竞赛装备打造暂不执行/);
    assert.match(factory.reason, reason);
    assert.doesNotMatch(factory.reason, /可安排所选配方/);
  }
}

let passed = 0;
async function test(name, work) { await work(); passed++; console.log('通过：' + name); }

await test('非装备打造日由普通开关决定制造，开启军备竞赛不再阻止日常制造', async () => {
  for (const ordinary of [false, true]) {
    const f = fixture(); f.rank.subjectId = 4; f.settings.forge.enabled = ordinary;
    const plan = await f.preview();
    if (ordinary) {
      assert.equal(plan.actions[0]?.kind, 'forgeStart');
      assert.match(plan.notes.join('；'), /普通自动锻造按自身配置执行/);
      assert.equal(plan.factories[0].reason, '可安排所选配方');
    } else assertHeld(plan, /藏品培养/);
    assert.equal(f.weeklyReads(), 1);
  }
});

await test('今日其他已启用活动不干扰普通装备制造', async () => {
  const f = fixture(); f.rank.subjectId = 4; f.settings.weeklyActivity.antiqueEnabled = true;
  const plan = await f.preview();
  assert.equal(plan.actions[0]?.kind, 'forgeStart');
  assert.match(plan.notes.join('；'), /今日为藏品培养/);
});

await test('非打造日仍遵守普通续产和领取细项，不因活动授权而强行开启', async () => {
  const f = fixture(); f.rank.subjectId = 4;
  f.settings.forge.craft = false;
  let plan = await f.preview();
  assert.equal(plan.actions.length, 0);
  assert.match(plan.factories[0].reason, /自动续产已关闭/);
  f.settings.forge.collect = false;
  f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 60 };
  plan = await f.preview();
  assert.equal(plan.actions.length, 0);
  assert.match(plan.factories[0].reason, /自动领取已关闭/);
});

await test('装备日积分达标仅停止军备竞赛，普通制造按自身开关继续', async () => {
  for (const ordinary of [false, true]) {
    const f = fixture(); f.settings.forge.enabled = ordinary;
    Object.assign(f.settings.weeklyActivity, { forgeStop: 'score', forgeScore: 100 });
    f.rank.rankList[0].score = 100;
    const plan = await f.preview();
    if (ordinary) {
      assert.equal(plan.actions[0]?.kind, 'forgeStart');
      assert.match(plan.notes.join('；'), /已达目标积分（100\/100）/);
    } else assertHeld(plan, /已达目标积分（100\/100）/);
  }
});

await test('军备竞赛未开放时不影响已解锁工厂的普通制造', async () => {
  for (const ordinary of [false, true]) {
    const f = fixture(); f.player.level = 19; f.settings.forge.enabled = ordinary;
    const plan = await f.preview();
    if (ordinary) assert.equal(plan.actions[0]?.kind, 'forgeStart');
    else assertHeld(plan, /尚未开放|开放条件未同步/);
    assert.equal(f.weeklyReads(), 0);
  }
});

await test('活动分组及未知本人积分不会启用已关闭的普通制造', async () => {
  const grouping = fixture(); grouping.rank.grouping = true; grouping.settings.forge.enabled = false;
  assertHeld(await grouping.preview(), /活动分组/);
  const unknown = fixture();
  unknown.settings.forge.enabled = false;
  Object.assign(unknown.settings.weeklyActivity, { forgeStop: 'score', forgeScore: 100 });
  unknown.rank.rankList = [];
  assertHeld(await unknown.preview(), /无法确认本人积分/);
});

await test('打造日按周活动品质顺序选配方且保留用户原顺序', async () => {
  for (const order of ['asc', 'desc']) {
    const f = fixture();
    f.settings.forge.recipeIds = ['1002', '1001'];
    f.settings.weeklyActivity.forgeQualityOrder = order;
    const expected = weeklyForgeRecipes(f.settings.forge.recipeIds, f.config, order)[0];
    const plan = await f.preview();
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].kind, 'forgeStart');
    assert.equal(plan.actions[0].body.makeId, Number(expected));
    assert.equal(plan.factories[0].reason, '可安排所选配方');
  }
});

await test('普通锻造总开关与领取续产都关闭时，军备竞赛仍可制造和领取', async () => {
  for (const completed of [false, true]) {
    const f = fixture(); Object.assign(f.settings.forge, { enabled: false, collect: false, craft: false });
    if (completed) f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 60 };
    const plan = await f.preview();
    assert.equal(plan.actions[0]?.kind, completed ? 'forgeClaim' : 'forgeStart');
    assert.match(plan.notes.join('；'), /军备竞赛独立执行/);
  }
});

await test('周活动打造仍检查可用金币', async () => {
  const f = fixture(); f.state.gold = 1999;
  const plan = await f.preview();
  assert.equal(plan.actions.length, 0);
  assert.match(plan.factories[0].reason, /金币不足/);
});

await test('关闭周活动或不勾选装备打造时保持普通装备制造', async () => {
  for (const field of ['enabled', 'forgeEnabled']) {
    const f = fixture(); f.rank.subjectId = 4; f.settings.weeklyActivity[field] = false;
    const plan = await f.preview();
    assert.equal(plan.actions[0]?.kind, 'forgeStart');
    assert.equal(plan.factories[0].reason, '可安排所选配方');
    assert.equal(f.weeklyReads(), 0);
  }
});

await test('原生自动锻造不受军备竞赛主题或积分停止规则限制', async () => {
  const f = fixture(); f.rank.subjectId = 4;
  f.settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  const plan = await f.preview();
  assert.equal(plan.actions[0]?.kind, 'forgeNative');
  assert.equal(plan.actions[0].body.isOn, true);
  assert.equal(f.weeklyReads(), 0);
  f.state.factory.auto = true;
  const running = await f.preview();
  assert.equal(running.actions.length, 0);
  assert.match(running.factories[0].reason, /游戏原生自动锻造已开启/);
});

await test('非打造日和达标后保留普通计划的原生关闭和其他工厂制造', async () => {
  for (const reached of [false, true]) {
    const f = fixture(); f.state.factory.auto = true;
    if (reached) {
      Object.assign(f.settings.weeklyActivity, { forgeStop: 'score', forgeScore: 100 });
      f.rank.rankList[0].score = 100;
    } else f.rank.subjectId = 4;
    f.settings.forge.buildingIds.push('2装备厂');
    f.config.tables.BuildingUnlockCfg.data.push({ buildingId: '2装备厂', buildingType: '装备厂', playerLevel: 17 });
    f.state.buildings.push({ buildingId: '2装备厂', level: 1, auto: false });
    const plan = await f.preview({ keys: f.ownedNative() });
    assert.equal(plan.actions.length, 2);
    assert.equal(plan.actions[0].kind, 'forgeNative');
    assert.equal(plan.actions[0].body.isOn, false);
    assert.equal(plan.actions[0].body.buildingId, '1装备厂');
    assert.equal(plan.actions[1].kind, 'forgeStart');
    assert.equal(plan.actions[1].body.buildingId, '2装备厂');
    assert.equal(plan.factories.find(row => row.buildingId === '2装备厂').reason, '可安排所选配方');
  }
});

await test('非活动日普通总开关关闭时不改原生状态，其他角色归属不能操作本角色', async () => {
  const disabled = fixture(); disabled.rank.subjectId = 4; disabled.state.factory.auto = true;
  disabled.settings.forge.enabled = false;
  assert.equal((await disabled.preview({ keys: disabled.ownedNative() })).actions.length, 0);
  const foreign = fixture(); foreign.rank.subjectId = 4; foreign.state.factory.auto = true;
  const record = Object.values(foreign.ownedNative())[0];
  record.details.playerId = '9007199254900999';
  const keys = { [nativeForgeKey(record.details, record.details.buildingId)]: record };
  assert.equal((await foreign.preview({ keys })).actions.length, 0);
});

await test('活动读取失败不启用军备竞赛消费，普通制造和原生关闭仍按自身配置执行', async () => {
  const f = fixture(); f.failWeekly(new Error('模拟活动读取超时')); f.settings.forge.enabled = false;
  assertHeld(await f.preview(), /军备竞赛状态未确认.*模拟活动读取超时/);
  f.settings.forge.enabled = true;
  assert.equal((await f.preview()).actions[0]?.kind, 'forgeStart');
  f.state.factory.auto = true;
  const plan = await f.preview({ keys: f.ownedNative() });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, 'forgeNative');
  assert.equal(plan.actions[0].body.isOn, false);
  assert.match(plan.notes.join('；'), /模拟活动读取超时/);
});

await test('真实挂机普通制造与军备竞赛按各自开关运行且不重复下单', async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-forge-preview-loop-'));
  try {
    for (const [subjectId, ordinary] of [[4, false], [4, true], [2, false], [2, true]]) {
      const f = fixture(), reports = [];
      f.rank.subjectId = subjectId; f.settings.cityWar.enabled = false;
      Object.assign(f.settings.forge, { enabled: ordinary, collect: ordinary, craft: ordinary });
      f.client.setMaxListeners(50);
      const id = subjectId + '-' + ordinary;
      const ledger = createUsageLedger('forge-preview-' + id, { file: path.join(directory, id + '.json') });
      await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
        isEnabled: () => false, getSettings: () => f.settings, usageLedger: ledger, onStep: entry => reports.push(entry) });
      const crafts = f.client.writes.filter(row => row.name === 'MakeEquipRequest');
      assert.equal(crafts.length, subjectId === 2 || ordinary ? 1 : 0);
      if (subjectId === 2) assert(reports.some(entry => entry.category === '周活动'
        && entry.step?.kind === 'forgeStart' && entry.ok), '打造日应由周活动正常制造');
    }
  } finally {
    assert.equal(path.dirname(directory), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

console.log('装备制造独立预览专项：' + passed + ' 项通过');
