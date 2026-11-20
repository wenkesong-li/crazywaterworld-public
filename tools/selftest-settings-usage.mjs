// 用真实锻造计划验证配置摘要；夹具只读虚构游戏状态，不连接游戏或执行制造。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readEquipmentForge, planEquipmentForge } from '../src/equipment-forge.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';

const source = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('function configRenderUsage()');
const end = source.indexOf('function configSyncRecovery(', start);
assert(start >= 0 && end > start, '应能执行真实配置摘要函数');
const render = new Function('configEditor', '$', 'clear', 'el', source.slice(start, end) + '\nconfigRenderUsage();');

function summary({ preview = null, controls = [], scope = 'module:forge' } = {}) {
  const group = { id: 'forge', title: '装备自动锻造', controlKeys: ['equipmentCraft', 'equipmentCollect'] };
  const editor = {
    category: 'equipment', selectedGroups: { equipment: 'forge' }, groups: new Map([['forge', group]]),
    runtime: { controls }, draft: {}, previewSummary: preview,
  };
  const usage = { children: [], append(...children) { this.children.push(...children); } };
  const nodes = { 'config-usage': usage, 'config-preview-scope': { value: scope } };
  render(editor, id => nodes[id], node => { node.children = []; return node; },
    (tag, className, textContent) => ({ tag, className, textContent }));
  const lines = usage.children.map(node => node.textContent);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^执行条件：/);
  assert.doesNotMatch(lines.join('\n'), /受限：|无已报限制/);
  return { condition: lines[2], progress: lines[1], text: lines.join('\n') };
}

function preview(values = {}) {
  return { group: 'forge', scope: 'module:forge', scopeLabel: '装备自动锻造', notes: [], actions: [], ...values };
}

async function forgePreview(change = () => {}) {
  const fixture = warForgeFixture(), settings = warForgeSettings();
  change(fixture, settings);
  const snapshot = await readEquipmentForge(fixture.client, fixture.protocol, fixture.config, fixture.player);
  assert.equal(snapshot.reason, '');
  const plan = planEquipmentForge(snapshot, fixture.config, settings);
  assert.equal(fixture.client.writes.length, 0, '预览不得发出游戏写请求');
  return { plan, preview: preview({ notes: plan.notes, actions: plan.actions, forge: plan }) };
}

let passed = 0;
async function test(name, action) {
  await action(); passed++;
  console.log('通过：' + name);
}

await test('金币不足的真实锻造计划完整显示原因且不重复', async () => {
  const result = await forgePreview(fixture => { fixture.state.gold = 1999; });
  assert.equal(result.plan.actions.length, 0);
  assert.match(result.plan.factories[0].reason, /金币不足/);
  assert.equal(summary(result).condition, '执行条件：1装备厂：' + result.plan.factories[0].reason);
});

await test('正常可制造时摘要补充工厂结果，不把无备注当成受限', async () => {
  const result = await forgePreview();
  assert.equal(result.plan.actions[0]?.kind, 'forgeStart');
  assert.deepEqual(result.plan.notes, []);
  const rendered = summary(result);
  assert.match(rendered.condition, /1装备厂：可安排所选配方/);
  assert.match(rendered.progress, /1项待执行（仅预览）/);
});

await test('正在锻造时显示等待完成并去重工厂与备注', async () => {
  const result = await forgePreview(fixture => {
    fixture.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) + 3600 };
  });
  assert.equal(result.plan.actions.length, 0);
  assert.equal(summary(result).condition, '执行条件：1装备厂：等待当前锻造完成');
});

await test('装备已完成时显示挂机领取说明', async () => {
  const result = await forgePreview(fixture => {
    fixture.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 60 };
  });
  assert.equal(result.plan.actions[0]?.kind, 'forgeClaim');
  assert.match(summary(result).condition, /1装备厂：制作已完成，挂机运行时自动领取（预览不执行）/);
});

await test('原生自动锻造运行时展示游戏接管说明', async () => {
  const result = await forgePreview((fixture, settings) => {
    settings.forge.nativeAuto = true;
    fixture.state.factory.auto = true;
  });
  assert.equal(result.plan.actions.length, 0);
  assert.match(summary(result).condition, /游戏原生自动锻造已开启，领取和续产由游戏处理；工具规则不生效/);
});

await test('配方信息未确认等不匹配旧关键词的真实原因不漏报', async () => {
  const result = await forgePreview(fixture => {
    fixture.config.tables.BuildingEquipMakeCfg.data[0].costItem = [['GOLD', 2000]];
  });
  assert.equal(result.plan.actions.length, 0);
  assert.match(summary(result).condition, /配方成本格式未确认/);
});

await test('新的条件措辞原样展示，不依赖预先列举的关键词', () => {
  const rendered = summary({ preview: preview({ notes: ['服务端返回额度校验标记 X17'] }) });
  assert.match(rendered.condition, /服务端返回额度校验标记 X17/);
});

await test('零动作且无说明时不宣称可执行或无条件限制', () => {
  const rendered = summary({ preview: preview() });
  assert.match(rendered.condition, /无可执行动作|暂无可执行动作/);
  assert.match(rendered.progress, /0项待执行/);
});

await test('有动作、只读和未预览的空说明状态可区分', () => {
  const planned = summary({ preview: preview({ actions: [{ label: '制造装备' }] }) });
  const readOnly = summary({ preview: preview({ viewOnly: true }) });
  const unseen = summary();
  assert.match(planned.condition, /可安排|可执行|待执行/);
  assert.match(readOnly.condition, /只读/);
  assert.match(unseen.condition, /预览|检查/);
  assert.equal(new Set([planned.condition, readOnly.condition, unseen.condition]).size, 3);
});

await test('运行态总控依赖与异常说明均保留原文', () => {
  const rendered = summary({ controls: [{
    key: 'equipmentCraft', enabled: true, blockedBy: ['英雄总控'],
    observation: { state: 'error', text: '服务器返回额度校验标记 X18', checkedAt: '2026-11-18T00:00:00Z' },
  }] });
  assert.match(rendered.condition, /需开启英雄总控/);
  assert.match(rendered.condition, /服务器返回额度校验标记 X18/);
});

await test('旧预览范围不覆盖当前模块的执行条件', () => {
  const rendered = summary({ preview: preview({ scope: 'module:antique', notes: ['过期的藏品条件'] }) });
  assert.doesNotMatch(rendered.text, /过期的藏品条件/);
  assert.match(rendered.condition, /预览|检查/);
});

await test('条件去重并最多展示三条，其余提供查看提示', () => {
  const rendered = summary({ preview: preview({
    notes: ['工厂甲：校验甲', '工厂乙：校验乙', '工厂甲：校验甲', '工厂丙：校验丙', '工厂丁：校验丁'],
    forge: { factories: [{ buildingId: '工厂甲', reason: '校验甲' }] },
  }) });
  assert.equal(rendered.condition.match(/校验甲/g)?.length, 1);
  assert.match(rendered.condition, /校验乙.*校验丙/);
  assert.doesNotMatch(rendered.condition, /校验丁/);
  assert.match(rendered.condition, /其余.*下方/);
});

console.log('配置执行条件摘要自检通过：' + passed + ' 项');
