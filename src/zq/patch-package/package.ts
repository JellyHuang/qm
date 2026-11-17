import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LFS_COMPARISON_NOTE, refuseUnusableResult, renderXlsxDiff, stemOf, type XlsxWorkbookInput } from "./xlsx.ts";
import { APPLY_CMD, APPLY_PS1, renderReadmes } from "./readme.ts";
import { renderApplyScript, withoutManifestLine, type ScriptData } from "./apply-script.ts";
import { createPackageDir, describeFile, gitBlobId, removeQuietly, sha256Hex, type PackageFile } from "./files.ts";
import { PatchPackageError } from "./settings.ts";
import { packageZip, type PackageZip } from "./zip.ts";
import { assembleChange, type AssembleOptions, type ChangeEntry, type ChangeInput } from "./text.ts";

export interface PatchPackageInput extends ChangeInput {
  repo?: string;
  workbooks?: readonly XlsxWorkbookInput[];
  maxPages?: number;
}

export interface PatchPackage {
  dir: string;
  id: string;
  ticket: string;
  repo?: string;
  manifestPath: string;
  baseCommit: string;
  resultTree: string | null;
  resultCommit: string | null;
  files: (PackageFile & { path: string })[];
  changes: ChangeEntry[];
  zip: PackageZip;
  manifest: Record<string, unknown>;
}

interface Comparison {
  available: boolean;
  reason?: string;
  file?: string;
  note?: string;
  differences?: { total: number; listed: number; complete: boolean };
}

const MANIFEST_SCHEMA = 2;
const GENERATED_BY = "qm zq patch-package 2";

function tooLarge(bytes: number, cap: number): PatchPackageError {
  return new PatchPackageError(
    "too_large",
    `the package is ${bytes} bytes, over the limit of ${cap} (ZQ_PATCH_MAX_PACKAGE_BYTES); ask for another delivery route`,
  );
}

