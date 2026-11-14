import type { ZqReminder, ZqReminderStore } from "./reminders.ts";

const KIND_LABEL: Record<ZqReminder["kind"], string> = {
  "remind-stale": "Needs an update",
  "remind-overdue": "Overdue",
  "escalate-blocked": "Blocked for a long time",
  "meeting-follow-up": "Meeting follow-up",
};

function reminderText(r: ZqReminder): string {
  const title = r.subjectTitle ? ` ${r.subjectTitle}` : "";
  const lines = [`**${KIND_LABEL[r.kind]}:**${title} (${r.subjectId})`, r.reason];
  if (r.blockers.length) lines.push(`Fill in before moving it on: ${r.blockers.join(", ")}`);
  return lines.join("\n");
}

export interface DeliveryResult {
  sent: number;
  failed: number;
}

export async function deliverDue(opts: {
  reminders: ZqReminderStore;
  send: (mmUserId: string, text: string) => Promise<void>;
  now: number;
}): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0 };
  for (const reminder of await opts.reminders.due(opts.now)) {
    try {
      await opts.send(reminder.recipientMmUserId, reminderText(reminder));
      await opts.reminders.markSent(reminder.id);
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
