import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lifecycleOf, paused, parseContract } from "../src/zq/contract.ts";

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8"));

test("the fixture parses and keeps the labels for the stage keys", () => {
  const c = parseContract(raw());
  assert.equal(c.featureType, "feature");
  assert.equal(c.stages.feature["feature.briefing"], "宣讲对齐");
  assert.deepEqual(c.tools, {});
});

test("optional tools are accepted, unknown ones are refused", () => {
  const ok = parseContract({ ...raw(), tools: { exitCheck: "zq_check_exit" } });
  assert.equal(ok.tools.exitCheck, "zq_check_exit");
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
