import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface ReportStatusChange {
  workPackageId: number;
  subject: string;
  from?: string;
  to: string;
  at: number;
}

export interface ReportTimeEntry {
  workPackageId: number;
  subject: string;
  hours: number;
  comment?: string;
}

export interface ReportInput {
  mmUserId: string;
  opName: string;
  period: "daily" | "weekly";
  since: number;
  until: number;
  statusChanges: ReportStatusChange[];
  timeEntries: ReportTimeEntry[];
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
    `Write a short ${input.period} work report for ${input.opName}. Use only the facts below.`,
    "Status changes:",
    ...(changes.length ? changes : ["- none"]),
    "Time entries:",
    ...(entries.length ? entries : ["- none"]),
  ].join("\n");
}

function templateReport(input: ReportInput): string {
  const hours = input.timeEntries.reduce((sum, e) => sum + e.hours, 0);
  const lines = [`${input.period === "daily" ? "Daily" : "Weekly"} report for ${input.opName}`];
  if (input.statusChanges.length) {
    lines.push(
      "Progress:",
      ...input.statusChanges.map((c) => `- #${c.workPackageId} ${c.subject}: ${c.from ? `${c.from} -> ` : ""}${c.to}`),
    );
  }
  if (input.timeEntries.length) {
    lines.push(
      `Time logged: ${hours}h`,
      ...input.timeEntries.map((e) => `- #${e.workPackageId} ${e.subject}: ${e.hours}h`),
    );
  }
  if (lines.length === 1) lines.push("No recorded activity in this period.");
  return lines.join("\n");
}

export interface ZqReports {
  draft(input: ReportInput): Promise<ZqReportDraft>;
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
    async decide(id, approve, decidedBy, clickerMmUserId) {
      const draft = await opts.map.get(id);
      if (!draft) throw new Error("that report draft no longer exists");
      if (draft.mmUserId !== clickerMmUserId) throw new Error("only the person the report is about can decide it");
      if (draft.status !== "pending") return draft;
      const claimToken = randomUUID();
      const claimed = await opts.map.update(id, (d) =>
        d.status === "pending"
          ? { ...d, status: approve ? "confirmed" : "discarded", decidedAt: now(), decidedBy, claimToken }
          : d,
      );
      if (!claimed) throw new Error("that report draft no longer exists");
      if (approve && claimed.claimToken === claimToken) {
        await opts.writeBack(claimed);
        return (await opts.map.merge(id, { writtenBack: true })) ?? claimed;
      }
      return claimed;
    },
  };
}
