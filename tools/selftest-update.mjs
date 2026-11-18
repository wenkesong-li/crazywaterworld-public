import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUpdateService } from '../src/custom/update-service.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-update-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, command + ' ' + args.join(' ') + ' 失败：' + result.stderr);
  return result.stdout;
};
const git = (args, cwd) => run('git', args, cwd);
const remote = path.join(base, 'remote.git');
const work = path.join(base, 'work');
const dev = path.join(base, 'dev');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  git(['init', '--bare', '-b', 'main', remote], base);
  git(['init', '-b', 'main', work], base);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'tester'], work);
  fs.writeFileSync(path.join(work, 'version.txt'), 'v1\n');
  fs.writeFileSync(path.join(work, '.gitignore'), 'data/\n');
  git(['add', '.'], work);
  git(['commit', '-m', '初始版本'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-u', 'origin', 'main'], work);

  const service = createUpdateService({ root: work, remote });

  // 3.1 代码一致：提示已是最新版本。
  const same = await service.check();
  assert.equal(same.available, true);
  assert.equal(same.upToDate, true);
  assert.ok(same.current);
  console.log('通过：本地与远端一致时报告已是最新版本');

  // 远端前进一个提交。
  git(['clone', remote, dev], base);
  git(['config', 'user.email', 'dev@example.com'], dev);
  git(['config', 'user.name', 'dev'], dev);
  fs.writeFileSync(path.join(dev, 'version.txt'), 'v2\n');
  git(['add', '.'], dev);
  git(['commit', '-m', '新增功能：测试更新内容'], dev);
  git(['push', 'origin', 'main'], dev);
  const remoteHead = git(['rev-parse', 'HEAD'], dev).trim();

  // 3.2 代码不一致：展示差异提交。
  const diff = await service.check();
  assert.equal(diff.available, true);
  assert.equal(diff.upToDate, false);
  assert.equal(diff.remote, remoteHead);
  assert.ok(diff.commits.some(line => line.includes('新增功能：测试更新内容')));
  console.log('通过：远端有新提交时列出更新内容');

  // 3.2 确认更新后带进度地应用；data/ 等未跟踪目录不受影响。
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });
  fs.writeFileSync(path.join(work, 'data', 'accounts.json'), '{"kept":true}');
  const accepted = service.start();
  assert.equal(accepted.ok, true);
  let state;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    state = service.progress();
    if (state.finished) break;
  }
  assert.equal(state.finished, true);
  assert.equal(state.error, null, '更新不应失败：' + state.error);
  assert.equal(state.done, true);
  assert.equal(state.version, remoteHead);
  assert.equal(fs.readFileSync(path.join(work, 'version.txt'), 'utf8'), 'v2\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'data', 'accounts.json'), 'utf8')).kept, true);
  console.log('通过：确认更新后拉取代码，未跟踪的 data/ 目录保持不变');

  // 更新完成后的进度快照保持可读。
  const idle = service.progress();
  assert.equal(idle.running, false);
  assert.equal(idle.done, true);
  console.log('通过：更新完成后进度接口返回完成状态');

  // 本地有未提交修改时拒绝更新，避免覆盖用户改动。
  fs.writeFileSync(path.join(work, 'local-edit.txt'), 'dirty\n');
  const refused = service.start();
  assert.equal(refused.ok, true);
  let failed;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    failed = service.progress();
    if (failed.finished) break;
  }
  assert.equal(failed.finished, true);
  assert.ok(failed.error.includes('本地'), '应提示本地修改：' + failed.error);
  assert.equal(fs.readFileSync(path.join(work, 'local-edit.txt'), 'utf8'), 'dirty\n');
  console.log('通过：本地存在未提交修改时拒绝更新并保留现场');

  // 非 git 目录明确报告不可用。
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const unavailable = await createUpdateService({ root: plain }).check();
  assert.equal(unavailable.available, false);
  assert.ok(unavailable.reason.includes('git'));
  console.log('通过：非 git 目录提示无法在线更新');

  // 本机没有 git 程序时给出安装指引，而不是晦涩的执行错误。
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  const noGit = await createUpdateService({ root: plain, gitExecutable: 'cw-definitely-not-git' }).check();
  assert.equal(noGit.available, false);
  assert.ok(noGit.reason.includes('未检测到 git'));
  console.log('通过：缺少 git 程序时提示安装 Git');

  console.log('检查更新专项 7/7 通过');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
