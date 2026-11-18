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

const keyTable = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const { defaultLead: _drafted, ...undrafted } = keyTable;
const contract: ZqContract = { ...undrafted, typeLeads: {} };
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
  return work(1, {
    typeKey: "feature",
    statusKey: stage,
    projectId: "p1",
    responsiblePlanner: ALICE,
    assignee: ALICE,
    ...over,
  });
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
  const a = rules({ feature: feature("feature.development", PLANNED), children }).filter(
    (x) => x.rule !== "task-dates-missing",
  );
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

test("the review is for the reviewer on the order, the QA stage for the QA owner and the acceptance for the planner", () => {
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
    feature: feature("feature.acceptance"),
    children: [],
    exit: { ready: true, blockers: [] },
  });
  assert.deepEqual(acceptance[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
});

test("an empty responsibility field never falls back to a duty group: it is reported to the configured duties", () => {
  const unset = rules({ feature: feature("feature.review"), children: [] }, contract, { ...OPTS, unsetDuties: ["pm"] });
  assert.deepEqual(ids(unset), ["responsibility-not-set"]);
  assert.deepEqual(unset[0]!.to, [{ kind: "duty", duty: "pm" }]);
  assert.equal(unset[0]!.subjectId, "wp:1:reviewer");
  assert.match(unset[0]!.text, /需要制作人,但还没有设置/);
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

test("a delayed feature gets one notice to its planner and PM naming the day the delay began, keyed by the delay mark", () => {
  const PM = { id: "41", name: "Pm P" };
  const delayed = feature("feature.development", {
    ...PLANNED,
    pm: PM,
    delayMarked: true,
    delayedSince: NOW - 3 * DAY,
  });
  const a = rules({ feature: delayed, children: [] });
  assert.deepEqual(ids(a), ["delay-notice"]);
  assert.deepEqual(a[0]!.to, [
    { kind: "field", field: "responsiblePlanner" },
    { kind: "field", field: "pm" },
  ]);
  assert.equal(a[0]!.subjectId, `wp:1:delay:${NOW - 3 * DAY}`);
  assert.equal(a[0]!.once, true);
  assert.match(a[0]!.text, /「单1」\(#1\)/);
  assert.match(a[0]!.text, /自 2026-11-11 起/);
  assert.doesNotMatch(a[0]!.text, /@/);
  const again = rules({ feature: { ...delayed, delayedSince: NOW - DAY }, children: [] });
  assert.notEqual(again[0]!.subjectId, a[0]!.subjectId);
});

test("a feature that is not marked delayed gets no delay notice, and a mark without a date does not crash", () => {
  const dev = (over: Partial<WorkView>) => feature("feature.development", { ...PLANNED, pm: ALICE, ...over });
  assert.deepEqual(ids(rules({ feature: dev({ delayMarked: false, delayedSince: NOW - DAY }), children: [] })), []);
  assert.deepEqual(ids(rules({ feature: dev({ lifecycle: "delayed" }), children: [] })), []);
  const undated = rules({ feature: dev({ delayMarked: true }), children: [] });
  assert.deepEqual(ids(undated), ["delay-notice"]);
  assert.equal(undated[0]!.subjectId, "wp:1:delay:unknown");
  assert.doesNotMatch(undated[0]!.text, /undefined|NaN/);
});

const optimization = (over: Partial<WorkView> = {}): WorkView =>
  work(60, {
    typeKey: "optimization",
    statusKey: "execution.unassigned",
    projectId: "p1",
    responsiblePlanner: ALICE,
    ...over,
  });

test("an optimization order with nobody assigned asks its planner; one handled by a single person asks nobody", () => {
  const unassigned = rules({ feature: optimization(), children: [] });
  assert.deepEqual(ids(unassigned), ["optimization-unassigned"]);
  assert.match(unassigned[0]!.text, /优化单「单60」\(#60\)还没有指派/);
  assert.deepEqual(unassigned[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  assert.deepEqual(
    rules({ feature: optimization({ assignee: BOB, statusKey: "execution.waiting" }), children: [] }),
    [],
  );
});

test("an optimization order has no plan-date rules, but a late single assignee or child order is chased", () => {
  const single = optimization({ assignee: BOB, statusKey: "execution.active" });
  assert.deepEqual(rules({ feature: single, children: [] }), []);
  const late = rules({ feature: { ...single, dueAt: NOW - 3 * DAY }, children: [] });
  assert.deepEqual(ids(late), ["task-overdue"]);
  assert.equal(late[0]!.subjectId, "wp:60");
  const childLate = work(61, { parentId: 60, assignee: ALICE, dueAt: NOW - DAY });
  assert.deepEqual(ids(rules({ feature: optimization({ statusKey: "execution.active" }), children: [childLate] })), [
    "task-overdue",
  ]);
});

test("child orders without an executor go to the type's lead, and finished children ask the planner once to close the order", () => {
  const open = work(61, { parentId: 60, typeKey: "backend", statusKey: "execution.unassigned" });
  const dispatched = rules({ feature: optimization(), children: [open] });
  assert.deepEqual(ids(dispatched), ["task-unassigned"]);
  assert.deepEqual(dispatched[0]!.to, [{ kind: "duty", duty: "server_lead" }]);
  assert.match(dispatched[0]!.text, /优化单「单60」/);
  const finished = [61, 62].map((id) => work(id, { parentId: 60, statusKey: "execution.done", assignee: BOB }));
  const done = rules({ feature: optimization({ statusKey: "execution.active" }), children: finished });
  assert.deepEqual(ids(done), ["optimization-children-done"]);
  assert.equal(done[0]!.once, true);
  assert.deepEqual(rules({ feature: optimization({ statusKey: "execution.done" }), children: finished }), []);
});

test("without an optimization type in the contract the order is just another ticket", () => {
  const plain = parseContract({
    ...JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
    optimizationType: undefined,
  });
  assert.deepEqual(rules({ feature: optimization(), children: [] }, plain), []);
});

test("a submitted completion confirmation asks the planner to accept it once and silences the executor's overdue reminder", () => {
  const submitted = optimization({
    assignee: BOB,
    statusKey: "execution.active",
    completionSubmitted: true,
    dueAt: NOW - 2 * DAY,
  });
  const actions = rules({ feature: submitted, children: [] });
  assert.deepEqual(ids(actions), ["optimization-completion-submitted"]);
  assert.equal(actions[0]!.once, true);
  assert.deepEqual(actions[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  assert.match(actions[0]!.text, /已提交完成确认.*已完成/);
  assert.deepEqual(rules({ feature: { ...submitted, statusKey: "execution.done" }, children: [] }), []);
});

const attachedFeature = (over: Partial<WorkView> = {}) =>
  feature("feature.development", { pm: BOB, plannedEnd: NOW + 30 * DAY, ...over });
const attached = (id: number, over: Partial<WorkView> = {}) =>
  work(id, { typeKey: "optimization", parentId: 1, statusKey: "execution.unassigned", ...over });

test("an optimization order under a feature asks the feature's planner to assign it, and is never chased for plan dates", () => {
  const actions = rules({ feature: attachedFeature({ plannedEnd: NOW + DAY }), children: [attached(70)] });
  assert.deepEqual(ids(actions), ["optimization-unassigned"]);
  assert.deepEqual(actions[0]!.to, [{ kind: "field", field: "responsiblePlanner" }]);
  const planned = attached(71, { assignee: BOB, statusKey: "execution.active" });
  assert.deepEqual(rules({ feature: attachedFeature({ plannedEnd: NOW + DAY }), children: [planned] }), []);
});

test("an optimization order under a feature goes to its own planner once the executor submits, and its child orders close it", () => {
  const own = attached(72, {
    assignee: BOB,
    statusKey: "execution.active",
    completionSubmitted: true,
    responsiblePlanner: { id: "21", name: "Planner Own" },
  });
  const submitted = rules({ feature: attachedFeature(), children: [own] });
  assert.deepEqual(ids(submitted), ["optimization-completion-submitted"]);
  assert.deepEqual(submitted[0]!.to, [{ kind: "user", user: { id: "21", name: "Planner Own" } }]);
  const parent = attached(73, { statusKey: "execution.active" });
  const kids = [74, 75].map((id) => work(id, { parentId: 73, statusKey: "execution.done", assignee: BOB }));
  const closing = rules({ feature: attachedFeature(), children: [parent, ...kids] });
  assert.deepEqual(ids(closing), ["optimization-children-done"]);
  assert.equal(closing[0]!.subjectId, "wp:73");
});

test("the child orders of an optimization order under a feature are not chased as the feature's own orders", () => {
  const parent = attached(76, { statusKey: "execution.active", assignee: BOB });
  const kid = work(77, { parentId: 76, statusKey: "execution.active", assignee: BOB });
  assert.deepEqual(rules({ feature: attachedFeature(), children: [parent, kid] }), []);
});

test("an order still in the unassigned stage that already has an executor is not reported as having none", () => {
  const assigned = work(2, { typeKey: "backend", statusKey: "execution.unassigned", assignee: BOB });
  const open = work(3, { typeKey: "backend", statusKey: "execution.unassigned" });
  const out = rules({ feature: feature("feature.development", PLANNED), children: [assigned, open] }).filter(
    (a) => a.rule === "task-unassigned",
  );
  assert.equal(out.length, 1);
  assert.match(out[0]!.text, /#3/);
  assert.doesNotMatch(out[0]!.text, /#2/);
});

test("each new submission time of an optimization order is reminded once, and a missing time keeps the single reminder", () => {
  const base = optimization({ assignee: BOB, statusKey: "execution.active", completionSubmitted: true });
  const first = rules({ feature: { ...base, completionSubmittedAt: NOW - DAY }, children: [] })[0]!;
  const again = rules({ feature: { ...base, completionSubmittedAt: NOW - DAY }, children: [] })[0]!;
  const resubmitted = rules({ feature: { ...base, completionSubmittedAt: NOW }, children: [] })[0]!;
  const untimed = rules({ feature: base, children: [] })[0]!;
  assert.equal(first.subjectId, again.subjectId);
  assert.notEqual(first.subjectId, resubmitted.subjectId);
  assert.equal(untimed.subjectId, "wp:60");
  assert.ok([first, resubmitted, untimed].every((a) => a.once === true));
});

test("a feature with responsible planners and no assignee asks the producer once which planner takes it", () => {
  const second = { id: "15", name: "Carol C" };
  const many = feature("feature.planning", {
    assignee: undefined,
    planners: [ALICE, second],
    reviewer: { id: "22", name: "Rev R" },
  });
  const asked = rules({ feature: many, children: [] }).filter((a) => a.rule === "assignee-unconfirmed");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.to, [{ kind: "field", field: "reviewer" }]);
  assert.match(asked[0]!.text, /还没有受理人.*Alice A、Carol C.*确认哪一位/);
  assert.equal(asked[0]!.once, true);
  const again = rules({ feature: many, children: [] }).filter((a) => a.rule === "assignee-unconfirmed")[0]!;
  assert.equal(again.subjectId, asked[0]!.subjectId);
  const changed = rules({ feature: { ...many, planners: [ALICE, BOB] }, children: [] }).filter(
    (a) => a.rule === "assignee-unconfirmed",
  )[0]!;
  assert.notEqual(changed.subjectId, asked[0]!.subjectId);
  const settled = rules({ feature: { ...many, assignee: ALICE }, children: [] });
  assert.equal(settled.filter((a) => a.rule === "assignee-unconfirmed").length, 0);
  const single = rules({
    feature: feature("feature.planning", { assignee: undefined, reviewer: { id: "22", name: "Rev R" } }),
    children: [],
  });
  assert.equal(single.filter((a) => a.rule === "assignee-unconfirmed").length, 1);
  const noPlanner = feature("feature.planning", { assignee: undefined });
  assert.equal(
    rules({ feature: { ...noPlanner, responsiblePlanner: undefined }, children: [] }).filter(
      (a) => a.rule === "assignee-unconfirmed",
    ).length,
    0,
  );
});

test("a finished or closed feature is not asked who its assignee is", () => {
  const open = feature("feature.development", { assignee: undefined, reviewer: { id: "22", name: "Rev R" } });
  const asked = (f: WorkView) => rules({ feature: f, children: [] }).filter((a) => a.rule === "assignee-unconfirmed");
  assert.equal(asked(open).length, 1);
  assert.equal(asked({ ...open, statusKey: "feature.done" }).length, 0);
  assert.equal(asked({ ...open, closed: true }).length, 0);
});

const LEAD = { id: "31", name: "Lead L" };
const withLeads = (typeLeads: Record<string, Array<{ id: string; name: string }>>): ZqContract => ({
  ...contract,
  typeLeads,
});

test("an order nobody holds goes to the people the key table names for its type, and to the duty holders when it names none", () => {
  const open = work(5, { typeKey: "backend", statusKey: "execution.unassigned" });
  const routed = rules(
    { feature: feature("feature.development", PLANNED), children: [open] },
    withLeads({ backend: [LEAD] }),
  ).filter((a) => a.rule === "task-unassigned");
  assert.deepEqual(routed[0]!.to, [{ kind: "user", user: LEAD }]);
  const plain = rules({ feature: feature("feature.development", PLANNED), children: [open] }).filter(
    (a) => a.rule === "task-unassigned",
  );
  assert.deepEqual(plain[0]!.to, [{ kind: "duty", duty: "server_lead" }]);
});

test("an unassigned optimization order and an unassigned bug go to the leads of their type when the key table names them", () => {
  const leads = withLeads({ optimization: [LEAD], bug: [LEAD] });
  const opt = rules({ feature: optimization(), children: [] }, leads).filter(
    (a) => a.rule === "optimization-unassigned",
  );
  assert.deepEqual(opt[0]!.to, [{ kind: "user", user: LEAD }]);
  const bug = work(9, { typeKey: "bug", statusKey: "bug.unassigned", parentId: 1 });
  const facts = { feature: feature("feature.development", PLANNED), children: [], bugs: [bug] };
  const routed = rules(facts, leads).filter((a) => a.rule === "bug-unassigned");
  assert.deepEqual(routed[0]!.to, [{ kind: "user", user: LEAD }]);
  assert.match(routed[0]!.text, /还没有指定处理人/);
  assert.equal(rules(facts).filter((a) => a.rule === "bug-unassigned").length, 0);
  const fallback = rules(facts, { ...contract, defaultLead: LEAD }).filter((a) => a.rule === "bug-unassigned");
  assert.deepEqual(fallback[0]!.to, [{ kind: "user", user: LEAD }]);
  assert.equal(
    rules({ ...facts, bugs: [{ ...bug, assignee: BOB }] }, leads).filter((a) => a.rule === "bug-unassigned").length,
    0,
  );
});

test("an order with no named lead and no duty holder goes to the default lead, and a mapped lead still wins", () => {
  const other = { id: "32", name: "Other O" };
  const open = work(5, { typeKey: "planning", statusKey: "execution.unassigned" });
  const facts = { feature: feature("feature.development", PLANNED), children: [open] };
  const dispatched = (c: ZqContract) => rules(facts, c).filter((a) => a.rule === "task-unassigned");
  const stripped: ZqContract = { ...contract, typeOwners: {}, defaultLead: LEAD };
  assert.deepEqual(dispatched(stripped)[0]!.to, [{ kind: "user", user: LEAD }]);
  assert.deepEqual(dispatched({ ...stripped, typeLeads: { planning: [other] } })[0]!.to, [
    { kind: "user", user: other },
  ]);
  assert.equal(dispatched({ ...contract, typeOwners: {} }).length, 0);
});

test("the drafted key table sends each trade's unassigned orders to its lead and everything else to the default lead", () => {
  const to = (typeKey: string) => {
    const open = work(5, { typeKey, statusKey: "execution.unassigned" });
    const facts = { feature: feature("feature.development", PLANNED), children: [open] };
    return rules(facts, keyTable).filter((a) => a.rule === "task-unassigned")[0]!.to;
  };
  const ids = (typeKey: string) => to(typeKey).map((t) => (t.kind === "user" ? t.user.id : t.kind));
  assert.deepEqual(ids("character_model"), ["45"]);
  assert.deepEqual(ids("vfx"), ["29"]);
  assert.deepEqual(ids("frontend"), ["35"]);
  assert.deepEqual(ids("backend"), ["5"]);
  assert.deepEqual(ids("qa_test"), ["38"]);
  assert.deepEqual(ids("fgui"), ["41"]);
  assert.deepEqual(ids("mystery_trade"), ["5"]);
});

test("an assigned open order without a due date is asked each day for progress and the missing dates, using its start date and status", () => {
  const dated = work(2, {
    assignee: BOB,
    dueAt: NOW + DAY,
    plannedStart: NOW,
    plannedEnd: NOW + DAY,
    estimateHours: 1,
  });
  const asked = (c: WorkView) =>
    rules({ feature: feature("feature.development", PLANNED), children: [c] }).filter(
      (a) => a.rule === "task-dates-missing",
    );
  assert.equal(asked(dated).length, 0);
  const fresh = asked({ ...dated, dueAt: undefined, startAt: NOW - DAY });
  assert.deepEqual(fresh[0]!.to, [{ kind: "user", user: BOB }]);
  assert.match(fresh[0]!.text, /还没有截止日期/);
  assert.doesNotMatch(fresh[0]!.text, /天,还在/);
  const stale = asked({ ...dated, dueAt: undefined, startAt: NOW - 5 * DAY });
  assert.match(stale[0]!.text, /已从 .* 开始 5 天,还在「/);
  assert.match(asked({ ...dated, dueAt: undefined })[0]!.text, /开始日期和截止日期/);
  assert.equal(asked({ ...dated, dueAt: undefined, assignee: undefined }).length, 0);
  assert.equal(asked({ ...dated, dueAt: undefined, completionSubmitted: true }).length, 0);
  assert.equal(asked({ ...dated, dueAt: undefined, statusKey: "execution.done" }).length, 0);
});
