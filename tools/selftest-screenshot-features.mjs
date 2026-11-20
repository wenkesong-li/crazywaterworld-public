import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { defaultSettings, validateSettings, createUsageLedger, saveAutomationSettings, loadAutomationSettings, exportAutomationSettings, importAutomationSettings, settingsCatalog } from '../src/automation-settings.mjs';
import { automationControls, setAutomationControl } from '../src/automation-controls.mjs';
import { merchantStrategyPlan } from '../src/merchant-strategy.mjs';
import { merchantSettings } from '../src/merchant-planner.mjs';
import { recordMerchantSnapshot } from '../src/merchant-journal.mjs';
import { watchMerchant } from '../src/merchant-monitor.mjs';
import { runMerchantSpeed, planMerchantSpeed } from '../src/merchant-speed.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadConfig } from '../src/config.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-screenshot-features-'));
const protocol = loadProtocol();
let passed = 0, serial = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
const at = Date.UTC(2026, 10, 14, 4, 2) / 1000; // 北京时间12:02，实际配置的刷新窗口。
const config = { tables: {
  ActivityTradeCfg: { data: [ ['海商王贸易时间','10-22'],['海商王行驶时间','120'],['海商王加速时长','30'],['海商王刷新时间','10,12,14,16,18,20'],['海商王加速日购买上限','50'] ].map(([key,value])=>({key,value})) },
  ItemPriceCfg: { data: [{ itemId:'海商王加速',rubyPrice:800 }] },
  TradeShipCfg: { data: [{lv:1,capacity:1000,profitMargin:300}] },
  TradeGoodsCfg: { data: [1001,1002,1003].map(goodsId=>({goodsId,unitPrice:50,capacity:1,maxCount:1000})) },
} };
function fixture() {
  const id = ++serial, settings = defaultSettings(), calls = [], reports = [];
  Object.assign(settings.merchant, { autoSpeedUp:true, autoBuyPointers:true, speedUpMode:'refresh', speedUpMinProfit:100, pointerDailyDiamondLimit:4000 });
  Object.assign(settings.resources, {allowDiamonds:true,diamondDailyLimit:10000});
  const event = { period:1001,startTime:at-86400,endTime:at+86400 }, file = path.join(folder, 'usage-'+id+'.json');
  const state = { period:1001,player:{coins:1000,profit:2000,buySpeedTimes:0,goods:[{pid:1,goodsId:1001,num:100,buyPrice:10,cityId:10}]},
    cargo:{cargoLv:1,cityId:10,moveToCityId:20,moveStartTime:at-360,moveEndTime:at+6840},
    worldCargo:[{playerId:'99999',guildIdx:1,cargo:{cityId:30,moveToCityId:20,moveStartTime:at-2400,moveEndTime:at+360}}] };
  const radar={radar:[{cityId:10,specGoodsId:1001},{cityId:20,specGoodsId:1002}]};
  let stock=0, diamonds=10000, mode='', active=true, hook=()=>{};
  const client = new EventEmitter(); Object.assign(client,{connected:true,tradeWindow:event,serverClockOffsetMs:at*1000-Date.now(),
    async request(name,body={},response) {
      assert(protocol[name], name); assert(protocol[response], response); protocol[name].encode(body).finish();
      calls.push({name,body}); await hook(name,body);
      if(name==='TradeInfoRequest')return structuredClone(state);
      if(name==='TradeGuildRadarRequest')return structuredClone(radar);
      if(name==='AllItemRequest')return {items:stock?[{itemId:'海商王加速',num:stock}]:[]};
      if(name==='AllResourceRequest')return {list:[{res:4,amount:diamonds}]};
      if(name==='TradeBuySpeedItemRequest') {
        if(mode==='notSent')throw Object.assign(Error('未发送'),{notSent:true});
        if(mode==='unknown')throw Error('响应丢失');
        stock+=body.buyNum;diamonds-=800*body.buyNum;state.player.buySpeedTimes+=body.buyNum;
        return {buySpeedTimes:state.player.buySpeedTimes};
      }
      if(name==='TradeSpeedRequest') {stock-=body.useNum;state.cargo.moveEndTime-=body.useNum*1800;return {moveEndTime:state.cargo.moveEndTime};}
      throw Error('不允许请求 '+name);
    }
  });
  const ctx = { player:{playerId:String(91000+id),worldId:'2002001001',guildId:'1001',level:37},
    ledger:createUsageLedger('test',{file,now:()=>at*1000}),settings:()=>settings,label:'海商王',enabled:()=>active,report:r=>reports.push(r) };
  const marketHistory=[{observedAt:at-7020,stock:0},{observedAt:at-6120,stock:1000}].map(({observedAt,stock})=>({
    cityId:20,specGoodsId:1002,period:event.period,startTime:event.startTime,observedAt,
    goods:[{goodsId:1001,price:45,stock:0},{goodsId:1002,price:10,stock}]}));
  for(const market of marketHistory) recordMerchantSnapshot(ctx.ledger,{config,event,time:market.observedAt,market,radar,settings,
    state:{...state,cargo:{...state.cargo,cityId:20,moveToCityId:0,moveEndTime:0}}});
  return {settings,client,state,event,ctx,calls,reports,radar,marketHistory,run:()=>runMerchantSpeed(client,config,ctx,event,structuredClone(state)),
    writes:()=>calls.filter(c=>['TradeBuySpeedItemRequest','TradeSpeedRequest'].includes(c.name)),
    mode:v=>{mode=v;},hook:v=>{hook=v;},pause:()=>{active=false;},restart:()=>{ctx.ledger=createUsageLedger('test',{file,now:()=>at*1000});},stock:v=>{stock=v;} };
}
try {
  await test('新增模块消费默认关闭，真实配置目录校验和独立参数持久化',()=>{
    const settings=defaultSettings();validateSettings(settings,{catalog:settingsCatalog(loadConfig())});
    for(const key of ['alliance','guildShip','guildFort','silicon','heroRaid'])assert.equal(settings[key].enabled,false);
    settings.silicon.fleets[1].enabled=true;settings.silicon.fleets[1].safeGuilds=['23'];settings.silicon.fleets[1].safePlayers=['甲'];
    settings.silicon.windows=['22:00-02:00'];settings.alliance.allowedMaterials=['木板'];settings.merchant.speedUpMode='arrival';
    const file=path.join(folder,'settings.json');saveAutomationSettings('a',settings,{file,revision:0});
    assert.deepEqual(loadAutomationSettings('a',{file}).settings,validateSettings(settings));
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)),validateSettings(settings));
    assert.equal(loadAutomationSettings('b',{file}).settings.silicon.fleets[1].enabled,false);
  });
  await test('新增字段严格校验，无效舰队、时段、名单及未知分组不能静默保存',()=>{
    for(const change of [s=>s.silicon.windows=['25:00-26:00'],s=>s.silicon.fleets[1].id='1远征船',s=>s.silicon.fleets[0].safeGuilds=['联盟甲'],s=>s.silicon.fleets[0].extra=true,s=>s.guildShip.minCoinsLarge=101]){
      const s=defaultSettings();change(s);assert.throws(()=>validateSettings(s));
    }
    const doc=exportAutomationSettings(defaultSettings());doc.settings.heroRaid=null;assert.throws(()=>importAutomationSettings(doc));
    const catalog=settingsCatalog(loadConfig());
    for(const [group,key] of [['alliance','allowedMaterials'],['alliance','blockedMaterials'],['alliance','requestMaterials'],['alliance','techIds'],['guildShip','rewardItems'],['guildShip','disabledMaterials'],['guildFort','materials']]){
      const s=defaultSettings();s[group][key]=['不存在的配置项'];assert.throws(()=>validateSettings(s,{catalog}),group+'.'+key);
    }
  });
  await test('全部新增参数具有界面入口，超凡英雄与联盟商船归属活动页并保留子项',()=>{
    const src=fs.readFileSync(new URL('../src/settings-ui.js',import.meta.url),'utf8');
    const { groups, activityFields }=newStateFunction(src.slice(0,src.indexOf('function configGet('))+'\nreturn {groups:configGroups,activityFields:activityOwnedSettings};')();
    const fields=new Set(groups.flatMap(g=>g.fields.map(f=>f.key)));
    const s=defaultSettings();for(const group of ['alliance','guildFort','silicon'])for(const key of Object.keys(s[group])){
      if(key==='fleets')for(let i=0;i<3;i++)for(const name of Object.keys(s.silicon.fleets[i])){
        // 直接编辑已建成的实际舰队，不再用三个可重分配的编号槽位冒充已解锁队伍。
        if(name==='id')assert(!fields.has('silicon.fleets.'+i+'.id'));
        else {const field=groups.flatMap(g=>g.fields).find(f=>f.key==='silicon.fleets.'+i+'.'+name);assert(field);assert.equal(field.fleetGroup,'silicon');assert.equal(field.fleetIndex,i);}
      }
      else assert(fields.has(group+'.'+key),group+'.'+key);
    }
    for(const group of ['heroRaid','guildShip'])for(const key of Object.keys(s[group])){
      assert(activityFields.has(group+'.'+key),group+'.'+key);
      assert(!fields.has(group+'.'+key),'活动移出游戏配置');
    }
    const heroControl=automationControls.find(c=>c.key==='heroRaid.enabled');
    assert(heroControl);assert(!heroControl.idleGroup);assert(!heroControl.configTarget);
    Object.assign(s.heroRaid,{enabled:true,challenge:true,orders:true,lottery:true,retryTimes:23});
    assert.deepEqual(setAutomationControl(s,'heroRaid.enabled',false).heroRaid,{...s.heroRaid,enabled:false});
    s.alliance.recruit=true;const off=setAutomationControl(s,'alliance.enabled',false);assert(off.alliance.recruit);
    for(const key of ['alliance','guildFort','silicon'])assert(automationControls.some(c=>c.key===key+'.enabled'&&c.configTarget));
    const shipControl=automationControls.find(c=>c.key==='guildShip.enabled');
    assert(shipControl);assert(!shipControl.idleGroup);assert(!shipControl.configTarget);assert.deepEqual(shipControl.gates,[]);
  });
  await test('刷新模式只在真实刷新窗口加速，每日用量与每程上限共同生效',()=>{
    const f=fixture(),stock=new Map([['海商王加速',10]]);
    const plan=(time,extra)=>planMerchantSpeed(config,f.event,f.state,f.radar,stock,f.settings.merchant,time,
      {actor:f.ctx.player,marketHistory:f.marketHistory,...extra});
    assert.equal(plan(at).useNum,4);
    assert.equal(plan(at+9*60).kind,'none');
    assert.notEqual(plan(at,{dailyUsed:27}).kind,'speed');
    f.settings.merchant.dailyPointerLimit=0;assert.notEqual(plan(at).kind,'speed');
  });
  await test('零库存没有物品条目时仍能按有效方案补购，后续使用计入持久日额',async()=>{
    const f=fixture();await f.run();assert.deepEqual(f.writes().map(c=>[c.name,c.body]),[['TradeBuySpeedItemRequest',{buyNum:4}]]);
    assert.equal(f.ctx.ledger.snapshot().counters.merchantPointerDiamonds,3200);f.restart();await f.run();
    assert.equal(f.writes().at(-1).name,'TradeSpeedRequest');assert.equal(f.ctx.ledger.snapshot().counters.merchantPointers,4);
  });
  await test('自然领先、自己的船、外盟船和异港船都不会触发抢货消费',async()=>{
    for(const alter of [f=>f.state.worldCargo[0].cargo.moveEndTime=f.state.cargo.moveEndTime+120,
      f=>f.state.worldCargo[0].playerId=f.ctx.player.playerId, f=>f.state.worldCargo[0].guildIdx=2,
      f=>f.state.worldCargo[0].cargo.moveToCityId=30, f=>f.state.worldCargo=[]]){
      const f=fixture();alter(f);await f.run();assert.deepEqual(f.writes(),[]);
    }
  });
  await test('空舱抢货只用改变顺位的最少指针，已有指针足够时直接使用',async()=>{
    const f=fixture();f.state.player.goods=[];f.state.cargo.moveEndTime=at+1320;f.stock(3);
    f.state.cargo.moveStartTime=f.state.cargo.moveEndTime-7200;
    f.state.worldCargo.unshift({...f.state.worldCargo[0],playerId:'99998',
      cargo:{...f.state.worldCargo[0].cargo,moveEndTime:at+10}});
    await f.run();assert.deepEqual(f.writes().map(c=>[c.name,c.body]),[['TradeSpeedRequest',{useNum:1}]]);
  });
  await test('只允许用背包指针与只准补一根分别按用户额度执行',async()=>{
    for(const [speed,buy,have,expected] of [
      [false,true,3,[]],[true,false,0,[]],[true,false,1,['TradeSpeedRequest']],
      [true,true,0,['TradeBuySpeedItemRequest']]
    ]){
      const f=fixture();f.state.player.goods=[];f.state.cargo.moveEndTime=at+1320;
      f.state.cargo.moveStartTime=f.state.cargo.moveEndTime-7200;f.stock(have);
      Object.assign(f.settings.merchant,{autoSpeedUp:speed,autoBuyPointers:buy,pointerDailyDiamondLimit:800});
      await f.run();assert.deepEqual(f.writes().map(c=>c.name),expected);
      if(expected[0]==='TradeBuySpeedItemRequest')assert.deepEqual(f.writes()[0].body,{buyNum:1});
    }
  });
  await test('次优货能补足利润、缺少可比行情、本金不足或低于用户门槛时保留指针',()=>{
    const f=fixture(), stock=new Map([['海商王加速',4]]);
    const plan=history=>planMerchantSpeed(config,f.event,f.state,f.radar,stock,f.settings.merchant,at,
      {actor:f.ctx.player,marketHistory:history});
    f.state.player.goods=[];
    assert.equal(plan(f.marketHistory).accelerationReason,'stockRace');
    const selfBought=f.marketHistory.map((m,i)=>({...m,held:i?[{cityId:20,goodsId:1002,num:1000}]:[]}));
    assert.notEqual(plan(selfBought).kind,'speed','自己买走的库存不能触发抢货消费');
    const alternate=f.marketHistory.map(m=>({...m,goods:[...m.goods,{goodsId:1003,price:10,stock:0}]}));
    assert.notEqual(plan(alternate).kind,'speed');
    assert.notEqual(plan(f.marketHistory.slice(0,1)).kind,'speed');
    f.state.player.coins=1;assert.notEqual(plan(f.marketHistory).kind,'speed');
    f.state.player.coins=1000;f.settings.merchant.minExpectedProfit=50000;assert.notEqual(plan(f.marketHistory).kind,'speed');
  });
  await test('补购或使用前重新检查同盟顺位，准备期间的商船推送取消旧计划',async()=>{
    for(const have of [0,4]){
      const f=fixture();f.stock(have);f.hook(name=>{
        if(name==='TradeInfoRequest')f.state.worldCargo[0].cargo.moveEndTime=f.state.cargo.moveEndTime+300;
      });await f.run();assert.deepEqual(f.writes(),[]);
    }
    const f=fixture(), monitor=watchMerchant(f.client);
    monitor.observe({event:f.event,state:f.state,time:at});
    const off=monitor.subscribe(()=>{});
    try {
      f.hook(name=>{if(name==='AllResourceRequest')f.client.emit('message',{name:'SCTradeCargoMove',
        body:{cargo:f.state.worldCargo[0]}});});
      await f.run();assert.deepEqual(f.writes(),[]);assert(monitor.fleetRevision>0);
    } finally { off(); }
  });
  await test('购买指针遵守总预算、模块预算、钻石保留量和游戏日购买上限',async()=>{
    for(const alter of [f=>f.settings.resources.allowDiamonds=false,f=>f.settings.merchant.pointerDailyDiamondLimit=0,
      f=>f.settings.resources.diamondDailyLimit=3000,f=>f.settings.resources.diamondThreshold=9000,f=>f.state.player.buySpeedTimes=49]){
      const f=fixture();alter(f);await f.run();assert.equal(f.writes().length,0);
    }
  });
  await test('购买响应未知跨重启不重发，明确未发送释放预算',async()=>{
    const f=fixture();f.mode('unknown');await f.run();f.restart();await f.run();assert.equal(f.writes().length,1);assert.equal(f.ctx.ledger.pendingCounters().diamonds,3200);
    const g=fixture();g.mode('notSent');await g.run();assert.equal(g.ctx.ledger.pendingCounters().diamonds??0,0);
  });
  await test('购买前关闭开关取消写入，零日用量不因购买功能绕过',async()=>{
    const f=fixture();f.hook(name=>{if(name==='AllResourceRequest')f.pause();});await f.run();assert.equal(f.writes().length,0);
    const g=fixture();g.settings.merchant.dailyPointerLimit=0;await g.run();assert.equal(g.writes().length,0);
  });
  await test('利润达限或读取期间调低上限时，不继续使用或购买指针',async()=>{
    for(const count of [0,4]){
      const f=fixture();f.stock(count);f.settings.merchant.profitLimit=2000;await f.run();assert.equal(f.writes().length,0);
      const g=fixture();g.stock(count);g.hook(name=>{if(name==='AllItemRequest')g.settings.merchant.profitLimit=2000;});
      await g.run();assert.equal(g.writes().length,0);
    }
  });
  await test('首趟指定时间、有限等待、同刷新一程与累计利润上限作用于真实计划',()=>{
    const f=fixture(),policy=merchantSettings({...f.settings.merchant,firstDepartureMode:'time',firstDepartureTime:'14:00'}),move={kind:'move',city:10,destination:20};
    assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
    const start=Date.UTC(2026,10,14,2,1)/1000,explore={...move,exploration:true};
    assert.equal(merchantStrategyPlan(explore,config,f.event,f.state,merchantSettings(),start,f.ctx.ledger).kind,'wait');
    assert.equal(merchantStrategyPlan(explore,config,f.event,f.state,merchantSettings(),start+1800,f.ctx.ledger).kind,'move');
    const ticket=f.ctx.ledger.reserve({},{},{},{uniqueKey:'leg',details:{scope:'merchant:'+f.event.startTime+':1001',expected:{request:'TradeMoveRequest',start:at-60}}});f.ctx.ledger.confirm(ticket);
    policy.firstDepartureMode='smart';policy.speedUpMode='arrival';assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
    assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at+7200,f.ctx.ledger).kind,'move');
    policy.profitLimit=2000;assert.equal(merchantStrategyPlan({kind:'buy'},config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
  });
} finally { fs.rmSync(folder,{recursive:true,force:true}); }
console.log('截图功能与接线专项：'+passed+'/'+passed+' 通过');
