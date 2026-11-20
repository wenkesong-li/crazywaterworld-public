import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Worker } from 'node:worker_threads';

const restricted = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) restricted.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  restricted.addSubnet(address, prefix, 'ipv6');
}
const publicAddress = address => isIP(address) === 4 ? !restricted.check(address)
  : isIP(address) === 6 && /^[23]/.test(address) && !restricted.check(address, 'ipv6');

function channelUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('请输入完整的渠道网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('渠道需要无需登录的 HTTP 或 HTTPS 网址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? !publicAddress(host) : !host.includes('.') || /(?:^|\.)(localhost|local)\.?$/i.test(host)) {
    throw Error('请输入可公开访问的渠道网址');
  }
  return url;
}

export function channelConfig(input) {
  const name = typeof input.name === 'string' && input.name.trim();
  if (!name || name.length > 80) throw Error('渠道名称需要 1 至 80 个字符');
  if (typeof input.url !== 'string' || input.url.length > 4096) throw Error('渠道网址无效');
  const url = channelUrl(input.url).href;
  const { pattern, mode = 'text' } = input;
  if (!['text', 'raw'].includes(mode)) throw Error('请选择提取方式');
  const jsonField = mode === 'raw' ? input.jsonField ?? '' : '';
  if (typeof jsonField !== 'string' || jsonField.length > 128) throw Error('JSON 数组字段无效');
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2000) throw Error('请输入 1 至 2000 个字符的正则表达式');
  try { new RegExp(pattern, 'gmu'); } catch (error) { throw Error('正则表达式无效：' + error.message); }
  return { name, url, mode, pattern, jsonField: jsonField.trim() };
}

// Validate the addresses actually passed to the socket, including on repeated fetches.
function publicLookup(host, options, callback) {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) return callback(Error('渠道地址需要指向公网'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function publicRequest(value, options) {
  const url = channelUrl(value);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    transport.get(url, { ...options, agent: false, lookup: publicLookup }, body => {
      resolve({ body, status: body.statusCode, ok: body.statusCode >= 200 && body.statusCode < 300 });
    }).on('error', reject);
  });
}

export async function fetchChannelBody(url, fetcher = publicRequest) {
  const controller = new AbortController();
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    headers: { 'user-agent': 'CrazyWaterWorld-GiftCatalog/1.0', accept: 'text/html, text/plain, application/json' } });
  try {
    if (!response.ok) throw Error('来源站点返回 HTTP ' + response.status + (response.status >= 300 && response.status < 400 ? '，请填写跳转后的网址' : ''));
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw Error('来源页面超过 2 MB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { controller.abort(); }
}

export function parseChannelBody(config, body, now) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gift-code-channel-worker.mjs', import.meta.url), {
      workerData: { mode: config.mode, pattern: config.pattern, jsonField: config.jsonField, body, now }, execArgv: [],
    });
    const timer = setTimeout(() => { reject(Error('渠道内容解析超时，请检查来源和提取规则')); void worker.terminate(); }, 1500);
    worker.once('message', result => result.error ? reject(Error(result.error)) : resolve(result));
    worker.once('error', reject);
    worker.once('exit', () => { clearTimeout(timer); reject(Error('渠道内容解析中止')); });
  });
}
