import { fleetSpeedBudgetLimits, siliconSpeedCounter, speedBudgetAllows } from './fleet-speed-budget.mjs';
import { createHash } from 'node:crypto';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';
import { isMiningSilicon,  dispatchReservationReason, fleetRecordReason, reserveDispatch } from './fleet-availability.mjs';
import { registerFleetReservations, isFleetReserved } from './fleet-reservations.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { recordsInWorld } from './fleet-settlement.mjs';

// 硅矿奖励由服务器自动发放；ChipMineRewardRequest 只是读取共享周期次数。
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const day = time => Math.floor((time + 28800) / 86400);
const fleetNumber = id => /^([1-3])远征船$/.exec(id ?? '')?.[1];
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
const nameKey = value => String(value ?? '').trim().toLocaleLowerCase();
const identity = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), exactAutomationId(player?.guildId)].join(':');
const active = new WeakSet(), watchers = new WeakMap();
const stateKey = world => 'silicon-state:' + world;
const slotKey = (world, id) => 'silicon:' + world + ':' + fleetNumber(id);
const ownSlot = (snapshot, id) => snapshot.mines.filter(mine => !mine.reason).flatMap(mine => mine.positions.map(position => ({ mine, position }))).find(row => row.position.player?.fleetId === id);
const idle = fleet => fleet?.state === 1 && !fleet.curGridIdx && !fleet.targetGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs && !fleet.autoFight?.isOn;

function quantity(value) {
  if (integer(value)) return value;
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
const get = async (client, protocol, name, body = {}) => {
  if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw Error('当前协议缺少 ' + name);
  return client.request(name + 'Request', body, name + 'Response', 8000);
};
function openingReason(config, player, time) {
  const level = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界')?.playerLevel;
  if (!integer(level, 1) || !integer(player?.level, 1)) return '世界开放等级未确认';
  if (player.level < level) return `世界玩法在 ${level} 级开放`;
  const opened = gameplayOpenDay(config, player, '芯片'), age = worldOpenDays(player, time);
  if (!(opened > 0)) return '当前赛季尚未开放硅矿';
  if (!integer(age, 1) || age < opened) return '未达到当前赛季硅矿开放天数';
  if (!exactAutomationId(player?.worldId) || !exactAutomationId(player?.playerId)) return '角色或区服身份未确认';
  return '';
}
export { openingReason as siliconOpeningReason };
export function siliconInWindow(windows, time) {
  if (!windows?.length) return true;
  const minute = Math.floor(((time + 28800) % 86400) / 60);
  return windows.some(window => {
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
    if (!m) return false;
    const start = Number(m[1]) * 60 + Number(m[2]), end = Number(m[3]) * 60 + Number(m[4]);
    if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) return false;
    return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  });
}
const pursuitEnabled = fleet => !fleet.huntEnabled && fleet.pursuit && !fleet.emptyOnly && fleet.tiers.some(tier => tier !== 'BLUE');
export const siliconInterval = settings => settings?.silicon?.fleets?.some(fleet => fleet.enabled && (fleet.huntEnabled || pursuitEnabled(fleet))) ? 120000 : 600000;
export function watchSiliconMining(client) {
  if (watchers.has(client)) return watchers.get(client);
  const listeners = new Set();
  const watcher = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    wake() { for (const fn of listeners) { try { fn(); } catch {} } } };
  client.on?.('message', ({ name, body }) => {
    if (['SCChipMine', 'SCChipMineRewardInfo', 'SCMyFleetUpdate', 'SCMyFleetPower', 'SCNewCampaignReport', 'SCUpdateItem'].includes(name)) watcher.wake();
  });
  watchers.set(client, watcher); return watcher;
}

function rewardDay(snapshot, ledger) {
  const prior = ledger?.keyRecords?.()[stateKey(snapshot.worldId)]?.details ?? {};
  const today = day(snapshot.checkedAt), count = snapshot.reward.myRewardTimes;
  const sameCycle = prior.rewardResetTime === snapshot.reward.rewardResetTime;
  // 首次读到的是三日累计，没有可靠证据可减掉昨日次数。宁可少派，不虚构今日为零。
  const delta = sameCycle && integer(prior.rewardCount) && count >= prior.rewardCount ? count - prior.rewardCount : count;
  return { ...prior, day: today, dailyRewards: (prior.day === today ? prior.dailyRewards ?? 0 : 0) + delta,
    rewardCount: count, rewardResetTime: snapshot.reward.rewardResetTime, observedAt: snapshot.checkedAt,
    failures: prior.day === today ? prior.failures ?? {} : {}, defeated: prior.defeated ?? {}, reports: prior.reports ?? [] };
}
function persistState(ledger, world, state) {
  const key = stateKey(world);
  if (ledger.hasKey(key)) ledger.updateKeyDetails(key, state);
  else { const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: state }); ledger.confirm(ticket); }
}

