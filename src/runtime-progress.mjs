export function stepObservation(entry) {
  const label = entry.step?.label || entry.title || entry.label;
  const state = entry.pending || ['unknown', 'pending'].includes(entry.status) ? 'pending'
    : entry.skipped ? 'waiting' : entry.ok ? 'ok' : 'error';
  const text = entry.reason || entry.error || entry.note || label || (entry.ok ? '执行成功' : '已检查');
  return { text, state };
}

// 已用完的免费副本会延至明天，不再查询。保留今天各个副本的最后一次实际结果。
export function summarizeTrialChecks(schedule, taskKey, raids) {
  const today = schedule.nextDay() - 86400;
  const statuses = raids.map(raid => ({ name: raid.title || '副本 ' + raid.raidId,
    result: schedule.status(taskKey + ':' + raid.raidId) })).filter(row => row.result?.checkedAt >= today);
  if (!statuses.length) return;
  const severity = ['error','pending','waiting','ok'].find(value => statuses.some(row => row.result.state === value));
  schedule.observe(taskKey, statuses.map(row => row.name + '：' + row.result.text).join('；'), severity);
}

// 博物馆统一由基地计划报告升级、领奖、上架和探宝状态。
export function museumRuntimeStatus(settings, { status, nextCheck }) {
  if (settings.museum?.runEnabled === false || !settings.loop?.world) return { observation: null, nextCheck: null };
  if (['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => settings.museum?.[key])) {
    return { observation: status('museum.runEnabled') ?? null, nextCheck: nextCheck('museum.runEnabled') ?? null };
  }
  return { observation: null, nextCheck: null };
}

// 只读展示层：进度使用已观测计数，条件保留真实阻断原因，不从开关推断已完成。
export function runtimeProgress(control,observation,usage={counters:{}},{running=false,connected=false,treasureReward='今日奖励未同步',freeTimes,now=Date.now()}={}){
 const text=observation?.text||'',state=observation?.state,counters=usage.counters??{};
 const mapping={
  'schedule.pirate':['pirateSweeps','本工具今日免费扫荡','次'],
  'cityWar.enabled':['cityWarDispatches','本工具今日出征','次'],
  'forge.enabled':['forgeStarts','本工具今日锻造','单'],
  'resident.enabled':['residentOrders','本工具今日交单','单'],
  'cargo.enabled':['cargoLoads','本工具今日装货','次'],
  'worldBoss.enabled':['worldBossPetrol','本工具今日首战用油',''],
  'trials.paid':['trialDiamonds','本工具今日扫荡用钻',''],
 };
 const count=mapping[control.key];
 let progress=count&&Number.isSafeInteger(counters[count[0]])?count[1]+' '+counters[count[0]]+count[2]:'—';
 let condition=state === 'unseen' ? '—' : text||'尚未同步当前条件';
 if(control.key!=='treasure.enabled'&&/^(控制项|分组控制)/.test(text) && !control.blockedBy?.length)
   return {progress:'—',condition:control.enabled ? control.configurationNote || '范围已开启' : '范围已关闭'};
 // 只拆显式的分隔句，避免把条件数字当作完成量。
 const trial=['trials.paid','trials.ads','schedule.trialSweep'].includes(control.key);
 const match=!trial && text.match(/^(.+?(?:\d+\/\d+|已领至第\s*\d+\s*档|已领取\s*\d+|累计[^，；]*\d+|当前进度\s*\d+)[^，；]*)(?:[，；]\s*(.+))?$/);
 if(control.key==='treasure.enabled'){
  progress='本工具今日出征 '+(counters.treasureDispatches??0)+'次 · '+treasureReward;
 }else if(match){progress=match[1];condition=match[2]||'—';}
 else if(/^(今日.*礼包|当前免费礼包|本期.*免费礼包).*已领取$/.test(text)){progress=text;condition='—';}
 else if(state==='ok'&&!trial){progress=text||'已确认执行成功';condition='—';}
 if(state==='error'||state==='pending')condition=text||'等待确认';
 if(!control.enabled)condition='已关闭'+(condition==='—'?'':'；'+condition);
 else if(control.blockedBy?.length)condition='受总控限制：'+control.blockedBy.join('、')+(condition==='—'?'':'；'+condition);
 else if(!connected)condition='账号未连接'+(condition==='—'?'':'；'+condition);
 else if(!running&&condition==='—')condition='挂机未运行';
 else if(state==='unseen')condition=control.configurationNote || '等待首次检查';
 const type={'schedule.freeRecruit':'hero','schedule.freeAntiqueRecruit':'antique'}[control.key];
 if(type&&connected){
  const ts=freeTimes?.[type];
  if(Number.isSafeInteger(ts)&&ts>=0){
   const day=ms=>new Date(ms+28800000).toISOString().slice(0,10);
   const time=new Date(ts*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
   const date=day(ts*1000);
   const prefix=date===day(now)?'':date===day(now+86400000)?'明日 ':date.slice(5)+' ';
   progress=ts*1000<=now?'冷却已到':'下次 '+prefix+time;
   if(condition.startsWith('下次免费招募'))condition='—';
  }
 }
 return {progress,condition};
}
