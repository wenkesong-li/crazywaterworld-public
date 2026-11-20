import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../src/production-planning-ui.js', import.meta.url), 'utf8');
let passed = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const nodes = new Map();
  const env = { calls: [], errors: [], tables: [], current: 'account-a', snapshot: { connected: true, paused: false }, disconnected: new Set() };
  function element(tag = 'div', className = '', value = '') {
    let text = String(value ?? '');
    return {
      tagName: tag, className, disabled: false, children: [],
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value ?? ''); this.children = []; },
      appendChild(child) { this.children.push(child); return child; },
    };
  }
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  env.element = element;
  env.clear = node => { node.textContent = ''; return node; };
  env.table = (headers, rows) => {
    env.tables.push({ headers, rows });
    return element('table', '', [headers, ...rows].flat().map(cell => cell.textContent ?? cell).join(' '));
  };
  env.respond = async () => ({ statusLabel: '固定快照模型内最优', snapshotTime: 1767225600,
    completionAt: 1767225661, upperBound: 61, lowerBound: 60, scope: 'all-orders',
    orders: [{ id: 'resident:1', label: '居民订单', requirements: [{ id: 'bread', name: '面包', num: 2 }], completionAt: 1767225661, statusLabel: '联合方案已齐套' }],
    timeline: [{ machineId: 'factory:1', machineName: '食品厂', itemId: 'bread', productName: '面包', quantity: 2,
      startAt: 1767225600, finishAt: 1767225661, timingLabel: '会话实测' }],
    notes: ['共同材料只分配一次'], missingReads: [], assumptions: ['共同材料只分配一次'],
  });
  env.call = async route => { env.calls.push(route); return env.respond(route); };
  newStateFunction('env', `
    'use strict';
    const $ = env.node, el = env.element, clear = env.clear, table = env.table;
    const chip = (state, label) => el('span', state, label);
    const call = env.call, reportError = error => env.errors.push(error), disconnected = env.disconnected;
    let current = env.current, snapshot = env.snapshot;
    ${script}
    env.reset = resetProductionPlan;
    env.time = productionPlanTime;
    env.duration = productionPlanDuration;
    env.render = renderProductionPlan;
    env.changeAccount = account => {
      current = account;
      resetProductionPlan();
      $('production-plan-refresh').disabled = !snapshot.connected || snapshot.paused || disconnected.has(current);
    };
    env.setCurrent = account => { current = account; };
  `)(env);
  env.click = () => env.node('production-plan-refresh').disabled ? undefined : env.node('production-plan-refresh').onclick();
  return env;
}

async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

await test('按钮触发真实读取脚本，展示北京时间、逐单完成与生产顺序', async () => {
  const env = fixture();
  await env.click();
  assert.deepEqual(env.calls, ['/api/world/production-plan']);
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.match(env.node('production-plan-status').textContent, /数据更新于 .*北京时间/);
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /全部需求预计/);
  assert.match(text, /01\/01.*08:01:01/);
  assert.match(text, /约需 1分1秒/);
  assert.match(text, /面包 ×2/);
  assert.doesNotMatch(text, /模型内最优|会话实测|工期下界|共同材料只分配一次/);
  assert.equal(env.tables.length, 2);
  assert.equal(env.errors.length, 0);
});

await test('断开、暂停、无账号和主动断开状态均不发送读取', async () => {
  for (const mode of ['disconnected', 'paused', 'no-account', 'explicit-disconnect']) {
    const env = fixture();
    if (mode === 'disconnected') env.snapshot.connected = false;
    if (mode === 'paused') env.snapshot.paused = true;
    if (mode === 'no-account') env.setCurrent(null);
    if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    await env.click();
    assert.deepEqual(env.calls, []);
  }
});

await test('等待期间按钮禁用，失败后恢复点击并显示错误状态', async () => {
  const env = fixture(), pending = deferred();
  env.respond = () => pending.promise;
  const running = env.click();
  assert.equal(env.node('production-plan-refresh').disabled, true);
  assert.match(env.node('production-plan-status').textContent, /正在生成计划/);
  env.click();
  assert.equal(env.calls.length, 1);
  const error = new Error('测试读取失败');
  pending.reject(error);
  await running;
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.equal(env.node('production-plan-status').textContent, '生成失败，请重试');
  assert.deepEqual(env.errors, [error]);
});

await test('无需求、读取不全和条件不足时给出对应提示', () => {
  const env = fixture();
  const result = env.node('production-plan-result');
  env.render({ status: 'optimal', orders: [], completionAt: 1767225600, upperBound: 0 });
  assert.equal(result.textContent, '当前没有需要备料的需求。');
  env.render({ status: 'incomplete', missingReads: ['AllItemRequest'], orders: [] });
  assert.match(result.textContent, /生产数据还不完整/);
  assert.doesNotMatch(result.textContent, /AllItemRequest|没有需要/);
  env.render({ status: 'infeasible' });
  assert.match(result.textContent, /无法备齐所有需求/);
  env.render({});
  assert.match(result.textContent, /暂时无法预计/);
  assert.equal(env.time(null), '时间待定');
  assert.equal(env.duration(3661), '1小时1分1秒');
});

