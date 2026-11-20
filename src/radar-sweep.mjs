import { exactAutomationId } from './automation-policy.mjs';
import { radarEvents, radarKey } from './fleet-settlement.mjs';

const claimAllRequest = 'RadarGetAllRewardsRequest';
const levelUnlocked = player => Number.isSafeInteger(player?.level) && player.level >= 30;
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const active = (endTime, client) => Number.isSafeInteger(endTime) && (endTime === -1 || endTime > now(client));
const prefix = s => `radar-sweep:${s.world}:${s.guild}:`;

async function readEvents(client) {
  const reply = await client.request('RadarInfoRequest', {}, 'RadarInfoResponse');
  const events = radarEvents(reply?.radarInfo);
  if (!events) throw Error('联盟情报列表未完整返回');
  return events;
}

function sameRole(snapshot, player) {
  return snapshot.world === exactAutomationId(player.worldId) && snapshot.guild === exactAutomationId(player.guildId);
}

// 普通月卡自动完成新刷新的情报。游戏的一键按钮只领取整批奖励。
export async function readRadarSweep(client, protocol, player) {
  const s = { world: exactAutomationId(player?.worldId), guild: exactAutomationId(player?.guildId), events: [] };
  if (!s.world || !s.guild || !levelUnlocked(player)) return null;
  const type = protocol?.MonthCardType?.MONTH_CARD_NORMAL;
  if (!Number.isInteger(type) || !protocol.MonthCardRequest || !protocol.MonthCardResponse || !protocol[claimAllRequest]) return null;
  const cards = await client.request('MonthCardRequest', {}, 'MonthCardResponse');
  if (!sameRole(s, player)) throw Error('角色或联盟已变化');
  if (!Array.isArray(cards?.cardItem)) throw Error('普通月卡状态未同步');
  const matches = cards.cardItem.filter(card => card.type === type);
  if (!matches.length) return null;
  if (matches.length > 1 || !Number.isSafeInteger(matches[0].endTime)) throw Error('普通月卡有效期未确认');
  if (!active(matches[0].endTime, client)) return null;
  s.endTime = matches[0].endTime;
  s.events = await readEvents(client);
  if (!sameRole(s, player)) throw Error('角色或联盟已变化');
  return active(s.endTime, client) ? s : null;
}

// 用同一份事件快照核对整批领奖。切回逐条处理也要避开前次批量请求。
function radarSweepRecords(snapshot, records) {
  return Object.entries(records).filter(([key]) => key.startsWith(prefix(snapshot)));
}

export function previouslySwept(snapshot, records) {
  return new Set(radarSweepRecords(snapshot, records).flatMap(([, r]) => r.details.events));
}

export function settleRadarSweeps(snapshot, records, ledger) {
  const ready = new Set(snapshot.events.filter(e => e.state === 4).map(radarKey));
  let count = 0;
  for (const [key, record] of radarSweepRecords(snapshot, records)) {
    if (!record.confirmed && record.details.events.every(id => !ready.has(id))) {
      ledger.resolveKey(key, true);
      count += record.details.events.length;
    }
  }
  return count;
}

function planRadarSweep(snapshot, records) {
  const ready = snapshot.events.filter(e => e.state === 4).map(radarKey);
  const previous = previouslySwept(snapshot, records);
  if (!ready.length) return { actions: [], notes: ['等待普通月卡自动完成情报'], ready };
  if (ready.some(id => previous.has(id) || records['radar-claim:' + snapshot.world + ':' + id]))
    return { actions: [], notes: ['前次情报领奖仍在列表中，等待服务器更新'], ready };
  return { actions: [{ kind: 'radarSweep', label: '一键领取 ' + ready.length + ' 项联盟情报奖励', costs: [] }], notes: [], ready };
}

export async function previewRadarSweep(client, protocol, player, ledger, targetKey) {
  const snapshot = await readRadarSweep(client, protocol, player);
  if (!snapshot) return null;
  if (targetKey) {
    const event = snapshot.events.find(e => 'radar-' + (e.fixed ? e.eventId : e.uid) === targetKey);
    if (!event || event.state !== 4) return { actions: [], notes: [event ? '等待普通月卡自动完成此情报' : '目标情报已变化'] };
  }
  return planRadarSweep(snapshot, ledger.keyRecords());
}

export async function runRadarSweep(client, snapshot, player, { baseline, ledger, enabled, report }) {
  const emit = entry => report({ label: '普通月卡一键扫荡', ...entry });
  const count = settleRadarSweeps(snapshot, baseline, ledger);
  if (count) emit({ ok: true, label: '已确认前次一键领取 ' + count + ' 项联盟情报奖励' });
  const plan = planRadarSweep(snapshot, ledger.keyRecords());
  if (!plan.actions.length) return emit({ skipped: true, reason: plan.notes[0] });
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey: prefix(snapshot) + plan.ready[0],
    details: { kind: 'radarSweep', events: plan.ready } });
  try {
    await client.sendWatch(claimAllRequest, {}, { window: 600, beforeSend() {
      if (!enabled() || !sameRole(snapshot, player) || !levelUnlocked(player) || !active(snapshot.endTime, client))
        throw Error('挂机配置、角色或月卡状态已变化');
    } });
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === claimAllRequest)) {
      ledger.cancel(ticket);
      return emit({ ok: false, error: error.message });
    }
    return emit({ status: 'pending', reason: '批量领奖结果待核对：' + error.message });
  }
  try {
    const events = await readEvents(client);
    if (!sameRole(snapshot, player) || events.some(e => e.state === 4 && plan.ready.includes(radarKey(e))))
      return emit({ status: 'pending', reason: '已提交一键领取，等待服务器更新情报列表' });
    ledger.confirm(ticket);
    emit({ ok: true, label: '已一键领取 ' + plan.ready.length + ' 项联盟情报奖励' });
  } catch (error) {
    emit({ status: 'pending', reason: '批量领奖回读待确认：' + error.message });
  }
}
