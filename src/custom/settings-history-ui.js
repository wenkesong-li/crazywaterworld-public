const historyDialog = $('config-history-dialog');
const historyStatus = $('config-history-status');
const historyBody = $('config-history-body');
const historyActions = $('config-history-actions');
let historyOwner;
let historySerial;
let historyWorking = false;

function historyActive() {
  return historyDialog.open && historyOwner === current && historyOwner === configEditor.owner
    && historySerial === configEditor.serial && !configPageStale();
}

function historyButton(label, action, primary = false) {
  const button = el('button', primary ? 'history-action primary' : 'history-action', label);
  button.type = 'button';
  button.onclick = action;
  return button;
}

function historyScreen(title, message = '') {
  $('config-history-title').textContent = title;
  historyStatus.textContent = message;
  clear(historyBody);
  clear(historyActions).append(historyButton('关闭', () => { if (!historyWorking) historyDialog.close(); }));
}

async function historyWork(work) {
  if (historyWorking || !historyActive()) return;
  historyWorking = true;
  historyDialog.setAttribute('aria-busy', 'true');
  try { await work(); }
  catch (error) { if (historyActive()) historyStatus.textContent = error.message; }
  finally {
    historyWorking = false;
    historyDialog.removeAttribute('aria-busy');
  }
}

function historyOpen(screen) {
  if (!current || !configEditor.draft || configEditor.owner !== current || configEditor.busy) return;
  historyOwner = current;
  historySerial = configEditor.serial;
  configCancelSaveTimer();
  configBusy(true);
  configUpdateState();
  historyDialog.showModal();
  screen();
}

historyDialog.oncancel = event => { if (historyWorking) event.preventDefault(); };
historyDialog.onclose = () => {
  if (historyOwner === configEditor.owner && historySerial === configEditor.serial) {
    configBusy(false);
    configUpdateState();
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

async function saveHistory(name, settings, draft = false) {
  return call('/api/settings/history', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, name, settings, draft }),
  });
}

function historySaveScreen() {
  historyScreen('保存当前配置', '为当前游戏账号保存命名快照。每个账号保留最近 50 条，包含恢复前的历史草稿。');
  const name = historyName('配置名称');
  name.placeholder = '例如：日常挂机';
  historyActions.append(historyButton('保存', () => historyWork(async () => {
    if (!name.value.trim()) { name.focus(); throw Error('请输入配置名称'); }
    await saveHistory(name.value, configEditor.draft);
    if (historyActive()) historyScreen('配置已保存', '已保存「' + name.value.trim() + '」。');
  }), true));
  name.focus();
}

function historyList() {
  historyScreen('历史配置', '只显示当前游戏账号的历史记录。');
  void historyWork(async () => {
    const { entries } = await call('/api/settings/history');
    if (!historyActive()) return;
    if (!entries.length) historyBody.append(el('p', 'dim', '还没有保存过配置。'));
    for (const entry of entries) {
      const row = el('div', 'history-record');
      const text = el('div');
      text.append(el('strong', '', entry.name), el('small', '', when(entry.at) + (entry.draft ? ' · 历史草稿' : ' · 配置快照')));
      row.append(text, historyButton('查看与恢复', () => historyWork(() => historyPreview(entry.id))));
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

async function historyPreview(id) {
  const record = await call('/api/settings/history?id=' + encodeURIComponent(id));
  if (!historyActive()) return;
  const original = configEditor.draft;
  // Show differences even when an incomplete historical draft cannot yet pass validation.
  const target = record.document.settings;
  const comparisonTarget = record.draft ? target : (await call('/api/settings/validate', {
    method: 'POST',
    body: JSON.stringify({ document: record.document }),
  })).settings;
  if (!historyActive()) return;
  const changes = historyDifferences(original, comparisonTarget);
  historyScreen(record.name, changes.length ? '以下项目与当前配置不同，请核对恢复后要覆盖的内容。' : '这条记录与当前配置相同。');
  const full = el('details', 'history-full');
  full.append(el('summary', '', '查看完整配置'), el('pre', '', JSON.stringify(comparisonTarget, null, 2)));
  historyBody.append(full);
  if (!changes.length) return;
  const comparison = el('div', 'history-differences');
  for (const change of changes) {
    const row = el('div', 'history-change');
    row.append(el('strong', '', configEditor.fields.get(change.key)?.label || change.key),
      el('p', '', '当前：' + historyValue(change.before)),
      el('p', '', '恢复后：' + historyValue(change.after)));
    comparison.append(row);
  }
  historyBody.prepend(comparison);
  historyActions.append(historyButton('继续恢复', () => {
    historyScreen('恢复前保存草稿？', '恢复将覆盖当前配置。你可以先把当前配置保存为历史草稿。');
    const name = historyName('草稿名称', '恢复前草稿 ' + new Date().toLocaleString('zh-CN'));
    const restore = backup => historyWork(async () => {
      if (backup && !name.value.trim()) { name.focus(); throw Error('请输入草稿名称'); }
      const payload = record.draft ? { settings: target } : { document: record.document };
      const validated = await call('/api/settings/validate', { method: 'POST', body: JSON.stringify(payload) });
      if (!historyActive() || configEditor.draft !== original) throw Error('当前配置已变化，请重新核对差异');
      if (backup) await saveHistory(name.value, original, true);
      if (!historyActive() || configEditor.draft !== original) throw Error('当前配置已变化，请重新核对差异');
      configEditor.draft = validated.settings;
      configRender();
      configBusy(false);
      if (!await configSave(null, { automatic: true })) {
        if (historyActive()) {
          configCancelSaveTimer();
          const message = configEditor.saveError?.message || '请重新载入配置后重试';
          configEditor.draft = original;
          configRender();
          configBusy(true);
          throw Error('恢复未保存：' + message);
        }
        return;
      }
      if (historyActive()) {
        configBusy(true);
        historyScreen('配置已恢复', backup ? '原配置已保存为历史草稿。' : '已应用所选历史配置。');
      }
    });
    historyActions.append(historyButton('直接恢复', () => restore(false)),
      historyButton('保存草稿并恢复', () => restore(true), true));
  }, true));
}

$('config-history-save').onclick = () => historyOpen(historySaveScreen);
$('config-history-open').onclick = () => historyOpen(historyList);
