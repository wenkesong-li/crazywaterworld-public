import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{radarDispatchConfirmed,runAllianceRadar}from'../src/alliance-radar.mjs';import{formatLoopStep,formatLoopRound}from'../src/loop.mjs';import{createUsageLedger}from'../src/automation-settings.mjs';import{pirateAdvanceFixture}from'./fixtures/pirate-advance.mjs';
process.on('uncaughtException',e=>{console.error(e.stack);process.exitCode=1;});
import { previewRadarSweep } from '../src/radar-sweep.mjs';
import { defaultSettings, hasExtraWork, validateSettings } from '../src/automation-settings.mjs';
import { loadProtocol } from '../src/proto.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-confirm-'));let n=0;
for(const mode of ['moving','wrongTarget','delayed','network','rejected']){
 const f=pirateAdvanceFixture(),s=f.settings;s.radar.runEnabled=s.radar.enabled=true;s.radar.fleetIds=['1远征船'];s.radar.petrolReserve=0;f.player.guildId='1001007';f.config.tables.ModuleOpenCfg.data.push({moduleId:'联盟情报',playerLevel:18});f.config.tables.WorldParamCfg.data.push({paramName:'情报事件消耗汽油',paramValue:500});
 let state=1,reads=f.client.request;f.client.request=async(name,body,response)=>name==='RadarInfoRequest'?{radarInfo:{events:[{uid:'9007199254740995',eventId:10001,state,gridIdx:777,createTime:100,pirate:{type:1,level:1}}]}}:reads(name,body,response);
 f.client.sendWatch=async()=>{f.client.writes.push('sent');if(mode==='network')throw Error('连接暂未返回');if(mode==='rejected')throw Object.assign(Error('服务器拒绝'),{prompt:true,request:'RadarSendFleetsRequest'});state=2;if(mode!=='delayed'){f.fleet.state=2;f.fleet.targetGridIdx=mode==='wrongTarget'?888:777;}};
 const ledger=createUsageLedger('a',{file:path.join(dir,mode+'.json')}),reports=[],args={getSettings:()=>s,enabled:()=>true,ledger,report:e=>reports.push(e)};
 await runAllianceRadar(f.client,f.config,f.player,args);
 const last=reports.at(-1);if(mode==='moving'){assert.equal(last.ok,true);assert.equal(ledger.snapshot().uncertain,0);}else if(mode==='rejected'){assert.equal(last.ok,false);assert.equal(ledger.snapshot().uncertain,0);}else{assert.equal(last.status,'pending');assert.equal(ledger.snapshot().uncertain,1);const text=formatLoopStep({...last,category:'联盟情报'});assert(text.includes('等待确认'));assert(!text.includes('失败'));
 state=3;await runAllianceRadar(f.client,f.config,f.player,args);assert.equal(ledger.snapshot().uncertain,0);assert(reports.some(e=>e.label==='已确认前次联盟情报派遣'));assert.equal(f.client.writes.length,1);}
 n++;
}
assert.equal(radarDispatchConfirmed({fleets:[{buildingId:'2远征船',state:2,targetGridIdx:777}]},{state:2,gridIdx:777},'1远征船'),false);
const text=formatLoopRound({round:1,tasks:{results:[]},dailies:{results:[]},world:{results:[{status:'pending'}]}});assert(text.includes('待确认 1 项'));console.log('情报确认专项 '+(n+2)+'/'+(n+2)+' 通过：行军、目标不符、延迟、网络未知、明确拒绝、他队排除及汇总');

function sweepFixture(name) {
  const f = pirateAdvanceFixture();
  f.protocol = loadProtocol();
  f.settings = defaultSettings();
  Object.assign(f.player, { guildId: 123, level: 30 });
  f.config.tables.ModuleOpenCfg.data.push({ moduleId: '联盟情报', playerLevel: 18 });
  f.config.tables.WorldParamCfg.data.push({ paramName: '情报事件消耗汽油', paramValue: 500 });
  f.settings.radar.runEnabled = f.settings.radar.enabled = true;
  const normal = f.protocol.MonthCardType.MONTH_CARD_NORMAL;
  const state = {
    cards: [{ type: normal, endTime: -1 }],
    events: [{ uid: '9007199254740995', eventId: 10001, state: 4, createTime: 100 }],
    fixedEvent: { eventId: 2, state: 4, createTime: 200 },
    confirm: true, writes: 0, reads: [], reports: [], claims: [], dispatches: [],
  };
  const ledger = createUsageLedger('a', { file: path.join(dir, name + '.json') });
  const read = f.client.request;
  f.client.request = async (name, body, response) => {
    state.reads.push(name);
    if (name === 'MonthCardRequest') return { cardItem: state.cards };
    if (name === 'RadarInfoRequest') return { radarInfo: { events: state.events, fixedEvent: state.fixedEvent } };
    if (name === 'RadarGetRewardRequest') {
      state.claims.push(body);
      return { reward: { asset: [{ id: 'GOLD', num: 1 }] } };
    }
    return read(name, body, response);
  };
  f.client.sendWatch = async (name, body, { beforeSend }) => {
    if (name === 'RadarSendFleetsRequest') {
      state.dispatches.push(body.fleetBuildingIds);
      state.events.find(e => e.state === 1).state = 3;
      return;
    }
    assert.equal(name, 'RadarGetAllRewardsRequest');
    assert.deepEqual(body, {});
    state.onSend?.();
    try { beforeSend(); } catch (error) { throw Object.assign(error, { notSent: true }); }
    state.writes++;
    if (state.error) throw state.error;
    if (state.confirm) { state.events = []; state.fixedEvent = null; }
  };
  const run = () => runAllianceRadar(f.client, f.config, f.player, {
    protocol: f.protocol, getSettings: () => f.settings, ledger, enabled: () => true, report: e => state.reports.push(e),
  });
  const preview = () => previewRadarSweep(f.client, f.protocol, f.player, ledger);
  return { ...f, ledger, state, run, preview };
}

