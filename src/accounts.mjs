import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { worldName } from './world-name.mjs';

// 账号身份使用 openId：同一个号重复登录或导入只刷新凭证，不重复创建记录。
// 一条记录 = 一份能登录的凭证 + 一点人类可读的标记（昵称、等级、区服）。
// 自检要在一个临时目录里验证「读 / 写 / 迁移」这条链，所以留一个环境变量出口。
// 正常运行时根本不会设它，路径与原来一致。
export const DATA_DIR = process.env.CW_DATA_DIR
  ? path.resolve(process.env.CW_DATA_DIR)
  : path.resolve(import.meta.dirname, '../data');
export const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');
// 早期版本只有一个账号，凭证写在这个文件里。现在只作为迁移来源与备份，不再写。
export const LEGACY_CREDENTIALS_PATH = path.join(DATA_DIR, 'credentials.json');

function emptyStore() {
  return { version: 1, activeId: null, accounts: [] };
}

export function accountId(credential) {
  const id = credential?.login?.eworldParams?.openId;
  if (typeof id !== 'string' || !id) return null;
  if (credential.source === 'alipay') return 'alipay:' + id;
  return ['douyin', 'douyin-mitm'].includes(credential.source) ? 'douyin:' + id : id;
}

export function loginProfiles(store, credential) {
  const identity = accountId(credential);
  if (!identity) return store.accounts.filter(account => account.id === credential.id);
  return store.accounts.filter(account => accountId(account) === identity);
}

// 合服后的实际区服可能相同，登录入口（出生服）仍能区分两个角色。
export function worldProfileId(credential) {
  const world = Number(credential.login?.worldId);
  if (!Number.isSafeInteger(world) || world <= 0) return null;
  return 'role:' + createHash('sha256').update(JSON.stringify([accountId(credential), world])).digest('hex');
}

export function matchingProfile(store, credential, world = credential.login?.worldId) {
  const profiles = loginProfiles(store, credential);
  if (!Number(world)) return profiles.find(row => row.id === store.activeId) ?? profiles[0];
  return profiles.find(row => Number(row.login.worldId) === Number(world))
    ?? profiles.find(row => !Number(row.login.worldId));
}

// 网页和 CLI 要的都是这一小块，凭证本体不往外散。
export function toCredential(account) {
  return {
    url: account.url,
    login: account.login,
    ...(account.loginFrameHex ? { loginFrameHex: account.loginFrameHex } : {}),
    source: account.source ?? 'mitm',
    capturedAt: account.capturedAt ?? null,
  };
}

export function accountFromCredential(credential, { label = null, now = new Date().toISOString() } = {}) {
  const id = accountId(credential);
  if (!id) throw new Error('这份凭证里没有 login.eworldParams.openId，认不出是哪个账号');
  const url = credential.url || credential.wsUrl;
  const login = credential.login || credential.body;
  if (!url || !login) throw new Error('凭证必须同时有 url 和 login');
  return {
    id,
    label,
    url,
    login,
    loginFrameHex: credential.loginFrameHex ?? null,
    source: credential.source ?? 'mitm',
    capturedAt: credential.capturedAt ?? null,
    addedAt: now,
    lastSeen: null,
    automation: { enabled: false, autoStart: false },
  };
}

// 文件不存在或读坏时不让整条命令挂掉，调用方拿到的要么是空仓库要么是旧凭证合成的一条。
export function loadStore() {
  if (fs.existsSync(ACCOUNTS_PATH)) {
    return normalizeStore(JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')));
  }
  if (fs.existsSync(LEGACY_CREDENTIALS_PATH)) {
    const credential = JSON.parse(fs.readFileSync(LEGACY_CREDENTIALS_PATH, 'utf8'));
    const account = accountFromCredential(credential, { label: null });
    return { ...emptyStore(), activeId: account.id, accounts: [account] };
  }
  return emptyStore();
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  store.accounts = accounts.filter((account) => account && typeof account.id === 'string' && account.url && account.login);
  const active = store.accounts.find((account) => account.id === raw.activeId);
  store.activeId = active ? active.id : (store.accounts[0]?.id ?? null);
  return store;
}

export function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ACCOUNTS_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, ACCOUNTS_PATH);
}

export function refreshProfileLogin(profile, credential, worldId = profile.login.worldId) {
  profile.login = { ...credential.login, ...(worldId != null ? { worldId } : {}) };
  profile.url = credential.url;
  profile.source = credential.source;
  profile.capturedAt = credential.capturedAt;
  profile.loginFrameHex = Number(worldId || 0) === Number(credential.login.worldId || 0) ? credential.loginFrameHex : null;
}

