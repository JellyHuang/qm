import { paused, type ZqContract } from "./contract.ts";
import type { FeatureFacts, WorkView } from "./rules.ts";
import { dayKeyIn } from "./scanner.ts";

const DAY = 86_400_000;
const FRIDAY = 5;

export interface WeeklyBrief {
  leadOpUserId: string;
  leadName: string;
  text: string;
}

function weekOf(at: number, timezone: string): { start: string; end: string } {
  const [y, m, d] = dayKeyIn(timezone, at).split("-").map(Number);
  const today = Date.UTC(y!, m! - 1, d!);
  const sinceFriday = (new Date(today).getUTCDay() - FRIDAY + 7) % 7;
  const start = today - sinceFriday * DAY;
  const dotted = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", ".");
  return { start: dotted(start), end: dotted(start + 6 * DAY) };
}

function ordersOf(facts: readonly FeatureFacts[], contract: ZqContract): WorkView[] {
  const seen = new Map<number, WorkView>();
  for (const { feature, children } of facts) {
    const candidates = contract.optimizationType === feature.typeKey ? [feature, ...children] : children;
    for (const w of candidates) if (!seen.has(w.id)) seen.set(w.id, w);
  }
  return [...seen.values()]
    .sort((a, b) => a.id - b.id)
    .filter((w) => !paused(w.lifecycle) && !w.closed && w.statusKey !== contract.stageRoles.taskDone);
}

function line(w: WorkView, contract: ZqContract): string {
  const status = contract.stages.task[w.statusKey] ?? contract.stages.feature[w.statusKey] ?? w.statusKey;
  const notes = [w.delayMarked ? "已延期" : "", w.awaitingNote ?? ""].filter(Boolean).join(";");
  const percent = w.percent === undefined ? `${status}(未取到完成百分比)` : `${w.percent}% ${status}`;
  return `${w.subject} ${percent}${notes ? `(备注:${notes})` : ""}`;
}

export function composeWeeklyBriefs(opts: {
  facts: readonly FeatureFacts[];
  contract: ZqContract;
  now: number;
  timezone: string;
}): WeeklyBrief[] {
  const { contract } = opts;
  const fallback = contract.defaultLead ? [contract.defaultLead] : [];
  const orders = ordersOf(opts.facts, contract);
  const byLead = new Map<string, { name: string; sections: Map<string, WorkView[]> }>();
  for (const w of orders) {
    const label = contract.weeklyLabels[w.typeKey];
    if (!label) continue;
    const named = contract.typeLeads[w.typeKey] ?? [];
    for (const lead of named.length ? named : fallback) {
      const entry = byLead.get(lead.id) ?? { name: lead.name, sections: new Map() };
      entry.sections.set(label, [...(entry.sections.get(label) ?? []), w]);
      byLead.set(lead.id, entry);
    }
  }
  const { start, end } = weekOf(opts.now, opts.timezone);
  return [...byLead].map(([leadOpUserId, { name, sections }]) => ({
    leadOpUserId,
    leadName: name,
    text: [
      `${start}-${end}`,
      ...[...sections].flatMap(([label, list]) => [
        "",
        `${label}:`,
        ...list.sort((a, b) => a.id - b.id).map((w, i) => `${i + 1}. ${line(w, contract)}`),
      ]),
    ].join("\n"),
  }));
}
