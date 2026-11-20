import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { filterOpponentsByPower } from './opponent-power.mjs';

const busy = new WeakSet();
const attempted = new WeakMap();
const skipped = reason => ({ skipped: true, reason });

function evaluateArena({ task, probe, dailyResetTime, client, now, settings }) {
  if (!task) return { status: 'waiting', reason: '尚未取得今日竞技场任务' };
  const limit = settings?.arena?.dailyBattleLimit ?? task.targetProgress;
  if (task.progress >= limit) return { status: 'done', reason: '已达到竞技场每日战斗次数（' + limit + ' 次）' };
  const info = probe('ArenaInfoRequest');
  if (!Number.isSafeInteger(info?.dailyChallengeTimes) || info.dailyChallengeTimes < 0) return { status: 'waiting', reason: '尚未取得竞技场今日挑战次数' };
  if (info.dailyChallengeTimes >= limit) return { status: 'done', reason: '已达到竞技场每日战斗次数（' + limit + ' 次）' };
  const tickets = probe('AllResourceRequest')?.list?.find(row => row.res === 5);
  if (!tickets || !Number.isSafeInteger(toNumber(tickets.amount)) || toNumber(tickets.amount) < 1) {
    return { status: 'waiting', reason: '挑战券不足或未能确认余额' };
  }
  const self = info?.myself;
  const selfId = uidText(self?.id);
  if (!selfId || !Number.isSafeInteger(self.rankNo) || self.rankNo < 1 || !Array.isArray(info.challenges)) {
    return { status: 'waiting', reason: '尚未取得竞技场排名或对手名单' };
  }
  // ArenaModel builds the visible list from top3, challenges and (when missing)
  // myself. ArenaChallengeItem enables entries 4+ outside the top ten; rows
  // ranked below the player are sweep targets with a different protocol.
  const ranks = new Map();
  const contested = new Set();
  for (const row of [...(info.top3 ?? []), ...info.challenges, self]) {
    if (ranks.has(row.rankNo) && uidText(ranks.get(row.rankNo).id) !== uidText(row.id)) contested.add(row.rankNo);
    ranks.set(row.rankNo, row);
  }
  const roster = [...ranks.values()];
  roster.sort((a, b) => a.rankNo - b.rankNo);
  const targets = roster.filter((row, i) => !contested.has(row.rankNo)
    && (self.rankNo <= 10 || (i >= 3 && row.rankNo > 3 && info.challenges.includes(row)))
    && Number.isSafeInteger(row.rankNo) && row.rankNo > 0 && row.rankNo < self.rankNo
    && uidText(row.id) && uidText(row.id) !== selfId && Number.isFinite(toNumber(row.power)));
  if (!targets.length) return { status: 'waiting', reason: '没有排名在自己之前的可挑战对手，排名靠后的对手属于扫荡' };
  const filtered = filterOpponentsByPower(targets, self.power, settings?.arena?.maxPowerRatio);
  if (filtered.reason) return { status: 'waiting', reason: filtered.reason };
  const target = filtered.candidates.sort((a, b) => settings?.arena?.target === 'rank'
    ? a.rankNo - b.rankNo : toNumber(a.power) - toNumber(b.power) || b.rankNo - a.rankNo)[0];
  const reset = dailyResetTime || Math.floor((now + 28800) / 86400);
  const snapshot = JSON.stringify([reset, task.progress, info.dailyChallengeTimes, selfId, self.rankNo,
    roster.map(row => [row.rankNo, uidText(row.id)])]);
  const previous = client && attempted.get(client);
  if (previous?.reset === reset && info.dailyChallengeTimes < previous.confirmedTimes) {
    return { status: 'waiting', reason: '已收到战报，等待竞技场挑战次数更新' };
  }
  if (previous?.reset === reset && previous.snapshots.has(snapshot)) {
    return { status: 'waiting', reason: '已尝试过本轮名单，等待对手名单或挑战次数更新' };
  }
  return { status: 'ready', actions: [{ request: 'ArenaChallengeRequest', response: 'ArenaChallengeResponse',
    body: { rank: target.rankNo, challengeId: uidText(target.id) }, arenaSnapshot: snapshot, arenaReset: reset,
    cost: '挑战券 ×1', note: '挑战第 ' + target.rankNo + ' 名对手（战力 ' + toNumber(target.power) + '）' + filtered.note }] };
}

export async function readArena(client, getSettings, timeout) {
  const request = name => client.request(name + 'Request', {}, name + 'Response', timeout);
  const daily = await request('DailyTaskInfo');
  const task = daily.dailyTask?.find(row => row.id === 1005);
  const info = await request('ArenaInfo');
  const resources = await request('AllResource');
  const plan = evaluateArena({ task, client, settings: getSettings(), dailyResetTime: daily.dailyResetTime,
    now: (Date.now() + (client.serverClockOffsetMs || 0)) / 1000,
    probe: name => name === 'ArenaInfoRequest' ? info : resources });
  const tickets = toNumber(resources.list?.find(row => row.res === 5)?.amount);
  return { plan, info, task, tickets: Number.isSafeInteger(tickets) ? tickets : null };
}

async function runArena({ client, protocol, action, timeout, allowAction, getSettings = () => null, performWrite = write => write() }) {
  if (busy.has(client)) return skipped('正在核对上一场竞技场挑战');
  busy.add(client);
  try {
    const request = name => client.request(name + 'Request', {}, name + 'Response', timeout);
    const { info, plan: fresh } = await readArena(client, getSettings, timeout);
    const current = fresh.actions?.[0];
    if (!current) return skipped(fresh.reason);
    if (current.arenaSnapshot !== action.arenaSnapshot || current.body.challengeId !== action.body.challengeId
      || current.body.rank !== action.body.rank) return skipped('竞技场排名或对手名单已更新，请按最新名单再挑战');
    if (!allowAction(1005, action)) return skipped('竞技场挑战已关闭');
    if (!protocol.ArenaChallengeResponse) throw new Error('缺少竞技场挑战回包定义');
    let previous = attempted.get(client);
    if (!previous || previous.reset !== current.arenaReset) {
      previous = { reset: current.arenaReset, snapshots: new Set(), confirmedTimes: 0 };
      attempted.set(client, previous);
    }
    previous.snapshots.add(current.arenaSnapshot);
    const challengeId = wireUid(current.body.challengeId);
    const body = await performWrite(() => client.request('ArenaChallengeRequest', { rank: current.body.rank, challengeId }, 'ArenaChallengeResponse', timeout));
    if (body?.isChange) return skipped('对手排名已变更，本轮未挑战，等待新名单');
    if (uidText(body?.reportId)) {
      previous.confirmedTimes = info.dailyChallengeTimes + 1;
      return { body };
    }
    const after = await request('ArenaInfo');
    if (!(after.dailyChallengeTimes > info.dailyChallengeTimes)) throw new Error('未确认竞技场战报或挑战次数变化');
    return { body };
  } finally {
    busy.delete(client);
  }
}

export const arenaDailyDriver = {
  id: 1005, title: '竞技场战斗',
  probes: [['ArenaInfoRequest', {}], ['AllResourceRequest', {}]],
  evaluate: evaluateArena, run: runArena,
};
