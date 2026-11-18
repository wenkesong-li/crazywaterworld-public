import { createHash, randomUUID } from 'node:crypto';
import { ensureHeadlessBrowser } from './platform/browser.mjs';
import { exchangeDouyinCredential, findDouyinGameResources, safeDouyinGameAuthError } from './douyin-game-auth.mjs';

const OFFICIAL_URL = 'https://www.douyin.com/';
const ACTIVE_PHASES = new Set(['starting', 'waiting', 'verifying', 'authorizing']);
const START_TIMEOUT_MS = 12 * 60_000;
const QR_TIMEOUT_MS = 5 * 60_000;
const VERIFICATION_TIMEOUT_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 3 * 60_000;
const CAPTURED_TIMEOUT_MS = 10 * 60_000;
const VERIFY_PHONE = '请用抖音扫描上方验证二维码，并在手机完成官方身份验证。';
const VERIFY_WEB = '抖音要求额外安全验证，请按官方提示完成验证；若没有可扫描的验证二维码，可稍后重试。';
const VERIFY_WINDOW = '抖音官网要求页面验证。请在已打开的临时抖音官方窗口完成验证，完成后这里会继续显示登录二维码。';

function officialPage(url) {
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && (target.hostname === 'douyin.com' || target.hostname.endsWith('.douyin.com')
      || target.hostname === 'api.amemv.com');
  } catch { return false; }
}

async function launchBrowser({ signal, headless } = {}) {
  signal?.throwIfAborted();
  const executablePath = await ensureHeadlessBrowser();
  signal?.throwIfAborted();
  const { chromium } = await import('playwright-core');
  signal?.throwIfAborted();
  return chromium.launch({ executablePath, headless, timeout: 30_000 });
}

// This runs in the official page. The old login panel may remain below a phone
// verification portal, so visibility includes hit-testing and document order.
export function inspectDouyinLoginDom() {
  function visible(node, sampleCorners = false) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    // The official QR has a sibling logo over its centre. Several inner samples
    // distinguish this small overlay from an old QR covered by a verification portal.
    const points = sampleCorners ? [[0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82], [0.5, 0.5]] : [[0.5, 0.5]];
    let exposed = 0;
    for (const [dx, dy] of points) {
      const x = rect.left + rect.width * dx, y = rect.top + rect.height * dy;
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (top && (node === top || node.contains(top) || top.contains(node))) exposed++;
    }
    return exposed >= (sampleCorners ? 3 : 1);
  }
  function panelText(node) {
    let text = '';
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const value = (node.innerText || '').trim();
      if (value.length > 1200) break;
      if (value) text = value;
      if (node.getAttribute?.('role') === 'dialog') break;
    }
    return text;
  }
  const textNodes = Array.from(document.querySelectorAll('div,span,p,h1,h2,h3')).filter(node => {
    const text = (node.innerText || '').trim();
    return text.length > 0 && text.length < 160 && /手机刷脸验证|身份验证|安全验证|完成验证|二维码已过期|二维码已失效|二维码失效/.test(text) && visible(node);
  });
  const visibleText = textNodes.map(node => node.innerText).join('\n');
  const challenge = /验证码中间页|安全验证|访问验证|人机验证/.test(document.title || '');
  const verification = /手机刷脸验证|身份验证|安全验证|完成验证/.test(visibleText);
  const images = Array.from(document.querySelectorAll('img[alt="二维码"],img[alt*="二维码"],img[aria-label="二维码"],#douyin_login_comp_scan_code_qrcode img')).filter(node => {
    const rect = node.getBoundingClientRect();
    return node.complete && node.naturalWidth >= 80 && rect.width >= 80 && rect.height >= 80 && visible(node, true);
  });
  const node = images.at(-1);
  if (!node) return { verification, challenge, expired: /二维码已过期|二维码已失效|二维码失效/.test(visibleText), image: null, clip: null };
  const rect = node.getBoundingClientRect();
  const text = panelText(node);
  let image = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    canvas.getContext('2d').drawImage(node, 0, 0);
    image = canvas.toDataURL('image/png');
  } catch { /* A cross-origin image can still be captured from its visible box. */ }
  return {
    verification: verification || /手机刷脸验证|身份验证|安全验证/.test(text),
    challenge,
    expired: /二维码已过期|二维码已失效|二维码失效/.test(text),
    image,
    clip: { x: Math.max(0, rect.left), y: Math.max(0, rect.top),
      width: Math.min(rect.right, innerWidth) - Math.max(0, rect.left),
      height: Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top) },
  };
}

