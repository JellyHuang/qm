import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PatchPackageError } from "./settings.ts";

export interface PackageFile {
  name: string;
  sha256: string;
  bytes: number;
}

export async function describeFile(dir: string, name: string): Promise<PackageFile> {
  const path = join(dir, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { name, sha256: hash.digest("hex"), bytes: (await stat(path)).size };
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

export async function writeManifest(dir: string, manifest: object): Promise<string> {
  const path = join(dir, "manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export async function listPackage(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
