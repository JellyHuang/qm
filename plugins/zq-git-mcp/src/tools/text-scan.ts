import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

const SNIFF_BYTES = 8000;

export interface TextScan {
  content: string;
  firstLine: number;
  lastLine: number;
  totalLines: number;
  totalBytes: number;
  cutChars: number;
}

export async function sniff(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readRange(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function scanText(
  file: string,
  range: { start: number; end: number },
  budgetChars: number,
): Promise<TextScan> {
  const keepBytes = Math.max(budgetChars * 4, 4096);
  const out: string[] = [];
  let chars = 0;
  let cutChars = 0;
  let lastLine = 0;
  let line = 1;
  let totalBytes = 0;
  let pieces: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  let pending = false;
  let full = false;

  const finishLine = () => {
    if (line >= range.start && line <= range.end) {
      const text = Buffer.concat(pieces).toString("utf8");
      const length = text.length + dropped;
      const room = budgetChars - chars - (out.length > 0 ? 1 : 0);
      if (!full && dropped === 0 && text.length <= room) {
        chars += text.length + (out.length > 0 ? 1 : 0);
        out.push(text);
        lastLine = line;
      } else if (!full && out.length === 0 && room > 0) {
        out.push(text.slice(0, room));
        chars += Math.min(room, text.length);
        cutChars += length - Math.min(room, text.length);
        lastLine = line;
        full = true;
      } else {
        full = true;
        cutChars += length;
      }
    }
    pieces = [];
    kept = 0;
    dropped = 0;
    pending = false;
    line++;
  };

  for await (const raw of createReadStream(file)) {
    const chunk = raw as Buffer;
    totalBytes += chunk.length;
    let pos = 0;
    while (pos < chunk.length) {
      const newline = chunk.indexOf(10, pos);
      const end = newline === -1 ? chunk.length : newline;
      if (end > pos) pending = true;
      if (line >= range.start && line <= range.end) {
        const take = Math.min(end - pos, Math.max(0, keepBytes - kept));
        if (take > 0) pieces.push(chunk.subarray(pos, pos + take));
        kept += take;
        dropped += end - pos - take;
      }
      if (newline === -1) break;
      finishLine();
      pos = newline + 1;
    }
  }
  if (pending) finishLine();
  return {
    content: out.join("\n"),
    firstLine: range.start,
    lastLine,
    totalLines: line - 1,
    totalBytes,
    cutChars,
  };
}
