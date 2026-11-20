import { setTimeout as sleep } from 'node:timers/promises';

// Coordinates wakeups and queued checkpoints. The caller still owns task
// ordering, and every job uses the existing per-account execution queue.
export function createLoopScheduler({
  client, stop = {}, schedule = work => work(),
  sleep: wait = (ms, signal) => sleep(ms, undefined, { signal }), now = Date.now,
}) {
  let disposed = false;
  let pendingWake = false;
  let waiting = null;
  const cleanups = new Set();
  const queued = new Map();
  const observers = [];
  let inMainStep = false, readTimer = null, readJob = null;
  const active = () => !disposed && !stop.aborted && client.connected !== false;

  function armReads() {
    clearTimeout(readTimer);
    if (!inMainStep || readJob || !active() || !client.interleaveRead) return;
    const deadline = Math.min(...observers.map(scan => scan.nextRead()));
    if (!Number.isFinite(deadline)) return;
    readTimer = setTimeout(() => {
      readJob = client.interleaveRead(async () => {
        if (!inMainStep || !active()) return;
        // These independent discovery requests have distinct response names.
        // Keep the read gate until every response (including failures) settles.
        await Promise.allSettled(observers.filter(scan => scan.nextRead() <= now()).map(scan => scan.read()));
      }, { whileCurrent: () => inMainStep && active() }).finally(() => {
        readJob = null;
        armReads();
      });
    }, Math.max(0, Math.min(2147483647, deadline - now())));
  }

  function addCleanup(cleanup) {
    if (disposed) cleanup();
    else cleanups.add(cleanup);
    return cleanup;
  }
  function listen(emitter, event, listener) {
    if (disposed) return;
    emitter.on?.(event, listener);
    addCleanup(() => {
      const remove = emitter.off?.bind(emitter) ?? emitter.removeListener?.bind(emitter);
      remove?.(event, listener);
    });
  }
  function wake() {
    if (!active()) return;
    armReads();
    pendingWake = true;
    waiting?.resolve(true);
  }
  function wakeIfEarlier(deadline) {
    armReads();
    if (waiting && deadline < waiting.deadline) wake();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(readTimer);
    pendingWake = false;
    queued.clear();
    waiting?.resolve(true);
    waiting?.controller.abort();
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  function run(work) {
    if (!active()) return Promise.resolve();
    return schedule(() => active() ? work() : undefined);
  }
  function runDue(key, nextAt, work) {
    if (queued.has(key)) return queued.get(key);
    if (!active() || nextAt() > now()) return Promise.resolve();
    const job = Promise.resolve().then(() => run(() => nextAt() <= now() ? work() : undefined));
    queued.set(key, job);
    const clear = () => { if (queued.get(key) === job) queued.delete(key); };
    job.then(clear, clear);
    return job;
  }

  // Each yield ends a complete business operation. Keep the current queue
  // slot for ordinary steps, and reacquire it for a due scan before resuming.
  async function runSteps(steps, { nextAt, runPending, afterStep }) {
    let done = false;
    try {
      while (active() && !done) {
        await run(async () => {
          if (nextAt() <= now()) await runPending();
          while (active() && !done) {
            inMainStep = true;
            armReads();
            try {
              ({ done } = await steps.next());
              if (active()) await afterStep();
            } finally {
              inMainStep = false;
              clearTimeout(readTimer);
              await readJob;
            }
            if (nextAt() <= now()) break;
          }
        });
      }
    } finally {
      if (!done) await steps.return();
    }
  }

  // The caller owns the account queue. A scan can supply server timestamps
  // (seconds) in addition to its polling interval. Pushes only mark it due.
  function scanTask({ enabled, intervalMs, hourlyFallback = false, observe }) {
    let pollAt = 0, serverDeadline = Infinity;
    let observedUntil = 0, revision = 0;
    let requested = false, running = false;
    const offset = () => client.serverClockOffsetMs || 0;
    const nextAt = () => {
      if (!active() || !enabled() || running) return Infinity;
      return requested ? 0 : Math.min(pollAt, serverDeadline - offset());
    };
    function invalidate() {
      revision++;
      observedUntil = 0;
      if (!active() || !enabled()) return;
      requested = true;
      wake();
    }
    if (observe) observers.push({
      nextRead: () => Math.max(nextAt(), observedUntil),
      async read() {
        const version = revision;
        const current = () => version === revision && active() && enabled();
        const started = now() + offset();
        let boundaries;
        try { boundaries = await observe(current); }
        finally {
          if (current()) {
            const next = (boundaries ?? []).filter(t => Number.isSafeInteger(t) && t * 1000 > started);
            const fallback = hourlyFallback ? (Math.floor(started / 3600000) + 1) * 3600000 : Infinity;
            const boundary = next.length ? Math.min(...next) * 1000 : fallback;
            observedUntil = Math.min(now() + intervalMs(), boundary - offset());
          }
        }
      },
    });
    async function check(work) {
      if (nextAt() > now()) return false;
      const started = now() + offset();
      observedUntil = 0;
      requested = false;
      running = true;
      let boundaries;
      try {
        boundaries = await work();
      } finally {
        // A boundary crossed while reading is due immediately. The following
        // scan consumes it even if the server still returns the old timestamp.
        const upcoming = (boundaries ?? []).filter(t => Number.isSafeInteger(t) && t * 1000 > started);
        if (upcoming.length) serverDeadline = Math.min(...upcoming) * 1000;
        else if (!(serverDeadline > started && Number.isFinite(serverDeadline))) {
          serverDeadline = hourlyFallback ? (Math.floor(started / 3600000) + 1) * 3600000 : Infinity;
        }
        pollAt = now() + intervalMs();
        running = false;
      }
      return true;
    }
    return { nextAt, invalidate, check };
  }
  async function waitUntil(deadline) {
    if (!active()) return true;
    if (pendingWake) { pendingWake = false; return true; }
    const ms = Math.max(0, deadline - now());
    if (ms === 0) return false;
    const controller = new AbortController();
    let resolve;
    const changed = new Promise(complete => { resolve = complete; });
    const current = { controller, resolve, deadline };
    waiting = current;
    try {
      return await Promise.race([Promise.resolve(wait(ms, controller.signal)).then(() => false), changed]);
    } finally {
      if (waiting === current) waiting = null;
      pendingWake = false;
      controller.abort();
    }
  }

  listen(client, 'close', dispose);
  listen(client, 'state', () => { if (client.connected === false) dispose(); });
  if (stop.aborted) dispose();
  else if (stop.addEventListener) {
    stop.addEventListener('abort', dispose, { once: true });
    addCleanup(() => stop.removeEventListener('abort', dispose));
  }
  return { active, wake, wakeIfEarlier, waitUntil, run, runDue, runSteps, scanTask, listen, addCleanup, dispose };
}
