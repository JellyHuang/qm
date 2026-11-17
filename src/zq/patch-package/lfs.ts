import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitRunner } from "./git.ts";
import { PatchPackageError } from "./settings.ts";

export const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_MAX_BYTES = 1024;

export interface BaseFileInfo {
  blobId: string;
  size: number;
  kind: "text" | "binary" | "lfs_pointer";
  pointer?: Buffer;
}

export interface BaseReader {
  stat(path: string): Promise<BaseFileInfo | null>;
  bytes(path: string): Promise<Buffer | null>;
}

export interface ChangeRef {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
  sameBlob: boolean;
  newPointer: boolean;
}

export interface Classification {
  kind: "text" | "binary" | "lfs";
  baseBlob?: string;
  warnings: string[];
}

export function isLfsPointer(bytes: Buffer): boolean {
  return (
    bytes.length <= LFS_POINTER_MAX_BYTES && bytes.subarray(0, LFS_HEADER.length).toString("latin1") === LFS_HEADER
  );
}

export function createRepoReader(git: GitRunner, repoDir: string, commit: string): BaseReader {
  const entry = async (path: string): Promise<{ oid: string; size: number } | null> => {
    const line = (await git.run("cat-file", ["--batch-check"], { cwd: repoDir, stdin: `${commit}:${path}\n` }))
      .toString("utf8")
      .trim();
    const [oid = "", type = "", size = ""] = line.split(" ");
    return type === "blob" ? { oid, size: Number(size) } : null;
  };
  const blob = (oid: string) => git.run("cat-file", ["blob", oid], { cwd: repoDir });
  return {
    async stat(path) {
      const found = await entry(path);
      if (!found) return null;
      if (found.size > LFS_POINTER_MAX_BYTES) return { blobId: found.oid, size: found.size, kind: "text" };
      const content = await blob(found.oid);
      if (isLfsPointer(content)) return { blobId: found.oid, size: found.size, kind: "lfs_pointer", pointer: content };
      return { blobId: found.oid, size: found.size, kind: content.includes(0) ? "binary" : "text" };
    },
    async bytes(path) {
      const found = await entry(path);
      return found ? blob(found.oid) : null;
    },
  };
}

function directoriesOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

async function checkFilters(
  git: GitRunner,
  cwd: string,
  paths: readonly string[],
  ignoreCase: boolean,
): Promise<Map<string, string>> {
  const out = await git.run("check-attr", ["-z", "--stdin", "filter"], {
    cwd,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.ignorecase",
      GIT_CONFIG_VALUE_0: ignoreCase ? "true" : "false",
    },
    stdin: paths.map((path) => `${path}\0`).join(""),
  });
  const tokens = out.toString("utf8").split("\0");
  const values = new Map<string, string>();
  for (let i = 0; i + 2 < tokens.length; i += 3) values.set(tokens[i] ?? "", tokens[i + 2] ?? "");
  return values;
}

function plainKind(change: ChangeRef): "binary" | "text" {
  return change.binary ? "binary" : "text";
}

function decide(path: string, value: string, base: BaseFileInfo | null, warnings: string[]): "lfs" | "plain" {
  const pointer = base?.kind === "lfs_pointer";
  if (value === "lfs") {
    if (!pointer) warnings.push(`${path} will be stored as a Git LFS pointer when it is committed`);
    return "lfs";
  }
  if (value === "unset" || value === "unspecified") {
    if (pointer)
      throw new PatchPackageError(
        "lfs_attribute_mismatch",
        `${path} is a Git LFS pointer at the base commit but its .gitattributes rules do not say LFS; a person must look at it`,
      );
    return "plain";
  }
  throw new PatchPackageError(
    "unsupported_filter",
    `${path} uses the filter ${JSON.stringify(value)}; only Git LFS is supported`,
  );
}

export async function classifyChanges(
  git: GitRunner,
  reader: BaseReader,
  changes: readonly ChangeRef[],
  tmpRoot: string = tmpdir(),
): Promise<Map<string, Classification>> {
  for (const change of changes)
    for (const path of [change.path, change.oldPath ?? change.path])
      if (path.split("/").at(-1) === ".gitattributes")
        throw new PatchPackageError(
          "attributes_changed",
          `${path} is a .gitattributes file; a package that changes attribute rules is not supported`,
        );
  const allPaths = [...new Set(changes.flatMap((c) => [c.path, ...(c.oldPath ? [c.oldPath] : [])]))];
  const dirs = [...new Set(allPaths.flatMap(directoriesOf))].sort();
  const scratch = await mkdtemp(join(tmpRoot, "qm-attr-"));
  try {
    await git.run("init", ["-q"], { cwd: scratch });
    await rm(join(scratch, ".git", "info", "attributes"), { force: true });
    for (const dir of dirs) {
      const file = dir === "" ? ".gitattributes" : `${dir}/.gitattributes`;
      const content = await reader.bytes(file);
      if (content === null) continue;
      await mkdir(dirname(join(scratch, file)), { recursive: true });
      await writeFile(join(scratch, file), content);
    }
    const strict = await checkFilters(git, scratch, allPaths, false);
    const folded = await checkFilters(git, scratch, allPaths, true);
    for (const path of allPaths)
      if (strict.get(path) !== folded.get(path))
        throw new PatchPackageError(
          "attributes_case_dependent",
          `the rules for ${path} depend on letter case (${strict.get(path)} against ${folded.get(path)} on a case-insensitive file system); fix .gitattributes first`,
        );
    const result = new Map<string, Classification>();
    for (const change of changes) {
      const warnings: string[] = [];
      const base = change.status === "A" ? null : await reader.stat(change.oldPath ?? change.path);
      const decision = decide(change.path, strict.get(change.path) ?? "unspecified", base, warnings);
      if (change.oldPath) decide(change.oldPath, strict.get(change.oldPath) ?? "unspecified", base, warnings);
      if (change.status !== "D" && change.newPointer && !change.sameBlob)
        throw new PatchPackageError(
          decision === "lfs" ? "lfs_pointer_content" : "lfs_attribute_mismatch",
          decision === "lfs"
            ? `${change.path} holds a Git LFS pointer instead of the real file; check out the real file first`
            : `${change.path} holds a Git LFS pointer but its .gitattributes rules do not say LFS`,
        );
      result.set(change.path, {
        kind: decision === "lfs" ? "lfs" : plainKind(change),
        ...(base ? { baseBlob: base.blobId } : {}),
        warnings,
      });
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
