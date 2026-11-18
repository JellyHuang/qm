import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract } from "../src/zq/contract.ts";
import { createMcpOpReader, OpError, parseWorkView } from "../src/zq/op-reader.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const PERSON = { mmUserId: "mm1", principalId: "internal:a", opName: "A" };
const planner = { id: "11", login: "alice", name: "Alice A" };

const wp = (over: Record<string, unknown> = {}) => ({
  id: 5,
  subject: "新增英雄",
  project_id: "p1",
  type_key: "feature",
  status_key: "feature.briefing",
  stage_key: "feature.briefing",
  lifecycle: "delayed",
  lock_version: 3,
  parent_id: null,
  assignee: null,
  start_date: "2026-11-09",
  due_date: "2026-11-14",
  estimated_hours: 6.5,
  updated_at: "2026-11-13T04:00:00Z",
  status_changed_at: null,
  planner,
  ...over,
});

test("the normalized v0.3 object is read by its stable keys, and status_key is used when stage_key is absent", () => {
  const view = parseWorkView(wp(), contract)!;
  assert.deepEqual(
    [
      view.id,
      view.typeKey,
      view.statusKey,
      view.lifecycle,
      view.projectId,
      view.estimateHours,
      view.responsiblePlanner,
    ],
    [5, "feature", "feature.briefing", "delayed", "p1", 6.5, planner],
  );
  assert.equal(view.parentId, undefined);
  assert.equal(view.statusChangedAt, undefined, "an unknown change time stays unknown");
  assert.equal(
    parseWorkView(wp({ stage_key: undefined }), contract)!.statusKey,
    "feature.briefing",
    "status_key is the same-value alias",
  );
  assert.equal(parseWorkView(wp({ type_key: undefined }), contract), undefined);
});

test("a date without a time is the Shanghai day: a due date is only overdue after that day ends", () => {
  const view = parseWorkView(wp(), contract)!;
  assert.equal(view.dueAt, Date.parse("2026-11-14T23:59:59.999+08:00"));
  assert.equal(view.plannedEnd, Date.parse("2026-11-14T23:59:59.999+08:00"));
  assert.equal(view.plannedStart, Date.parse("2026-11-09T00:00:00+08:00"));
});

test("a group assignee does not count as a person being assigned", () => {
  const user = { id: "12", login: "bob", name: "Bob B", type: "User" };
  assert.equal(parseWorkView(wp({ assignee: user }), contract)!.assignee?.id, "12");
  assert.equal(parseWorkView(wp({ assignee: { ...user, type: "Group" } }), contract)!.assignee, undefined);
});

test("the project name is read from the row when OpenProject sends it, and stays unknown otherwise", () => {
  assert.equal(parseWorkView(wp(), contract)!.projectName, undefined);
  assert.equal(parseWorkView(wp({ project_name: "ZQ" }), contract)!.projectName, "ZQ");
  const nested = parseWorkView(
    wp({ project_id: undefined, project: { id: 3, name: "ZQ", identifier: "zq-sandbox" } }),
    contract,
  )!;
  assert.deepEqual([nested.projectId, nested.projectName], ["3", "ZQ"]);
  assert.equal(parseWorkView(wp({ project: { identifier: "zq-sandbox" } }), contract)!.projectName, "zq-sandbox");
});

function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  return {
    calls,
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push(`${tool}:${JSON.stringify(args)}`);
      const noBugs = () => ({ next_offset: null, results: [] });
      const out = (handlers[tool] ?? (tool.endsWith("zq_bugs_for_feature") ? noBugs : undefined))?.(args);
      if (out instanceof Error) throw out;
      return JSON.stringify(out ?? {});
    },
  };
}

