import { SettingsError, validateSettings } from '../automation-settings.mjs';

function locate(settings, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(key)) return null;
  const parts = key.split('.');
  const field = parts.pop();
  const target = parts.reduce((node, part) => node && Object.hasOwn(node, part) ? node[part] : null, settings);
  return target && Object.hasOwn(target, field) ? { target, field } : null;
}

export function previewEnableAll(input, candidates, options, confirmSpending = false) {
  if (!Array.isArray(candidates) || candidates.length > 300) throw Error('批量开关列表无效');
  let settings = validateSettings(input, options);
  const enabled = [];
  const skipped = [];
  const spending = [];
  for (const item of candidates) {
    if (!item || typeof item.key !== 'string' || !Array.isArray(item.paths) || !item.paths.length || item.paths.length > 30) {
      throw Error('批量开关列表无效');
    }
    const draft = structuredClone(settings);
    const targets = item.paths.map(path => locate(draft, path));
    if (targets.some(entry => !entry || typeof entry.target[entry.field] !== 'boolean')) {
      skipped.push({ key: item.key, reason: '当前版本没有可开启的对应开关' });
      continue;
    }
    if (targets.every(({ target, field }) => target[field])) continue;
    if (!confirmSpending && (item.spending === true || item.paths.some(path => /allow|paid|spend|speedUp|upgrade|craft|breed|reroll|recruit|(?:^|\.)feed/i.test(path)))) {
      spending.push(item.key);
      continue;
    }
    for (const { target, field } of targets) target[field] = true;
    try {
      settings = validateSettings(draft, options);
      enabled.push(item.key);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      skipped.push({ key: item.key, reason: [...new Set(Object.values(error.fields))].join('\n') });
    }
  }
  return { settings, enabled, skipped, spending };
}