export async function readSiliconMining(client, protocol, config, player, { settings, ledger } = {}) {
  const snapshot = { checkedAt: now(client), identity: identity(player), worldId: exactAutomationId(player?.worldId), playerId: exactAutomationId(player?.playerId), nickname: player?.nickname,
    guildIdx: Number(BigInt(exactAutomationId(player?.guildId) ?? '0') % 1000n), reason: '', notes: [], reward: null, dailyRewards: null,
    mines: [], fleets: [], buildings: [], fuel: null, petrolCost: null, pendingFuel: ledger ? pendingPetrol(ledger) : 0, repairs: {}, blacklist: [], fightTimes: 0, maxFightTimes: null };
  snapshot.reason = openingReason(config, player, snapshot.checkedAt);
  if (snapshot.reason) return snapshot;
  const p = settings?.silicon;
  if (!p) { snapshot.reason = '硅矿配置未同步'; return snapshot; }
  const who = identity(player);
  let list, reward, own, water, bag, merge;
  try {
    [list, reward, own, water, bag, merge] = await Promise.all(['ChipMineList', 'ChipMineReward', 'MyFleets', 'OnWater', 'AllItem', 'UniteWorldsPlan'].map(name => get(client, protocol, name)));
  } catch (error) { snapshot.reason = '硅矿状态读取失败：' + error.message; return snapshot; }
  if (who !== identity(player)) { snapshot.reason = '读取期间账号或联盟已变化'; return snapshot; }
  if (![list.chipMines, own.fleets, water.building, bag.items, merge.worldIds].every(Array.isArray)) { snapshot.reason = '矿区、舰队、库存或合服信息不完整'; return snapshot; }
  const r = reward.rewardInfo;
  if (!r || ![r.myRewardTimes, r.rewardResetTime, r.maxRewardTimes].every(n => integer(n)) || r.rewardResetTime <= snapshot.checkedAt) { snapshot.reason = '硅矿奖励周期或剩余次数未同步'; return snapshot; }
  snapshot.reward = { myRewardTimes: r.myRewardTimes, rewardResetTime: r.rewardResetTime, maxRewardTimes: r.maxRewardTimes };
  snapshot.dailyRewards = rewardDay(snapshot, ledger).dailyRewards;
  const fuels = bag.items.filter(item => item.itemId === '汽油');
  snapshot.fuel = fuels.length > 1 ? null : fuels.length ? quantity(fuels[0].num) : 0;
  snapshot.petrolCost = rows(config, 'WorldParamCfg').find(row => row.paramName === '采集硅矿消耗汽油')?.paramValue;
  if (!integer(snapshot.fuel) || !integer(snapshot.petrolCost, 1)) { snapshot.reason = '硅矿汽油余额或派遣消耗未确认'; return snapshot; }
  if (merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0 && (snapshot.checkedAt >= merge.executeTs - 3600 || day(snapshot.checkedAt) === day(merge.executeTs)))) snapshot.reason = '合服匹配或执行期间暂停硅矿派遣';
  snapshot.buildings = water.building;
  snapshot.fleets = own.fleets.map(fleet => ({ ...fleet, state: fleet.state, durability: fleet.durability, maxDura: fleet.maxDura,
    startGridIdx: fleet.startGridIdx, cityId: fleet.cityId, targetCityId: fleet.targetCityId,
    curGridIdx: fleet.curGridIdx ?? 0, targetGridIdx: fleet.targetGridIdx ?? 0, treasureLootUid: fleet.treasureLootUid ?? 0,
    power: quantity(fleet.power), ownerPlayerId: fleet.owner ? exactAutomationId(fleet.owner.playerId) : null }));
  if (new Set(snapshot.fleets.map(fleet => fleet.buildingId)).size !== snapshot.fleets.length) { snapshot.reason = '舰队编号重复'; return snapshot; }
  const colors = new Map(['BLUE', 'PURPLE', 'ORANGE'].flatMap(tier => rows(config, 'ChipMineCfg').filter(row => row.quality === tier && row.qualityIndex === protocol.Color?.[tier]).map(row => [row.qualityIndex, row])));
  if (new Set(list.chipMines.map(mine => mine.gridId)).size !== list.chipMines.length) { snapshot.reason = '矿区编号重复'; return snapshot; }
  // 同名响应没有 gridId，必须逐矿查询，不能并发造成目标错配。
  for (const mine of list.chipMines) {
    const type = colors.get(mine.color);
    if (!type || !integer(mine.gridId, 1)) continue;
    const item = { gridId: mine.gridId, tier: type.quality, color: mine.color, name: type.name, positions: [], reason: '' }; snapshot.mines.push(item);
    try {
      const detail = await get(client, protocol, 'ChipMine', { gridId: mine.gridId });
      if (!Array.isArray(detail.occupiedPositions) || !integer(detail.positionNum) || !integer(detail.occupiedNum) || !integer(detail.fightTimes) || !integer(detail.maxFightTimes)) throw Error('矿区位置和抢占次数未同步');
      if (!detail.rewardInfo || ![detail.rewardInfo.myRewardTimes, detail.rewardInfo.rewardResetTime, detail.rewardInfo.maxRewardTimes].every(n => integer(n)) || detail.rewardInfo.rewardResetTime !== snapshot.reward.rewardResetTime) throw Error('读取期间硅矿奖励周期发生变化');
      snapshot.reward.myRewardTimes = Math.max(snapshot.reward.myRewardTimes, detail.rewardInfo.myRewardTimes);
      snapshot.reward.maxRewardTimes = Math.min(snapshot.reward.maxRewardTimes, detail.rewardInfo.maxRewardTimes);
      item.positionNum = detail.positionNum; item.occupiedNum = detail.occupiedNum;
      item.positions = detail.occupiedPositions.map(position => ({ index: position.index, player: position.player ? {
        nickname: position.player.nickname, guildIdx: position.player.guildIdx, power: quantity(position.player.power),
        rewardTimes: position.player.rewardTimes, fleetId: position.player.fleetId ?? '' } : null }));
      if (item.positions.some(position => !integer(position.index) || (type.quality !== 'BLUE' && position.index >= item.positionNum) || position.player && (typeof position.player.nickname !== 'string' || !integer(position.player.guildIdx) || !integer(position.player.power) || !integer(position.player.rewardTimes))) || new Set(item.positions.map(position => position.index)).size !== item.positions.length) throw Error('矿位身份或索引不完整');
      snapshot.fightTimes = Math.max(snapshot.fightTimes, detail.fightTimes);
      snapshot.maxFightTimes = Math.min(snapshot.maxFightTimes ?? detail.maxFightTimes, detail.maxFightTimes);
    } catch (error) { item.reason = error.message; }
  }
  snapshot.dailyRewards = rewardDay(snapshot, ledger).dailyRewards;
  if (!snapshot.mines.length) snapshot.reason ||= '当前没有已确认的硅矿';
  for (const policy of p.fleets.filter(fleet => fleet.enabled && fleet.autoRepair)) {
    const fleet = snapshot.fleets.find(row => row.buildingId === policy.id);
    if (!idle(fleet) || !(fleet.durability < fleet.maxDura)) continue;
    try { snapshot.repairs[policy.id] = await get(client, protocol, 'FleetRepairParam', { buildingId: policy.id }); }
    catch { snapshot.notes.push(policy.id + '维修报价未同步'); }
  }
  if (p.fleets.some(fleet => fleet.enabled && pursuitEnabled(fleet))) {
    try { const black = await get(client, protocol, 'BlackList'); if (!Array.isArray(black.list)) throw Error(); snapshot.blacklist = black.list.filter(row => exactAutomationId(row.playerId) && row.nickname).map(row => ({ id: exactAutomationId(row.playerId), name: nameKey(row.nickname) })); }
    catch { snapshot.notes.push('游戏黑名单未同步，本轮不追击'); }
  }
  return snapshot;
}

