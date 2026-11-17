import { readFileSync } from "node:fs";
import { Cron } from "croner";
import { JENKINS_JOBS } from "./jenkins/client.ts";
import { parseContract, type Duty, type ZqContract } from "./contract.ts";

export interface ZqConfig {
  identityMap: boolean;
  scanner: { enabled: boolean; cron: string; timezone: string };
  deliverReminders: boolean;
  reminderDailyCeiling: number;
  contractFile?: string;
  opBaseUrl?: string;
  featureChannels: boolean;
  changeDigest: boolean;
  childOrders: boolean;
  remarkPrincipal?: string;
  escalation: { duties: readonly Duty[]; afterDays: number };
  unsetResponsibilityDuties: readonly Duty[];
  reports: { enabled: boolean; dailyCron?: string; weeklyCron?: string };
  gitMcp?: { url: string; secret: string };
  gitPoll: { enabled: boolean; intervalMs: number };
  gitAuthors: {
    externalDomains: readonly string[];
    botNames: readonly string[];
    botTokens: readonly string[];
    genericNames: readonly string[];
    identityAdmins: readonly string[];
    bindMaxPerPerson: number;
    bind: boolean;
    mattermostEmailFallback: boolean;
    mapping: boolean;
    ignoredReopenDays: number;
    queueRetentionDays: number;
  };
  jenkins: { url?: string; rerun: boolean; jobs: readonly string[]; rerunJobs: readonly string[]; hourlyCap: number };
}

const DEFAULT_CRON = "*/5 * * * *";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_DAILY_CEILING = 200;
const DEFAULT_ESCALATION_DAYS = 2;
const WEDNESDAY = 3;
const GIT_POLL_SECONDS = { default: 300, min: 30, max: 3600 };
const DEFAULT_BOT_TOKENS = ["bot"];
const DEFAULT_GENERIC_NAMES = ["admin", "administrator", "root", "test", "user", "git", "unknown", "pc"];
const MAX_BOT_TOKENS = 50;

const on = (value: string | undefined) => value?.trim() === "1";

function clock(name: string, raw: string | undefined, weekday: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`${name} must look like 09:30`);
  return `${Number(match[2])} ${Number(match[1])} * * ${weekday}`;
}

function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw?.trim() || fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return n;
}

function duties(name: string, raw: string | undefined): Duty[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const duty of list)
    if (!/^[a-z][a-z0-9_]*$/.test(duty)) throw new Error(`${name} must list duty keys such as pm,lead_ui: ${duty}`);
  return list;
}

function names(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function listed(name: string, raw: string | undefined, fallback: readonly string[], valid: (item: string) => boolean) {
  const list = raw === undefined ? [...fallback] : names(raw);
  for (const item of list) if (!valid(item)) throw new Error(`${name} has an invalid item: ${item}`);
  return list;
}

function jobNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined || !raw.trim()) return [...fallback];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const job of list) if (!/^[\w.-]+$/.test(job)) throw new Error(`${name} must list plain job names: ${job}`);
  return list;
}