test("pages follow next_offset to the end, children are grouped under their parent, and the tools get the documented arguments", async () => {
  const rows = [
    wp({ id: 1 }),
    wp({ id: 2, type_key: "vfx", parent_id: 1, stage_key: "execution.unassigned", status_key: "execution.unassigned" }),
  ];
  const f = fake({
    openproject_zq_list_work_packages: (a) => ({
      next_offset: a["offset"] === 0 ? 1 : null,
      results: a["offset"] === 0 ? [rows[0]] : [rows[1]],
    }),
    openproject_zq_check_exit: () => ({
      ready: false,
      blockers: [{ code: "PHASE_NOT_AVAILABLE", message: "P0 不放行" }],
    }),
    openproject_zq_meetings_for_feature: (a) => ({
      feature_id: a["id"],
      planner,
      next_offset: null,
      results: [
        {
          id: 9,
          title: "宣讲",
          project_id: "p1",
          start_time: "2026-11-14T07:00:00Z",
          end_time: "2026-11-14T08:00:00Z",
          state: "open",
        },
      ],
    }),
  });
  const { facts } = await createMcpOpReader({ call: f.call, contract }).features(PERSON);
  assert.equal(facts.length, 1);
  assert.deepEqual(
    facts[0]!.children.map((c) => c.id),
    [2],
  );
  assert.deepEqual(facts[0]!.exit, { ready: false, blockers: ["P0 不放行"] });
  assert.deepEqual(facts[0]!.meetings, [
    {
      id: "9",
      title: "宣讲",
      startAt: Date.parse("2026-11-14T07:00:00Z"),
      endAt: Date.parse("2026-11-14T08:00:00Z"),
      state: "open",
    },
  ]);
  assert.ok(f.calls.includes('openproject_zq_list_work_packages:{"limit":100,"offset":1}'));
  assert.ok(f.calls.includes('openproject_zq_check_exit:{"id":1}'));
  assert.ok(f.calls.includes('openproject_zq_meetings_for_feature:{"id":1,"offset":0}'));
});

test("a feature OpenProject says is not visible is read without the optional answers, any other error is the person's failure", async () => {
  const list = { openproject_zq_list_work_packages: () => ({ next_offset: null, results: [wp({ id: 1 })] }) };
  const hidden = fake({
    ...list,
    openproject_zq_check_exit: () => ({ error: { code: "not_found", message: "no such object" } }),
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
  });
  const [facts] = (await createMcpOpReader({ call: hidden.call, contract }).features(PERSON)).facts;
  assert.equal(facts!.exit, undefined);
  assert.deepEqual(facts!.meetings, []);
  const denied = fake({
    ...list,
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
    openproject_zq_check_exit: () => ({ error: { code: "permission_denied", message: "no" } }),
  });
  await assert.rejects(createMcpOpReader({ call: denied.call, contract }).features(PERSON), (e: unknown) => {
    assert.ok(e instanceof OpError);
    assert.equal(e.code, "permission_denied");
    return true;
  });
});

test("a list that does not advance is refused instead of looping", async () => {
  const f = fake({ openproject_zq_list_work_packages: () => ({ next_offset: 0, results: [] }) });
  await assert.rejects(createMcpOpReader({ call: f.call, contract }).features(PERSON), /did not advance/);
});

test("duty holders are asked for by OpenProject's name of the duty and keep several people as several", async () => {
  const f = fake({
    openproject_zq_duty_holders: () => ({
      project_id: "p1",
      next_offset: null,
      results: [
        { id: "12", login: "bob", name: "Bob B", sources: [{ membership_id: 1 }] },
        { id: "13", login: "carol", name: "Carol C", sources: [] },
      ],
    }),
  });
  const reader = createMcpOpReader({ call: f.call, contract });
  const holders = await reader.dutyHolders(PERSON, "p1", "art_lead");
  assert.deepEqual(
    holders?.map((h) => h.id),
    ["12", "13"],
  );
  assert.ok(f.calls[0]!.includes('"duty":"lead_artist"'));
  const without = createMcpOpReader({ call: f.call, contract: { ...contract, tools: {} } });
  assert.equal(await without.dutyHolders(PERSON, "p1", "art_lead"), undefined);
});

test("stage_key and status_key that disagree are a contract problem: the order is skipped and reported, not guessed", async () => {
  assert.throws(
    () => parseWorkView(wp({ status_key: "feature.review", stage_key: "feature.briefing" }), contract),
    /contract_mismatch|stage_key/,
  );
  const f = fake({
    openproject_zq_list_work_packages: () => ({
      next_offset: null,
      results: [wp({ id: 1 }), wp({ id: 2, status_key: "feature.review", stage_key: "feature.briefing" })],
    }),
    openproject_zq_check_exit: () => ({ ready: false, blockers: [] }),
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
  });
  const read = await createMcpOpReader({ call: f.call, contract }).features(PERSON);
  assert.deepEqual(
    read.facts.map((x) => x.feature.id),
    [1],
  );
  assert.equal(read.problems.length, 1);
  assert.match(read.problems[0]!, /work package 2 has stage_key feature\.briefing but status_key feature\.review/);
});

test("the personal responsibility properties are read as people, and an empty one stays empty", () => {
  const people = {
    pm: { id: "21", login: "pm", name: "PM P" },
    reviewer: { id: "22", login: "rv", name: "Rev R" },
    qa_owner: { id: "23", login: "qa", name: "QA Q" },
    acceptor: null,
    regression_owner: { id: "24", login: "rg", name: "Reg G" },
  };
  const view = parseWorkView(wp(people), contract)!;
  assert.deepEqual(
    [view.pm?.id, view.reviewer?.id, view.qaOwner?.id, view.regressionOwner?.id, view.acceptor],
    ["21", "22", "23", "24", undefined],
  );
});