const opponentKey = player => hash([nameKey(player.nickname), player.guildIdx]);
export function siliconPursuitActive(snapshot, policy, settings) {
  // rewardResetTime 是服务端三日周期，不把每15分钟产奖误当作三日重置。
  const start = snapshot.reward?.rewardResetTime - 3 * 86400;
  return pursuitEnabled(policy) && integer(settings.silicon.pursuitMinutes, 1)
    && snapshot.checkedAt >= start && snapshot.checkedAt < start + settings.silicon.pursuitMinutes * 60;
}
function capReason(snapshot, p) {
  if (snapshot.reward.myRewardTimes >= snapshot.reward.maxRewardTimes) return '已达服务器本周期硅矿奖励上限';
  if (p.dailyRewardLimit > 0 && snapshot.dailyRewards >= p.dailyRewardLimit) return '已达今日硅矿奖励上限';
  return '';
}
function fleetReadinessReason(snapshot, policy, fleet) {
  if (!fleet) return '舰队不存在';
  if (fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId) return '舰队归属不符';
  if (!integer(fleet.durability, 1) || !integer(fleet.maxDura, 1) || fleet.durability * 100 < fleet.maxDura * (policy.minDurabilityPercent ?? 1)) return '舰队耐久不足';
  if (!snapshot.buildings.some(building => building.buildingId === policy.id && building.level > 0 && building.fleet?.formation?.heroPositions?.some(hero => hero.heroId))) return '缺少已保存的舰队编队';
  return '';
}
function fleetReason(snapshot, policy, settings, ledger, client) {
  const fleet = snapshot.fleets.find(row => row.buildingId === policy.id);
  const ready = fleetReadinessReason(snapshot, policy, fleet);
  if (ready) return ready;
  const held = fleetRecordReason(ledger.keyRecords(), policy.id, snapshot.worldId) || dispatchReservationReason(client, settings, 'silicon', policy.id);
  return held || (!idle(fleet) ? '舰队在行军、维修、驻守或战斗' : '');
}
function huntReservationReason(snapshot, policy, own, settings, keys, client) {
  // 当前已核实的采矿占用可撤回，其余玩法/未知操作仍须避让。
  const otherKeys = Object.fromEntries(Object.entries(keys).filter(([key, record]) => !(key === slotKey(snapshot.worldId, policy.id)
    && record.confirmed && record.details?.gridId === own.mine.gridId && record.details.index === own.position.index)));
  return fleetRecordReason(otherKeys, policy.id, snapshot.worldId)
    || dispatchReservationReason(client, settings, 'silicon', policy.id, { ignoreLegacy: true })
    || (isFleetReserved(client, policy.id, ['silicon', 'dispatch-ledger']) ? '舰队有原自动任务尚未确认结束' : '');
}
function miningCandidates(snapshot, policy, settings, state, fleet, used, plannedAttacks, targetHeld, attacksOnly = false) {
  const pursuit = siliconPursuitActive(snapshot, policy, settings), candidates = [];
  for (const mine of snapshot.mines.filter(mine => policy.tiers.includes(mine.tier) && !mine.reason)) {
    if (!pursuit && !attacksOnly) {
      const count = mine.tier === 'BLUE' ? 3 : mine.positionNum;
      for (let index = 0; index < count; index++) if (!mine.positions.some(position => position.index === index && position.player) && !targetHeld(mine.gridId, index)) candidates.push({ mine, index, opponent: null });
    }
    if (policy.emptyOnly || mine.tier === 'BLUE' || (policy.dailyAttackLimit > 0 && (used['siliconAttacks' + fleetNumber(policy.id)] ?? 0) >= policy.dailyAttackLimit) || snapshot.fightTimes + plannedAttacks >= snapshot.maxFightTimes) continue;
    for (const position of mine.positions) {
      const target = position.player;
      if (!target || target.fleetId || target.guildIdx === snapshot.guildIdx || !nameKey(target.nickname) || !integer(fleet?.power, 1) || target.power > fleet.power * (policy.maxPowerRatio ?? 100) / 100) continue;
      if ((policy.safePlayers ?? []).some(name => nameKey(name) === nameKey(target.nickname)) || (policy.safeGuilds ?? []).map(String).includes(String(target.guildIdx))) continue;
      if (policy.failureLimit > 0 && (state.failures[policy.id + ':' + opponentKey(target)] ?? 0) >= policy.failureLimit) continue;
      if (policy.huntEnabled && !(policy.huntPlayers ?? []).some(name => nameKey(name) === nameKey(target.nickname))) continue;
      if (pursuit && (!state.defeated[opponentKey(target)] || snapshot.blacklist.filter(member => member.name === nameKey(target.nickname)).length !== 1)) continue;
      if (targetHeld(mine.gridId, position.index)) continue;
      candidates.push({ mine, index: position.index, opponent: target });
    }
  }
  candidates.sort((a, b) => (policy.huntEnabled ? -1 : 1) * (Number(Boolean(a.opponent)) - Number(Boolean(b.opponent))) || (a.opponent && b.opponent ? (policy.opponentOrder === 'powerAsc' ? 1 : -1) * (a.opponent.power - b.opponent.power) : 0) || a.mine.gridId - b.mine.gridId || a.index - b.index);
  return candidates;
}
export function planSiliconMining(snapshot, settings, ledger, client, heldForEvent = () => false) {
  const p = settings.silicon, result = { checkedAt: snapshot.checkedAt, dailyRewards: snapshot.dailyRewards, reward: snapshot.reward, actions: [], rows: [], notes: [...snapshot.notes], reason: snapshot.reason };
  if (!p.enabled) { result.reason = '硅矿总开关已关闭'; return result; }
  if (snapshot.reason || !snapshot.reward) return result;
  const state = rewardDay(snapshot, ledger), cap = capReason(snapshot, p), inWindow = siliconInWindow(p.windows, snapshot.checkedAt);
  const keys = ledger.keyRecords(), used = ledger.snapshot().counters;
  const returningHunts = Object.values(keys).filter(record => record.details?.kind === 'siliconRetreat' && record.details.worldId === snapshot.worldId && record.details.huntTarget);
  const intendedFuel = returningHunts.length * snapshot.petrolCost;
  // 撤回不消耗派遣费；仅在计划内为返航追杀保留意向，不能登记成实际消费。
  let availableFuel = snapshot.fuel - snapshot.pendingFuel - intendedFuel, plannedAttacks = returningHunts.length + [1, 2, 3].reduce((count, n) => count + (ledger.pendingCounters()['siliconAttacks' + n] ?? 0), 0);
  const targetHeld = (gridId, index) => result.actions.some(action => action.gridId === gridId && action.index === index || action.huntTarget?.gridId === gridId && action.huntTarget?.index === index)
    || Object.values(keys).some(record => record.details?.worldId === snapshot.worldId && record.details.active !== false &&
      (record.details.kind === 'siliconDispatch' && record.details.gridId === gridId && record.details.index === index || record.details.kind === 'siliconRetreat' && record.details.huntTarget?.gridId === gridId && record.details.huntTarget?.index === index));
  if (cap) result.notes.push(cap);
  for (const policy of p.fleets) {
    const own = ownSlot(snapshot, policy.id), fleet = snapshot.fleets.find(row => row.buildingId === policy.id), row = { id: policy.id, enabled: policy.enabled, reason: '', target: null }; result.rows.push(row);
    if (!policy.enabled) { row.reason = '舰队未启用'; continue; }
    if (heldForEvent(policy.id)) { row.reason = '已进入活动提前召回时段，暂停自动占矿'; continue; }
    const retreat = (reason, target = null) => {
      row.reason = reason;
      if (!own || !fleet || fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId || fleet.state !== 5 || fleet.curGridIdx !== own.mine.gridId) { row.reason += '；采矿舰队状态未确认'; return; }
      if (keys['silicon-retreat:' + snapshot.worldId + ':' + fleetNumber(policy.id)]) { row.reason += '；撤回结果待确认'; return; }
      if (!(own.position.player.rewardTimes > 0)) { row.reason += '；尚未完成首次15分钟采集，等待服务器允许撤回'; return; }
      const huntTarget = target ? { gridId: target.mine.gridId, index: target.index, opponent: target.opponent } : null;
      result.actions.push({ kind: 'siliconRetreat', request: 'ChipMineRetreatRequest', body: { fleetId: policy.id }, buildingId: policy.id,
        gridId: own.mine.gridId, beforeRewardTs: fleet.chipWar?.rewardTs ?? 0, huntTarget, retreatReason: reason,
        label: policy.id + '硅矿撤回（' + reason + '）', costs: [] });
      if (huntTarget) {
        row.target = { gridId: huntTarget.gridId, index: huntTarget.index, nickname: huntTarget.opponent.nickname };
        availableFuel -= snapshot.petrolCost; plannedAttacks++;
      }
    };
    if (cap || !inWindow) {
      row.reason = cap || '不在硅矿占领时段';
      if (own) retreat(row.reason);
      continue;
    }
    if (own) {
      row.reason = '已在' + own.mine.name + '采集';
      if (policy.huntEnabled && policy.huntRetreat === 'afterReward') retreat('采一次矿后撤回');
      else if (policy.huntEnabled && policy.huntRetreat === 'onTarget') {
        const readiness = fleetReadinessReason(snapshot, policy, fleet) || huntReservationReason(snapshot, policy, own, settings, keys, client);
        if (readiness) { row.reason += '；' + readiness; continue; }
        if (availableFuel < snapshot.petrolCost) { row.reason += '；追杀汽油不足，继续采集'; continue; }
        const target = miningCandidates(snapshot, policy, settings, state, fleet, used, plannedAttacks, targetHeld, true)[0];
        if (target) retreat('发现名单目标' + target.opponent.nickname + '，先撤回再核对攻打', target);
        else row.reason += '；未发现符合限制的追杀目标';
      }
      continue;
    }
    row.reason = fleetReason(snapshot, policy, settings, ledger, client);
    if (row.reason) continue;
    if (availableFuel < snapshot.petrolCost) { row.reason = '汽油不足'; continue; }
    const pursuit = siliconPursuitActive(snapshot, policy, settings), candidates = miningCandidates(snapshot, policy, settings, state, fleet, used, plannedAttacks, targetHeld);
    const target = candidates[0];
    if (!target) { row.reason = pursuit ? '追击时段：没有已击败且在游戏黑名单中的合规目标，保持待命' : policy.huntEnabled ? '没有符合限制的追杀名单目标或空位，保持待命' : '当前没有符合矿级、安全名单、战力及次数限制的位置'; continue; }
    const action = { kind: 'siliconDispatch', request: 'ChipMineSendFleetRequest', body: { gridId: target.mine.gridId, index: target.index, fleetId: policy.id },
      buildingId: policy.id, gridId: target.mine.gridId, index: target.index, color: target.mine.color, opponent: target.opponent, pursuit,
      cost: snapshot.petrolCost, costs: [{ id: '汽油', num: snapshot.petrolCost }], label: policy.id + (target.opponent ? policy.huntEnabled ? '追杀' + target.opponent.nickname + '，抢占' : '抢占' : '采集') + target.mine.name };
    result.actions.push(action); row.target = { gridId: action.gridId, index: action.index, nickname: action.opponent?.nickname ?? null }; row.reason = action.label;
    availableFuel -= action.cost; if (target.opponent) plannedAttacks++;
  }
  return result;
}

