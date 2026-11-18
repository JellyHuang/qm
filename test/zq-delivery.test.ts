import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { deliverDue } from "../src/zq/delivery.ts";
import { createZqReminderStore, type ZqReminder, type ZqReminderDraft } from "../src/zq/reminders.ts";
import { testMap } from "./support/test-database.ts";

const DAY = "2026-11-18";
const draft = (id: string, to: string, over: Partial<ZqReminderDraft> = {}): ZqReminderDraft => ({
  id,
  rule: "task-dates-missing",
  subjectId: `wp:${id}`,
  recipientMmUserId: to,
  text: `单 ${id}`,
  batch: { heading: "下面的单子还缺日期:", line: `单 ${id} 缺开始日期` },
  dayKey: DAY,
  dueAt: 1,
  ...over,
});

test("one person's date reminders of the day go out as one numbered message, other reminders stay one each", async () => {
  const reminders = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => 5 });
  for (const d of [
    draft("a", "mm-1"),
    draft("b", "mm-1"),
    draft("c", "mm-2"),
    draft("d", "mm-1", { rule: "task-overdue", batch: undefined, text: "逾期" }),
    draft("e", "mm-1", { dayKey: "2026-11-19" }),
  ])
    await reminders.schedule(d, "live");
  const sent: Array<[string, string, string]> = [];
  const out = await deliverDue({
    reminders,
    now: 10,
    send: async (to, text, rule) => void sent.push([to, text, rule]),
  });
  assert.deepEqual(out, { sent: 5, failed: 0 });
  assert.equal(sent.length, 4);
  const batched = sent.filter(([to, , rule]) => to === "mm-1" && rule === "task-dates-missing").map(([, text]) => text);
  assert.deepEqual(batched.map((t) => t.split("\n")).sort(), [
    ["下面的单子还缺日期:", "1. 单 a 缺开始日期", "2. 单 b 缺开始日期"],
    ["下面的单子还缺日期:", "1. 单 e 缺开始日期"],
  ]);
  assert.ok(sent.some(([to, text]) => to === "mm-2" && text.endsWith("1. 单 c 缺开始日期")));
  assert.ok(sent.some(([, text, rule]) => rule === "task-overdue" && text === "逾期"));
  assert.deepEqual(await reminders.pendingFor("mm-1"), []);
});

test("a failed batched send leaves every reminder in it pending to be retried together", async () => {
  const reminders = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => 5 });
  for (const id of ["a", "b"]) await reminders.schedule(draft(id, "mm-1"), "live");
  const down = await deliverDue({
    reminders,
    now: 10,
    send: async () => {
      throw new Error("mattermost down");
    },
  });
  assert.deepEqual(down, { sent: 0, failed: 2 });
  assert.equal((await reminders.pendingFor("mm-1")).length, 2);
  const sent: string[] = [];
  const up = await deliverDue({ reminders, now: 10, send: async (_to, text) => void sent.push(text) });
  assert.deepEqual(up, { sent: 2, failed: 0 });
  assert.equal(sent.length, 1);
});