test("OpenProject's real error text, with the code in brackets, is understood whether it is returned or thrown", async () => {
  const list = { openproject_zq_list_work_packages: () => ({ next_offset: null, results: [wp({ id: 1 })] }) };
  const throwing = (message: string) => async (tool: string, args: Record<string, unknown>) => {
    if (tool.endsWith("zq_check_exit")) throw new Error(message);
    return fake({ ...list, openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }) }).call(
      tool,
      args,
    );
  };
  const hidden = await createMcpOpReader({
    call: throwing(
      "mcp tool zq_check_exit error: Error executing tool zq_check_exit: [NOT_FOUND] 对象不可见或键不存在",
    ),
    contract,
  }).features(PERSON);
  assert.equal(hidden.facts[0]!.exit, undefined, "not visible: the answer is left out");
  await assert.rejects(
    createMcpOpReader({ call: throwing("mcp tool zq_check_exit error: [FORBIDDEN] 无权限"), contract }).features(
      PERSON,
    ),
    (e: unknown) => e instanceof Error && /FORBIDDEN/.test(e.message),
  );
  const returned = fake({ ...list, openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }) });
  const asText = async (tool: string, args: Record<string, unknown>) =>
    tool.endsWith("zq_check_exit") ? "[validation_error] Invalid argument(s)" : returned.call(tool, args);
  await assert.rejects(
    createMcpOpReader({ call: asText, contract }).features(PERSON),
    (e: unknown) => e instanceof OpError && e.code === "validation_error",
  );
});

test("a numeric project id is sent as a number, because zq_duty_holders refuses a string", async () => {
  const f = fake({ openproject_zq_duty_holders: () => ({ next_offset: null, results: [] }) });
  await createMcpOpReader({ call: f.call, contract }).dutyHolders(PERSON, "3", "pm");
  assert.ok(f.calls[0]!.includes('"project_id":3,'), f.calls[0]);
});

test("the delay marker, the awaited orders and the note are read, and a bug is kept apart from the orders", async () => {
  const view = parseWorkView(
    wp({
      delay_marked: true,
      delayed_since: "2026-11-12T01:00:00Z",
      awaiting_note: "等待:#2",
      awaited_children: [
        { id: 2, type_key: "vfx", stage_key: "execution.active", owner: { id: "12", login: "bob", name: "Bob B" } },
        { id: 3, type_key: "backend", stage_key: "execution.unassigned", owner: null },
        { id: "x" },
      ],
    }),
    contract,
  )!;
  assert.equal(view.delayMarked, true);
  assert.equal(view.delayedSince, Date.parse("2026-11-12T01:00:00Z"));
  assert.equal(view.awaitingNote, "等待:#2");
  assert.deepEqual(view.awaited, [
    { id: 2, typeKey: "vfx", stageKey: "execution.active", owner: { id: "12", login: "bob", name: "Bob B" } },
    { id: 3, typeKey: "backend", stageKey: "execution.unassigned" },
  ]);
  const bug = {
    id: 7,
    subject: "崩溃",
    type_key: "bug",
    stage_key: "bug.fixing",
    parent_id: 1,
    feature_id: 1,
    blocking: true,
    qa_owner: { id: "23", login: "qa", name: "QA Q" },
  };
  const f = fake({
    openproject_zq_list_work_packages: () => ({
      next_offset: null,
      results: [
        wp({ id: 1 }),
        wp({ id: 2, type_key: "vfx", parent_id: 1, stage_key: "execution.active", status_key: "execution.active" }),
      ],
    }),
    openproject_zq_check_exit: () => ({ ready: false, blockers: [] }),
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
    openproject_zq_bugs_for_feature: (a) => ({
      feature_id: a["id"],
      next_offset: a["offset"] === 0 ? 1 : null,
      results: a["offset"] === 0 ? [bug] : [{ ...bug, id: 8, blocking: false }],
    }),
  });
  const { facts } = await createMcpOpReader({ call: f.call, contract, serverId: "openproject" }).features(PERSON);
  assert.deepEqual(
    facts[0]!.children.map((c) => c.id),
    [2],
  );
  assert.deepEqual(
    facts[0]!.bugs?.map((b) => [b.id, b.blocking, b.qaOwner?.id]),
    [
      [7, true, "23"],
      [8, false, "23"],
    ],
  );
  assert.ok(f.calls.includes('openproject_zq_bugs_for_feature:{"id":1,"offset":1}'));
});

