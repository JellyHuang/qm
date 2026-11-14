import { Cron } from "croner";
import { paused, type Duty, type ZqContract } from "./contract.ts";
import type { ZqGroups } from "./groups.ts";
import { reminderId, type ReminderMode, type ZqReminderStore } from "./reminders.ts";
import {
  DEFAULT_RULE_OPTIONS,
  evaluateRules,
  type FeatureFacts,
  type OpUserRef,
  type RuleOptions,
  type Target,
} from "./rules.ts";

export interface ScanPerson {
  mmUserId: string;
  principalId: string;
  opUserId?: string;
  opName: string;
}

export interface OpReader {
  features(person: ScanPerson): Promise<{ facts: FeatureFacts[]; problems: string[] }>;
  dutyHolders(person: ScanPerson, projectId: string, duty: Duty): Promise<OpUserRef[] | undefined>;
}

export interface ZqFeatureRef {
  id: number;
  subject: string;
  url?: string;
}

export interface ScanOptions {
  reader: OpReader;
  contract: ZqContract;
  people: readonly ScanPerson[];
  mmUserIdOfOpUser: (opUserId: string) => Promise<string | undefined>;
  reminders: ZqReminderStore;
  groups?: { store: ZqGroups; create: (feature: ZqFeatureRef, memberMmUserIds: string[]) => Promise<string> };
  opBaseUrl?: string;
  mode: ReminderMode;
  now: number;
  timezone: string;
  dailyCeiling: number;
  escalation: { duties: readonly Duty[]; afterDays: number };
  unsetDuties?: readonly Duty[];
}

export interface ScanReport {
  mode: ReminderMode;
  peopleScanned: number;
  peopleFailed: number;
  featuresSeen: number;
  created: number;
  alreadyKnown: number;
  ceilingHit: number;
  noHolder: number;
  unlinked: number;
  groupsCreated: number;
  unsetResponsibility: number;
  contractProblems: number;
  problemSamples: string[];
}

export function dayKeyIn(timezone: string, at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

export function scanIsDue(cron: string, timezone: string, lastRunAt: number | undefined, now: number): boolean {
  if (lastRunAt === undefined) return true;
  const next = new Cron(cron, { timezone, paused: true, mode: "5-part" }).nextRun(new Date(lastRunAt));
  return next !== null && next.getTime() <= now;
}

const DAY = 86_400_000;

export async function scanOnce(opts: ScanOptions): Promise<ScanReport> {
  const report: ScanReport = {
    mode: opts.mode,
    peopleScanned: 0,
    peopleFailed: 0,
    featuresSeen: 0,
    created: 0,
    alreadyKnown: 0,
    ceilingHit: 0,
    noHolder: 0,
    unlinked: 0,
    groupsCreated: 0,
    unsetResponsibility: 0,
    contractProblems: 0,
    problemSamples: [],
  };
  const dayKey = dayKeyIn(opts.timezone, opts.now);
  const ruleOptions: RuleOptions = {
    ...DEFAULT_RULE_OPTIONS,
    now: opts.now,
    escalateAfterMs: opts.escalation.afterDays * DAY,
    escalationDuties: opts.escalation.duties,
    unsetDuties: opts.unsetDuties ?? [],
  };
  const handled = new Set<number>();

  for (const person of opts.people) {
    let facts: FeatureFacts[];
    try {
      const read = await opts.reader.features(person);
      facts = read.facts;
      for (const problem of read.problems) {
        report.contractProblems++;
        if (report.problemSamples.length < 5 && !report.problemSamples.includes(problem))
          report.problemSamples.push(problem);
      }
    } catch {
      report.peopleFailed++;
      continue;
    }
    report.peopleScanned++;
    const holders = new Map<string, OpUserRef[] | undefined>();

    async function holdersOf(projectId: string | undefined, duty: Duty): Promise<OpUserRef[] | undefined> {
      if (!projectId) return undefined;
      const key = `${projectId}:${duty}`;
      if (!holders.has(key))
        holders.set(key, await opts.reader.dutyHolders(person, projectId, duty).catch(() => undefined));
      return holders.get(key);
    }

    async function usersOf(target: Target, fact: FeatureFacts): Promise<OpUserRef[]> {
      if (target.kind === "user") return [target.user];
      if (target.kind === "field") return fact.feature[target.field] ? [fact.feature[target.field]!] : [];
      const found = await holdersOf(fact.feature.projectId, target.duty);
      if (!found?.length) report.noHolder++;
      return found ?? [];
    }

    for (const fact of facts) {
      if (handled.has(fact.feature.id)) continue;
      handled.add(fact.feature.id);
      report.featuresSeen++;
      for (const action of evaluateRules(fact, opts.contract, ruleOptions)) {
        if (action.rule === "responsibility-not-set") report.unsetResponsibility++;
        const users = (await Promise.all(action.to.map((t) => usersOf(t, fact)))).flat();
        const recipients = new Set<string>();
        for (const u of users) {
          const mm = await opts.mmUserIdOfOpUser(u.id);
          if (mm) recipients.add(mm);
          else report.unlinked++;
        }
        for (const mm of recipients) {
          const id = reminderId(action.rule, action.subjectId, mm, dayKey);
          if (!(await opts.reminders.has(id)) && (await opts.reminders.countForDay(mm, dayKey)) >= opts.dailyCeiling) {
            report.ceilingHit++;
            continue;
          }
          const { created } = await opts.reminders.schedule(
            {
              id,
              rule: action.rule,
              subjectId: action.subjectId,
              subjectTitle: action.subjectTitle,
              recipientMmUserId: mm,
              text: action.text,
              dayKey,
              dueAt: opts.now,
            },
            opts.mode,
          );
          if (created) report.created++;
          else report.alreadyKnown++;
        }
      }
      if (
        opts.groups &&
        opts.mode === "live" &&
        (await ensureGroup(fact, opts.contract, opts.groups, opts.mmUserIdOfOpUser, opts.opBaseUrl))
      )
        report.groupsCreated++;
    }
  }
  return report;
}

async function ensureGroup(
  fact: FeatureFacts,
  contract: ZqContract,
  groups: NonNullable<ScanOptions["groups"]>,
  mmUserIdOfOpUser: ScanOptions["mmUserIdOfOpUser"],
  opBaseUrl: string | undefined,
): Promise<boolean> {
  const { feature, children } = fact;
  const live = children.filter((c) => !paused(c.lifecycle));
  if (feature.statusKey !== contract.stageRoles.briefing || !live.length || live.some((c) => !c.assignee)) return false;
  const people = [feature.responsiblePlanner, ...live.map((c) => c.assignee)].flatMap((u) => u ?? []);
  const members = (await Promise.all(people.map((u) => mmUserIdOfOpUser(u.id)))).flatMap((m) => m ?? []);
  if (!members.length) return false;
  const ref: ZqFeatureRef = {
    id: feature.id,
    subject: feature.subject,
    ...(opBaseUrl ? { url: `${opBaseUrl}/work_packages/${feature.id}` } : {}),
  };
  const { created } = await groups.store.ensure(feature.id, members, (list) => groups.create(ref, list));
  return created;
}
