import { Cron } from "croner";
import {
  DEFAULT_FOLLOW_UP_POLICY,
  evaluateFollowUp,
  evaluateMeetingFollowUp,
  pendingExitFields,
  type FollowUpPolicy,
  type MeetingState,
  type WorkPackageState,
} from "./follow-up-rules.ts";
import type { ReminderMode, ZqReminderDraft, ZqReminderStore } from "./reminders.ts";

export interface ScanPerson {
  mmUserId: string;
  principalId: string;
  opUserId?: string;
  opName: string;
}

export interface ScannedWorkPackage extends WorkPackageState {
  subject: string;
  fields: Record<string, string | undefined>;
}

export interface OpReader {
  workPackages(person: ScanPerson): Promise<ScannedWorkPackage[]>;
  meetings(person: ScanPerson): Promise<MeetingState[]>;
}

export interface ScanOptions {
  reader: OpReader;
  people: readonly ScanPerson[];
  reminders: ZqReminderStore;
  mode: ReminderMode;
  now: number;
  timezone: string;
  dailyCap: number;
  policy?: FollowUpPolicy;
}

export interface ScanReport {
  mode: ReminderMode;
  peopleScanned: number;
  peopleFailed: number;
  workPackagesSeen: number;
  meetingsSeen: number;
  created: number;
  alreadyKnown: number;
  cappedOut: number;
  unassigned: number;
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

function isAssignee(wp: ScannedWorkPackage, person: ScanPerson): boolean {
  if (wp.assigneeOpUserId && person.opUserId) return wp.assigneeOpUserId === person.opUserId;
  return Boolean(wp.assigneeName) && wp.assigneeName?.trim().toLowerCase() === person.opName.trim().toLowerCase();
}

function isPlanner(meeting: MeetingState, person: ScanPerson): boolean {
  if (meeting.plannerOpUserId && person.opUserId) return meeting.plannerOpUserId === person.opUserId;
  return (
    Boolean(meeting.plannerName) && meeting.plannerName?.trim().toLowerCase() === person.opName.trim().toLowerCase()
  );
}

export async function scanOnce(opts: ScanOptions): Promise<ScanReport> {
  const report: ScanReport = {
    mode: opts.mode,
    peopleScanned: 0,
    peopleFailed: 0,
    workPackagesSeen: 0,
    meetingsSeen: 0,
    created: 0,
    alreadyKnown: 0,
    cappedOut: 0,
    unassigned: 0,
  };
  const dayKey = dayKeyIn(opts.timezone, opts.now);
  const policy = opts.policy ?? DEFAULT_FOLLOW_UP_POLICY;
  const handledSubjects = new Set<string>();

  async function offer(draft: Omit<ZqReminderDraft, "dayKey" | "dueAt">): Promise<void> {
    const { created } = await opts.reminders.schedule({ ...draft, dayKey, dueAt: opts.now }, opts.mode);
    if (created) report.created++;
    else report.alreadyKnown++;
  }

  async function admitted(id: string, mmUserId: string): Promise<boolean> {
    if (await opts.reminders.has(id)) return true;
    if ((await opts.reminders.countForDay(mmUserId, dayKey)) < opts.dailyCap) return true;
    report.cappedOut++;
    return false;
  }

  for (const person of opts.people) {
    let workPackages: ScannedWorkPackage[];
    let meetings: MeetingState[];
    try {
      [workPackages, meetings] = await Promise.all([opts.reader.workPackages(person), opts.reader.meetings(person)]);
    } catch {
      report.peopleFailed++;
      continue;
    }
    report.peopleScanned++;

    for (const wp of workPackages) {
      const subjectId = `wp:${wp.id}`;
      if (handledSubjects.has(subjectId) || !isAssignee(wp, person)) continue;
      handledSubjects.add(subjectId);
      report.workPackagesSeen++;
      const lastFollowUpAt = await opts.reminders.lastLiveAt(subjectId);
      const actions = evaluateFollowUp(
        { ...wp, ...(lastFollowUpAt !== undefined ? { lastFollowUpAt } : {}) },
        opts.now,
        policy,
      );
      for (const action of actions) {
        if (!(await admitted(action.dedupeKey, person.mmUserId))) continue;
        await offer({
          id: action.dedupeKey,
          kind: action.kind,
          subjectId,
          subjectTitle: wp.subject,
          recipientMmUserId: person.mmUserId,
          reason: action.reason,
          blockers: pendingExitFields(wp.status, wp.fields),
        });
      }
    }

    for (const meeting of meetings) {
      const subjectId = `meeting:${meeting.id}`;
      if (handledSubjects.has(subjectId)) continue;
      if (!isPlanner(meeting, person)) {
        if (meeting.plannerName || meeting.plannerOpUserId) continue;
        report.unassigned++;
        continue;
      }
      handledSubjects.add(subjectId);
      report.meetingsSeen++;
      const action = evaluateMeetingFollowUp(meeting, opts.now);
      if (!action) continue;
      if (!(await admitted(action.dedupeKey, person.mmUserId))) continue;
      await offer({
        id: action.dedupeKey,
        kind: action.kind,
        subjectId,
        subjectTitle: meeting.title,
        recipientMmUserId: person.mmUserId,
        reason: action.reason,
        blockers: [],
      });
    }
  }
  return report;
}
