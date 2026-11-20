// 添加账号弹窗统一管理渠道切换和临时登录会话的收尾。
// 其他登录脚本的首次渲染发生在本脚本初始化前。
var accountAddState = null;

function accountAddChannel() {
  return accountAddState && $('account-add-dialog').open ? accountAddState.channel : null;
}

function accountAddChanged(channel, phase, { busy = false, account = null } = {}) {
  if (!accountAddState || !accountAddChannel() || accountAddState.channel !== channel) return;
  if (!accountAddState.cleaning && (phase !== accountAddState.phase || busy !== accountAddState.busy)) accountAddState.feedback = '';
  Object.assign(accountAddState, { phase, busy, account });
  renderAccountAdd();
}

function renderAccountAdd() {
  const state = accountAddState;
  if (!state) return;
  const names = { alipay: '支付宝扫码登录', phone: 'APP 账号登录', wechat:'微信扫码登录', 'douyin-qr':'抖音扫码登录' };
  const channel = state.channel;
  const completed = state.phase === 'saved';
  const locked = state.busy || state.cleaning;
  $('account-add-title').textContent = channel ? names[channel] : '添加账号';
  $('account-add-step').textContent = !channel ? '选择登录渠道' : completed ? '添加完成'
    : (channel === 'phone' && state.phase === 'selecting') || (['alipay','wechat','douyin-qr'].includes(channel) && state.phase === 'captured') ? '选择区服和角色'
      : '登录验证';
  $('account-add-channels').hidden = Boolean(channel);
  $('account-add-alipay').hidden = channel !== 'alipay';
  $('account-add-douyin').hidden = channel !== 'douyin-qr';
  $('account-add-phone').hidden = channel !== 'phone';
  $('account-add-wechat').hidden = channel !== 'wechat';
  $('account-add-back').hidden = !channel;
  $('account-add-back').textContent = completed ? '继续添加账号' : '返回选择渠道';
  $('account-add-back').disabled = locked;
  $('account-add-close').disabled = locked;
  $('account-add-done').hidden = !completed;
  $('account-add-done').disabled = locked;
  $('account-add-dialog').setAttribute('aria-busy', String(locked));
  const feedback = $('account-add-feedback');
  feedback.textContent = state.cleaning ? '正在结束本次登录并清理临时会话…' : state.feedback;
  feedback.className = 'phone-feedback ' + (state.feedback && !locked ? 'bad' : 'dim');
}

async function leaveAccountAdd(close) {
  const dialog = $('account-add-dialog');
  if (!dialog.open || !accountAddState) return false;
  const state = accountAddState;
  if (state.busy || state.cleaning) {
    if (state.busy) state.feedback = '当前请求正在处理，完成后即可返回或关闭。';
    renderAccountAdd();
    return false;
  }
  state.cleaning = true;
  state.feedback = '';
  renderAccountAdd();
  try {
    let cleared = true;
    if (state.channel === 'alipay') cleared = await resetAlipayLogin();
    else if (state.channel === 'douyin-qr') cleared = await resetDouyinLogin();
    else if (state.channel === 'phone') cleared = await resetPhoneLogin();
    else if (state.channel === 'wechat') cleared = await resetWechatLogin();
    if (cleared === false) {
      state.feedback = '登录请求正在处理中，请稍候再返回或关闭。';
      return false;
    }
    Object.assign(state, { channel: null, phase: 'entry', busy: false, account: null });
    if (close) {
      dialog.close();
      $('account-add').focus();
    } else {
      renderAccountAdd();
      document.querySelector('#account-add-channels [data-login-channel]')?.focus();
    }
    return true;
  } catch (error) {
    state.feedback = error.message || '临时登录会话尚未结束，请重试。';
    return false;
  } finally {
    state.cleaning = false;
    renderAccountAdd();
  }
}

accountAddState = { channel: null, phase: 'entry', busy: false, cleaning: false, feedback: '', account: null };
$('account-add').onclick = () => {
  const dialog = $('account-add-dialog');
  if (dialog.open) return;
  renderAccountAdd();
  dialog.showModal();
  document.querySelector('#account-add-channels [data-login-channel]')?.focus();
};
for (const button of document.querySelectorAll('#account-add-channels [data-login-channel]')) {
  button.onclick = () => {
    if (!$('account-add-dialog').open || accountAddState.channel || accountAddState.cleaning) return;
    const channel = button.dataset.loginChannel;
    if (!['alipay', 'phone', 'wechat', 'douyin-qr'].includes(channel)) return;
    Object.assign(accountAddState, { channel, phase: 'entry', busy: false, account: null, feedback: '' });
    renderAccountAdd();
    const target = { alipay: 'alipay-start', phone: 'phone-account', wechat:'wechat-start', 'douyin-qr':'douyin-start' };
    $(target[channel]).focus();
    if (channel === 'phone') void refreshPhoneDevice();
  };
}
$('account-add-close').onclick = () => leaveAccountAdd(true);
$('account-add-back').onclick = () => leaveAccountAdd(false);
$('account-add-done').onclick = () => leaveAccountAdd(true);
$('account-add-dialog').oncancel = event => {
  event.preventDefault();
  void leaveAccountAdd(true);
};

for (const channel of ['alipay', 'phone', 'wechat']) {
  $('account-add-' + channel + '-shortcut').onclick = () => {
    if ($('account-add-dialog').open) return;
    $('account-add').onclick();
    for (const button of document.querySelectorAll('#account-add-channels [data-login-channel]')) {
      if (button.dataset.loginChannel === channel) button.onclick();
    }
    if (channel === 'alipay') void $('alipay-start').onclick();
  };
}
