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
  status_key: "feature.status.legacy",
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

test("the normalized v0.3 object is read by its stable keys, and stage_key wins over status_key", () => {
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
  assert.equal(parseWorkView(wp({ stage_key: undefined }), contract)!.statusKey, "feature.status.legacy");
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

function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  return {
    calls,
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push(`${tool}:${JSON.stringify(args)}`);
      const out = handlers[tool]?.(args);
      if (out instanceof Error) throw out;
      return JSON.stringify(out ?? {});
    },
  };
}

test("pages follow next_offset to the end, children are grouped under their parent, and the tools get the documented arguments", async () => {
  const rows = [wp({ id: 1 }), wp({ id: 2, type_key: "vfx", parent_id: 1, stage_key: "execution.unassigned" })];
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
  const facts = await createMcpOpReader({ call: f.call, contract }).features(PERSON);
  assert.equal(facts.length, 1);
  assert.deepEqual(
    facts[0]!.children.map((c) => c.id),
    [2],
  );
  assert.deepEqual(facts[0]!.exit, { ready: false, blockers: ["P0 不放行"] });
  assert.deepEqual(facts[0]!.meetings, [
    { id: "9", title: "宣讲", endAt: Date.parse("2026-11-14T08:00:00Z"), state: "open" },
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
  const [facts] = await createMcpOpReader({ call: hidden.call, contract }).features(PERSON);
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
