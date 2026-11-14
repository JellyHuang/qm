import type { DurableMap } from "../persistence/durable-map.ts";
import type { FollowUpAction } from "./follow-up-rules.ts";

export interface ZqReminder {
  id: string;
  kind: FollowUpAction["kind"];
  workPackageId: number;
  assigneeOpUserId?: string;
  assigneeName?: string;
  reason: string;
  status: "pending" | "sent" | "cancelled";
  dueAt: number;
  createdAt: number;
  sentAt?: number;
}

export interface ZqReminderStore {
  schedule(action: FollowUpAction, dueAt: number): Promise<{ reminder: ZqReminder; created: boolean }>;
  due(now: number, limit?: number): Promise<ZqReminder[]>;
  markSent(id: string): Promise<ZqReminder | null>;
  cancelForWorkPackage(workPackageId: number): Promise<number>;
}

export function createZqReminderStore(opts: { map: DurableMap<ZqReminder>; now?: () => number }): ZqReminderStore {
  const now = opts.now ?? (() => Date.now());
  return {
    async schedule(action, dueAt) {
      const reminder: ZqReminder = {
        id: action.dedupeKey,
        kind: action.kind,
        workPackageId: action.workPackageId,
        ...(action.assigneeOpUserId ? { assigneeOpUserId: action.assigneeOpUserId } : {}),
        ...(action.assigneeName ? { assigneeName: action.assigneeName } : {}),
        reason: action.reason,
        status: "pending",
        dueAt,
        createdAt: now(),
      };
      const created = await opts.map.insertIfAbsent(reminder.id, reminder);
      return { reminder: created ? reminder : ((await opts.map.get(reminder.id)) ?? reminder), created };
    },
    async due(at, limit = 100) {
      return (await opts.map.all())
        .filter((r) => r.status === "pending" && r.dueAt <= at)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, limit);
    },
    markSent: (id) =>
      opts.map.update(id, (r) => (r.status === "pending" ? { ...r, status: "sent", sentAt: now() } : r)),
    async cancelForWorkPackage(workPackageId) {
      const open = (await opts.map.all()).filter((r) => r.workPackageId === workPackageId && r.status === "pending");
      await Promise.all(open.map((r) => opts.map.merge(r.id, { status: "cancelled" })));
      return open.length;
    },
  };
}
