import { renderLoginPage as page } from './custom/login-page.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DATA_DIR, loadStore } from './accounts.mjs';
import { createConsoleUsers, passwordFields, publicConsoleUser } from './console-users.mjs';
import { createReleaseNotes } from './custom/release-notes.mjs';

import { atomicJson, readJson } from './json-store.mjs';

const SESSION_SECONDS = 24 * 60 * 60;
const cookieName = 'cw_console_session';
const digest = value => createHash('sha256').update(value).digest('hex');


export function createConsoleAuth({directory=DATA_DIR,env=process.env,now=Date.now,getGameAccounts=()=>loadStore().accounts}={}) {
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'console-admin.json');
  let admin=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const configuredPassword = env.CW_ADMIN_PASSWORD;
  const sameAdmin = configuredPassword && admin?.username === (env.CW_ADMIN_USERNAME || 'admin')
    && /^[a-f0-9]{32}$/.test(admin.salt) && /^[a-f0-9]{128}$/.test(admin.hash)
    && timingSafeEqual(scryptSync(configuredPassword, admin.salt, 64), Buffer.from(admin.hash, 'hex'));
  if(!admin || (configuredPassword && !sameAdmin)){
    const password=env.CW_ADMIN_PASSWORD||randomBytes(15).toString('base64url');
    admin={username:env.CW_ADMIN_USERNAME||'admin',...passwordFields(password)};
    atomicJson(file, admin);
    if(!env.CW_ADMIN_PASSWORD)fs.writeFileSync(path.join(directory,'console-initial-password.txt'),password,{mode:0o600});
  }
  if(!admin.username||!/^[a-f0-9]{32}$/.test(admin.salt)||!/^[a-f0-9]{128}$/.test(admin.hash))throw Error('控制台管理员配置无效');
  const users=createConsoleUsers({directory,admin,now,resetAdmin:Boolean(env.CW_ADMIN_PASSWORD)});
  const releaseNotes=createReleaseNotes(directory);
  const sessionFile = path.join(directory, 'console-sessions.json');
  const saved = readJson(sessionFile, { version: 1, sessions: [] });
  if (saved?.version !== 1 || !Array.isArray(saved.sessions)) throw Error('控制台会话数据无效');
  const sessions = new Map();
  const failures = new Map();
  for (const entry of saved.sessions) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.key) || !Number.isSafeInteger(entry.expires)
      || typeof entry.userId !== 'string' || !Number.isSafeInteger(entry.revision)
      || (entry.activeAccountId !== null && typeof entry.activeAccountId !== 'string')) {
      throw Error('控制台会话记录无效');
    }
    if (entry.expires > now()) sessions.set(entry.key, { ...entry, streams: new Set() });
  }

  function persist() {
    atomicJson(sessionFile, {
      version: 1,
      sessions: [...sessions].map(([key, { expires, userId, revision, activeAccountId }]) =>
        ({ key, expires, userId, revision, activeAccountId })),
    });
  }

  function remove(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    for (const response of session.streams) response.destroy();
    persist();
  }
  function revoke(id){for(const [key,session] of sessions)if(session.userId===id)remove(key);}
  function currentUser(req){
    const session=sessions.get(req.consoleSessionKey);
    if(!session)return null;
    if(session.expires<=now()){remove(req.consoleSessionKey);return null;}
    const user=users.get(session.userId);
    if(!user?.enabled||user.revision!==session.revision){remove(req.consoleSessionKey);return null;}
    return publicConsoleUser(user);
  }
  function authorizeRequest(req,res){
    const pathname=new URL(req.url,'http://localhost').pathname;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(typeof value==='string'?{error:value}:value));};
    const redirect=location=>{res.writeHead(303,{Location:location});res.end();};
    if(!['GET','HEAD'].includes(req.method)&&((req.headers.origin&&req.headers.origin!=='http://'+req.headers.host&&req.headers.origin!=='https://'+req.headers.host)||req.headers['sec-fetch-site']==='cross-site')){json(403,'拒绝跨站请求');return false;}
    const token=String(req.headers.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
    const key=digest(token);req.consoleSessionKey=key;
    const user=currentUser(req);
    req.consoleUser=user;
    const secure = req.socket.encrypted || (env.CW_TRUST_PROXY === '1'
      && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && req.headers['x-forwarded-proto'] === 'https');
    const setCookie=(value,age)=>res.setHeader('Set-Cookie',`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`);
    if(pathname==='/auth/logout'&&req.method==='POST'){remove(key);setCookie('',0);redirect('/login');return false;}
    if(pathname==='/login'&&req.method==='GET'){
      if(user)redirect('/');else{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page(false));}return false;
    }
    function readBody(limit,work){req.setEncoding('utf8');let body='',size=0;req.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size<=limit)body+=chunk;});req.on('end',()=>{try{if(size>limit){json(413,'请求过大');return;}work(body);}catch(error){json(400,error.message);}});}
    if(pathname==='/auth/login'&&req.method==='POST'){
      readBody(4096,body=>{
        const peer=req.socket.remoteAddress;
        const ip=env.CW_TRUST_PROXY==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)?String(req.headers['x-real-ip']||peer):peer;
        for(const [address,entry] of failures)if(entry.until<=now())failures.delete(address);
        const failure=failures.get(ip);
        if(failure?.count>=5||failures.size>=1000){json(429,'登录尝试过于频繁，请 15 分钟后重试');return;}
        const values=new URLSearchParams(body),password=values.get('password')||'';
        const target=users.find(values.get('username'));
        const credential=target||admin;
        const valid=password.length<=256&&timingSafeEqual(scryptSync(password,credential.salt,64),Buffer.from(credential.hash,'hex'))&&target?.enabled;
        if(!valid){failures.set(ip,{count:(failure?.count||0)+1,until:failure?.until||now()+900000});res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'});res.end(page(true));return;}
        failures.delete(ip);remove(key);
        for(const [id,entry] of sessions)if(entry.expires<=now())remove(id);
        const sameUser=[...sessions].filter(([,entry])=>entry.userId===target.id);
        if(sameUser.length>=10)remove(sameUser[0][0]);
        if(sessions.size>=10000)remove(sessions.keys().next().value);
        const value=randomBytes(32).toString('hex');
        sessions.set(digest(value),{expires:now()+SESSION_SECONDS*1000,streams:new Set(),userId:target.id,revision:target.revision,activeAccountId:null});
        try { persist(); } catch (error) { sessions.delete(digest(value)); throw error; }
        setCookie(value,SESSION_SECONDS);redirect('/');
      });return false;
    }
    if(!user){if(pathname.startsWith('/api/'))json(401,'请先登录控制台');else redirect('/login');return false;}
    if(pathname==='/api/auth/me'&&req.method==='GET'){json(200,{user});return false;}
    if(pathname==='/api/updates'&&req.method==='GET'){json(200,releaseNotes.view(user.id));return false;}
    if(pathname==='/api/updates/read'&&req.method==='POST'){
      readBody(4096,body=>{
        const actor=currentUser(req);
        if(!actor){json(401,'请先登录控制台');return;}
        json(200,releaseNotes.acknowledge(actor.id,JSON.parse(body||'{}').version));
      });return false;
    }
    if(pathname.startsWith('/api/admin/')){
      if(user.role!=='admin'){json(403,'仅管理员可操作');return false;}
      if(pathname==='/api/admin/users'&&req.method==='GET'){json(200,{users:users.all().map(publicConsoleUser),accounts:getGameAccounts().map(a=>({id:a.id,title:a.label||a.lastSeen?.nickname||'未命名游戏账号'}))});return false;}
      const match=/^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
      if(pathname==='/api/admin/users'&&req.method==='POST'||match&&['PATCH','DELETE'].includes(req.method)){
        readBody(65536,body=>{
          if(currentUser(req)?.role!=='admin'){json(403,'权限已变化，请重新登录');return;}
          const payload=JSON.parse(body||'{}');
          if(payload.confirm!==true)throw Error('请确认用户管理操作');
          let changed;
          if(req.method==='POST')changed=users.create(payload);
          else{
            const id=decodeURIComponent(match[1]);
            changed=req.method==='DELETE'?users.remove(id,payload.revision):users.update(id,payload,new Set(getGameAccounts().map(a=>a.id)));
            revoke(id);
          }
          json(200,{ok:true,user:changed});
        });return false;
      }
      json(404,'没有这个用户管理接口');return false;
    }
    if(req.headers.accept?.includes('text/event-stream')||pathname.includes('events')){
      const entry=sessions.get(key);entry.streams.add(res);
      const timer=setTimeout(()=>{ try { remove(key); } catch { /* The expired token is already removed from memory. */ } },Math.max(1,entry.expires-now()));timer.unref();
      res.on('close',()=>{clearTimeout(timer);entry.streams.delete(res);});
    }
    return true;
  }
  const authorize=(req,res)=>{try{return authorizeRequest(req,res);}catch{res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'鉴权数据暂不可用，已拒绝访问'}));return false;}};
  authorize.currentUser=currentUser;
  authorize.canAccess=(req,id)=>{const user=currentUser(req);return Boolean(user&&(user.role==='admin'||user.accountIds.includes(id)));};
  authorize.selectedAccount=req=>sessions.get(req.consoleSessionKey)?.activeAccountId;
  authorize.selectAccount=(req,id)=>{if(!authorize.canAccess(req,id))throw Error('无权访问此游戏账号');const entry=sessions.get(req.consoleSessionKey);if(entry.activeAccountId!==id){entry.activeAccountId=id;persist();}};
  return authorize;
}
