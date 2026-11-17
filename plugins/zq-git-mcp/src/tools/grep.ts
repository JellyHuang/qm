import { createReadStream } from "node:fs";

const MATCH_CHARS = 10_000;
const OUTPUT_LINE_CHARS = 500;

export interface GrepHit {
  line: number;
  text: string;
  before: string[];
  after: string[];
}

interface PendingHit {
  hit: GrepHit;
  remaining: number;
}

const clip = (text: string) => (text.length > OUTPUT_LINE_CHARS ? `${text.slice(0, OUTPUT_LINE_CHARS)}...` : text);

export async function grepFile(
  file: string,
  options: { matches: (line: string) => boolean; context: number },
  onHit: (hit: GrepHit) => boolean,
): Promise<number> {
  const { context } = options;
  const keepBytes = MATCH_CHARS * 4;
  let line = 0;
  let pieces: Buffer[] = [];
  let kept = 0;
  let recent: string[] = [];
  let pending: PendingHit[] = [];
  let go = true;

  const emit = (hit: GrepHit) => {
    if (!onHit(hit)) go = false;
  };

  const handle = (raw: string) => {
    line++;
    const text = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).slice(0, MATCH_CHARS);
    const shown = clip(text);
    for (const entry of pending) entry.hit.after.push(shown);
    pending = pending.filter((entry) => {
      if (--entry.remaining > 0) return true;
      emit(entry.hit);
      return false;
    });
    if (options.matches(text)) {
      const hit: GrepHit = { line, text: shown, before: [...recent], after: [] };
      if (context === 0) emit(hit);
      else pending.push({ hit, remaining: context });
    }
    if (context > 0) recent = [...recent, shown].slice(-context);
  };

  const finish = () => {
    handle(Buffer.concat(pieces).toString("utf8"));
    pieces = [];
    kept = 0;
  };

  let partial = false;
  for await (const raw of createReadStream(file)) {
    const chunk = raw as Buffer;
    let pos = 0;
    while (pos < chunk.length && go) {
      const newline = chunk.indexOf(10, pos);
      const end = newline === -1 ? chunk.length : newline;
      const take = Math.min(end - pos, Math.max(0, keepBytes - kept));
      if (take > 0) pieces.push(chunk.subarray(pos, pos + take));
      kept += take;
      if (end > pos) partial = true;
      if (newline === -1) break;
      finish();
      partial = false;
      pos = newline + 1;
    }
    if (!go) break;
  }
  if (go && partial) finish();
  if (go) for (const entry of pending) emit(entry.hit);
  return line;
}
