import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION, SettingsError, importAutomationSettings, migrateSettingsVersion, validateSettings } from './automation-settings.mjs';

export function createSettingsHistory(directory) {
  function fileFor(accountId) {
    // Windows 文件名不区分大小写，游戏账号标识区分。
    const key = createHash('sha256').update(accountId).digest('hex');
    return path.join(directory, 'settings-history', key + '.json');
  }

  function read(file) {
    const data = readJson(file, { version: 1, entries: [] });
    if (data?.version !== 1 || !Array.isArray(data.entries)) throw Error('配置历史文件无法读取');
    return data;
  }

  return {
    list(accountId) {
      return read(fileFor(accountId)).entries.map(({ id, name, at, draft }) => ({ id, name, at, draft }));
    },
    preview(accountId, id, options) {
      const entry = read(fileFor(accountId)).entries.find(row => row.id === id);
      if (!entry) throw Error('当前游戏账号没有这条配置记录');
      const { name, draft, document } = entry;
      if (!draft) return { name, draft, settings: importAutomationSettings(document, options) };
      const settings = migrateSettingsVersion(document.settings, document.version ?? SETTINGS_SCHEMA_VERSION);
      try {
        return { name, draft, settings: validateSettings(settings, options) };
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error;
        return { name, draft, settings, errors: error.fields };
      }
    },
    save(accountId, name, settings, { draft = false, catalog } = {}) {
      const title = typeof name === 'string' ? name.trim() : '';
      if (!title || title.length > 80) throw Error('请输入 1 至 80 字的配置名称');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('配置必须是对象');
      const document = { format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION,
        settings: draft ? settings : validateSettings(settings, { catalog }) };
      const file = fileFor(accountId);
      return withFileLock(file, () => {
        const data = read(file);
        const entry = { id: randomUUID(), name: title, at: new Date().toISOString(), draft, document };
        data.entries = [entry, ...data.entries].slice(0, 50);
        atomicJson(file, data);
        return { id: entry.id, name: entry.name, at: entry.at, draft: entry.draft };
      });
    },
  };
}
