const DAY_MS = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const BUILTIN_DATE_FORMATS = new Set([
  ...Array.from({ length: 9 }, (_, i) => 14 + i),
  ...Array.from({ length: 10 }, (_, i) => 27 + i),
  45,
  46,
  47,
  ...Array.from({ length: 9 }, (_, i) => 50 + i),
]);

export function colIndex(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

export function colLetters(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseRef(ref: string): { col: number; row: number } | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  return match ? { col: colIndex(match[1] ?? ""), row: Number(match[2]) } : undefined;
}

export function isDateFormat(numFmtId: number, code: string | undefined): boolean {
  if (code === undefined) return BUILTIN_DATE_FORMATS.has(numFmtId);
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped) && !/^general$/i.test(stripped);
}

export function serialToIso(serial: number, date1904: boolean): string {
  const whole = Math.floor(serial);
  if (!date1904 && whole === 60) return "1900-02-29";
  const shift = !date1904 && whole < 60 ? 1 : 0;
  const ms = (date1904 ? EPOCH_1904 : EPOCH_1900) + (serial + shift) * DAY_MS;
  const iso = new Date(Math.round(ms / 1000) * 1000).toISOString();
  return serial === whole ? iso.slice(0, 10) : iso.slice(0, 19);
}

export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            /(^|[^A-Za-z0-9_.!'])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g,
            (_m, lead, dc, c, dr, r) => {
              const col = dc ? c : colLetters(colIndex(c) + dCol);
              const row = dr ? r : String(Math.max(1, Number(r) + dRow));
              return `${lead}${dc}${col}${dr}${row}`;
            },
          ),
    )
    .join("");
}
