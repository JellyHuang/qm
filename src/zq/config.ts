import { readFileSync } from "node:fs";
import { Cron } from "croner";
import { JENKINS_JOBS, type JenkinsCauseKind } from "./jenkins/client.ts";
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
  jenkins: {
    url?: string;
    credential?: { user: string; secret: string };
    poll: { enabled: boolean; intervalMs: number };
    rerun: boolean;
    notify: { live: boolean; channelId?: string };
    jobs: readonly string[];
    rerunJobs: readonly string[];
    hourlyCap: number;
    maxAgeMs: number;
    failureResults: readonly string[];
    causes: readonly JenkinsCauseKind[];
    botIds: readonly string[];
    dangerParams: readonly string[];
    dangerAckJobs: readonly string[];
    owners: Readonly<Record<string, string>>;
    defaultOwner?: string;
  };
}

const NOT_RERUN_BY_DEFAULT = ["Server-Run", "PackageSent"];
const DANGER_PARAMS = ["DROP_DATABASE", "TARGET_SERVER", "SOURCE"];
const FAILURE_RESULTS = ["FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT"] as const;
const CAUSE_KINDS = ["timer", "scm", "upstream", "user", "remote", "other"] as const;

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

function choices<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T[]): T[] {
  const list = names(raw);
  if (list.length === 0) return fallback;
  for (const item of list)
    if (!(allowed as readonly string[]).includes(item))
      throw new Error(`${name} must list ${allowed.join(", ")}: ${item}`);
  return list as T[];
}

function owners(raw: string | undefined): Record<string, string> {
  return Object.fromEntries(
    names(raw).map((pair) => {
      const [job, owner, ...extra] = pair.split("=").map((s) => s.trim());
      if (!job || !owner || extra.length > 0)
        throw new Error(`ZQ_JENKINS_OWNERS must look like Server-Build=alice: ${pair}`);
      return [job, owner];
    }),
  );
}

export function zqConfigFromEnv(
  env: NodeJS.ProcessEnv,
  surfaces: { mattermost: boolean } = { mattermost: true },
): ZqConfig {
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
  const jenkinsPoll = on(env.ZQ_JENKINS_POLL);
  const jenkinsNotify = on(env.ZQ_JENKINS_NOTIFY);
  const notifyChannel = env.ZQ_JENKINS_NOTIFY_CHANNEL?.trim();
  const botUser = env.JENKINS_QM_BOT_USER?.trim();
  const botSecret = env.JENKINS_QM_BOT_TOKEN?.trim() || env.JENKINS_QM_BOT_PASSWORD?.trim();
  if (jenkinsPoll && !jenkinsUrl) throw new Error("ZQ_JENKINS_POLL needs ZQ_JENKINS_URL");
  if (jenkinsPoll && !(botUser && botSecret))
    throw new Error("ZQ_JENKINS_POLL needs JENKINS_QM_BOT_USER and JENKINS_QM_BOT_TOKEN (or JENKINS_QM_BOT_PASSWORD)");
  if (jenkinsRerun && !jenkinsPoll) throw new Error("ZQ_JENKINS_RERUN needs ZQ_JENKINS_POLL");
  if (jenkinsNotify && !(jenkinsPoll && notifyChannel))
    throw new Error("ZQ_JENKINS_NOTIFY needs ZQ_JENKINS_POLL and ZQ_JENKINS_NOTIFY_CHANNEL");
  if (jenkinsNotify && !surfaces.mattermost)
    throw new Error(
      "ZQ_JENKINS_NOTIFY needs a Mattermost connection (MATTERMOST_URL, MATTERMOST_BOT_TOKEN and MATTERMOST_TEAM)",
    );
  const jenkinsJobs = jobNames("ZQ_JENKINS_JOBS", env.ZQ_JENKINS_JOBS, JENKINS_JOBS);
  const rerunJobs = jobNames(
    "ZQ_JENKINS_RERUN_JOBS",
    env.ZQ_JENKINS_RERUN_JOBS,
    jenkinsJobs.filter((job) => !NOT_RERUN_BY_DEFAULT.includes(job)),
  );
  const dangerAckJobs = jobNames("ZQ_JENKINS_DANGER_ACK_JOBS", env.ZQ_JENKINS_DANGER_ACK_JOBS, []);
  const unlisted = dangerAckJobs.filter((job) => !rerunJobs.includes(job));
  if (unlisted.length > 0)
    throw new Error(`ZQ_JENKINS_DANGER_ACK_JOBS names jobs outside ZQ_JENKINS_RERUN_JOBS: ${unlisted.join(", ")}`);
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
    jenkins: {
      ...(jenkinsUrl ? { url: jenkinsUrl } : {}),
      ...(botUser && botSecret ? { credential: { user: botUser, secret: botSecret } } : {}),
      poll: {
        enabled: jenkinsPoll,
        intervalMs: integer("ZQ_JENKINS_POLL_SECONDS", env.ZQ_JENKINS_POLL_SECONDS, 120, 30, 3600) * 1000,
      },
      rerun: jenkinsRerun,
      notify: { live: jenkinsNotify, ...(notifyChannel ? { channelId: notifyChannel } : {}) },
      jobs: jenkinsJobs,
      rerunJobs,
      hourlyCap: integer("ZQ_JENKINS_RERUN_HOURLY_CAP", env.ZQ_JENKINS_RERUN_HOURLY_CAP, 3, 1, 100),
      maxAgeMs: integer("ZQ_JENKINS_MAX_AGE_MINUTES", env.ZQ_JENKINS_MAX_AGE_MINUTES, 30, 1, 1440) * 60_000,
      failureResults: choices("ZQ_JENKINS_FAILURE_RESULTS", env.ZQ_JENKINS_FAILURE_RESULTS, FAILURE_RESULTS, [
        "FAILURE",
      ]),
      causes: choices("ZQ_JENKINS_RERUN_CAUSES", env.ZQ_JENKINS_RERUN_CAUSES, CAUSE_KINDS, [
        "timer",
        "scm",
        "upstream",
      ]),
      botIds: names(env.ZQ_JENKINS_BOT_IDS),
      dangerParams: names(env.ZQ_JENKINS_DANGER_PARAMS ?? DANGER_PARAMS.join(",")).map((n) => n.toUpperCase()),
      dangerAckJobs,
      owners: owners(env.ZQ_JENKINS_OWNERS),
      ...(env.ZQ_JENKINS_DEFAULT_OWNER?.trim() ? { defaultOwner: env.ZQ_JENKINS_DEFAULT_OWNER.trim() } : {}),
    },
  };
}

export function loadZqContract(path: string): ZqContract {
  return parseContract(JSON.parse(readFileSync(path, "utf8")));
}

export function zqStartupWarnings(config: ZqConfig, surfaces: { mattermost: boolean }): string[] {
  return config.jenkins.poll.enabled && !surfaces.mattermost
    ? [
        "[zq jenkins] ZQ_JENKINS_POLL=1 but no Mattermost connection is configured: the Jenkins poller is NOT running (no polling, no audit rows, no dry-run). Configure Mattermost or unset ZQ_JENKINS_POLL",
      ]
    : [];
}
