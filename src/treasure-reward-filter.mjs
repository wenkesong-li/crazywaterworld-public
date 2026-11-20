// 此 ID 只供客户端展示；货轮实际发放的是各品质的补给材料。
const supplyDisplayId = '展示补给材料';
const rows = (config, name) => config?.tables?.[name]?.data ?? [];

function configuredRewardIds(config) {
  const libraries = new Set(rows(config, 'TreasureLootCfg').flatMap(row => row.rewardLib ?? []));
  return new Set(rows(config, 'TreasureLootRewardCfg')
    .filter(row => libraries.has(row.libId) && Array.isArray(row.reward) && typeof row.reward[0] === 'string' && row.reward[1] > 0)
    .map(row => row.reward[0]));
}

function supplyRewardIds(config, rewardIds = configuredRewardIds(config)) {
  const items = rows(config, 'ItemCfg');
  if (!items.some(row => row.id === supplyDisplayId)) return new Set();
  return new Set(items.filter(row => row.type === '补给材料' && row.id !== supplyDisplayId && rewardIds.has(row.id)).map(row => row.id));
}

// 达到门槛后，以第一个命中的勾选项排序。每项只计一次，与掉落数量无关。
export function treasureRewardPriority(config, selected, rewards, mode = 'any', minHits = 2) {
  if (!selected?.length) return 0;
  const ids = new Set((rewards ?? []).map(asset => asset.id));
  const required = mode === 'all' ? selected.length : mode === 'multiple' ? minHits : 1;
  let first = -1, hits = 0;
  for (const [index, id] of selected.entries()) {
    const matches = id === supplyDisplayId ? [...supplyRewardIds(config)].some(supply => ids.has(supply)) : ids.has(id);
    if (!matches) continue;
    if (first < 0) first = index;
    if (++hits >= required) return first;
  }
  return -1;
}

export function matchesTreasureRewards(config, selected, rewards, mode, minHits) {
  return treasureRewardPriority(config, selected, rewards, mode, minHits) >= 0;
}

export function treasureRewardMissReason(label, mode, minHits = 2) {
  if (mode === 'all') return `未命中全部${label}目标奖励`;
  if (mode === 'multiple') return `${label}目标奖励需至少命中 ${minHits} 项`;
  return `未命中任一${label}目标奖励`;
}

// 仅货轮使用此目录：先列实际奖励，完整材料和旧选择仍可搜索；其他模块不改名称或顺序。
export function treasureRewardOptions(config, materials) {
  const rewardIds = configuredRewardIds(config), supplies = supplyRewardIds(config, rewardIds);
  const priority = id => id === supplyDisplayId ? 0 : supplies.has(id) ? 1 : rewardIds.has(id) ? 2 : 3;
  return materials.map(option => option.value === supplyDisplayId ? { ...option, label: option.label + '（任意品质）' } : { ...option })
    .sort((a, b) => priority(a.value) - priority(b.value));
}
