// 更新记录：自动拉取上游父库的 CHANGELOG.md 并解析为按日期倒序的条目；
// 网络不可用时回退到本仓库自带的 CHANGELOG.md。已读状态按本机保存在 data/。
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

export const DEFAULT_CHANGELOG_URL = 'https://raw.githubusercontent.com/xutongxue233/crazywaterworld/main/CHANGELOG.md';
const CACHE_TTL_MS = 10 * 60_000;

export function parseChangelog(text) {
  const entries = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (heading) {
      if (current) entries.push(current);
      current = { id: heading[1], items: [] };
      continue;
    }
    // 非日期的二级标题（如“说明”）结束当前节点，其内容不并入日期条目。
    if (/^##\s/.test(line)) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const item = /^[-*]\s+(.+)$/.exec(line.trim());
    if (item) current.items.push(item[1].trim());
  }
  if (current) entries.push(current);
  return entries.filter(entry => entry.items.length).sort((a, b) => b.id.localeCompare(a.id));
}

export function createReleaseNotes(directory, {
  url = process.env.CW_CHANGELOG_URL || DEFAULT_CHANGELOG_URL,
  localOnly = process.env.CW_CHANGELOG_SOURCE === 'local',
  root = path.resolve(import.meta.dirname, '../..'),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const file = path.join(directory, 'console-release-reads.json');
  let cache = null;

  const readLocal = () => {
    try { return parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')); }
    catch { return []; }
  };

  async function entries() {
    if (localOnly) return { entries: readLocal(), source: 'local' };
    if (cache && now() - cache.at < CACHE_TTL_MS) return cache.value;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const list = parseChangelog(await response.text());
      if (!list.length) throw new Error('更新日志为空');
      cache = { at: now(), value: { entries: list, source: 'upstream' } };
      return cache.value;
    } catch {
      // 拉不到上游时退回本地文件，保持更新记录可用。
      const local = readLocal();
      cache = { at: now(), value: { entries: local, source: 'local' } };
      return cache.value;
    }
  }

  const readState = () => {
    const data = readJson(file, { version: 1, readers: {} });
    if (data?.version !== 1 || !data.readers || typeof data.readers !== 'object' || Array.isArray(data.readers)) throw Error('更新记录已读数据无效');
    return data;
  };

  return {
    async view(userId = 'local') {
      const { entries: list, source } = await entries();
      const latestId = list[0]?.id ?? '';
      return { entries: list.slice(0, 60), latestId, source, unread: Boolean(latestId) && readState().readers[userId] !== latestId };
    },
    acknowledge(userId, id) {
      if (!id || typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(id)) throw Error('更新日期无效，请刷新页面');
      withFileLock(file, () => {
        const data = readState();
        if (data.readers[userId] >= id) return;
        data.readers[userId] = id;
        atomicJson(file, data);
      });
      return { ok: true };
    },
  };
}