// 抓到同一账号的新凭证就地刷新，各角色保留自己的登录入口、人工备注和配置。
export function upsertAccount(store, credential, { label = null, now = new Date().toISOString(), refreshCredentials = true } = {}) {
  const fresh = accountFromCredential(credential, { label, now });
  const profiles = loginProfiles(store, credential);
  const existing = matchingProfile(store, credential);
  // 同一登录身份刷新一次凭据，所有入口使用新票据，各自保留登录区服。
  for (const profile of profiles) {
    if (!refreshCredentials && profile !== existing) continue;
    const worldId = profile === existing && Number(fresh.login.worldId) ? fresh.login.worldId : profile.login.worldId;
    refreshProfileLogin(profile, fresh, worldId);
  }
  if (!existing) {
    if (profiles.length) {
      fresh.id = worldProfileId(fresh);
      fresh.automation.paused = true;
    }
    if (store.accounts.some(row => row.id === fresh.id)) throw new Error('角色记录标识冲突');
    store.accounts.push(fresh);
    if (!store.activeId) store.activeId = fresh.id;
    return { account: fresh, created: true };
  }
  if (label !== null) existing.label = label;
  return { account: existing, created: false };
}

export function rememberSeen(account, player, now = new Date().toISOString()) {
  if (!account) return;
  account.lastSeen = {
    nickname: player?.nickname ?? account.lastSeen?.nickname ?? null,
    level: player?.level ?? account.lastSeen?.level ?? null,
    power: player?.power ?? account.lastSeen?.power ?? null,
    worldId: player?.worldId ?? account.lastSeen?.worldId ?? null,
    at: now,
  };
  if (!account.label && account.lastSeen.nickname) account.label = account.lastSeen.nickname;
}

export function removeAccount(store, id) {
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((account) => account.id !== id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id ?? null;
  return store.accounts.length !== before;
}

export function setActive(store, id) {
  if (!store.accounts.some((account) => account.id === id)) throw new Error(`没有账号 ${id}`);
  store.activeId = id;
}

// 选择顺序：显式指定（id / 昵称 / 1 起的序号）→ 当前选中 → 只有一条就用它。
export function pickAccount(store, selector = null) {
  if (selector !== null && selector !== undefined && selector !== '') {
    const wanted = String(selector).trim();
    const byId = store.accounts.find((account) => account.id === wanted);
    if (byId) return byId;
    const byLabel = store.accounts.find((account) => account.label && account.label === wanted);
    if (byLabel) return byLabel;
    const order = Number(wanted);
    if (Number.isInteger(order) && order >= 1 && order <= store.accounts.length) return store.accounts[order - 1];
    const partial = store.accounts.filter((account) => account.id.startsWith(wanted) || (account.label ?? '').includes(wanted));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`"${wanted}" 匹配到多个账号: ${partial.map((account) => describeAccount(account).title).join(', ')}`);
    throw new Error(`找不到账号 "${wanted}"`);
  }
  if (store.activeId) {
    const active = store.accounts.find((account) => account.id === store.activeId);
    if (active) return active;
  }
  return store.accounts[0] ?? null;
}

// 控制台的账号描述只包含打码后的凭证信息。
function mask(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(8)}${text.slice(-4)}`;
}

export function describeAccount(account, { active = false, hasSiblingRoles = false } = {}) {
  const params = account.login?.eworldParams ?? {};
  const lastSeen = account.lastSeen
    ? { ...account.lastSeen, worldName: worldName(account.lastSeen.worldId) }
    : null;
  const scanChannel = ['alipay', 'wechat', 'douyin', 'douyin-mitm'].includes(account.source);
  const channelName = account.source === 'alipay' ? '支付宝' : account.source === 'wechat' ? '微信' : '抖音';
  let title = account.label || lastSeen?.nickname || (scanChannel
    ? `${channelName}账号 ${String(params.openId ?? '').slice(-6)}` : `账号 ${account.id.slice(0, 6)}`);
  if (scanChannel && lastSeen?.nickname) {
    const remark = account.label && account.label !== lastSeen.nickname ? account.label : null;
    title = [remark, lastSeen.nickname, lastSeen.worldName].filter(Boolean).join(' · ');
  }
  const loginWorld = account.login?.worldId;
  const loginWorldName = worldName(loginWorld) || String(loginWorld || '');
  if (hasSiblingRoles && loginWorldName && (!scanChannel || !lastSeen?.nickname || loginWorld !== lastSeen.worldId)) {
    title += ' · ' + loginWorldName;
  }
  return {
    id: account.id,
    title,
    hasSiblingRoles,
    loginWorldName,
    label: account.label ?? null,
    url: account.url,
    source: account.source,
    capturedAt: account.capturedAt,
    addedAt: account.addedAt,
    lastSeen,
    active,
    masked: {
      openId: mask(params.openId),
      token: mask(params.token),
      sign: mask(params.sign),
    },
    hasFrame: Boolean(account.loginFrameHex),
  };
}

export function revealAccount(account) {
  const params = account.login?.eworldParams ?? {};
  return {
    ...describeAccount(account),
    raw: {
      openId: params.openId ?? null,
      token: params.token ?? null,
      timestamp: params.timestamp ?? null,
      sign: params.sign ?? null,
    },
    loginFrameHex: account.loginFrameHex ?? null,
  };
}
