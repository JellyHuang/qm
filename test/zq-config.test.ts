import test from "node:test";
import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";

test("everything is off by default and no report is scheduled", () => {
  const c = zqConfigFromEnv({});
  assert.deepEqual(
    [c.identityMap, c.scanner.enabled, c.deliverReminders, c.reports.enabled],
    [false, false, false, false],
  );
  assert.equal(c.reports.dailyCron, undefined);
  assert.equal(c.reports.weeklyCron, undefined);
  assert.equal(c.scanner.timezone, "Asia/Shanghai");
  assert.equal(c.reminderDailyCeiling, 200);
  assert.deepEqual(c.escalation, { duties: [], afterDays: 2 });
});

test("the weekly report is always on Wednesday and the time is configurable", () => {
  assert.equal(zqConfigFromEnv({ ZQ_REPORT_WEEKLY_AT: "10:05" }).reports.weeklyCron, "5 10 * * 3");
  assert.equal(zqConfigFromEnv({ ZQ_REPORT_DAILY_AT: "9:30" }).reports.dailyCron, "30 9 * * *");
  assert.throws(() => zqConfigFromEnv({ ZQ_REPORT_WEEKLY_AT: "25:00" }), /ZQ_REPORT_WEEKLY_AT/);
});

test("the scanner needs the contract key table, and bad values refuse startup", () => {
  assert.throws(() => zqConfigFromEnv({ ZQ_SCANNER: "1" }), /ZQ_CONTRACT_FILE/);
  assert.equal(zqConfigFromEnv({ ZQ_SCANNER: "1", ZQ_CONTRACT_FILE: "/x.json" }).contractFile, "/x.json");
  assert.throws(() => zqConfigFromEnv({ ZQ_SCANNER_TZ: "Mars/Base" }), /IANA/);
  assert.throws(() => zqConfigFromEnv({ ZQ_SCANNER_CRON: "nope" }), /ZQ_SCANNER_CRON/);
  assert.throws(() => zqConfigFromEnv({ ZQ_REMINDER_DAILY_CEILING: "0" }), /ZQ_REMINDER_DAILY_CEILING/);
});

test("escalation targets are duties from the contract and are not chosen by default", () => {
  assert.deepEqual(zqConfigFromEnv({ ZQ_ESCALATION_DUTIES: "pm, planning_lead" }).escalation.duties, [
    "pm",
    "planning_lead",
  ]);
  assert.throws(() => zqConfigFromEnv({ ZQ_ESCALATION_DUTIES: "Boss!" }), /ZQ_ESCALATION_DUTIES must list duty keys/);
});

test("feature channels and the OpenProject link are off and unset by default, and the URL must be http(s)", () => {
  const c = zqConfigFromEnv({});
  assert.equal(c.featureChannels, false);
  assert.equal(c.opBaseUrl, undefined);
  const on = zqConfigFromEnv({ ZQ_FEATURE_CHANNELS: "1", ZQ_OP_BASE_URL: "https://op.example.com//" });
  assert.deepEqual([on.featureChannels, on.opBaseUrl], [true, "https://op.example.com"]);
  assert.throws(() => zqConfigFromEnv({ ZQ_OP_BASE_URL: "op.example.com" }), /ZQ_OP_BASE_URL/);
});

test("who hears about an empty responsibility field is configured and never chosen by default", () => {
  assert.deepEqual(zqConfigFromEnv({}).unsetResponsibilityDuties, []);
  assert.deepEqual(zqConfigFromEnv({ ZQ_UNSET_RESPONSIBILITY_DUTIES: "pm,producer" }).unsetResponsibilityDuties, [
    "pm",
    "producer",
  ]);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_UNSET_RESPONSIBILITY_DUTIES: "no body" }),
    /ZQ_UNSET_RESPONSIBILITY_DUTIES must list duty keys/,
  );
});

