import { createWechatLogin as createNativeLogin } from '../wechat-login.mjs';

// The upstream controller owns one QR session. Give each console user a separate instance.
export function createWechatLogin({ createNative = createNativeLogin } = {}) {
  const sessions = new Map();
  let closed = false;

  function session(owner, id) {
    const entry = sessions.get(owner);
    if (!entry || entry.id !== id) throw Error('微信扫码会话已失效，请重新获取二维码');
    return entry;
  }

  async function dispose(owner, entry) {
    if (sessions.get(owner) === entry) sessions.delete(owner);
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.credential = null;
    entry.entry = null;
    await entry.native.close();
  }

  return {
    async start(owner) {
      if (closed) throw Error('控制台已关闭');
      const previous = sessions.get(owner);
      if (previous?.saving) throw Error('正在保存账号，请稍候');
      if (!previous && sessions.size >= 100) throw Error('扫码人数过多，请稍后重试');

      const pending = { native: createNative(), controller: new AbortController() };
      sessions.set(owner, pending);
      try {
        if (previous) await dispose(owner, previous);
        if (sessions.get(owner) !== pending) throw Error('二维码已刷新');
        const state = await pending.native.start();
        if (sessions.get(owner) !== pending) throw Error('二维码已刷新');
        pending.id = state.id;
        pending.timer = setTimeout(() => { void dispose(owner, pending); }, 14 * 60_000);
        pending.timer.unref();
        return state;
      } catch (error) {
        await dispose(owner, pending);
        throw error;
      }
    },
    session,
    status(owner, id) {
      const pending = session(owner, id);
      const state = pending.native.status(id);
      pending.phase = state.phase;
      if (state.phase === 'captured') pending.credential ??= pending.native.takeCredential(id);
      else if (!['starting', 'waiting', 'scanned', 'authorizing'].includes(state.phase)) {
        pending.controller.abort();
        pending.credential = null;
        pending.entry = null;
      }
      return state;
    },
    async cancel(owner, id) {
      const pending = session(owner, id);
      if (pending.saving) throw Error('正在保存账号，请稍候');
      await dispose(owner, pending);
    },
    async close() {
      closed = true;
      await Promise.all([...sessions].map(([owner, entry]) => dispose(owner, entry)));
    },
  };
}
