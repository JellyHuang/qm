import { readFileSync } from "node:fs";
import { Cron } from "croner";
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
  remarkPrincipal?: string;
  escalation: { duties: readonly Duty[]; afterDays: number };
  unsetResponsibilityDuties: readonly Duty[];
  reports: { enabled: boolean; dailyCron?: string; weeklyCron?: string };
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
  };
}

export function loadZqContract(path: string): ZqContract {
  return parseContract(JSON.parse(readFileSync(path, "utf8")));
}
