import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../accounts.mjs';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

export const GIFT_CODE_SOURCE = 'https://m.ali213.net/news/gl2602/1747967.html';
export const giftDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const expiredDate = (date, now) => date && Date.parse(date + 'T23:59:59.999+08:00') < now;
export const hasGiftCodeHistory = row => row.status==='skipped'?String(row.detail??'').includes('已有兑换记录')
  :row.status==='rejected'?(row.promptName!=='GIFT_CODE_TOO_MANY_REQUESTS'&&row.detail!=='请求过于频繁')
    :['success','used','unknown','sending','queued'].includes(row.status);
const plainText = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<(?:br\b[^>]*|\/p|\/div|\/li|\/h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name.toLowerCase()]);

export function parseGiftCodeArticle(html) {
  const text = plainText(html);
  if (!text.includes('疯狂水世界')) throw Error('来源页面不是疯狂水世界礼包码文章');
  const start = /一[、.．]\s*兑换码/.exec(text), end = /二[、.．]\s*使用方式/.exec(text);
  if (!start || !end || end.index <= start.index) throw Error('来源页面格式已变化，保留原有码库');
  const rows = new Map();
  for (const line of text.slice(start.index + start[0].length, end.index).split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /兑换码[：:]?$/.test(value)) continue;
    const match = /^([\p{L}\p{N}_-]{1,128})(?:[（(]有效期至\s*(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[）)])?$/u.exec(value);
    if (!match) throw Error('来源页面含无法识别的礼包码条目，保留原有码库');
    const expiresAt = match[2] ? `${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}` : null;
    if (expiresAt && new Date(expiresAt + 'T00:00:00Z').toISOString().slice(0, 10) !== expiresAt) throw Error('来源页面有效期格式异常');
    rows.set(match[1], { code: match[1], expiresAt });
  }
  if (!rows.size) throw Error('来源页面没有解析到礼包码，保留原有码库');
  const updated = /更新时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(text);
  return { rows: [...rows.values()], sourceUpdatedAt: updated ? new Date(updated[1] + 'T' + updated[2] + '+08:00').toISOString() : null };
}

