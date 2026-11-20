import { writeFile } from 'node:fs/promises';
import { fetchGameGuideCatalog } from '../src/custom/game-guide-library.mjs';

const catalog = await fetchGameGuideCatalog();
for (const [topic, articles] of Object.entries(catalog)) console.log(topic + ' · ' + articles.length);
await writeFile(new URL('../src/custom/game-guide-catalog.json', import.meta.url),
  JSON.stringify(catalog, null, 2) + '\n');