function installReservations(client, ledger, world) {
  registerFleetReservations(client, 'silicon', id => Object.entries(ledger.keyRecords()).some(([key, record]) => key.startsWith('silicon:' + world + ':') && record.details?.buildingId === id && record.details.active !== false), () => Object.entries(ledger.keyRecords()).some(([key, record]) => key.startsWith('silicon:' + world + ':') && record.details?.active !== false));
}
function homewardFromMine(fleet, gridId) {
  return fleet?.state === 2 && !fleet.treasureLootUid && integer(gridId, 1) &&
    fleet.startGridIdx === gridId && integer(fleet.targetGridIdx, 1) && fleet.targetGridIdx !== gridId &&
    fleet.cityId > 0 && fleet.targetCityId === fleet.cityId;
}

function mineReturn(fleet, details) {
  return homewardFromMine(fleet, details?.gridId) && fleet.moveStartTs >= details.sentAt &&
    (!details.returnStartTs || fleet.moveStartTs === details.returnStartTs);
}

function sameSiliconMove(fleet, step) {
  return fleet?.state === 2 && !fleet.treasureLootUid && fleet.moveStartTs === step.moveStartTs &&
    fleet.startGridIdx === step.startGridIdx && fleet.targetGridIdx === step.targetGridIdx &&
    (step.mode === 'return' ? homewardFromMine(fleet, step.gridId) && fleet.targetCityId === step.targetCityId : !fleet.targetCityId);
}

async function reconcile(client, protocol, snapshot, ledger) {
  if (snapshot.reason || !snapshot.reward) return;
  const state = rewardDay(snapshot, ledger), keys = ledger.keyRecords();
  for (const [key, record] of Object.entries(keys)) {
    const details = record.details;
    if (record.expired || !details || details.worldId !== snapshot.worldId || !key.startsWith('silicon')) continue;
    const fleet = snapshot.fleets.find(row => row.buildingId === details.buildingId), position = ownSlot(snapshot, details.buildingId);
    if (fleet?.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId) continue;
    if (['siliconDispatch','siliconRetreat'].includes(details.kind) && !snapshot.mines.some(mine => mine.gridId === details.gridId && !mine.reason)) continue;
    // 城战原生委任是偏好设置，已回城的活动召回舰队可结束旧采矿占用。
    const recall = keys['silicon-retreat:' + snapshot.worldId + ':' + fleetNumber(details.buildingId)]?.details;
    const recalledHome = recall?.recallSource && recall.gridId === details.gridId && !position && fleet?.state === 1 &&
      !fleet.curGridIdx && !fleet.targetGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs;
    const miningFinished = idle(fleet) || recalledHome;
    if (details.kind === 'siliconDispatch') {
      const occupied = position?.mine.gridId === details.gridId && (position.position.index === details.index || details.manualShortcut && details.color === protocol.Color.BLUE);
      const traveling = fleet?.state === 2 && !fleet.treasureLootUid && !fleet.targetCityId && fleet.targetGridIdx === details.gridId;
      if (!record.confirmed && (occupied || traveling)) ledger.resolveKey(key, true, { ...details, occupied: occupied || details.occupied, active: true, outboundStartTs: traveling ? fleet.moveStartTs : null });
      else if (occupied && !details.occupied) ledger.updateKeyDetails(key, { ...details, occupied: true, active: true });
      if (record.confirmed && !details.speedRouteClosed && fleet?.state === 2) {
        if (mineReturn(fleet, details)) {
          if (!details.returnStartTs) ledger.updateKeyDetails(key, { ...details, returnStartTs: fleet.moveStartTs });
        } else if (!traveling || details.returnStartTs || (details.outboundStartTs && details.outboundStartTs !== fleet.moveStartTs)) {
          ledger.updateKeyDetails(key, { ...details, speedRouteClosed: true });
        } else if (!details.outboundStartTs) {
          ledger.updateKeyDetails(key, { ...details, outboundStartTs: fleet.moveStartTs });
        }
      }
      if (record.confirmed && miningFinished) {
        if (details.opponent && !details.occupied) state.failures[details.buildingId + ':' + opponentKey(details.opponent)] = (state.failures[details.buildingId + ':' + opponentKey(details.opponent)] ?? 0) + 1;
        ledger.releaseCompletedKey(key);
      }
    } else if (details.kind === 'siliconRetreat' && !position && fleet && (miningFinished || fleet.state === 2 && fleet.targetGridIdx !== details.gridId)) {
      const returning = mineReturn(fleet, details);
      if (!record.confirmed || (returning && !details.returnStartTs)) {
        ledger.resolveKey(key, true, { ...details, returnStartTs: returning ? fleet.moveStartTs : details.returnStartTs });
      }
      // 回城航程和追杀意向保留到归队，供跨轮复核。
      if (miningFinished || (!returning && !details.huntTarget && !details.recallSource)) ledger.releaseCompletedKey(key);
    } else if (details.kind === 'siliconRepair' && fleet && (fleet.state === 4 && fleet.repairing?.startTs >= details.sentAt || fleet.durability > details.beforeDurability)) {
      if (!record.confirmed) ledger.resolveKey(key, true);
      if (idle(fleet)) ledger.releaseCompletedKey(key);
    } else if (details.kind === 'siliconSpeed' && fleet) {
      // 旧版已发送的维修加速仅凭服务端状态结算。
      const earlierRepair = fleet.state === 4 && fleet.repairing?.endTs < details.beforeEnd &&
        (!details.repairStartTs || fleet.repairing.startTs === details.repairStartTs);
      const repairedEarly = snapshot.checkedAt < details.beforeEnd && idle(fleet) && fleet.durability >= details.targetDurability;
      const earlierMove = fleet.moveEndTs < details.beforeEnd && fleet.moveEndTs >= details.moveStartTs &&
        (details.mode ? sameSiliconMove(fleet, details) : fleet.state === 2 && fleet.moveStartTs === details.moveStartTs);
      if (details.repair ? earlierRepair || repairedEarly : earlierMove) {
        ledger.resolveKey(key, true); ledger.releaseCompletedKey(key);
      } else if (idle(fleet)) {
        ledger.resolveKey(key, false);
      }
    }
  }
  // 用真实个人战报确认“曾击败”，不把空位占领或总战力较高推断成胜利。
  const targets = Object.entries(keys).filter(([key, record]) => key.startsWith('silicon:' + snapshot.worldId + ':') && record.details?.opponent && !record.details.won);
  if (targets.length) {
    try {
      const response = await get(client, protocol, 'CampaignReports', { pageNo: 0 });
      for (const report of response.reports ?? []) {
        const uid = exactAutomationId(report.uid), at = quantity(report.createTime);
        if (!uid || report.type !== 11 || report.mySide !== 0 || report.win !== true || !integer(at) || state.reports.includes(uid)) continue;
        const matching = targets.filter(([, record]) => record.details.buildingId === report.chipWar?.fleetId && record.details.color === report.chipWar?.color && at >= record.details.sentAt);
        if (matching.length !== 1) continue;
        const [key, record] = matching[0], detail = await get(client, protocol, 'CampaignReportDetail', { campaignId: automationWireId(uid) });
        if (!detail.battles?.some(battle => battle.win === true && nameKey(battle.rightCamp?.player?.nickname) === nameKey(record.details.opponent.nickname))) continue;
        state.defeated[opponentKey(record.details.opponent)] = { nickname: record.details.opponent.nickname, guildIdx: record.details.opponent.guildIdx, at };
        state.reports.push(uid); if (ledger.hasKey(key)) ledger.updateKeyDetails(key, { ...ledger.keyRecords()[key].details, won: true });
      }
    } catch { /* 战报失败不会把目标加入追击名单。 */ }
  }
  state.reports = state.reports.slice(-500); persistState(ledger, snapshot.worldId, state);
}

