import type { ZqReminder, ZqReminderStore } from "./reminders.ts";

export interface DeliveryResult {
  sent: number;
  failed: number;
}

const groupKey = (r: ZqReminder) => (r.batch ? `${r.recipientMmUserId}|${r.rule}|${r.dayKey}` : r.id);

export async function deliverDue(opts: {
  reminders: ZqReminderStore;
  send: (mmUserId: string, text: string, rule: string, target?: string) => Promise<void>;
  now: number;
}): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0 };
  const groups = new Map<string, ZqReminder[]>();
  for (const reminder of await opts.reminders.due(opts.now))
    groups.set(groupKey(reminder), [...(groups.get(groupKey(reminder)) ?? []), reminder]);
  for (const group of groups.values()) {
    const first = group[0]!;
    const text = first.batch
      ? [first.batch.heading, ...group.map((r, i) => `${i + 1}. ${r.batch!.line}`)].join("\n")
      : first.text;
    try {
      await opts.send(first.recipientMmUserId, text, first.rule, first.target);
      for (const reminder of group) await opts.reminders.markSent(reminder.id);
      result.sent += group.length;
    } catch {
      result.failed += group.length;
    }
  }
  return result;
}
