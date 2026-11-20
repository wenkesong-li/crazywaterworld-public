export const codePattern = /^[\p{L}\p{N}_-]{1,128}$/u;

// These are ordinary, editable channel settings. No extractor dispatches on a site name.
export const articleRule = {
  mode: 'text',
  pattern: /更新时间[：:][ \t]*(?<updatedAt>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)|^(?<=疯狂水世界[\s\S]*?^一[、.．][ \t]*兑换码$[\s\S]*?)(?![^\r\n]*兑换码[：:]?$)(?<code>[^（(\r\n]+?)(?:[（(]有效期至[ \t]*(?<expiresAt>[^）)\r\n]+)[）)])?$(?=[\s\S]*?^二[、.．][ \t]*使用方式$)/.source,
  jsonField: '',
};
export const wikiRule = {
  mode: 'raw',
  jsonField: 'codes',
  // JSON array items are formatted with two-space indentation. Match fields on
  // the item itself, independent of key order or nested feedback objects.
  pattern: /^\{(?=[\s\S]*?^  "status": "valid")(?:(?=[\s\S]*?^  "starts_at": "(?<startsAt>[^"]+)")|)(?:(?=[\s\S]*?^  "expires_at": "(?<expiresAt>[^"]+)")|)[\s\S]*?^  "code": "(?<code>[^"]+)"/.source,
};

export function upgradeGiftRule(channel) {
  if (channel.mode === 'article') return { ...channel, ...articleRule };
  if (channel.mode === 'wiki') return { ...channel, ...wikiRule };
  return { ...channel, jsonField: channel.jsonField ?? '' };
}

function giftTimestamp(value) {
  if (value == null) return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) throw Error('提取到的日期格式异常');
  const date = [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0')].join('-');
  const day = Date.parse(date + 'T00:00:00Z');
  const stamp = Date.parse(date + 'T' + (match[4] ?? '00:00:00') + (match[5] ?? '+08:00'));
  if (!Number.isFinite(stamp) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) throw Error('提取到的日期无效');
  return stamp;
}

export function giftArticleText(html) {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br\b[^>]*|\/p|\/div|\/li|\/h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({ nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>' })[name.toLowerCase()]);
}

export function extractGiftRows({ mode, pattern, jsonField }, body, now = Date.now()) {
  const regex = new RegExp(pattern, 'gmu');
  const rows = new Map();
  let updated = null, matchedCode = false;
  function collect(content) {
    for (const match of content.matchAll(regex)) {
      const groups = match.groups ?? {};
      if (groups.updatedAt) updated = giftTimestamp(groups.updatedAt);
      const code = (Object.hasOwn(groups, 'code') ? groups.code : match.length > 1 ? match[1] : match[0])?.trim();
      if (!code) continue;
      if (code.length > 128 || !codePattern.test(code)) throw Error('匹配结果含有无效礼包码，请用捕获组只选中码值');
      matchedCode = true;
      const start = giftTimestamp(groups.startsAt), end = giftTimestamp(groups.expiresAt);
      if (start !== null && start > now || end !== null && /[T ]/.test(groups.expiresAt) && end < now) continue;
      rows.set(code, { code, expiresAt: end === null ? null : new Date(end + 8 * 3600000).toISOString().slice(0, 10) });
      if (rows.size > 500) throw Error('匹配超过 500 个不同礼包码，请缩小匹配范围');
    }
  }
  if (mode === 'raw' && jsonField) {
    const data = JSON.parse(body);
    if (!Array.isArray(data?.[jsonField])) throw Error('响应缺少 JSON 数组字段：' + jsonField);
    for (const entry of data[jsonField]) collect(JSON.stringify(entry, null, 2));
    // A verified list with no eligible items replaces the previous snapshot.
    if (typeof data.updated_at === 'string' && updated === null) {
      try { updated = giftTimestamp(data.updated_at); } catch { /* Optional source metadata. */ }
    }
  } else {
    collect(mode === 'text' ? giftArticleText(body) : body);
    if (!matchedCode) throw Error('未匹配到礼包码，请检查匹配内容和表达式');
  }
  return { rows: [...rows.values()], sourceUpdatedAt: updated === null ? null : new Date(updated).toISOString() };
}

// Compatibility entry point for callers that parse the original catalog article.
export function parseGiftCodeArticle(html) {
  return extractGiftRows(articleRule, html);
}