export function createGiftCodeLibrary({ directory = DATA_DIR, now = Date.now, fetcher = fetch } = {}) {
  const catalogFile = path.join(directory, 'public-gift-codes.json'), preferenceFile = path.join(directory, 'gift-code-preferences.json');
  const manualFile = path.join(directory, 'shared-gift-codes.json');
  const read = () => {
    const data = readJson(catalogFile, { version: 1, codes: [], expired: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.expired)) throw Error('公共礼包码数据库无效');
    return data;
  };
  const preferences = () => {
    const data = readJson(preferenceFile, { version: 1, accounts: [] });
    if (data?.version !== 1 || !Array.isArray(data.accounts)) throw Error('自动兑换设置无效');
    return data;
  };
  // 手动添加的礼包码全账号共享；旧版本按账号保存的手动码一次性迁移合并到共享库。
  const sharedCodes = () => withFileLock(manualFile, () => {
    const data = readJson(manualFile, { version: 1, codes: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes)) throw Error('共享礼包码数据库无效');
    const legacy = preferences().accounts.filter(account => Array.isArray(account.manualCodes) && account.manualCodes.length);
    if (legacy.length) withFileLock(preferenceFile, () => {
      const prefs = preferences();
      const merged = new Map(data.codes.map(row => [row.code, row]));
      for (const account of prefs.accounts) {
        for (const row of account.manualCodes ?? []) {
          const known = merged.get(row.code);
          merged.set(row.code, known
            ? { ...known, expiresAt: row.expiresAt && (!known.expiresAt || row.expiresAt < known.expiresAt) ? row.expiresAt : known.expiresAt }
            : { code: row.code, expiresAt: row.expiresAt ?? null, firstSeenAt: row.firstSeenAt ?? new Date(now()).toISOString() });
        }
        account.manualCodes = [];
      }
      data.codes = [...merged.values()];
      atomicJson(manualFile, data); atomicJson(preferenceFile, prefs);
    });
    return data;
  });
  const changePreference = (id, work) => withFileLock(preferenceFile, () => {
    const data = preferences();
    let account = data.accounts.find(entry => entry.id === id);
    if (!account) { account = { id, enabled: false }; data.accounts.push(account); }
    work(account); atomicJson(preferenceFile, data); return { ...account };
  });
  let fetching = null;
  const library = {
    pruneExpired() {
      if(!read().codes.some(row=>expiredDate(row.expiresAt,now())))return;
      withFileLock(catalogFile,()=>{const data=read(),expired=new Set(data.expired.map(row=>row.code));
        data.codes=data.codes.filter(row=>{if(!expiredDate(row.expiresAt,now()))return true;if(!expired.has(row.code)){data.expired.push({code:row.code,reason:'来源注明的有效期已结束',at:new Date(now()).toISOString()});expired.add(row.code);}return false;});atomicJson(catalogFile,data);});
    },
    isExpired(code) { const data=read();return data.expired.some(entry => entry.code === code)||data.codes.some(entry=>entry.code===code&&expiredDate(entry.expiresAt,now())); },
    expire(code, reason = '游戏服务器明确返回礼包码已过期') {
      withFileLock(catalogFile, () => {
        const data = read();
        if (data.expired.some(entry => entry.code === code)) return;
        data.codes = data.codes.filter(entry => entry.code !== code);
        data.expired.push({ code, reason, at: new Date(now()).toISOString() });
        atomicJson(catalogFile, data);
      });
    },
    reconcile(rows) {
      library.pruneExpired();
      const known=new Set(read().expired.map(row=>row.code));
      for (const row of rows) if (!known.has(row.code)&&row.status === 'rejected' && (row.promptName === 'GIFT_CODE_EXPIRED' || row.detail === '礼包码已过期')) {library.expire(row.code);known.add(row.code);}
    },
    entries() {
      library.pruneExpired();
      const data=read(),expired=new Set(data.expired.map(row=>row.code));
      const codes=new Map(data.codes.map(row=>[row.code,{...row,manual:false}]));
      for(const row of sharedCodes().codes){
        if(expired.has(row.code)||expiredDate(row.expiresAt,now())){codes.delete(row.code);continue;}
        const publicRow=codes.get(row.code);
        codes.set(row.code,publicRow?{...publicRow,expiresAt:row.expiresAt&&(!publicRow.expiresAt||row.expiresAt<publicRow.expiresAt)?row.expiresAt:publicRow.expiresAt,manual:true}:{...row,manual:true});
      }
      return [...codes.values()];
    },
    available(rows) {
      library.pruneExpired();
      const unavailable = new Set(rows.filter(hasGiftCodeHistory).map(row => row.code));
      return library.entries().filter(row => !expiredDate(row.expiresAt, now()) && !unavailable.has(row.code)).map(row => row.code);
    },
    view() {
      library.pruneExpired();
      const data = read(), codes = data.codes.filter(row => !expiredDate(row.expiresAt, now()));
      return { source: GIFT_CODE_SOURCE, updatedAt: data.sourceUpdatedAt, lastSyncedAt: data.lastSuccessAt ?? null,
        lastError: data.lastError ?? '', dailyTime: '每天北京时间 08:00（当天已成功抓取则使用缓存）', total: codes.length, unique: codes.length,
        expired: data.expired.length, codes, tryCodes: codes.map(row => row.code),
        revision: createHash('sha256').update(codes.map(row => row.code).join('\n')).digest('hex') };
    },
    auto(id) { return { enabled: false, ...preferences().accounts.find(entry => entry.id === id) }; },
    accountRevision() { return createHash('sha256').update(JSON.stringify(library.entries().map(row=>[row.code,row.expiresAt]))).digest('hex'); },
    addManual(code,expiresAt) {
      if(typeof code!=='string'||!/^[\p{L}\p{N}_-]{1,128}$/u.test(code.trim()))throw Error('礼包码需为1至128个汉字、字母、数字、下划线或短横线');
      code=code.trim();expiresAt=expiresAt||null;
      if(expiresAt&&(typeof expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)||new Date(expiresAt+'T00:00:00Z').toISOString().slice(0,10)!==expiresAt||expiredDate(expiresAt,now())))throw Error('到期日期无效或已经过期');
      if(library.isExpired(code))throw Error('该礼包码已全局下架，不能再次添加');
      withFileLock(manualFile,()=>{const data=sharedCodes();const rows=data.codes;data.codes=[...rows.filter(row=>row.code!==code),{code,expiresAt,firstSeenAt:rows.find(row=>row.code===code)?.firstSeenAt??new Date(now()).toISOString()}];atomicJson(manualFile,data);});
    },
    setAuto(id, enabled) {
      if (typeof enabled !== 'boolean') throw Error('自动兑换开关必须为布尔值');
      return changePreference(id, account => { if (account.enabled !== enabled) { account.lastRunKey = ''; account.lastAttemptAt = 0; } account.enabled = enabled; });
    },
    removeAccount(id) { if(!preferences().accounts.some(account=>account.id===id))return;withFileLock(preferenceFile,()=>{const data=preferences();data.accounts=data.accounts.filter(account=>account.id!==id);atomicJson(preferenceFile,data);}); },
    attempt(id, key) { return changePreference(id, account => { account.lastRunKey = key; account.lastAttemptAt = now(); }); },
    retry(id, key) { return changePreference(id, account => { if (account.lastRunKey === key) account.lastRunKey = ''; }); },
    async refresh({ force = false } = {}) {
      if (fetching) return fetching;
      const data = read(), time = now();
      if (data.lastSuccessAt && giftDay(Date.parse(data.lastSuccessAt)) === giftDay(time)) return library.view();
      if (data.lastAttemptAt && time - data.lastAttemptAt < (force ? 60000 : 3600000) || data.leaseUntil > time) return library.view();
      const claimed = withFileLock(catalogFile, () => {
        const latest = read(); if (latest.leaseUntil > now()) return false;
        latest.lastAttemptAt = now(); latest.leaseUntil = now() + 90000; atomicJson(catalogFile, latest); return true;
      });
      if (!claimed) return library.view();
      fetching = (async () => {
        try {
          const response = await fetcher(GIFT_CODE_SOURCE, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'CrazyWaterWorld-GiftCatalog/1.0', accept: 'text/html' } });
          if (!response.ok) throw Error('来源站点返回 HTTP ' + response.status);
          const chunks = []; let size = 0;
          for await (const chunk of response.body) { size += chunk.byteLength; if (size > 2 * 1024 * 1024) { response.body.cancel?.().catch(() => {}); throw Error('来源页面超过大小限制'); } chunks.push(Buffer.from(chunk)); }
          const parsed = parseGiftCodeArticle(Buffer.concat(chunks).toString('utf8'));
          withFileLock(catalogFile, () => {
            const latest = read(), expired = new Set(latest.expired.map(row => row.code));
            const entries = new Map(latest.codes.map(row => [row.code, row]));
            for (const row of parsed.rows) {
              if (expired.has(row.code)) continue;
              if (expiredDate(row.expiresAt, now())) { entries.delete(row.code); latest.expired.push({ code: row.code, reason: '来源注明的有效期已结束', at: new Date(now()).toISOString() }); expired.add(row.code); continue; }
              entries.set(row.code, { ...entries.get(row.code), ...row, firstSeenAt: entries.get(row.code)?.firstSeenAt ?? new Date(now()).toISOString(),lastSeenAt:new Date(now()).toISOString() });
            }
            Object.assign(latest, { codes: [...entries.values()], sourceUpdatedAt: parsed.sourceUpdatedAt, lastSuccessAt: new Date(now()).toISOString(), lastError: '', leaseUntil: 0 });
            atomicJson(catalogFile, latest);
          });
        } catch (error) {
          withFileLock(catalogFile, () => { const latest = read(); latest.lastError = error.message; latest.leaseUntil = 0; atomicJson(catalogFile, latest); });
          throw error;
        }
        return library.view();
      })().finally(() => { fetching = null; });
      return fetching;
    },
    due() {
      const data = read(), time = now();
      return (!data.lastSuccessAt || giftDay(Date.parse(data.lastSuccessAt)) !== giftDay(time)) && new Date(time+8*3600000).getUTCHours()>=8;
    },
  };
  return library;
}

export const publicGiftCodes = createGiftCodeLibrary();
