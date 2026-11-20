import type { StoreApi } from "zustand/vanilla";

export interface ConsoleState {
  currentAccountId: string | null;
  disconnected: Set<string>;
  accountIds: string[];
  accountsById: Record<
    string,
    {
      id: string;
      title?: string;
      label?: string | null;
      lastSeen?: { nickname?: string | null } | null;
      status?: Record<string, unknown>;
    }
  >;
  view: {
    page: string;
    resource: string;
    logAccount: string;
    logGroup: string;
    onlyIssues: boolean;
    loginSettingsAccountId: string | null;
  };
  slices: Record<string, unknown>;
  actions: {
    setView(patch: Partial<ConsoleState["view"]>): void;
    patchSlice(key: string, patch: object): void;
  };
}

declare global {
  interface Window {
    cwConsoleStore: StoreApi<ConsoleState>;
  }
}

export function getConsoleStore(): StoreApi<ConsoleState> {
  if (!window.cwConsoleStore)
    throw new Error("控制台状态尚未初始化，请刷新页面");
  return window.cwConsoleStore;
}
