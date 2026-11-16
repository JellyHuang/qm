import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createZqReports, type ZqReportDraft } from "../src/zq/reports.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { testMap } from "./support/test-database.ts";

const ALICE = { mmUserId: "mm-alice", principalId: "internal:alice", opUserId: "1", opName: "Alice A" };
const BOB = { mmUserId: "mm-bob", principalId: "internal:bob", opUserId: "2", opName: "Bob B" };
const MM_OF = new Map([
  ["10", "mm-pm"],
  ["11", "mm-pm2"],
]);
const WEEKLY_DUE = Date.UTC(2026, 10, 11, 10, 1);
const DAILY_DUE = Date.UTC(2026, 10, 11, 10, 31);

function harness(opts: {
  projectsOf: Record<string, string[]>;
  featurePm?: Record<string, string>;
  duty?: Record<string, string[]>;
  daily?: boolean;
  names?: Record<string, string>;
  failSends?: Record<string, number>;
}) {
  const config = zqConfigFromEnv({
    ZQ_REPORTS: "1",
    ZQ_REPORT_WEEKLY_AT: "17:00",
    ...(opts.daily ? { ZQ_REPORT_DAILY_AT: "18:30" } : {}),
  });
  const clock = { now: Date.UTC(2026, 10, 11, 8, 0) };
  const cards: Array<{ to: string; id: string; text: string }> = [];
  const state = testMap<ZqRunState>();
  const store = createZqReports({
    map: testMap<ZqReportDraft>(),
    write: undefined,
    writeBack: async () => {},
    now: () => 1000,
  });
  const dutyCalls: string[] = [];
  const attempts: string[] = [];
  const builds: number[] = [];
  const service = createZqService({
    config,
    reader: {
      features: async () => ({ facts: [], problems: [] }),
      dutyHolders: async (_person, projectId) => {
        dutyCalls.push(projectId);
        return opts.duty?.[projectId]?.map((id) => ({ id, name: id }));
      },
    },
    mmUserIdOfOpUser: async (id) => MM_OF.get(id),
    people: async () => [ALICE, BOB],
    reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
    state,
    send: async () => {},
    reports: {
      store,
      source: {
        build: async (person, period, since, until) => {
          builds.push(clock.now);
          const projects = opts.projectsOf[person.mmUserId] ?? [];
          return {
            mmUserId: person.mmUserId,
            opName: person.opName,
            period,
            since,
            until,
            statusChanges: projects.map((p) => ({
              workPackageId: 100 + Number(person.opUserId),
              subject: `${person.opName} task in ${p}`,
              to: "进行中",
              at: 5,
              projectId: p,
            })),
            timeEntries: projects.map((p) => ({
              workPackageId: 900,
              subject: `${person.opName} hours in ${p}`,
              hours: 2,
              projectId: p,
            })),
            projects: projects.map((id) => ({
              id,
              ...(opts.names?.[id] ? { name: opts.names[id] } : {}),
              pmOpUserIds: opts.featurePm?.[id] ? [opts.featurePm[id]!] : [],
            })),
          };
        },
      },
      sendCard: async (to, id, text) => {
        attempts.push(to);
        const left = opts.failSends?.[to] ?? 0;
        if (left > 0) {
          opts.failSends![to] = left - 1;
          throw new Error("mattermost down");
        }
        cards.push({ to, id, text });
      },
    },
    now: () => clock.now,
    sendRetryDelayMs: 0,
  });
  const tickAt = async (at: number) => {
    clock.now = at;
    return service.tick();
  };
  return { store, cards, attempts, builds, state, dutyCalls, tickAt };
}

test("a weekly report goes to the project manager only, one draft with a section per person", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"], "mm-bob": ["3"] }, featurePm: { "3": "10" } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 1);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm"],
  );
  const text = h.cards[0]!.text;
  assert.match(text, /Alice A:/);
  assert.match(text, /Bob B:/);
  assert.match(text, /Alice A task in 3/);
  assert.match(text, /Bob B hours in 3/);
});

