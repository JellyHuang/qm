import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { ZqConfig } from "./config.ts";
import type { FlushResult, ZqChangeLine, ZqChanges } from "./changes.ts";
import { deliverDue } from "./delivery.ts";
import { composeMorning } from "./morning.ts";
import { composeWeeklyBriefs } from "./weekly.ts";
import { DAILY_ASK, type ZqDaily } from "./daily.ts";
import type { ReminderMode, ZqReminderStore } from "./reminders.ts";
import {
  sectionForProject,
  type ReportInput,
  type ReportProject,
  type ReportScope,
  type ZqReportDraft,
  type ZqReports,
} from "./reports.ts";
import { projectsOfFacts } from "./report-source.ts";
import type { FeatureFacts, RuleId } from "./rules.ts";
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

interface ReportSource {
  build(
    person: ScanPerson,
    period: ReportInput["period"],
    since: number,
    until: number,
    scope?: ReportScope,
  ): Promise<ReportInput>;
}

export interface ZqServiceDeps {
  config: ZqConfig;
  reader: OpReader;
  contract?: ZqContract;
  mmUserIdOfOpUser: (opUserId: string) => Promise<string | undefined>;
  groups?: { store: ZqGroups; create: (feature: ZqFeatureRef, memberMmUserIds: string[]) => Promise<string> };
  changes?: {
    store: ZqChanges;
    channel: (channelId: string, text: string) => Promise<void>;
    lineLabel?: (line: ZqChangeLine) => Promise<string>;
  };
  people: () => Promise<ScanPerson[]>;
  daily?: ZqDaily;
  bindCards?: { tick(): Promise<number> };
  reminders: ZqReminderStore;
  state: DurableMap<ZqRunState>;
  send: (mmUserId: string, text: string, why?: string, target?: string) => Promise<void>;
  reports?: {
    store: ZqReports;
    source: ReportSource;
    sendCard: (mmUserId: string, draftId: string, text: string) => Promise<void>;
  };
  now?: () => number;
  sendRetryDelayMs?: number;
}

export interface ZqService {
  tick(): Promise<{
    scanned?: ScanReport;
    delivered?: { sent: number; failed: number };
    changes?: FlushResult;
    reportsSent: number;
    weeklyCardFailed: number;
    morningSent?: number;
    dailyAsked?: number;
    weeklyBriefsSent?: number;
    bindCardsSent?: number;
  }>;
}

const DAY = 86_400_000;
const MAX_SEND_TRIES = 3;

interface PersonScope {
  person: ScanPerson;
  facts: FeatureFacts[];
  projects: ReportProject[];
}