test("the change feed is read page by page until has_more is false, with the project id as a number and the cursor passed on", async () => {
  const withFeed = { ...contract, tools: { ...contract.tools, changesSince: "zq_changes_since" } };
  const row = (id: string) => ({
    event_id: id,
    ticket_id: 2,
    parent_feature_id: 1,
    kind: "stage",
    kinds: ["stage"],
    old: { stage: "execution.active" },
    new: { stage: "execution.done" },
    actor: { kind: "user", id: "12", name: "Bob B" },
    occurred_at: "2026-11-16T01:00:00Z",
    reason: null,
    batch_id: null,
  });
  const f = fake({
    openproject_zq_changes_since: (a) =>
      a["cursor"] === null
        ? { results: [row("j1")], next_cursor: "c1", has_more: true, watermark: "w" }
        : { results: [row("j2")], next_cursor: "c2", has_more: false, watermark: "w" },
  });
  const reader = createMcpOpReader({ call: f.call, contract: withFeed });
  const read = await reader.changes!(PERSON, "3", null);
  assert.deepEqual(
    read.events.map((e) => [e.id, e.ticketId, e.featureId, e.byRule, e.actorName]),
    [
      ["j1", 2, 1, false, "Bob B"],
      ["j2", 2, 1, false, "Bob B"],
    ],
  );
  assert.equal(read.nextCursor, "c2");
  assert.deepEqual(f.calls, [
    'openproject_zq_changes_since:{"project_id":3,"cursor":null,"limit":100}',
    'openproject_zq_changes_since:{"project_id":3,"cursor":"c1","limit":100}',
  ]);
  const { changesSince: _unused, ...rest } = contract.tools;
  assert.equal(createMcpOpReader({ call: f.call, contract: { ...contract, tools: rest } }).changes, undefined);
});

test("a cursor the server refuses surfaces as an error with the lower-cased code, whether returned or thrown", async () => {
  const withFeed = { ...contract, tools: { ...contract.tools, changesSince: "zq_changes_since" } };
  const thrown = createMcpOpReader({
    call: async () => {
      throw new Error("mcp tool error: [CURSOR_INVALID] 游标无效");
    },
    contract: withFeed,
  });
  await assert.rejects(
    thrown.changes!(PERSON, "3", "x"),
    (e: unknown) => e instanceof OpError && e.code === "cursor_invalid",
  );
  const returned = createMcpOpReader({
    call: async () => JSON.stringify({ error: { code: "cursor_scope_changed", message: "范围变化" } }),
    contract: withFeed,
  });
  await assert.rejects(
    returned.changes!(PERSON, "3", "x"),
    (e: unknown) => e instanceof OpError && e.code === "cursor_scope_changed",
  );
});

test("an optimization order with no feature parent is read like a feature, one under a feature stays that feature's child", async () => {
  const unassigned = { stage_key: "execution.unassigned", status_key: "execution.unassigned" };
  const rows = [
    wp({ id: 1 }),
    wp({ id: 60, type_key: "optimization", ...unassigned }),
    wp({ id: 61, type_key: "optimization", parent_id: 1, ...unassigned }),
    wp({ id: 62, type_key: "optimization", ...unassigned }),
    wp({ id: 63, type_key: "backend", parent_id: 62, ...unassigned }),
  ];
  const f = fake({
    openproject_zq_list_work_packages: () => ({ next_offset: null, results: rows }),
    openproject_zq_check_exit: () => ({ ready: false, blockers: [] }),
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
  });
  const { facts } = await createMcpOpReader({ call: f.call, contract }).features(PERSON);
  assert.deepEqual(
    facts.map((x) => [x.feature.id, x.children.map((c) => c.id)]),
    [
      [1, [61]],
      [60, []],
      [62, [63]],
    ],
  );
});

test("the completion confirmation of an optimization order is read from its flag, and only when true", () => {
  const read = (v: unknown) => parseWorkView(wp({ type_key: "optimization", completion_submitted: v }), contract)!;
  assert.equal(read(true).completionSubmitted, true);
  assert.equal(
    parseWorkView(wp({ type_key: "optimization", delivery_result: "pass" }), {
      ...contract,
      fields: { ...contract.fields, completionSubmitted: "delivery_result" },
    })!.completionSubmitted,
    true,
  );
  assert.equal(read(false).completionSubmitted, undefined);
  assert.equal(read("yes").completionSubmitted, undefined);
});

