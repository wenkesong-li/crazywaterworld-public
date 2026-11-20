const historyDialog = $('config-history-dialog');
const historyStatus = $('config-history-status');
const historyBody = $('config-history-body');
const historyActions = $('config-history-actions');
let historySession;

function historyActive(session) {
  return historyDialog.open && session === historySession && session.owner === current
    && session.owner === configEditor.owner && session.serial === configEditor.serial;
}

function historyButton(label, action, primary = false) {
  const button = el('button', primary ? 'history-action primary' : 'history-action', label);
  button.type = 'button';
  button.onclick = () => { if (!historySession?.working) action(); };
  return button;
}

function historyScreen(title, message = '') {
  $('config-history-title').textContent = title;
  historyStatus.textContent = message;
  clear(historyBody);
  clear(historyActions).append(historyButton('关闭', () => historyDialog.close()));
}

async function historyWork(work) {
  const session = historySession;
  if (!session || session.working || !historyActive(session)) return;
  session.working = true;
  historyDialog.setAttribute('aria-busy', 'true');
  try {
    if (configPageStale() || configEditor.recoveryBlocked) throw Error('配置已变化，请关闭历史窗口并重新载入。');
    await work(session);
  } catch (error) {
    if (historyActive(session)) historyStatus.textContent = error.message;
  } finally {
    session.working = false;
    if (session === historySession) historyDialog.removeAttribute('aria-busy');
  }
}

function historyOpen(screen) {
  if (!current || !configEditor.draft || configEditor.owner !== current || configEditor.busy
    || configEditor.loading || configEditor.recoveryBlocked || configPageStale()) return;
  historySession = { owner: current, serial: configEditor.serial, working: false };
  configCancelSaveTimer();
  configBusy(true);
  configUpdateState();
  historyDialog.showModal();
  screen();
}

historyDialog.oncancel = event => { if (historySession?.working) event.preventDefault(); };
historyDialog.onclose = () => {
  if (historyDialog.open) return;
  const session = historySession;
  historySession = null;
  historyDialog.removeAttribute('aria-busy');
  if (session && session.owner === configEditor.owner && session.serial === configEditor.serial) {
    configBusy(false);
    configUpdateState();
    if (session.editError && configEditor.saveError === session.editError) configErrors(session.editError);
  }
};

function historyName(label, value = '') {
  const field = el('label', 'history-name', label);
  const input = el('input');
  input.type = 'text';
  input.maxLength = 80;
  input.value = value;
  field.append(input);
  historyBody.append(field);
  return input;
}

function historyUrl(session) {
  return '/api/settings/history?account=' + encodeURIComponent(session.owner);
}

function saveHistory(session, name, settings, draft = false) {
  return call(historyUrl(session), {
    method: 'POST',
    body: JSON.stringify({ confirm: true, name, settings, draft }),
  });
}

function historySaveScreen() {
  historyScreen('保存配置快照', '为当前游戏账号保存命名快照。每个账号保留最近 50 条，包含恢复前的历史草稿。');
  const name = historyName('配置名称');
  name.placeholder = '例如：日常挂机';
  historyActions.append(historyButton('保存', () => historyWork(async session => {
    const title = name.value.trim();
    if (!title) { name.focus(); throw Error('请输入配置名称'); }
    await saveHistory(session, title, configEditor.draft);
    if (historyActive(session)) historyScreen('快照已保存', '已保存「' + title + '」。');
  }), true));
  name.focus();
}

function historyList() {
  historyScreen('历史配置', '只显示当前游戏账号的历史记录。');
  void historyWork(async session => {
    const { entries } = await call(historyUrl(session));
    if (!historyActive(session)) return;
    if (!entries.length) historyBody.append(el('p', 'dim', '还没有保存过配置。'));
    for (const entry of entries) {
      const row = el('div', 'history-record');
      const text = el('div');
      text.append(el('strong', '', entry.name), el('small', '', when(entry.at) + (entry.draft ? ' · 历史草稿' : ' · 配置快照')));
      row.append(text, historyButton('查看与恢复', () => historyWork(session => historyPreview(session, entry.id))));
      historyBody.append(row);
    }
  });
}