export function zqConfigFromEnv(env: NodeJS.ProcessEnv): ZqConfig {
  const cron = env.ZQ_SCANNER_CRON?.trim() || DEFAULT_CRON;
  const timezone = env.ZQ_SCANNER_TZ?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`ZQ_SCANNER_TZ is not an IANA timezone: ${timezone}`);
  }
  try {
    new Cron(cron, { timezone, paused: true, mode: "5-part" });
  } catch (e) {
    throw new Error("ZQ_SCANNER_CRON or ZQ_SCANNER_TZ is invalid", { cause: e });
  }
  const dailyCron = clock("ZQ_REPORT_DAILY_AT", env.ZQ_REPORT_DAILY_AT, "*");
  const weeklyCron = clock("ZQ_REPORT_WEEKLY_AT", env.ZQ_REPORT_WEEKLY_AT, String(WEDNESDAY));
  const contractFile = env.ZQ_CONTRACT_FILE?.trim();
  const opBaseUrl = env.ZQ_OP_BASE_URL?.trim().replace(/\/+$/, "");
  if (opBaseUrl && !/^https?:\/\//.test(opBaseUrl)) throw new Error("ZQ_OP_BASE_URL must be an http(s) URL");
  const scannerEnabled = on(env.ZQ_SCANNER);
  if (scannerEnabled && !contractFile) throw new Error("ZQ_SCANNER needs ZQ_CONTRACT_FILE (the contract key table)");
  const gitMcpUrl = env.ZQ_GIT_MCP_URL?.trim();
  const gitMcpSecret = env.ZQ_GIT_MCP_SECRET?.trim();
  if (gitMcpUrl && !/^https?:\/\//.test(gitMcpUrl)) throw new Error("ZQ_GIT_MCP_URL must be an http(s) URL");
  if (Boolean(gitMcpUrl) !== Boolean(gitMcpSecret)) throw new Error("ZQ_GIT_MCP_URL and ZQ_GIT_MCP_SECRET go together");
  const gitPoll = on(env.ZQ_GIT_POLL);
  if (gitPoll && !gitMcpUrl) throw new Error("ZQ_GIT_POLL needs ZQ_GIT_MCP_URL and ZQ_GIT_MCP_SECRET");
  const gitAuthorMapping = on(env.ZQ_GIT_AUTHOR_MAPPING);
  if (gitAuthorMapping && !gitPoll) throw new Error("ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1");
  const gitAuthorBind = on(env.ZQ_GIT_AUTHOR_BIND);
  if (gitAuthorBind && !gitAuthorMapping) throw new Error("ZQ_GIT_AUTHOR_BIND needs ZQ_GIT_AUTHOR_MAPPING=1");
  const gitEmailFallback = on(env.ZQ_GIT_MATTERMOST_EMAIL_FALLBACK);
  if (gitEmailFallback && !gitAuthorMapping)
    throw new Error("ZQ_GIT_MATTERMOST_EMAIL_FALLBACK needs ZQ_GIT_AUTHOR_MAPPING=1");
  const botTokens = listed("ZQ_GIT_BOT_TOKENS", env.ZQ_GIT_BOT_TOKENS, DEFAULT_BOT_TOKENS, (item) =>
    /^[a-z0-9]{2,32}$/.test(item),
  );
  if (botTokens.length > MAX_BOT_TOKENS) throw new Error(`ZQ_GIT_BOT_TOKENS lists at most ${MAX_BOT_TOKENS} tokens`);
  const genericNames = listed(
    "ZQ_GIT_GENERIC_NAMES",
    env.ZQ_GIT_GENERIC_NAMES,
    DEFAULT_GENERIC_NAMES,
    (item) => !item.includes("\\"),
  );
  const identityAdmins = listed("ZQ_GIT_IDENTITY_ADMINS", env.ZQ_GIT_IDENTITY_ADMINS, [], (item) =>
    /^[\x21-\x7e]{1,256}$/.test(item),
  );
  const gitPollSeconds = integer(
    "ZQ_GIT_POLL_SECONDS",
    env.ZQ_GIT_POLL_SECONDS,
    GIT_POLL_SECONDS.default,
    GIT_POLL_SECONDS.min,
    GIT_POLL_SECONDS.max,
  );
  const jenkinsUrl = env.ZQ_JENKINS_URL?.trim().replace(/\/+$/, "");
  if (jenkinsUrl && !/^https?:\/\//.test(jenkinsUrl)) throw new Error("ZQ_JENKINS_URL must be an http(s) URL");
  const jenkinsRerun = on(env.ZQ_JENKINS_RERUN);
  if (jenkinsRerun && !jenkinsUrl) throw new Error("ZQ_JENKINS_RERUN needs ZQ_JENKINS_URL");
  const jenkinsJobs = jobNames("ZQ_JENKINS_JOBS", env.ZQ_JENKINS_JOBS, JENKINS_JOBS);
  const rerunJobs = jobNames("ZQ_JENKINS_RERUN_JOBS", env.ZQ_JENKINS_RERUN_JOBS, []);
  const outside = rerunJobs.filter((job) => !jenkinsJobs.includes(job));
  if (outside.length > 0)
    throw new Error(`ZQ_JENKINS_RERUN_JOBS names jobs outside ZQ_JENKINS_JOBS: ${outside.join(", ")}`);
  return {
    identityMap: on(env.ZQ_IDENTITY_MAP),
    scanner: { enabled: scannerEnabled, cron, timezone },
    deliverReminders: on(env.ZQ_REMINDER_DELIVERY),
    reminderDailyCeiling: integer(
      "ZQ_REMINDER_DAILY_CEILING",
      env.ZQ_REMINDER_DAILY_CEILING,
      DEFAULT_DAILY_CEILING,
      1,
      10_000,
    ),
    ...(contractFile ? { contractFile } : {}),
    ...(opBaseUrl ? { opBaseUrl } : {}),
    featureChannels: on(env.ZQ_FEATURE_CHANNELS),
    changeDigest: on(env.ZQ_CHANGE_DIGEST),
    childOrders: on(env.ZQ_CHILD_ORDERS),
    ...(env.ZQ_REMARK_PRINCIPAL?.trim() ? { remarkPrincipal: env.ZQ_REMARK_PRINCIPAL.trim() } : {}),
    escalation: {
      duties: duties("ZQ_ESCALATION_DUTIES", env.ZQ_ESCALATION_DUTIES),
      afterDays: integer("ZQ_ESCALATION_AFTER_DAYS", env.ZQ_ESCALATION_AFTER_DAYS, DEFAULT_ESCALATION_DAYS, 1, 365),
    },
    unsetResponsibilityDuties: duties("ZQ_UNSET_RESPONSIBILITY_DUTIES", env.ZQ_UNSET_RESPONSIBILITY_DUTIES),
    reports: {
      enabled: on(env.ZQ_REPORTS),
      ...(dailyCron ? { dailyCron } : {}),
      ...(weeklyCron ? { weeklyCron } : {}),
    },
    ...(gitMcpUrl && gitMcpSecret ? { gitMcp: { url: gitMcpUrl, secret: gitMcpSecret } } : {}),
    gitPoll: { enabled: gitPoll, intervalMs: gitPollSeconds * 1000 },
    gitAuthors: {
      externalDomains: names(env.ZQ_GIT_EXTERNAL_DOMAINS),
      botNames: names(env.ZQ_GIT_BOT_NAMES),
      botTokens,
      genericNames,
      identityAdmins,
      bindMaxPerPerson: integer("ZQ_GIT_BIND_MAX_PER_PERSON", env.ZQ_GIT_BIND_MAX_PER_PERSON, 10, 1, 100),
      bind: gitAuthorBind,
      mattermostEmailFallback: gitEmailFallback,
      mapping: gitAuthorMapping,
      ignoredReopenDays: integer("ZQ_GIT_IGNORED_REOPEN_DAYS", env.ZQ_GIT_IGNORED_REOPEN_DAYS, 0, 0, 3650),
      queueRetentionDays: integer("ZQ_GIT_UNMAPPED_RETENTION_DAYS", env.ZQ_GIT_UNMAPPED_RETENTION_DAYS, 180, 1, 3650),
    },
    jenkins: {
      ...(jenkinsUrl ? { url: jenkinsUrl } : {}),
      rerun: jenkinsRerun,
      jobs: jenkinsJobs,
      rerunJobs,
      hourlyCap: integer("ZQ_JENKINS_RERUN_HOURLY_CAP", env.ZQ_JENKINS_RERUN_HOURLY_CAP, 3, 1, 100),
    },
  };
}

export function loadZqContract(path: string): ZqContract {
  return parseContract(JSON.parse(readFileSync(path, "utf8")));
}