export async function readDouyinLoginPage(page) {
  const state = await page.evaluate(inspectDouyinLoginDom);
  let image = state.image;
  if (!image && state.clip?.width >= 80 && state.clip?.height >= 80) {
    image = 'data:image/png;base64,' + (await page.screenshot({ type: 'png', clip: state.clip, timeout: 5000 })).toString('base64');
  }
  return { image, verification: state.verification === true, challenge: state.challenge === true, expired: state.expired === true };
}

function validImage(image) {
  return typeof image === 'string' && image.length <= 3_000_000 && /^data:image\/png;base64,[a-z\d+/]+=*$/i.test(image);
}

function validCredential(credential) {
  const params = credential?.login?.eworldParams;
  try {
    return credential?.source === 'douyin' && credential.url === 'wss://dhyaoj-gate.khlgamen.com/ws'
      && ['openId', 'token', 'sign'].every(key => typeof params?.[key] === 'string' && params[key].trim())
      && BigInt(params.timestamp) > 0n && credential.login.worldId === 0 && !!credential.login.eworldClientInfo;
  } catch { return false; }
}

function exchangeMessage(error) {
  return safeDouyinGameAuthError(error).message;
}

export function createDouyinLogin({
  launch = launchBrowser,
  exchange = exchangeDouyinCredential,
  prepare = exchange === exchangeDouyinCredential ? () => findDouyinGameResources() : () => {},
  readPage = readDouyinLoginPage,
  now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  startTimeoutMs = START_TIMEOUT_MS,
  qrTimeoutMs = QR_TIMEOUT_MS,
  verificationTimeoutMs = VERIFICATION_TIMEOUT_MS,
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
  capturedTimeoutMs = CAPTURED_TIMEOUT_MS,
  pollIntervalMs = 1000,
  headless = process.platform !== 'win32',
} = {}) {
  let current = null;
  let closed = false;
  const sessions = new Set();

  function snapshot(session) {
    return { id: session?.id ?? null, phase: session?.phase ?? 'cancelled', qrImage: session?.qrImage ?? null,
      expiresAt: session?.expiresAt ?? null, error: session?.error ?? null, verification: session?.verification ?? null };
  }
  function live(session) { return !closed && current === session && ACTIVE_PHASES.has(session.phase); }
  function release(session) {
    if (session.setupDone && session.disposed && !ACTIVE_PHASES.has(session.phase) && session.phase !== 'captured') sessions.delete(session);
  }
  function clearTimer(session, key) {
    if (session[key] !== null) unschedule(session[key]);
    session[key] = null;
  }
  async function dispose(session) {
    if (session.disposing) return session.disposing;
    const browser = session.browser, context = session.context;
    session.browser = null; session.context = null; session.page = null; session.pages.clear();
    session.disposing = (async () => {
      try { await context?.close(); } catch { /* Continue closing the browser. */ }
      try { await browser?.close(); } catch { /* The browser may already be disconnected. */ }
    })();
    await session.disposing;
    session.disposed = true;
    release(session);
  }
  function finish(session, phase, error = null) {
    clearTimer(session, 'timer'); clearTimer(session, 'pollTimer');
    session.abort.abort();
    session.phase = phase; session.error = error; session.qrImage = null; session.qrKey = null; session.verification = null;
    if (phase !== 'captured') session.credential = null;
    session.ready();
    void dispose(session);
  }
  function deadline(session, expiresAt, phase, message) {
    clearTimer(session, 'timer');
    session.expiresAt = expiresAt; session.expiryPhase = phase; session.expiryMessage = message;
    session.timer = schedule(() => {
      if (current === session && !closed && (ACTIVE_PHASES.has(session.phase) || session.phase === 'captured')) finish(session, phase, message);
    }, Math.max(0, expiresAt - now()));
    session.timer?.unref?.();
  }
  function expire(session) {
    if (session && (ACTIVE_PHASES.has(session.phase) || session.phase === 'captured') && session.expiresAt <= now()) {
      finish(session, session.expiryPhase, session.expiryMessage);
    }
  }
  function selected(id) {
    if (id && current?.id !== id) throw new Error('本次抖音扫码登录已失效，请重新生成二维码。');
    expire(current); return current;
  }
  function armPoll(session) {
    if (!live(session) || session.phase === 'authorizing' || session.pollTimer !== null) return;
    session.pollTimer = schedule(() => { session.pollTimer = null; void poll(session); }, pollIntervalMs);
    session.pollTimer?.unref?.();
  }
  async function authorize(session, sessionId) {
    if (!live(session) || session.phase === 'authorizing') return;
    session.phase = 'authorizing'; session.qrImage = null; session.verification = null;
    clearTimer(session, 'pollTimer');
    deadline(session, now() + exchangeTimeoutMs, 'error', '抖音游戏登录超时，请检查网络和游戏资源后重新扫码。');
    session.ready();
    let userAgent;
    try { userAgent = await session.page?.evaluate(() => navigator.userAgent); } catch { /* Optional environment information. */ }
    if (!live(session)) return;
    // The website cookie is handed only to the platform exchange, never returned
    // in status or stored with the resulting game credential.
    try {
      const credential = await exchange({ sessionId, signal: session.abort.signal, userAgent });
      expire(session);
      if (!live(session)) return;
      if (!validCredential(credential)) throw new Error('Incomplete game credential');
      session.credential = structuredClone(credential);
      finish(session, 'captured');
      deadline(session, now() + capturedTimeoutMs, 'expired', '抖音登录结果已过期，请重新扫码。');
    } catch (error) {
      if (live(session)) finish(session, 'error', exchangeMessage(error));
    }
  }
  async function passportResponse(session, response) {
    if (!live(session) || session.phase === 'authorizing') return;
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (!officialPage(url.href) || !/\/passport\//.test(url.pathname) || !/qr|login|verify|sso/.test(url.pathname)) return;
    let result;
    try { result = await response.json(); } catch { return; }
    if (!live(session) || session.phase === 'authorizing') return;
    // Passport results are hints only. A cookie from the isolated official
    // browser context is required before exchange. Old QR polling responses can
    // arrive after a refresh: only the currently visible DOM/deadline expires it.
    session.passportSeen = result?.data?.status !== undefined || result?.message !== undefined;
    void poll(session);
  }
  function watchPage(session, page) {
    if (session.pages.has(page)) return;
    session.pages.add(page);
    page.on('crash', () => { if (live(session) && session.pages.has(page)) finish(session, 'error', '抖音登录页面意外退出，请重新生成二维码。'); });
    page.on('close', () => {
      const removed = session.pages.delete(page);
      if (removed && live(session) && session.pages.size === 0) finish(session, 'error', '抖音登录页面已关闭，请重新生成二维码。');
    });
  }
  async function poll(session) {
    expire(session);
    if (!live(session) || session.phase === 'authorizing' || session.polling || !session.context) return;
    session.polling = true;
    try {
      const cookies = await session.context.cookies(OFFICIAL_URL);
      if (!live(session) || session.phase === 'authorizing') return;
      const cookie = cookies.find(value => value.name === 'sessionid' && /^(?:\.?douyin\.com|www\.douyin\.com)$/.test(value.domain)
        && typeof value.value === 'string' && value.value.length > 0 && value.value.length <= 4096
        && !/[\r\n]/.test(value.value) && (value.expires <= 0 || value.expires * 1000 > now()));
      if (cookie) { void authorize(session, cookie.value); return; }
      let found = null;
      for (const page of [...session.pages].reverse()) {
        if (!officialPage(page.url())) continue;
        const state = await readPage(page);
        if (!live(session) || session.phase === 'authorizing') return;
        if (state?.challenge || state?.verification || state?.image || state?.expired) { found = state; break; }
      }
      session.readFailures = 0;
      if (session.pageChallenge && !found?.challenge) {
        session.pageChallenge = false;
        if (!found?.image && !found?.verification) { session.phase = 'starting'; session.verification = null; }
      }
      if (!found) {
        if (session.phase === 'starting' && session.loginEntryAttempts < 8
          && now() - session.lastEntryAttemptAt >= 5000) {
          session.lastEntryAttemptAt = now();
          if (await openLoginEntry(session.page)) session.loginEntryAttempts++;
        }
        return;
      }
      if (found.challenge) {
        if (headless) {
          finish(session, 'error', '抖音官网要求人工页面验证，当前无头浏览器无法完成。请在有桌面的 Windows 中扫码重试。');
          return;
        }
        if (session.phase !== 'verifying') deadline(session, now() + verificationTimeoutMs, 'expired', '抖音官网页面验证已超时，请重新生成二维码。');
        session.pageChallenge = true;
        session.phase = 'verifying'; session.verification = VERIFY_WINDOW; session.qrImage = null; session.qrKey = null;
        session.ready();
        return;
      }
      if (found.expired) { finish(session, 'expired', '抖音二维码已过期，请重新生成后扫码。'); return; }
      const image = validImage(found.image) ? found.image : null;
      const key = image ? createHash('sha256').update(image).digest('hex') : null;
      const enteringVerification = found.verification && session.phase !== 'verifying';
      if (found.verification) {
        session.phase = 'verifying'; session.verification = image ? VERIFY_PHONE : headless ? VERIFY_WEB : VERIFY_WINDOW;
        if (enteringVerification) {
          deadline(session, now() + verificationTimeoutMs, 'expired', '抖音身份验证已超时，请重新扫码并在手机完成验证。');
        }
      } else if (image) { session.phase = 'waiting'; session.verification = null; }
      if (key && key !== session.qrKey) {
        session.qrKey = key; session.qrImage = image;
        if (!found.verification) deadline(session, now() + qrTimeoutMs, 'expired', '抖音二维码已过期，请重新生成后扫码。');
      } else if (found.verification && !image) { session.qrKey = null; session.qrImage = null; }
      if (image || found.verification) session.ready();
    } catch {
      if (live(session) && session.phase !== 'authorizing' && ++session.readFailures >= 5) {
        finish(session, 'error', '无法读取抖音登录页面，请检查网络后重新生成二维码。');
      }
    } finally { session.polling = false; armPoll(session); }
  }
  async function openLoginEntry(page) {
    const choices = [page.locator('#douyin-header').getByText('登录', { exact: true }), page.getByRole('button', { name: '登录', exact: true })];
    for (const locator of choices) {
      try {
        const count = Math.min(await locator.count(), 8);
        for (let index = 0; index < count; index++) {
          const entry = locator.nth(index);
          if (await entry.isVisible()) { await entry.click({ timeout: 3000 }); return true; }
        }
      } catch { /* The homepage may already have opened the login portal. */ }
    }
    return false;
  }
  async function initialize(session) {
    let stage = 'resources';
    try {
      await prepare({ signal: session.abort.signal });
      if (!live(session)) return;
      stage = 'browser';
      const browser = await launch({ signal: session.abort.signal, headless });
      if (!live(session)) { await browser.close().catch(() => {}); return; }
      session.browser = browser;
      browser.on('disconnected', () => {
        if (live(session) && !session.disposing) finish(session, 'error', '临时抖音登录浏览器已断开，请重新生成二维码。');
      });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      if (!live(session)) { await context.close().catch(() => {}); return; }
      session.context = context;
      context.on('page', page => watchPage(session, page));
      context.on('response', response => { void passportResponse(session, response).catch(() => {}); });
      const page = await context.newPage();
      if (!live(session)) { await page.close().catch(() => {}); return; }
      session.page = page; watchPage(session, page);
      await page.goto(OFFICIAL_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!live(session)) return;
      await poll(session);
      armPoll(session);
    } catch (error) {
      if (live(session)) finish(session, 'error', stage === 'resources' ? exchangeMessage(error)
        : '无法打开抖音登录页面。请检查浏览器运行权限、下载网络或 CW_BROWSER_EXECUTABLE 设置后重试。');
    }
  }
  function start() {
    if (closed) return Promise.reject(new Error('控制台已关闭，无法开始抖音扫码登录。'));
    expire(current);
    if (current && (ACTIVE_PHASES.has(current.phase) || current.phase === 'captured')) {
      const session = current;
      return session.startPromise.then(() => snapshot(session));
    }
    const session = { id: randomUUID(), phase: 'starting', qrImage: null, qrKey: null, verification: null, error: null,
      expiresAt: now() + startTimeoutMs, credential: null, timer: null, pollTimer: null, polling: false, readFailures: 0,
      loginEntryAttempts: 0, lastEntryAttemptAt: -Infinity,
      browser: null, context: null, page: null, pages: new Set(), disposing: null, abort: new AbortController(), passportSeen: false };
    session.readyPromise = new Promise(resolve => { session.ready = resolve; });
    session.startPromise = session.readyPromise;
    current = session; sessions.add(session);
    deadline(session, session.expiresAt, 'error', '浏览器准备或抖音二维码生成超时，请检查网络后重试。');
    session.setupPromise = initialize(session);
    void session.setupPromise.finally(() => { session.setupDone = true; release(session); });
    return session.startPromise.then(() => snapshot(session));
  }
  return {
    start,
    status(id) { return snapshot(selected(id)); },
    async cancel(id) {
      const session = selected(id);
      if (!session) return snapshot(null);
      finish(session, 'cancelled'); await dispose(session); return snapshot(session);
    },
    async close() {
      closed = true;
      const pending = [...new Set([...sessions, current].filter(Boolean))];
      for (const session of pending) finish(session, 'cancelled');
      await Promise.all(pending.map(dispose));
      await Promise.allSettled(pending.map(session => session.setupPromise));
      sessions.clear();
    },
    takeCredential(id) {
      const session = selected(id);
      if (session?.phase !== 'captured' || !session.credential) throw new Error('尚未取得抖音游戏登录凭证，请完成扫码和身份验证。');
      return structuredClone(session.credential);
    },
  };
}
