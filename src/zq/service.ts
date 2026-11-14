import type { DurableMap } from "../persistence/durable-map.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { ZqConfig } from "./config.ts";
import { deliverDue } from "./delivery.ts";
import type { ReminderMode, ZqReminderStore } from "./reminders.ts";
import type { ReportInput, ZqReports } from "./reports.ts";
import type { ZqContract } from "./contract.ts";
import type { ZqGroups } from "./groups.ts";
import { scanIsDue, scanOnce, type OpReader, type ScanPerson, type ScanReport } from "./scanner.ts";

export interface ZqRunState {
  lastRunAt: number;
  lastReport?: ScanReport;
}

export interface ReportSource {
  build(person: ScanPerson, period: ReportInput["period"], since: number, until: number): Promise<ReportInput>;
}

export interface ZqServiceDeps {
  config: ZqConfig;
  reader: OpReader;
  contract?: ZqContract;
  mmUserIdOfOpUser: (opUserId: string) => Promise<string | undefined>;
  groups?: { store: ZqGroups; create: (name: string, memberMmUserIds: string[]) => Promise<string> };
  people: () => Promise<ScanPerson[]>;
  reminders: ZqReminderStore;
  state: DurableMap<ZqRunState>;
  send: (mmUserId: string, text: string) => Promise<void>;
  reports?: {
    store: ZqReports;
    source: ReportSource;
    sendCard: (mmUserId: string, draftId: string, text: string) => Promise<void>;
  };
  now?: () => number;
}

export interface ZqService {
  tick(): Promise<{ scanned?: ScanReport; delivered?: { sent: number; failed: number }; reportsSent: number }>;
}

const DAY = 86_400_000;

export function createZqService(deps: ZqServiceDeps): ZqService {
  const now = deps.now ?? (() => Date.now());
  const { config } = deps;

  async function claim(key: string, cron: string, at: number, runOnFirst: boolean): Promise<boolean> {
    const previous = await deps.state.get(key);
    const due = previous ? scanIsDue(cron, config.scanner.timezone, previous.lastRunAt, at) : runOnFirst;
    if (previous && !due) return false;
    await deps.state.put(key, { ...previous, lastRunAt: at });
    return due;
  }

  async function reportsTick(at: number): Promise<number> {
    const reports = deps.reports;
    if (!config.reports.enabled || !reports) return 0;
    let sent = 0;
    for (const [period, cron, span] of [
      ["daily", config.reports.dailyCron, DAY],
      ["weekly", config.reports.weeklyCron, 7 * DAY],
    ] as const) {
      if (!cron) continue;
      if (!(await claim(`report:${period}`, cron, at, false))) continue;
      for (const person of await deps.people()) {
        try {
          const input = await reports.source.build(person, period, at - span, at);
          const draft = await reports.store.draft(input);
          await reports.sendCard(person.mmUserId, draft.id, draft.text);
          sent++;
        } catch (e) {
          reportFailureAs(`zq: ${period} report for ${person.mmUserId}`, undefined)(e);
        }
      }
    }
    return sent;
  }

  return {
    async tick() {
      const at = now();
      const out: Awaited<ReturnType<ZqService["tick"]>> = { reportsSent: 0 };
      if (config.scanner.enabled && deps.contract) {
        if (await claim("scanner", config.scanner.cron, at, true)) {
          const mode: ReminderMode = config.deliverReminders ? "live" : "dry-run";
          out.scanned = await scanOnce({
            reader: deps.reader,
            contract: deps.contract,
            people: await deps.people(),
            mmUserIdOfOpUser: deps.mmUserIdOfOpUser,
            reminders: deps.reminders,
            ...(deps.groups ? { groups: deps.groups } : {}),
            mode,
            now: at,
            timezone: config.scanner.timezone,
            dailyCeiling: config.reminderDailyCeiling,
            escalation: config.escalation,
          });
          await deps.state.merge("scanner", { lastReport: out.scanned });
        }
        if (config.deliverReminders)
          out.delivered = await deliverDue({ reminders: deps.reminders, send: deps.send, now: at });
      }
      out.reportsSent = await reportsTick(at);
      return out;
    },
  };
}