interface WeeklyOutcome {
  sent: number;
  failed: number;
}

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

  async function projectPms(projectId: string, scopes: PersonScope[]): Promise<string[]> {
    const fromFeatures = [
      ...new Set(scopes.flatMap((s) => s.projects.find((p) => p.id === projectId)?.pmOpUserIds ?? [])),
    ];
    const opUsers =
      fromFeatures.length > 0
        ? fromFeatures
        : ((
            await deps.reader
              .dutyHolders(scopes.find((s) => s.projects.some((p) => p.id === projectId))!.person, projectId, "pm")
              .catch(() => undefined)
          )?.map((u) => u.id) ?? []);
    const linked = await Promise.all(opUsers.map((id) => deps.mmUserIdOfOpUser(id)));
    return [...new Set(linked.flatMap((id) => id ?? []))];
  }

  async function deliver(
    reports: NonNullable<ZqServiceDeps["reports"]>,
    draft: ZqReportDraft,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const to of draft.addressees ?? []) {
      let tries = draft.sendFailures?.[to] ?? 0;
      if (draft.delivered?.includes(to)) continue;
      while (tries < MAX_SEND_TRIES) {
        try {
          await reports.sendCard(to, draft.id, draft.text);
          await reports.store.recordSend(draft.id, to, true);
          sent++;
          break;
        } catch (e) {
          tries++;
          await reports.store.recordSend(draft.id, to, false);
          if (tries >= MAX_SEND_TRIES) {
            failed++;
            reportFailureAs(`zq: weekly report card for ${to} on ${draft.id}`, undefined)(e);
          } else await sleep(deps.sendRetryDelayMs ?? 2000);
        }
      }
    }
    return { sent, failed };
  }

  async function weeklyProjects(reports: NonNullable<ZqServiceDeps["reports"]>, at: number): Promise<WeeklyOutcome> {
    const scopes: PersonScope[] = [];
    for (const person of await deps.people()) {
      try {
        const { facts } = await deps.reader.features(person);
        scopes.push({ person, facts, projects: projectsOfFacts(facts) });
      } catch (e) {
        reportFailureAs(`zq: weekly report for ${person.mmUserId}`, undefined)(e);
      }
    }
    const out: WeeklyOutcome = { sent: 0, failed: 0 };
    const addresseesOf = new Map<string, string[]>();
    for (const projectId of new Set(scopes.flatMap((s) => s.projects.map((p) => p.id)))) {
      try {
        const addressees = await projectPms(projectId, scopes);
        if (addressees.length > 0) addresseesOf.set(projectId, addressees);
      } catch (e) {
        reportFailureAs(`zq: weekly report project manager of ${projectId}`, undefined)(e);
      }
    }
    const inputs: ReportInput[] = [];
    for (const { person, facts, projects } of scopes) {
      const wanted = new Set(projects.map((p) => p.id).filter((id) => addresseesOf.has(id)));
      if (wanted.size === 0) continue;
      try {
        inputs.push(await reports.source.build(person, "weekly", at - 7 * DAY, at, { facts, projects: wanted }));
      } catch (e) {
        reportFailureAs(`zq: weekly report for ${person.mmUserId}`, undefined)(e);
      }
    }
    const weekKey = weekKeyOf(at);
    for (const [projectId, addressees] of addresseesOf) {
      try {
        const sections = inputs.flatMap((i) => sectionForProject(i, projectId) ?? []);
        const projectName = inputs.flatMap((i) => i.projects?.find((p) => p.id === projectId)?.name ?? [])[0];
        const { draft, created } = await reports.store.draftProject({
          projectId,
          ...(projectName ? { projectName } : {}),
          weekKey,
          since: at - 7 * DAY,
          until: at,
          sections,
          addressees,
        });
        if (!created) continue;
        const delivered = await deliver(reports, draft);
        out.sent += delivered.sent;
        out.failed += delivered.failed;
      } catch (e) {
        reportFailureAs(`zq: weekly report for project ${projectId}`, undefined)(e);
      }
    }
    return out;
  }

  async function resendPending(reports: NonNullable<ZqServiceDeps["reports"]>, at: number): Promise<WeeklyOutcome> {
    const out: WeeklyOutcome = { sent: 0, failed: 0 };
    for (const draft of await reports.store.openProjectDrafts(weekKeyOf(at))) {
      const delivered = await deliver(reports, draft);
      out.sent += delivered.sent;
      out.failed += delivered.failed;
    }
    return out;
  }

  async function morningTick(at: number): Promise<number> {
    const cron = config.morningCron;
    if (!cron || !deps.contract || !config.deliverReminders) return 0;
    if (!(await claim("morning", cron, at, false))) return 0;
    let sent = 0;
    for (const person of await deps.people()) {
      if (!person.opUserId) continue;
      try {
        const { facts } = await deps.reader.features(person);
        const text = composeMorning(person.opUserId, facts, deps.contract);
        if (!text) continue;
        await deps.send(person.mmUserId, text, "morning-plan");
        sent++;
      } catch (e) {
        reportFailureAs(`zq: morning message for ${person.mmUserId}`, undefined)(e);
      }
    }
    return sent;
  }

  async function dailyAskTick(at: number): Promise<number> {
    const cron = config.dailyAskCron;
    if (!cron || !deps.daily || !config.deliverReminders) return 0;
    if (!(await claim("daily-ask", cron, at, false))) return 0;
    const day = dayKeyIn(config.scanner.timezone, at);
    let asked = 0;
    for (const person of await deps.people()) {
      try {
        if (!(await deps.daily.ask(person.mmUserId, day))) continue;
        await deps.send(person.mmUserId, DAILY_ASK, "daily-ask");
        asked++;
      } catch (e) {
        reportFailureAs(`zq: daily question for ${person.mmUserId}`, undefined)(e);
      }
    }
    return asked;
  }

  async function weeklyBriefTick(at: number): Promise<number> {
    const cron = config.weeklyBriefCron;
    if (!cron || !deps.contract || !config.deliverReminders) return 0;
    if (!(await claim("weekly-brief", cron, at, false))) return 0;
    const facts = new Map<number, FeatureFacts>();
    for (const person of await deps.people()) {
      try {
        for (const f of (await deps.reader.features(person)).facts) facts.set(f.feature.id, f);
      } catch (e) {
        reportFailureAs(`zq: weekly brief read for ${person.mmUserId}`, undefined)(e);
      }
    }
    let sent = 0;
    for (const brief of composeWeeklyBriefs({
      facts: [...facts.values()],
      contract: deps.contract,
      now: at,
      timezone: config.scanner.timezone,
    })) {
      try {
        const to = await deps.mmUserIdOfOpUser(brief.leadOpUserId);
        if (!to) continue;
        await deps.send(to, brief.text, "weekly-brief");
        sent++;
      } catch (e) {
        reportFailureAs(`zq: weekly brief for ${brief.leadName}`, undefined)(e);
      }
    }
    return sent;
  }

  async function reportsTick(at: number): Promise<WeeklyOutcome> {
    const reports = deps.reports;
    const out: WeeklyOutcome = { sent: 0, failed: 0 };
    if (!config.reports.enabled || !reports) return out;
    for (const [period, cron] of [
      ["daily", config.reports.dailyCron],
      ["weekly", config.reports.weeklyCron],
    ] as const) {
      if (!cron) continue;
      if (!(await claim(`report:${period}`, cron, at, false))) {
        if (period === "weekly") {
          try {
            const rechecked = await resendPending(reports, at);
            out.sent += rechecked.sent;
            out.failed += rechecked.failed;
          } catch (e) {
            reportFailureAs("zq: weekly report card retry", undefined)(e);
          }
        }
        continue;
      }
      if (period === "weekly") {
        const weekly = await weeklyProjects(reports, at);
        out.sent += weekly.sent;
        out.failed += weekly.failed;
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
      const out: Awaited<ReturnType<ZqService["tick"]>> = { reportsSent: 0, weeklyCardFailed: 0 };
      if (config.scanner.enabled && deps.contract) {
        if (await claim("scanner", config.scanner.cron, at, true)) {
          const mode: ReminderMode = config.deliverReminders ? "live" : "dry-run";
          const announcing: Array<{ rule: RuleId; marker: string }> = [
            ...(deps.contract.stageRoles.bugVerified
              ? [{ rule: "bug-verified-notice" as const, marker: "bug-verified-baseline" }]
              : []),
            ...(deps.contract.stageRoles.qaTesting
              ? [{ rule: "qa-stage-entered" as const, marker: "qa-stage-baseline" }]
              : []),
          ];
          const pending: typeof announcing = [];
          for (const a of announcing) if ((await deps.state.get(a.marker)) === null) pending.push(a);
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
            ...(pending.length ? { baseline: pending.map((a) => a.rule) } : {}),
          });
          for (const a of pending) await deps.state.put(a.marker, { lastRunAt: at });
          await deps.state.merge("scanner", { lastReport: out.scanned });
        }
        if (config.deliverReminders)
          out.delivered = await deliverDue({
            reminders: deps.reminders,
            send: (to, text, rule) => deps.send(to, text, rule),
            now: at,
          });
        if (config.deliverReminders && deps.changes)
          out.changes = await deps.changes.store.flush(deps.groups?.store, {
            channel: deps.changes.channel,
            dm: (to, text) => deps.send(to, text, "change-digest"),
            ...(deps.changes.lineLabel ? { lineLabel: deps.changes.lineLabel } : {}),
          });
      }
      if (config.morningCron) out.morningSent = await morningTick(at);
      if (config.dailyAskCron) out.dailyAsked = await dailyAskTick(at);
      if (config.weeklyBriefCron) out.weeklyBriefsSent = await weeklyBriefTick(at);
      if (deps.bindCards) out.bindCardsSent = await deps.bindCards.tick();
      const reported = await reportsTick(at);
      out.reportsSent = reported.sent;
      out.weeklyCardFailed = reported.failed;
      return out;
    },
  };
}
