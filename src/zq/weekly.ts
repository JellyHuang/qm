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

interface Entry {
  order: WorkView;
  parent: string;
}

const OTHER = "其他";
const NO_PARENT = "(没有上级总单)";

function ordersOf(facts: readonly FeatureFacts[], contract: ZqContract): Entry[] {
  const seen = new Map<number, Entry>();
  for (const { feature, children } of facts) {
    const standalone = contract.optimizationType === feature.typeKey;
    const entries = [
      ...(standalone ? [{ order: feature, parent: NO_PARENT }] : []),
      ...children.map((order) => ({ order, parent: feature.subject })),
    ];
    for (const entry of entries) if (!seen.has(entry.order.id)) seen.set(entry.order.id, entry);
  }
  return [...seen.values()]
    .sort((a, b) => a.order.id - b.order.id)
    .filter(({ order: w }) => !paused(w.lifecycle) && !w.closed && w.statusKey !== contract.stageRoles.taskDone);
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
  const byLead = new Map<string, { name: string; sections: Map<string, Entry[]> }>();
  for (const entry of ordersOf(opts.facts, contract)) {
    const label = contract.weeklyLabels[entry.order.typeKey] ?? OTHER;
    const named = contract.weeklyLeads[label] ?? contract.typeLeads[entry.order.typeKey] ?? [];
    for (const lead of named.length ? named : fallback) {
      const slot = byLead.get(lead.id) ?? { name: lead.name, sections: new Map() };
      slot.sections.set(label, [...(slot.sections.get(label) ?? []), entry]);
      byLead.set(lead.id, slot);
    }
  }
  const { start, end } = weekOf(opts.now, opts.timezone);
  return [...byLead].map(([leadOpUserId, { name, sections }]) => ({
    leadOpUserId,
    leadName: name,
    text: [
      `${start}-${end}`,
      ...[...sections]
        .sort(([a], [b]) => Number(a === OTHER) - Number(b === OTHER))
        .flatMap(([label, entries]) => {
          const parents = [...new Set(entries.map((e) => e.parent))];
          let n = 0;
          return [
            "",
            `${label}:`,
            ...parents.flatMap((parent) => [
              `【${parent}】`,
              ...entries.filter((e) => e.parent === parent).map((e) => `${++n}. ${line(e.order, contract)}`),
            ]),
          ];
        }),
    ].join("\n"),
  }));
}
