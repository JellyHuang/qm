import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { FeatureFacts } from "./rules.ts";

export interface ReportStatusChange {
  workPackageId: number;
  subject: string;
  from?: string;
  to: string;
  at: number;
  projectId?: string;
}

export interface ReportTimeEntry {
  workPackageId: number;
  subject: string;
  hours: number;
  comment?: string;
  projectId?: string;
}

export interface ReportProject {
  id: string;
  name?: string;
  pmOpUserIds: string[];
}

export interface ReportScope {
  facts?: FeatureFacts[];
  projects?: ReadonlySet<string>;
}

export interface ReportInput {
  mmUserId: string;
  opName: string;
  period: "daily" | "weekly";
  since: number;
  until: number;
  statusChanges: ReportStatusChange[];
  timeEntries: ReportTimeEntry[];
  projects?: ReportProject[];
}

interface ProjectReportInput {
  projectId: string;
  projectName?: string;
  weekKey: string;
  since: number;
  until: number;
  sections: ReportInput[];
  addressees: string[];
}

export type ReportWriter = (prompt: string) => Promise<string>;

export interface ZqReportDraft {
  id: string;
  mmUserId: string;
  period: ReportInput["period"];
  since: number;
  until: number;
  text: string;
  status: "pending" | "confirmed" | "discarded";
  kind?: "person" | "project";
  projectId?: string;
  projectName?: string;
  weekKey?: string;
  addressees?: string[];
  delivered?: string[];
  sendFailures?: Record<string, number>;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  claimToken?: string;
  writtenBack?: boolean;
}

export function reportPrompt(input: ReportInput): string {
  const changes = input.statusChanges.map(
    (c) => `- #${c.workPackageId} ${c.subject}: ${c.from ? `${c.from} -> ` : ""}${c.to}`,
  );
  const entries = input.timeEntries.map(
    (e) => `- #${e.workPackageId} ${e.subject}: ${e.hours}h${e.comment ? ` (${e.comment})` : ""}`,
  );
  return [
    `请为 ${input.opName} 写一份简短的${input.period === "daily" ? "日报" : "周报"}。只使用下面的事实,不要补充推测。`,
    "状态变化:",
    ...(changes.length ? changes : ["- 无"]),
    "工时记录:",
    ...(entries.length ? entries : ["- 无"]),
  ].join("\n");
}

function templateReport(input: ReportInput): string {
  const hours = Math.round(input.timeEntries.reduce((sum, e) => sum + e.hours, 0) * 100) / 100;
  const lines = [`${input.opName}的${input.period === "daily" ? "日报" : "周报"}草稿`];
  if (input.statusChanges.length) {
    lines.push(
      "进展:",
      ...input.statusChanges.map((c) => `- #${c.workPackageId} ${c.subject}: ${c.from ? `${c.from} -> ` : ""}${c.to}`),
    );
  }
  if (input.timeEntries.length) {
    lines.push(
      `已记工时:${hours} 小时`,
      ...input.timeEntries.map((e) => `- #${e.workPackageId} ${e.subject}: ${e.hours}h`),
    );
  }
  if (lines.length === 1) lines.push("这段时间在 OpenProject 里没有记录。");
  return lines.join("\n");
}

function projectDraftId(projectId: string, weekKey: string): string {
  return `project:${projectId}:weekly:${weekKey}`;
}

function personSection(input: ReportInput): string[] {
  const hours = Math.round(input.timeEntries.reduce((sum, e) => sum + e.hours, 0) * 100) / 100;
  const lines = [`${input.opName}:`];
  for (const c of input.statusChanges)
    lines.push(`- 进展 #${c.workPackageId} ${c.subject}: ${c.from ? `${c.from} -> ` : ""}${c.to}`);
  if (input.timeEntries.length) {
    lines.push(`- 已记工时:${hours} 小时`);
    for (const e of input.timeEntries) lines.push(`  - #${e.workPackageId} ${e.subject}: ${e.hours}h`);
  }
  if (lines.length === 1) lines.push("- 这周在 OpenProject 里没有记录。");
  return lines;
}

function projectReport(input: ProjectReportInput): string {
  return [
    `项目 ${input.projectName ?? input.projectId} 的周报草稿(${input.weekKey} 当周)`,
    ...input.sections.flatMap((s) => personSection(s)),
  ].join("\n");
}

