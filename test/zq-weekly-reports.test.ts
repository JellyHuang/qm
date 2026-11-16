import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createReportSource } from "../src/zq/report-source.ts";
import { createZqReports, type ZqReportDraft } from "../src/zq/reports.ts";
import { parseContract } from "../src/zq/contract.ts";
import type { OpReader, ScanPerson } from "../src/zq/scanner.ts";
import type { WorkView } from "../src/zq/rules.ts";
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
const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);

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
  const drafts = testMap<ZqReportDraft>();
  const store = createZqReports({ map: drafts, write: undefined, writeBack: async () => {}, now: () => 1000 });
  const calls: string[] = [];
  const attempts: string[] = [];
  const workOf = (person: ScanPerson, project: string) => 100 * Number(person.opUserId) + Number(project);
  const reader: OpReader = {
    features: async (person) => {
      calls.push(`features:${person.mmUserId}`);
      const facts = (opts.projectsOf[person.mmUserId] ?? []).map((project) => {
        const view = (id: number, subject: string): WorkView => ({
          id,
          subject,
          typeKey: "feature",
          statusKey: "feature.development",
          projectId: project,
          ...(opts.names?.[project] ? { projectName: opts.names[project]! } : {}),
        });
        const pm = opts.featurePm?.[project];
        return {
          feature: {
            ...view(9000 + Number(project), `feature ${project}`),
            ...(pm ? { pm: { id: pm, name: pm } } : {}),
          },
          children: [view(workOf(person, project), `${person.opName} task in ${project}`)],
        };
      });
      return { facts, problems: [] };
    },
    dutyHolders: async (_person, projectId) => {
      calls.push(`duty:${projectId}`);
      return opts.duty?.[projectId]?.map((id) => ({ id, name: id }));
    },
    changes: async (person, projectId) => {
      calls.push(`changes:${projectId}:${person.mmUserId}`);
      return {
        events: [
          {
            id: `e-${person.opUserId}-${projectId}`,
            ticketId: workOf(person, projectId),
            featureId: 9000 + Number(projectId),
            kinds: ["stage"],
            newStage: "execution.active",
            old: {},
            new: { assignee: person.opUserId },
            actorId: person.opUserId,
            byRule: false,
            at: WEEKLY_DUE - 3_600_000,
          },
        ],
        nextCursor: "c",
      };
    },
  };
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push(`${tool}:${String(args["user"])}`);
    const person = [ALICE, BOB].find((p) => p.opUserId === args["user"])!;
    return JSON.stringify({
      next_offset: null,
      results: (opts.projectsOf[person.mmUserId] ?? []).map((p) => ({ work_package_id: workOf(person, p), hours: 2 })),
    });
  };
  const service = createZqService({
    config,
    reader,
    mmUserIdOfOpUser: async (id) => MM_OF.get(id),
    people: async () => [ALICE, BOB],
    reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
    state,
    send: async () => {},
    reports: {
      store,
      source: { build: createReportSource({ reader, call, contract, timezone: config.scanner.timezone }) },
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
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  return { store, drafts, cards, attempts, state, calls, count, tickAt };
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
  assert.match(text, /已记工时:2 小时/);
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
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("duty:")),
    ["duty:3"],
  );
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

test("a project without a manager builds nothing: no feed or time reads, no draft, no card", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"], "mm-bob": ["3"] }, duty: { "3": [] } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 0);
  assert.deepEqual(h.cards, []);
  assert.equal(h.count("changes:"), 0);
  assert.equal(h.count("openproject_list_time_entries"), 0);
  assert.equal(h.count("duty:"), 1);
  assert.deepEqual(await h.drafts.select({}), []);
  const later = await h.tickAt(WEEKLY_DUE + 3_600_000);
  assert.equal(later.reportsSent, 0);
  assert.equal(h.count("duty:"), 1);
});

test("a project manager without a Mattermost account counts as no manager", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm: { "3": "99" } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 0);
  assert.equal(h.count("changes:"), 0);
  assert.equal(h.count("openproject_list_time_entries"), 0);
  assert.deepEqual(await h.drafts.select({}), []);
});

test("a project with a feature pm resolves without any duty read", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3"] }, featurePm: { "3": "10" } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  await h.tickAt(WEEKLY_DUE);
  assert.equal(h.count("duty:"), 0);
  assert.equal(h.cards.length, 1);
});

test("only the project with a manager is read and drafted, and each person's features are read once", async () => {
  const h = harness({
    projectsOf: { "mm-alice": ["3", "4"], "mm-bob": ["4"] },
    featurePm: { "3": "10" },
    duty: { "4": [] },
  });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const out = await h.tickAt(WEEKLY_DUE);
  assert.equal(out.reportsSent, 1);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-pm"],
  );
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("changes:")),
    ["changes:3:mm-alice"],
  );
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("openproject_list_time_entries")),
    ["openproject_list_time_entries:1"],
  );
  assert.equal(h.count("features:"), 2);
  const stored = await h.drafts.select({});
  assert.deepEqual(
    stored.map((d) => d.id),
    ["project:3:weekly:2026-11-09"],
  );
  assert.doesNotMatch(h.cards[0]!.text, /in 4/);
});

test("running the weekly cron again in the same week adds and sends nothing", async () => {
  const h = harness({ projectsOf: { "mm-alice": ["3", "4"] }, featurePm: { "3": "10" }, duty: { "4": [] } });
  await h.tickAt(Date.UTC(2026, 10, 11, 8, 0));
  const first = await h.tickAt(WEEKLY_DUE);
  assert.equal(first.reportsSent, 1);
  await h.state.put("report:weekly", { lastRunAt: Date.UTC(2026, 10, 10) });
  const second = await h.tickAt(WEEKLY_DUE + 60_000);
  assert.equal(second.reportsSent, 0);
  assert.equal(h.cards.length, 1);
  assert.equal((await h.drafts.select({})).length, 1);
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
