import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createZqReports, reportPrompt, type ReportInput, type ZqReportDraft } from "../src/zq/reports.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { testMap } from "./support/test-database.ts";

const INPUT: ReportInput = {
  mmUserId: "mm1",
  opName: "Alice A",
  period: "daily",
  since: 0,
  until: 86_400_000,
  statusChanges: [{ workPackageId: 7, subject: "Boss intro", from: "fm.review", to: "fm.rework", at: 5 }],
  timeEntries: [
    { workPackageId: 7, subject: "Boss intro", hours: 2.5, comment: "storyboard" },
    { workPackageId: 8, subject: "Menu", hours: 1 },
  ],
};

function reports(opts: { write?: (prompt: string) => Promise<string>; written?: ZqReportDraft[] } = {}) {
  return createZqReports({
    map: testMap<ZqReportDraft>(),
    write: opts.write,
    writeBack: async (draft) => void opts.written?.push(draft),
    now: () => 1000,
  });
}

test("the prompt carries only the recorded facts", () => {
  const prompt = reportPrompt(INPUT);
  assert.match(prompt, /#7 Boss intro: fm\.review -> fm\.rework/);
  assert.match(prompt, /#7 Boss intro: 2\.5h \(storyboard\)/);
  assert.match(reportPrompt({ ...INPUT, statusChanges: [], timeEntries: [] }), /状态变化:\n- 无\n工时记录:\n- 无/);
});

test("without a writer the draft is a plain template, with one the writer's text is used", async () => {
  const plain = await reports().draft(INPUT);
  assert.match(plain.text, /已记工时:3\.5 小时/);
  assert.equal(plain.status, "pending");
  const prompts: string[] = [];
  const written = await reports({
    write: async (prompt) => {
      prompts.push(prompt);
      return "  Alice finished the storyboard.  ";
    },
  }).draft(INPUT);
  assert.equal(written.text, "Alice finished the storyboard.");
  assert.equal(prompts.length, 1);
  const empty = await reports({ write: async () => "   " }).draft(INPUT);
  assert.match(empty.text, /Alice A的日报草稿/);
});

test("a draft for the same person and period is made once", async () => {
  let calls = 0;
  const store = reports({ write: async () => `draft ${++calls}` });
  const first = await store.draft(INPUT);
  const second = await store.draft(INPUT);
  assert.equal(second.text, first.text);
  assert.equal(calls, 1);
});

test("only the person can decide, an approval writes back exactly once, and a discard never writes", async () => {
  const written: ZqReportDraft[] = [];
  const store = reports({ written });
  const draft = await store.draft(INPUT);
  await assert.rejects(store.decide(draft.id, true, "mm2", "mm2"), /只有报告对应的本人/);
  assert.deepEqual(written, []);
  const decisions = await Promise.all([
    store.decide(draft.id, true, "mm1", "mm1"),
    store.decide(draft.id, true, "mm1", "mm1"),
    store.decide(draft.id, true, "mm1", "mm1"),
  ]);
  assert.equal(written.length, 1);
  assert.ok(decisions.every((d) => d.status === "confirmed"));
  assert.equal((await store.decide(draft.id, false, "mm1", "mm1")).status, "confirmed", "a decision is final");
  assert.equal(written.length, 1);

  const other = await store.draft({ ...INPUT, until: 2 * 86_400_000 });
  assert.equal((await store.decide(other.id, false, "mm1", "mm1")).status, "discarded");
  assert.equal(written.length, 1);
  await assert.rejects(store.decide("nope", true, "mm1", "mm1"), /已经不存在/);
});

test("the service sends the weekly card to the project manager and the daily card to the person at the report time, and not before", async () => {
  const config = zqConfigFromEnv({ ZQ_REPORTS: "1", ZQ_REPORT_DAILY_AT: "18:30", ZQ_REPORT_WEEKLY_AT: "17:00" });
  const clock = { now: Date.UTC(2026, 10, 11, 8, 0) };
  const cards: Array<{ to: string; id: string; text: string }> = [];
  const store = reports();
  const service = createZqService({
    config,
    reader: { features: async () => ({ facts: [], problems: [] }), dutyHolders: async () => undefined },
    mmUserIdOfOpUser: async () => "mm-pm",
    people: async () => [{ mmUserId: "mm1", principalId: "internal:alice", opName: "Alice A" }],
    reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
    state: testMap<ZqRunState>(),
    send: async () => {},
    reports: {
      store,
      source: {
        build: async (person, period, since, until) => ({
          ...INPUT,
          mmUserId: person.mmUserId,
          period,
          since,
          until,
          projects: [{ id: "3", pmOpUserIds: ["9"] }],
        }),
      },
      sendCard: async (to, id, text) => void cards.push({ to, id, text }),
    },
    now: () => clock.now,
  });
  assert.equal((await service.tick()).reportsSent, 0, "the first tick only starts the clock");
  clock.now = Date.UTC(2026, 10, 11, 10, 29);
  assert.equal(
    (await service.tick()).reportsSent,
    1,
    "Wednesday 18:29 Shanghai: the weekly report (17:00) is due, the daily one (18:30) not yet",
  );
  clock.now = Date.UTC(2026, 10, 11, 10, 31);
  assert.equal((await service.tick()).reportsSent, 1, "Wednesday 18:31 Shanghai: the daily report");
  assert.deepEqual(
    cards.map((c) => c.to),
    ["mm-pm", "mm1"],
  );
  clock.now += 60_000;
  assert.equal((await service.tick()).reportsSent, 0);
});
