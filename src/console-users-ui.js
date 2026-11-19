let consoleIdentity=null,consoleUsersData=null,consoleUserSelected=null,consoleUsersBusy=false;
async function loadConsoleIdentity(){
  const response=await fetch('/api/auth/me');
  if(response.status===404){document.documentElement.dataset.consoleRole='admin';$('console-users-open').hidden=true;return;} // Unauthenticated local development console.
  if(response.status===401){location.replace('/login');throw Error('请先登录');}
  if(!response.ok)throw Error('无法验证后台用户权限');
  consoleIdentity=(await response.json()).user;
  document.documentElement.dataset.consoleRole=consoleIdentity.role;
  $('console-identity').textContent=(consoleIdentity.role==='admin'?'管理员：':'后台用户：')+consoleIdentity.username;
  $('console-assignment-note').hidden=consoleIdentity.role==='admin';
}
function consoleUsersMessage(message){$('console-users-message').textContent=message;}
function renderConsoleUsers(){
  const list=clear($('console-users-list')),query=$('console-user-search').value.trim().toLowerCase();
  $('console-users-total').textContent=consoleUsersData.users.length;
  $('console-users-enabled').textContent=consoleUsersData.users.filter(user=>user.enabled).length;
  $('console-users-games').textContent=consoleUsersData.accounts.length;
  for(const user of consoleUsersData.users.filter(row=>row.username.toLowerCase().includes(query))){
    const button=el('button','console-user-choice');button.type='button';button.disabled=consoleUsersBusy;
    button.setAttribute('aria-pressed',String(consoleUserSelected===user.id));
    const avatar=el('span','console-user-avatar',Array.from(user.username)[0].toUpperCase());avatar.setAttribute('aria-hidden','true');
    const text=el('span','console-user-choice-text');text.append(el('strong','',user.username),el('span','dim',user.role==='admin'?'全部游戏账号':user.accountIds.length+' 个游戏账号'));
    button.append(avatar,text,el('span','console-user-status'+(user.enabled?' is-enabled':''),user.role==='admin'?'管理员':user.enabled?'已启用':'已停用'));
    button.onclick=()=>{consoleUserSelected=user.id;renderConsoleUsers();renderConsoleUserEditor();};list.append(button);
  }
  if(!list.children.length)list.append(el('p','dim','没有匹配的用户'));
}
function renderConsoleUserEditor(){
  const user=consoleUsersData?.users.find(row=>row.id===consoleUserSelected);
  $('console-user-editor').hidden=!user||user.role==='admin';
  $('console-user-empty').hidden=Boolean(user);
  $('console-user-root-note').hidden=user?.role!=='admin';
  if(!user||user.role==='admin')return;
  $('console-user-edit-name').textContent=user.username;
  $('console-user-enabled').checked=user.enabled;
  $('console-user-reset-password').value='';
  const box=clear($('console-user-assignments'));
  if(!consoleUsersData.accounts.length)box.append(el('p','dim','暂无游戏账号，请先在账号页添加。'));
  for(const account of consoleUsersData.accounts){
    const label=el('label','console-user-assignment'),input=el('input');input.type='checkbox';input.value=account.id;input.checked=user.accountIds.includes(account.id);
    const names=consoleUsersData.users.filter(other=>other.role==='user'&&other.id!==user.id&&other.accountIds.includes(account.id)).map(other=>other.username);
    const text=el('span');text.append(el('strong','',account.title),el('span','dim',names.length?'同时分配给：'+names.join('、'):'未分配给其他普通用户'));
    input.onchange=()=>{$('console-assigned-count').textContent=$('console-user-assignments').querySelectorAll('input:checked').length;};
    label.append(input,text);box.append(label);
  }
  $('console-assigned-count').textContent=box.querySelectorAll('input:checked').length;
}
$('console-user-search').oninput=()=>{if(consoleUsersData)renderConsoleUsers();};
for(const [id,checked] of [['console-assign-all',true],['console-assign-none',false]])$(id).onclick=()=>{for(const input of $('console-user-assignments').querySelectorAll('input'))input.checked=checked;$('console-assigned-count').textContent=checked?consoleUsersData.accounts.length:0;};
async function refreshConsoleUsers(){
  consoleUsersData=await call('/api/admin/users');
  if(!consoleUsersData.users.some(user=>user.id===consoleUserSelected))consoleUserSelected=null;
  renderConsoleUsers();renderConsoleUserEditor();
}
async function consoleUsersAction(work){
  if(consoleUsersBusy)return;consoleUsersBusy=true;
  for(const field of $('console-users-dialog').querySelectorAll('button,input,fieldset'))field.disabled=true;
  try{await work();}catch(error){consoleUsersMessage(error.message);}
  finally{consoleUsersBusy=false;for(const field of $('console-users-dialog').querySelectorAll('button,input,fieldset'))field.disabled=false;if(consoleUsersData)renderConsoleUsers();}
}
$('console-users-open').onclick=()=>{
  if(consoleIdentity?.role!=='admin')return;
  $('console-user-create-panel').open=!consoleUsersData||consoleUsersData.users.length===1;$('console-users-dialog').showModal();consoleUsersMessage('正在读取用户与分配情况…');
  void consoleUsersAction(async()=>{await refreshConsoleUsers();consoleUsersMessage('');});
};
$('console-users-close').onclick=()=>{if(!consoleUsersBusy)$('console-users-dialog').close();};
$('console-users-dialog').oncancel=event=>{if(consoleUsersBusy)event.preventDefault();};
$('console-user-password-visible').onchange=()=>{
  for(const id of ['console-user-create-password','console-user-reset-password'])$(id).type=$('console-user-password-visible').checked?'text':'password';
};
$('console-user-create').onsubmit=event=>{
  event.preventDefault();
  const username=$('console-user-create-name').value.trim(),password=$('console-user-create-password').value;
  void consoleUsersAction(async()=>{
    const result=await call('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true,username,password})});
    consoleUserSelected=result.user.id;$('console-user-create-panel').open=false;$('console-user-create-name').value='';$('console-user-create-password').value='';
    await refreshConsoleUsers();consoleUsersMessage('后台用户已创建，请勾选游戏账号并保存分配。');
  });
};
$('console-user-editor').onsubmit=event=>{
  event.preventDefault();const user=consoleUsersData?.users.find(row=>row.id===consoleUserSelected);if(!user)return;
  const payload={confirm:true,revision:user.revision,enabled:$('console-user-enabled').checked,accountIds:[...$('console-user-assignments').querySelectorAll('input:checked')].map(input=>input.value)};
  const password=$('console-user-reset-password').value;if(password)payload.password=password;
  void consoleUsersAction(async()=>{
    await call('/api/admin/users/'+encodeURIComponent(user.id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    await refreshConsoleUsers();consoleUsersMessage('用户与分配已保存，该用户需要重新登录以使用新权限。');
  });
};
$('console-user-delete').onclick=()=>{
  const user=consoleUsersData?.users.find(row=>row.id===consoleUserSelected);
  if(!user||!confirm('删除后台用户“'+user.username+'”？分配权限会撤销，游戏账号数据继续保留。'))return;
  void consoleUsersAction(async()=>{
    await call('/api/admin/users/'+encodeURIComponent(user.id),{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true,revision:user.revision})});
    consoleUserSelected=null;await refreshConsoleUsers();consoleUsersMessage('后台用户已删除。');
  });
};
