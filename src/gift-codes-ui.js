const giftLabels={queued:'待兑换',sending:'兑换中',success:'兑换成功',used:'已兑换',rejected:'服务器拒绝',unknown:'待确认',skipped:'未发送',recorded:'已有记录'};
let giftPage=1,giftPageSize=10,giftStatus='exclude-invalid',giftViewed='',giftRows=[],giftTotal=0,giftPages=1,giftExporting=false;
const giftBatchLabels={success:'成功',used:'已兑换',rejected:'拒绝',unknown:'待确认',skipped:'未发送'};
let giftAccounts=[],giftSelected=new Set(),giftChosen=false,giftStarting=false,giftNote='';
let giftInitial=null,giftInitialVersion=0;
let giftLoading=false;
const giftAutoBusy=new Set();
function giftRecordQuery(){return new URLSearchParams({account:giftViewed,status:giftStatus,page:String(giftPage),pageSize:String(giftPageSize)});}
function paintGiftPage(){
  $('gift-prev').disabled=giftPage<=1;
  $('gift-next').disabled=giftPage>=giftPages;
  $('gift-record-export').disabled=giftExporting || !giftViewed || !giftTotal;
  $('gift-page').textContent=giftPage+' / '+giftPages+' 页，共 '+giftTotal+' 条';
  const body=$('gift-code-history');clear(body);
  for(const row of giftRows){
    const tr=el('tr');
    [row.code,giftLabels[row.status]||row.status,row.detail,when(row.at)].forEach((value,index)=>{
      const td=el('td','',value);td.setAttribute('data-label',['礼包码','状态','结果','时间'][index]);tr.append(td);
    });
    const action=el('td');action.setAttribute('data-label','操作');
    if(row.retryable){const retry=el('button','gift-auto-toggle','重试');retry.type='button';retry.onclick=async()=>{
      if(!confirm('重试礼包码 '+row.code+'？服务器此前拒绝了请求，但具体原因可能尚未识别，重试不保证成功。'))return;
      retry.disabled=true;const account=giftViewed;
      try{await call('/api/gift-codes/retry?'+new URLSearchParams({account}),{method:'POST',body:JSON.stringify({confirm:true,code:row.code})});if(giftViewed===account)$('gift-record-notice').textContent='已提交重试，请查看新增的兑换记录';await refreshGiftCodes();}
      catch(error){if(giftViewed===account)$('gift-record-notice').textContent=error.message;}
      finally{retry.disabled=false;}
    };action.append(retry);}else action.textContent='—';tr.append(action);body.append(tr);
  }
  if(!giftRows.length){const tr=el('tr'),td=el('td','','暂无符合条件的兑换记录');td.colSpan=5;tr.append(td);body.append(tr);}
}
function giftRecordsReset(){giftPage=1;giftRows=[];giftTotal=0;giftPages=1;paintGiftPage();$('gift-record-notice').textContent='';}
$('gift-prev').onclick=()=>{if(giftPage>1){giftPage--;void refreshGiftCodes();}};
$('gift-next').onclick=()=>{if(giftPage<giftPages){giftPage++;void refreshGiftCodes();}};
$('gift-page-size').onchange=()=>{giftPageSize=Number($('gift-page-size').value);giftRecordsReset();void refreshGiftCodes();};
$('gift-record-status').onchange=()=>{giftStatus=$('gift-record-status').value;giftRecordsReset();void refreshGiftCodes();};
$('gift-record-account').onchange=()=>{giftViewed=$('gift-record-account').value;giftRecordsReset();void refreshGiftCodes();};
$('gift-record-export').onclick=async()=>{
  if(giftExporting || !giftViewed || !giftTotal)return;
  const viewed=giftViewed,status=giftStatus,query=giftRecordQuery();
  giftExporting=true;paintGiftPage();
  try{
    const response=await fetch('/api/gift-codes/export?'+query);
    if(!response.ok)throw Error((await response.json()).error || '导出失败');
    const blob=await response.blob();
    if(status!==giftStatus || viewed!==giftViewed)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='礼包兑换记录.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('gift-record-notice').textContent='已导出当前账号和筛选条件下的全部记录。';
  }catch(error){if(status===giftStatus && viewed===giftViewed)$('gift-record-notice').textContent='导出失败：'+error.message;}
  finally{giftExporting=false;paintGiftPage();}
};
function giftCanStart(a){return !a.paused&&!a.running&&!a.error;}
function giftTargets(){return giftAccounts.filter(a=>giftSelected.has(a.id)&&giftCanStart(a)).map(a=>a.id);}
function giftAccountNote(a){
  if(a.error)return a.error;
  if(a.paused)return '已暂停';
  if(a.running)return '兑换中 '+(a.total-(a.counts.queued??0)-(a.counts.sending??0))+' / '+a.total;
  const last=Object.entries(giftBatchLabels).filter(([status])=>a.counts[status]).map(([status,label])=>label+' '+a.counts[status]);
  return (a.connected?'已连接':'未连接')+(last.length?' · 上批：'+last.join('，'):'');
}
function paintGiftState(){
  const running=giftAccounts.filter(a=>a.running).length;
  $('gift-code-state').textContent=[running?'正在兑换，剩余 '+running+' 个账号':'',giftNote].filter(Boolean).join('；');
}
function paintGiftInitial(){
  const button=$('gift-load-initial'),note=$('gift-code-initial-note');
  // 载入公共码库不依赖游戏账号：未添加账号时也可点击抓取并查看；新增行/批量新增仍需选择账号。
  button.disabled=giftLoading;
  $('gift-add-row').disabled=!giftSelected.size;
  $('gift-batch-add').disabled=!giftSelected.size;
  button.textContent=giftLoading?'正在检查并载入…':'载入未兑换公共码';
  if(!giftInitial){note.textContent='点击载入可立即检查当天缓存并抓取';return;}
  note.textContent=(giftInitial.dailyTime||'每日更新')+'；公共码 '+giftInitial.total+' 条，所选账号未兑换码 '+giftInitial.available+' 条，已下架过期码 '+giftInitial.expired+' 条；'
    +(giftInitial.lastSyncedAt?'上次同步 '+when(giftInitial.lastSyncedAt):'等待首次同步')+(giftInitial.lastError?'；同步失败，保留原有码库：'+giftInitial.lastError:'');
  const table=clear($('gift-code-library-rows'));
  for(const entry of giftInitial.displayRows??[]){
    if(!entry.eligible&&!entry.usage.some(row=>['queued','sending'].includes(row.status))&&!$('gift-show-processed').checked)continue;
    const usage=entry.usage.map(row=>row.title+'：'+(giftLabels[row.status]||'未兑换')).join('；');
    const counts={};for(const row of entry.usage){const status=giftLabels[row.status]||'未兑换';counts[status]=(counts[status]??0)+1;}
    const status=entry.usage.length===1?(giftLabels[entry.usage[0].status]||'未兑换'):entry.usage.length?Object.entries(counts).map(([label,count])=>label+' '+count).join(' / '):'未连接账号';
    const availability=entry.eligible?(entry.usage.some(row=>row.status!=='unused')?'部分账号可用':entry.expiresAt?'未到期':'有效期待确认')
      :entry.usage.some(row=>['queued','sending'].includes(row.status))?'处理中':entry.usage.some(row=>row.status==='unknown')?'待确认，不重发':'已处理，不再兑换';
    const row=el('tr');[entry.code,availability,status,entry.expiresAt||'来源未注明',entry.manual?'个人添加':'公共码库'].forEach((value,index)=>{const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','可用状态','使用状态','到期日期','来源 / 操作'][index]);row.append(cell);});row.children[2].title=usage;table.append(row);
  }
  if(!table.children.length){const row=el('tr'),cell=el('td','','暂无未兑换码，可点击载入或新增礼包码行');cell.colSpan=5;row.append(cell);table.append(row);}
}
async function refreshGiftInitial(){
  if(giftLoading)return;
  const version=++giftInitialVersion;
  const query=new URLSearchParams({accounts:JSON.stringify([...giftSelected])});
  try{const data=await call('/api/gift-codes/initial?'+query);if(version!==giftInitialVersion)return;giftInitial=data;paintGiftInitial();}
  catch(error){if(version===giftInitialVersion){$('gift-code-initial-note').textContent='公共码库读取失败：'+error.message;$('gift-load-initial').disabled=true;}}
}
$('gift-load-initial').onclick=async()=>{
  if(giftLoading)return;giftLoading=true;paintGiftInitial();const version=++giftInitialVersion;
  try{const data=await call('/api/gift-codes/load',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected]})});if(version!==giftInitialVersion)return;giftInitial=data;giftNote=data.lastError?'同步失败，已载入可用缓存：'+data.lastError:'已载入全部未兑换码，历史已处理和已过期的码默认不显示。';}
  catch(error){giftNote=error.message;}
  finally{giftLoading=false;if(version!==giftInitialVersion)void refreshGiftInitial();paintGiftInitial();paintGiftState();}
};
$('gift-show-processed').onchange=paintGiftInitial;
$('gift-add-row').onclick=()=>{
  if(!giftSelected.size)return;
  const row=el('tr'),code=el('input'),date=el('input');code.type='text';code.maxLength=128;code.placeholder='输入礼包码';code.setAttribute('aria-label','新增礼包码');date.type='date';date.setAttribute('aria-label','新增礼包码到期日期');
  const inputCell=el('td');inputCell.append(code);const dateCell=el('td');dateCell.append(date);const actions=el('td'),save=el('button','gift-auto-toggle','保存'),cancel=el('button','gift-auto-toggle','取消');save.type=cancel.type='button';
  cancel.onclick=()=>row.remove();
  save.onclick=async()=>{if(!code.value.trim()){code.focus();return;}if(!giftSelected.size){giftNote='请先勾选保存到的游戏账号';paintGiftState();return;}save.disabled=cancel.disabled=code.disabled=date.disabled=true;
    try{const result=await call('/api/gift-codes/manual',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected],code:code.value.trim(),expiresAt:date.value||null})});row.remove();giftNote=result.saved?'已保存到 '+result.saved+' 个游戏账号'+(result.ignored?'，已有记录的账号已过滤':''):'该码已有兑换历史，没有重复添加';await refreshGiftCodes();}
    catch(error){giftNote=error.message;paintGiftState();}
    finally{save.disabled=cancel.disabled=code.disabled=date.disabled=false;}
  };
  const controls=el('div','gift-manual-actions');controls.append(save,cancel);actions.append(controls);row.append(inputCell,el('td','','待保存'),el('td','','未兑换'),dateCell,actions);[...row.children].forEach((cell,index)=>cell.setAttribute('data-label',['礼包码','可用状态','使用状态','到期日期','操作'][index]));$('gift-code-manual-rows').append(row);code.focus();
};
// 批量新增：弹窗粘贴多行礼包码，每行一条，统一保存到已勾选账号。
const batchDialog=document.createElement('dialog');batchDialog.id='gift-batch-dialog';batchDialog.setAttribute('aria-labelledby','gift-batch-title');
const batchHeading=document.createElement('h2');batchHeading.id='gift-batch-title';batchHeading.textContent='批量新增礼包码';
const batchInput=document.createElement('textarea');batchInput.rows=8;batchInput.maxLength=12000;batchInput.placeholder='每行一个礼包码，换行分隔，可整段粘贴';
batchInput.setAttribute('aria-label','批量礼包码，每行一个');
const batchExpiry=document.createElement('input');batchExpiry.type='date';batchExpiry.setAttribute('aria-label','批量礼包码共用到期日期');
const batchHint=document.createElement('p');batchHint.className='dim';
const batchMessage=document.createElement('p');batchMessage.setAttribute('role','status');
const batchFooter=document.createElement('div');batchFooter.className='update-footer';
const batchCancel=document.createElement('button');batchCancel.type='button';batchCancel.textContent='取消';
const batchSave=document.createElement('button');batchSave.type='button';batchSave.textContent='保存';
batchFooter.append(batchSave,batchCancel);
batchDialog.append(batchHeading,batchInput,batchExpiry,batchHint,batchMessage,batchFooter);
document.body.append(batchDialog);
batchCancel.onclick=()=>batchDialog.close();
batchDialog.oncancel=event=>{event.preventDefault();batchDialog.close();};
$('gift-batch-add').onclick=()=>{
  if(!giftSelected.size){giftNote='请先勾选保存到的游戏账号';paintGiftState();return;}
  batchInput.value='';batchExpiry.value='';batchMessage.textContent='';
  batchHint.textContent='将保存到已勾选的 '+giftSelected.size+' 个游戏账号；已有兑换历史的账号自动过滤，到期日期留空表示未注明。';
  batchDialog.showModal();batchInput.focus();
};
batchSave.onclick=async()=>{
  const codes=[...new Set(batchInput.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean))];
  if(!codes.length){batchMessage.textContent='请至少输入一条礼包码';return;}
  batchSave.disabled=batchCancel.disabled=batchInput.disabled=batchExpiry.disabled=true;
  try{
    const result=await call('/api/gift-codes/manual',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected],codes,expiresAt:batchExpiry.value||null})});
    batchDialog.close();
    giftNote='批量保存 '+result.codes+' 条礼包码：写入 '+result.saved+' 个账号'+(result.ignored?'，过滤已有记录 '+result.ignored+' 项':'');
    paintGiftState();await refreshGiftCodes();void refreshGiftInitial();
  }catch(error){batchMessage.textContent=error.message;}
  finally{batchSave.disabled=batchCancel.disabled=batchInput.disabled=batchExpiry.disabled=false;}
};
function paintGiftAccounts(){
  const box=$('gift-account-list'),key=giftAccounts.map(a=>a.id+'\n'+a.title).join('\n');
  if(box.accountsKey!==key){
    box.accountsKey=key;clear(box);
    for(const a of giftAccounts){
      const input=el('input');input.type='checkbox';
      input.onchange=()=>{giftChosen=true;if(input.checked)giftSelected.add(a.id);else giftSelected.delete(a.id);++giftInitialVersion;paintGiftAccounts();void refreshGiftInitial();};
      const automatic=el('button','gift-auto-toggle');automatic.type='button';
      automatic.onclick=async event=>{
        event.preventDefault();if(giftAutoBusy.has(a.id))return;giftAutoBusy.add(a.id);automatic.disabled=true;
        const account=giftAccounts.find(account=>account.id===a.id);
        try{const result=await call('/api/gift-codes/auto?account='+encodeURIComponent(a.id),{method:'POST',body:JSON.stringify({confirm:true,enabled:!account.autoRedeem})});giftNote=account.autoRedeem?'已关闭该账号自动兑换':result.syncError?'自动兑换已开启，码库同步失败：'+result.syncError:'已开启该账号自动兑换；暂停账号会等待恢复。';}
        catch(error){giftNote=error.message;}
        finally{giftAutoBusy.delete(a.id);await refreshGiftCodes();}
      };
      const row=el('label','gift-account');row.append(input,el('span','',a.title),automatic,el('span','dim'));
      box.append(row);
    }
  }
  giftAccounts.forEach((a,index)=>{
    const row=box.children[index];
    row.firstChild.checked=giftSelected.has(a.id);row.firstChild.disabled=Boolean(a.error);
    const automatic=row.querySelector('button');automatic.textContent=a.autoRedeem?'关闭自动兑换':'开启自动兑换';automatic.setAttribute('aria-pressed',String(Boolean(a.autoRedeem)));automatic.disabled=giftAutoBusy.has(a.id);
    row.lastChild.textContent=giftAccountNote(a)+' · 未兑换 '+(a.available??0)+' 条';
  });
  const ready=giftTargets().length;
  $('gift-selected-count').textContent='已选 '+ready+' / '+giftAccounts.length;
  $('gift-code-start').disabled=giftStarting||!ready;
  const picker=$('gift-record-account');
  if(picker.options.length!==giftAccounts.length || giftAccounts.some((a,i)=>picker.options[i]?.value!==a.id || picker.options[i]?.text!==a.title))picker.replaceChildren(...giftAccounts.map(a=>new Option(a.title,a.id)));
  picker.value=giftViewed;
}
$('gift-select-all').onclick=()=>{giftChosen=true;giftSelected=new Set(giftAccounts.filter(account=>!account.error).map(a=>a.id));++giftInitialVersion;paintGiftAccounts();void refreshGiftInitial();};
$('gift-select-none').onclick=()=>{giftChosen=true;giftSelected=new Set();++giftInitialVersion;paintGiftAccounts();void refreshGiftInitial();};
let giftTimer, giftVersion=0;
function giftAccountChanged(){
  ++giftVersion;clearTimeout(giftTimer);
  giftNote='';giftViewed=current||'';giftRecordsReset();
  giftInitial=null;++giftInitialVersion;
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  $('gift-code-state').textContent='';
  if(!$('tab-giftcodes').classList.contains('hidden'))void refreshGiftCodes();
}
async function refreshGiftCodes(){
  const version=++giftVersion;
  clearTimeout(giftTimer);
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  void refreshGiftInitial();
  if(!accounts.some(a=>a.id===giftViewed))giftViewed=current||accounts[0]?.id||'';
  if(!accounts.length){giftViewed='';giftRecordsReset();$('gift-code-start').disabled=true;$('gift-code-state').textContent='请先添加账号';return;}
  try{
    const [list,data]=await Promise.all([call('/api/gift-codes/accounts'),call('/api/gift-codes?'+giftRecordQuery())]);
    if(version!==giftVersion)return;
    giftAccounts=list.accounts;giftRows=data.rows;giftPage=data.page;giftPages=data.pages;giftTotal=data.total;paintGiftPage();
    if($('gift-record-notice').textContent.startsWith('读取记录失败：'))$('gift-record-notice').textContent='';
    for(const id of [...giftSelected])if(!giftAccounts.some(a=>a.id===id))giftSelected.delete(id);
    paintGiftAccounts();paintGiftState();
    if(!$('tab-giftcodes').classList.contains('hidden'))giftTimer=setTimeout(refreshGiftCodes,giftAccounts.some(a=>a.running)?750:15000);
  }catch(error){if(version===giftVersion){giftRows=[];giftTotal=0;giftPages=1;giftPage=1;paintGiftPage();$('gift-record-notice').textContent='读取记录失败：'+error.message;$('gift-code-state').textContent=error.message;}}
}
$('gift-code-start').onclick=async()=>{
  const targets=giftTargets();
  if($('gift-code-manual-rows').children.length){$('gift-code-state').textContent='请先保存或取消新增行';return;}
  if(!giftInitial?.tryCodes?.length){$('gift-code-state').textContent='请先载入未兑换码或新增礼包码行';return;}
  if(!targets.length){$('gift-code-state').textContent='请至少选择一个账号';return;}
  ++giftVersion;clearTimeout(giftTimer);giftStarting=true;giftNote='';$('gift-code-start').disabled=true;
  try{
    const data=await call('/api/gift-codes/redeem',{method:'POST',body:JSON.stringify({confirm:true,library:true,accounts:targets})});
    const refused=data.results.filter(r=>!r.accepted);
    if(refused.length)giftNote='未开始：'+refused.map(r=>r.title+'（'+r.error+'）').join('、');
  }catch(error){giftNote=error.message;}
  giftStarting=false;
  await refreshGiftCodes();
};