function isoSeconds(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export async function buildPatchPackage(input: PatchPackageInput, options: AssembleOptions): Promise<PatchPackage> {
  const { settings } = options;
  const scratch = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "qm-patch-"));
  let packageDir: string | undefined;
  try {
    const assembled = await assembleChange(input, options, scratch);
    const workbooks = input.workbooks ?? [];
    const stems = workbooks.map((workbook) => stemOf(workbook.result.path));
    if (new Set(stems).size !== stems.length)
      throw new PatchPackageError("bad_input", "the workbook file names must be different");

    const comparisons = new Map<string, Comparison>();
    const comparisonFiles: string[] = [];
    await mkdir(join(scratch, "comparison"));
    for (const [index, workbook] of workbooks.entries()) {
      refuseUnusableResult(workbook.result);
      const entry = assembled.changes.find((c) => c.path === workbook.result.path && c.status !== "D");
      if (!entry) throw new PatchPackageError("bad_input", `${workbook.result.path} is not among the changed files`);
      if (entry.kind === "lfs") {
        comparisons.set(entry.path, { available: false, reason: "lfs", note: LFS_COMPARISON_NOTE });
        continue;
      }
      const name = `comparison/${stems[index]}.diff.md`;
      const rendered = await renderXlsxDiff(join(scratch, name), workbook.result, workbook.fetchPage, {
        ticket: assembled.ticket,
        ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
      });
      comparisons.set(entry.path, {
        available: true,
        file: name,
        differences: { total: rendered.total, listed: rendered.rendered, complete: rendered.complete },
      });
      comparisonFiles.push(name);
    }
    for (const entry of assembled.changes)
      if (entry.kind !== "lfs" && /\.xlsx$/i.test(entry.path) && entry.status !== "D") entry.kind = "xlsx";

    const patchNames = assembled.patch ? ["patches/0001.patch"] : [];
    const payloadNames = assembled.payloads.map((_, i) => `files/${String(i + 1).padStart(4, "0")}.dat`);
    const idLines = [
      ...(assembled.patch ? [{ name: patchNames[0] as string, sha: sha256Hex(await readFile(assembled.patch)) }] : []),
      ...assembled.payloads.map((payload, i) => ({ name: payloadNames[i] as string, sha: payload.sha256 })),
    ]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((line) => `${line.name} ${line.sha}\n`)
      .join("");
    const id = `${assembled.ticket}-${sha256Hex(Buffer.from(idLines)).slice(0, 12)}`;
    packageDir = await createPackageDir(settings.outputDir, id);
    const dir = packageDir;
    if (assembled.patch) await mkdir(join(dir, "patches"));
    if (assembled.payloads.length > 0) await mkdir(join(dir, "files"));
    if (comparisonFiles.length > 0) await mkdir(join(dir, "comparison"));
    if (assembled.patch) await copyFile(assembled.patch, join(dir, "patches", "0001.patch"));
    for (const [i, payload] of assembled.payloads.entries())
      await writeFile(join(dir, payloadNames[i] as string), payload.bytes);
    for (const name of comparisonFiles) await copyFile(join(scratch, name), join(dir, name));
    await writeFile(join(dir, "COMMIT_MESSAGE.txt"), assembled.message);
    await writeFile(join(dir, "apply.ps1"), APPLY_PS1);
    await writeFile(join(dir, "apply.cmd"), APPLY_CMD.replace(/\n/g, "\r\n"));

    const changes = assembled.changes.map((entry) => {
      const { payload, ...rest } = entry;
      const comparison = comparisons.get(entry.path);
      return {
        ...rest,
        ...(payload === undefined ? {} : { payload: payloadNames[payload] }),
        ...(comparison ? { comparison } : {}),
      };
    });

    const readmes = renderReadmes({
      id,
      repo: input.repo,
      ticket: assembled.ticket,
      base: input.baseCommit,
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
      changes,
      hasPatch: assembled.patch !== null,
      payloads: assembled.payloads.map((p, i) => ({ file: payloadNames[i] as string, path: p.path })),
    });
    await writeFile(join(dir, "README_CN.txt"), readmes.cn);
    await writeFile(join(dir, "README_EN.txt"), readmes.en);

    const named = [
      ...patchNames.map((name) => ({ name, role: "patch", part: "A" })),
      ...payloadNames.map((name) => ({ name, role: "payload", part: "B" })),
      { name: "COMMIT_MESSAGE.txt", role: "message" },
      ...comparisonFiles.map((name) => ({ name, role: "comparison" })),
      { name: "README_CN.txt", role: "readme", language: "zh" },
      { name: "README_EN.txt", role: "readme", language: "en" },
      { name: "apply.ps1", role: "script", untested: true },
      { name: "apply.cmd", role: "script", untested: true },
    ];
    const described = await Promise.all(named.map((file) => describeFile(dir, file.name)));
    const byName = new Map(described.map((file) => [file.name, file]));

    const scriptData: ScriptData = {
      id,
      base: input.baseCommit,
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
      authorDate: `${isoSeconds(assembled.date).slice(0, 19)}+00:00`,
      messageFile: "COMMIT_MESSAGE.txt",
      textPatches: patchNames,
      packageFiles: [...patchNames, ...payloadNames, "COMMIT_MESSAGE.txt"].map((name) => ({
        blob: (byName.get(name) as PackageFile).gitBlob,
        name,
      })),
      lfsFiles: assembled.payloads.map((payload, i) => ({
        status: payload.status,
        mode: payload.mode,
        sha256: payload.sha256,
        baseBlob: payload.baseBlob,
        payload: payloadNames[i] as string,
        path: payload.path,
      })),
      paths: [
        ...new Set(assembled.changes.flatMap((entry) => (entry.oldPath ? [entry.oldPath, entry.path] : [entry.path]))),
      ],
    };
    const bareScript = renderApplyScript(scriptData);
    const scriptBytes = Buffer.from(bareScript);
    const scriptBlob = gitBlobId(scriptBytes);

    const manifest: Record<string, unknown> = {
      schema: MANIFEST_SCHEMA,
      kind: "patch-package",
      id,
      generatedBy: GENERATED_BY,
      generatedAt: isoSeconds(assembled.date),
      ...(input.repo ? { repo: input.repo } : {}),
      ticket: assembled.ticket,
      subject: assembled.subject,
      source: input.change.kind === "diff" ? "git-mcp-diff" : "working-copy",
      base: { commit: input.baseCommit },
      message: {
        file: "COMMIT_MESSAGE.txt",
        sha256: (byName.get("COMMIT_MESSAGE.txt") as PackageFile).sha256,
        gitBlob: (byName.get("COMMIT_MESSAGE.txt") as PackageFile).gitBlob,
      },
      author: {
        name: settings.authorName,
        email: settings.authorEmail,
        date: scriptData.authorDate,
        role: "package marker; not the author of the commit unless --keep-bot-author is used",
      },
      applyDefaults: {
        mode: "one commit on the current branch of the repository whose root holds the package folder",
        repo: "the folder that contains the package folder, which must be the root of the working tree; --repo DIR applies to the repository that contains DIR instead and the package folder may then be anywhere",
        packageFolder:
          "stays untracked in the repository and is never committed; .gitignore and .git/info/exclude are never edited; the script refuses when files of it are tracked or when the change touches a path inside it; it can be deleted after a successful run, the script never deletes anything",
        author: "the person who applies the package (local git user.name and user.email)",
        committer: "the person who applies the package",
        flags: {
          "--dry-run": "apply, show the result, then undo everything",
          "--new-branch": `build the commit on the local branch qm/${id} from the base commit in a temporary worktree; the current branch is not touched`,
          "--keep-bot-author": "keep the package author as the author of the commit; the applier stays the committer",
        },
        undo: "git reset --keep <original HEAD printed by the script>, only before the commit is pushed",
      },
      commits: 1,
      parts: [
        ...(assembled.patch
          ? [
              {
                id: "A",
                kind: "mbox",
                files: patchNames,
                applyWith: "git am --3way --keep-cr --keep-non-patch",
                resultTree: assembled.resultTree,
              },
            ]
          : []),
        ...(assembled.payloads.length > 0
          ? [
              {
                id: "B",
                kind: "lfs-files",
                files: payloadNames,
                applyWith: "copy, git add, git commit",
              },
            ]
          : []),
      ],
      files: [
        ...named.map((file) => {
          const done = byName.get(file.name) as PackageFile;
          return {
            name: file.name,
            role: file.role,
            ...("part" in file ? { part: file.part } : {}),
            ...("language" in file ? { language: file.language } : {}),
            ...("untested" in file ? { untested: true } : {}),
            bytes: done.bytes,
            sha256: done.sha256,
            gitBlob: done.gitBlob,
          };
        }),
        {
          name: "apply.sh",
          role: "script",
          bytes: scriptBytes.length,
          sha256: sha256Hex(scriptBytes),
          gitBlob: scriptBlob,
          hashExcludes: "the line that starts with QM_MANIFEST_BLOB=",
        },
      ],
      changes,
      selfCheck: {
        scriptGitBlob: scriptBlob,
        scriptSha256: sha256Hex(scriptBytes),
        scriptExcludes: "the line that starts with QM_MANIFEST_BLOB=, which holds the git blob id of this manifest",
        limits:
          "apply.sh checks this manifest and itself against each other and the other files against their blob ids. That detects damage and incomplete downloads. It does not stop someone who changes the files and the script together.",
      },
      instructions: {
        sh: "sh <package folder>/apply.sh [--dry-run] [--new-branch] [--keep-bot-author] [--repo <dir-of-your-clone>], run with the package folder inside the root of your repository",
        cmd: "<package folder>\\apply.cmd [--dry-run] [--new-branch] [--keep-bot-author] (UNTESTED); a double-click works and waits for a key at the end",
        powershell:
          "powershell -NoProfile -ExecutionPolicy Bypass -File .\\<package folder>\\apply.ps1 [-DryRun] [-NewBranch] [-KeepBotAuthor] [-Repo <absolute clone dir>] (UNTESTED)",
        manual: "see the last section of README_EN.txt (English) or README_CN.txt (Chinese)",
      },
      verified: {
        partA: assembled.patch
          ? "git am --3way --keep-cr --keep-non-patch onto a scratch repository at the base commit gave the intended tree and message"
          : "no text part",
        partB: assembled.payloads.length
          ? "payload sha256 and size recorded; the pointer is produced on the developer machine by git-lfs and checked by apply.sh"
          : "no LFS part",
      },
      untested: ["apply.ps1", "apply.cmd"],
      warnings: assembled.warnings,
    };
    const manifestPath = join(dir, "manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(manifestPath, manifestBytes);
    const script = renderApplyScript(scriptData, gitBlobId(manifestBytes));
    if (withoutManifestLine(script) !== bareScript)
      throw new PatchPackageError("verify_failed", "the apply script changed when the manifest id was added");
    const scriptPath = join(dir, "apply.sh");
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);

    const names = [...described.map((file) => file.name), "apply.sh", "manifest.json"].sort();
    const files = await Promise.all(
      names.map(async (name) => ({
        ...(await describeFile(dir, name)),
        path: join(dir, name),
      })),
    );
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total > settings.maxPackageBytes) throw tooLarge(total, settings.maxPackageBytes);
    const zip = packageZip(
      id,
      await Promise.all(files.map(async (file) => ({ name: file.name, bytes: await readFile(file.path) }))),
    );
    if (zip.bytes > settings.maxPackageBytes) throw tooLarge(zip.bytes, settings.maxPackageBytes);
    return {
      dir,
      id,
      ticket: assembled.ticket,
      ...(input.repo ? { repo: input.repo } : {}),
      manifestPath,
      baseCommit: input.baseCommit,
      resultTree: assembled.resultTree,
      resultCommit: assembled.resultCommit,
      files,
      changes: assembled.changes,
      zip,
      manifest,
    };
  } catch (e) {
    if (packageDir) await removeQuietly(packageDir);
    throw e;
  } finally {
    await removeQuietly(scratch);
  }
}
