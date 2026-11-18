// HTTP request shapes only: no real server, browser, network or account files.
import assert from 'node:assert/strict';
import { createConsoleVersion, renderVersionedPage, consoleVersionError } from '../src/console-version.mjs';

let passed = 0;
const test = (name, work) => { work(); passed++; console.log('通过：' + name); };
const page = '<!doctype html><html><head><script>boot()</script></head><body>控制台</body></html>';
const current = createConsoleVersion(page), stale = createConsoleVersion(page);
const request = (headers = {}, method = 'POST', url = '/api/settings') => ({ headers, method, url });
const rejected = req => {
  const result = consoleVersionError(req, current);
  assert.equal(result.status, 409); assert.equal(result.code, 'CLIENT_VERSION_MISMATCH');
  assert.equal(result.version, current); assert.equal(result.fields.revision, result.error);
  assert.match(result.error, /保留未保存的修改.*刷新页面/);
};

test('同页面每次后台启动都产生独立版本，注入位于脚本之前', () => {
  assert.notEqual(current, stale);
  const rendered = renderVersionedPage(page, current);
  const meta = '<meta name="cw-console-version" content="' + current + '">';
  assert(rendered.includes(meta)); assert(rendered.indexOf(meta) < rendered.indexOf('<script>'));
  assert(rendered.includes('<body>控制台</body>'));
});

test('支持head属性和大小写，重复渲染只保留当前版本', () => {
  const old = '<html><HEAD lang="zh-CN"><META content="obsolete" NAME=\'cw-console-version\'><title>测试</title></HEAD></html>';
  const rendered = renderVersionedPage(renderVersionedPage(old, stale), current);
  assert.equal((rendered.match(/name="cw-console-version"/g) ?? []).length, 1);
  assert(rendered.includes('content="' + current + '"')); assert(!rendered.includes(stale));
  assert(rendered.includes('<title>测试</title>'));
});

test('版本标识拒绝HTML注入、空值和超长输入，缺head不静默放行', () => {
  for (const value of ['', null, 123, '" onclick="bad()', '<script>x</script>', 'x&y', 'x'.repeat(201)]) {
    assert.throws(() => renderVersionedPage(page, value), /版本标识无效/);
  }
  assert.throws(() => renderVersionedPage('<body>test</body>', current), /缺少 head/);
  assert.throws(() => createConsoleVersion(null), /字符串/);
});

test('当前浏览器版本正常写入，重启前的版本即使页面相同也拒绝', () => {
  assert.equal(consoleVersionError(request({ origin: 'http://localhost', 'x-cw-console-version': current }), current), null);
  rejected(request({ origin: 'http://localhost', 'x-cw-console-version': stale }));
  rejected(request({ 'X-CW-Console-Version': stale }));
  assert.equal(consoleVersionError(request({ 'X-CW-Console-Version': current }), current), null);
});

test('旧浏览器缺版本头仍拒绝，Origin/Referer和浏览器Fetch元数据可识别', () => {
  for (const headers of [{ origin: 'http://localhost' }, { referer: 'http://localhost/' },
    { 'sec-fetch-site': 'same-origin' }, { 'Sec-Fetch-Dest': 'empty' }, { 'sec-fetch-user': '?1' }, { Origin: 'null' }]) rejected(request(headers));
});

test('本地脚本无版本头保持兼容，显式旧头不能绕过且空头重复头拒绝', () => {
  assert.equal(consoleVersionError(request(), current), null);
  assert.equal(consoleVersionError(request({ 'user-agent': 'node', 'content-type': 'application/json' }), current), null);
  assert.equal(consoleVersionError(request({ 'sec-fetch-mode': 'cors' }), current), null,'Node fetch默认mode头不代表浏览器');
  assert.equal(consoleVersionError(request({ 'user-agent': 'node', 'Sec-Fetch-Mode': 'cors' }), current), null);
  rejected(request({ 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }));
  rejected(request({ 'sec-fetch-mode': 'cors', 'x-cw-console-version': stale }));
  for (const value of [stale, '', current + ', ' + stale, [current], undefined]) rejected(request({ 'x-cw-console-version': value }));
  rejected(request({ 'x-cw-console-version': current, 'X-CW-Console-Version': stale }));
});

test('GET/HEAD/OPTIONS只读请求不受旧版或缺版本限制', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) for (const headers of [{ origin: 'http://localhost' }, { 'x-cw-console-version': stale }]) {
    assert.equal(consoleVersionError(request(headers, method), current), null);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) rejected(request({ origin: 'http://localhost' }, method));
});

test('专用停止断开路由始终可用，旧页面能停止正在执行的任务', () => {
  for (const route of ['/api/loop/stop', '/api/disconnect', '/api/stages/stop', '/api/pirates/advance/stop',
    '/api/guild/mutual/stop', '/api/trials/stop',  '/api/accounts/alipay-login/cancel', '/api/accounts/phone-login/cancel']) {
    for (const headers of [{ origin: 'http://localhost' }, { 'x-cw-console-version': stale }]) {
      assert.equal(consoleVersionError(request(headers, 'POST', route + '?account=test'), current), null);
    }
  }
});

test('混合启停路由和相似路径不得借停止白名单绕过版本保护', () => {
  for (const route of ['/api/accounts/pause', '/api/loop/auto-start', '/api/loop/start', '/api/loop/stop-extra',
    '/api/settings?next=/api/loop/stop', '/api/loop/stop/']) {
    rejected({ ...request({ origin: 'http://localhost' }, 'POST', route), body: { start: true, autoStart: true } });
  }
  rejected(request({ origin: 'http://localhost' }, 'DELETE', '/api/loop/stop'));
});

console.log('控制台页面版本保护专项 ' + passed + '/' + passed + ' 通过');
