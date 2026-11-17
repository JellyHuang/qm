import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract } from "../src/zq/contract.ts";
import { createMcpOpReader } from "../src/zq/op-reader.ts";
import { createReportSource, projectsOfFacts } from "../src/zq/report-source.ts";
import { createZqReports, reportPrompt, type ZqReportDraft } from "../src/zq/reports.ts";
import { testMap } from "./support/test-database.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const BOB = { mmUserId: "mm-bob", principalId: "internal:bob", opUserId: "12", opName: "Bob B" };
const bob = { id: "12", login: "bob", name: "Bob B" };
const carol = { id: "13", login: "carol", name: "Carol C" };
const UNTIL = Date.parse("2026-11-16T10:30:00Z");
const SINCE = UNTIL - 86_400_000;

const wp = (over: Record<string, unknown>) => ({
  project_id: "3",
  type_key: "vfx",
  lifecycle: "normal",
  stage_key: "execution.active",
  status_key: "execution.active",
  parent_id: 1,
  estimated_hours: 2,
  ...over,
});

const WORK = [
  wp({
    id: 1,
    subject: "新增英雄",
    type_key: "feature",
    parent_id: null,
    stage_key: "feature.development",
    status_key: "feature.development",
  }),
  wp({ id: 2, subject: "英雄特效", assignee: bob }),
  wp({ id: 3, subject: "英雄模型", assignee: carol }),
  wp({ id: 4, subject: "英雄动作", assignee: bob }),
];

const stage = (id: string, ticket: number, from: string, to: string, over: Record<string, unknown> = {}) => ({
  event_id: id,
  ticket_id: ticket,
  parent_feature_id: 1,
  kinds: ["stage"],
  old_stage: from,
  new_stage: to,
  old: { stage: from, assignee: over["assignee"] ?? "12" },
  new: { stage: to, assignee: over["assignee"] ?? "12" },
  actor: over["actor"] ?? bob,
  time: over["time"] ?? "2026-11-16T07:00:00Z",
});

function fakeOpenProject(events: unknown[], entries: unknown[]) {
  const calls: string[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push(`${tool}:${JSON.stringify(args)}`);
    if (tool === "openproject_zq_list_work_packages") return JSON.stringify({ next_offset: null, results: WORK });
    if (tool === "openproject_zq_bugs_for_feature" || tool === "openproject_zq_meetings_for_feature")
      return JSON.stringify({ next_offset: null, results: [] });
    if (tool === "openproject_zq_changes_since")
      return JSON.stringify({ results: events, next_cursor: "c1", has_more: false });
    if (tool === "openproject_list_time_entries") return JSON.stringify({ next_offset: null, results: entries });
    return JSON.stringify({});
  };
  const reader = createMcpOpReader({ call, contract });
  const source = createReportSource({ reader, call, contract, timezone: "Asia/Shanghai" });
  return { calls, source };
}

async function draftFor(events: unknown[], entries: unknown[]) {
  const { source, calls } = fakeOpenProject(events, entries);
  const input = await source(BOB, "daily", SINCE, UNTIL);
  const reports = createZqReports({
    map: testMap<ZqReportDraft>(),
    write: undefined,
    writeBack: async () => {},
  });
  return { calls, input, draft: await reports.draft(input) };
}

