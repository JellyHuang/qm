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
