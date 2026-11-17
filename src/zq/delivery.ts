import type { ZqReminderStore } from "./reminders.ts";

export interface DeliveryResult {
  sent: number;
  failed: number;
}

export async function deliverDue(opts: {
  reminders: ZqReminderStore;
  send: (mmUserId: string, text: string, rule: string) => Promise<void>;
  now: number;
}): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0 };
  for (const reminder of await opts.reminders.due(opts.now)) {
    try {
      await opts.send(reminder.recipientMmUserId, reminder.text, reminder.rule);
      await opts.reminders.markSent(reminder.id);
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
