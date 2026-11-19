import { Resolver } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { BlockList } from 'node:net';

const giftSourceResolver = new Resolver({ timeout: 3000, tries: 2 });

export const giftSources = Object.freeze([
  { id: 'ali213', name: '游侠网', url: 'https://m.ali213.net/news/gl2602/1747967.html' },
  { id: 'wiki', name: '疯狂水世界 Wiki', url: 'https://fkssj.game-wiki.cn/api/public/codes' },
]);

function wikiTime(value, endOfDay = false) {
  if (typeof value !== 'string' || !value) return null;
  const text = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text)
    ? text + (endOfDay ? 'T23:59:59.999+08:00' : 'T00:00:00+08:00')
    : /(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : text + '+08:00');
}

export function parseWikiGiftCodes(text, now) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.codes)) throw Error('Wiki 礼包码接口格式已变化');
  const rows = [];
  for (const entry of data.codes) {
    if (entry?.status !== 'valid') continue;
    const { code, starts_at, expires_at, reward } = entry;
    if (typeof code !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(code.trim())) continue;
    const starts = wikiTime(starts_at);
    const expires = wikiTime(expires_at, true);
    if (starts_at && (!Number.isFinite(starts) || starts > now)) continue;
    if (expires_at && (!Number.isFinite(expires) || expires < now)) continue;
    rows.push({ code: code.trim(), reward: typeof reward === 'string' ? reward.trim().slice(0, 1000) : '', expiresAt: expires === null ? null
      : new Date(expires + 8 * 3600000).toISOString().slice(0, 10), expiresAtMs: expires });
  }
  const updated = wikiTime(data.updated_at);
  return { rows, sourceUpdatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null };
}

export async function fetchGiftSource(source, fetcher) {
  const response = await fetcher(source.url, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { 'cache-control': 'no-cache', accept: source.id === 'wiki' ? 'application/json' : 'text/html' },
  });
  if (!response.ok) throw Error('来源返回 HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw Error('来源内容超过大小限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function customGiftSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('请输入有效的 HTTPS 网址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+$/i.test(url.hostname)) throw Error('请输入公开的 HTTPS 域名网址');
  if (url.href.length > 1000) throw Error('渠道网址过长');
  return url;
}

const blockedGiftNetworks = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blockedGiftNetworks.addSubnet(network, bits);

export async function fetchCustomGiftSource(source) {
  const url = customGiftSourceUrl(source.url);
  const addresses = await giftSourceResolver.resolve4(url.hostname);
  if (!addresses.length || addresses.some(address => blockedGiftNetworks.check(address))) throw Error('渠道域名必须解析到公网地址');
  // Pin the checked address for the actual TLS connection. Retain the original hostname for certificate validation.
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, {
      agent: false, family: 4, autoSelectFamily: false, signal: AbortSignal.timeout(20000),
      lookup: (_hostname, _options, callback) => callback(null, addresses[0], 4),
      headers: { 'cache-control': 'no-cache', accept: source.format === 'wiki' ? 'application/json' : 'text/html' },
    }, async response => {
      try {
        if (response.statusCode !== 200) throw Error('来源返回 HTTP ' + response.statusCode);
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw Error('来源内容超过大小限制');
          chunks.push(chunk);
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
  });
}