async function sendAndCheck(client, protocol, player, options, snapshot, step, counters = {}, limits = {}) {
  const { getSettings, ledger, enabled = () => true, report = () => {} } = options, settings = getSettings(), who = identity(player), today = day(snapshot.checkedAt);
  const baseKey = step.kind === 'siliconDispatch' ? slotKey(snapshot.worldId, step.buildingId) : step.kind === 'siliconRetreat' ? 'silicon-retreat:' + snapshot.worldId + ':' + fleetNumber(step.buildingId) : 'silicon-' + step.kind.slice(7).toLowerCase() + ':' + snapshot.worldId + ':' + fleetNumber(step.buildingId);
  const key = step.kind === 'siliconSpeed' ? baseKey + ':' + step.mode + ':' + step.moveStartTs : baseKey;
  if (ledger.hasKey(key)) return false;
  if (!protocol?.[step.request]) throw Error('当前协议缺少 ' + step.request);
  if (step.recallSource || ['siliconRepair','siliconSpeed'].includes(step.kind)) {
    const own = await get(client, protocol, 'MyFleets'), fleet = own.fleets?.find(row => row.buildingId === step.buildingId);
    if (!fleet || (fleet.owner && exactAutomationId(fleet.owner.playerId) !== snapshot.playerId)) return false;
    if (step.recallSource && (fleet.state !== 5 || fleet.curGridIdx !== step.gridId ||
        fleet.chipWar?.rewardTs !== step.beforeRewardTs || !options.recallCurrent?.(step.buildingId))) return false;
    if (step.kind === 'siliconRepair' && (!idle(fleet) || fleet.durability !== step.beforeDurability)) return false;
    if (step.kind === 'siliconSpeed' && (!sameSiliconMove(fleet, step) || fleet.moveEndTs !== step.beforeEnd)) return false;
  }
  const details = { kind: step.kind, worldId: snapshot.worldId, buildingId: step.buildingId, gridId: step.gridId ?? 0, index: step.index ?? 0,
    color: step.color ?? 0, opponent: step.opponent ?? null, huntTarget: step.huntTarget ?? null, sentAt: snapshot.checkedAt, active: true, occupied: false, manualShortcut: options.manualShortcut === true,
    ...(step.recallSource ? { recallSource: step.recallSource } : {}),
    ...(step.mode ? { mode: step.mode, startGridIdx: step.startGridIdx, targetGridIdx: step.targetGridIdx, targetCityId: step.targetCityId } : {}),
    beforeDurability: step.beforeDurability ?? 0, beforeEnd: step.beforeEnd ?? 0, moveStartTs: step.moveStartTs ?? 0 };
  if (step.kind === 'siliconSpeed') {
    if (settings !== options.plannedSettings || who !== snapshot.identity || speedReservationReason(client, settings, ledger, snapshot, step.buildingId)) return false;
    limits = fleetSpeedBudgetLimits(settings, 'silicon', siliconSpeedCounter(step.buildingId, step.mode), ledger.snapshot().counters);
  }
  let ticket;
  try { ticket = ledger.reserve(counters, limits, {}, { uniqueKey: key, details }); }
  catch (error) { report({ label: step.label, skipped: true, reason: error.message }); return false; }
  const allowed = () => {
    const policy = getSettings()?.silicon?.fleets?.find(fleet => fleet.id === step.buildingId);
    const manual = options.manualShortcut === true && ['siliconDispatch', 'siliconRetreat'].includes(step.kind);
    const eventRecall = step.kind === 'siliconRetreat' && !!step.recallSource && options.recallCurrent?.(step.buildingId);
    return enabled() && client.connected !== false && identity(player) === who && getSettings() === settings && day(now(client)) === today && (manual || eventRecall || settings.silicon.enabled && policy?.enabled && !step.recallSource)
      && (step.kind !== 'siliconDispatch' || manual || !options.heldForEvent?.(step.buildingId))
      && (step.kind !== 'siliconRepair' || policy.autoRepair && !options.heldForEvent?.(step.buildingId))
      && (step.kind !== 'siliconSpeed' || policy[step.mode + 'SpeedUp'] && settings.resources.allowDiamonds &&
        step.beforeEnd - now(client) > policy[step.mode + 'TargetSeconds']);
  };
  if (!allowed()) { ledger.cancel(ticket); return false; }
  try {
    await client.sendWatch(step.request, step.body, { window: 500 });
    const fresh = await readSiliconMining(client, protocol, options.config, player, { settings: getSettings(), ledger });
    if (who !== identity(player)) throw Error('写入后账号已切换，保留待确认记录');
    if (options.manualShortcut && !enabled()) throw Error('写入后连接已变化，保留待确认记录');
    await reconcile(client, protocol, fresh, ledger);
    const record = ledger.keyRecords()[key], confirmed = !record || record.confirmed;
    report({ label: step.label, ok: confirmed, status: confirmed ? 'confirmed' : 'unknown', reason: confirmed ? '服务器业务状态已确认' : '请求已发送，结果未确认；保留预算及舰队锁，不重复发送' });
    return confirmed;
  } catch (error) {
    const rejected = error.prompt && error.request === step.request;
    if (rejected || error.notSent && error.request === step.request) ledger.cancel(ticket);
    report({ label: step.label, ok: false, status: rejected ? 'rejected' : error.notSent && error.request === step.request ? 'cancelled' : 'unknown', error: error.message }); return false;
  }
}

