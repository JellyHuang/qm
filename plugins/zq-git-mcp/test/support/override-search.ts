import { colLetters } from "../../src/xlsx/cells.ts";

export interface SheetSummaryShape {
  sheet: string;
  status: string;
  ambiguous: number;
  ambiguousKeys: number;
  changedCells: number;
  rowsAdded: number;
  rowsRemoved: number;
  suggestedKeyColumns?: string[];
}

export interface OverrideRun {
  sheet: string;
  attempt: number;
  keyColumns: string[];
  ambiguousBefore: number;
  ambiguousAfter: number;
  changedCells: number;
  rowsAdded: number;
  rowsRemoved: number;
  unique: boolean;
}

type Call = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const MAX_ATTEMPTS = 6;
const COLUMN_POOL = 6;

const sheetsOf = (body: Record<string, unknown>): SheetSummaryShape[] =>
  ((body.summary as { sheets?: SheetSummaryShape[] } | undefined)?.sheets ?? []) as SheetSummaryShape[];

function candidates(summary: SheetSummaryShape, explicit: string[] | undefined): string[][] {
  if (explicit && explicit.length > 0) return [explicit];
  const suggested = summary.suggestedKeyColumns ?? [];
  const pool = Array.from({ length: COLUMN_POOL }, (_, i) => colLetters(i + 1)).filter(
    (letter) => !suggested.includes(letter),
  );
  return [...(suggested.length > 0 ? [suggested] : []), ...pool.map((letter) => [...suggested, letter])].slice(
    0,
    MAX_ATTEMPTS,
  );
}

export async function searchKeyOverrides(
  call: Call,
  base: Record<string, unknown>,
  explicit?: string[],
): Promise<{ defaults: SheetSummaryShape[]; runs: OverrideRun[] }> {
  const first = await call(base);
  if (first.error !== undefined) throw new Error(`the default run failed: ${JSON.stringify(first.error)}`);
  const defaults = sheetsOf(first);
  const runs: OverrideRun[] = [];
  for (const summary of defaults.filter((entry) => entry.status === "both" && entry.ambiguousKeys > 0)) {
    let attempt = 0;
    for (const keyColumns of candidates(summary, explicit)) {
      attempt++;
      const body = await call({ ...base, limit: 1, overrides: { [summary.sheet]: { keyColumns } } });
      const after = sheetsOf(body).find((entry) => entry.sheet === summary.sheet);
      const ambiguousAfter = after?.ambiguousKeys ?? -1;
      runs.push({
        sheet: summary.sheet,
        attempt,
        keyColumns,
        ambiguousBefore: summary.ambiguousKeys,
        ambiguousAfter,
        changedCells: after?.changedCells ?? 0,
        rowsAdded: after?.rowsAdded ?? 0,
        rowsRemoved: after?.rowsRemoved ?? 0,
        unique: ambiguousAfter === 0,
      });
      if (ambiguousAfter === 0) break;
    }
  }
  return { defaults, runs };
}