test("the draft shows Chinese stage labels, only this person's tickets and only events inside the period", async () => {
  const { draft, input } = await draftFor(
    [
      stage("e1", 2, "execution.waiting", "execution.active"),
      stage("e2", 4, "execution.active", "execution.done"),
      stage("e3", 3, "execution.active", "execution.done", { assignee: "13", actor: carol }),
      stage("e4", 4, "execution.waiting", "execution.active", { time: "2026-11-14T07:00:00Z" }),
      stage("e5", 4, "execution.done", "execution.waiting", { time: "2026-11-17T07:00:00Z" }),
    ],
    [],
  );
  assert.deepEqual(
    input.statusChanges.map((c) => [c.workPackageId, c.subject, c.from, c.to]),
    [
      [2, "英雄特效", "等待开发", "进行中"],
      [4, "英雄动作", "进行中", "已完成"],
    ],
  );
  assert.match(draft.text, /- #2 英雄特效: 等待开发 -> 进行中/);
  assert.match(draft.text, /- #4 英雄动作: 进行中 -> 已完成/);
  assert.doesNotMatch(draft.text, /execution\.|英雄模型|Carol/);
  assert.doesNotMatch(reportPrompt(input), /execution\./);
});

test("a ticket this person finished counts even when someone else is the assignee, and bug events are ignored", async () => {
  const { input } = await draftFor(
    [
      stage("e1", 3, "execution.active", "execution.done", { assignee: "13", actor: bob }),
      stage("e2", 9, "bug.fixing", "bug.retest"),
      { ...stage("e3", 2, "bug.new", "bug.fixing"), old_stage: undefined, new_stage: undefined },
    ],
    [],
  );
  assert.deepEqual(
    input.statusChanges.map((c) => c.workPackageId),
    [3],
  );
});

test("recorded hours come from time entries per work package and an estimate is never reported as spent", async () => {
  const { draft, input, calls } = await draftFor(
    [stage("e1", 4, "execution.active", "execution.done")],
    [
      { work_package_id: 2, hours: 1.5, comment: "特效调试", spent_on: "2026-11-16" },
      { work_package_id: 2, hours: "PT30M", spent_on: "2026-11-16" },
      { work_package_id: 4, hours: 0, spent_on: "2026-11-16" },
    ],
  );
  assert.deepEqual(
    input.timeEntries.map((e) => [e.workPackageId, e.subject, e.hours, e.comment]),
    [[2, "英雄特效", 2, "特效调试"]],
  );
  assert.match(draft.text, /已记工时:2 小时/);
  assert.doesNotMatch(draft.text, /#4 英雄动作: \d/);
  assert.ok(
    calls.includes(
      'openproject_list_time_entries:{"user":"12","spent_on_from":"2026-11-16","spent_on_to":"2026-11-16","offset":1,"limit":100}',
    ),
  );
});

test("a task done with an estimate and no recorded hours produces no time entry", async () => {
  const { draft, input } = await draftFor([stage("e1", 4, "execution.active", "execution.done")], []);
  assert.deepEqual(input.timeEntries, []);
  assert.doesNotMatch(draft.text, /已记工时|2h|2 小时/);
});

test("a person with no linked OpenProject user gets an empty report without reading any feed", async () => {
  const { source, calls } = fakeOpenProject([stage("e1", 2, "execution.waiting", "execution.active")], []);
  const { opUserId: _unused, ...unlinked } = BOB;
  const input = await source(unlinked, "weekly", UNTIL - 7 * 86_400_000, UNTIL);
  assert.deepEqual([input.statusChanges, input.timeEntries], [[], []]);
  assert.ok(!calls.some((c) => c.includes("changes_since") || c.includes("time_entries")));
});

test("a stand-alone optimization order reports to its own project manager, one under a feature to the feature's", () => {
  const pm = (id: string) => ({ id, name: `pm${id}` });
  const base = { statusKey: "execution.active", subject: "s" };
  const alone = { feature: { ...base, id: 60, typeKey: "optimization", projectId: "p9", pm: pm("9") }, children: [] };
  const hosted = {
    feature: { ...base, id: 1, typeKey: "feature", projectId: "p1", pm: pm("1") },
    children: [{ ...base, id: 5, typeKey: "optimization", projectId: "p1", parentId: 1 }],
  };
  assert.deepEqual(
    projectsOfFacts([alone, hosted]).map((p) => [p.id, p.pmOpUserIds]),
    [
      ["p9", ["9"]],
      ["p1", ["1"]],
    ],
  );
});
