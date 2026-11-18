import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { agendaPreviewArgs, outcomePreviewArgs, previewMeetingWrite } from "../src/zq/meetings.ts";

test("an outcome is checked against the tool's rules before any call, and always carries confirm=false", () => {
  const ok = outcomePreviewArgs({ agendaItemId: 50, kind: "decision", notes: "  确认需求范围  " });
  assert.deepEqual(ok, {
    ok: true,
    args: { agenda_item_id: 50, kind: "decision", notes: "确认需求范围", confirm: false },
  });
  assert.deepEqual(outcomePreviewArgs({ agendaItemId: 50, kind: "information" }), {
    ok: false,
    problems: ["「信息」类结论必须写内容"],
  });
  assert.deepEqual(outcomePreviewArgs({ agendaItemId: 50, kind: "work_package", notes: "x" }), {
    ok: false,
    problems: ["「工单」类结论必须指定工单"],
  });
  assert.deepEqual(outcomePreviewArgs({ agendaItemId: 50, kind: "work_package", workPackageId: 7 }), {
    ok: true,
    args: { agenda_item_id: 50, kind: "work_package", work_package_id: 7, confirm: false },
  });
  assert.equal(outcomePreviewArgs({ agendaItemId: 0, kind: "decision" }).ok, false);
  assert.equal(outcomePreviewArgs({ agendaItemId: 5, kind: "decision", notes: "x".repeat(50_001) }).ok, false);
});

test("an agenda item is checked for title, notes and duration, and a work package item names its work package", () => {
  assert.deepEqual(agendaPreviewArgs({ meetingId: 21, title: " 宣讲结论 ", durationMinutes: 15 }), {
    ok: true,
    args: { meeting_id: 21, title: "宣讲结论", duration_in_minutes: 15, confirm: false },
  });
  assert.deepEqual(agendaPreviewArgs({ meetingId: 21, title: "t", workPackageId: 9 }), {
    ok: true,
    args: { meeting_id: 21, title: "t", item_type: "work_package", work_package_id: 9, confirm: false },
  });
  const bad = agendaPreviewArgs({ meetingId: 0, title: " ", durationMinutes: 1441 });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.problems.length, 3);
  assert.equal(agendaPreviewArgs({ meetingId: 1, title: "x".repeat(256) }).ok, false);
});

test("a preview is the only call ever made, and a server-side problem is reported instead of hidden", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const call = (body: unknown) => async (tool: string, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    return JSON.stringify(body);
  };
  const built = outcomePreviewArgs({ agendaItemId: 50, kind: "decision", notes: "n" });
  const ready = await previewMeetingWrite(
    call({ state: "preview", ready: true, validation_errors: {} }),
    "openproject_create_meeting_outcome",
    built,
  );
  assert.deepEqual(ready, { ready: true, problems: [] });
  assert.equal(calls[0]![1]["confirm"], false);
  const rejected = await previewMeetingWrite(
    call({ state: "preview", ready: false, validation_errors: { kind: "不被允许" } }),
    "openproject_create_meeting_outcome",
    built,
  );
  assert.deepEqual(rejected, { ready: false, problems: ["kind: 不被允许"] });
  const invalid = await previewMeetingWrite(
    call({}),
    "openproject_create_meeting_outcome",
    outcomePreviewArgs({ agendaItemId: 50, kind: "information" }),
  );
  assert.equal(invalid.ready, false);
  assert.equal(calls.length, 2, "nothing is called for an input the checks already refuse");
  assert.ok(calls.every(([, args]) => args["confirm"] === false));
});
