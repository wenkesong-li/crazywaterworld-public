import { exactAutomationId } from './automation-policy.mjs';
import { merchantTiming, planMerchant } from './merchant-planner.mjs';

// worldCargo 只描述航程。停港者以及对方的货舱、资金和采购意图均不可见。
export function merchantCompetitorArrivals(state, actor, time, refreshAt) {
  const arrivals = [];
  const self = exactAutomationId(actor?.playerId), guild = exactAutomationId(actor?.guildId);
  if (!self || !guild || !Array.isArray(state.worldCargo)) return arrivals;
  const guildIdx = Number(BigInt(guild) % 1000n);
  if (!guildIdx) return arrivals;
  for (const other of state.worldCargo) {
    const id = exactAutomationId(other?.playerId), voyage = other?.cargo;
    if (!id || id === self || other.guildIdx !== guildIdx || voyage?.moveToCityId !== state.cargo.moveToCityId ||
      !Number.isSafeInteger(voyage.cityId) || voyage.cityId <= 0 || voyage.cityId === voyage.moveToCityId ||
      !Number.isSafeInteger(voyage.moveStartTime) || voyage.moveStartTime <= 0 || voyage.moveStartTime > time ||
      !Number.isSafeInteger(voyage.moveEndTime) || voyage.moveEndTime <= time || voyage.moveEndTime < refreshAt) continue;
    arrivals.push(voyage.moveEndTime);
  }
  return arrivals.sort((a, b) => a - b);
}

// 在相同本人资金、批次和设置下，用以往到访的库存重算到港卖旧货、再配新货的机会。
// 只统计新采购的潜在利润，旧货本来就能卖的利润不归到抢先到港。
function modelPurchase(config, event, state, radar, sample, arrival, settings, actionSeconds) {
  const cityId = state.cargo.moveToCityId;
  const docked = { period: event.period, cargo: { ...state.cargo, cityId, moveToCityId: 0, moveEndTime: 0 },
    player: { ...state.player } };
  const epoch = merchantTiming(config, event, arrival).marketEpoch;
  let time = arrival;
  for (;;) {
    const plan = planMerchant(config, event, docked, sample, radar, time, [], { settings, actionSeconds });
    if (plan.kind === 'buy') {
      const readyAt = time + actionSeconds * plan.purchases.length;
      const window = merchantTiming(config, event, readyAt);
      if (window.marketEpoch !== epoch) return { profit: null, readyAt };
      if (settings.speedUpMode === 'arrival' &&
        window.marketEpoch === merchantTiming(config, event, state.cargo.moveStartTime).marketEpoch &&
        window.nextRefreshAt + window.travelSeconds + (1 + plan.purchases.length) * actionSeconds >= window.tradeEndTime)
        return { profit: 0, readyAt };
      return { profit: plan.purchases.reduce((sum, row) => sum + row.gain, 0), readyAt };
    }
    if (plan.kind !== 'sell') return { profit: plan.mode === 'WAIT_REFRESH' ? null : 0, readyAt: time };
    const batch = docked.player.goods.find(row => row.pid === plan.pid);
    docked.player.goods = docked.player.goods.filter(row => row.pid !== plan.pid);
    docked.player.coins += batch.buyPrice * batch.num + plan.gain;
    docked.player.profit += Math.max(0, plan.gain);
    time += actionSeconds;
    if (merchantTiming(config, event, time).marketEpoch !== epoch) return { profit: null, readyAt: time };
    if (settings.profitLimit > 0 && docked.player.profit >= settings.profitLimit) return { profit: 0, readyAt: time };
  }
}

export function estimateMerchantRace(config, event, state, radar, time, settings, options, rival, actionSeconds) {
  const natural = state.cargo.moveEndTime, city = state.cargo.moveToCityId;
  const epoch = merchantTiming(config, event, natural).previousRefreshAt;
  const port = radar?.radar?.find(row => row?.cityId === city);
  if (!port || !epoch || !rival || rival < epoch || rival > natural)
    return () => null;
  const cycles = new Map();
  for (const market of options.marketHistory ?? []) {
    if (market?.cityId !== city || market.period !== event.period || market.startTime !== event.startTime ||
      !Number.isSafeInteger(market.observedAt) || market.observedAt < event.startTime || market.observedAt > time ||
      market.specGoodsId !== port.specGoodsId || (port.rareGoodsId && market.rareGoodsId !== port.rareGoodsId) ||
      !Array.isArray(market.goods) || market.goods.some(row => !row || !Number.isSafeInteger(row.goodsId) ||
        !Number.isSafeInteger(row.price) || row.price <= 0 || !Number.isSafeInteger(row.stock) || row.stock < 0)) continue;
    const start = merchantTiming(config, event, market.observedAt).previousRefreshAt;
    if (!start) continue;
    if (!cycles.has(start)) cycles.set(start, []);
    cycles.get(start).push({ ...market, offset: market.observedAt - start });
  }
  const histories = [...cycles].sort(([a], [b]) => b - a).map(([, rows]) => rows.sort((a, b) => a.offset - b.offset));
  return early => {
    // 提前跨到上一轮会触发实际到港交易。等刷新唤醒后重算，避免把下一轮库存计入上一轮。
    if (early < epoch || early + actionSeconds >= rival || early >= natural) return null;
    for (const rows of histories) {
      // 同一实际刷新周期内两次观测，落入抢先到港和自然到港之间的时间范围。
      const before = rows.find(row => row.offset >= early - epoch);
      const after = rows.findLast(row => row.offset <= natural - epoch);
      if (!before || !after || before.offset >= after.offset || before.visitStart !== after.visitStart) continue;
      // 同一批挂牌货比较早晚已购量。换价、缺项或库存倒退不能作为耗库证据。
      const old = new Map(before.goods.map(row => [row.goodsId, row]));
      if (old.size !== before.goods.length || old.size !== after.goods.length || new Set(after.goods.map(row => row.goodsId)).size !== old.size ||
        after.goods.some(row => !old.has(row.goodsId) ||
        old.get(row.goodsId).price !== row.price || old.get(row.goodsId).stock > row.stock)) continue;
      // 自己在这次停港采购的数量也进入联盟已购量，不能把它算作晚到的损失。
      const held = (sample, id) => (sample.held ?? []).reduce((sum, batch) =>
        sum + (batch.cityId === city && batch.goodsId === id ? batch.num : 0), 0);
      const laterGoods = after.goods.map(row => ({ ...row, stock: Math.max(old.get(row.goodsId).stock,
        row.stock - Math.max(0, held(after, row.goodsId) - held(before, row.goodsId))) }));
      if (!laterGoods.some(row => old.get(row.goodsId).stock < row.stock)) return null;
      const initial = modelPurchase(config, event, state, radar, { goods: before.goods }, early, settings, actionSeconds);
      if (!initial.profit || initial.readyAt >= rival) return null;
      const later = modelPurchase(config, event, state, radar, { goods: laterGoods }, natural, settings, actionSeconds);
      if (later.profit === null) return null;
      const gain = initial.profit - later.profit;
      return gain > 0 ? { gain, expiresAt: Math.min(epoch + before.offset, rival - (initial.readyAt - early) - 1) } : null;
    }
    return null;
  };
}
