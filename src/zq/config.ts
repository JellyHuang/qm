import { readFileSync } from "node:fs";
import { Cron } from "croner";
import { GIT_FETCH_TIMEOUT_MS } from "./git/runner.ts";
import { DEFAULT_GIT_LIMITS, type GitLimitsConfig } from "./git/limits.ts";
import { isGitRepo } from "./git/validate.ts";
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
  roleplay?: { mmUserId: string; projectIds: readonly string[] };
  changeDigest: boolean;
  childOrders: boolean;
  remarkPrincipal?: string;
  escalation: { duties: readonly Duty[]; afterDays: number };
  unsetResponsibilityDuties: readonly Duty[];
  reports: { enabled: boolean; dailyCron?: string; weeklyCron?: string };
  jenkins: { url?: string; rerun: boolean; jobs: readonly string[]; rerunJobs: readonly string[]; hourlyCap: number };
  git: {
    enabled: boolean;
    dir?: string;
    remotes: Record<string, string>;
    knownHosts?: string;
    fetchTimeoutMs: number;
    limits: GitLimitsConfig;
  };
}

const DEFAULT_CRON = "*/5 * * * *";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_DAILY_CEILING = 200;
const DEFAULT_ESCALATION_DAYS = 2;
const WEDNESDAY = 3;
const MAX_GIT_DAILY_BYTES = 10 * 1024 ** 3;
const MAX_GIT_FETCH_TIMEOUT_MS = 24 * 60 * 60_000;

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

function jobNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined || !raw.trim()) return [...fallback];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const job of list) if (!/^[\w.-]+$/.test(job)) throw new Error(`${name} must list plain job names: ${job}`);
  return list;
}

function gitRemotes(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("ZQ_GIT_REMOTES must be a JSON object of repository name to URL", { cause: e });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("ZQ_GIT_REMOTES must be a JSON object of repository name to URL");
  const remotes: Record<string, string> = {};
  for (const [name, url] of Object.entries(parsed)) {
    if (!isGitRepo(name)) throw new Error(`ZQ_GIT_REMOTES names a repository outside the allowlist: ${name}`);
    if (typeof url !== "string" || !url.trim() || url.startsWith("-"))
      throw new Error(`ZQ_GIT_REMOTES needs a URL for ${name}`);
    remotes[name] = url.trim();
  }
  return remotes;
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
  const gitDir = env.ZQ_GIT_DIR?.trim();
  const gitKnownHosts = env.ZQ_GIT_KNOWN_HOSTS?.trim();
  const gitEnabled = on(env.ZQ_GIT_READONLY);
  if (gitEnabled && !gitDir) throw new Error("ZQ_GIT_READONLY needs ZQ_GIT_DIR (the bare clone directory)");
  const jenkinsUrl = env.ZQ_JENKINS_URL?.trim().replace(/\/+$/, "");
  if (jenkinsUrl && !/^https?:\/\//.test(jenkinsUrl)) throw new Error("ZQ_JENKINS_URL must be an http(s) URL");
  const jenkinsRerun = on(env.ZQ_JENKINS_RERUN);
  if (jenkinsRerun && !jenkinsUrl) throw new Error("ZQ_JENKINS_RERUN needs ZQ_JENKINS_URL");
  const jenkinsJobs = jobNames("ZQ_JENKINS_JOBS", env.ZQ_JENKINS_JOBS, JENKINS_JOBS);
  const rerunJobs = jobNames("ZQ_JENKINS_RERUN_JOBS", env.ZQ_JENKINS_RERUN_JOBS, []);
  const outside = rerunJobs.filter((job) => !jenkinsJobs.includes(job));
  if (outside.length > 0)
    throw new Error(`ZQ_JENKINS_RERUN_JOBS names jobs outside ZQ_JENKINS_JOBS: ${outside.join(", ")}`);
  const roleplayUser = env.ZQ_ROLEPLAY_MM_USER?.trim();
  const roleplayProjects = (env.ZQ_ROLEPLAY_PROJECTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (Boolean(roleplayUser) !== roleplayProjects.length > 0)
    throw new Error("ZQ_ROLEPLAY_MM_USER and ZQ_ROLEPLAY_PROJECTS must be set together");
  return {
    ...(roleplayUser ? { roleplay: { mmUserId: roleplayUser, projectIds: roleplayProjects } } : {}),
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
    jenkins: {
      ...(jenkinsUrl ? { url: jenkinsUrl } : {}),
      rerun: jenkinsRerun,
      jobs: jenkinsJobs,
      rerunJobs,
      hourlyCap: integer("ZQ_JENKINS_RERUN_HOURLY_CAP", env.ZQ_JENKINS_RERUN_HOURLY_CAP, 3, 1, 100),
    },
    git: {
      enabled: gitEnabled,
      remotes: gitRemotes(env.ZQ_GIT_REMOTES),
      fetchTimeoutMs: integer(
        "ZQ_GIT_FETCH_TIMEOUT_MS",
        env.ZQ_GIT_FETCH_TIMEOUT_MS,
        GIT_FETCH_TIMEOUT_MS,
        1000,
        MAX_GIT_FETCH_TIMEOUT_MS,
      ),
      limits: {
        callsPerMinute: integer(
          "ZQ_GIT_CALLS_PER_MINUTE",
          env.ZQ_GIT_CALLS_PER_MINUTE,
          DEFAULT_GIT_LIMITS.callsPerMinute,
          1,
          10_000,
        ),
        globalCallsPerMinute: integer(
          "ZQ_GIT_GLOBAL_CALLS_PER_MINUTE",
          env.ZQ_GIT_GLOBAL_CALLS_PER_MINUTE,
          DEFAULT_GIT_LIMITS.globalCallsPerMinute,
          1,
          100_000,
        ),
        dailyBytes: integer(
          "ZQ_GIT_DAILY_BYTES",
          env.ZQ_GIT_DAILY_BYTES,
          DEFAULT_GIT_LIMITS.dailyBytes,
          1,
          MAX_GIT_DAILY_BYTES,
        ),
      },
      ...(gitDir ? { dir: gitDir } : {}),
      ...(gitKnownHosts ? { knownHosts: gitKnownHosts } : {}),
    },
  };
}

export function loadZqContract(path: string): ZqContract {
  return parseContract(JSON.parse(readFileSync(path, "utf8")));
}
