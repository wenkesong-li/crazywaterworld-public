import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DATA_DIR } from '../accounts.mjs';

const version='v0.3.10';
const checksums={
  'darwin-arm64':'72ad020e83864706cfe3d6398b983317014741029ef3b9e5ada4e8bbf783b0d1',
  'darwin-x64':'e2ab9b36c9878bd20929299b7ecfbaff9d5ef62cec1f73e0e4777830692f865c',
  'linux-x64':'b43189a80920b008167cc27bc3ff9ad02668c99ae18a289692223005af236c09',
  'linux-arm64':'11ae032a76e94901938223798fee7593209c339438444aa495005d1953c6f8bd',
  'win32-x64':'ef3bea7e3413838cdc2ee6b991ca30308929d33580160ed6707bc35b5ff11c52',
  'win32-arm64':'f7d78523288a6d821fc2b1a4af3fa690b81482be82baa6689b90f0e8c34470da',
};
const directory=path.join(DATA_DIR,'wechat-authorizer');
const binary=path.join(directory,'yyb-go-'+version+(process.platform==='win32'?'.exe':''));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let installing=null;
export function prepareWechatService(){
  if(installing)return installing;
  installing=(async()=>{
    const expected=checksums[process.platform+'-'+process.arch];if(!expected)throw Error('当前服务器架构不支持微信扫码授权服务');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
    if(fs.existsSync(binary)&&digest(fs.readFileSync(binary))===expected)return binary;
    const name='yyb-go-'+(process.platform==='win32'?'windows':process.platform)+'-'+(process.arch==='x64'?'amd64':process.arch)+(process.platform==='win32'?'.exe':'');
    let bytes;
    try{
      const r=await fetch('https://github.com/525815266/YYB-Go-Enhanced/releases/download/'+version+'/'+name,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error();bytes=Buffer.from(await r.arrayBuffer());
      if(digest(bytes)!==expected)throw Error();
    }catch{
      const release=await fetch('https://api.github.com/repos/525815266/YYB-Go-Enhanced/releases/tags/'+version,{signal:AbortSignal.timeout(20000)});
      const asset=(await release.json()).assets?.find(row=>row.name===name);if(!asset)throw Error('微信扫码服务下载失败，请检查GitHub连接');
      const r=await fetch(asset.url,{headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('微信扫码服务下载失败');bytes=Buffer.from(await r.arrayBuffer());
    }
    if(digest(bytes)!==expected)throw Error('微信扫码服务文件校验失败');
    const temp=binary+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,bytes,{mode:0o700});fs.renameSync(temp,binary);return binary;
  })().finally(()=>{installing=null;});return installing;
}

export function createManagedWechatService(){
  const port=18086,baseUrl='http://127.0.0.1:'+port;
  let child=null,starting=null,closed=false,token=null;
  const healthy=async()=>{try{return (await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}};
  return {
    async ensure(){
      if(closed)throw Error('微信服务已关闭');
      if(starting)return starting;
      starting=(async()=>{
        const file=await prepareWechatService();if(closed)throw Error('微信服务已关闭');
        const tokenFile=path.join(directory,'protocol-token');
        if(!fs.existsSync(tokenFile))try{fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
        token=fs.readFileSync(tokenFile,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('微信服务令牌配置异常');
        if(!await healthy()){
          const resource=path.join(directory,'resource');fs.mkdirSync(resource,{recursive:true,mode:0o700});
          child=spawn(file,['-host','127.0.0.1','-port',String(port),'-resource-root',resource,'-keepalive-interval','0'],{windowsHide:true,stdio:'ignore',env:{...process.env,YYB_AUTH_DRIVER:'none',YYB_PROTOCOL_TOKEN:token,YYB_INTEGRATION_TOKEN:'',YYB_BIND_ADDRESS:'127.0.0.1',YYB_PORT:String(port)}});
          let failure;child.once('error',error=>{failure=error;});child.once('exit',()=>{failure=Error('授权服务已退出');child=null;});
          for(let i=0;i<50;i++){if(closed)throw Error('微信服务已关闭');if(failure)throw Error('微信授权服务启动失败');if(await healthy())return {baseUrl,token};await delay(100);}
          child?.kill();throw Error('微信授权服务启动超时');
        }
        return {baseUrl,token};
      })().finally(()=>{starting=null;});return starting;
    },
    close(){closed=true;child?.kill();child=null;},
  };
}
