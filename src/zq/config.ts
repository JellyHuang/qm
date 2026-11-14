import { Cron } from "croner";

export interface ZqConfig {
  identityMap: boolean;
  scanner: { enabled: boolean; cron: string; timezone: string };
  deliverReminders: boolean;
  reminderDailyCap: number;
  reports: { enabled: boolean; dailyCron: string; weeklyCron: string };
}

const DEFAULT_CRON = "*/5 * * * *";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_DAILY_CAP = 3;
const DEFAULT_REPORT_DAILY_CRON = "30 18 * * 1-5";
const DEFAULT_REPORT_WEEKLY_CRON = "0 17 * * 5";

const on = (value: string | undefined) => value?.trim() === "1";

export function zqConfigFromEnv(env: NodeJS.ProcessEnv): ZqConfig {
  const cron = env.ZQ_SCANNER_CRON?.trim() || DEFAULT_CRON;
  const timezone = env.ZQ_SCANNER_TZ?.trim() || DEFAULT_TIMEZONE;
  const dailyCron = env.ZQ_REPORT_DAILY_CRON?.trim() || DEFAULT_REPORT_DAILY_CRON;
  const weeklyCron = env.ZQ_REPORT_WEEKLY_CRON?.trim() || DEFAULT_REPORT_WEEKLY_CRON;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`ZQ_SCANNER_TZ is not an IANA timezone: ${timezone}`);
  }
  for (const [name, expression] of [
    ["ZQ_SCANNER_CRON", cron],
    ["ZQ_REPORT_DAILY_CRON", dailyCron],
    ["ZQ_REPORT_WEEKLY_CRON", weeklyCron],
  ] as const) {
    try {
      new Cron(expression, { timezone, paused: true, mode: "5-part" });
    } catch (e) {
      throw new Error(`${name} or ZQ_SCANNER_TZ is invalid`, { cause: e });
    }
  }
  const cap = Number(env.ZQ_REMINDER_DAILY_CAP?.trim() || DEFAULT_DAILY_CAP);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 50)
    throw new Error("ZQ_REMINDER_DAILY_CAP must be an integer from 1 through 50");
  return {
    identityMap: on(env.ZQ_IDENTITY_MAP),
    scanner: { enabled: on(env.ZQ_SCANNER), cron, timezone },
    deliverReminders: on(env.ZQ_REMINDER_DELIVERY),
    reminderDailyCap: cap,
    reports: { enabled: on(env.ZQ_REPORTS), dailyCron, weeklyCron },
  };
}
