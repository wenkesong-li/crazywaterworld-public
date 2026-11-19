const enableAllDialog = $('config-enable-all-dialog');
const enableAllRun = $('config-enable-all-run');
const enableAllClose = $('config-enable-all-close');
const enableAllSummary = $('config-enable-all-summary');
let finishSpendingConfirmation;
const enableAllResults = $('config-enable-all-results');

function renderSpendingChoices(keys, switches) {
  const sections = new Map();
  const choices = new Map();
  const displayed = new Set(keys);
  for (const key of keys) {
    let parent = switches.get(key)?.spec.parent;
    while (parent && switches.has(parent) && !displayed.has(parent)) {
      displayed.add(parent);
      parent = switches.get(parent).spec.parent;
    }
  }
  for (const [key, { group, spec }] of switches) {
    if (!displayed.has(key)) continue;
    if (!sections.has(group.id)) {
      const section = el('li', 'config-enable-group spending');
      const list = el('ul');
      section.append(el('h3', '', group.title), list);
      sections.set(group.id, list);
      enableAllResults.append(section);
    }
    const row = el('li');
    if (spec.parent && displayed.has(spec.parent)) row.classList.add('config-spending-child');
    const label = el('label', 'config-spending-choice');
    const input = el('input');
    input.type = 'checkbox';
    const alreadyEnabled = configSwitchValue(spec);
    input.checked = alreadyEnabled;
    input.disabled = alreadyEnabled || !keys.includes(key);
    const text = el('span');
    text.append(el('strong', '', spec.label + (alreadyEnabled ? '（已开启）' : '')));
    if (spec.help) text.append(el('small', '', spec.help));
    label.append(input, text);
    row.append(label);
    sections.get(group.id).append(row);
    if (keys.includes(key) && !alreadyEnabled) choices.set(key, input);
  }
  return choices;
}

