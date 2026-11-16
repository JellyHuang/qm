import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract, type ZqContract } from "../src/zq/contract.ts";
import {
  DEFAULT_RULE_OPTIONS,
  evaluateRules,
  type FeatureFacts,
  type RuleAction,
  type WorkView,
} from "../src/zq/rules.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 4, 0);
const OPTS = { ...DEFAULT_RULE_OPTIONS, now: NOW };
const ALICE = { id: "11", name: "Alice A" };
const BOB = { id: "12", name: "Bob B" };

function work(id: number, over: Partial<WorkView> = {}): WorkView {
  return { id, subject: `单${id}`, typeKey: "backend", statusKey: "execution.active", ...over };
}

const PLANNED = { plannedEnd: NOW + 30 * DAY };

function feature(stage: string, over: Partial<WorkView> = {}): WorkView {
  return work(1, { typeKey: "feature", statusKey: stage, projectId: "p1", responsiblePlanner: ALICE, ...over });
}

const rules = (facts: FeatureFacts, c: ZqContract = contract, o = OPTS): RuleAction[] => evaluateRules(facts, c, o);
const ids = (actions: RuleAction[]) => actions.map((a) => a.rule);

test("a work package that is not a feature never produces feature rules", () => {
  assert.deepEqual(rules({ feature: work(5), children: [] }), []);
});

test("suspended and cancelled features are skipped, a delayed one is not", () => {
  const stage = "feature.planning_unassigned";
  assert.deepEqual(rules({ feature: feature(stage, { lifecycle: "suspended" }), children: [] }), []);
  assert.deepEqual(rules({ feature: feature(stage, { lifecycle: "cancelled" }), children: [] }), []);
  assert.deepEqual(ids(rules({ feature: feature(stage, { lifecycle: "delayed" }), children: [] })), [
    "planner-unassigned",
  ]);
});

test("an unassigned planner and a pending review go to the owners the contract names for the stage", () => {
  const a = rules({ feature: feature("feature.planning_unassigned"), children: [] });
  assert.deepEqual(a[0]!.to, [
    { kind: "duty", duty: "producer" },
    { kind: "duty", duty: "pm" },
  ]);
  assert.match(a[0]!.text, /待分配策划/);
  const r = rules({ feature: feature("feature.review", { reviewer: BOB }), children: [] });
  assert.deepEqual(ids(r), ["review-pending"]);
  assert.deepEqual(r[0]!.to, [{ kind: "field", field: "reviewer" }]);
});