export function sectionForProject(input: ReportInput, projectId: string): ReportInput | undefined {
  const projects = input.projects ?? [];
  if (!projects.some((p) => p.id === projectId)) return undefined;
  const sole = projects.length === 1;
  const mine = (id: string | undefined) => id === projectId || (id === undefined && sole);
  return {
    ...input,
    statusChanges: input.statusChanges.filter((c) => mine(c.projectId)),
    timeEntries: input.timeEntries.filter((e) => mine(e.projectId)),
  };
}

export interface ZqReports {
  draft(input: ReportInput): Promise<ZqReportDraft>;
  draftProject(input: ProjectReportInput): Promise<{ draft: ZqReportDraft; created: boolean }>;
  openProjectDrafts(weekKey: string): Promise<ZqReportDraft[]>;
  recordSend(id: string, to: string, delivered: boolean): Promise<ZqReportDraft | null>;
  decide(id: string, approve: boolean, decidedBy: string, clickerMmUserId: string): Promise<ZqReportDraft>;
}

export function createZqReports(opts: {
  map: DurableMap<ZqReportDraft>;
  write: ReportWriter | undefined;
  writeBack: (draft: ZqReportDraft) => Promise<void>;
  now?: () => number;
}): ZqReports {
  const now = opts.now ?? (() => Date.now());
  return {
    async draft(input) {
      const id = `${input.mmUserId}:${input.period}:${input.until}`;
      const existing = await opts.map.get(id);
      if (existing) return existing;
      const written = opts.write ? (await opts.write(reportPrompt(input))).trim() : "";
      const draft: ZqReportDraft = {
        id,
        mmUserId: input.mmUserId,
        period: input.period,
        since: input.since,
        until: input.until,
        text: written || templateReport(input),
        status: "pending",
        createdAt: now(),
      };
      await opts.map.insertIfAbsent(id, draft);
      return (await opts.map.get(id)) ?? draft;
    },
    async draftProject(input) {
      const id = projectDraftId(input.projectId, input.weekKey);
      const draft: ZqReportDraft = {
        id,
        mmUserId: input.addressees[0] ?? "",
        period: "weekly",
        kind: "project",
        projectId: input.projectId,
        ...(input.projectName ? { projectName: input.projectName } : {}),
        weekKey: input.weekKey,
        addressees: input.addressees,
        since: input.since,
        until: input.until,
        text: projectReport(input),
        status: "pending",
        createdAt: now(),
      };
      const inserted = await opts.map.insertIfAbsent(id, draft);
      return { draft: (await opts.map.get(id)) ?? draft, created: inserted };
    },
    async openProjectDrafts(weekKey) {
      const rows = await opts.map.select({ where: { field: "weekKey", anyOfFold: [weekKey] } });
      return rows.filter((d) => d.kind === "project" && d.status === "pending");
    },
    async recordSend(id, to, delivered) {
      return opts.map.update(id, (d) =>
        delivered
          ? { ...d, delivered: [...new Set([...(d.delivered ?? []), to])] }
          : { ...d, sendFailures: { ...d.sendFailures, [to]: (d.sendFailures?.[to] ?? 0) + 1 } },
      );
    },
    async decide(id, approve, decidedBy, clickerMmUserId) {
      const draft = await opts.map.get(id);
      if (!draft) throw new Error("这份草稿已经不存在");
      const project = draft.kind === "project";
      if (!(draft.addressees ?? [draft.mmUserId]).includes(clickerMmUserId))
        throw new Error(project ? "只有收到这份周报的项目经理可以确认" : "只有报告对应的本人可以确认");
      if (draft.status !== "pending") return draft;
      const claimToken = randomUUID();
      const claimed = await opts.map.update(id, (d) =>
        d.status === "pending"
          ? { ...d, status: approve ? "confirmed" : "discarded", decidedAt: now(), decidedBy, claimToken }
          : d,
      );
      if (!claimed) throw new Error("这份草稿已经不存在");
      if (approve && !project && claimed.claimToken === claimToken) {
        await opts.writeBack(claimed);
        return (await opts.map.merge(id, { writtenBack: true })) ?? claimed;
      }
      return claimed;
    },
  };
}
