import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from '../accounts.mjs';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

import { giftSources, parseWikiGiftCodes, fetchGiftSource, fetchCustomGiftSource, customGiftSourceUrl } from './gift-code-sources.mjs';

export const GIFT_CODE_SOURCE = giftSources[0].url;
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
  const changePreference = (id, work) => withFileLock(preferenceFile, () => {
    const data = preferences();
    let account = data.accounts.find(entry => entry.id === id);
    if (!account) { account = { id, enabled: false }; data.accounts.push(account); }
    work(account); atomicJson(preferenceFile, data); return { ...account };
  });
  const snapshots = data => data.sourceRows ?? { ali213: data.codes };
  const rowExpired = row => row.expiresAtMs != null ? row.expiresAtMs < now() : expiredDate(row.expiresAt, now());
  const sourcesFor = data => [...giftSources, ...(data.customChannels ?? [])];
  function mergeChannels(data) {
    const blocked = new Set(data.expired.map(row => row.code));
    const merged = new Map();
    for (const { id, name } of sourcesFor(data)) {
      for (const row of snapshots(data)[id] ?? []) {
        if (blocked.has(row.code) || rowExpired(row)) continue;
        const existing = merged.get(row.code);
        if (!existing) {
          merged.set(row.code, { ...row, sources: [id], sourceDetails: [{ name, trigger: row.trigger }] });
          continue;
        }
        const time = row.expiresAtMs ?? (row.expiresAt ? Date.parse(row.expiresAt + 'T23:59:59.999+08:00') : Infinity);
        const previous = existing.expiresAtMs ?? (existing.expiresAt ? Date.parse(existing.expiresAt + 'T23:59:59.999+08:00') : Infinity);
        merged.set(row.code, { ...(time < previous ? row : existing), reward: existing.reward || row.reward, sources: [...new Set([...existing.sources, id])], sourceDetails: [...existing.sourceDetails, { name, trigger: row.trigger }] });
      }
    }
    data.codes = [...merged.values()];
  }
  let fetching = null;
  const library = {
    fetchHistory(id) {
      const batches = read().fetchHistory ?? [];
      if (!id) return batches.map(({ rows, ...batch }) => batch);
      const batch = batches.find(entry => entry.id === id);
      if (!batch) throw Error('抓取批次已不存在');
      const rewards = read().verifiedRewards ?? {};
      return { ...batch, rows: batch.rows.map(row => ({
        ...row, reward: row.reward || (Object.hasOwn(rewards, row.code) ? rewards[row.code] : ''),
      })) };
    },
    rememberReward(code, reward) {
      if (typeof reward !== 'string' || !reward.trim()) return;
      withFileLock(catalogFile, () => {
        const data = read();
        const shared = [...data.codes, ...(data.sharedCodes ?? [])].find(row => row.code === code);
        const recorded = (data.fetchHistory ?? []).some(batch => batch.rows.some(row => row.code === code));
        if ((!shared && !recorded) || shared?.reward) return;
        const rewards = data.verifiedRewards ?? {};
        if (Object.hasOwn(rewards, code)) return;
        data.verifiedRewards = { ...rewards, [code]: reward.trim().slice(0, 1000) };
        atomicJson(catalogFile, data);
      });
    },
    channels() {
      return sourcesFor(read()).map(source => ({ ...source, fixed: !source.format }));
    },
    updateChannel({ id, name, url, format, remove }) {
      if (giftSources.some(source => source.id === id)) throw Error('内置公共礼包码渠道不可修改或移除');
      withFileLock(catalogFile, () => {
        const data = read();
        const custom = data.customChannels ?? [];
        const previous = custom.find(source => source.id === id);
        if (id && !previous) throw Error('找不到自建渠道');
        data.sourceRows = snapshots(data);
        if (remove === true) {
          if (!previous) throw Error('请选择要移除的渠道');
          data.customChannels = custom.filter(source => source.id !== id);
          delete data.sourceRows[id];
        } else {
          const title = typeof name === 'string' ? name.trim() : '';
          if (!title || title.length > 40 || !['wiki', 'article'].includes(format)) throw Error('请填写渠道名称并选择数据格式');
          const href = customGiftSourceUrl(url).href;
          if (sourcesFor(data).some(source => source.id !== id && source.url === href)) throw Error('这个网址已添加');
          if (!previous && custom.length >= 10) throw Error('最多添加 10 个自建渠道');
          const source = { id: previous?.id ?? randomUUID(), name: title, url: href, format };
          data.customChannels = [...custom.filter(item => item.id !== id), source];
          if (previous && (previous.url !== href || previous.format !== format)) delete data.sourceRows[id];
        }
        mergeChannels(data);
        atomicJson(catalogFile, data);
      });
      return library.channels();
    },
    pruneExpired() {
      const current = read();
      if (![...current.codes, ...(current.sharedCodes ?? [])].some(rowExpired)) return;
      withFileLock(catalogFile,()=>{const data=read(),expired=new Set(data.expired.map(row=>row.code));
        const active = row => {
          if (!rowExpired(row) && !expired.has(row.code)) return true;
          if (!expired.has(row.code)) {
            data.expired.push({ code: row.code, reason: '注明的有效期已结束', at: new Date(now()).toISOString() });
            expired.add(row.code);
          }
          return false;
        };
        data.sharedCodes = (data.sharedCodes ?? []).filter(active);
        data.codes = data.codes.filter(active);
        atomicJson(catalogFile, data);
      });
    },
    isExpired(code) { const data=read();return data.expired.some(entry => entry.code === code)||[...data.codes, ...(data.sharedCodes ?? [])].some(entry=>entry.code===code&&rowExpired(entry)); },
    expire(code, reason = '游戏服务器明确返回礼包码已过期') {
      withFileLock(catalogFile, () => {
        const data = read();
        if (data.expired.some(entry => entry.code === code)) return;
        data.codes = data.codes.filter(entry => entry.code !== code);
        data.sharedCodes = (data.sharedCodes ?? []).filter(entry => entry.code !== code);
        data.expired.push({ code, reason, at: new Date(now()).toISOString() });
        atomicJson(catalogFile, data);
      });
    },
    reconcile(rows) {
      library.pruneExpired();
      const known=new Set(read().expired.map(row=>row.code));
      for (const row of rows) if (!known.has(row.code)&&row.status === 'rejected' && (row.promptName === 'GIFT_CODE_EXPIRED' || row.detail === '礼包码已过期')) {library.expire(row.code);known.add(row.code);}
    },
    entries(id) {
      library.pruneExpired();
      const data=read(),expired=new Set(data.expired.map(row=>row.code));
      const codes=new Map(data.codes.map(row=>[row.code,{...row,manual:false}]));
      for (const row of data.sharedCodes ?? []) {
        if (expired.has(row.code) || expiredDate(row.expiresAt, now())) {
          codes.delete(row.code);
          continue;
        }
        const existing = codes.get(row.code);
        const expiry = [row.expiresAt, existing?.expiresAt].filter(Boolean).sort()[0] ?? null;
        codes.set(row.code, { ...existing, ...row, expiresAt: expiry, manual: true, shared: true });
      }
      if(id){
        const personal=library.auto(id).manualCodes??[];
        for(const row of personal){
          if(expired.has(row.code)||expiredDate(row.expiresAt,now())){codes.delete(row.code);continue;}
          const shared=codes.get(row.code);
          codes.set(row.code,shared?{...shared,expiresAt:row.expiresAt&&(!shared.expiresAt||row.expiresAt<shared.expiresAt)?row.expiresAt:shared.expiresAt}:{...row,manual:true});
        }
      }
      const rewards = data.verifiedRewards ?? {};
      return [...codes.values()].map(row => Object.hasOwn(rewards, row.code) && !row.reward
        ? { ...row, reward: rewards[row.code] } : row);
    },
    available(rows,id) {
      library.pruneExpired();
      const unavailable = new Set(rows.filter(hasGiftCodeHistory).map(row => row.code));
      return library.entries(id).filter(row => !expiredDate(row.expiresAt, now()) && !unavailable.has(row.code)).map(row => row.code);
    },
    view() {
      library.pruneExpired();
      const data = read(), codes = library.entries();
      return { source: GIFT_CODE_SOURCE, updatedAt: data.sourceUpdatedAt, lastSyncedAt: data.lastSuccessAt ?? null,
        lastError: data.lastError ?? '', lastFetch: data.lastFetch ?? null, dailyTime: '每天北京时间 08:00 自动抓取，也可手动获取最新', total: codes.length, unique: codes.length,
        expired: data.expired.length, codes, tryCodes: codes.map(row => row.code),
        revision: createHash('sha256').update(codes.map(row => row.code).join('\n')).digest('hex') };
    },
    auto(id) { return { enabled: false, ...preferences().accounts.find(entry => entry.id === id) }; },
    accountRevision(id) { return createHash('sha256').update(JSON.stringify(library.entries(id).map(row=>[row.code,row.expiresAt]))).digest('hex'); },
    addManual(ids,code,expiresAt) {
      if(typeof code!=='string'||!/^[\p{L}\p{N}_-]{1,128}$/u.test(code.trim()))throw Error('礼包码需为1至128个汉字、字母、数字、下划线或短横线');
      code=code.trim();expiresAt=expiresAt||null;
      if(expiresAt&&(typeof expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)||new Date(expiresAt+'T00:00:00Z').toISOString().slice(0,10)!==expiresAt||expiredDate(expiresAt,now())))throw Error('到期日期无效或已经过期');
      if(library.isExpired(code))throw Error('该礼包码已全局下架，不能再次添加');
      withFileLock(preferenceFile,()=>{const data=preferences();for(const id of ids){let account=data.accounts.find(row=>row.id===id);if(!account){account={id,enabled:false};data.accounts.push(account);}const rows=account.manualCodes??[];account.manualCodes=[...rows.filter(row=>row.code!==code),{code,expiresAt,firstSeenAt:rows.find(row=>row.code===code)?.firstSeenAt??new Date(now()).toISOString()}];}atomicJson(preferenceFile,data);});
    },
    addSharedBatch(input, expiresAt) {
      if (!Array.isArray(input) || input.length === 0 || input.length > 500
        || input.some(code => typeof code !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(code.trim()))) {
        throw Error('请输入 1 至 500 条有效礼包码，每行一条');
      }
      const codes = [...new Set(input.map(code => code.trim()))];
      const date = expiresAt || null;
      if (date && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
        || expiredDate(date, now()))) throw Error('到期日期无效或已经过期');
      return withFileLock(catalogFile, () => {
        const data = read();
        const rows = new Map((data.sharedCodes ?? []).map(row => [row.code, row]));
        for (const code of codes) {
          if (library.isExpired(code)) throw Error('礼包码已过期或全局下架：' + code);
          rows.set(code, { code, expiresAt: date, firstSeenAt: rows.get(code)?.firstSeenAt ?? new Date(now()).toISOString() });
        }
        data.sharedCodes = [...rows.values()];
        atomicJson(catalogFile, data);
        return codes.length;
      });
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
      if (!force && data.lastSuccessAt && giftDay(Date.parse(data.lastSuccessAt)) === giftDay(time)) return library.view();
      if ((!force && data.lastAttemptAt && time - data.lastAttemptAt < 3600000) || data.leaseUntil > time) return library.view();
      const claimed = withFileLock(catalogFile, () => {
        const latest = read();
        if (latest.leaseUntil > now()) return false;
        latest.lastAttemptAt = now();
        latest.leaseUntil = now() + 90000;
        atomicJson(catalogFile, latest);
        return true;
      });
      if (!claimed) return library.view();
      fetching = (async () => {
        const results = await Promise.all(sourcesFor(data).map(async source => {
          try {
            const content = await (source.format ? fetchCustomGiftSource(source) : fetchGiftSource(source, fetcher));
            const parsed = source.id === 'wiki' || source.format === 'wiki' ? parseWikiGiftCodes(content, now()) : parseGiftCodeArticle(content);
            return { ...source, ...parsed };
          } catch (error) {
            return { ...source, error: error.message };
          }
        }));
        withFileLock(catalogFile, () => {
          const latest = read();
          latest.sourceRows = snapshots(latest);
          const codes = new Set();
          let success = false;
          const currentSources = new Map(sourcesFor(latest).map(source => [source.id, source]));
          for (const result of results) {
            const source = currentSources.get(result.id);
            if (result.error || source?.url !== result.url || source.format !== result.format) continue;
            success = true;
            const rows = result.rows.filter(row => !rowExpired(row)).map(row => ({ ...row, trigger: force ? 'manual' : 'automatic' }));
            const previousRows = result.id === 'ali213' ? latest.sourceRows[result.id] ?? [] : [];
            latest.sourceRows[result.id] = [...new Map([...previousRows, ...rows].map(row => [row.code, row])).values()]
              .filter(row => !rowExpired(row));
            for (const row of rows) codes.add(row.code);
          }
          const prior = new Set(latest.codes.map(row => row.code));
          mergeChannels(latest);
          const available = new Set(latest.codes.map(row => row.code));
          const fetched = [...codes].filter(code => available.has(code));
          const errors = results.filter(result => result.error).map(result => result.name + '：' + result.error);
          latest.lastFetch = {
            at: new Date(now()).toISOString(),
            codes: fetched,
            added: fetched.filter(code => !prior.has(code)).length,
            channels: results.map(({ id, name, rows, error }) => ({ id, name, count: rows?.filter(row => !rowExpired(row)).length ?? 0, error })),
          };
          const fetchedSet = new Set(fetched);
          const batch = {
            id: randomUUID(), at: latest.lastFetch.at, trigger: force ? 'manual' : 'automatic', fetched: fetched.length, added: latest.lastFetch.added,
            channels: latest.lastFetch.channels.map(({ id, name, count, error }) => ({ id, name, count, error })),
            rows: latest.codes.filter(row => fetchedSet.has(row.code)).map(row => ({
              code: row.code, expiresAt: row.expiresAt, expiresAtMs: row.expiresAtMs, reward: row.reward, sources: row.sources, sourceDetails: row.sourceDetails,
            })),
          };
          latest.fetchHistory = [batch, ...(latest.fetchHistory ?? [])].slice(0, 30);
          if (success) {
            latest.lastSuccessAt = batch.at;
            latest.sourceUpdatedAt = results.filter(result => result.sourceUpdatedAt)
              .map(result => result.sourceUpdatedAt).sort().at(-1) ?? latest.sourceUpdatedAt;
          }
          latest.lastError = errors.join('；');
          latest.leaseUntil = 0;
          atomicJson(catalogFile, latest);
        });
        return library.view();
      })().finally(() => { fetching = null; });
      return fetching;
    },
    due() {
      const data = read(), time = now();
      return (!data.lastSuccessAt || giftDay(Date.parse(data.lastSuccessAt)) !== giftDay(time)) && new Date(time+8*3600000).getUTCHours()>=8;
    },
  };
  if (Object.hasOwn(read(), 'channelIds')) {
    withFileLock(catalogFile, () => {
      const data = read();
      if (!Object.hasOwn(data, 'channelIds')) return;
      data.sourceRows = snapshots(data);
      delete data.channelIds;
      mergeChannels(data);
      atomicJson(catalogFile, data);
    });
  }
  return library;
}

export const publicGiftCodes = createGiftCodeLibrary();
