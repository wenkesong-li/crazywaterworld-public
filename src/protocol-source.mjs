import fs from 'node:fs';
import path from 'node:path';
import { wechatPackageCandidates, wechatUsersDirectory } from './platform/client-paths.mjs';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const PROTO_BUNDLE = path.resolve(import.meta.dirname, '../work/extracted/_src_chunks_/src/chunks/game.js');
const APPID = 'wx2ea52a972ea18e5e';
// 用户自备协议包的放置位置：程序根目录或其 protocol/ 子目录下的 _src_chunks_.wxapkg，无需环境变量。
const dropInBundles = [
  path.resolve(import.meta.dirname, '../_src_chunks_.wxapkg'),
  path.resolve(import.meta.dirname, '../protocol/_src_chunks_.wxapkg'),
];

// Describe the selected source without evaluating game code. A running
// connection keeps its loaded protocol; new connections can compare this
// identity to detect a newly downloaded package or an edited explicit file.
export function protocolSourceInfo(bundlePath) {
  const explicit = bundlePath || process.env.CW_PROTO_BUNDLE;
  const cached = explicit ? null : wechatPackageCandidates(APPID, { includeIncomplete: true })[0];
  if (cached && !fs.existsSync(cached))
    throw new Error('微信游戏包 ' + path.basename(path.dirname(cached)) + ' 的协议分包尚未下载，请在电脑版微信打开游戏并进入游戏后重试');
  // 拖放即用：显式指定 > 微信缓存 > 用户放置的 wxapkg > work/extracted。
  const dropIn = (!explicit && !cached) ? dropInBundles.find(file => fs.existsSync(file)) : null;
  if (!explicit && !cached && !dropIn) {
    // 本机微信缓存里完全没有游戏包：列出搜索过的位置并给出两条出路，代替裸 ENOENT。
    throw new Error([
      '未找到本机微信的游戏协议包，已搜索：',
      '  1) ' + wechatUsersDirectory(),
      '  2) ' + dropInBundles.join(' 或 '),
      '  3) ' + PROTO_BUNDLE,
      '解决方式一：在电脑版微信（4.x）中打开《疯狂水世界》并进入游戏一次，让微信下载协议分包后重试。',
      '解决方式二：从其他机器拷贝 _src_chunks_.wxapkg，放到程序根目录或 protocol/ 子目录（无需其他设置），或用 CW_PROTO_BUNDLE 指向它。',
    ].join('\n'));
  }
  const file = path.resolve(explicit || cached || dropIn || PROTO_BUNDLE);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('协议来源不是文件：' + file);
  const kind = explicit ? 'explicit' : cached ? 'wechat' : dropIn ? 'drop-in' : 'extracted';
  return Object.freeze({ file, kind, packageVersion: cached ? path.basename(path.dirname(file)) : null,
    mtimeMs: stat.mtimeMs, size: stat.size, signature: JSON.stringify([file, stat.mtimeMs, stat.size]) });
}

function readBundle(file) {
  const input = fs.readFileSync(file);
  if (!/\.wxapkg$/i.test(file)) return input.toString('utf8');
  const { data } = decrypt(APPID, input);
  const entry = inspectArchive(data).files.find(item => item.relativePath === 'src/chunks/game.js');
  if (!entry) throw new Error(file + ' 中缺少 src/chunks/game.js，请使用 _src_chunks_.wxapkg');
  return data.toString('utf8', entry.off, entry.off + entry.size);
}

export function readProtocolSource(bundlePath) {
  const explicit = bundlePath || process.env.CW_PROTO_BUNDLE;
  if (explicit) return readBundle(explicit);
  let cacheError;
  try {
    for (const file of wechatPackageCandidates(APPID)) {
      try { return readBundle(file); }
      catch (error) { cacheError ??= error; }
    }
  } catch (error) { cacheError = error; }
  if (fs.existsSync(PROTO_BUNDLE)) return readBundle(PROTO_BUNDLE);
  if (cacheError) throw cacheError;
  throw new Error('缺少协议文件。请在电脑版微信打开《疯狂水世界》并进入游戏，或设置 CW_PROTO_BUNDLE 指向自己的 _src_chunks_.wxapkg 或解包后的 src/chunks/game.js。');
}
