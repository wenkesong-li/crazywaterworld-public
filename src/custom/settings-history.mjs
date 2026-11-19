import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

export function createSettingsHistory(directory) {
  function fileFor(accountId) {
    return path.join(directory, 'settings-history', encodeURIComponent(accountId) + '.json');
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
    get(accountId, id) {
      const entry = read(fileFor(accountId)).entries.find(row => row.id === id);
      if (!entry) throw Error('当前游戏账号没有这条配置记录');
      return entry;
    },
    save(accountId, name, document, { draft = false } = {}) {
      const title = typeof name === 'string' ? name.trim() : '';
      if (!title || title.length > 80) throw Error('请输入 1 至 80 字的配置名称');
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
