import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRow } from "./audit.ts";

const SEGMENT_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^segment-(\d{12})\.jsonl$/;

export interface Spool {
  load(): Promise<void>;
  backlog(): number;
  append(row: AuditRow): Promise<"stored" | "dropped">;
  drain(insert: (row: AuditRow) => Promise<void>): Promise<{ replayed: number; expired: number; failure?: unknown }>;
}

export interface SpoolOptions {
  dir: string;
  maxBytes: number;
  maxAgeMs: number;
  now?: () => number;
}

interface Segment {
  file: string;
  bytes: number;
  records: number;
}

function parseLines(text: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as AuditRow);
    } catch {
      continue;
    }
  }
  return rows;
}

export function createSpool(options: SpoolOptions): Spool {
  const { dir, maxBytes, maxAgeMs } = options;
  const now = options.now ?? Date.now;
  let segments: Segment[] = [];
  let sequence = 0;

  const total = () => segments.reduce((sum, segment) => sum + segment.bytes, 0);

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  return {
    async load() {
      await ensureDir();
      segments = [];
      for (const name of (await readdir(dir)).filter((entry) => SEGMENT.test(entry)).sort()) {
        const file = join(dir, name);
        const text = await readFile(file, "utf8");
        segments.push({ file, bytes: Buffer.byteLength(text), records: parseLines(text).length });
        sequence = Math.max(sequence, Number(SEGMENT.exec(name)?.[1] ?? 0));
      }
    },
    backlog: () => segments.reduce((sum, segment) => sum + segment.records, 0),
    async append(row) {
      const line = `${JSON.stringify(row)}\n`;
      const size = Buffer.byteLength(line);
      if (total() + size > maxBytes) return "dropped";
      await ensureDir();
      let current = segments.at(-1);
      if (!current || current.bytes + size > SEGMENT_BYTES) {
        current = { file: join(dir, `segment-${String(++sequence).padStart(12, "0")}.jsonl`), bytes: 0, records: 0 };
        segments.push(current);
        await writeFile(current.file, "", { mode: 0o600 });
      }
      await appendFile(current.file, line, { mode: 0o600 });
      current.bytes += size;
      current.records++;
      return "stored";
    },
    async drain(insert) {
      let replayed = 0;
      let expired = 0;
      while (segments[0]) {
        const segment = segments[0];
        const rows = parseLines(await readFile(segment.file, "utf8"));
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as AuditRow;
          if (now() - row.at > maxAgeMs) {
            expired++;
            continue;
          }
          try {
            await insert(row);
          } catch (e) {
            const rest = rows.slice(i);
            const text = rest.map((remaining) => `${JSON.stringify(remaining)}\n`).join("");
            await writeFile(`${segment.file}.tmp`, text, { mode: 0o600 });
            await rename(`${segment.file}.tmp`, segment.file);
            segment.bytes = Buffer.byteLength(text);
            segment.records = rest.length;
            return { replayed, expired, failure: e };
          }
          replayed++;
        }
        await rm(segment.file, { force: true });
        segments.shift();
      }
      return { replayed, expired };
    },
  };
}