function shortcutIntent(intent) {
  if (!intent || !['dispatch', 'retreat'].includes(intent.kind)) throw Error('仅支持空位采集或撤回自己的舰队');
  if (!integer(intent.gridId, 1)) throw Error('请选择明确的矿区');
  if (intent.kind === 'dispatch' && !integer(intent.index)) throw Error('请选择明确的空矿位');
  if (intent.kind === 'retreat' && !fleetNumber(intent.fleetId)) throw Error('请选择自己的采矿舰队');
  return { kind: intent.kind, gridId: intent.gridId, ...(intent.kind === 'dispatch' ? { index: intent.index } : { fleetId: intent.fleetId }) };
}

// 快捷操作只指定一次动作，不修改自动化开关、时段或目标策略；仍共用预算与舰队锁。
function planSiliconShortcut(snapshot, settings, ledger, client, intent, fleetId, recallSource) {
  if (snapshot.reason || !snapshot.reward) throw Error(snapshot.reason || '奖励信息未同步');
  const policy = settings.silicon?.fleets?.find(row => row.id === fleetId);
  if (!policy || !fleetNumber(fleetId)) throw Error('舰队配置未同步');
  const fleet = snapshot.fleets.find(row => row.buildingId === fleetId);
  const mine = snapshot.mines.find(row => row.gridId === intent.gridId);
  if (!mine || mine.reason) throw Error(mine?.reason || '矿区不存在或未同步');
  if (intent.kind === 'retreat') {
    const own = ownSlot(snapshot, fleetId);
    if (!own || own.mine.gridId !== intent.gridId || !fleet || fleet.state !== 5 || !fleet.chipWar
      || fleet.curGridIdx !== own.mine.gridId || fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId) throw Error('舰队已不在这个矿区采集，请刷新');
    if (!(own.position.player.rewardTimes > 0)) throw Error('尚未完成首次采集，首奖后才能撤回');
    const keys = Object.fromEntries(Object.entries(ledger.keyRecords()).filter(([key, record]) => !(key === slotKey(snapshot.worldId, fleetId)
      && record.confirmed && record.details.gridId === mine.gridId && (mine.tier === 'BLUE' || record.details.index === own.position.index))));
    const task = recallSource === 'treasure' && settings.treasure.follow ? 'follow' : recallSource || 'silicon';
    const held = fleetRecordReason(keys, fleetId, snapshot.worldId) || dispatchReservationReason(client, settings, task, fleetId, { ignoreLegacy: true, ignoreOwners: ['silicon'] })
      || (isFleetReserved(client, fleetId, ['silicon', 'dispatch-ledger']) ? '舰队有其他操作尚未结束' : '');
    if (held) throw Error(held);
    return { kind: 'siliconRetreat', request: 'ChipMineRetreatRequest', body: { fleetId }, buildingId: fleetId,
      gridId: mine.gridId, index: own.position.index, color: mine.color, beforeRewardTs: fleet.chipWar.rewardTs,
      cost: 0, costs: [], label: fleetId + '手动撤回' + mine.name };
  }
  const cap = capReason(snapshot, settings.silicon);
  if (cap) throw Error(cap);
  const blocked = fleetReason(snapshot, policy, settings, ledger, client);
  if (blocked) throw Error(blocked);
  const personal = mine.tier === 'BLUE', positions = mine.positions.filter(row => row.player);
  if (intent.index >= (personal ? 3 : mine.positionNum)) throw Error('矿位不存在');
  if (personal ? positions[intent.index] : positions.some(row => row.index === intent.index)) throw Error('矿位已被占领，请刷新后选择空位');
  if (!personal && (positions.length !== mine.occupiedNum || mine.occupiedNum > mine.positionNum)) throw Error('矿位数量未同步，请刷新');
  const records = Object.values(ledger.keyRecords()).filter(record => record.details?.worldId === snapshot.worldId && record.details.active !== false);
  if (records.some(record => record.details.kind === 'siliconDispatch' && record.details.gridId === mine.gridId && record.details.index === intent.index
    || record.details.kind === 'siliconRetreat' && record.details.huntTarget?.gridId === mine.gridId && record.details.huntTarget?.index === intent.index)) throw Error('该矿位已有派遣或返航追击任务');
  const intendedFuel = records.filter(record => record.details.kind === 'siliconRetreat' && record.details.huntTarget).length * snapshot.petrolCost;
  if (snapshot.fuel - pendingPetrol(ledger) - intendedFuel < snapshot.petrolCost) throw Error('汽油不足');
  return { kind: 'siliconDispatch', request: 'ChipMineSendFleetRequest', body: { gridId: mine.gridId, index: intent.index, fleetId },
    buildingId: fleetId, gridId: mine.gridId, index: intent.index, color: mine.color, opponent: null,
    cost: snapshot.petrolCost, costs: [{ id: '汽油', num: snapshot.petrolCost }], label: fleetId + '手动采集' + mine.name };
}

export async function previewSiliconShortcut(client, protocol, config, player, rawIntent, options) {
  const intent = shortcutIntent(rawIntent), { getSettings, ledger, enabled = () => true } = options;
  const settings = getSettings(), who = identity(player);
  if (!enabled() || active.has(client)) throw Error('硅矿任务正在处理或连接已变化，请稍后再试');
  const snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
  if (!enabled() || who !== identity(player) || settings !== getSettings()) throw Error('账号或配置已变化，请重新选择');
  // 同步已完成操作的账本证据，自动化关闭后也能继续手动操作；不发送游戏写入。
  await reconcile(client, protocol, snapshot, ledger);
  if (!enabled()) throw Error('账号连接已变化，请重新选择');
  const ids = intent.kind === 'retreat' ? [intent.fleetId] : snapshot.fleets.map(fleet => fleet.buildingId).filter(fleetNumber);
  const fleets = ids.map(id => {
    const fleet = snapshot.fleets.find(row => row.buildingId === id);
    let step = null, reason = '';
    try { step = planSiliconShortcut(snapshot, settings, ledger, client, intent, id); } catch (error) { reason = error.message; }
    return { id, name: id.replace('远征船', '号舰队'), power: fleet?.power ?? null,
      durability: fleet?.durability ?? null, maxDura: fleet?.maxDura ?? null, reason, step };
  });
  const mine = snapshot.mines.find(row => row.gridId === intent.gridId);
  return { intent, checkedAt: snapshot.checkedAt, worldId: snapshot.worldId, mineName: mine?.name || '硅矿',
    fuel: snapshot.fuel, cost: intent.kind === 'retreat' ? 0 : snapshot.petrolCost, fleets,
    reason: snapshot.reason || (!fleets.length ? '没有已同步的远征舰队' : ''),
    automatic: !!settings.silicon.enabled };
}

