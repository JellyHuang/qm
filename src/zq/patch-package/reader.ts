import { gitBlobId } from "./files.ts";
import { LFS_HEADER, type BaseFileInfo, type BaseReader } from "./lfs.ts";
import { PatchPackageError } from "./settings.ts";

export type ReadFileCall = (args: {
  path: string;
  offset?: number;
  length?: number;
}) => Promise<Record<string, unknown> | null>;

const DEFAULT_CHUNK_BYTES = 32 * 1024;
const MIN_CHUNK_BYTES = 16;
const REPLACEMENT = "�";

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new PatchPackageError("bad_input", `read_file did not return ${what}`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new PatchPackageError("bad_input", `read_file did not return ${what}`);
  return value;
}

export function createServiceReader(read: ReadFileCall, options: { chunkBytes?: number } = {}): BaseReader {
  const chunk = Math.max(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, MIN_CHUNK_BYTES);

  const stat = async (path: string): Promise<BaseFileInfo | null> => {
    const result = await read({ path, offset: 0, length: 1 });
    if (result === null) return null;
    if (result.kind === "submodule")
      throw new PatchPackageError("unsupported", `${path} is a submodule; this version does not handle those`);
    const blobId = text(result.oid, "an object id");
    const size = count(result.size, "a size");
    if (result.kind === "lfs_pointer") {
      const pointer = Buffer.from(
        `${LFS_HEADER}\noid sha256:${text(result.lfsOid, "an LFS oid")}\nsize ${count(result.lfsSize, "an LFS size")}\n`,
      );
      return { blobId, size, kind: "lfs_pointer", pointer };
    }
    if (result.kind !== "text" && result.kind !== "binary")
      throw new PatchPackageError(
        "bad_input",
        `read_file returned the unknown kind ${String(result.kind)} for ${path}`,
      );
    return { blobId, size, kind: result.kind };
  };

  return {
    stat,
    async bytes(path) {
      const info = await stat(path);
      if (info === null) return null;
      let assembled: Buffer;
      let sawReplacement = false;
      if (info.pointer) assembled = info.pointer;
      else {
        const parts: Buffer[] = [];
        let offset = 0;
        while (offset < info.size) {
          const wanted = Math.min(chunk, info.size - offset);
          const result = await read({ path, offset, length: wanted });
          if (result === null || result.kind !== info.kind)
            throw new PatchPackageError("bad_input", `${path} changed while it was being read`);
          const served = typeof result.length === "number" ? result.length : wanted;
          let part: Buffer;
          if (info.kind === "binary") part = Buffer.from(text(result.base64, "base64 content"), "base64");
          else {
            let content = text(result.content, "text content");
            if (content.endsWith(REPLACEMENT) && offset + served < info.size) content = content.slice(0, -1);
            sawReplacement ||= content.includes(REPLACEMENT);
            part = Buffer.from(content, "utf8");
          }
          if (part.length === 0)
            throw new PatchPackageError("bad_input", `read_file did not advance while reading ${path}`);
          parts.push(part);
          offset += part.length;
        }
        assembled = Buffer.concat(parts);
      }
      if (assembled.length !== info.size || gitBlobId(assembled) !== info.blobId)
        throw new PatchPackageError(
          sawReplacement ? "not_utf8" : "oid_mismatch",
          sawReplacement
            ? `${path} is not valid UTF-8 text; this version refuses such files because the service cannot return their exact bytes`
            : `the bytes read for ${path} do not match its object id ${info.blobId}`,
        );
      return assembled;
    },
  };
}
