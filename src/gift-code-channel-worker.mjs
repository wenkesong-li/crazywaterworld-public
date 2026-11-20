import { parentPort, workerData } from 'node:worker_threads';
import { extractGiftRows } from './gift-code-extraction.mjs';

try {
  parentPort.postMessage(extractGiftRows(workerData, workerData.body, workerData.now));
} catch (error) { parentPort.postMessage({ error: error.message }); }
