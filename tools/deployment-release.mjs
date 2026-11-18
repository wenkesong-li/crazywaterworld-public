import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJson, withFileLock } from '../src/json-store.mjs';
import { releases as manualReleases } from '../src/custom/release-notes.mjs';

const [action, input, destination] = process.argv.slice(2);
if (!input || !destination) throw Error('需要指定输入文件和输出位置');
const document = JSON.parse(fs.readFileSync(input, 'utf8'));
if (action === 'prepare') {
  if (!/^[a-f0-9]{40}$/.test(document.from) || !/^[a-f0-9]{40}$/.test(document.to) || !Array.isArray(document.commits)) throw Error('部署提交范围无效');
  const items = [...new Set(document.commits.map(commit => {
    if (!/^[a-f0-9]{40}$/.test(commit.hash) || typeof commit.subject !== 'string') throw Error('部署提交无效');
    return commit.subject.replace(/^(?:feat|fix|perf|refactor|chore|build|style|docs|test)(?:\([^)]*\))?:\s*/i, '').trim();
  }).filter(Boolean))];
  const previousManual = manualReleases.findIndex(entry => entry.version === document.previousManualVersion);
  if (previousManual > 0) items.push(...manualReleases.slice(0, previousManual).flatMap(entry => entry.items).filter(item => !items.includes(item)));
  if (!items.length) items.push('同步代码并重新构建，保留现有账号数据与配置。');
  const now = new Date();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  atomicJson(path.resolve(destination), {
    version: 'deploy-' + document.to.slice(0, 12), date, title: '版本更新 · ' + date, author: '李大龙',
    items, from: document.from, commit: document.to, preparedAt: now.toISOString(),
  });
} else if (action === 'publish') {
  if (!/^deploy-[a-f0-9]{12}$/.test(document.version) || !/^[a-f0-9]{40}$/.test(document.commit) || !Array.isArray(document.items) || document.author !== '李大龙') throw Error('部署更新记录无效');
  const file = path.join(path.resolve(destination), 'console-deployment-history.json');
  withFileLock(file, () => {
    const history = readJson(file, []);
    if (!Array.isArray(history)) throw Error('部署更新历史无效');
    if (!history.some(entry => entry.commit === document.commit)) atomicJson(file, [{ ...document, deployedAt: new Date().toISOString() }, ...history]);
  });
} else throw Error('请选择 prepare 或 publish');
