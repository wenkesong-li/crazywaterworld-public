import { isRecord } from "./login-settings";

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseDailyTasks(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.tasks))
    throw new Error("日常任务列表格式无效");
  return value.tasks.map((row: unknown) => {
    if (!isRecord(row) || !isRecord(row.task) || !isRecord(row.manual))
      throw new Error("日常任务格式无效");
    const {
      id,
      title,
      targetProgress,
      progress = 0,
      rewardClaimed = false,
    } = row.task;
    if (
      !count(id) ||
      typeof title !== "string" ||
      !count(targetProgress) ||
      !count(progress) ||
      typeof rewardClaimed !== "boolean"
    )
      throw new Error("日常任务进度格式无效");
    const { token, ruby, label } = row.manual;
    let action: { token: string; ruby: number; label: string } | undefined;
    if (token !== undefined) {
      if (
        typeof token !== "string" ||
        !token ||
        !count(ruby) ||
        typeof label !== "string"
      )
        throw new Error("日常任务操作格式无效");
      action = { token, ruby, label };
    }
    const details = new Map<string, number>();
    if (action && Array.isArray(row.actions)) {
      for (const item of row.actions) {
        if (!isRecord(item) || typeof item.note !== "string") continue;
        const note =
          typeof item.cost === "string" && item.cost !== "无"
            ? `${item.note}（${item.cost}）`
            : item.note;
        details.set(note, (details.get(note) ?? 0) + 1);
      }
    }
    const notes = [...details].map(([note, times]) =>
      times > 1 ? `${note} × ${times}` : note,
    );
    const reason = row.manual.reason ?? row.reason;
    if (!rewardClaimed && typeof reason === "string") notes.unshift(reason);
    return {
      id,
      title,
      targetProgress,
      progress,
      rewardClaimed,
      action,
      status: row.status,
      detail: notes.join(" · "),
    };
  });
}

export type DailyTask = ReturnType<typeof parseDailyTasks>[number];

export function parseDailyOutcome(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    typeof value.ok !== "boolean"
  )
    throw new Error("操作结果待确认，请刷新进度");
  return value.label;
}
