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
    ZQ_GIT_EXTERNAL_DOMAINS: "@yizhu, partner.example,",
    ZQ_GIT_BOT_NAMES: "ZQBot.compiler",
  });
  assert.deepEqual(on.gitMcp, { url: "http://127.0.0.1:8765/mcp", secret: "a-shared-secret-0123456789" });
  assert.deepEqual(on.gitAuthors, { externalDomains: ["@yizhu", "partner.example"], botNames: ["ZQBot.compiler"] });
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp" }), /go together/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_MCP_SECRET: "x" }), /go together/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_GIT_MCP_URL: "ftp://host/mcp", ZQ_GIT_MCP_SECRET: "never-echoed-secret" }),
    (e) => e instanceof Error && /http\(s\)/.test(e.message) && !e.message.includes("never-echoed-secret"),
  );
});

test("the git poll switch is off by default, needs the service address and secret, and bounds its interval", () => {
  assert.deepEqual(zqConfigFromEnv({}).gitPoll, { enabled: false, intervalMs: 300_000 });
  const service = { ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp", ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789" };
  assert.equal(zqConfigFromEnv(service).gitPoll.enabled, false);
  assert.deepEqual(zqConfigFromEnv({ ...service, ZQ_GIT_POLL: "1", ZQ_GIT_POLL_SECONDS: "30" }).gitPoll, {
    enabled: true,
    intervalMs: 30_000,
  });
  assert.equal(zqConfigFromEnv({ ...service, ZQ_GIT_POLL_SECONDS: "3600" }).gitPoll.intervalMs, 3_600_000);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_POLL: "1" }), /ZQ_GIT_POLL needs ZQ_GIT_MCP_URL and ZQ_GIT_MCP_SECRET/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_POLL: "1", ZQ_GIT_MCP_URL: service.ZQ_GIT_MCP_URL }), /go together/);
  for (const bad of ["29", "3601", "0", "-5", "1.5", "abc"])
    assert.throws(
      () => zqConfigFromEnv({ ...service, ZQ_GIT_POLL_SECONDS: bad }),
      /ZQ_GIT_POLL_SECONDS must be an integer from 30 through 3600/,
    );
});