test("the zq-git-mcp service address and secret go together and the author rules are plain lists", () => {
  const off = zqConfigFromEnv({});
  assert.equal(off.gitMcp, undefined);
  assert.deepEqual(off.gitAuthors, { externalDomains: [], botNames: [] });
  const on = zqConfigFromEnv({
    ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp",
    ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789",
    ZQ_GIT_EXTERNAL_DOMAINS: "@pipeline.invalid, partner.example,",
    ZQ_GIT_BOT_NAMES: "ExampleBot.compiler",
  });
  assert.deepEqual(on.gitMcp, { url: "http://127.0.0.1:8765/mcp", secret: "a-shared-secret-0123456789" });
  assert.deepEqual(on.gitAuthors, {
    externalDomains: ["@pipeline.invalid", "partner.example"],
    botNames: ["ExampleBot.compiler"],
  });
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp" }), /go together/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_MCP_SECRET: "x" }), /go together/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_GIT_MCP_URL: "ftp://host/mcp", ZQ_GIT_MCP_SECRET: "never-echoed-secret" }),
    (e) => e instanceof Error && /http\(s\)/.test(e.message) && !e.message.includes("never-echoed-secret"),
  );
});

test("patch package settings default to a QM identity and a documented ticket pattern and enable nothing", () => {
  const c = zqConfigFromEnv({});
  assert.equal(c.patchPackage.ticketPattern, "^(WP-)?[0-9]{1,9}$");
  assert.equal(c.patchPackage.authorName, "QM Bot");
  assert.equal(c.patchPackage.authorEmail, "qm-bot@invalid");
  assert.equal(c.patchPackage.subjectMax, 72);
  assert.equal(c.patchPackage.bodyMax, 5000);
  assert.equal(c.patchPackage.maxPackageBytes, 80 * 1024 * 1024);
  assert.match(c.patchPackage.outputDir, /qm-patch-packages$/);
  assert.deepEqual(
    [c.identityMap, c.scanner.enabled, c.deliverReminders, c.reports.enabled, c.featureChannels, c.jenkins.rerun],
    [false, false, false, false, false, false],
  );
});

test("patch package settings come from the environment and bad values refuse startup", () => {
  const c = zqConfigFromEnv({
    ZQ_PATCH_TICKET_PATTERN: "^WP-[0-9]+$",
    ZQ_PATCH_AUTHOR_NAME: "QM Patches",
    ZQ_PATCH_AUTHOR_EMAIL: "qm@example.test",
    ZQ_PATCH_OUTPUT_DIR: "/var/qm/patches",
    ZQ_PATCH_SUBJECT_MAX: "100",
    ZQ_PATCH_BODY_MAX: "2000",
    ZQ_PATCH_MAX_PACKAGE_BYTES: "1048576",
  });
  assert.deepEqual(c.patchPackage, {
    ticketPattern: "^WP-[0-9]+$",
    authorName: "QM Patches",
    authorEmail: "qm@example.test",
    outputDir: "/var/qm/patches",
    subjectMax: 100,
    bodyMax: 2000,
    maxPackageBytes: 1048576,
  });
  assert.throws(() => zqConfigFromEnv({ ZQ_PATCH_TICKET_PATTERN: "(" }), /ZQ_PATCH_TICKET_PATTERN/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_PATCH_AUTHOR_NAME: "Alice", ZQ_PATCH_AUTHOR_EMAIL: "alice@example.test" }),
    /ZQ_PATCH_AUTHOR_NAME/,
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_PATCH_OUTPUT_DIR: "relative/dir" }), /ZQ_PATCH_OUTPUT_DIR/);
  assert.throws(() => zqConfigFromEnv({ ZQ_PATCH_SUBJECT_MAX: "5" }), /ZQ_PATCH_SUBJECT_MAX/);
  for (const bad of ["0", "-5", "1.5", "lots", "9007199254740993"])
    assert.throws(() => zqConfigFromEnv({ ZQ_PATCH_MAX_PACKAGE_BYTES: bad }), /ZQ_PATCH_MAX_PACKAGE_BYTES/, bad);
});
