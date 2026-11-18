let wechatState=null,wechatTimer=null,wechatBusy=false,wechatVersion=0,wechatChoice='';
const wechatPath='/api/accounts/wechat-login/';
function renderWechatLogin(){
  const state=wechatState??{phase:'idle'},phase=state.phase;
  $('wechat-start').disabled=wechatBusy;
  $('wechat-start').textContent=state.id?'重新获取二维码':'获取二维码';
  const image=$('wechat-qr');image.hidden=!state.qrImage;if(state.qrImage)image.src=state.qrImage;else image.removeAttribute('src');
  const labels={idle:'点击获取二维码后，用手机微信扫码。',waiting:'请用手机微信扫码并确认授权。',scanned:'已扫码，请在手机微信确认授权。',authorizing:'授权成功，正在登录游戏…','reading-roles':'正在读取游戏区服和角色…',captured:'请选择要保存的角色。',expired:'二维码已过期，请重新获取。',saved:'账号已保存。新账号默认不挂机。',error:'授权失败，请重新获取二维码。'};
  $('wechat-hint').textContent=state.error||state.roleError||labels[phase]||'';
  const box=clear($('wechat-roles'));const choices=state.choices??[];
  if(choices.length===1&&!wechatChoice)wechatChoice=choices[0].id;
  if(!choices.some(row=>row.id===wechatChoice))wechatChoice='';
  for(const choice of choices){const label=el('label','choice-item'),input=el('input');input.type='radio';input.name='wechat-role';input.value=choice.id;input.checked=choice.id===wechatChoice;input.disabled=wechatBusy;input.onchange=()=>{wechatChoice=input.value;renderWechatLogin();};label.append(input,el('span','',choice.nickname+' · '+choice.worldName));box.append(label);}
  $('wechat-save').hidden=phase!=='captured';$('wechat-save').disabled=wechatBusy||!wechatChoice||!!state.roleError;
  $('wechat-roles-retry').hidden=phase!=='captured';$('wechat-roles-retry').disabled=wechatBusy;
  accountAddChanged('wechat',phase,{busy:wechatBusy});
}
async function pollWechatLogin(version){
  if(version!==wechatVersion||!wechatState?.id)return;
  try{const state=await call(wechatPath+'status?'+new URLSearchParams({id:wechatState.id}));if(version!==wechatVersion)return;wechatState=state;renderWechatLogin();if(!['captured','error','expired','saved'].includes(state.phase))wechatTimer=setTimeout(()=>pollWechatLogin(version),1500);}
  catch(error){if(version===wechatVersion){wechatState={...wechatState,phase:'error',error:error.message};renderWechatLogin();}}
}
async function resetWechatLogin(){
  if(wechatBusy)return false;clearTimeout(wechatTimer);++wechatVersion;
  if(wechatState?.id&&wechatState.phase!=='saved')await call(wechatPath+'cancel',{method:'POST',body:JSON.stringify({confirm:true,id:wechatState.id})});
  wechatState=null;wechatChoice='';renderWechatLogin();return true;
}
$('wechat-start').onclick=async()=>{
  if(wechatBusy)return;clearTimeout(wechatTimer);const version=++wechatVersion;wechatBusy=true;renderWechatLogin();
  try{wechatState=await call(wechatPath+'start',{method:'POST',body:JSON.stringify({confirm:true})});wechatChoice='';}
  catch(error){wechatState={phase:'error',error:error.message};}
  finally{wechatBusy=false;renderWechatLogin();if(wechatState?.id)void pollWechatLogin(version);}
};
$('wechat-roles-retry').onclick=async()=>{
  if(wechatBusy||!wechatState?.id)return;wechatBusy=true;renderWechatLogin();
  try{wechatState=await call(wechatPath+'roles',{method:'POST',body:JSON.stringify({confirm:true,id:wechatState.id})});wechatChoice='';}
  catch(error){wechatState.error=error.message;}
  finally{wechatBusy=false;renderWechatLogin();if(wechatState?.phase==='reading-roles')void pollWechatLogin(wechatVersion);}
};
$('wechat-save').onclick=async()=>{
  if(wechatBusy||wechatState?.phase!=='captured')return;
  const choice=wechatState.choices?.find(row=>row.id===wechatChoice);if(!choice)return;
  wechatBusy=true;renderWechatLogin();
  try{if(!await configMayChangeAccount(choice.accountId))throw Error('请先处理当前账号未保存的配置');
    const result=await call(wechatPath+'save',{method:'POST',body:JSON.stringify({confirm:true,id:wechatState.id,choiceId:choice.id})});
    wechatState={phase:'saved'};++wechatVersion;clearTimeout(wechatTimer);
    stateActions.upsertAccount({...accounts.find(account=>account.id===result.account.id),...result.account});
    accountDetailsOwner=null;selectLoadedAccount(result.account.id);renderAccounts();
    try{await loadAccounts(false);}catch{wechatState.error='账号已保存，列表刷新失败，请刷新页面查看。';}
  }catch(error){wechatState.error=error.message;}
  finally{wechatBusy=false;renderWechatLogin();}
};
renderWechatLogin();
