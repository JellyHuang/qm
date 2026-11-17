import assert from "node:assert/strict";
import { test } from "node:test";
import type { JenkinsBuild } from "../src/zq/jenkins/client.ts";
import {
  decide,
  fingerprint,
  paramProblem,
  type Decision,
  type DecisionInput,
  type DecisionPolicy,
} from "../src/zq/jenkins/decision.ts";

const NOW = 10_000_000_000;

const policy: DecisionPolicy = {
  failureResults: ["FAILURE"],
  rerunJobs: ["Server-Build"],
  causes: ["timer", "scm", "upstream"],
  maxAgeMs: 30 * 60_000,
  hourlyCap: 3,
  botUser: "qm-bot",
};

const build = (patch: Partial<JenkinsBuild> = {}): JenkinsBuild => ({
  number: 10,
  url: "http://j/job/Server-Build/10/",
  building: false,
  result: "FAILURE",
  timestamp: NOW - 120_000,
  duration: 60_000,
  causes: [{ kind: "timer" }],
  params: [{ name: "A", value: "1" }],
  maskedParams: [],
  ...patch,
});

const input = (patch: Partial<DecisionInput> = {}): DecisionInput => ({
  job: "Server-Build",
  build: build(),
  newer: [],
  rerunNumbers: new Set(),
  definedParams: ["A"],
  claimsLastHour: 0,
  chainFingerprints: new Set(),
  now: NOW,
  ...patch,
});

const cases: Array<[string, Partial<DecisionInput>, Decision, Partial<DecisionPolicy>?]> = [
  ["a failed timer build is rerun", {}, { action: "rerun" }],
  ["an scm build is rerun", { build: build({ causes: [{ kind: "scm" }] }) }, { action: "rerun" }],
  ["an upstream build is rerun", { build: build({ causes: [{ kind: "upstream" }] }) }, { action: "rerun" }],
  ["a running build waits", { build: build({ building: true, result: null }) }, { action: "wait" }],
  ["a build with no result waits", { build: build({ result: null }) }, { action: "wait" }],
  ["a success is ignored", { build: build({ result: "SUCCESS" }) }, { action: "ignore" }],
  ["an aborted build is ignored by default", { build: build({ result: "ABORTED" }) }, { action: "ignore" }],
  ["an unstable build is ignored by default", { build: build({ result: "UNSTABLE" }) }, { action: "ignore" }],
  [
    "an unstable build counts when configured",
    { build: build({ result: "UNSTABLE" }) },
    { action: "rerun" },
    { failureResults: ["FAILURE", "UNSTABLE"] },
  ],
  [
    "a build that finished long ago is too old",
    { build: build({ timestamp: NOW - 3 * 3_600_000 }) },
    { action: "skip", reason: "too_old" },
  ],
  ["a rerun of ours is never rerun", { rerunNumbers: new Set([10]) }, { action: "skip", reason: "is_rerun" }],
  [
    "a build started by the bot account is never rerun",
    { build: build({ causes: [{ kind: "user", userId: "QM-Bot" }] }) },
    { action: "skip", reason: "bot_triggered" },
    { causes: ["timer", "user"] },
  ],
  ["a job outside the rerun list is skipped", { job: "LLM-Wiki" }, { action: "skip", reason: "job_not_enabled" }],
  [
    "a human-triggered build is a manual trigger",
    { build: build({ causes: [{ kind: "user", userId: "alice" }] }) },
    { action: "skip", reason: "manual_trigger" },
  ],
  [
    "an unknown cause is not allowed",
    { build: build({ causes: [{ kind: "other" }] }) },
    { action: "skip", reason: "cause_not_allowed" },
  ],
  ["no cause at all is not allowed", { build: build({ causes: [] }) }, { action: "skip", reason: "cause_not_allowed" }],
  [
    "a human build is rerun when the allowlist says so",
    { build: build({ causes: [{ kind: "user", userId: "alice" }] }) },
    { action: "rerun" },
    { causes: ["timer", "user"] },
  ],
  [
    "a human retry of a build we reran is a chain",
    {
      build: build({ causes: [{ kind: "user", userId: "alice" }] }),
      chainFingerprints: new Set([fingerprint([{ name: "A", value: "1" }])]),
    },
    { action: "skip", reason: "chain_rerun" },
    { causes: ["timer", "user"] },
  ],
  [
    "a newer success supersedes",
    { newer: [{ number: 11, building: false, result: "SUCCESS" }] },
    { action: "skip", reason: "superseded" },
  ],
  [
    "a newer running build supersedes",
    { newer: [{ number: 11, building: true, result: null }] },
    { action: "skip", reason: "superseded" },
  ],
  [
    "a newer failure does not supersede",
    { newer: [{ number: 11, building: false, result: "FAILURE" }] },
    { action: "rerun" },
  ],
  [
    "masked parameters are refused with a notice",
    { build: build({ maskedParams: ["PASSWORD"] }) },
    { action: "skip", reason: "parameters_unreadable", notice: "needs_attention" },
  ],
  [
    "a parameter missing from the build is incomplete",
    { definedParams: ["A", "B"] },
    { action: "skip", reason: "parameters_incomplete", notice: "needs_attention" },
  ],
  [
    "a parameter the job does not define is incomplete",
    { definedParams: [] },
    { action: "skip", reason: "parameters_incomplete", notice: "needs_attention" },
  ],
  [
    "the circuit breaker trips at the cap",
    { claimsLastHour: 3 },
    { action: "skip", reason: "circuit_open", notice: "circuit_open" },
  ],
  ["one claim below the cap still reruns", { claimsLastHour: 2 }, { action: "rerun" }],
];

for (const [name, patch, expected, policyPatch] of cases)
  test(`decide: ${name}`, () => {
    assert.deepEqual(decide(input(patch), { ...policy, ...policyPatch }), expected);
  });

test("parameter problems are named from the build and the job definition", () => {
  assert.equal(paramProblem({ params: [{ name: "A", value: "" }], maskedParams: [] }, ["A"]), undefined);
  assert.equal(paramProblem({ params: [], maskedParams: ["P"] }, []), "parameters_unreadable");
  assert.equal(paramProblem({ params: [], maskedParams: [] }, ["A"]), "parameters_incomplete");
});

test("the fingerprint ignores order and tells different values apart", () => {
  const a = [
    { name: "A", value: "1" },
    { name: "B", value: "" },
  ];
  assert.equal(fingerprint(a), fingerprint([...a].reverse()));
  assert.notEqual(
    fingerprint(a),
    fingerprint([
      { name: "A", value: "1" },
      { name: "B", value: "x" },
    ]),
  );
});
