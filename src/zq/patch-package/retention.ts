import { randomBytes } from "node:crypto";
import { access, chmod, constants, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DurableMap } from "../../persistence/durable-map.ts";
import { currentTenant, isTenantId } from "../../tenants/context.ts";
import { sha256Hex } from "./files.ts";
import type { PatchPackage } from "./package.ts";
import { PatchPackageError, type PatchRetentionSettings } from "./settings.ts";

export interface PatchPackageRecipient {
  mmUserId?: string;
  source: "requester" | "author_binding" | "explicit";
  unresolved?: string;
}

interface RecordedFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface PatchPackageRecord {
  id: string;
  kind: "patch-package";
  ticket: string;
  repo?: string;
  recipient: PatchPackageRecipient;
  baseCommit: string;
  resultCommit?: string;
  files: RecordedFile[];
  zip: RecordedFile;
  createdAt: number;
  expiresAt: number;
  deletedAt?: number;
}

interface CleanupResult {
  deleted: number;
  purged: number;
  refused: string[];
}

interface OrphanReport {
  orphanDirectories: string[];
  missingZips: string[];
}

export interface PatchRetention {
  verifyDirectory(): Promise<void>;
  retain(
    pkg: Pick<PatchPackage, "id" | "ticket" | "repo" | "baseCommit" | "resultCommit" | "files" | "zip">,
    recipient: PatchPackageRecipient,
  ): Promise<{ record: PatchPackageRecord; written: boolean }>;
  cleanup(options?: { now?: number; batchSize?: number }): Promise<CleanupResult>;
  orphans(): Promise<OrphanReport>;
}

const DAY_MS = 86_400_000;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCES = new Set(["requester", "author_binding", "explicit"]);

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurably(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString("hex")}.part`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  await syncDirectory(dirname(path));
}

async function holdsZip(path: string, zip: RecordedFile): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size === zip.bytes && sha256Hex(await readFile(path)) === zip.sha256;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
}

export function createPatchRetention(deps: {
  map: DurableMap<PatchPackageRecord>;
  settings: PatchRetentionSettings;
  now?: () => number;
  log?: (line: string) => void;
}): PatchRetention {
  const { map, settings } = deps;
  const clock = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));

  function tenantDir(): string {
    const tenant = currentTenant();
    if (!isTenantId(tenant))
      throw new PatchPackageError("bad_input", "the tenant id is not usable as a directory name");
    return join(settings.dir, tenant);
  }

  function packageDir(id: string): string {
    if (!PACKAGE_ID.test(id)) throw new PatchPackageError("bad_input", `the package id ${id} is not a plain name`);
    return join(tenantDir(), id);
  }

  async function removePackageDirectory(id: string): Promise<boolean> {
    const dir = packageDir(id);
    const info = await lstat(dir).catch((e: unknown) => {
      if (errorCode(e) === "ENOENT") return null;
      throw e;
    });
    if (info && !info.isDirectory()) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  return {
    async verifyDirectory() {
      try {
        await mkdir(settings.dir, { recursive: true, mode: 0o700 });
        if (!(await stat(settings.dir)).isDirectory()) throw new Error("not a directory");
        await access(settings.dir, constants.R_OK | constants.W_OK | constants.X_OK);
      } catch (e) {
        throw new Error(`ZQ_PATCH_RETAIN_DIR ${settings.dir} is not a usable writable directory`, { cause: e });
      }
    },

    async retain(pkg, recipient) {
      const id = pkg.id;
      const dir = packageDir(id);
      if (pkg.zip.name !== `${id}.zip` || sha256Hex(pkg.zip.data) !== pkg.zip.sha256)
        throw new PatchPackageError("bad_input", `the zip of ${id} does not match its recorded name and hash`);
      if (!SOURCES.has(recipient.source))
        throw new PatchPackageError("bad_input", "the recipient source is not requester, author_binding or explicit");
      const zip: RecordedFile = { name: pkg.zip.name, sha256: pkg.zip.sha256, bytes: pkg.zip.bytes };
      const existing = await map.get(id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dirname(dir), 0o700);
      await chmod(dir, 0o700);
      const zipPath = join(dir, zip.name);
      const written = !(await holdsZip(zipPath, zip));
      if (written) await writeDurably(zipPath, pkg.zip.data);
      if (existing && existing.deletedAt === undefined && existing.zip.sha256 === zip.sha256)
        return { record: existing, written };
      const now = clock();
      const record: PatchPackageRecord = {
        id,
        kind: "patch-package",
        ticket: pkg.ticket,
        ...(pkg.repo === undefined ? {} : { repo: pkg.repo }),
        recipient: {
          ...(recipient.mmUserId === undefined ? {} : { mmUserId: recipient.mmUserId }),
          source: recipient.source,
          ...(recipient.unresolved === undefined ? {} : { unresolved: recipient.unresolved }),
        },
        baseCommit: pkg.baseCommit,
        ...(pkg.resultCommit === null ? {} : { resultCommit: pkg.resultCommit }),
        files: pkg.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
        zip,
        createdAt: now,
        expiresAt: now + settings.days * DAY_MS,
      };
      try {
        await map.put(id, record);
      } catch (e) {
        if (!existing) await rm(dir, { recursive: true, force: true });
        throw e;
      }
      return { record, written };
    },

    async cleanup(options = {}) {
      const now = options.now ?? clock();
      const batch = options.batchSize ?? settings.cleanupBatch;
      const rows = await map.all();
      const due = rows
        .filter((row) => row.deletedAt === undefined && row.expiresAt <= now)
        .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1))
        .slice(0, batch);
      const result: CleanupResult = { deleted: 0, purged: 0, refused: [] };
      for (const row of due) {
        const current = await map.get(row.id);
        if (!current || current.deletedAt !== undefined || current.expiresAt > now) continue;
        let removed = false;
        try {
          removed = await removePackageDirectory(row.id);
        } catch (e) {
          if (!(e instanceof PatchPackageError)) throw e;
        }
        if (!removed) {
          log(`[zq patch retention] refused to delete the directory of ${JSON.stringify(row.id)}`);
          result.refused.push(row.id);
          continue;
        }
        await map.update(row.id, (value) =>
          value.deletedAt === undefined && value.expiresAt <= now ? { ...value, deletedAt: now } : value,
        );
        result.deleted++;
      }
      const lapsed = (row: PatchPackageRecord) =>
        row.deletedAt !== undefined && row.deletedAt + settings.recordDays * DAY_MS <= now;
      for (const row of rows.filter(lapsed).slice(0, batch)) if (await map.deleteIf(row.id, lapsed)) result.purged++;
      return result;
    },

    async orphans() {
      const rows = await map.all();
      const known = new Set(rows.map((row) => row.id));
      const names = await readdir(tenantDir()).catch((e: unknown) => {
        if (errorCode(e) === "ENOENT") return [];
        throw e;
      });
      const missingZips: string[] = [];
      for (const row of rows)
        if (row.deletedAt === undefined && !(await holdsZip(join(packageDir(row.id), row.zip.name), row.zip)))
          missingZips.push(row.id);
      return {
        orphanDirectories: names.filter((name) => !known.has(name)).sort(),
        missingZips: missingZips.sort(),
      };
    },
  };
}
