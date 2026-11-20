import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Badge } from "../../badge";
import { Button } from "../../button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table";
import {
  type DailyTask,
  parseDailyOutcome,
  parseDailyTasks,
} from "../contracts/daily-tasks";
import { createAccountRequest } from "../lib/api";
import { type ConsoleState, getConsoleStore } from "../lib/console-store";

// A submitted action can outlive this view. Wait for it before rereading the same account.
const pending = new Map<string, Promise<string>>();

function connectionHint(state: ConsoleState) {
  const id = state.currentAccountId;
  if (!id) return "请先选择账号";
  const status = state.accountsById[id]?.status;
  if (status?.paused) return "账号已暂停，请先恢复托管";
  if (status?.reconnecting) return "账号正在重连";
  if (status?.loginBlocked || state.disconnected.has(id))
    return "请先连接当前账号";
  return "";
}

function statusLabel(task: DailyTask) {
  if (task.rewardClaimed) return "已领取";
  if (task.progress >= task.targetProgress) return "已达标";
  if (task.status === "partial" && task.action) return "部分可做";
  if (task.action) return "可执行";
  return task.status === "waiting" ? "等待中" : "暂无操作";
}

function TaskList({ account }: { account: string }) {
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh and settled writes both require a fresh survey.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function read() {
      try {
        await pending.get(account)?.catch(() => {});
        signal.throwIfAborted();
        const data = await createAccountRequest(account)("/api/dailies", {
          signal,
        });
        if (!signal.aborted) setTasks(parseDailyTasks(data));
      } catch (err) {
        if (!signal.aborted) {
          setTasks(null);
          setError(err instanceof Error ? err.message : "读取日常任务失败");
        }
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [account, revision]);

  function refresh() {
    setBusy(true);
    setError("");
    setRevision((n) => n + 1);
  }

  async function execute(task: DailyTask) {
    const action = task.action;
    const state = getConsoleStore().getState();
    if (
      !action ||
      busy ||
      pending.has(account) ||
      state.view.page !== "dailies" ||
      state.currentAccountId !== account ||
      connectionHint(state)
    )
      return;
    if (
      action.ruby &&
      !window.confirm(`花费 ${action.ruby} 钻石完成「${task.title}」？`)
    )
      return;
    setBusy(true);
    setError("");
    setNotice(`正在处理「${task.title}」…`);
    const job = createAccountRequest(account)("/api/dailies/single", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        token: action.token,
        paid: action.ruby > 0,
      }),
    }).then(parseDailyOutcome);
    pending.set(account, job);
    try {
      setNotice(await job);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作结果待确认");
    } finally {
      pending.delete(account);
      refresh();
    }
  }

  const completed = tasks?.filter(
    (t) => t.rewardClaimed || t.progress >= t.targetProgress,
  ).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>日常任务</h2>
        </CardTitle>
        {tasks && (
          <CardDescription>
            已完成 {completed} / {tasks.length}
          </CardDescription>
        )}
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setNotice("");
              refresh();
            }}
          >
            刷新进度
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p role="status" className="dim mb-2 empty:hidden">
          {notice || (busy ? "正在读取任务进度…" : "")}
        </p>
        {error && <p role="alert">{error}</p>}
        {tasks?.length === 0 && <p className="dim">当前账号暂无日常任务</p>}
        {tasks && tasks.length > 0 && (
          <div className="table-stack">
            <Table aria-label="日常任务进度" aria-busy={busy}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">任务</TableHead>
                  <TableHead scope="col">进度</TableHead>
                  <TableHead scope="col">状态</TableHead>
                  <TableHead scope="col">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <span className="font-medium">{task.title}</span>
                      {task.detail && (
                        <p className="text-xs text-muted-foreground">
                          {task.detail}
                        </p>
                      )}
                    </TableCell>
                    <TableCell
                      data-label="进度"
                      className="whitespace-nowrap tabular-nums"
                    >
                      {task.progress} / {task.targetProgress}
                    </TableCell>
                    <TableCell data-label="状态">
                      <Badge variant={task.action ? "secondary" : "outline"}>
                        {statusLabel(task)}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="操作">
                      {task.action && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void execute(task)}
                        >
                          {task.action.label}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
function DailyTasksPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "dailies");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, connectionHint);
  if (!active) return null;
  if (hint || !account)
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>日常任务</h2>
          </CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
      </Card>
    );
  return <TaskList key={account} account={account} />;
}

export function mountDailyTasks(host: HTMLElement) {
  createRoot(host).render(<DailyTasksPage />);
}