test("two projects give two drafts and never mix each other's work", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3", "4"], "mm-bob": ["4"] },
    featurePm: { "3": "10", "4": "11" },
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 2);
  const byTo = new Map(h.cards.map((c) => [c.to, c.text]));
  assert.deepEqual([...byTo.keys()].sort(), ["mm-pm", "mm-pm2"]);
  assert.match(byTo.get("mm-pm")!, /Alice A task in 3/);
  assert.doesNotMatch(byTo.get("mm-pm")!, /in 4|Bob/);
  assert.match(byTo.get("mm-pm2")!, /Alice A task in 4/);
  assert.match(byTo.get("mm-pm2")!, /Bob B task in 4/);
  assert.doesNotMatch(byTo.get("mm-pm2")!, /in 3/);
});

test("without a feature pm the duty holder of the project is the addressee", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, duty: { "3": ["11"] } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  await h.tickAt(WEEKLY_DUE);
  assert.deepEqual(h.dutyCalls, ["3"]);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm2"],
  );
});

test("only the addressed manager can confirm, and the confirmation says it is not written back", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm: { "3": "10" } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  await h.tickAt(WEEKLY_DUE);
  const id = h.cards[0]!.id;
  await assert.rejects(h.store.decide(id, true, "mm-alice", "mm-alice"), /只有收到这份周报的项目经理/);
  await assert.rejects(h.store.decide(id, true, "mm-pm2", "mm-pm2"), /只有收到这份周报的项目经理/);
  const confirmed = await h.store.decide(id, true, "mm-pm", "mm-pm");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.writtenBack, undefined);
});

test("a project without a reachable manager is not sent, is recorded as skipped and counted", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3", "4"] },
    featurePm: { "3": "99" },
    duty: { "4": [] },
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 0);
  assert.equal(out.weeklyNoPm, 2);
  assert.deepEqual(h.cards, []);
  const again = await h.store.draftProject({
    projectId: "3",
    weekKey: "2026-11-09",
    since: 0,
    until: 0,
    sections: [],
    addressees: [],
  });
  assert.equal(again.created, false, "the skipped record exists durably");
  assert.equal(again.draft.status, "skipped");
  assert.equal(again.draft.skipReason, "no_pm");
  await assert.rejects(h.store.decide(again.draft.id, true, "mm-pm", "mm-pm"));
});

test("running the weekly cron again in the same week adds and sends nothing", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3", "4"] }, featurePm: { "3": "10" } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const first = await h.tickAt(WEEKLY_DUE);
  assert.deepEqual([first.reportsSent, first.weeklyNoPm], [1, 1]);
  await h.state.put("report:weekly", { lastRunAt: Date.UTC(2026, 10, 10) });
  const second = await h.tickAt(WEEKLY_DUE + 60_000);
  assert.deepEqual([second.reportsSent, second.weeklyNoPm], [0, 0]);
  assert.equal(h.cards.length, 1);
});

test("the daily report still goes to each person as before", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3"], "mm-bob": ["3"] },
    featurePm: { "3": "10" },
    daily: true,
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 10, 29));
  const out = await h.tickAt(DAILY_DUE);
  assert.equal(out.reportsSent, 2);
  assert.deepEqual(h.cards.map((c) => c.to).sort(), ["mm-alice", "mm-bob"]);
  const draft = await h.store.decide(h.cards[0]!.id, true, h.cards[0]!.to, h.cards[0]!.to);
  assert.equal(draft.status, "confirmed");
  await assert.rejects(h.store.decide(h.cards[1]!.id, true, "mm-pm", "mm-pm"), /只有报告对应的本人/);
});

test("the draft names the project and falls back to the id when the name is unknown", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3", "4"] },
    featurePm: { "3": "10", "4": "11" },
    names: { "3": "ZQ" },
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  await h.tickAt(WEEKLY_DUE);
  const byTo = new Map(h.cards.map((c) => [c.to, c.text]));
  assert.match(byTo.get("mm-pm")!, /^项目 ZQ 的周报草稿/);
  assert.match(byTo.get("mm-pm2")!, /^项目 4 的周报草稿/);
});

