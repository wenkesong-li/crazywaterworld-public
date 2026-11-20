import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';

const script = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('function renderWorld('));
const start = script.indexOf('function worldProductionTime(');
const end = script.indexOf('let worldVersion =', start);
assert(start >= 0 && end > start, '页面应包含工厂和农田的实际展示代码');
const refreshEnd = script.indexOf("$('inventory-refresh').onclick=", end);
assert(refreshEnd > end, '页面应包含账号切换时的海面刷新逻辑');
const durationStart = script.indexOf('function productionPlanDuration(');
const durationEnd = script.indexOf('function renderProductionPlan(', durationStart);
assert(durationStart >= 0 && durationEnd > durationStart);

function element(tag = 'div', className = '', value = '') {
  let text = String(value ?? '');
  const node = {
    tagName: tag, className, children: [], dataset: {}, attributes: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(' '); },
    set textContent(value) { text = String(value ?? ''); this.children = []; },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    after(sibling) { this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, sibling); sibling.parent = this.parent; },
    querySelectorAll(selector) {
      if (selector === 'tbody tr') return this.children.filter(child => child.tagName === 'tr');
      return this.children.flatMap(descendants).filter(child => matches(child, selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    focus() { this.focused = true; },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
  };
  node.classList = {
    add(name) { node.className = [node.className, name].filter(Boolean).join(' '); },
    contains(name) { return (node.className || '').split(' ').includes(name); },
  };
  return node;
}

function matches(node, selector) {
  if (selector === 'h2') return node.tagName === 'h2';
  const match = selector.match(/^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/);
  assert(match, '测试夹具未支持选择器 ' + selector);
  const [, tag, attribute, expected] = match;
  if (tag && node.tagName !== tag) return false;
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = attribute.startsWith('data-') ? node.dataset[key] : attribute === 'open' ? node.open : node.attributes[attribute];
  return expected === undefined ? value !== undefined && value !== false : String(value) === expected;
}

function descendants(root) {
  return [root, ...root.children.flatMap(descendants)];
}

function cellText(value) {
  return value?.textContent ?? value?.text ?? String(value);
}

function currentProductText(cell) {
  if (!cell?.children?.length) return cellText(cell);
  return cell.children.filter(child => child.tagName !== 'button').map(cellText).join(' ');
}

function fixture() {
  const nodes = new Map();
  const env = { now: 1767225600000, tables: [], element };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  env.clear = node => { node.textContent = ''; return node; };
  env.table = (headers, rows) => {
    const result = element('table');
    env.tables.push({ headers, rows, node: result });
    result.append(element('thead', '', headers.join(' ')));
    for (const row of rows) {
      const tr = element('tr');
      for (const value of row) {
        tr.append(value?.tagName ? value : element('td', '', value?.text ?? value));
      }
      result.append(tr);
    }
    return result;
  };
  env.document = {
    hidden: false,
    querySelectorAll(selector) {
      return [...nodes.values()].flatMap(descendants).filter(node => matches(node, selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  newStateFunction('env', `
    const $ = env.node, el = env.element, clear = env.clear, table = env.table;
    const document = env.document, Date = class extends globalThis.Date { static now() { return env.now; } };
    const chip = (state, label) => el('span', state, label);
    const component = id => {
      if (id !== 'ui-building-card') return el('button');
      const card = el('div'), header = el('div'), body = el('div');
      card.dataset.slot = 'card';
      header.dataset.slot = 'card-header';
      body.dataset.slot = 'card-content';
      header.appendChild(el('h2'));
      card.append(header, body);
      return card;
    }, iconEl = () => el('img');
    const renderInventory = () => {}, fmt = value => String(value);
    const resetInventory = () => {};
    const call = () => new Promise(() => {});
    const snapshot = { paused: false }, disconnected = new Set();
    let current = 'account-a';
    let orderClockOffset = 0;
    ${script.slice(script.indexOf('function orderState('), script.indexOf('const pendingResidentOrders'))}
    env.orderState = orderState;
    ${script.slice(durationStart, durationEnd)}
    ${script.slice(start, end)}
    ${script.slice(end, refreshEnd)}
    env.render = renderWorld;
    env.updateTimers = updateWorldProductionTimers;
    env.refreshUnavailable = mode => {
      if (mode === 'account') current = 'account-b';
      if (mode === 'paused') snapshot.paused = true;
      if (mode === 'disconnected') disconnected.add(current);
      refreshManualWorld(true);
    };
  `)(env);
  return env;
}

function productionButton(env, buildingId = '1食品厂') {
  const button = env.document.querySelectorAll('[data-factory-production]')
    .find(node => node.dataset.factoryProduction === buildingId);
  assert(button, buildingId + ' 应提供生产格展开按钮');
  return button;
}

function worldData(env, extra = {}) {
  return { serverNow: env.now / 1000 + 5, factories: [], farms: [], buildings: [], orders: [], stock: [],
    resFields: { fields: [], rows: [], totals: [] }, ...extra };
}

function factory(jobs = [], extra = {}) {
  return { buildingId: '1食品厂', type: '食品厂', typeName: '食品厂', level: 3,
    queue: jobs.length, capacity: 6, queueKnown: true, jobs, plannedJobs: [], auto: '面包', autoEnabled: false, ...extra };
}

let passed = 0;
function test(name, work) {
  work();
  passed++;
  console.log('通过：' + name);
}

test('海面依次展示工厂、农田、空位，活动工坊并入工厂表格', () => {
  const env = fixture();
  const data = worldData(env, {
    factories: [factory(), factory([], { buildingId: '1活动工厂', displayName: '活动工坊-1', type: '活动工厂', typeName: '活动工坊' })],
    farms: [10, 2, 1].map(index => ({ plot: index + '农田', level: 1, productId: null, productName: null, state: 'idle' })),
    buildings: [{ buildingId: '1材料厂', type: '材料厂', level: 0 }],
  });
  const original = JSON.stringify(data);
  env.render(data);
  const headings = descendants(env.node('world-factories')).filter(node => node.tagName === 'h2');
  assert.deepEqual(headings.map(node => node.textContent), ['工厂', '农田', '空位']);
  assert.equal(env.tables.length, 3);
  assert.deepEqual(env.node('world-factories').children.map(card => card.dataset.slot), ['card', 'card', 'card']);
  assert.deepEqual(env.tables[0].headers, ['建筑', '类型', '等级', '当前产物', '自动生产', '游戏排队']);
  assert.equal(env.tables[0].rows.length, 2);
  const workshop = productionButton(env, '1活动工厂');
  assert.equal(workshop.textContent, '活动工坊-1');
  assert.equal(workshop.attributes['aria-label'], '展开活动工坊-1的生产格');
  assert.deepEqual(env.tables[1].headers, ['农田', '等级', '当前作物', '状态与计时']);
  assert.deepEqual(env.tables[1].rows.map(row => row[0]?.text ?? row[0]), ['1农田', '2农田', '10农田']);
  assert.equal(JSON.stringify(data), original, '展示排序不能修改服务器快照');
});

test('居民订单以材料标签和逐项需缺留数量展示缺口，关闭自动交付也显示缺料', () => {
  const env = fixture();
  const shortages = [
    { name: '烤鱼', required: 3, owned: 50, available: 0, missing: 3 },
    { name: '食盐', required: 5, owned: 2, available: 2, missing: 3 },
  ];
  const order = { decision: { status: 'missing', reason: '材料不足：旧版长说明', shortages } };
  for (const autoDeliverOrders of [true, false]) {
    const state = env.orderState(order, { autoDeliverOrders });
    assert.equal(state.children[0].children[0].textContent, '材料不足');
    assert.equal(state.textContent.includes('自动交付已关闭'), !autoDeliverOrders);
    assert.doesNotMatch(state.textContent, /旧版长说明/);
    assert.deepEqual(state.children[1].children.map(row => row.children.map(cellText)), [
      ['烤鱼', '需：3', '缺：3', '留：50'], ['食盐', '需：5', '缺：3', '留：0'],
    ]);
  }
  order.decision.status = 'reserved';
  assert.match(env.orderState(order, { autoDeliverOrders: true }).textContent, /材料已预留/);
  const unknown = { decision: { status: 'unknown', reason: '库存读取失败' } };
  assert.match(env.orderState(unknown, { autoDeliverOrders: true }).textContent, /等待核对.*库存读取失败/);
});

function detailRow(button) {
  const row = button.parent;
  const detail = row.parent.children[row.parent.children.indexOf(row) + 1];
  assert.equal(detail.id, button.attributes['aria-controls']);
  return detail;
}

test('一键展开收起同步单厂开关，农田与空位可独立折叠并保留到刷新后', () => {
  const env = fixture();
  const data = worldData(env, {
    factories: [factory(), factory([], { buildingId: '2食品厂' })],
    farms: [{ plot: '1农田', level: 1, status: '空闲' }],
    buildings: [{ buildingId: '1材料厂', type: '材料厂', level: 0 }],
  });
  const groupButton = group => env.document.querySelector('[data-building-toggle="world-' + group + '-section"]');
  const list = group => env.document.querySelector('[data-building-list="world-' + group + '-section"]');
  const details = () => [productionButton(env), productionButton(env, '2食品厂')].map(detailRow);
  env.render(data);
  const bulk = groupButton('factory');
  assert.equal(bulk.textContent, '全部展开');
  productionButton(env).onclick();
  assert.equal(bulk.textContent, '全部展开');
  bulk.onclick();
  assert(details().every(detail => !detail.hidden));
  assert.equal(bulk.textContent, '全部收起');
  assert.equal(bulk.attributes['aria-controls'], details().map(detail => detail.id).join(' '));
  productionButton(env).onclick();
  assert.equal(bulk.attributes['aria-expanded'], 'false');
  bulk.onclick();
  assert.equal(bulk.attributes['aria-expanded'], 'true');

  assert.equal(list('farm').hidden, false);
  assert.equal(list('slot').hidden, false);
  groupButton('farm').onclick();
  assert.equal(list('farm').hidden, true);
  assert.equal(list('slot').hidden, false);
  env.document.activeElement = groupButton('farm');
  env.render(data);
  assert.equal(groupButton('farm').focused, true);
  assert.equal(groupButton('farm').attributes['aria-expanded'], 'false');
  assert.equal(list('farm').hidden, true);
  assert.equal(groupButton('factory').textContent, '全部收起');
  groupButton('factory').onclick();
  assert(details().every(detail => detail.hidden));
  groupButton('slot').onclick();
  groupButton('farm').onclick();
  assert.equal(list('farm').hidden, false);
  assert.equal(list('slot').hidden, true);
  env.refreshUnavailable('account');
  env.render(data);
  assert.equal(list('slot').hidden, false);
  assert.equal(groupButton('factory').textContent, '全部展开');
});

test('六个游戏格只展示已投产队列，工具拟投产物及估时单列', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { factories: [factory([
    { productId: '面包', finishTime: now + 65 },
    { productId: '饼干', estimatedFinishTime: now + 125 },
  ], { plannedJobs: [{ productId: '蛋糕', estimatedFinishTime: now + 180 }] })] }));
  const button = productionButton(env);
  const detail = detailRow(button);
  assert.equal(detail.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  button.onclick();
  assert.equal(detail.hidden, false);
  assert.equal(button.attributes['aria-expanded'], 'true');
  assert.equal(detail.children[0].colSpan, 6);
  const slots = descendants(detail).filter(node => node.classList.contains('factory-slot'));
  assert.equal(slots.length, 6);
  assert.match(slots[0].textContent, /格子 1.*生产中.*面包.*完成时间.*08:01:10/);
  assert.match(slots[1].textContent, /格子 2.*排队 #1.*饼干/);
  const [game, plan] = descendants(detail).filter(node => node.tagName === 'section');
  assert.doesNotMatch(game.textContent, /蛋糕|08:02:10/);
  assert.match(plan.children[0].textContent, /排产计划.*预计完成/);
  assert.match(plan.textContent, /蛋糕.*08:03:05/);
  assert.doesNotMatch(plan.textContent, /面包|饼干/);
  assert(slots.slice(2).every(slot => slot.textContent.includes('空闲')));
  button.onclick();
  assert.equal(detail.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
});

test('相邻同产物只显示整批最晚完成时间，跨日和部分时间未知时仍正确', () => {
  const env = fixture();
  const midnight = 1767283200;
  const plannedJobs = [
    ['面包', midnight - 5], ['面包', midnight + 5], ['面包', midnight], ['面条', null], ['面包', midnight + 10], ['面包', null],
  ].map(([productId, estimatedFinishTime]) => ({ productId, estimatedFinishTime }));
  env.render(worldData(env, { factories: [factory([], { plannedJobs })] }));
  const button = productionButton(env);
  button.onclick();
  const groups = descendants(detailRow(button)).filter(node => node.className === 'factory-planned-group');
  assert.deepEqual(groups.map(group => group.children[0].textContent), ['面包 ×3', '面条 ×1', '面包 ×2']);
  assert.deepEqual(groups.map(group => group.children.slice(1).map(node => node.textContent)),
    [['01/02 00:00:05'], ['时间待定'], ['时间待定']]);
});

test('多个在产位均展示剩余时间，排队摘要显示首项和总数', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { factories: [factory([
    { index: 10, productId: '面包', name: '面包', finishTime: now + 65 },
    { index: 11, productId: '面条', name: '面条', finishTime: now + 120 },
    { index: 12, productId: '饼干', name: '饼干', finishTime: null },
    { index: 13, productId: '蛋糕', name: '蛋糕', finishTime: 0 },
  ])] }));
  const row = env.tables[0].rows[0];
  const current = currentProductText(row[3]);
  assert.match(current, /面包.*1分5秒/);
  assert.match(current, /面条.*2分0秒/);
  assert.doesNotMatch(current, /饼干|蛋糕/);
  assert.match(cellText(row[5]), /饼干.*共 2 件/);
});

test('多座工厂可独立展开，刷新或工厂消失后按建筑保留状态', () => {
  const env = fixture();
  const data = worldData(env, { factories: [factory([{ productId: '饼干' }]), factory([], { buildingId: '2食品厂' })] });
  env.render(data);
  const first = productionButton(env), second = productionButton(env, '2食品厂');
  first.onclick();
  second.onclick();
  assert.match(detailRow(first).textContent, /饼干.*本轮没有待投产任务/);
  assert.equal((detailRow(second).textContent.match(/空闲/g) || []).length, 6);
  data.factories[0].jobs = [{ productId: '蛋糕' }];
  data.factories.reverse();
  env.document.activeElement = first;
  env.render(data);
  const updated = productionButton(env);
  assert.match(detailRow(updated).textContent, /蛋糕/);
  assert.equal(updated.focused, true);
  assert(!detailRow(productionButton(env, '2食品厂')).hidden);
  updated.onclick();
  env.render(data);
  assert(detailRow(productionButton(env)).hidden);
  assert(!detailRow(productionButton(env, '2食品厂')).hidden);
  env.render(worldData(env));
  env.render(data);
  assert(detailRow(productionButton(env, '2食品厂')).hidden);
});

test('切换账号、暂停或断开后清理旧账号的展开状态', () => {
  for (const mode of ['account', 'paused', 'disconnected']) {
    const env = fixture();
    const data = worldData(env, { factories: [factory([{ productId: '饼干' }])] });
    env.render(data);
    productionButton(env).onclick();
    env.refreshUnavailable(mode);
    assert.equal(env.node('world-factories').textContent, '', mode);
    env.render(data);
    assert(detailRow(productionButton(env)).hidden, mode);
  }
});

test('当前产物区分等待开工、已完成和空闲，缺少队列显示未同步', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  const cases = [
    { value: factory([{ index: 5, productId: '饼干', name: '饼干', finishTime: null }]), current: /待开工/, next: '饼干 ×1' },
    { value: factory([{ index: 5, productId: '面包', name: '面包', finishTime: now - 1 }]), current: /面包.*已完成.*待收取/, next: '—' },
    { value: factory(), current: /空闲/, next: '—' },
    { value: factory([], { queueKnown: false }), current: /未同步/, next: '未同步' },
  ];
  for (const entry of cases) {
    env.render(worldData(env, { factories: [entry.value] }));
    const row = env.tables.at(-1).rows[0];
    assert.match(currentProductText(row[3]), entry.current);
    assert.equal(cellText(row[5]), entry.next);
  }
});

test('自动生产按实际开关显示，缺少状态时显示未同步', () => {
  for (const [autoEnabled, expected] of [[true, '已开启'], [false, '未开启'], [undefined, '未同步']]) {
    const env = fixture();
    env.render(worldData(env, { factories: [factory([], { autoEnabled })] }));
    assert.equal(cellText(env.tables[0].rows[0][4]), expected);
  }
});

test('生产格容量变化或缺失时仍完整显示全部已排产项目', () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({ index: 100 + index, productId: '物品' + index, name: '物品' + index, finishTime: null }));
  for (const capacity of [6, null]) {
    const env = fixture();
    env.render(worldData(env, { factories: [factory(jobs, { capacity })] }));
    productionButton(env).onclick();
    const text = detailRow(productionButton(env)).textContent;
    for (const job of jobs) assert(text.includes(job.name), job.name);
    assert.equal(descendants(detailRow(productionButton(env))).filter(node => node.classList.contains('factory-slot')).length, 6);
    assert.match(text, /另外返回 1 项.*物品6/);
  }
});

