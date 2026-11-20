import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

const origin = 'https://fkssj.game-wiki.cn';
const topics = ['hero', 'building', 'lineup'];
const text = value => value.replace(/<[^>]*>/g, '').replace(/&(?:amp|quot|apos|lt|gt|#\d+);/g, token => {
  const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  const code = Number(token.slice(2, -1));
  return names[token] ?? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token);
}).replace(/\s+/gu, ' ').trim();

const bootstrap = JSON.parse(readFileSync(new URL('./game-guide-catalog.json', import.meta.url), 'utf8'));

export async function fetchGameGuideCatalog(fetcher = fetch) {
  const entries = await Promise.all(topics.map(async topic => {
    const response = await fetcher(origin + '/c/' + topic, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw Error(topic + ' HTTP ' + response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw Error(topic + ' 栏目响应超过大小限制');
      chunks.push(Buffer.from(chunk));
    }
    const page = Buffer.concat(chunks).toString('utf8');
    const articles = new Map();
    for (const [, card] of page.matchAll(/<li class="article-card"[^>]*>([\s\S]*?)<\/li>/g)) {
      const headline = card.match(/<h3\b[^>]*>\s*<a href="\/article\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!headline) continue;
      const [, id, title] = headline;
      const date = card.match(/<time datetime="(\d{4}-\d\d-\d\d)/)?.[1] ?? '';
      articles.set(id, { id, title: text(title), date });
    }
    if (!articles.size) throw Error(topic + ' 未识别到攻略卡片');
    return [topic, [...articles.values()]];
  }));
  return Object.fromEntries(entries);
}

export function createGameGuides(directory) {
  const file = path.join(directory, 'console-game-guides.json');
  const read = () => readJson(file, { catalog: bootstrap, edits: {}, syncedAt: null });
  let syncing = null;
  function view() {
    const { catalog, edits, syncedAt } = read();
    return { syncedAt, catalog: Object.fromEntries(topics.map(topic => [
      topic, catalog[topic].map(entry => ({ ...entry, ...edits[entry.id] })),
    ])) };
  }
  return {
    view,
    refresh() {
      if (syncing) return syncing;
      syncing = fetchGameGuideCatalog().then(catalog => {
        withFileLock(file, () => atomicJson(file, { ...read(), catalog, syncedAt: new Date().toISOString() }));
        return view();
      }).finally(() => { syncing = null; });
      return syncing;
    },
  };
}
