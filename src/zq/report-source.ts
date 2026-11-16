import type { FeedEvent } from "./changes.ts";
import type { ZqContract } from "./contract.ts";
import { hours, isObject, parsePage, str, type OpCall } from "./op-reader.ts";
import type { ReportInput, ReportStatusChange, ReportTimeEntry } from "./reports.ts";
import { dayKeyIn, type OpReader, type ScanPerson } from "./scanner.ts";

const DAY = 86_400_000;
const PAGE_LIMIT = 100;
const PAGE_CAP = 1000;
const UNKNOWN_SUBJECT = "(标题未知)";

function userIdOf(value: unknown): string | undefined {
  return isObject(value) ? str(value["id"]) : str(value);
}

function stageOf(side: Record<string, unknown>): string | undefined {
  return str(side["stage"]) ?? str(side["stage_key"]);
}

export function createReportSource(opts: {
  reader: OpReader;
  call: OpCall;
  contract: ZqContract;
  timezone: string;
  serverId?: string;
}): (person: ScanPerson, period: ReportInput["period"], since: number, until: number) => Promise<ReportInput> {
  const { contract } = opts;
  const tool = (name: string) => `${opts.serverId ?? "openproject"}_${name}`;
  const label = (key: string | undefined) =>
    key === undefined ? undefined : (contract.stages.feature[key] ?? contract.stages.task[key] ?? key);

  async function timeEntries(
    person: ScanPerson,
    since: number,
    until: number,
    subjects: ReadonlyMap<number, string>,
    projectOf: ReadonlyMap<number, string>,
  ): Promise<ReportTimeEntry[]> {
    const spent = new Map<number, { hours: number; comments: string[] }>();
    let offset = 1;
    for (let page = 0; page < PAGE_CAP; page++) {
      const read = parsePage(
        await opts.call(
          tool("list_time_entries"),
          {
            user: person.opUserId,
            spent_on_from: dayKeyIn(opts.timezone, since + DAY),
            spent_on_to: dayKeyIn(opts.timezone, until),
            offset,
            limit: PAGE_LIMIT,
          },
          person.principalId,
        ),
      );
      for (const row of read.results) {
        const id = Number(
          row["work_package_id"] ?? (isObject(row["work_package"]) ? row["work_package"]["id"] : undefined),
        );
        const logged = hours(row["hours"]);
        if (!Number.isSafeInteger(id) || logged === undefined || logged <= 0) continue;
        const entry = spent.get(id) ?? { hours: 0, comments: [] };
        entry.hours += logged;
        const comment = str(row["comment"]);
        if (comment && !entry.comments.includes(comment)) entry.comments.push(comment);
        spent.set(id, entry);
      }
      if (read.nextOffset === null || read.nextOffset <= offset) break;
      offset = read.nextOffset;
    }
    return [...spent].map(([id, entry]) => ({
      workPackageId: id,
      subject: subjects.get(id) ?? UNKNOWN_SUBJECT,
      hours: Math.round(entry.hours * 100) / 100,
      ...(entry.comments.length ? { comment: entry.comments.join("; ") } : {}),
      ...(projectOf.has(id) ? { projectId: projectOf.get(id)! } : {}),
    }));
  }

  return async (person, period, since, until) => {
    const { facts } = await opts.reader.features(person);
    const views = facts.flatMap((f) => [f.feature, ...f.children, ...(f.bugs ?? [])]);
    const subjects = new Map(views.map((w) => [w.id, w.subject]));
    const projectOf = new Map(views.flatMap((w) => (w.projectId ? [[w.id, w.projectId] as const] : [])));
    const nameOf = new Map(
      views.flatMap((w) => (w.projectId && w.projectName ? [[w.projectId, w.projectName] as const] : [])),
    );
    const bugIds = new Set(facts.flatMap((f) => (f.bugs ?? []).map((b) => b.id)));
    const bugStages = new Set(Object.keys(contract.stages.bug));
    const me = person.opUserId;

    const concerns = (e: FeedEvent) =>
      e.actorId === me || userIdOf(e.new["assignee"]) === me || userIdOf(e.old["assignee"]) === me;
    const isBug = (e: FeedEvent) =>
      bugIds.has(e.ticketId) ||
      [e.oldStage, e.newStage, stageOf(e.old), stageOf(e.new)].some((s) => s !== undefined && bugStages.has(s));

    const projectIds = [...new Set(views.flatMap((w) => (w.projectId ? [w.projectId] : [])))];
    const statusChanges: ReportStatusChange[] = [];
    if (me && opts.reader.changes) {
      for (const project of projectIds) {
        const { events } = await opts.reader.changes(person, project, null);
        for (const e of events) {
          if (e.at < since || e.at > until || !e.kinds.includes("stage") || isBug(e) || !concerns(e)) continue;
          const to = label(e.newStage ?? stageOf(e.new));
          if (!to) continue;
          const from = label(e.oldStage ?? stageOf(e.old));
          statusChanges.push({
            workPackageId: e.ticketId,
            subject: subjects.get(e.ticketId) ?? UNKNOWN_SUBJECT,
            ...(from ? { from } : {}),
            to,
            at: e.at,
            projectId: project,
          });
        }
      }
      statusChanges.sort((a, b) => a.at - b.at);
    }

    const reportProjects = projectIds.map((id) => ({
      id,
      ...(nameOf.has(id) ? { name: nameOf.get(id)! } : {}),
      pmOpUserIds: [
        ...new Set(facts.flatMap((f) => (f.feature.projectId === id && f.feature.pm ? [f.feature.pm.id] : []))),
      ],
    }));

    return {
      mmUserId: person.mmUserId,
      opName: person.opName,
      period,
      since,
      until,
      statusChanges,
      timeEntries: me ? await timeEntries(person, since, until, subjects, projectOf) : [],
      projects: reportProjects,
    };
  };
}
