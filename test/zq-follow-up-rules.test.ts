import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  exitBlockers,
  latestStatusChangeAt,
  DEFAULT_FOLLOW_UP_POLICY,
  evaluateFollowUp,
  type WorkPackageState,
} from "../src/zq/follow-up-rules.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function wp(partial: Partial<WorkPackageState>): WorkPackageState {
  return {
    id: 7,
    status: "pm.in_progress",
    assigneeOpUserId: "42",
    statusChangedAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...partial,
  };
}

test("statuses classify case-insensitively and unknown statuses are left alone", () => {
  assert.equal(classifyStatus(" FM.Review ", DEFAULT_FOLLOW_UP_POLICY), "active");
  assert.equal(classifyStatus("fm.unknown", DEFAULT_FOLLOW_UP_POLICY), undefined);
  assert.deepEqual(evaluateFollowUp(wp({ status: "fm.unknown", updatedAt: 0 }), NOW), []);
});

test("closed work is never followed up, even when overdue", () => {
  assert.deepEqual(evaluateFollowUp(wp({ status: "qa.rejected", dueAt: NOW - 9 * DAY, updatedAt: 0 }), NOW), []);
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
  const blocked = wp({ status: "fm.suspended", statusChangedAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY });
  const kinds = evaluateFollowUp(blocked, NOW).map((a) => a.kind);
  assert.deepEqual(kinds, ["remind-stale", "escalate-blocked"]);
  const early = wp({ status: "fm.suspended", statusChangedAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY });
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

test("every status key of the OpenProject families classifies, and terminal ones are closed", () => {
  const families = {
    pm: ["planned", "in_progress", "suspended", "done", "closed"],
    fm: ["in_progress", "review", "rework", "qa", "formal", "suspended", "closed"],
    dv: ["in_progress", "review", "qa", "done", "suspended", "closed"],
    qa: ["confirmed", "fixing", "verify", "reopened", "closed", "rejected"],
    mt: ["in_progress", "done", "cancelled"],
  };
  for (const [family, suffixes] of Object.entries(families)) {
    for (const suffix of suffixes) {
      assert.ok(classifyStatus(`${family}.${suffix}`, DEFAULT_FOLLOW_UP_POLICY), `${family}.${suffix}`);
    }
  }
  assert.equal(classifyStatus("new", DEFAULT_FOLLOW_UP_POLICY), "open");
  for (const key of ["fm.formal", "pm.done", "qa.closed", "mt.cancelled"]) {
    assert.equal(classifyStatus(key, DEFAULT_FOLLOW_UP_POLICY), "closed", key);
  }
  assert.equal(classifyStatus("dv.suspended", DEFAULT_FOLLOW_UP_POLICY), "blocked");
});

test("the status change time comes from the latest activity into the current status", () => {
  const activities = [
    { createdAt: 10 },
    { createdAt: 20, statusTo: "fm.review" },
    { createdAt: 30, statusTo: "FM.Rework" },
    { createdAt: 40, statusTo: "fm.review" },
  ];
  assert.equal(latestStatusChangeAt(activities, "fm.review", 1), 40);
  assert.equal(latestStatusChangeAt(activities, "fm.rework", 1), 30);
  assert.equal(latestStatusChangeAt(activities, "fm.qa", 1), 1);
});

test("a work package known only by assignee display name is still followed up", () => {
  const { assigneeOpUserId: _drop, ...rest } = wp({ updatedAt: NOW - 6 * DAY });
  const action = evaluateFollowUp({ ...rest, assigneeName: "Alice A" }, NOW)[0]!;
  assert.equal(action.assigneeName, "Alice A");
  assert.equal("assigneeOpUserId" in action, false);
});

test("exit conditions list the fields still empty, because OpenProject does not enforce them", () => {
  assert.deepEqual(exitBlockers("fm.qa", "fm.formal", {}), ["review_result", "qa_result"]);
  assert.deepEqual(exitBlockers("FM.QA", "fm.formal", { review_result: "pass", qa_result: "  " }), ["qa_result"]);
  assert.deepEqual(exitBlockers("fm.qa", "fm.formal", { review_result: "pass", qa_result: "pass" }), []);
  assert.deepEqual(exitBlockers("pm.in_progress", "pm.suspended", { suspend_reason: null }), ["suspend_reason"]);
  assert.deepEqual(exitBlockers("fm.in_progress", "fm.review", {}), []);
});
