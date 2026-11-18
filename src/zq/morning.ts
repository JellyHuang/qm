import { paused, type ZqContract } from "./contract.ts";
import type { FeatureFacts, WorkView } from "./rules.ts";

const where = (w: WorkView) => `「${w.subject}」(#${w.id})`;

export function ordersOf(opUserId: string, facts: readonly FeatureFacts[], contract: ZqContract): WorkView[] {
  const seen = new Map<number, WorkView>();
  for (const { feature, children } of facts) {
    const candidates = contract.optimizationType === feature.typeKey ? [feature, ...children] : children;
    for (const w of candidates) if (w.assignee?.id === opUserId && !seen.has(w.id)) seen.set(w.id, w);
  }
  return [...seen.values()].filter(
    (w) => !paused(w.lifecycle) && !w.closed && w.statusKey !== contract.stageRoles.taskDone,
  );
}

export function composeMorning(
  opUserId: string,
  facts: readonly FeatureFacts[],
  contract: ZqContract,
): string | undefined {
  const mine = ordersOf(opUserId, facts, contract);
  if (mine.length === 0) return undefined;
  const running = mine.filter((w) => w.statusKey === contract.stageRoles.taskActive && !w.completionSubmitted);
  const submitted = mine.filter((w) => w.completionSubmitted);
  const waiting = mine.filter((w) => !running.includes(w) && !submitted.includes(w)).sort((a, b) => a.id - b.id);
  const list = (orders: readonly WorkView[]) => orders.map((w, i) => `${i + 1}. ${where(w)}`);
  const lines = [
    "早上好,这是你今天的单子:",
    "",
    `还没开始执行(${waiting.length}):`,
    ...(waiting.length ? list(waiting) : ["无"]),
    "",
    `正在执行(${running.length}):`,
    ...(running.length ? list(running) : ["无"]),
  ];
  if (submitted.length && waiting.length)
    lines.push(
      "",
      `已提交完成、等待确认:${submitted.map(where).join("、")}。可以接着安排:${where(waiting[0]!)}。开始后请把状态改为「进行中」并填上开始日期和预计结束日期。`,
    );
  return lines.join("\n");
}