export async function runSiliconShortcut(client, protocol, config, player, preview, fleetId, options) {
  const intent = shortcutIntent(preview?.intent), { getSettings, ledger, enabled = () => true } = options;
  const proposed = preview.fleets?.find(row => row.id === fleetId && row.step)?.step;
  if (!proposed) throw Error('这支舰队未通过本次确认，请重新选择');
  if (!enabled() || active.has(client)) throw Error('硅矿任务正在处理或连接已变化，请重新选择');
  const settings = getSettings(), who = identity(player);
  if (preview.worldId !== exactAutomationId(player.worldId)) throw Error('所在区服已变化，请重新选择');
  active.add(client); installReservations(client, ledger, preview.worldId);
  try {
    const snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
    if (!enabled() || who !== identity(player) || settings !== getSettings()) throw Error('账号或配置已变化，操作未发送');
    await reconcile(client, protocol, snapshot, ledger);
    const step = planSiliconShortcut(snapshot, settings, ledger, client, intent, fleetId);
    if (step.cost > preview.cost || step.color !== proposed.color) throw Error('矿区费用或品质已变化，请重新确认');
    if (intent.kind === 'retreat' && (step.index !== proposed.index || step.beforeRewardTs !== proposed.beforeRewardTs)) throw Error('采矿进度已变化，请重新确认撤回');
    if (!enabled() || who !== identity(player) || settings !== getSettings()) throw Error('账号或配置已变化，操作未发送');
    reserveDispatch(client, 'silicon', [fleetId]);
    let result;
    await sendAndCheck(client, protocol, player, { ...options, config, manualShortcut: true, report: entry => { result = entry; options.report?.(entry); } }, snapshot, step,
      intent.kind === 'dispatch' ? { siliconPetrol: step.cost, siliconDispatches: 1 } : {},
      {});
    return { ...(result || { ok: false, status: 'skipped', reason: '状态已变化，操作未发送，请重新读取' }), cost: step.cost, kind: intent.kind, fleetId };
  } finally { reserveDispatch(client, 'silicon', []); active.delete(client); }
}

export function siliconRecallOpensAt(policy, start) {
  return policy?.enabled && policy.recallSilicon && policy.fleetIds?.length &&
    integer(policy.recallLeadMinutes, 1) && integer(start, 1) ? start - policy.recallLeadMinutes * 60 : null;
}

function eventRecallStep(snapshot, settings, ledger, client, own, id, source) {
  const step = planSiliconShortcut(snapshot, settings, ledger, client, { kind: 'retreat', gridId: own.mine.gridId, fleetId: id }, id, source);
  return { ...step, recallSource: source, label: id + (source === 'cityWar' ? '城战开战' : '货轮刷新') + '前从' + own.mine.name + '召回' };
}

export async function previewSiliconEventRecall(client, protocol, config, player, settings, ledger, source, start, fleets) {
  const result = { actions: [], notes: [] }, p = settings[source], from = siliconRecallOpensAt(p, start);
  if (from === null || now(client) >= start) return result;
  if (now(client) < from) {
    result.notes.push('将在活动开始前 ' + p.recallLeadMinutes + ' 分钟检查所选舰队的硅矿占用');
    return result;
  }
  const ids = p.fleetIds.filter(id => fleets.some(f => f.buildingId === id && isMiningSilicon(f)));
  if (!ids.length) return result;
  const snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
  if (snapshot.reason) result.notes.push(snapshot.reason);
  else if (now(client) < start) for (const id of ids) {
    const own = ownSlot(snapshot, id);
    if (!own) continue;
    try { result.actions.push(eventRecallStep(snapshot, settings, ledger, client, own, id, source)); }
    catch (error) { result.notes.push(id + '提前召回：' + error.message); }
  }
  return result;
}

// 活动开关授权撤回已在矿位的本人舰队，包括手动派出的采矿舰队。
export async function recallSiliconForEvent(client, protocol, config, player, options) {
  const { source, fleetIds, getSettings, ledger, enabled, recallCurrent, verifyStart, report } = options;
  if (!ledger || !fleetIds.length || !enabled() || active.has(client)) return;
  const settings = getSettings(), who = identity(player);
  let nextRewardAt = Infinity;
  const current = id => enabled() && client.connected !== false && settings === getSettings() &&
    identity(player) === who && recallCurrent(id);
  active.add(client);
  try {
    for (const id of fleetIds) {
      if (!current(id)) continue;
      const snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
      if (snapshot.reason || !current(id)) continue;
      await reconcile(client, protocol, snapshot, ledger);
      const own = ownSlot(snapshot, id);
      if (!own || !current(id)) continue;
      if (own.position.player.rewardTimes === 0) {
        const rewardAt = snapshot.fleets.find(f => f.buildingId === id)?.chipWar?.rewardTs;
        if (Number.isSafeInteger(rewardAt) && rewardAt > snapshot.checkedAt) nextRewardAt = Math.min(nextRewardAt, rewardAt);
      }
      let step;
      try { step = eventRecallStep(snapshot, settings, ledger, client, own, id, source); }
      catch (error) { report({ label: id + '提前召回', skipped: true, reason: error.message }); continue; }
      // 矿位读取期间活动可能改期。只有同一场次仍处于提前窗口才发送。
      if (!await verifyStart() || !current(id)) continue;
      await sendAndCheck(client, protocol, player, { ...options, config, recallCurrent: current }, snapshot, step);
    }
    return nextRewardAt;
  } finally { active.delete(client); }
}

// 采矿自动化关闭时也要结算活动召回的返航，释放该次采矿和撤回记录。
export async function settleSiliconEventRecalls(client, protocol, config, player, settings, ledger, enabled) {
  if (!ledger || active.has(client) || !enabled()) return;
  const world = exactAutomationId(player?.worldId), who = identity(player);
  if (!Object.values(ledger.keyRecords()).some(r => !r.expired && r.details?.worldId === world &&
      r.details.kind === 'siliconRetreat' && r.details.recallSource)) return;
  active.add(client);
  try {
    const snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
    if (enabled() && who === identity(player)) await reconcile(client, protocol, snapshot, ledger);
  } finally { active.delete(client); }
}

function speedReservationReason(client, settings, ledger, snapshot, id) {
  const records = Object.fromEntries(Object.entries(recordsInWorld(ledger.keyRecords(), snapshot.worldId))
    .filter(([, r]) => !(r.confirmed && ['siliconDispatch', 'siliconRepair', 'siliconRetreat'].includes(r.details?.kind))));
  return fleetRecordReason(records, id, snapshot.worldId) ||
    dispatchReservationReason(client, settings, 'silicon', id, { ignoreLegacy: true }) ||
    isFleetReserved(client, id, ['silicon', 'dispatch-ledger']);
}

function siliconSpeedMode(snapshot, fleet, records) {
  const suffix = snapshot.worldId + ':' + fleetNumber(fleet.buildingId);
  const confirmed = key => {
    const record = records[key];
    return record?.confirmed && !record.expired && record.details?.active && !record.details.speedRouteClosed ? record.details : null;
  };
  if (fleet.state !== 2 || fleet.treasureLootUid || !integer(fleet.moveStartTs, 1)) return null;
  const dispatch = confirmed('silicon:' + suffix), retreat = confirmed('silicon-retreat:' + suffix);
  if (mineReturn(fleet, retreat) || mineReturn(fleet, dispatch)) return 'return';
  if (dispatch && !fleet.targetCityId && dispatch.gridId === fleet.targetGridIdx && !dispatch.returnStartTs &&
      fleet.moveStartTs >= dispatch.sentAt && (!dispatch.outboundStartTs || fleet.moveStartTs === dispatch.outboundStartTs)) return 'march';
  return null;
}