test('倒计时使用服务器时间偏移，时间推进后更新工厂和农田状态', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, {
    factories: [factory([{ index: 2, productId: '面包', name: '面包', finishTime: now + 65 }])],
    farms: [{ plot: '1农田', level: 2, productId: '小麦', productName: '小麦', state: 'growing', ripeTime: now + 65 }],
  }));
  productionButton(env).onclick();
  const timers = env.document.querySelectorAll('[data-production-finish-at]');
  assert.equal(timers.length, 2, '工厂主行和农田均展示倒计时');
  for (const timer of timers) assert.match(timer.textContent, /^（.*剩余 1分5秒）$/);
  env.now += 60000;
  env.updateTimers();
  for (const timer of timers) assert.match(timer.textContent, /^（.*剩余 5秒）$/);
  env.now += 6000;
  env.updateTimers();
  for (const timer of timers) assert.equal(timer.textContent, timer.dataset.productionReadyText);
  assert.match(env.tables[1].node.textContent, /已成熟/);
  assert.match(detailRow(productionButton(env)).textContent, /待收取/);
});

test('未同步队列和缺少成熟时间明确显示未知状态', () => {
  const env = fixture();
  env.render(worldData(env, {
    factories: [factory([], { queueKnown: false })],
    farms: [{ plot: '1农田', level: 1, productId: '小麦', productName: '小麦', state: 'growing', ripeTime: null }],
  }));
  assert.match(env.tables[0].node.textContent, /未同步/);
  assert.doesNotMatch(env.tables[0].node.textContent, /空闲/);
  assert.match(env.tables[1].node.textContent, /时间未同步/);
  assert.doesNotMatch(env.tables[1].node.textContent, /已成熟/);
  assert.equal(env.document.querySelectorAll('[data-production-finish-at]').length, 0);
});

test('农田施工使用建造倒计时，重新读取后清理旧倒计时', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { farms: [{ plot: '1农田', level: 0, state: 'building', finishTime: now + 10 }] }));
  assert.match(env.tables[0].node.textContent, /建造中.*10秒/);
  env.now += 11000;
  env.updateTimers();
  assert.match(env.tables[0].node.textContent, /待竣工/);
  env.render(worldData(env, { farms: [{ plot: '1农田', level: 1, state: 'idle', status: '空闲' }] }));
  assert.equal(env.document.querySelectorAll('[data-production-finish-at]').length, 0);
  assert.match(env.node('world-factories').textContent, /空闲/);
  assert.doesNotMatch(env.node('world-factories').textContent, /待竣工/);
});

console.log('海面生产界面测试 ' + passed + '/' + passed + ' 通过');
