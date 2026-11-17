import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PatchPackageError } from "./settings.ts";

export interface PackageFile {
  name: string;
  sha256: string;
  gitBlob: string;
  bytes: number;
}

export function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function describeFile(dir: string, name: string): Promise<PackageFile> {
  const path = join(dir, name);
  const bytes = (await stat(path)).size;
  const sha256 = createHash("sha256");
  const blob = createHash("sha1").update(`blob ${bytes}\0`);
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk as Buffer);
    blob.update(chunk as Buffer);
  }
  return { name, sha256: sha256.digest("hex"), gitBlob: blob.digest("hex"), bytes };
}

export async function createPackageDir(outputDir: string, name: string): Promise<string> {
  if (!/^[\w.-]+$/.test(name) || name.startsWith("."))
    throw new PatchPackageError("bad_input", `the package name ${name} is not a plain file name`);
  const dir = join(outputDir, name);
  await mkdir(outputDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new PatchPackageError("exists", `the package ${name} already exists in the output directory`);
    throw e;
  }
  return dir;
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