export async function planSiliconMaintenance(client, protocol, config, settings, ledger, snapshot, heldForEvent = () => false) {
  const p = settings.silicon;
  if (!p.enabled || snapshot.reason || !snapshot.reward) return null;
  const gathering = !capReason(snapshot, p) && siliconInWindow(p.windows, snapshot.checkedAt);
  const records = ledger.keyRecords(), used = ledger.snapshot().counters;
  for (const policy of p.fleets.filter(fleet => fleet.enabled)) {
    const fleet = snapshot.fleets.find(row => row.buildingId === policy.id);
    if (!fleet || !integer(fleet.durability) || !integer(fleet.maxDura, 1) ||
        (fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId)) continue;
    if (gathering && !heldForEvent(policy.id) && policy.autoRepair && idle(fleet) && fleet.durability < fleet.maxDura && !fleetRecordReason(records, policy.id, snapshot.worldId) && !dispatchReservationReason(client, settings, 'silicon', policy.id)) {
      const quote = snapshot.repairs[policy.id];
      if (!(quote?.unitRepairCost > 0 && quote.unitRepairTime > 0)) continue;
      const cost = Math.ceil((fleet.maxDura - fleet.durability) * quote.unitRepairCost);
      if (!integer(cost, 1) || snapshot.fuel - pendingPetrol(ledger) < cost) continue;
      return { kind: 'siliconRepair', request: 'RepairFleetRequest', body: { buildingId: policy.id }, buildingId: policy.id,
        beforeDurability: fleet.durability, cost, costs: [{ id: '汽油', num: cost }], label: policy.id + '硅矿普通维修' };
    }
    const mode = siliconSpeedMode(snapshot, fleet, records);
    if (!mode || (mode !== 'return' && heldForEvent(policy.id)) || !policy[mode + 'SpeedUp'] || (!gathering && mode !== 'return') || !settings.resources?.allowDiamonds ||
        speedReservationReason(client, settings, ledger, snapshot, policy.id)) continue;
    const beforeEnd = fleet.moveEndTs;
    const remaining = beforeEnd - snapshot.checkedAt, threshold = policy[mode + 'TargetSeconds'];
    if (!integer(beforeEnd, 1) || !integer(threshold) || remaining <= threshold) continue;
    const cost = rows(config, 'WorldParamCfg').find(row => row.paramName === '行军加速消耗')?.paramValue;
    const counter = siliconSpeedCounter(policy.id, mode), limits = fleetSpeedBudgetLimits(settings, 'silicon', counter, used);
    if (!integer(cost, 1) || !speedBudgetAllows(limits, used, cost)) continue;
    const resources = await get(client, protocol, 'AllResource'), ruby = resources.list?.filter(row => row.res === 4);
    if (ruby?.length !== 1 || !integer(quantity(ruby[0].amount)) ||
        quantity(ruby[0].amount) - (ledger.pendingCounters().diamonds ?? 0) - cost < settings.resources.diamondThreshold) continue;
    const name = mode === 'return' ? '回城' : '去程';
    return { kind: 'siliconSpeed', request: 'SpeedUpFleetRequest',
      body: { buildingId: policy.id },
      buildingId: policy.id, mode, cost, costs: [{ id: 'RUBY', num: cost }], beforeEnd,
      gridId: mode === 'return' ? fleet.startGridIdx : fleet.targetGridIdx, startGridIdx: fleet.startGridIdx, targetGridIdx: fleet.targetGridIdx,
      targetCityId: fleet.targetCityId, moveStartTs: fleet.moveStartTs,
      label: policy.id + '硅矿' + name + '加速（剩余 ' + remaining + ' 秒，目标 ' + threshold + ' 秒），消耗 ' + cost + ' 钻石' };
  }
  return null;
}

export async function runSiliconMining(client, protocol, config, player, options = {}) {
  const { getSettings, ledger, enabled = () => true, report = () => {} } = options;
  if (!enabled() || !getSettings?.()?.silicon?.enabled || active.has(client)) return null;
  if (!ledger) throw Error('硅矿自动化缺少持久化账本');
  const who = identity(player); active.add(client); watchSiliconMining(client); installReservations(client, ledger, exactAutomationId(player.worldId));
  try {
    let settings = getSettings(), snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
    if (who !== identity(player) || !enabled()) return null;
    await reconcile(client, protocol, snapshot, ledger);
    if (snapshot.reason) { report({ label: '硅矿自动采集', skipped: true, reason: snapshot.reason }); return snapshot; }
    const initialFuel = snapshot.fuel, sentPetrol = new Map();
    // 业务确认可能早于库存扣减回写；本轮已确认费用继续压低余额上界，未知费用只由 pending 扣一次。
    const constrainFuel = fresh => {
      const keys = ledger.keyRecords();
      const confirmedSpend = [...sentPetrol].reduce((total, [key, cost]) => total + (keys[key]?.confirmed === false ? 0 : cost), 0);
      fresh.fuel = Math.min(fresh.fuel, initialFuel - confirmedSpend);
      fresh.pendingFuel = pendingPetrol(ledger);
    };
    constrainFuel(snapshot);
    const plan = planSiliconMining(snapshot, settings, ledger, client, options.heldForEvent);
    for (const proposed of plan.actions) {
      if (!enabled() || who !== identity(player) || client.connected === false) break;
      settings = getSettings(); reserveDispatch(client, 'silicon', [proposed.buildingId]);
      try {
        const fresh = await readSiliconMining(client, protocol, config, player, { settings, ledger });
        if (!enabled() || settings !== getSettings() || who !== identity(player) || day(fresh.checkedAt) !== day(now(client))) continue;
        await reconcile(client, protocol, fresh, ledger);
        constrainFuel(fresh);
        const reviewed = planSiliconMining(fresh, settings, ledger, client, options.heldForEvent).actions.find(action => action.kind === proposed.kind && action.buildingId === proposed.buildingId && action.gridId === proposed.gridId && action.index === proposed.index && hash(action.opponent) === hash(proposed.opponent) && hash(action.huntTarget) === hash(proposed.huntTarget));
        if (!reviewed) continue;
        const counters = reviewed.kind === 'siliconDispatch' ? { siliconPetrol: reviewed.cost, siliconDispatches: 1, ...(reviewed.opponent ? { ['siliconAttacks' + fleetNumber(reviewed.buildingId)]: 1 } : {}) } : {};
        const policy = settings.silicon.fleets.find(fleet => fleet.id === reviewed.buildingId), limits = { ...(reviewed.opponent && policy.dailyAttackLimit > 0 ? { ['siliconAttacks' + fleetNumber(reviewed.buildingId)]: policy.dailyAttackLimit } : {}) };
        const confirmed = await sendAndCheck(client, protocol, player, { ...options, config, enabled, report }, fresh, reviewed, counters, limits);
        if (reviewed.kind === 'siliconDispatch') {
          const key = slotKey(fresh.worldId, reviewed.buildingId);
          if (confirmed || ledger.hasKey(key)) sentPetrol.set(key, reviewed.cost);
        }
      } finally { reserveDispatch(client, 'silicon', []); }
    }
    if (enabled() && who === identity(player)) {
      settings = getSettings(); snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
      if (enabled() && settings === getSettings() && who === identity(player)) {
        await reconcile(client, protocol, snapshot, ledger);
        constrainFuel(snapshot);
        const step = await planSiliconMaintenance(client, protocol, config, settings, ledger, snapshot, options.heldForEvent);
        if (step && enabled() && settings === getSettings() && who === identity(player)) {
          const counters = step.kind === 'siliconRepair' ? { siliconPetrol: step.cost } :
            { diamonds: step.cost, siliconDiamonds: step.cost, [siliconSpeedCounter(step.buildingId, step.mode)]: step.cost };
          await sendAndCheck(client, protocol, player, { ...options, enabled, report, config, plannedSettings: settings }, snapshot, step, counters);
          plan.actions.push(step);
        }
      }
    }
    if (!plan.actions.length) report({ label: '硅矿自动采集', skipped: true, reason: plan.reason || plan.notes.join('；') || plan.rows.filter(row => row.enabled).map(row => row.id + '：' + row.reason).join('；') || '未启用舰队' });
    return plan;
  } finally { reserveDispatch(client, 'silicon', []); active.delete(client); }
}