function historyDifferences(before, after, prefix = '', rows = []) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (object(before) && object(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      historyDifferences(before[key], after[key], prefix ? prefix + '.' + key : key, rows);
    }
  } else if (JSON.stringify(before) !== JSON.stringify(after)) rows.push({ key: prefix, before, after });
  return rows;
}

function historyValue(value) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value == null || value === '') return '未设置';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

async function historyPreview(session, id) {
  const record = await call(historyUrl(session) + '&id=' + encodeURIComponent(id));
  if (!historyActive(session)) return;
  const original = configEditor.draft;
  const comparisonTarget = record.settings;
  const changes = historyDifferences(original, comparisonTarget);
  historyScreen(record.name, changes.length ? '以下项目与当前配置不同，请核对恢复后要覆盖的内容。' : '这条记录与当前配置相同。');
  historyActions.append(historyButton('返回列表', historyList));
  const full = el('details', 'history-full');
  full.append(el('summary', '', '查看完整配置'), el('pre', '', JSON.stringify(comparisonTarget, null, 2)));
  historyBody.append(full);
  if (!changes.length) return;
  const comparison = el('div', 'history-differences');
  for (const change of changes) {
    const row = el('div', 'history-change');
    const field = configEditor.fields.get(change.key);
    const group = configEditor.groups.get(field?.groupId);
    row.append(el('strong', '', group ? group.title + ' · ' + field.label : field?.label || change.key),
      el('p', '', '当前：' + historyValue(change.before)),
      el('p', '', '恢复后：' + historyValue(change.after)));
    comparison.append(row);
  }
  historyBody.prepend(comparison);
  historyActions.append(historyButton(record.errors ? '取回并编辑' : '继续恢复',
    () => historyRestoreScreen(session, record, original), true));
}

function historyRestoreScreen(session, record, original) {
  historyScreen('恢复前保存草稿？', record.errors
    ? '这份草稿还有待修正的字段。取回后请在配置页补齐，校验通过后才会生效。'
    : '应用后会自动保存整份配置。你可以先保留当前草稿。');
  const name = historyName('草稿名称', '恢复前草稿 ' + new Date().toLocaleString('zh-CN'));
  const restore = backup => historyWork(async () => {
    const check = () => {
      if (!historyActive(session) || configPageStale() || configEditor.recoveryBlocked
        || configEditor.draft !== original) throw Error('当前配置已变化，请重新核对差异。');
      if (configEditor.saveError?.fields?.revision) throw Error('配置已在其他页面更新，请重新载入后核对差异。');
    };
    check();
    if (backup) {
      if (!name.value.trim()) { name.focus(); throw Error('请输入草稿名称'); }
      await saveHistory(session, name.value, original, true);
      check();
    }
    // 历史草稿可能含未填完的数字或无效的组合。先恢复表单，再由原有校验和版本检查控制保存。
    configEditor.draft = record.settings;
    configEditor.previewSummary = null;
    try {
      configRender();
    } catch (error) {
      configEditor.draft = original;
      configRender();
      throw Error('无法在当前版本编辑这份历史配置：' + error.message);
    }
    configClearErrors();
    configEditor.saveRetries = 0;
    configEditor.saveError = record.errors ? { fields: record.errors, message: '已取回草稿，请修正标出的配置。' } : null;
    if (record.errors) session.editError = configEditor.saveError;
    else configMessage('');
    historyDialog.close();
  });
  historyActions.append(historyButton(record.errors ? '直接取回' : '直接恢复', () => restore(false)),
    historyButton(record.errors ? '保存草稿并取回' : '保存草稿并恢复', () => restore(true), true));
}

$('config-history-save').onclick = () => historyOpen(historySaveScreen);
$('config-history-open').onclick = () => historyOpen(historyList);
