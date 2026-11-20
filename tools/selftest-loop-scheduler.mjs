import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopScheduler } from '../src/loop-scheduler.mjs';

let passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}
function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  const control = new AbortController();
  const jobs = [], sleeps = [];
  const scheduler = createLoopScheduler({
    client, stop: control.signal, now: () => 1000,
    schedule: work => new Promise((resolve, reject) => jobs.push(async () => {
      try { resolve(await work()); } catch (error) { reject(error); }
    })),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      sleeps.push({ ms, signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  return { client, control, scheduler, jobs, sleeps };
}

await test('到期任务经现有队列执行，重复投递合并', async () => {
  const f = fixture();
  let executed = 0;
  const first = f.scheduler.runDue('factory', () => 900, () => executed++);
  const duplicate = f.scheduler.runDue('factory', () => 900, () => executed++);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(f.jobs.length, 1);
  assert.equal(executed, 0);
  await f.jobs.shift()();
  await first;
  assert.equal(executed, 1);
  f.scheduler.dispose();
});

await test('排队期间期限或开关变化，在执行点复查', async () => {
  const f = fixture();
  let deadline = 900, executed = 0;
  const job = f.scheduler.runDue('factory', () => deadline, () => executed++);
  await Promise.resolve();
  deadline = Infinity;
  await f.jobs.shift()();
  await job;
  assert.equal(executed, 0);
  await f.scheduler.runDue('factory', () => 2000, () => executed++);
  assert.equal(f.jobs.length, 0);
  f.scheduler.dispose();
});

await test('推送风暴只唤醒等待，取消旧计时器且不投递协议', async () => {
  const f = fixture();
  const wait = f.scheduler.waitUntil(6000);
  assert.equal(f.sleeps[0].ms, 5000);
  for (let i = 0; i < 100; i++) f.scheduler.wake();
  assert.equal(await wait, true);
  assert.equal(f.sleeps[0].signal.aborted, true);
  assert.equal(f.jobs.length, 0);
  const next = f.scheduler.waitUntil(7000);
  assert.equal(f.sleeps.length, 2);
  f.sleeps[1].resolve();
  assert.equal(await next, false);
  f.scheduler.dispose();
});

await test('等待开始前的推送合并为一次即时复查', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.wake();
  assert.equal(await f.scheduler.waitUntil(2000), true);
  assert.equal(f.sleeps.length, 0);
  const wait = f.scheduler.waitUntil(2000);
  f.sleeps[0].resolve();
  assert.equal(await wait, false);
  f.scheduler.dispose();
});

for (const reason of ['pause', 'disconnect', 'finite-round']) {
  await test(reason + '退出清理等待、监听和队列中的接续工作', async () => {
    const f = fixture();
    let executed = 0, cleaned = 0;
    f.scheduler.listen(f.client, 'message', () => f.scheduler.wake());
    f.scheduler.addCleanup(() => cleaned++);
    const job = f.scheduler.runDue('factory', () => 0, () => executed++);
    await Promise.resolve();
    const wait = f.scheduler.waitUntil(6000);
    if (reason === 'pause') f.control.abort();
    else if (reason === 'disconnect') { f.client.connected = false; f.client.emit('close'); }
    else f.scheduler.dispose();
    assert.equal(await wait, true);
    assert.equal(f.sleeps[0].signal.aborted, true);
    assert.equal(f.scheduler.active(), false);
    assert.deepEqual(f.client.eventNames(), []);
    await f.jobs.shift()();
    await job;
    f.client.emit('message');
    f.scheduler.wake();
    await f.scheduler.runDue('factory', () => 0, () => executed++);
    assert.equal(executed, 0);
    assert.equal(f.jobs.length, 0);
    f.scheduler.dispose();
    assert.equal(cleaned, 1);
  });
}

await test('同账号恢复时新调度器清空旧运行的唤醒与任务', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.dispose();
  const next = createLoopScheduler({ client: f.client, now: () => 1000, sleep: async () => {} });
  assert.equal(await next.waitUntil(2000), false);
  let executed = 0;
  await next.runDue('factory', () => 0, () => executed++);
  assert.equal(executed, 1);
  next.dispose();
});

await test('运行中修改间隔按原等待起点重算下一轮，缩短、延长与已到期均及时生效', async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-loop-interval-'));
  const previousDataDir = process.env.CW_DATA_DIR, originalNow = Date.now;
  process.env.CW_DATA_DIR = directory;
  try {
    const { runLoop } = await import('../src/loop.mjs');
    const { defaultSettings } = await import('../src/automation-settings.mjs');
    const settings = defaultSettings();
    function disable(value) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'boolean') value[key] = false;
        else if (item && typeof item === 'object') disable(item);
      }
    }
    disable(settings);
    for (const scenario of [
      { initial: 60000, next: 1000, elapsed: 500, waits: [60000, 500], finish: 1000 },
      { initial: 1000, next: 60000, elapsed: 500, waits: [1000, 59500], finish: 60000 },
      { initial: 60000, next: 1000, elapsed: 5000, waits: [60000], finish: 5000 },
    ]) {
      const base = Date.UTC(2026, 10, 17, 4);
      let now = base, interval = scenario.initial;
      Date.now = () => now;
      const client = new EventEmitter();
      client.setMaxListeners(50);
      client.connected = true;
      client.request = async name => assert.fail('关闭业务任务时不应请求 ' + name);
      const waits = [], rounds = [];
      await runLoop(client, {}, {
        rounds: 2, allowMutate: true, isEnabled: () => false,
        getSettings: () => settings, getEveryMs: () => interval,
        sleep: async ms => {
          assert(waits.length < 3, '更新间隔后应在新截止时间完成等待');
          waits.push(ms);
          if (waits.length === 1) {
            now += scenario.elapsed;
            interval = scenario.next;
            client.emit('automationSettingsChanged');
          } else now += ms;
        },
        onRound: () => rounds.push(now - base),
      });
      assert.deepEqual(waits, scenario.waits);
      assert.deepEqual(rounds, [0, scenario.finish]);
      assert.equal(client.listenerCount('automationSettingsChanged'), 0);
    }
  } finally {
    Date.now = originalNow;
    if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
    else process.env.CW_DATA_DIR = previousDataDir;
    assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

await test('服务端刷新时间、缺失时的整点兜底和固定轮询分别生效', async () => {
  const client = new EventEmitter();
  client.serverClockOffsetMs = 7000;
  const hour = Date.UTC(2026, 10, 20, 2);
  let clock = hour - 12000;
  const scheduler = createLoopScheduler({ client, now: () => clock });
  const policy = { enabled: () => true, intervalMs: () => 30000 };
  const treasure = scheduler.scanTask({ ...policy, hourlyFallback: true });
  const radar = scheduler.scanTask(policy);
  await treasure.check(() => []);
  await radar.check(() => []);
  assert.equal(treasure.nextAt(), hour - 7000);
  assert.equal(radar.nextAt(), clock + 30000);
  clock = treasure.nextAt();
  const refresh = hour / 1000 + 8;
  await treasure.check(() => [refresh]);
  client.serverClockOffsetMs += 500;
  assert.equal(treasure.nextAt(), refresh * 1000 - client.serverClockOffsetMs);
  clock = treasure.nextAt();
  await treasure.check(() => [refresh]); // 旧批次仍返回刚经过的刷新点
  assert.equal(treasure.nextAt(), clock + 30000);
  assert.equal(await radar.check(() => assert.fail('固定周期未到')), false);
  scheduler.dispose();
});

await test('心跳校时提前刷新期限时立即结束旧等待', async () => {
  const f = fixture();
  const scan = f.scheduler.scanTask({ enabled: () => true, intervalMs: () => 60000 });
  await scan.check(() => [30]);
  const wait = f.scheduler.waitUntil(scan.nextAt());
  f.scheduler.wakeIfEarlier(scan.nextAt());
  assert.equal(f.sleeps[0].signal.aborted, false);
  f.client.serverClockOffsetMs = 5000;
  f.scheduler.wakeIfEarlier(scan.nextAt());
  assert.equal(await wait, true);
  assert.equal(scan.nextAt(), 25000);
  f.scheduler.dispose();
});

await test('在途推送合并为一次补扫，跨过已知边界会立即复查', async () => {
  let clock = 10000, reads = 0;
  const scheduler = createLoopScheduler({ client: new EventEmitter(), now: () => clock });
  const scan = scheduler.scanTask({ enabled: () => true, intervalMs: () => 60000 });
  await scan.check(() => { reads++; clock = 12000; return [11]; });
  assert.equal(scan.nextAt(), 11000);
  await scan.check(async () => {
    reads++;
    for (let n = 0; n < 10; n++) scan.invalidate();
    assert.equal(await scan.check(() => assert.fail('扫描重入')), false);
    return [11];
  });
  await scan.check(() => { reads++; return [11]; });
  assert.equal(reads, 3);
  assert.equal(scan.nextAt(), 72000);
  scheduler.dispose();
  assert.equal(scan.nextAt(), Infinity);
});

await test('让出账号队列后暂停会取消待扫描任务和剩余主轮步骤', async () => {
  const client = new EventEmitter(), stop = new AbortController(), events = [];
  let due = false, slots = 0;
  const scheduler = createLoopScheduler({
    client, stop: stop.signal,
    schedule: async work => {
      if (++slots === 2) stop.abort();
      return work();
    },
  });
  async function* steps() {
    try {
      events.push('first');
      due = true;
      yield;
      events.push('second');
    } finally { events.push('closed'); }
  }
  await scheduler.runSteps(steps(), {
    nextAt: () => due ? 0 : Infinity, runPending: () => events.push('scan'), afterStep: () => {},
  });
  assert.equal(slots, 2);
  assert.deepEqual(events, ['first', 'closed']);
});

console.log('循环调度离线专项 ' + passed + '/' + passed + ' 通过');
