// Execute the real page guard and request wrapper without opening a game connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const guardSource = section('function createConsoleVersionGuard(', 'window.cwConsoleVersion = createConsoleVersionGuard();');
const callSource = section('async function call(', 'function el(');
const response = (version = 'old-page', data = { ok: true }, status = 200) => ({
  headers: new Headers(version ? { 'X-CW-Console-Version': version } : {}),
  ok: status < 400, status, statusText: String(status), async json() { return data; },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(version = 'old-page') {
  const element = tag => ({ tag, children: [], dataset: {}, style: {}, attributes: {}, disabled: false,
    append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const header = element('header'), body = element('body'), meta = { content: version };
  const env = { header, meta, requests: [], errors: [], events: [], downloads: 0, reloads: 0, confirms: 0, allowRefresh: false, progress: 0 };
  env.document = { body, createElement: element, querySelector: selector => selector === 'header' ? header : selector.startsWith('meta[') ? meta : null };
  env.location = { href: 'http://console.test/', reload() { env.reloads++; } };
  env.window = { confirm() { env.confirms++; return env.allowRefresh; }, dispatchEvent(event) { env.events.push(event.type); } };
  env.fetch = async (path, options) => { env.requests.push({ path, options }); return env.fetchHook ? env.fetchHook(path, options) : response(); };
  const api = new Function('env', `
    const document = env.document, window = env.window, location = env.location, fetch = env.fetch;
    let current = 'account-a';
    const configHasDraft = () => true, configDownloadDraft = () => { env.downloads++; };
    const trackCall = delta => { env.progress += delta; }, appendLog = () => {}, refreshLoop = async () => {};
    const reportError = error => env.errors.push(error);
    ${guardSource}
    window.cwConsoleVersion = createConsoleVersionGuard();
    ${callSource}
    return { guard: window.cwConsoleVersion, call };
  `)(env);
  return { ...api, env, banner: () => header.children.find(node => node.id === 'console-version-warning'),
    action(label) { return this.banner().children[1].children.find(button => button.textContent === label); } };
}
const mismatch = error => error.code === 'CLIENT_VERSION_MISMATCH' && !!error.fields?.revision;
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

await test('页面版本从初始meta冻结，所有请求携同一header且不能由响应升级', async () => {
  const f = fixture(); f.env.meta.content = 'changed-dom';
  await f.call('/api/loop'); await f.call('/api/settings', { method: 'POST', body: '{}' });
  assert(f.env.requests.every(request => request.options.headers.get('X-CW-Console-Version') === 'old-page'));
  assert.equal(f.guard.version, 'old-page'); assert.equal(f.guard.isStale(), false);
  assert.throws(() => { f.guard.version = 'new-page'; }, TypeError);
  assert.equal(f.env.progress, 0);
});

await test('GET发现后台重启即显示持久提示和冻结事件，不需要等到保存', async () => {
  const f = fixture(); f.env.fetchHook = () => response('new-page');
  await f.call('/api/loop'); assert.equal(f.guard.isStale(), true); assert.equal(f.guard.version, 'old-page');
  assert.equal(f.banner().attributes.role, 'alert'); assert.match(f.banner().children[0].textContent, /草稿已保留/);
  assert.deepEqual(f.env.events, ['cw-console-version-stale']);
  await f.call('/api/loop'); assert.equal(f.env.header.children.length, 1); assert.equal(f.env.events.length, 1);
  const before = f.env.requests.length;
  for (const path of ['/api/settings', '/api/settings/validate', '/api/settings/preview', '/api/loop/start', '/api/accounts/pause']) {
    await assert.rejects(f.call(path, { method: 'POST', body: '{}' }), mismatch);
  }
  assert.equal(f.env.requests.length, before, '普通写请求在fetch前拦截');
});

await test('旧页只允许读取和专用停止断开，混合启停路由与其他method不能借道', async () => {
  const f = fixture(); f.guard.observe('new-page');
  const stops = ['/api/loop/stop','/api/disconnect','/api/stages/stop','/api/pirates/advance/stop',
    '/api/guild/mutual/stop','/api/trials/stop','/api/accounts/alipay-login/cancel','/api/accounts/phone-login/cancel'];
  f.env.fetchHook = () => response('new-page');
  for (const path of stops) await f.call(path, { method: 'POST', body: '{"confirm":true}' });
  for (const path of ['/api/accounts/pause', '/api/loop/auto-start']) await assert.rejects(f.call(path, {method:'POST',body:'{"start":true}'}), mismatch);
  await assert.rejects(f.call('/api/loop/stop', {method:'DELETE'}), mismatch);
  assert.equal(f.env.requests.length, stops.length);
});

await test('409即使没有版本header也冻结；缺少初始meta时不信任响应版本', async () => {
  const f = fixture(); f.env.fetchHook = () => response(null, { code: 'CLIENT_VERSION_MISMATCH', error: '请刷新页面', fields: { revision: '请刷新' } }, 409);
  await assert.rejects(f.call('/api/settings', {method:'POST',body:'{}'}), mismatch);
  assert.equal(f.guard.isStale(), true); assert(f.banner());
  const g = fixture(''); g.env.fetchHook = () => response('new-page'); await g.call('/api/loop');
  assert.equal(g.guard.version, ''); assert.equal(g.guard.isStale(), true);
});

await test('写响应晚到时即使200和旧header也不能误报成功', async () => {
  const f = fixture(), pending = deferred();
  f.env.fetchHook = (_path, options) => options.method === 'POST' ? pending.promise : response('new-page');
  const save = f.call('/api/settings', {method:'POST',body:'{}'});
  await f.call('/api/loop'); pending.resolve(response('old-page', { settings: { replaced: true } }));
  await assert.rejects(save, mismatch); assert.equal(f.guard.version, 'old-page'); assert.equal(f.env.progress, 0);
});

await test('新版响应在JSON解析前触发冻结，写请求不采用新schema或HTML错误页', async () => {
  const f = fixture(); let parsed = false;
  f.env.fetchHook = () => ({ ...response('new-page'), async json() { parsed = true; throw new Error('不是旧版JSON'); } });
  await assert.rejects(f.call('/api/settings', {method:'POST',body:'{}'}), mismatch);
  assert.equal(parsed, false); assert.equal(f.guard.isStale(), true);
});

await test('过期横幅提供本地草稿备份和明确刷新确认，停止按钮仍可用', async () => {
  const f = fixture(); f.guard.reject(); f.action('下载游戏配置草稿').onclick(); assert.equal(f.env.downloads, 1);
  f.action('刷新页面').onclick(); assert.equal(f.env.confirms, 1); assert.equal(f.env.reloads, 0);
  f.env.allowRefresh = true; f.action('刷新页面').onclick(); assert.equal(f.env.reloads, 1);
  await f.action('停止当前账号挂机').onclick(); await f.action('断开当前账号').onclick();
  assert.deepEqual(f.env.requests.map(request => new URL(request.path, 'http://console.test').pathname), ['/api/loop/stop','/api/disconnect']);
});

console.log('旧网页版本保护 UI 专项 ' + passed + '/' + passed + ' 通过');
