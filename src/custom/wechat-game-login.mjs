import crypto from 'node:crypto';
import { createManagedWechatService } from './wechat-service.mjs';

const APPID = 'wx2ea52a972ea18e5e';
// 游戏客户端公开的微信渠道参数，不是用户账号密钥。
const config = { appId:'14021170', signKey:'df8B12db29582476', packetId:'50001988', channelId:'1400', bai:14021170, bci:31400, sst:1 };
const sorted = object => Object.keys(object).sort().filter(key => typeof object[key] === 'number' || object[key]).map(key => key+'='+object[key]).join('&');

export async function exchangeWechatGameCode(code, { fetcher=fetch, signal }={}) {
  if(typeof code!=='string'||!code)throw Error('微信未返回小程序登录code，请重新扫码');
  const did=crypto.randomUUID(),dc=crypto.randomUUID(),clientKey=crypto.randomBytes(16).toString('hex');
  let initId='',tid='';
  const request=async(route,body={},method='POST',extra={})=>{
    const nonce='1'+crypto.randomBytes(4).toString('hex');
    const query={sign:'',ts:Date.now().toString(),nonce:tid||nonce,initId:initId||tid||nonce,reqId:nonce,apiVersion:200,bai:config.bai,bci:config.bci,rpf:'31',did,dc,sst:1,...extra};
    const header={ai:config.appId,pi:config.packetId,ci:config.channelId,cv:'101200',pf:'1'};
    const text=JSON.stringify(body);
    query.sign=crypto.createHash('md5').update(`wltyx$${config.signKey}${clientKey}@${text==='{}'?'':text}$${sorted(query)}##${sorted(header)}`).digest('hex');
    const response=await fetcher('https://api.gzxianc.com/api'+route+'?'+new URLSearchParams(Object.entries(query).filter(([,value])=>value)),{
      method,headers:{'content-type':'application/json;charset=utf-8',...header},body:method==='GET'?undefined:text,signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(20000)]),redirect:'error'});
    const result=await response.json();if(result.meta?.tid)tid=result.meta.tid;
    if(!response.ok||result.code!==0)throw Error('游戏登录服务拒绝请求，请重新扫码或稍后重试');
    return result.data;
  };
  const pub=await request('/public/info',{},'GET',{ai:config.appId,pi:config.packetId,ci:config.channelId,pf:'1'});
  const key=crypto.publicEncrypt({key:'-----BEGIN PUBLIC KEY-----\n'+pub.publicKey.match(/.{1,64}/g).join('\n')+'\n-----END PUBLIC KEY-----',padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(clientKey)).toString('base64');
  const init=await request('/init',{did,dc,nm:'wifi',sv:'15.0',svc:'',pm:'Mac',lang:'zh',tz:'+8',dn:'',sd:'320',sh:'1280',sw:'720',pn:APPID,appVersion:'1.12.11',privacyVersion:100,key,activation:1,appName:'疯狂水世界'});
  initId=init.initId??'';const channel=init.channel;
  if(!channel?.appId||!channel.mchId)throw Error('游戏初始化缺少微信渠道信息');
  const params={protocol:'300003',code,sessionkey:'',openid:'',unionid:'',sceneId:'1001',appid:channel.appId,superaid:config.appId,aid:config.appId,packetid:channel.mchId,linkid:channel.mchId,cid:config.channelId,channelid:config.channelId,devicecode:dc,platform:'mac',system:'macOS 15.0',gameversion:'1.12.11',shareid:0,shareposition:0,shareserverid:'',shareroleid:'',traceId:Buffer.from(encodeURIComponent('{}')).toString('base64')};
  const response=await fetcher('https://minigame.ewan.cn/minigame',{method:'POST',headers:{'content-type':'text/plain;charset=utf-8',ai:channel.appId,pi:channel.mchId,ci:config.channelId,traceId:crypto.randomUUID(),reqId:'3'+Date.now().toString().slice(-7)},body:Buffer.from(encodeURIComponent(JSON.stringify(params))).toString('base64'),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(20000)]),redirect:'error'});
  const text=await response.text();let login;try{login=JSON.parse(text);}catch{login=JSON.parse(decodeURIComponent(Buffer.from(text,'base64').toString()));}
  if(!response.ok||login.status!==200||!login.mopenid)throw Error('微信游戏授权失败，请重新扫码');
  login.channeluid=String(login.openid);login.openid=login.mopenid;login.useractiveflag=1;
  login.userInfo={channelUid:login.channeluid,bandPhoneFlag:!!login.bandphoneflag,shareId:'0',sharePosition:'0',shareServerId:'',shareRoleId:'',userType:login.usertype,usertype:login.usertype,visitBackStatus:0};
  const game=await request('/user/login',{appVersion:'1.12.11',channel:{uid:login.openid,extJson:JSON.stringify(login)},sysVersion:'macOS 15.0',phoneModel:'Mac'});
  if(!game.openId||!(game.signToken||game.token)||!game.sign||!Number.isFinite(Number(game.ts)))throw Error('游戏返回的登录凭据不完整');
  const timestamp=Number(game.ts)<1e12?Number(game.ts)*1000:Number(game.ts);
  return {url:'wss://dhyaoj-gate.khlgamen.com:443/ws',source:'wechat',capturedAt:new Date().toISOString(),login:{language:'zh_CN',eworldParams:{openId:game.openId,token:game.signToken||game.token,sign:game.sign,timestamp},eworldClientInfo:{appId:config.appId,channelId:config.channelId,clientVersion:'1.12.11'},worldId:0,systemLanguage:'zh_cn_#hans'}};
}

