import { getConsoleStore } from "./lib/console-store";
import type { LoginSettingsMount } from "./pages/login-settings";

const dailyHost = document.getElementById("daily-tasks-root");
if (dailyHost) {
  const host = dailyHost;
  const store = getConsoleStore();
  let loading = false;
  const loadDailies = async () => {
    if (loading || store.getState().view.page !== "dailies") return;
    loading = true;
    host.textContent = "正在载入日常任务…";
    try {
      const { mountDailyTasks } = await import("./pages/daily-tasks");
      mountDailyTasks(host);
      unsubscribe();
    } catch {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "载入失败，重试日常任务";
      retry.onclick = loadDailies;
      host.replaceChildren(retry);
    } finally {
      loading = false;
    }
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.view.page !== previous.view.page) void loadDailies();
  });
  void loadDailies();
}

const hostElement = document.getElementById("login-settings-root");
const dialogElement = document.getElementById("account-login-dialog");
const titleElement = document.getElementById("account-login-title");
const closeElement = document.getElementById("account-login-close");

if (
  hostElement &&
  dialogElement instanceof HTMLDialogElement &&
  titleElement &&
  closeElement
) {
  const host = hostElement;
  const dialog = dialogElement;
  const title = titleElement;
  const close = closeElement;
  const store = getConsoleStore();
  let mounted: LoginSettingsMount | undefined;
  let loading = false;
  let disposed = false;
  const active = () => dialog.open && !document.hidden;
  const account = () => store.getState().view.loginSettingsAccountId;

  async function update() {
    if (disposed) return;
    const state = store.getState();
    const id = account();
    const selected = id ? state.accountsById[id] : null;
    host.dataset.account = id ?? "";
    if (selected && state.view.page === "account") {
      title.textContent = `${selected.label || selected.lastSeen?.nickname || selected.title || "账号"} · 登录设置`;
      if (!dialog.open) {
        dialog.showModal();
        close.focus();
      }
    } else if (dialog.open) {
      dialog.close();
    }
    if (mounted) {
      mounted.update(account(), active());
      return;
    }
    if (!active() || loading) return;
    loading = true;
    try {
      // Keep React, Radix and Day.js off the overview page's initial JS path.
      const { mountLoginSettings } = await import("./pages/login-settings");
      if (!disposed) mounted = mountLoginSettings(host, account(), active());
    } catch {
      if (disposed) return;
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = "登录设置加载失败，请重试；更新程序后请刷新网页。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载页面组件";
      retry.addEventListener("click", () => {
        void update();
      });
      host.replaceChildren(message, retry);
    } finally {
      loading = false;
    }
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.view.loginSettingsAccountId !==
        previous.view.loginSettingsAccountId ||
      state.accountsById !== previous.accountsById ||
      state.view.page !== previous.view.page
    )
      void update();
  });
  const closeSettings = () =>
    store.getState().actions.setView({ loginSettingsAccountId: null });
  close.addEventListener("click", closeSettings);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettings();
  });
  dialog.addEventListener("close", () => {
    // A previous close event can arrive after another account has been opened.
    if (!dialog.open)
      store.getState().actions.setView({ loginSettingsAccountId: null });
  });
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    disposed = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", update);
    mounted?.unmount();
  });
  void update();
}
