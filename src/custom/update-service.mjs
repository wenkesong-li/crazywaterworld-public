// 一键从 GitHub 拉取最新代码：对比远端分支、展示差异提交、按阶段执行并汇报进度。
// 仅在 git 克隆目录可用；`data/`、`work/` 等本地目录不参与更新，账号与配置不受影响。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGitSync(root, args, gitExecutable = 'git') {
  const result = spawnSync(gitExecutable, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('git ' + args[0] + ' 失败：' + (result.stderr || '').trim().split('\n')[0]);
  return result.stdout;
}

function runGit(root, args, gitExecutable = 'git', { onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable, args, { cwd: root, windowsHide: true });
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
  // 默认跟踪上游父库；克隆地址与文档也一致指向父库。可用 CW_UPDATE_REMOTE 覆盖。
  remote = process.env.CW_UPDATE_REMOTE || 'https://github.com/xutongxue233/crazywaterworld.git',
  branch = process.env.CW_UPDATE_BRANCH || 'main',
  npmExecutable,
  gitExecutable = 'git',
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
    // 本机没装 git 程序时（例如只拷贝了仓库目录），给出明确的安装指引而不是晦涩的执行错误。
    const probe = spawnSync(gitExecutable, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) {
      return { available: false, reason: '未检测到 git 程序，无法在线更新。请先安装 Git（https://git-scm.com/downloads）后重试，或手动下载最新版本覆盖。' };
    }
    let current;
    try { current = runGitSync(root, ['rev-parse', 'HEAD'], gitExecutable).trim(); }
    catch { return { available: false, reason: '无法读取本地 git 版本，请确认仓库完整。' }; }
    let remoteLine;
    try { remoteLine = runGitSync(root, ['ls-remote', remote, 'refs/heads/' + branch], gitExecutable).trim(); }
    catch { return { available: false, reason: '无法访问更新源（' + remote + '），请检查网络或远程配置。', current }; }
    const remoteSha = remoteLine.split(/\s+/)[0] || '';
    if (!remoteSha) return { available: false, reason: '更新源上没有 ' + branch + ' 分支。', current };
    if (remoteSha === current) return { available: true, upToDate: true, current };
    try {
      runGitSync(root, ['fetch', '--quiet', remote, branch], gitExecutable);
      // 比较祖先关系，区分“可以快进的落后”和“本地带自有提交的分叉”：
      // 本地已包含上游全部提交（分发自带定制提交、上游未动）时不误报新版本。
      const base = runGitSync(root, ['merge-base', 'HEAD', 'FETCH_HEAD'], gitExecutable).trim();
      if (base === remoteSha) return { available: true, upToDate: true, current };
      const log = runGitSync(root, ['log', '--oneline', '--no-decorate', 'HEAD..FETCH_HEAD'], gitExecutable).trim();
      const commits = log ? log.split('\n').slice(0, 100) : [];
      const diverged = base !== current;
      return { available: true, upToDate: false, diverged, current, remote: remoteSha, commits };
    } catch (error) {
      return { available: false, reason: '拉取更新信息失败：' + error.message, current };
    }
  }

  function setStage(stage, percent, detail) {
    job.stage = stage; job.percent = percent; job.detail = detail;
  }

  async function apply() {
    try {
      const status = (await runGit(root, ['status', '--porcelain'], gitExecutable)).trim();
      if (status) throw new Error('本地代码有未提交的修改，请先还原或提交后再更新');
      const before = (await runGit(root, ['rev-parse', 'HEAD'], gitExecutable)).trim();
      setStage('fetch', 5, '正在拉取远端代码…');
      // git fetch --progress 的百分比输出在 stderr，取最近一次百分比折算到 5–60%。
      let fetchPercent = 5;
      await runGit(root, ['fetch', '--progress', remote, branch], gitExecutable, {
        onOutput: text => {
          const match = /(\d+)%/.exec(text.split(/\r|\n/).filter(Boolean).pop() ?? '');
          if (match) {
            fetchPercent = 5 + Math.round(Number(match[1]) * 0.55);
            setStage('fetch', fetchPercent, '正在拉取远端代码… ' + match[1] + '%');
          }
        },
      });
      setStage('pull', 62, '正在应用更新…');
      await runGit(root, ['pull', '--ff-only', remote, branch], gitExecutable);
      const after = (await runGit(root, ['rev-parse', 'HEAD'], gitExecutable)).trim();
      const changed = await runGit(root, ['diff', '--name-only', before, after], gitExecutable);
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
      // 本地相对上游有独立提交时无法快进，给出明确出路而不是 git 原文。
      job.error = /fast-forward|divergent|fetch first|unrelated histories/i.test(error.message)
        ? '本地代码与上游已分叉，无法直接快进更新。请手动合并上游改动，或重新克隆最新版本。'
        : error.message;
      setStage('error', job.percent, job.error);
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