export function createWechatLogin({ baseUrl=process.env.CW_WECHAT_SERVICE_URL||'', token=process.env.CW_WECHAT_SERVICE_TOKEN||'', fetcher=fetch, exchange=exchangeWechatGameCode, now=Date.now }={}) {
  const managed=baseUrl?null:createManagedWechatService();
  const sessions=new Map();let closed=false;
  const api=async(path,{method='GET',body,signal}={})=>{
    let response;
    try{response=await fetcher(new URL(path,baseUrl),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(45000)]),redirect:'error'});}
    catch(error){if(signal?.aborted)throw error;throw Error('微信扫码服务连接失败，请先启动微信授权服务');}
    return response;
  };
  const requireSession=(owner,id)=>{const s=sessions.get(owner);if(closed||!s||s.id!==id||s.expiresAt<=now())throw Error('二维码已失效，请重新获取');return s;};
  const view=s=>({id:s.id,phase:s.phase,qrImage:s.phase==='waiting'||s.phase==='scanned'?s.qrImage:null,expiresAt:s.expiresAt,error:s.error});
  async function json(path,options){const r=await api(path,options);const x=await r.json();if(!r.ok||x.code!==0)throw Error('微信授权服务返回失败，请重新获取二维码');return x.data;}
  async function cancel(owner,id){const s=sessions.get(owner);if(!s||id&&s.id!==id)return;if(s.saving)throw Error('正在保存账号，请稍候');s.controller.abort();clearTimeout(s.timer);sessions.delete(owner);s.credential=null;s.entry=null;s.qrImage=null;}
  return {
    async start(owner){if(closed)throw Error('服务已关闭');await cancel(owner);if(sessions.size>=100)throw Error('扫码人数过多，请稍后重试');
      const s={id:crypto.randomUUID(),phase:'starting',expiresAt:now()+5*60000,controller:new AbortController(),error:null};sessions.set(owner,s);
      s.timer=setTimeout(()=>{if(!s.saving)void cancel(owner,s.id);},5*60000);s.timer.unref?.();
      try{if(managed){const ready=await managed.ensure();baseUrl=ready.baseUrl;token=ready.token;requireSession(owner,s.id);}const q=await json('/wx/qrcodeauth',{method:'POST',body:{},signal:s.controller.signal});s.remoteId=q.session_id;if(typeof s.remoteId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(s.remoteId))throw Error('二维码会话无效');
        const image=await api('/wx/qrcodeauth/'+s.remoteId+'/image',{signal:s.controller.signal});if(!image.ok||!image.headers.get('content-type')?.startsWith('image/'))throw Error('二维码图片获取失败');const bytes=Buffer.from(await image.arrayBuffer());if(bytes.length>2*1024*1024)throw Error('二维码图片过大');
        requireSession(owner,s.id);s.qrImage='data:image/png;base64,'+bytes.toString('base64');s.phase='waiting';return view(s);
      }catch(error){await cancel(owner,s.id);throw error;}
    },
    async status(owner,id){const s=requireSession(owner,id);if(['waiting','scanned'].includes(s.phase)&&!s.poll){
      s.poll=(async()=>{try{const result=await json('/wx/qrcodeauth/'+s.remoteId+'/poll',{signal:s.controller.signal});requireSession(owner,id);
        if(result.status==='authorized'||result.status==='confirmed'){
          s.phase='authorizing';
          // 确认接口返回账号；从授权结果取得服务端账号引用，不向浏览器暴露票据。
          const account=await json('/wx/qrcodeauth/'+s.remoteId+'/confirm',{method:'POST',body:{},signal:s.controller.signal});
          const auth=await json('/wxapp/getCode',{method:'POST',body:{ref:String(account.id),app_id:APPID},signal:s.controller.signal});
          s.credential=await exchange(auth.result?.code,{fetcher,signal:s.controller.signal});requireSession(owner,id);s.phase='captured';s.qrImage=null;
        }else if(result.status==='scanned')s.phase='scanned';else if(['expired','cancelled'].includes(result.status)){s.phase='expired';s.qrImage=null;}
      }catch(error){if(!s.controller.signal.aborted){s.phase='error';s.error='微信授权未完成，请重新获取二维码';s.qrImage=null;}}finally{s.poll=null;}})();
    }return view(s);},
    session:requireSession,cancel,
    async close(){closed=true;for(const [owner,s] of sessions){s.saving=false;await cancel(owner,s.id);}managed?.close();},
  };
}
