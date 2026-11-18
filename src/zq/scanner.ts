import { Cron } from "croner";
import { paused, type Duty, type ZqContract } from "./contract.ts";
import type { FeedEvent, ZqChanges } from "./changes.ts";
import type { ZqGroups } from "./groups.ts";
import { reminderId, type ReminderMode, type ZqReminderStore } from "./reminders.ts";
import {
  DEFAULT_RULE_OPTIONS,
  evaluateRules,
  peopleOn,
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
  changes?(
    person: ScanPerson,
    projectId: string,
    cursor: string | null,
  ): Promise<{ events: FeedEvent[]; nextCursor: string }>;
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
  groups?: {
    store: ZqGroups;
    create: (feature: ZqFeatureRef, memberMmUserIds: string[]) => Promise<string>;
    remark?: (input: { featureId: number; channelId: string; participantOpUserIds: string[] }) => Promise<void>;
  };
  changes?: ZqChanges;
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
  remarkFailed: number;
  changesRecorded: number;
  changeResync: number;
  unsetResponsibility: number;
  contractProblems: number;
  problemSamples: string[];
}

function targetKey(t: Target): string {
  if (t.kind === "user") return "user";
  return t.kind === "duty" ? `duty:${t.duty}` : `field:${t.field}`;
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
    remarkFailed: 0,
    changesRecorded: 0,
    changeResync: 0,
    unsetResponsibility: 0,
    contractProblems: 0,
    problemSamples: [],
  };
  const dayKey = dayKeyIn(opts.timezone, opts.now);
  const ruleOptions: RuleOptions = {
    ...DEFAULT_RULE_OPTIONS,
    now: opts.now,
    day: (at) => dayKeyIn(opts.timezone, at),
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
    const feed = opts.changes && opts.mode === "live" && opts.reader.changes ? opts.changes : undefined;
    if (feed) await readFeed(person, facts, feed, opts, report);
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
      if (target.kind === "field") return peopleOn(fact.feature, target.field);
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
        const recipients = new Map<string, string>();
        for (const target of action.to) {
          for (const u of await usersOf(target, fact)) {
            const mm = await opts.mmUserIdOfOpUser(u.id);
            if (!mm) report.unlinked++;
            else if (!recipients.has(mm)) recipients.set(mm, targetKey(target));
          }
        }
        for (const [mm, target] of recipients) {
          const id = reminderId(action.rule, action.subjectId, mm, action.once ? "once" : dayKey);
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
              target,
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
      if (opts.changes && opts.mode === "live" && !opts.reader.changes) {
        const pm = fact.feature.pm ? await opts.mmUserIdOfOpUser(fact.feature.pm.id) : undefined;
        report.changesRecorded += await opts.changes.record(fact, opts.contract, {
          day: (at) => dayKeyIn(opts.timezone, at),
          link: (id) => (opts.opBaseUrl ? `${opts.opBaseUrl}/work_packages/${id}` : `#${id}`),
          ...(pm ? { fallbackMmUserId: pm } : {}),
        });
      }
      if (
        opts.groups &&
        opts.mode === "live" &&
        (await ensureGroup(fact, opts.contract, opts.groups, opts.mmUserIdOfOpUser, opts.opBaseUrl))
      )
        report.groupsCreated++;
      if (opts.groups?.remark && opts.mode === "live") await settleRemark(fact.feature.id, opts.groups, report);
    }
  }
  return report;
}

async function readFeed(
  person: ScanPerson,
  facts: readonly FeatureFacts[],
  store: ZqChanges,
  opts: ScanOptions,
  report: ScanReport,
): Promise<void> {
  const projects = [...new Set(facts.flatMap((f) => f.feature.projectId ?? []))];
  const pmOf = new Map<number, string | undefined>();
  for (const fact of facts)
    pmOf.set(fact.feature.id, fact.feature.pm ? await opts.mmUserIdOfOpUser(fact.feature.pm.id) : undefined);
  for (const projectId of projects) {
    const key = `${projectId}:${person.principalId}`;
    const known = await store.cursor(key);
    let read: { events: FeedEvent[]; nextCursor: string };
    try {
      read = await opts.reader.changes!(person, projectId, known ?? null);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code !== "cursor_invalid" && code !== "cursor_scope_changed") throw e;
      report.changeResync++;
      read = await opts.reader.changes!(person, projectId, null);
      read.events = [];
    }
    if (known !== undefined)
      report.changesRecorded += await store.ingest(read.events, opts.contract, {
        facts: facts.filter((f) => f.feature.projectId === projectId),
        day: (at) => dayKeyIn(opts.timezone, at),
        link: (id) => (opts.opBaseUrl ? `${opts.opBaseUrl}/work_packages/${id}` : `#${id}`),
        fallbackMmUserIdOf: (featureId) => pmOf.get(featureId),
      });
    await store.saveCursor(key, read.nextCursor);
  }
}

async function settleRemark(
  featureId: number,
  groups: NonNullable<ScanOptions["groups"]>,
  report: ScanReport,
): Promise<void> {
  const group = await groups.store.get(featureId);
  if (!group?.groupRef || group.remarkWritten) return;
  try {
    await groups.remark!({
      featureId,
      channelId: group.groupRef,
      participantOpUserIds: group.participantOpUserIds,
    });
    await groups.store.markRemarkWritten(featureId);
  } catch {
    report.remarkFailed++;
  }
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
  const people = [
    ...peopleOn(feature, "responsiblePlanner"),
    ...peopleOn(feature, "reviewer"),
    ...(feature.participants ?? []),
  ];
  const members = (await Promise.all(people.map((u) => mmUserIdOfOpUser(u.id)))).flatMap((m) => m ?? []);
  if (!members.length) return false;
  const ref: ZqFeatureRef = {
    id: feature.id,
    subject: feature.subject,
    ...(opBaseUrl ? { url: `${opBaseUrl}/work_packages/${feature.id}` } : {}),
  };
  const { created } = await groups.store.ensure(
    feature.id,
    members,
    (list) => groups.create(ref, list),
    people.map((u) => u.id),
  );
  return created;
}