$('config-enable-all').onclick = () => {
  enableAllSummary.textContent = '开启当前账号可用的挂机开关，按现有配置校验。无法开启的项目会跳过并列出原因。消耗类开关需要再次确认。派遣沿用已保存的舰队和优先策略。';
  clear(enableAllResults);
  enableAllRun.textContent = '确认开启';
  enableAllRun.hidden = false;
  enableAllRun.disabled = false;
  enableAllClose.textContent = '取消';
  enableAllDialog.showModal();
};
enableAllClose.onclick = () => {
  if (finishSpendingConfirmation) finishSpendingConfirmation(false);
  else enableAllDialog.close();
};
enableAllDialog.addEventListener('close', () => finishSpendingConfirmation?.(null));
enableAllDialog.oncancel = event => { if (enableAllClose.disabled) event.preventDefault(); };
enableAllRun.onclick = async () => {
  if (finishSpendingConfirmation) {
    finishSpendingConfirmation(true);
    return;
  }
  const owner = current;
  if (!owner || configEditor.owner !== owner || configEditor.busy || configEditor.recoveryBlocked) return;
  const serial = configEditor.serial;
  const sameEditor = () => owner === current && owner === configEditor.owner && serial === configEditor.serial;
  const active = () => sameEditor() && !configPageStale();
  const original = configEditor.draft;
  const labels = new Map();
  const switches = new Map();
  const spendingKeys = new Set();
  for (const group of configEditor.groups.values()) {
    for (const spec of group.fields) {
      if (spec.kind !== 'switch' || switches.has(spec.key)) continue;
      const paths = spec.controlFields ?? [spec.key];
      switches.set(spec.key, { group, spec, paths });
      labels.set(spec.key, group.title + ' · ' + spec.label);
      const description = (spec.label + ' ' + (spec.help ?? '')).replace(/(?:不|无需|不会|不自动)(?:额外)?(?:消耗|花费|花|使用|购买)[^，。；、]*/g, '');
      if (/消耗|花费|预算|付费|加速器|钻石|交付|锻造|喂养/.test(description)
        || paths.some(path => /allow|paid|spend|speedUp|upgrade|craft|breed|reroll|recruit|(?:^|\.)feed/i.test(path))) spendingKeys.add(spec.key);
    }
  }
  // Keep the current form's parent and child switches together in the confirmation.
  let changed;
  do {
    changed = false;
    for (const [key, { spec }] of switches) {
      if (spendingKeys.has(spec.parent) && !spendingKeys.has(key)) {
        spendingKeys.add(key);
        changed = true;
      }
    }
  } while (changed);
  for (const key of [...spendingKeys]) {
    let parent = switches.get(key)?.spec.parent;
    while (parent && switches.has(parent) && !spendingKeys.has(parent)) {
      spendingKeys.add(parent);
      parent = switches.get(parent).spec.parent;
    }
  }
  const candidates = [...switches].filter(([, { spec }]) => !configSwitchValue(spec))
    .map(([key, { paths }]) => ({ key, paths, spending: spendingKeys.has(key) }));
  enableAllRun.disabled = enableAllClose.disabled = true;
  enableAllSummary.textContent = '正在校验各项功能…';
  configCancelSaveTimer();
  configBusy(true);
  configUpdateState();
  try {
    let result = await call('/api/settings/validate', {
      method: 'POST',
      body: JSON.stringify({ settings: original, enableAll: candidates }),
    });
    if (!active()) throw Error('账号或页面版本已变化，请重新打开配置');
    if (result.spending.length) {
      enableAllSummary.textContent = '请逐项选择要开启的消耗开关。新增项默认不勾选，已开启的项目保持原设置。';
      const choices = renderSpendingChoices(result.spending, switches);
      enableAllRun.textContent = '开启所选项';
      enableAllClose.textContent = '跳过消耗项';
      enableAllRun.disabled = enableAllClose.disabled = false;
      const confirmed = await new Promise(resolve => {
        finishSpendingConfirmation = value => {
          finishSpendingConfirmation = null;
          resolve(value);
        };
      });
      clear(enableAllResults);
      if (confirmed === null) return;
      if (!active()) throw Error('账号或页面版本已变化，请重新打开配置');
      enableAllRun.disabled = enableAllClose.disabled = true;
      const selected = new Set(confirmed ? [...choices].filter(([, input]) => input.checked).map(([key]) => key) : []);
      result.skipped.push(...result.spending.filter(key => !selected.has(key))
        .map(key => ({ key, reason: '二次确认时未勾选' })));
      for (const key of [...selected]) {
        let parent = switches.get(key)?.spec.parent;
        const seen = new Set([key]);
        while (parent && switches.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          const parentSpec = switches.get(parent).spec;
          if (choices.has(parent) && !choices.get(parent).checked) {
            selected.delete(key);
            result.skipped.push({ key, reason: '请同时选择上级开关：' + parentSpec.label });
            break;
          }
          parent = parentSpec.parent;
        }
      }
      if (selected.size) {
        const extra = await call('/api/settings/validate', {
          method: 'POST',
          body: JSON.stringify({ settings: result.settings, enableAll: candidates.filter(item => selected.has(item.key)), confirmSpending: true }),
        });
        result = { settings: extra.settings, enabled: [...result.enabled, ...extra.enabled], skipped: [...result.skipped, ...extra.skipped] };
      }
    }
    if (!active()) throw Error('账号或页面版本已变化，请重新打开配置');
    if (result.enabled.length) {
      configEditor.draft = result.settings;
      configRender();
      configBusy(false);
      if (!await configSave(null, { automatic: true })) {
        const reason = configEditor.saveError?.message || '请检查配置并重试';
        if (active()) {
          configCancelSaveTimer();
          configEditor.draft = original;
          configRender();
        }
        throw Error('本次批量开启未保存：' + reason);
      }
    }
    enableAllSummary.textContent = result.enabled.length || result.skipped.length
      ? '已开启 ' + result.enabled.length + ' 项，跳过 ' + result.skipped.length + ' 项。'
      : '可用功能已经开启。';
    for (const [title, state, items] of [
      ['开启成功', 'success', result.enabled.map(key => ({ key }))],
      ['未开启', 'skipped', result.skipped],
    ]) {
      if (!items.length) continue;
      const section = el('li', 'config-enable-group ' + state);
      section.append(el('h3', '', title + '（' + items.length + '）'));
      const list = el('ul');
      for (const item of items) {
        const row = el('li');
        row.append(el('strong', '', labels.get(item.key) || item.key));
        if (item.reason) row.append(el('p', '', item.reason));
        list.append(row);
      }
      section.append(list);
      enableAllResults.append(section);
    }
  } catch (error) {
    enableAllSummary.textContent = error.message;
  } finally {
    if (sameEditor()) {
      configBusy(false);
      configUpdateState();
    }
    enableAllClose.disabled = false;
    enableAllClose.textContent = '关闭';
    enableAllRun.hidden = true;
    enableAllClose.focus();
  }
};