test("a project skipped for no manager gets its draft and cards once a manager appears in the same week", async () => {
  const featurePm: Record<string, string> = {};
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm, duty: { "3": [] } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const first = await h.tickAt(WEEKLY_DUE);
  assert.deepEqual([first.reportsSent, first.weeklyNoPm], [0, 1]);
  const still = await h.tickAt(WEEKLY_DUE + 3_600_000);
  assert.deepEqual([still.reportsSent, still.weeklyNoPm], [0, 0]);
  assert.equal(h.cards.length, 0);
  featurePm["3"] = "10";
  const found = await h.tickAt(WEEKLY_DUE + 7_200_000);
  assert.deepEqual([found.reportsSent, found.weeklyNoPm], [1, 0]);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm"],
  );
  const stored = await h.store.openProjectDrafts("2026-11-09");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.status, "pending");
  assert.equal(stored[0]!.skipReason, undefined);
  const later = await h.tickAt(WEEKLY_DUE + 10_800_000);
  assert.equal(later.reportsSent, 0);
  assert.equal(h.cards.length, 1);
});

test("a card send that fails twice then succeeds is delivered once and marked delivered", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm: { "3": "10" }, failSends: { "mm-pm": 2 } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.deepEqual([out.reportsSent, out.weeklyCardFailed], [1, 0]);
  assert.deepEqual(h.attempts, ["mm-pm", "mm-pm", "mm-pm"]);
  assert.equal(h.cards.length, 1);
  const [draft] = await h.store.openProjectDrafts("2026-11-09");
  assert.deepEqual(draft!.delivered, ["mm-pm"]);
  assert.equal(draft!.status, "pending");
});

test("a card send that always fails stops after three tries, is counted and is not retried by later scans", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm: { "3": "10" }, failSends: { "mm-pm": 99 } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.deepEqual([out.reportsSent, out.weeklyCardFailed], [0, 1]);
  assert.equal(h.attempts.length, 3);
  const later = await h.tickAt(WEEKLY_DUE + 3_600_000);
  assert.deepEqual([later.reportsSent, later.weeklyCardFailed], [0, 0]);
  assert.equal(h.attempts.length, 3);
  const [draft] = await h.store.openProjectDrafts("2026-11-09");
  assert.equal(draft!.sendFailures?.["mm-pm"], 3);
  assert.equal(draft!.status, "pending");
});

test("a later scan never resends to an addressee who already received the card", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3"] },
    duty: { "3": ["10", "11"] },
    failSends: { "mm-pm2": 99 },
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.deepEqual([out.reportsSent, out.weeklyCardFailed], [1, 1]);
  assert.deepEqual(h.attempts, ["mm-pm", "mm-pm2", "mm-pm2", "mm-pm2"]);
  await h.tickAt(WEEKLY_DUE + 3_600_000);
  assert.equal(h.attempts.length, 4);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm"],
  );
});

test("the skipped-project recheck rebuilds the weekly reports at most every 30 minutes and picks up a new manager then", async () => {
  const featurePm: Record<string, string> = {};
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm, duty: { "3": [] } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  await h.tickAt(WEEKLY_DUE);
  const afterCron = h.builds.length;
  await h.tickAt(WEEKLY_DUE + 5 * 60_000);
  const first = h.builds.length;
  assert.ok(first > afterCron, "the first recheck rebuilds");
  featurePm["3"] = "10";
  const early = await h.tickAt(WEEKLY_DUE + 10 * 60_000);
  assert.equal(h.builds.length, first, "five minutes later nothing is rebuilt");
  assert.equal(early.reportsSent, 0);
  assert.equal(h.cards.length, 0);
  const late = await h.tickAt(WEEKLY_DUE + 36 * 60_000);
  assert.ok(h.builds.length > first, "after 30 minutes it rebuilds again");
  assert.equal(late.reportsSent, 1);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm"],
  );
});
