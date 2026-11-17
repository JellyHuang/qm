import type { DatabaseSync } from "node:sqlite";
import { colLetters } from "./cells.ts";
import type { SheetMeta } from "./ingest.ts";

const CANDIDATES = 6;

type CellTuple = [string, ...unknown[]];

function survivors(db: DatabaseSync, side: number, sheet: string, sets: string[][]): string[][] {
  const alive = sets.map((columns) => ({ columns, seen: new Set<string>(), ok: true }));
  const rows = db.prepare("SELECT cells FROM rows WHERE side = ? AND sheet = ?").iterate(side, sheet);
  for (const row of rows as Iterable<{ cells: string }>) {
    const cells = JSON.parse(row.cells) as Record<string, CellTuple>;
    let any = false;
    for (const candidate of alive) {
      if (!candidate.ok) continue;
      const parts = candidate.columns.map((header) => cells[header]?.[0] ?? "");
      const key = parts.join("\u001f");
      if (parts.some((part) => part === "") || candidate.seen.has(key)) {
        candidate.ok = false;
        candidate.seen.clear();
      } else {
        candidate.seen.add(key);
        any = true;
      }
    }
    if (!any) break;
  }
  return alive.filter((candidate) => candidate.ok).map((candidate) => candidate.columns);
}

function both(db: DatabaseSync, sheet: string, sets: string[][], sides: number[]): string[][] {
  let left = sets;
  for (const side of sides) left = left.length === 0 ? left : survivors(db, side, sheet, left);
  return left;
}

export function suggestKeyColumns(
  db: DatabaseSync,
  sheet: string,
  base: SheetMeta | undefined,
  head: SheetMeta,
): string[] {
  const shared = head.headers.filter((header) => !base || base.headers.includes(header)).slice(0, CANDIDATES);
  const sides = base ? [0, 1] : [1];
  const singles = shared.map((header) => [header]);
  const pairs = shared.flatMap((first, i) => shared.slice(i + 1).map((second) => [first, second]));
  const found = both(db, sheet, singles, sides)[0] ?? both(db, sheet, pairs, sides)[0];
  return (found ?? []).map((header) => colLetters(head.headerCols[head.headers.indexOf(header)] ?? 1));
}
