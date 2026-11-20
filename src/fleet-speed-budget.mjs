// 新账分项记账，同时沿用玩法总数核对升级前未分项的已扣及待确认钻石。
// 某项预算调低后，其已经花掉的钻石不占用其他项的独立额度。
export function fleetSpeedBudgetLimits(settings, module, counter, used) {
  const budgets = module === 'treasure'
    ? { treasureOutboundDiamonds: settings.treasure.dailyDiamondLimit, treasureReturnDiamonds: settings.treasure.returnDailyDiamondLimit }
    : Object.fromEntries(settings.silicon.fleets.flatMap(fleet => ['march', 'return'].map(mode =>
      [siliconSpeedCounter(fleet.id, mode), fleet[mode + 'DailyDiamonds']])));
  // 旧版已单列的维修花费已包含在 siliconDiamonds 中，不能再从行军额度扣一次。
  const retiredRepairSpend = module === 'silicon' ? settings.silicon.fleets.reduce((sum, fleet) =>
    sum + (used[siliconSpeedCounter(fleet.id, 'repair')] ?? 0), 0) : 0;
  const total = Object.entries(budgets).reduce((sum, [key, limit]) => sum + Math.max(limit, used[key] ?? 0), retiredRepairSpend);
  return { [counter]: budgets[counter], [module + 'Diamonds']: total, diamonds: settings.resources.diamondDailyLimit };
}

export function siliconSpeedCounter(id, mode) {
  return 'silicon' + mode[0].toUpperCase() + mode.slice(1) + 'Diamonds' + parseInt(id, 10);
}

export function speedBudgetAllows(limits, used, cost) {
  return Object.entries(limits).every(([key, limit]) => Number.isSafeInteger(limit) && limit >= cost &&
    Number.isSafeInteger(used[key] ?? 0) && (used[key] ?? 0) >= 0 && (used[key] ?? 0) + cost <= limit);
}
