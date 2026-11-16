import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkConfiguredDuties, lifecycleOf, paused, parseContract } from "../src/zq/contract.ts";

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8"));

test("the fixture parses and keeps the labels for the stage keys", () => {
  const c = parseContract(raw());
  assert.equal(c.featureType, "feature");
  assert.equal(c.stages.feature["feature.briefing"], "宣讲对齐");
  assert.equal(c.stageRoles.inProduction, "feature.development");
  assert.equal(c.stages.task["program.integration"], "联调中");
  assert.deepEqual(c.stageOwners["feature.review"], [{ kind: "field", field: "reviewer" }]);
  assert.equal(c.fields.qaOwner, "qa_owner");
  assert.equal(c.tools.exitCheck, "zq_check_exit");
});

test("optional tools are accepted, unknown ones are refused", () => {
  const ok = parseContract({ ...raw(), tools: { exitCheck: "other_check" } });
  assert.equal(ok.tools.exitCheck, "other_check");
  assert.throws(() => parseContract({ ...raw(), tools: { other: "x" } }), /unknown tool other/);
});

test("a table that names a stage owner for an unknown stage or an unknown duty is refused", () => {
  assert.throws(
    () => parseContract({ ...raw(), stageOwners: { "feature.nope": ["duty:pm"] } }),
    /unknown feature stage/,
  );
  assert.throws(
    () => parseContract({ ...raw(), stageOwners: { "feature.planning": ["duty:nobody"] } }),
    /unknown recipient/,
  );
  assert.throws(() => parseContract({ ...raw(), typeDuties: { vfx: "wizard" } }), /not a duty/);
  assert.throws(() => parseContract({ ...raw(), fields: {} }), /fields\.responsiblePlanner/);
  assert.throws(() => parseContract([]), /must be an object/);
  assert.throws(() => parseContract({ ...raw(), stageRoles: undefined }), /stageRoles must be an object/);
  assert.throws(
    () => parseContract({ ...raw(), stageRoles: { ...(raw()["stageRoles"] as object), briefing: "feature.nope" } }),
    /stageRoles\.briefing names unknown stage feature\.nope/,
  );
});

test("only the four lifecycle keys are understood, and suspended and cancelled pause reminders", () => {
  assert.deepEqual(["normal", "delayed", "suspended", "cancelled", "closed", 3].map(lifecycleOf), [
    "normal",
    "delayed",
    "suspended",
    "cancelled",
    undefined,
    undefined,
  ]);
  assert.deepEqual(
    [undefined, "normal", "delayed", "suspended", "cancelled"].map((l) => paused(lifecycleOf(l))),
    [false, false, false, true, true],
  );
});

test("the duties are whatever the table names, so a new duty such as a new lead needs no code change", () => {
  const base = raw();
  const table = {
    ...base,
    typeDuties: { ...(base["typeDuties"] as object), vfx: "vfx_lead" },
    duties: { ...(base["duties"] as object), vfx_lead: "lead_vfx" },
    stageOwners: {
      ...(base["stageOwners"] as object),
      "feature.staffing": ["field:responsiblePlanner", "duty:vfx_lead"],
    },
  };
  const c = parseContract(table);
  assert.deepEqual(c.typeOwners["vfx"], { kind: "duty", duty: "vfx_lead" });
  assert.equal(c.duties["vfx_lead"], "lead_vfx");
  assert.deepEqual(c.stageOwners["feature.staffing"]?.[1], { kind: "duty", duty: "vfx_lead" });
  assert.throws(() => parseContract({ ...table, duties: base["duties"] }), /typeDuties\.vfx is not a duty/);
  assert.throws(() => parseContract({ ...table, duties: {} }), /at least one duty/);
  assert.throws(() => parseContract({ ...table, duties: { "Lead UI": "x" } }), /is not a duty key/);
});

test("the duties set in the configuration must exist in the table, and the check names the setting", () => {
  const c = parseContract(raw());
  checkConfiguredDuties(c, { ZQ_ESCALATION_DUTIES: ["pm", "producer"], ZQ_UNSET_RESPONSIBILITY_DUTIES: [] });
  assert.throws(
    () => checkConfiguredDuties(c, { ZQ_ESCALATION_DUTIES: ["boss"] }),
    /ZQ_ESCALATION_DUTIES names a duty the contract key table does not have: boss/,
  );
});

test("the 0.4 key table is read: bug type, art resource flags, auto-advance stages, a task person field as a type owner", () => {
  const c = parseContract(raw());
  assert.equal(c.bugType, "bug");
  assert.deepEqual(
    ["ui", "fgui", "character_model", "backend", "frontend", "qa_test", "configuration", "brand_new_type"].map((t) =>
      c.artResource(t),
    ),
    [true, true, true, false, false, false, false, false],
  );
  assert.deepEqual(c.autoAdvanceStages, ["feature.development", "feature.resources"]);
  assert.deepEqual(c.typeOwners["configuration"], { kind: "taskField", field: "responsiblePlanner" });
  assert.deepEqual(c.typeOwners["ui"], { kind: "duty", duty: "ui_lead" });
  assert.equal(c.stageRoles.bugClosed, "bug.closed");
  assert.equal(c.fields.delayedSince, "delayed_since");
  assert.throws(() => parseContract({ ...raw(), autoAdvanceStages: ["feature.nope"] }), /unknown feature stage/);
  assert.throws(
    () => parseContract({ ...raw(), typeDuties: { x: { kind: "field", field: "nobody", on: "task" } } }),
    /unknown person field nobody/,
  );
});
