// 一键从 GitHub 拉取最新代码：对比远端分支、展示差异提交、按阶段执行并汇报进度。
// 仅在 git 克隆目录可用；`data/`、`work/` 等本地目录不参与更新，账号与配置不受影响。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGitSync(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('git ' + args[0] + ' 失败：' + (result.stderr || '').trim().split('\n')[0]);
  return result.stdout;
}

function runGit(root, args, { onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += chunk; onOutput?.(String(chunk)); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error('git ' + args[0] + ' 失败：' + (stderr || stdout).trim().split('\n')[0]));
    });
  });
}

function runNpm(root, args, executable, { onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, shell: process.platform === 'win32' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += chunk; onOutput?.(String(chunk)); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error('npm ' + args.join(' ') + ' 失败：' + (stderr || stdout).trim().split('\n').filter(Boolean).slice(-3).join('；')));
    });
  });
}

export function createUpdateService({
  root = process.env.CW_UPDATE_ROOT || path.resolve(import.meta.dirname, '../..'),
  remote = process.env.CW_UPDATE_REMOTE || 'origin',
  branch = process.env.CW_UPDATE_BRANCH || 'main',
  npmExecutable,
} = {}) {
  let job = null;

  const npmCommand = () => npmExecutable
    ?? (process.platform === 'win32'
      ? (fs.existsSync(path.join(root, 'runtime', 'npm.cmd')) ? path.join(root, 'runtime', 'npm.cmd') : 'npm.cmd')
      : (fs.existsSync(path.join(root, 'runtime', 'bin', 'npm')) ? path.join(root, 'runtime', 'bin', 'npm') : 'npm'));

  async function check() {
    if (!fs.existsSync(root) || !fs.existsSync(path.join(root, '.git'))) {
      return { available: false, reason: '当前目录不是 git 克隆，无法在线更新。请使用 git clone 方式安装，或重新下载绿色版。' };
    }
    let current;
    try { current = runGitSync(root, ['rev-parse', 'HEAD']).trim(); }
    catch { return { available: false, reason: '无法读取本地 git 版本，请确认仓库完整。' }; }
    let remoteLine;
    try { remoteLine = runGitSync(root, ['ls-remote', remote, 'refs/heads/' + branch]).trim(); }
    catch { return { available: false, reason: '无法访问更新源（' + remote + '），请检查网络或远程配置。', current }; }
    const remoteSha = remoteLine.split(/\s+/)[0] || '';
    if (!remoteSha) return { available: false, reason: '更新源上没有 ' + branch + ' 分支。', current };
    if (remoteSha === current) return { available: true, upToDate: true, current };
    try {
      runGitSync(root, ['fetch', '--quiet', remote, branch]);
      const log = runGitSync(root, ['log', '--oneline', '--no-decorate', 'HEAD..FETCH_HEAD']).trim();
      const commits = log ? log.split('\n').slice(0, 100) : [];
      return { available: true, upToDate: false, current, remote: remoteSha, commits };
    } catch (error) {
      return { available: false, reason: '拉取更新信息失败：' + error.message, current };
    }
  }

  function setStage(stage, percent, detail) {
    job.stage = stage; job.percent = percent; job.detail = detail;
  }

  async function apply() {
    try {
      const status = (await runGit(root, ['status', '--porcelain'])).trim();
      if (status) throw new Error('本地代码有未提交的修改，请先还原或提交后再更新');
      const before = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
      setStage('fetch', 5, '正在拉取远端代码…');
      // git fetch --progress 的百分比输出在 stderr，取最近一次百分比折算到 5–60%。
      let fetchPercent = 5;
      await runGit(root, ['fetch', '--progress', remote, branch], {
        onOutput: text => {
          const match = /(\d+)%/.exec(text.split(/\r|\n/).filter(Boolean).pop() ?? '');
          if (match) {
            fetchPercent = 5 + Math.round(Number(match[1]) * 0.55);
            setStage('fetch', fetchPercent, '正在拉取远端代码… ' + match[1] + '%');
          }
        },
      });
      setStage('pull', 62, '正在应用更新…');
      await runGit(root, ['pull', '--ff-only', remote, branch]);
      const after = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
      const changed = await runGit(root, ['diff', '--name-only', before, after]);
      const hasPackage = fs.existsSync(path.join(root, 'package.json'));
      if (hasPackage && /^package-lock\.json$/m.test(changed)) {
        setStage('deps', 65, '依赖有变化，正在安装…');
        let depsPercent = 65;
        await runNpm(root, ['install'], npmCommand(), {
          onOutput: () => { depsPercent = Math.min(84, depsPercent + 0.5); setStage('deps', Math.round(depsPercent), '依赖有变化，正在安装…'); },
        });
      } else {
        setStage('deps', 85, '依赖无变化，跳过安装。');
      }
      if (hasPackage) {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkg.scripts?.['build:ui']) {
          setStage('build', 87, '正在重新构建控制台界面…');
          let buildPercent = 87;
          await runNpm(root, ['run', 'build:ui'], npmCommand(), {
            onOutput: () => { buildPercent = Math.min(99, buildPercent + 0.5); setStage('build', Math.round(buildPercent), '正在重新构建控制台界面…'); },
          });
        }
      }
      job.version = after;
      setStage('done', 100, '更新完成。');
      job.done = true;
    } catch (error) {
      job.error = error.message;
      setStage('error', job.percent, error.message);
    } finally {
      job.finished = true;
    }
  }

  return {
    check,
    start() {
      if (job && !job.finished) return { ok: false, error: '已有更新正在进行中。' };
      job = { stage: 'prepare', percent: 0, detail: '准备更新…', done: false, error: null, finished: false, version: null };
      void apply();
      return { ok: true };
    },
    progress() {
      if (!job) return { running: false, finished: false, stage: 'idle', percent: 0, detail: '', done: false, error: null, version: null };
      return { running: !job.finished, finished: job.finished, stage: job.stage, percent: job.percent, detail: job.detail, done: job.done, error: job.error, version: job.version };
    },
  };
}
