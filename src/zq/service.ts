import type { DurableMap } from "../persistence/durable-map.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { ZqConfig } from "./config.ts";
import type { FlushResult, ZqChanges } from "./changes.ts";
import { deliverDue } from "./delivery.ts";
import type { ReminderMode, ZqReminderStore } from "./reminders.ts";
import { sectionForProject, type ReportInput, type ZqReports } from "./reports.ts";
import type { ZqContract } from "./contract.ts";
import type { ZqGroups } from "./groups.ts";
import {
  dayKeyIn,
  scanIsDue,
  scanOnce,
  type OpReader,
  type ScanPerson,
  type ScanReport,
  type ZqFeatureRef,
} from "./scanner.ts";

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
  groups?: { store: ZqGroups; create: (feature: ZqFeatureRef, memberMmUserIds: string[]) => Promise<string> };
  changes?: { store: ZqChanges; channel: (channelId: string, text: string) => Promise<void> };
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
  tick(): Promise<{
    scanned?: ScanReport;
    delivered?: { sent: number; failed: number };
    changes?: FlushResult;
    reportsSent: number;
    weeklyNoPm: number;
  }>;
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

  function weekKeyOf(at: number): string {
    const [y, m, d] = dayKeyIn(config.scanner.timezone, at).split("-").map(Number);
    const local = Date.UTC(y!, m! - 1, d!);
    const sinceMonday = (new Date(local).getUTCDay() + 6) % 7;
    return new Date(local - sinceMonday * DAY).toISOString().slice(0, 10);
  }

  async function projectPms(projectId: string, inputs: ReportInput[], people: ScanPerson[]): Promise<string[]> {
    const fromFeatures = [
      ...new Set(inputs.flatMap((i) => i.projects?.find((p) => p.id === projectId)?.pmOpUserIds ?? [])),
    ];
    const opUsers =
      fromFeatures.length > 0
        ? fromFeatures
        : ((await deps.reader.dutyHolders(people[0]!, projectId, "pm").catch(() => undefined)) ?? []).map((u) => u.id);
    const linked = await Promise.all(opUsers.map((id) => deps.mmUserIdOfOpUser(id)));
    return [...new Set(linked.flatMap((id) => id ?? []))];
  }

  async function weeklyProjects(
    reports: NonNullable<ZqServiceDeps["reports"]>,
    at: number,
  ): Promise<{ sent: number; noPm: number }> {
    const people = await deps.people();
    const inputs: ReportInput[] = [];
    for (const person of people) {
      try {
        inputs.push(await reports.source.build(person, "weekly", at - 7 * DAY, at));
      } catch (e) {
        reportFailureAs(`zq: weekly report for ${person.mmUserId}`, undefined)(e);
      }
    }
    const projectIds = [...new Set(inputs.flatMap((i) => (i.projects ?? []).map((p) => p.id)))];
    const weekKey = weekKeyOf(at);
    let sent = 0;
    let noPm = 0;
    for (const projectId of projectIds) {
      try {
        const sections = inputs.flatMap((i) => sectionForProject(i, projectId) ?? []);
        const addressees = await projectPms(projectId, sections, people);
        const { draft, created } = await reports.store.draftProject({
          projectId,
          weekKey,
          since: at - 7 * DAY,
          until: at,
          sections,
          addressees,
        });
        if (!created) continue;
        if (draft.status === "skipped") noPm++;
        else
          for (const to of addressees) {
            await reports.sendCard(to, draft.id, draft.text);
            sent++;
          }
      } catch (e) {
        reportFailureAs(`zq: weekly report for project ${projectId}`, undefined)(e);
      }
    }
    return { sent, noPm };
  }

  async function reportsTick(at: number): Promise<{ sent: number; noPm: number }> {
    const reports = deps.reports;
    const out = { sent: 0, noPm: 0 };
    if (!config.reports.enabled || !reports) return out;
    for (const [period, cron] of [
      ["daily", config.reports.dailyCron],
      ["weekly", config.reports.weeklyCron],
    ] as const) {
      if (!cron) continue;
      if (!(await claim(`report:${period}`, cron, at, false))) continue;
      if (period === "weekly") {
        const weekly = await weeklyProjects(reports, at);
        out.sent += weekly.sent;
        out.noPm += weekly.noPm;
        continue;
      }
      for (const person of await deps.people()) {
        try {
          const input = await reports.source.build(person, period, at - DAY, at);
          const draft = await reports.store.draft(input);
          await reports.sendCard(person.mmUserId, draft.id, draft.text);
          out.sent++;
        } catch (e) {
          reportFailureAs(`zq: ${period} report for ${person.mmUserId}`, undefined)(e);
        }
      }
    }
    return out;
  }

  return {
    async tick() {
      const at = now();
      const out: Awaited<ReturnType<ZqService["tick"]>> = { reportsSent: 0, weeklyNoPm: 0 };
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
            ...(deps.changes ? { changes: deps.changes.store } : {}),
            ...(config.opBaseUrl ? { opBaseUrl: config.opBaseUrl } : {}),
            mode,
            now: at,
            timezone: config.scanner.timezone,
            dailyCeiling: config.reminderDailyCeiling,
            escalation: config.escalation,
            unsetDuties: config.unsetResponsibilityDuties,
          });
          await deps.state.merge("scanner", { lastReport: out.scanned });
        }
        if (config.deliverReminders)
          out.delivered = await deliverDue({ reminders: deps.reminders, send: deps.send, now: at });
        if (config.deliverReminders && deps.changes)
          out.changes = await deps.changes.store.flush(deps.groups?.store, {
            channel: deps.changes.channel,
            dm: deps.send,
          });
      }
      const reported = await reportsTick(at);
      out.reportsSent = reported.sent;
      out.weeklyNoPm = reported.noPm;
      return out;
    },
  };
}
