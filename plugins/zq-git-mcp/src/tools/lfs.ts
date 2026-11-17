import { stat } from "node:fs/promises";
import { readRange } from "./text-scan.ts";

export const LFS_POINTER_MAX_BYTES = 1024;

export interface LfsPointer {
  oid: string;
  size: number;
}

const VERSION = "version https://git-lfs.github.com/spec/v1";

export function parseLfsPointer(content: Buffer): LfsPointer | undefined {
  if (content.length > LFS_POINTER_MAX_BYTES || content.includes(0)) return undefined;
  const lines = content.toString("utf8").split("\n");
  if (lines[0] !== VERSION) return undefined;
  const oid = lines.map((line) => /^oid sha256:([0-9a-f]{64})$/.exec(line)?.[1]).find(Boolean);
  const size = lines.map((line) => /^size (\d+)$/.exec(line)?.[1]).find(Boolean);
  return oid && size ? { oid, size: Number(size) } : undefined;
}

export async function readLfsPointer(file: string): Promise<LfsPointer | undefined> {
  const { size } = await stat(file);
  if (size > LFS_POINTER_MAX_BYTES) return undefined;
  return parseLfsPointer(await readRange(file, 0, size));
}