test("the child orders of an optimization order under a feature are read as that feature's orders", async () => {
  const rows = [
    wp({ id: 1 }),
    wp({
      id: 61,
      type_key: "optimization",
      parent_id: 1,
      stage_key: "execution.active",
      status_key: "execution.active",
    }),
    wp({ id: 62, type_key: "backend", parent_id: 61, stage_key: "execution.active", status_key: "execution.active" }),
  ];
  const f = fake({
    openproject_zq_list_work_packages: () => ({ next_offset: null, results: rows }),
    openproject_zq_check_exit: () => ({ ready: false, blockers: [] }),
    openproject_zq_meetings_for_feature: () => ({ next_offset: null, results: [] }),
  });
  const { facts } = await createMcpOpReader({ call: f.call, contract }).features(PERSON);
  assert.deepEqual(
    facts.map((x) => [x.feature.id, x.children.map((c) => c.id)]),
    [[1, [61, 62]]],
  );
});

test("an optimization order is never asked for the feature-only answers, and a project outside the scope is not touched", async () => {
  const unassigned = { stage_key: "execution.unassigned", status_key: "execution.unassigned" };
  const rows = [
    wp({ id: 1 }),
    wp({ id: 60, type_key: "optimization", ...unassigned }),
    wp({ id: 70, project_id: "other" }),
    wp({ id: 71, type_key: "optimization", project_id: "other", ...unassigned }),
  ];
  const featureOnly = (a: Record<string, unknown>) =>
    a["id"] === 1 ? { next_offset: null, results: [] } : new Error("invalid_feature: not a feature");
  const f = fake({
    openproject_zq_list_work_packages: () => ({ next_offset: null, results: rows }),
    openproject_zq_check_exit: (a) => (a["id"] === 1 ? { ready: false, blockers: [] } : new Error("invalid_feature")),
    openproject_zq_meetings_for_feature: featureOnly,
    openproject_zq_bugs_for_feature: featureOnly,
  });
  const { facts } = await createMcpOpReader({ call: f.call, contract, projects: ["p1"] }).features(PERSON);
  assert.deepEqual(
    facts.map((x) => x.feature.id),
    [1, 60],
  );
  assert.ok(
    f.calls.every((c) => !/"id":(60|70|71)\b/.test(c)),
    "no feature-only tool saw an order outside the features",
  );
});

test("the time an optimization order was submitted is read from its submission time property", () => {
  const read = (v: unknown) =>
    parseWorkView(wp({ type_key: "optimization", delivery_result: "pass", delivery_submitted_at: v }), {
      ...contract,
      fields: { ...contract.fields, completionSubmitted: "delivery_result" },
    })!;
  assert.equal(read("2026-11-17T09:00:00Z").completionSubmittedAt, Date.parse("2026-11-17T09:00:00Z"));
  assert.equal(read(null).completionSubmittedAt, undefined);
});

test("several responsible planners and the participants are read as lists, the first planner stays the main one", () => {
  const second = { id: "15", login: "carol", name: "Carol C" };
  const view = parseWorkView(
    wp({ planner: [planner, second], participants: [second, { id: "16", login: "dan", name: "Dan D" }] }),
    contract,
  )!;
  assert.deepEqual(
    view.planners?.map((u) => u.id),
    ["11", "15"],
  );
  assert.equal(view.responsiblePlanner?.id, "11");
  assert.deepEqual(
    view.participants?.map((u) => u.id),
    ["15", "16"],
  );
  assert.equal(parseWorkView(wp(), contract)!.planners, undefined);
});

test("a work package whose status is closed carries the closed flag, an open one does not", () => {
  assert.equal(parseWorkView(wp({ is_closed: true }), contract)!.closed, true);
  assert.equal(parseWorkView(wp({ isClosed: true }), contract)!.closed, true);
  assert.equal(
    parseWorkView(wp({ start_date: "2026-11-09" }), contract)!.startAt,
    Date.parse("2026-11-09T00:00:00+08:00"),
  );
  assert.equal(parseWorkView(wp({ percentage_done: 30 }), contract)!.percent, 30);
  assert.equal(parseWorkView(wp({ done_ratio: 55.4 }), contract)!.percent, 55);
  assert.equal(parseWorkView(wp({ percentage_done: 120 }), contract)!.percent, undefined);
  assert.equal(parseWorkView(wp({}), contract)!.percent, undefined);
  assert.equal(parseWorkView(wp({ start_date: null }), contract)!.startAt, undefined);
  assert.equal(parseWorkView(wp({ is_closed: false }), contract)!.closed, undefined);
  assert.equal(parseWorkView(wp(), contract)!.closed, undefined);
});