await test('各需求保留状态与备齐时间，跳过的需求不计入完成时间', () => {
  const env = fixture();
  const now = 1767225600;
  const skipped = { label: '不差钱商人', skipped: true, reason: '工厂等级不足或已停用（电路板）',
    requirements: [{ id: '电路板', num: 1 }] };
  env.render({ scope: 'feasible-demands', snapshotTime: now, completionAt: now + 60, upperBound: 60,
    priorityBounds: [{ label: '第1级' }], orders: [
      skipped, { label: '建筑备料', completionAt: now }, { label: '居民订单', completionAt: now + 60 },
    ] });
  assert.match(env.node('production-plan-result').textContent, /参与排产的需求预计/);
  assert.deepEqual(env.tables[0].headers, ['需求来源', '所需物品', '预计备齐']);
  assert.deepEqual(env.tables[0].rows.map(row => row.map(cell => cell.textContent)), [
    ['不差钱商人', '电路板 ×1工厂等级不足或已停用（电路板）', '已跳过'],
    ['建筑备料', '', '现在可备齐'], ['居民订单', '', env.time(now + 60)],
  ]);
  env.render({ orders: [skipped] });
  assert.match(env.node('production-plan-result').textContent, /本次需求均已跳过/);
});

await test('展开材料树按每批产量逐级换算，共用材料和循环配方可安全查看', () => {
  const env = fixture();
  env.render({ orders: [{ label: '贸易港', requirements: [{ id: '面包', num: 3 }, { id: '小麦', num: 1 }] }],
    recipes: [
      { productId: '面包', output: 1, inputs: [{ id: '小麦', num: 2 }] },
      { productId: '小麦', output: 5, inputs: [{ id: '种子', num: 1 }] },
      { productId: '种子', output: 1, inputs: [{ id: '小麦', num: 1 }] },
    ] });
  function expand(row) {
    const details = row.children[0];
    assert.equal(details.tagName, 'details');
    details.open = true;
    details.ontoggle();
    details.ontoggle();
    assert.equal(details.children.length, 2);
    return details.children[1].children[0];
  }
  const [source, materials] = env.tables[0].rows[0];
  assert.equal(source.tagName, 'strong');
  const [tree] = materials.children;
  const [bread, wheat] = tree.children;
  assert.ok(!bread.children[0].open);
  assert.equal(bread.children[0].name, wheat.children[0].name);
  assert.equal(bread.textContent, '面包 ×3');
  const ingredient = expand(bread);
  assert.equal(ingredient.textContent, '小麦 ×6');
  const seed = expand(ingredient);
  assert.equal(seed.textContent, '种子 ×2');
  assert.equal(expand(seed).children[0].tagName, 'span');
  assert.equal(expand(wheat).textContent, '种子 ×1');
});

await test('生产顺序和已有队列默认收起，保留原料与并行开工时间', () => {
  const env = fixture();
  const now = 1767225600;
  env.render({ timeline: [
    { kind: 'existing', machineId: '材料厂', itemId: '木板', quantity: 1 },
    { machineId: '食品厂', itemId: '面包', quantity: 1, startAt: now, finishAt: now + 20,
      inputs: [{ itemId: '小麦', quantity: 1 }] },
    { machineId: '农田', itemId: '小麦', quantity: 1, startAt: now, finishAt: now + 5, inputs: [] },
  ] });
  const details = env.node('production-plan-result').children.filter(child => child.tagName === 'details');
  assert.deepEqual(details.map(node => node.children[0].textContent), ['建议生产顺序（2 批）', '游戏内生产队列（1 批）']);
  assert.ok(details.every(node => !node.open));
  assert.deepEqual(env.tables[0].rows[0].map(cell => cell.textContent ?? cell), ['食品厂', '面包 ×1', env.time(now), env.time(now + 20)]);
  const bread = env.tables[0].rows[0][1].children[0].children[0];
  bread.open = true;
  bread.ontoggle();
  assert.equal(bread.children[1].textContent, '小麦 ×1');
  assert.equal(env.tables[0].rows[1][2], env.time(now));
  assert.equal(env.tables[1].rows[0][1].textContent, '木板 ×1');
});

await test('切换账号清理结果，旧请求成功或失败均不会覆盖新账号', async () => {
  for (const outcome of ['success', 'error']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    env.node('production-plan-result').textContent = '旧账号方案';
    const running = env.click();
    env.changeAccount('account-b');
    assert.equal(env.node('production-plan-result').textContent, '');
    if (outcome === 'success') pending.resolve({ statusLabel: '过期方案' });
    else pending.reject(new Error('旧账号错误'));
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-status').textContent, '');
    assert.equal(env.node('production-plan-refresh').disabled, false);
    assert.deepEqual(env.errors, []);
  }
});

await test('读取期间暂停、网络或主动断开后丢弃旧结果', async () => {
  for (const mode of ['paused', 'explicit-disconnect', 'network-disconnect']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    const running = env.click();
    if (mode === 'paused') env.snapshot.paused = true;
    else if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    else env.snapshot.connected = false;
    pending.resolve({ statusLabel: '旧连接方案' });
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-refresh').disabled, true);
  }
});

console.log('排产界面测试通过 ' + passed + ' 项');
