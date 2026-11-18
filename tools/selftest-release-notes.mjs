import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChangelog, createReleaseNotes } from '../src/custom/release-notes.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-notes-'));
try {
  // 解析：仅认日期二级标题，按日期倒序，无条目的日期跳过。
  const parsed = parseChangelog('# 更新日志\n\n## 2026-11-01\n\n- 第一项\n- 第二项\n\n## 2026-11-05\n\n- 较新的一项\n\n## 说明\n\n- 不属于日期节点的内容\n\n## 2026-10-20\n\n（空节点）\n');
  assert.deepEqual(parsed.map(entry => entry.id), ['2026-11-05', '2026-11-01']);
  assert.deepEqual(parsed[0].items, ['较新的一项']);
  assert.deepEqual(parsed[1].items, ['第一项', '第二项']);
  console.log('通过：CHANGELOG 解析为倒序日期节点并过滤空节点');

  const directory = path.join(base, 'data');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(base, 'CHANGELOG.md'), '# 更新日志\n\n## 2026-12-01\n\n- 本地新增\n');

  // 本地模式：不发起网络请求。
  let fetched = 0;
  const local = createReleaseNotes(directory, { root: base, localOnly: true, fetchImpl: async () => { fetched += 1; throw Error('不应联网'); } });
  let view = await local.view();
  assert.equal(view.source, 'local');
  assert.deepEqual(view.entries.map(entry => entry.id), ['2026-12-01']);
  assert.equal(view.unread, true);
  assert.equal(fetched, 0);
  console.log('通过：本地模式直接读取仓库 CHANGELOG 且不联网');

  // 已读状态按日期节点持久保存，重复标记不回退。
  assert.throws(() => local.acknowledge('local', 'not-a-date'), /更新日期无效/);
  local.acknowledge('local', '2026-12-01');
  assert.equal((await local.view()).unread, false);
  console.log('通过：已读状态持久保存且非法日期被拒绝');

  // 上游拉取失败时回退本地文件，功能不中断。
  const failing = createReleaseNotes(directory, { root: base, fetchImpl: async () => { throw Error('网络不可用'); } });
  view = await failing.view();
  assert.equal(view.source, 'local');
  assert.equal(view.entries[0].items[0], '本地新增');
  console.log('通过：上游不可用时回退本地 CHANGELOG');

  // 上游正常时使用上游内容并缓存，避免每次弹窗都请求。
  let calls = 0;
  const upstream = createReleaseNotes(directory, {
    root: base,
    fetchImpl: async () => { calls += 1; return { ok: true, text: async () => '# 更新日志\n\n## 2027-01-01\n\n- 上游新功能\n' }; },
  });
  view = await upstream.view();
  assert.equal(view.source, 'upstream');
  assert.equal(view.entries[0].id, '2027-01-01');
  assert.equal(view.entries[0].items[0], '上游新功能');
  assert.equal(view.unread, true);
  await upstream.view();
  assert.equal(calls, 1, '缓存期内不重复请求');
  console.log('通过：上游 CHANGELOG 作为内容节点并按缓存复用');

  console.log('更新记录专项 5/5 通过');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
