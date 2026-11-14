import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  DEFAULT_FOLLOW_UP_POLICY,
  evaluateFollowUp,
  type WorkPackageState,
} from "../src/zq/follow-up-rules.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function wp(partial: Partial<WorkPackageState>): WorkPackageState {
  return {
    id: 7,
    status: "In progress",
    assigneeOpUserId: "42",
    statusChangedAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...partial,
  };
}

test("statuses classify case-insensitively and unknown statuses are left alone", () => {
  assert.equal(classifyStatus(" In Progress ", DEFAULT_FOLLOW_UP_POLICY), "active");
  assert.equal(classifyStatus("Specified", DEFAULT_FOLLOW_UP_POLICY), undefined);
  assert.deepEqual(evaluateFollowUp(wp({ status: "Specified", updatedAt: 0 }), NOW), []);
});

test("closed work is never followed up, even when overdue", () => {
  assert.deepEqual(evaluateFollowUp(wp({ status: "Closed", dueAt: NOW - 9 * DAY, updatedAt: 0 }), NOW), []);
});

test("recent activity needs no follow-up", () => {
  assert.deepEqual(evaluateFollowUp(wp({}), NOW), []);
});

test("an active work package idle past its threshold gets one stale reminder for the assignee", () => {
  const actions = evaluateFollowUp(wp({ updatedAt: NOW - 6 * DAY }), NOW);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.kind, "remind-stale");
  assert.equal(actions[0]!.assigneeOpUserId, "42");
  assert.match(actions[0]!.reason, /no update for 6 day/);
});

test("overdue wins over stale and is reported once", () => {
  const actions = evaluateFollowUp(wp({ updatedAt: NOW - 6 * DAY, dueAt: NOW - 3 * DAY }), NOW);
  assert.deepEqual(
    actions.map((a) => a.kind),
    ["remind-overdue"],
  );
});

test("a recent follow-up cools the reminder down until the interval passes", () => {
  const idle = { updatedAt: NOW - 6 * DAY };
  assert.deepEqual(evaluateFollowUp(wp({ ...idle, lastFollowUpAt: NOW - DAY }), NOW), []);
  assert.equal(evaluateFollowUp(wp({ ...idle, lastFollowUpAt: NOW - 3 * DAY }), NOW).length, 1);
});

test("the dedupe key is stable within a reminder period and changes in the next one", () => {
  const at = (now: number) => evaluateFollowUp(wp({ updatedAt: 90 * DAY }), now)[0]!.dedupeKey;
  assert.equal(at(95.5 * DAY), at(96.5 * DAY));
  assert.notEqual(at(96.5 * DAY), at(98.5 * DAY));
});

test("a blocked work package escalates once per status change after the escalation age", () => {
  const blocked = wp({ status: "On hold", statusChangedAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY });
  const kinds = evaluateFollowUp(blocked, NOW).map((a) => a.kind);
  assert.deepEqual(kinds, ["remind-stale", "escalate-blocked"]);
  const early = wp({ status: "On hold", statusChangedAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY });
  assert.deepEqual(
    evaluateFollowUp(early, NOW).map((a) => a.kind),
    ["remind-stale"],
  );
  const key = (now: number) => evaluateFollowUp(blocked, now).find((a) => a.kind === "escalate-blocked")!.dedupeKey;
  assert.equal(key(NOW), key(NOW + DAY));
});

test("an unassigned work package still yields actions without an assignee", () => {
  const { assigneeOpUserId: _drop, ...rest } = wp({ updatedAt: NOW - 6 * DAY });
  const action = evaluateFollowUp(rest, NOW)[0]!;
  assert.equal("assigneeOpUserId" in action, false);
});
