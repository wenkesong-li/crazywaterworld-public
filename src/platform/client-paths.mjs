import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    // macOS 隐私权限拦截读取微信容器等目录时，给出带换行和命令高亮的解决步骤；
    // 终端直接输出可看到高亮，运行日志管道会剥掉控制字符后按多行展示。
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      const cmd = text => `\u001b[1;36m${text}\u001b[0m`;
      throw new Error([
        `无权读取 ${root}（macOS 隐私权限拦截）。两种解决方式任选其一：`,
        '',
        '方式一 · 授权后自动读取：',
        `  ${cmd('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')}`,
        '  在打开的「完全磁盘访问权限」面板中添加当前终端，完全退出（Cmd+Q）并重开终端后再次启动。',
        '',
        '方式二 · 跳过微信缓存，直接指定协议包：',
        `  ${cmd('CW_PROTO_BUNDLE=<协议包路径>/_src_chunks_.wxapkg ./点此启动.command')}`,
      ].join('\n'), { cause: error });
    }
    throw error;
  }
}

export function wechatUsersDirectory({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'darwin' && !env.APPDATA) {
    const containers = ['com.tencent.xinWeChat', 'com.tencent.WeChat'];
    const roots = containers.map(name => path.join(home, 'Library', 'Containers', name, 'Data', 'Documents', 'app_data', 'radium', 'users'));
    return roots.find(root => fs.existsSync(root)) || roots[0];
  }
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Tencent', 'xwechat', 'radium', 'users');
}

export function wechatPackageCandidates(appId, options) {
  const users = wechatUsersDirectory(options);
  const candidates = [];
  for (const user of directories(users)) {
    const root = path.join(users, user, 'applet', 'packages', appId);
    for (const version of directories(root).filter(name => /^\d+$/.test(name))) {
      const file = path.join(root, version, '_src_chunks_.wxapkg');
      const complete = fs.existsSync(file);
      // Strict consumers must notice a newer installed main package even if
      // WeChat has not downloaded its protocol subpackage yet. Empty version
      // directories alone are not evidence of an installed release.
      let mainPresent = false;
      if (options?.includeIncomplete) {
        try { mainPresent = fs.statSync(path.join(root, version, '__APP__.wxapkg')).isFile(); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      if (complete || mainPresent) candidates.push({ version: Number(version), file, complete });
    }
  }
  return candidates.sort((left, right) => right.version - left.version || Number(right.complete) - Number(left.complete)).map(entry => entry.file);
}

export function wechatCacheDirectories(appId, options) {
  const users = wechatUsersDirectory(options);
  return directories(users).map(user => path.join(users, user, 'applet', 'local', appId, 'usr', 'gamecaches'));
}

export function wechatConfigCandidates(appId, options) {
  const found = [];
  for (const cache of wechatCacheDirectories(appId, options)) {
    const directory = path.join(cache, 'config_cn');
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) found.push(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return found;
}
