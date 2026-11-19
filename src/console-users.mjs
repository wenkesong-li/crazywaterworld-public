import path from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';

export const normalizeConsoleUsername = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
export function passwordFields(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 256) throw Error('密码需为 4 至 256 个字符');
  const salt=randomBytes(16).toString('hex');
  return {salt,hash:scryptSync(password,salt,64).toString('hex')};
}
export function publicConsoleUser(user) {
  return {id:user.id,username:user.username,role:user.role,enabled:user.enabled,accountIds:[...user.accountIds],revision:user.revision,createdAt:user.createdAt};
}
export function createConsoleUsers({directory,admin,now=Date.now,resetAdmin=false}) {
  const file=path.join(directory,'console-users.json');
  const read=()=>{
    const data=readJson(file,null);
    if(data?.version!==1||!Array.isArray(data.users)||!data.users.some(u=>u.role==='admin'&&u.enabled))throw Error('后台用户数据无效，请恢复用户文件备份');
    const ids=new Set(),names=new Set();
    for(const user of data.users){
      if(typeof user.id!=='string'||!user.id||typeof user.username!=='string'||!user.username.trim()||!['admin','user'].includes(user.role)||typeof user.enabled!=='boolean'
        ||!Number.isSafeInteger(user.revision)||user.revision<1||!Array.isArray(user.accountIds)||user.accountIds.some(id=>typeof id!=='string')
        ||!/^[a-f0-9]{32}$/.test(user.salt)||!/^[a-f0-9]{128}$/.test(user.hash)||ids.has(user.id)||names.has(normalizeConsoleUsername(user.username)))throw Error('后台用户数据无效，已拒绝访问');
      ids.add(user.id);names.add(normalizeConsoleUsername(user.username));
    }
    return data;
  };
  withFileLock(file,()=>{
    if(readJson(file,null)===null)atomicJson(file,{version:1,users:[{...admin,id:'root',role:'admin',enabled:true,accountIds:[],revision:1,createdAt:new Date(now()).toISOString()}]});
    else if(resetAdmin){const data=read(),root=data.users.find(user=>user.id==='root'&&user.role==='admin');if(!root||data.users.some(user=>user.id!==root.id&&normalizeConsoleUsername(user.username)===normalizeConsoleUsername(admin.username)))throw Error('管理员环境变量与现有后台用户冲突');if(root.username!==admin.username||root.salt!==admin.salt||root.hash!==admin.hash){Object.assign(root,admin,{revision:root.revision+1});atomicJson(file,data);}}
  });
  read();
  function mutate(work){return withFileLock(file,()=>{const data=read();const result=work(data);atomicJson(file,data);return result;});}
  return {
    all:()=>read().users,
    get:id=>read().users.find(user=>user.id===id),
    find:username=>read().users.find(user=>normalizeConsoleUsername(user.username)===normalizeConsoleUsername(username)),
    create({username,password}){
      if(typeof username!=='string'||!username.trim()||username.trim().length>64||/[\x00-\x1f\x7f]/.test(username))throw Error('账号需为 1 至 64 个可见字符');
      const fields=passwordFields(password);
      return mutate(data=>{
        if(data.users.length>=1000)throw Error('后台用户数量已达上限');
        if(data.users.some(u=>normalizeConsoleUsername(u.username)===normalizeConsoleUsername(username)))throw Error('后台账号已存在');
        const user={...fields,id:randomUUID(),username:username.trim(),role:'user',enabled:true,accountIds:[],revision:1,createdAt:new Date(now()).toISOString()};
        data.users.push(user);return publicConsoleUser(user);
      });
    },
    update(id,{revision,password,enabled,accountIds},knownAccountIds){
      if(enabled!==undefined&&typeof enabled!=='boolean')throw Error('启用状态无效');
      if(accountIds!==undefined&&(!Array.isArray(accountIds)||accountIds.length>10000||accountIds.some(value=>typeof value!=='string'||!knownAccountIds.has(value))))throw Error('所选游戏账号已不存在，请刷新后重试');
      const fields=password===undefined?null:passwordFields(password);
      return mutate(data=>{
        const user=data.users.find(u=>u.id===id);if(!user)throw Error('后台用户已不存在');
        if(revision!==user.revision)throw Error('用户权限已被其他管理员修改，请刷新后重试');
        if(user.role==='admin')throw Error('不能通过普通用户管理修改超级管理员');
        if(fields)Object.assign(user,fields);
        if(enabled!==undefined)user.enabled=enabled;
        if(accountIds!==undefined)user.accountIds=[...new Set(accountIds)];
        user.revision++;return publicConsoleUser(user);
      });
    },
    remove(id,revision){return mutate(data=>{
      const user=data.users.find(u=>u.id===id);if(!user)throw Error('后台用户已不存在');
      if(user.role==='admin')throw Error('不能删除超级管理员');
      if(revision!==user.revision)throw Error('用户权限已更新，请刷新后重试');
      data.users=data.users.filter(u=>u.id!==id);return publicConsoleUser(user);
    });}
  };
}
