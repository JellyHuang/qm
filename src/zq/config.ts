import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Cron } from "croner";
import { JENKINS_JOBS } from "./jenkins/client.ts";
import {
  DEFAULT_AUTHOR_EMAIL,
  DEFAULT_AUTHOR_NAME,
  DEFAULT_BODY_MAX,
  DEFAULT_SUBJECT_MAX,
  DEFAULT_TICKET_PATTERN,
  defaultOutputDir,
  validateIdentity,
  type PatchPackageSettings,
} from "./patch-package/settings.ts";
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
  gitAuthors: { externalDomains: readonly string[]; botNames: readonly string[] };
  patchPackage: PatchPackageSettings;
  jenkins: { url?: string; rerun: boolean; jobs: readonly string[]; rerunJobs: readonly string[]; hourlyCap: number };
}

const DEFAULT_CRON = "*/5 * * * *";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_DAILY_CEILING = 200;
const DEFAULT_ESCALATION_DAYS = 2;
const WEDNESDAY = 3;

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

function jobNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined || !raw.trim()) return [...fallback];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const job of list) if (!/^[\w.-]+$/.test(job)) throw new Error(`${name} must list plain job names: ${job}`);
  return list;
}

function patchPackageSettings(env: NodeJS.ProcessEnv): PatchPackageSettings {
  const ticketPattern = env.ZQ_PATCH_TICKET_PATTERN?.trim() || DEFAULT_TICKET_PATTERN;
  try {
    new RegExp(ticketPattern);
  } catch (e) {
    throw new Error("ZQ_PATCH_TICKET_PATTERN is not a valid regular expression", { cause: e });
  }
  const authorName = env.ZQ_PATCH_AUTHOR_NAME?.trim() || DEFAULT_AUTHOR_NAME;
  const authorEmail = env.ZQ_PATCH_AUTHOR_EMAIL?.trim() || DEFAULT_AUTHOR_EMAIL;
  try {
    validateIdentity(authorName, authorEmail);
  } catch (e) {
    throw new Error(`ZQ_PATCH_AUTHOR_NAME and ZQ_PATCH_AUTHOR_EMAIL: ${(e as Error).message}`, { cause: e });
  }
  const outputDir = env.ZQ_PATCH_OUTPUT_DIR?.trim() || defaultOutputDir();
  if (!isAbsolute(outputDir)) throw new Error("ZQ_PATCH_OUTPUT_DIR must be an absolute path");
  return {
    ticketPattern,
    authorName,
    authorEmail,
    outputDir,
    subjectMax: integer("ZQ_PATCH_SUBJECT_MAX", env.ZQ_PATCH_SUBJECT_MAX, DEFAULT_SUBJECT_MAX, 20, 200),
    bodyMax: integer("ZQ_PATCH_BODY_MAX", env.ZQ_PATCH_BODY_MAX, DEFAULT_BODY_MAX, 100, 50_000),
  };
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
    gitAuthors: {
      externalDomains: names(env.ZQ_GIT_EXTERNAL_DOMAINS),
      botNames: names(env.ZQ_GIT_BOT_NAMES),
    },
    patchPackage: patchPackageSettings(env),
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