{
  const f = sweepFixture('membership');
  const older = defaultSettings();
  older.radar.monthCardSweep = true;
  const migrated = validateSettings(older);
  assert.equal(migrated.radar.enabled, true);
  assert.equal(migrated.radar.runEnabled, false);
  assert(!Object.hasOwn(migrated.radar, 'monthCardSweep'));
  assert.equal(hasExtraWork(f.settings), true);
  f.settings.radar.runEnabled = false;
  await f.run();
  assert.deepEqual(f.state.reads, []);
  f.settings.radar.runEnabled = true;
  f.settings.radar.enabled = false;
  await f.run();
  assert.deepEqual(f.state.reads, []);
  f.settings.radar.enabled = true;
  f.player.level = 29;
  await f.run();
  assert(!f.state.reads.includes('MonthCardRequest'));
  assert.equal(f.state.claims.length, 2);
  f.player.level = 30;
  for (const cards of [[], [{ type: f.protocol.MonthCardType.MONTH_CARD_SENIOR, endTime: -1 }],
    [{ type: f.protocol.MonthCardType.MONTH_CARD_NORMAL, endTime: 1 }]]) {
    f.state.cards = cards;
    f.state.events = [{ uid: String(500 + f.state.claims.length), eventId: 10001, state: 4, createTime: 210 }];
    const previousClaims = f.state.claims.length;
    assert.equal(await f.preview(), null);
    await f.run();
    assert.equal(f.state.claims.length, previousClaims + 1);
  }
  assert.equal(f.state.writes, 0);
}
{
  const f = sweepFixture('claim');
  f.state.cards[0].endTime = Math.floor(Date.now() / 1000) + 600;
  const plan = await f.preview();
  assert.equal(plan.actions.length, 1);
  assert.match(plan.actions[0].label, /2 项/);
  assert.deepEqual(f.ledger.keyRecords(), {});
  assert.equal(f.state.writes, 0);
  await f.run();
  await f.run();
  assert.equal(f.state.writes, 1);
  assert(f.state.reports.some(e => e.ok && e.label.includes('2 项')));
  assert.equal(f.ledger.snapshot().uncertain, 0);
  f.state.cards[0].endTime = 1;
  f.state.events = [{ uid: '530', eventId: 10001, state: 1, createTime: 250, pirate: { type: 1, level: 1 } }];
  f.settings.radar.fleetIds = ['1远征船'];
  await f.run();
  assert.deepEqual(f.state.dispatches, [['1远征船']]);
  f.state.cards[0].endTime = -1;
  f.state.events[0].state = 4;
  await f.run();
  assert.equal(f.state.writes, 2);
  assert.deepEqual(f.state.claims, []);
}
{
  const f = sweepFixture('pending');
  f.state.confirm = false;
  f.state.error = Error('连接中断');
  await f.run();
  assert.equal(f.ledger.snapshot().uncertain, 1);
  delete f.state.error;
  f.state.cards[0].endTime = 1;
  await f.run();
  assert.deepEqual(f.state.claims, [], '月卡过期后逐条领奖仍避开前次未知的一键领取');
  f.state.cards[0].endTime = -1;
  f.state.events = [{ uid: '9007199254740996', eventId: 10001, state: 4, createTime: 210 }];
  await f.run(); // 新事件与上一批未确认的固定情报同时出现。
  assert.equal(f.state.writes, 1);
  assert.deepEqual((await f.preview()).actions, []);
  f.state.fixedEvent = null;
  f.state.confirm = true;
  await f.run();
  assert.equal(f.state.writes, 2);
  assert.equal(f.ledger.snapshot().uncertain, 0);
}
{
  const f = sweepFixture('recheck');
  f.state.onSend = () => { f.settings.radar.enabled = false; };
  await f.run();
  assert.equal(f.state.writes, 0);
  assert.deepEqual(f.ledger.keyRecords(), {});
  f.settings.radar.enabled = true;
  delete f.state.onSend;
  f.state.error = Object.assign(Error('服务器拒绝'), { prompt: true, request: 'RadarGetAllRewardsRequest' });
  await f.run();
  assert.deepEqual(f.ledger.keyRecords(), {});
  delete f.state.error;
  await f.run();
  assert.equal(f.ledger.snapshot().uncertain, 0);
}
console.log('普通月卡一键扫荡通过：旧配置、等级和权益校验、批量预览、固定情报、重复防护、发送前暂停与拒绝重试');
