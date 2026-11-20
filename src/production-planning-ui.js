let productionPlanOwner = null;
let productionPlanVersion = 0;
let productionPlanBusy = false;

bindConsoleSlice('productionPlan', { productionPlanOwner, productionPlanBusy }, state => {
  productionPlanOwner = state.productionPlanOwner;
  productionPlanBusy = state.productionPlanBusy;
});

function resetProductionPlan() {
  productionPlanVersion++;
  setConsoleValue('productionPlan', 'productionPlanOwner', null);
  setConsoleValue('productionPlan', 'productionPlanBusy', false);
  clear($('production-plan-result'));
  $('production-plan-status').textContent = '';
}

function productionPlanTime(value) {
  if (!Number.isFinite(value)) return '时间待定';
  return new Date(value * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function productionPlanDuration(value) {
  if (!Number.isFinite(value)) return '待确认';
  const seconds = Math.max(0, Math.ceil(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + seconds % 60 + '秒';
}

function productionPlanSummary(data) {
  const orders = data.orders || [];
  const note = text => el('p', 'production-plan-summary', text);
  if (orders.length && orders.every(order => order.skipped)) return note('本次需求均已跳过，请检查下方的工厂条件。');
  if (data.status === 'optimal' && Array.isArray(data.orders) && !orders.length) return note('当前没有需要备料的需求。');
  if (Number.isFinite(data.completionAt)) {
    const subject = ['feasible-orders', 'feasible-demands'].includes(data.scope) ? '参与排产的需求' : '全部需求';
    if (data.upperBound === 0) return note(subject + '现在即可备齐。');
    const summary = note('');
    summary.appendChild(el('span', null, subject + '预计备齐'));
    summary.appendChild(el('strong', null, productionPlanTime(data.completionAt)));
    if (Number.isFinite(data.upperBound)) summary.appendChild(el('span', 'dim', '约需 ' + productionPlanDuration(data.upperBound)));
    return summary;
  }
  if (data.missingReads?.length) return note('生产数据还不完整，暂时无法预计备齐时间。请稍后重新生成计划。');
  if (data.status === 'infeasible') return note('按当前条件，无法备齐所有需求。');
  return note('暂时无法预计全部需求的备齐时间。');
}

function planMaterialText(item) {
  return (item.name || item.id) + (Number.isSafeInteger(item.num) ? ' ×' + item.num : ' 数量待定');
}

function planMaterialNode(item, recipes, ancestors, group) {
  const recipe = recipes.get(item.id);
  const branch = recipe?.inputs?.length && recipe.output > 0 && !ancestors.includes(item.id);
  const label = el(branch ? 'summary' : 'span', 'plan-material-label');
  if (item.icon) label.appendChild(iconEl(item.icon, 20, item.name || item.id));
  label.appendChild(el('span', null, planMaterialText(item)));
  const row = el('li');
  if (!branch) {
    row.appendChild(label);
    return row;
  }
  const details = el('details');
  if (group) details.name = group;
  details.appendChild(label);
  details.ontoggle = () => {
    if (!details.open || details.children.length > 1) return;
    const batches = Math.ceil(item.num / recipe.output);
    const children = el('ul', 'plan-material-branches');
    for (const input of recipe.inputs) {
      children.appendChild(planMaterialNode({ ...input, num: input.num * batches }, recipes, [...ancestors, item.id]));
    }
    details.appendChild(children);
  };
  row.appendChild(details);
  return row;
}

function planMaterialList(items, recipes, group) {
  const tree = el('ul', 'plan-material-roots');
  for (const item of items) tree.appendChild(planMaterialNode(item, recipes, [], group));
  return tree;
}

function planDemandRow(order, index, recipes, snapshotTime) {
  const materials = el('div', 'plan-demand-materials');
  materials.appendChild(planMaterialList(order.requirements || [], recipes, 'production-plan-products-' + index));
  if (order.reason) materials.appendChild(el('p', 'plan-demand-reason', order.reason));
  let status;
  if (order.skipped) status = chip('waiting', '已跳过');
  else if (!Number.isFinite(order.completionAt) || order.reason) status = chip('unknown', '时间待定');
  else if (order.completionAt === snapshotTime) status = chip('ready', '现在可备齐');
  else status = el('span', 'plan-demand-eta', productionPlanTime(order.completionAt));
  return [el('strong', null, order.label || order.id), materials, status];
}

function renderProductionPlan(data) {
  const box = clear($('production-plan-result'));
  box.appendChild(productionPlanSummary(data));
  const timeline = data.timeline || [];
  const recipes = new Map((data.recipes || []).map(recipe => [recipe.productId, recipe]));
  for (const job of timeline) {
    if (!recipes.has(job.itemId) && job.inputs?.length && job.quantity > 0) {
      recipes.set(job.itemId, { output: job.quantity, inputs: job.inputs.map(input => ({
        id: input.itemId, name: input.name, num: input.quantity,
      })) });
    }
  }
  if (data.orders?.length) {
    const rows = data.orders.map((order, index) => planDemandRow(order, index, recipes, data.snapshotTime));
    box.appendChild(table(['需求来源', '所需物品', '预计备齐'], rows, 'plan-demand-table'));
  }
  for (const [title, jobs] of [
    ['建议生产顺序', timeline.filter(job => job.kind !== 'existing')],
    ['游戏内生产队列', timeline.filter(job => job.kind === 'existing')],
  ]) {
    if (!jobs.length) continue;
    const details = el('details');
    details.appendChild(el('summary', null, title + '（' + jobs.length + ' 批）'));
    details.appendChild(table(['生产设施', '生产物品', '开始时间', '预计完成'], jobs.map(job => [
      job.machineName || job.machineId,
      planMaterialList([{ id: job.itemId, name: job.productName, num: job.quantity }], recipes),
      productionPlanTime(job.startAt),
      productionPlanTime(job.finishAt),
    ])));
    box.appendChild(details);
  }
}

$('production-plan-refresh').onclick = async () => {
  const account = current;
  if (!account || !snapshot.connected || snapshot.paused || disconnected.has(account)) return;
  const version = ++productionPlanVersion;
  setConsoleValue('productionPlan', 'productionPlanOwner', account);
  setConsoleValue('productionPlan', 'productionPlanBusy', true);
  clear($('production-plan-result'));
  $('production-plan-refresh').disabled = true;
  $('production-plan-status').textContent = '正在生成计划…';
  try {
    const data = await call('/api/world/production-plan');
    if (version !== productionPlanVersion || account !== current || !snapshot.connected || disconnected.has(account) || snapshot.paused) return;
    renderProductionPlan(data);
    $('production-plan-status').textContent = Number.isFinite(data.snapshotTime)
      ? '数据更新于 ' + productionPlanTime(data.snapshotTime) + '（北京时间）' : '';
  } catch (error) {
    if (version !== productionPlanVersion || account !== current) return;
    $('production-plan-status').textContent = '生成失败，请重试';
    reportError(error);
  } finally {
    if (version === productionPlanVersion) {
      setConsoleValue('productionPlan', 'productionPlanBusy', false);
      $('production-plan-refresh').disabled = !snapshot.connected || snapshot.paused || disconnected.has(current);
    }
  }
};
