import type { DurableMap } from "../persistence/durable-map.ts";
import type { RuleId } from "./rules.ts";

export type ReminderMode = "dry-run" | "live";

export interface ZqReminderDraft {
  id: string;
  rule: RuleId;
  subjectId: string;
  subjectTitle?: string;
  recipientMmUserId: string;
  target?: string;
  text: string;
  batch?: { heading: string; line: string };
  dayKey: string;
  dueAt: number;
}

export interface ZqReminder extends ZqReminderDraft {
  mode: ReminderMode;
  status: "pending" | "sent" | "cancelled";
  createdAt: number;
  sentAt?: number;
}

export interface ZqReminderStore {
  schedule(draft: ZqReminderDraft, mode: ReminderMode): Promise<{ reminder: ZqReminder; created: boolean }>;
  due(now: number, limit?: number): Promise<ZqReminder[]>;
  markSent(id: string): Promise<ZqReminder | null>;
  has(id: string): Promise<boolean>;
  countForDay(recipientMmUserId: string, dayKey: string): Promise<number>;
  cancelForSubject(subjectId: string): Promise<number>;
  pendingFor(recipientMmUserId: string): Promise<ZqReminder[]>;
}

export function reminderId(rule: RuleId, subjectId: string, recipientMmUserId: string, dayKey: string): string {
  return `${rule}:${subjectId}:${recipientMmUserId}:${dayKey}`;
}

export function createZqReminderStore(opts: { map: DurableMap<ZqReminder>; now?: () => number }): ZqReminderStore {
  const now = opts.now ?? (() => Date.now());
  return {
    async schedule(draft, mode) {
      const reminder: ZqReminder = { ...draft, mode, status: "pending", createdAt: now() };
      if (await opts.map.insertIfAbsent(reminder.id, reminder)) return { reminder, created: true };
      const existing = (await opts.map.get(reminder.id)) ?? reminder;
      if (existing.mode === "dry-run" && mode === "live" && existing.status === "pending") {
        const upgraded = await opts.map.merge(existing.id, { mode: "live" });
        return { reminder: upgraded ?? existing, created: false };
      }
      return { reminder: existing, created: false };
    },
    async due(at, limit = 100) {
      return (await opts.map.all())
        .filter((r) => r.mode === "live" && r.status === "pending" && r.dueAt <= at)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, limit);
    },
    markSent: (id) =>
      opts.map.update(id, (r) => (r.status === "pending" ? { ...r, status: "sent", sentAt: now() } : r)),
    async has(id) {
      return (await opts.map.get(id)) !== null;
    },
    async countForDay(recipientMmUserId, dayKey) {
      return (await opts.map.all()).filter(
        (r) => r.recipientMmUserId === recipientMmUserId && r.dayKey === dayKey && r.status !== "cancelled",
      ).length;
    },
    async cancelForSubject(subjectId) {
      const open = (await opts.map.all()).filter((r) => r.subjectId === subjectId && r.status === "pending");
      await Promise.all(open.map((r) => opts.map.merge(r.id, { status: "cancelled" })));
      return open.length;
    },
    async pendingFor(recipientMmUserId) {
      return (await opts.map.all()).filter((r) => r.recipientMmUserId === recipientMmUserId && r.status === "pending");
    },
  };
}