test("staffing asks the planner for trades when there are no child orders, and the duty leads for unassigned ones", () => {
  const empty = rules({ feature: feature("feature.staffing"), children: [] });
  assert.deepEqual(ids(empty), ["staffing-trades"]);
  assert.deepEqual(empty[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  const children = [
    work(2, { typeKey: "vfx", statusKey: "execution.unassigned" }),
    work(3, { typeKey: "scene_concept", statusKey: "execution.unassigned" }),
    work(4, { typeKey: "backend", statusKey: "execution.waiting" }),
    work(5, { typeKey: "frontend", statusKey: "execution.unassigned", lifecycle: "suspended" }),
  ];
  const assign = rules({ feature: feature("feature.staffing"), children });
  assert.deepEqual(ids(assign), ["task-unassigned"]);
  assert.deepEqual(assign[0]!.to, [{ kind: "duty", duty: "art_lead" }]);
  assert.match(assign[0]!.text, /2 张/);
});

test("the briefing stage needs a meeting, and follows up ten minutes after the planned end unless it is closed", () => {
  const f = feature("feature.briefing");
  assert.deepEqual(ids(rules({ feature: f, children: [] })), [], "no meeting link available: nothing is claimed");
  const missing = rules({ feature: f, children: [], meetings: [] });
  assert.deepEqual(ids(missing), ["briefing-meeting-missing"]);
  assert.deepEqual(missing[0]!.to, [{ kind: "field", field: "responsiblePlanner" }], "the planner only, not the PM");
  assert.deepEqual(
    ids(rules({ feature: f, children: [], meetings: [{ id: "m", title: "t", endAt: NOW, state: "cancelled" }] })),
    ["briefing-meeting-missing"],
  );
  const end = NOW - 9 * 60_000;
  assert.deepEqual(
    ids(rules({ feature: f, children: [], meetings: [{ id: "m", title: "t", endAt: end, state: "open" }] })),
    [],
  );
  const late = rules({
    feature: f,
    children: [],
    meetings: [{ id: "m", title: "宣讲", endAt: NOW - 11 * 60_000, state: "in_progress" }],
  });
  assert.deepEqual(ids(late), ["meeting-follow-up"]);
  assert.equal(late[0]!.subjectId, "meeting:m");
  assert.deepEqual(late[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  assert.deepEqual(
    ids(rules({ feature: f, children: [], meetings: [{ id: "m", title: "t", endAt: NOW - DAY, state: "closed" }] })),
    [],
  );
});

test("in production, missing estimates and dates go to the assignee until filled, skipping done and paused orders", () => {
  const children = [
    work(2, { assignee: BOB }),
    work(3, { assignee: BOB, estimateHours: 8, plannedStart: NOW, plannedEnd: NOW + DAY }),
    work(4, { assignee: BOB, statusKey: "execution.done" }),
    work(5, { assignee: BOB, lifecycle: "suspended" }),
    work(6),
  ];
  const a = rules({ feature: feature("feature.development", PLANNED), children });
  assert.deepEqual(ids(a), ["production-missing-plan"]);
  assert.deepEqual(a[0]!.to, [{ kind: "user", user: BOB }]);
  assert.match(a[0]!.text, /预计工时、计划开始时间、计划结束时间/);
});

test("an overdue order asks its assignee, and escalates only to the configured duties after the configured time", () => {
  const plan = { estimateHours: 1, plannedStart: NOW - 5 * DAY, plannedEnd: NOW - DAY };
  const late = work(2, { assignee: BOB, dueAt: NOW - 3 * DAY, ...plan });
  const plain = rules({ feature: feature("feature.development", PLANNED), children: [late] });
  assert.deepEqual(ids(plain), ["task-overdue"]);
  assert.match(plain[0]!.text, /3 天/);
  const escalating = rules({ feature: feature("feature.development", PLANNED), children: [late] }, contract, {
    ...OPTS,
    escalationDuties: ["pm", "planning_lead"],
  });
  assert.deepEqual(ids(escalating), ["task-overdue", "task-overdue-escalation"]);
  assert.deepEqual(escalating[1]!.to, [
    { kind: "duty", duty: "pm" },
    { kind: "duty", duty: "planning_lead" },
  ]);
  const recent = work(3, { assignee: BOB, dueAt: NOW - DAY, ...plan });
  const early = rules({ feature: feature("feature.development", PLANNED), children: [recent] }, contract, {
    ...OPTS,
    escalationDuties: ["pm"],
    escalateAfterMs: 2 * DAY,
  });
  assert.deepEqual(ids(early), ["task-overdue"]);
});

test("an exit-ready answer notifies the stage owners except where OpenProject advances the stage itself", () => {
  const f = feature("feature.development", PLANNED);
  assert.deepEqual(rules({ feature: f, children: [], exit: { ready: true, blockers: [] } }), []);
  const staffing = feature("feature.staffing");
  const ready = rules({
    feature: staffing,
    children: [work(9, { assignee: BOB })],
    exit: { ready: true, blockers: [] },
  });
  assert.deepEqual(ids(ready), ["exit-ready"]);
  assert.deepEqual(ready[0]!.to, [
    { kind: "field", field: "responsiblePlanner" },
    { kind: "duty", duty: "pm" },
  ]);
  assert.deepEqual(
    rules({ feature: staffing, children: [work(9, { assignee: BOB })], exit: { ready: false, blockers: ["x"] } }),
    [],
  );
  assert.deepEqual(rules({ feature: staffing, children: [work(9, { assignee: BOB })] }), []);
});

test("a feature in production without a planned end reminds the planner, and one with a planned end does not", () => {
  const a = rules({ feature: feature("feature.development"), children: [] });
  assert.deepEqual(ids(a), ["production-missing-planned-end"]);
  assert.deepEqual(a[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  assert.deepEqual(rules({ feature: feature("feature.development", PLANNED), children: [] }), []);
  assert.deepEqual(
    rules({
      feature: feature("feature.briefing"),
      children: [],
      meetings: [{ id: "m", title: "t", endAt: NOW + DAY, state: "open" }],
    }),
    [],
  );
});

test("an unassigned order is chased in any non-final stage, to the type's lead or to the planner named on the order", () => {
  const children = [
    work(2, { typeKey: "ui", statusKey: "execution.unassigned" }),
    work(3, { typeKey: "fgui", statusKey: "execution.unassigned" }),
    work(4, { typeKey: "configuration", statusKey: "execution.unassigned", responsiblePlanner: BOB }),
    work(5, { typeKey: "configuration", statusKey: "execution.unassigned" }),
    work(6, { typeKey: "backend", statusKey: "execution.waiting" }),
  ];
  for (const stage of ["feature.development", "feature.acceptance", "feature.qa"]) {
    const a = rules({ feature: feature(stage, PLANNED), children }).filter((x) => x.rule === "task-unassigned");
    assert.deepEqual(
      a.map((x) => x.to),
      [[{ kind: "duty", duty: "ui_lead" }], [{ kind: "user", user: BOB }]],
      stage,
    );
    assert.match(a[0]!.text, /2 张/);
  }
});

test("an open blocking bug reminds its owner and the QA owner, a closed or non-blocking one says nothing, bugs never trigger order rules", () => {
  const QA = { id: "31", name: "Qa Q" };
  const bug = (id: number, over: Partial<WorkView> = {}) =>
    work(id, { typeKey: "bug", statusKey: "bug.fixing", assignee: BOB, blocking: true, ...over });
  const a = rules({
    feature: feature("feature.qa", { qaOwner: QA }),
    children: [],
    bugs: [
      bug(7),
      bug(8, { statusKey: "bug.closed" }),
      bug(9, { blocking: false }),
      bug(10, { lifecycle: "cancelled" }),
    ],
  });
  assert.deepEqual(ids(a), ["blocking-bug-open"]);
  assert.deepEqual(a[0]!.to, [
    { kind: "user", user: BOB },
    { kind: "user", user: QA },
  ]);
  assert.equal(a[0]!.subjectId, "wp:7");
  const dev = rules({
    feature: feature("feature.development", PLANNED),
    children: [],
    bugs: [bug(11, { statusKey: "bug.unassigned", assignee: undefined })],
  });
  assert.deepEqual(ids(dev), []);
});

test("waiting for formal assets reminds each owner about their own orders and gives the PM the summary", () => {
  const PM = { id: "41", name: "Pm P" };
  const awaited = [
    { id: 2, typeKey: "vfx", stageKey: "execution.active", owner: BOB },
    { id: 3, typeKey: "vfx", stageKey: "execution.waiting", owner: BOB },
    { id: 4, typeKey: "backend", stageKey: "execution.active", owner: ALICE },
  ];
  const a = rules({ feature: feature("feature.resources", { pm: PM, awaited }), children: [] });
  assert.deepEqual(ids(a), ["formal-assets-pending", "formal-assets-pending", "formal-assets-pending"]);
  assert.deepEqual(a[0]!.to, [{ kind: "user", user: BOB }]);
  assert.match(a[0]!.text, /2 张执行单未完成:#2、#3/);
  assert.deepEqual(a[1]!.to, [{ kind: "user", user: ALICE }]);
  assert.deepEqual(a[2]!.to, [{ kind: "field", field: "pm" }]);
  assert.match(a[2]!.text, /3 张执行单未完成/);
  const note = rules({
    feature: feature("feature.resources", { pm: PM, awaited, awaitingNote: "等待:#2 #3 #4" }),
    children: [],
  });
  assert.equal(note[2]!.text, "等待:#2 #3 #4");
  assert.deepEqual(rules({ feature: feature("feature.resources", { pm: PM, awaited: [] }), children: [] }), []);
});

test("the review is for the reviewer on the order, the QA stage for the QA owner and the acceptance for the acceptor", () => {
  const reviewer = { id: "22", name: "Rev R" };
  const review = rules({ feature: feature("feature.review", { reviewer }), children: [] });
  assert.deepEqual(ids(review), ["review-pending"]);
  assert.deepEqual(review[0]!.to, [{ kind: "field", field: "reviewer" }]);
  const qa = rules({
    feature: feature("feature.qa", { qaOwner: { id: "23", name: "QA Q" } }),
    children: [],
    exit: { ready: true, blockers: [] },
  });
  assert.deepEqual(qa[0]!.to, [{ kind: "field", field: "qaOwner" }]);
  const acceptance = rules({
    feature: feature("feature.acceptance", { acceptor: ALICE }),
    children: [],
    exit: { ready: true, blockers: [] },
  });
  assert.deepEqual(acceptance[0]!.to, [{ kind: "field", field: "acceptor" }]);
});

test("an empty responsibility field never falls back to a duty group: it is reported to the configured duties", () => {
  const unset = rules({ feature: feature("feature.review"), children: [] }, contract, { ...OPTS, unsetDuties: ["pm"] });
  assert.deepEqual(ids(unset), ["responsibility-not-set"]);
  assert.deepEqual(unset[0]!.to, [{ kind: "duty", duty: "pm" }]);
  assert.equal(unset[0]!.subjectId, "wp:1:reviewer");
  assert.match(unset[0]!.text, /需要审核人,但还没有设置/);
  const unconfigured = rules({ feature: feature("feature.review"), children: [] });
  assert.deepEqual(ids(unconfigured), ["responsibility-not-set"]);
  assert.deepEqual(unconfigured[0]!.to, [], "counted, but nobody is guessed");
  assert.deepEqual(ids(rules({ feature: feature("feature.review", { reviewer: ALICE }), children: [] })), [
    "review-pending",
  ]);
});

test("a missing planner is reported once per field even when several rules would have used it", () => {
  const f = feature("feature.briefing", { responsiblePlanner: undefined });
  const out = rules(
    { feature: f, children: [], meetings: [{ id: "m", title: "t", endAt: NOW - DAY, state: "open" }] },
    contract,
    {
      ...OPTS,
      unsetDuties: ["pm"],
    },
  );
  assert.deepEqual(ids(out), ["responsibility-not-set"]);
});

test("an unclosed meeting is reminded again on every scan day until OpenProject says it is closed, to the planner only", () => {
  const f = feature("feature.briefing");
  const meeting = (state: string) => ({ id: "m", title: "宣讲", endAt: NOW - 3 * DAY, state });
  for (const state of ["open", "in_progress", "draft"]) {
    const out = rules({ feature: f, children: [], meetings: [meeting(state)] });
    assert.deepEqual(ids(out), ["meeting-follow-up"], state);
    assert.deepEqual(out[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  }
  assert.deepEqual(ids(rules({ feature: f, children: [], meetings: [meeting("closed")] })), []);
});
