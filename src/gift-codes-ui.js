const giftLabels={queued:'待兑换',sending:'兑换中',success:'兑换成功',used:'已兑换',rejected:'服务器拒绝',unknown:'待确认',skipped:'未发送',recorded:'已有记录'};
let giftPage=1,giftPageSize=10,giftStatus='exclude-invalid',giftViewed='',giftRows=[],giftTotal=0,giftPages=1,giftExporting=false;
const giftBatchLabels={success:'成功',used:'已兑换',rejected:'拒绝',unknown:'待确认',skipped:'未发送'};
let giftAccounts=[],giftSelected=new Set(),giftChosen=false,giftStarting=false,giftNote='';
let giftInitial=null,giftInitialVersion=0;
let giftLoading=false;
const giftAutoBusy=new Set();
function giftRecordQuery(){return new URLSearchParams({account:giftViewed,status:giftStatus,page:String(giftPage),pageSize:String(giftPageSize)});}
function giftCodeCopy(code) {
  const wrapper = el('div', 'gift-copy-line');
  const text = el('span', 'gift-record-code', code);
  text.title = code;
  const button = component('gift-copy-button-template');
  const feedback = el('span', 'sr-only');
  feedback.setAttribute('role', 'status');
  let timer;
  button.onclick = async () => {
    try {
      try {
        if (!navigator.clipboard?.writeText) throw Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(code);
      } catch {
        const input = el('textarea', 'gift-copy-buffer');
        input.value = code;
        input.readOnly = true;
        (button.closest('dialog[open]') ?? document.body).append(input);
        try {
          input.select();
          input.setSelectionRange(0, code.length);
          if (!document.execCommand('copy')) throw Error('Copy failed');
        } finally {
          input.remove();
          button.focus({ preventScroll: true });
        }
      }
      clearTimeout(timer);
      feedback.textContent = '已复制礼包码';
      button.title = '已复制';
      button.dataset.copied = 'true';
      button.querySelector('[data-copy-idle]').hidden = true;
      button.querySelector('[data-copy-success]').hidden = false;
      timer = setTimeout(() => {
        delete button.dataset.copied;
        button.title = '复制礼包码';
        button.querySelector('[data-copy-idle]').hidden = false;
        button.querySelector('[data-copy-success]').hidden = true;
      }, 1500);
    } catch {
      feedback.textContent = '复制失败，请选择礼包码手动复制';
      button.title = feedback.textContent;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };
  wrapper.append(text, button, feedback);
  return wrapper;
}

function paintGiftPage(){
  $('gift-prev').disabled=giftPage<=1;
  $('gift-next').disabled=giftPage>=giftPages;
  $('gift-record-export').disabled=giftExporting || !giftViewed || !giftTotal;
  $('gift-page').textContent=giftPage+' / '+giftPages+' 页，共 '+giftTotal+' 条';
  const body=$('gift-code-history');clear(body);
  for(const row of giftRows){
    const tr=el('tr');
    [row.code,row.channels?.join('、') || '未记录',row.automatic === true ? '自动' : row.automatic === false ? '手动' : '未记录',giftLabels[row.status]||row.status,row.detail,when(row.at)].forEach((value,index)=>{
      const td=el('td','',value);
      td.setAttribute('data-label',['礼包码','渠道','兑换方式','状态','结果','时间'][index]);
      if (index === 0) td.replaceChildren(giftCodeCopy(value));
      tr.append(td);
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
  if(!giftRows.length){const tr=el('tr'),td=el('td','','暂无符合条件的兑换记录');td.colSpan=7;tr.append(td);body.append(tr);}
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
function giftSourceLabel(entry) {
  const entries = entry.sourceDetails ?? (entry.sources ?? []).map(id => ({
    name: ({ ali213: '游侠网', wiki: '疯狂水世界 Wiki' })[id] ?? id,
  }));
  if (entries.length) return entries.map(source =>
    source.name + ' · ' + (source.trigger === 'automatic' ? '自动' : source.trigger === 'manual' ? '手动' : '方式未记录')).join('、');
  return entry.shared ? '共享添加 · 手动' : entry.manual ? '个人添加 · 手动' : '游侠网 · 方式未记录';
}

function paintGiftInitial(){
  const button=$('gift-load-initial'),note=$('gift-code-initial-note');
  button.disabled=giftLoading;
  $('gift-add-row').disabled=!giftSelected.size;
  button.textContent=giftLoading?'正在检查并载入…':'获取最新礼包码';
  if(!giftInitial){note.textContent='点击获取可重新抓取已添加的渠道';return;}
  note.textContent=(giftInitial.dailyTime||'每日更新')+'；公共码 '+giftInitial.total+' 条，所选账号未兑换码 '+giftInitial.available+' 条，已下架过期码 '+giftInitial.expired+' 条；'
    +(giftInitial.lastSyncedAt?'上次同步 '+when(giftInitial.lastSyncedAt):'等待首次同步')+(giftInitial.lastError?'；部分或全部渠道失败，保留失败渠道的上次数据：'+giftInitial.lastError:'');
  const table=clear($('gift-code-library-rows'));
  for(const entry of giftInitial.displayRows??[]){
    if(!entry.eligible&&!entry.usage.some(row=>['queued','sending'].includes(row.status))&&!$('gift-show-processed').checked)continue;
    const usage=entry.usage.map(row=>row.title+'：'+(giftLabels[row.status]||'未兑换')).join('；');
    const counts={};for(const row of entry.usage){const status=giftLabels[row.status]||'未兑换';counts[status]=(counts[status]??0)+1;}
    const status=entry.usage.length===1?(giftLabels[entry.usage[0].status]||'未兑换'):Object.entries(counts).map(([label,count])=>label+' '+count).join(' / ')||'未选择账号';
    const availability=entry.eligible?(entry.usage.some(row=>row.status!=='unused')?'部分账号可用':entry.expiresAt?'未到期':'有效期待确认')
      :entry.usage.some(row=>['queued','sending'].includes(row.status))?'处理中':entry.usage.some(row=>row.status==='unknown')?'待确认，不重发':'已处理，不再兑换';
    const row=el('tr');[entry.code,availability,status,entry.expiresAt||'来源未注明',giftSourceLabel(entry)].forEach((value,index)=>{const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','可用状态','使用状态','到期日期','来源 / 操作'][index]);row.append(cell);});row.children[2].title=usage;row.children[0].replaceChildren(giftCodeCopy(entry.code));if(entry.reward)row.children[0].append(el('small','gift-reward-detail dim',entry.reward));table.append(row);
  }
  if(!table.children.length){const row=el('tr'),cell=el('td','','暂无未兑换码，可点击载入或新增礼包码行');cell.colSpan=5;row.append(cell);table.append(row);}
}
async function refreshGiftInitial(){
  if(giftLoading)return;
  const version=++giftInitialVersion;
  const query=new URLSearchParams({accounts:JSON.stringify([...giftSelected])});
  try{const data=await call('/api/gift-codes/initial?'+query);if(version!==giftInitialVersion)return;giftInitial=data;paintGiftInitial();}
  catch(error){if(version===giftInitialVersion){$('gift-code-initial-note').textContent='公共码库读取失败：'+error.message;$('gift-load-initial').disabled=giftLoading;}}
}
$('gift-load-initial').onclick=async()=>{
  if(giftLoading)return;giftLoading=true;paintGiftInitial();const version=++giftInitialVersion;
  try{const data=await call('/api/gift-codes/load',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected]})});if(version!==giftInitialVersion)return;giftInitial=data;paintGiftFetchReport(data.fetchStats);giftNote=data.lastError?'有渠道获取失败：'+data.lastError:'已载入全部未兑换码，历史已处理和已过期的码默认不显示。';}
  catch(error){giftNote=error.message;}
  finally{giftLoading=false;if(version!==giftInitialVersion)void refreshGiftInitial();paintGiftInitial();paintGiftState();}
};
function paintGiftFetchReport(stats) {
  const box = clear($('gift-fetch-report'));
  box.hidden = !stats;
  if (!stats) return;
  box.append(el('strong', '', '本次获取 ' + stats.fetched + ' 条（去重后） · 新增入库 ' + stats.added + ' 条'));
  for (const channel of stats.channels) {
    box.append(el('p', '', channel.name + '：' + (channel.error ? '获取失败，保留上次数据 · ' + channel.error : '获取 ' + channel.count + ' 条')));
  }
  for (const account of stats.accounts) {
    box.append(el('p', '', account.title + '：已用过 ' + account.used + ' · 未验证 ' + account.unverified + ' · 已拒绝 ' + account.rejected));
  }
  box.append(el('small', 'dim', stats.accounts.length ? '未验证指所选游戏账号尚无明确兑换结果。' : '勾选游戏账号后再次获取，可查看各账号的兑换统计。'));
}

let giftChannelBusy = false;
let giftChannelEditing;
let giftChannelBaseline;
const giftChannelForm = $('gift-channel-form');
const giftChannelDialog = $('gift-channels-dialog');

function giftChannelValues() {
  return { name: $('gift-channel-name').value.trim(), url: $('gift-channel-url').value.trim(), format: $('gift-channel-format').value };
}

function setGiftChannelEditing(editing) {
  giftChannelForm.hidden = !editing;
  $('gift-channel-add').hidden = editing;
  $('gift-channel-save').hidden = $('gift-channel-cancel').hidden = !editing;
}

function mayDiscardGiftChannel() {
  return !giftChannelBusy && (giftChannelForm.hidden || giftChannelBaseline === JSON.stringify(giftChannelValues())
    || confirm('渠道有未保存的修改，确定放弃吗？'));
}

function editGiftChannel(channel) {
  giftChannelEditing = channel?.id;
  $('gift-channel-name').value = channel?.name ?? '';
  $('gift-channel-url').value = channel?.url ?? '';
  $('gift-channel-format').value = channel?.format ?? 'wiki';
  giftChannelBaseline = JSON.stringify(giftChannelValues());
  setGiftChannelEditing(true);
  $('gift-channel-name').focus();
}

async function loadGiftChannels(change) {
  if (giftChannelBusy) return;
  const list = $('gift-channels-list'), status = $('gift-channels-status');
  giftChannelBusy = true;
  list.inert = giftChannelForm.inert = true;
  $('gift-channel-save').disabled = true;
  status.textContent = change ? '正在保存渠道…' : '正在读取渠道…';
  try {
    const data = await call('/api/gift-codes/channels', change ? {
      method: 'POST', body: JSON.stringify({ confirm: true, ...change }),
    } : undefined);
    clear(list);
    for (const channel of data.channels) {
      const row = el('div', 'gift-channel-row');
      const text = el('div', 'gift-channel-address');
      const link = el('a', '', channel.url);
      link.href = channel.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      text.append(el('strong', '', channel.name), link);
      const actions = el('div', 'gift-channel-actions');
      if (channel.fixed) actions.append(el('span', 'dim', '内置 · 固定'));
      else {
        const edit = el('button', 'gift-auto-toggle', '编辑');
        edit.type = 'button';
        edit.onclick = () => { if (mayDiscardGiftChannel()) editGiftChannel(channel); };
        const remove = el('button', 'gift-auto-toggle', '移除');
        remove.type = 'button';
        remove.onclick = () => {
          if (mayDiscardGiftChannel() && confirm('移除「' + channel.name + '」？该渠道独有的礼包码会从公共库移除。')) {
            void loadGiftChannels({ id: channel.id, remove: true });
          }
        };
        actions.append(edit, remove);
      }
      row.append(text, actions);
      list.append(row);
    }
    status.textContent = change ? '渠道已更新，下次抓取时生效。' : '';
    if (change) {
      setGiftChannelEditing(false);
      paintGiftFetchReport(null);
      void refreshGiftInitial();
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    giftChannelBusy = false;
    list.inert = giftChannelForm.inert = false;
    $('gift-channel-save').disabled = false;
  }
}

$('gift-channel-add').onclick = () => { if (!giftChannelBusy) editGiftChannel(); };
$('gift-channel-cancel').onclick = () => {
  if (mayDiscardGiftChannel()) setGiftChannelEditing(false);
};
giftChannelForm.onsubmit = event => {
  event.preventDefault();
  const fields = giftChannelValues();
  const name = $('gift-channel-name');
  const url = $('gift-channel-url');
  name.setCustomValidity(fields.name ? '' : '请填写渠道名称');
  url.setCustomValidity(fields.url.startsWith('https://') ? '' : '请填写公开 HTTPS 网址');
  if (!giftChannelForm.reportValidity()) return;
  void loadGiftChannels({ id: giftChannelEditing, ...fields });
};
for (const id of ['gift-channel-name', 'gift-channel-url']) {
  $(id).addEventListener('input', event => event.target.setCustomValidity(''));
}
$('gift-channels-open').onclick = () => {
  setGiftChannelEditing(false);
  giftChannelDialog.showModal();
  void loadGiftChannels();
};
$('gift-channels-close').onclick = () => { if (mayDiscardGiftChannel()) giftChannelDialog.close(); };
giftChannelDialog.oncancel = event => { if (!mayDiscardGiftChannel()) event.preventDefault(); };
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
batchDialog.oncancel=event=>{event.preventDefault();if(!batchSave.disabled)batchDialog.close();};
$('gift-batch-add').onclick=()=>{
  batchInput.value='';batchExpiry.value='';batchMessage.textContent='';
  batchHint.textContent='本批礼包码全部账号共享，已兑换的账号会自动跳过；到期日期留空表示未注明。';
  batchDialog.showModal();batchInput.focus();
};
batchSave.onclick=async()=>{
  const codes=[...new Set(batchInput.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean))];
  if(!codes.length){batchMessage.textContent='请至少输入一条礼包码';return;}
  batchSave.disabled=batchCancel.disabled=batchInput.disabled=batchExpiry.disabled=true;
  try{
    const result=await call('/api/gift-codes/shared',{method:'POST',body:JSON.stringify({confirm:true,codes,expiresAt:batchExpiry.value||null})});
    batchDialog.close();
    giftNote='批量保存 '+result.codes+' 条礼包码，全部账号共享，已兑换的账号会自动跳过';
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
  paintGiftFetchReport(null);
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

const giftFetchDialog = $('gift-fetch-history-dialog');
let giftFetchHistoryRequest = 0;
function giftFetchCardField(label, value, expandable = false) {
  const field = el('div', 'gift-fetch-field');
  field.append(el('dt', '', label));
  const content = el('dd');
  if (label === '到期时间') content.classList.add('gift-fetch-date');
  if (expandable) {
    const details = el('details', 'gift-fetch-expand');
    details.append(el('summary', '', value));
    content.append(details);
  } else content.textContent = value;
  field.append(content);
  return field;
}

async function showGiftFetchHistory(id) {
  const request = ++giftFetchHistoryRequest;
  const body = clear($('gift-fetch-history-body'));
  const status = $('gift-fetch-history-status');
  $('gift-fetch-history-title').textContent = id ? '批次礼包码详情' : '礼包码抓取日志';
  $('gift-fetch-history-back').hidden = !id;
  status.textContent = '正在读取…';
  try {
    const data = await call('/api/gift-codes/fetch-history' + (id ? '?' + new URLSearchParams({ id, accounts: JSON.stringify(giftSelected.size ? [...giftSelected] : giftViewed ? [giftViewed] : []) }) : ''));
    if (!giftFetchDialog.open || request !== giftFetchHistoryRequest) return;
    if (!id) {
      status.textContent = data.batches.length ? '最近 ' + data.batches.length + ' 个抓取批次' : '暂无抓取记录';
      const list = el('div', 'gift-fetch-card-grid');
      for (const batch of data.batches) {
        const card = el('article', 'gift-fetch-card');
        const heading = el('div', 'gift-fetch-card-heading');
        heading.append(el('strong', '', when(batch.at)), el('span', 'gift-fetch-badge', batch.trigger === 'automatic' ? '自动' : '手动'));
        const fields = el('dl');
        fields.append(giftFetchCardField('获取', batch.fetched + ' 条'), giftFetchCardField('新增', batch.added + ' 条'),
          giftFetchCardField('结果', batch.channels.some(channel => channel.error) ? '有渠道失败' : '完成'));
        const button = el('button', 'gift-auto-toggle', '查看详情');
        button.type = 'button';
        button.onclick = () => void showGiftFetchHistory(batch.id);
        card.append(heading, fields, button);
        list.append(card);
      }
      body.append(list);
      return;
    }
    status.textContent = when(data.at) + (data.trigger === 'automatic' ? ' · 自动' : ' · 手动') + ' · 去重后获取 ' + data.fetched + ' 条 · 新增 ' + data.added + ' 条';
    for (const channel of data.channels) body.append(el('p', 'dim',
      channel.name + '：' + (channel.error ? '获取失败 · ' + channel.error : '获取 ' + channel.count + ' 条')));
    if (!data.rows.length) {
      body.append(el('p', 'dim', '该批次没有可入库的礼包码。'));
      return;
    }
    const list = el('div', 'gift-fetch-card-grid');
    for (const row of data.rows) {
      const card = el('article', 'gift-fetch-card');
      const heading = el('div', 'gift-fetch-card-heading');
      const statuses = new Set(row.usage.map(entry => entry.status));
      const availability = !row.usage.length || !statuses.size || row.availability !== '待游戏验证'
        ? row.availability
        : statuses.size === 1 && !statuses.has('unused')
          ? (giftLabels[row.usage[0].status] ?? row.availability)
          : statuses.size > 1 ? '各账号状态不同' : row.availability;
      heading.append(giftCodeCopy(row.code), el('span', 'gift-fetch-badge', availability));
      const fields = el('dl');
      fields.append(
        giftFetchCardField('到期时间', row.expiresAtMs == null ? row.expiresAt || '未注明' : when(row.expiresAtMs)),
        giftFetchCardField('礼包内容', row.reward || '未注明', Boolean(row.reward)),
        giftFetchCardField('来源', giftSourceLabel(row), true),
      );
      for (const entry of row.usage) {
        const label = entry.status === 'unused' ? '未兑换' : giftLabels[entry.status] ?? entry.status;
        const detail = entry.detail && ['rejected', 'unknown'].includes(entry.status) ? ' · ' + entry.detail : '';
        fields.append(giftFetchCardField('账号状态', entry.title + '：' + label + detail, true));
      }
      card.append(heading, fields);
      list.append(card);
    }
    body.append(list);
  } catch (error) {
    if (giftFetchDialog.open && request === giftFetchHistoryRequest) status.textContent = error.message;
  }
}
$('gift-fetch-history-open').onclick = () => { giftFetchDialog.showModal(); void showGiftFetchHistory(); };
$('gift-fetch-history-back').onclick = () => void showGiftFetchHistory();
$('gift-fetch-history-dismiss').onclick = () => giftFetchDialog.close();
