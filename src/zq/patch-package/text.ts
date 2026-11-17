import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRunner, type GitRunner } from "./git.ts";
import {
  createPackageDir,
  describeFile,
  listPackage,
  removeQuietly,
  writeManifest,
  type PackageFile,
} from "./files.ts";
import {
  PatchPackageError,
  commitMessage,
  validateIdentity,
  validateMessage,
  validateTicket,
  type PatchPackageSettings,
} from "./settings.ts";

export interface GitMcpDiffResult {
  base: string | null;
  head: string;
  files: { kind: string; path: string; status: string; binary?: boolean; unavailable?: string }[];
  diff: string;
  truncated: boolean;
}

type TextChange = { kind: "diff"; result: GitMcpDiffResult } | { kind: "workingDir"; dir: string };

export interface TextPatchInput {
  repoDir: string;
  baseCommit: string;
  ticket: string;
  subject: string;
  body?: string;
  change: TextChange;
}

export interface TextPatchOptions {
  settings: PatchPackageSettings;
  commitDate?: Date;
  tmpRoot?: string;
  observeGit?: (subcommand: string, args: readonly string[]) => void;
}

interface ChangedFile {
  path: string;
  oldPath?: string;
  status: string;
  oldMode: string;
  newMode: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface TextPatchPackage {
  dir: string;
  manifestPath: string;
  baseCommit: string;
  resultCommit: string;
  resultTree: string;
  files: (PackageFile & { path: string })[];
  changes: ChangedFile[];
  manifest: Record<string, unknown>;
}

const ZERO_OID = /^0+$/;
const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_MAX_BYTES = 1024;
const SUBMODULE_MODE = "160000";
const SPARSE_ENV = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.sparseCheckout",
  GIT_CONFIG_VALUE_0: "true",
  GIT_CONFIG_KEY_1: "core.sparseCheckoutCone",
  GIT_CONFIG_VALUE_1: "false",
};

function refuseUnusableDiff(input: GitMcpDiffResult, baseCommit: string): void {
  if (input.truncated)
    throw new PatchPackageError(
      "truncated_diff",
      "the diff from get_diff is truncated; fetch it complete (fetchCompleteDiff) or use the working copy route",
    );
  if (input.base === null || input.base !== baseCommit)
    throw new PatchPackageError("bad_input", "the diff was not computed against the given base commit");
  if (input.diff.length === 0) throw new PatchPackageError("empty", "the diff is empty, there is nothing to package");
  for (const file of input.files) {
    if (file.unavailable !== undefined)
      throw new PatchPackageError("unsupported", `${file.path} was unavailable to the service: ${file.unavailable}`);
    if (file.kind === "submodule" || file.kind === "lfs_pointer")
      throw new PatchPackageError("unsupported", `${file.path} is a ${file.kind}; this version does not handle those`);
    if (file.binary === true)
      throw new PatchPackageError(
        "unsupported",
        `${file.path} is binary; get_diff carries no binary content, use the working copy route`,
      );
    if (file.status === "R")
      throw new PatchPackageError(
        "unsupported",
        `${file.path} is an exact rename; get_diff carries no content for it, use the working copy route`,
      );
  }
}

function parseRaw(raw: Buffer): {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
  path: string;
  oldPath?: string;
}[] {
  const tokens = raw.toString("utf8").split("\0");
  const out: ReturnType<typeof parseRaw> = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(tokens[i] ?? "");
    if (!match) throw new PatchPackageError("git_failed", "unexpected git diff output");
    const [, oldMode = "", newMode = "", oldOid = "", newOid = "", status = ""] = match;
    const twoPaths = status === "R" || status === "C";
    const first = tokens[i + 1] ?? "";
    const second = twoPaths ? (tokens[i + 2] ?? "") : undefined;
    out.push({
      oldMode,
      newMode,
      oldOid,
      newOid,
      status,
      path: second ?? first,
      ...(second ? { oldPath: first } : {}),
    });
    i += twoPaths ? 3 : 2;
  }
  return out;
}

function parseNumstat(raw: Buffer): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = raw.toString("utf8").split("\0");
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < tokens.length && tokens[i];) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i] ?? "");
    if (!match) throw new PatchPackageError("git_failed", "unexpected git numstat output");
    const stats = {
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    };
    if (match[3] === "") {
      out.set(tokens[i + 2] ?? "", stats);
      i += 3;
    } else {
      out.set(match[3] ?? "", stats);
      i += 1;
    }
  }
  return out;
}

function sparsePattern(path: string): string {
  return `/${path.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`;
}

async function refuseLfsAndSubmodules(
  git: GitRunner,
  cwd: string,
  changes: ReturnType<typeof parseRaw>,
): Promise<void> {
  for (const change of changes)
    if (change.oldMode === SUBMODULE_MODE || change.newMode === SUBMODULE_MODE)
      throw new PatchPackageError("unsupported", `${change.path} is a submodule; this version does not handle those`);
  const oids = [...new Set(changes.flatMap((c) => [c.oldOid, c.newOid]).filter((oid) => !ZERO_OID.test(oid)))];
  if (oids.length === 0) return;
  const listing = (await git.run("cat-file", ["--batch-check"], { cwd, stdin: `${oids.join("\n")}\n` })).toString(
    "utf8",
  );
  for (const line of listing.split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (!oid || type !== "blob" || Number(size) > LFS_POINTER_MAX_BYTES) continue;
    const content = (await git.run("cat-file", ["blob", oid], { cwd })).toString("utf8");
    if (content.startsWith(LFS_HEADER)) {
      const paths = changes.filter((c) => c.oldOid === oid || c.newOid === oid).map((c) => c.path);
      throw new PatchPackageError(
        "unsupported",
        `${paths.join(", ")} is a Git LFS pointer; this version does not handle LFS`,
      );
    }
  }
}

export async function buildTextPatchPackage(
  input: TextPatchInput,
  options: TextPatchOptions,
): Promise<TextPatchPackage> {
  const { settings } = options;
  validateIdentity(settings.authorName, settings.authorEmail);
  const ticket = validateTicket(settings, input.ticket);
  const { subject, body } = validateMessage(settings, input.subject, input.body);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.baseCommit))
    throw new PatchPackageError("bad_input", "the base commit must be a full lowercase commit id");
  if (input.change.kind === "diff") refuseUnusableDiff(input.change.result, input.baseCommit);

  const git = createGitRunner({ name: settings.authorName, email: settings.authorEmail }, options.observeGit);
  const date = options.commitDate ?? new Date();
  const stamp = `${Math.floor(date.getTime() / 1000)} +0000`;
  const dateEnv = { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  const message = commitMessage(ticket, subject, body);

  const scratch = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "qm-patch-"));
  let packageDir: string | undefined;
  try {
    const source = (
      await git.run("rev-parse", ["--path-format=absolute", "--git-path", "objects"], { cwd: input.repoDir })
    )
      .toString("utf8")
      .trim();

    const init = async (name: string) => {
      const dir = join(scratch, name);
      await mkdir(dir);
      await git.run("init", ["-q"], { cwd: dir });
      await writeFile(join(dir, ".git", "objects", "info", "alternates"), `${source}\n`);
      await git.run("rev-parse", ["--verify", "--quiet", `${input.baseCommit}^{commit}`], { cwd: dir }).catch(() => {
        throw new PatchPackageError("bad_input", "the base commit is not in the given repository");
      });
      return dir;
    };

    const build = await init("build");
    await git.run("read-tree", [input.baseCommit], { cwd: build });
    await git.run("update-ref", ["--no-deref", "HEAD", input.baseCommit], { cwd: build });

    if (input.change.kind === "diff") {
      const diffFile = join(scratch, "change.diff");
      await writeFile(diffFile, input.change.result.diff);
      await git.run("apply", ["--cached", "--whitespace=nowarn", diffFile], { cwd: build });
    } else {
      await git.run("add", ["-A", "."], {
        cwd: input.change.dir,
        env: { GIT_DIR: join(build, ".git"), GIT_WORK_TREE: input.change.dir },
      });
    }

    const raw = await git.run("diff", ["--cached", "--raw", "-z", "--no-abbrev", "-M", input.baseCommit], {
      cwd: build,
    });
    const rawChanges = parseRaw(raw);
    if (rawChanges.length === 0)
      throw new PatchPackageError("empty", "the change is empty, there is nothing to package");
    for (const change of rawChanges)
      if (/[\u0000-\u001f]/.test(change.path) || /[\u0000-\u001f]/.test(change.oldPath ?? ""))
        throw new PatchPackageError("unsupported", "paths with control characters are not supported");
    await refuseLfsAndSubmodules(git, build, rawChanges);
    const numstat = parseNumstat(
      await git.run("diff", ["--cached", "--numstat", "-z", "-M", input.baseCommit], { cwd: build }),
    );
    const changes: ChangedFile[] = rawChanges.map((change) => {
      const stats = numstat.get(change.path) ?? { additions: null, deletions: null };
      return {
        path: change.path,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        status: change.status,
        oldMode: change.oldMode,
        newMode: change.newMode,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.additions === null,
      };
    });

    const messageFile = join(scratch, "message.txt");
    await writeFile(messageFile, message);
    await git.run("commit", ["--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-q", "-F", messageFile], {
      cwd: build,
      env: dateEnv,
    });
    const resultCommit = (await git.run("rev-parse", ["HEAD"], { cwd: build })).toString("utf8").trim();
    const resultTree = (await git.run("rev-parse", ["HEAD^{tree}"], { cwd: build })).toString("utf8").trim();

    const name = `${ticket}-${resultCommit.slice(0, 12)}`;
    packageDir = await createPackageDir(settings.outputDir, name);
    await git.run(
      "format-patch",
      ["--binary", "--full-index", "--no-signature", "-M", "-o", packageDir, `${input.baseCommit}..${resultCommit}`],
      { cwd: build, env: dateEnv },
    );
    const patchNames = (await listPackage(packageDir)).filter((file) => file.endsWith(".patch"));
    if (patchNames.length === 0) throw new PatchPackageError("git_failed", "git format-patch produced no patch file");

    const verify = await init("verify");
    const sparse = [...new Set(rawChanges.flatMap((c) => [c.path, ...(c.oldPath ? [c.oldPath] : [])]))].map(
      sparsePattern,
    );
    await writeFile(join(verify, ".git", "info", "sparse-checkout"), `${sparse.join("\n")}\n`);
    await git.run("read-tree", ["-m", "-u", input.baseCommit], { cwd: verify, env: SPARSE_ENV });
    await git.run("update-ref", ["--no-deref", "HEAD", input.baseCommit], { cwd: verify });
    await git
      .run("am", ["--3way", "--keep-cr", ...patchNames.map((file) => join(packageDir as string, file))], {
        cwd: verify,
        env: SPARSE_ENV,
      })
      .catch((e: unknown) => {
        throw new PatchPackageError("verify_failed", `git am --3way did not accept the patch: ${(e as Error).message}`);
      });
    const appliedTree = (await git.run("rev-parse", ["HEAD^{tree}"], { cwd: verify })).toString("utf8").trim();
    if (appliedTree !== resultTree)
      throw new PatchPackageError("verify_failed", "applying the patch to the base commit gave a different tree");
    const appliedMessage = (await git.run("cat-file", ["commit", "HEAD"], { cwd: verify })).toString("utf8");
    if (!appliedMessage.endsWith(`\n\n${message}`))
      throw new PatchPackageError(
        "verify_failed",
        "applying the patch to the base commit gave a different commit message",
      );

    const files = await Promise.all(patchNames.map((file) => describeFile(packageDir as string, file)));
    const manifest = {
      schema: 1,
      kind: "text-patch",
      ticket,
      subject,
      base: { commit: input.baseCommit },
      result: { tree: resultTree },
      author: { name: settings.authorName, email: settings.authorEmail },
      commitDate: new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString(),
      source: input.change.kind === "diff" ? "git-mcp-diff" : "working-copy",
      files,
      changes,
      apply: `git am --3way --keep-cr ${patchNames.join(" ")}`,
      verified: "git am --3way onto a fresh copy of the base commit gave the intended tree",
    };
    const manifestPath = await writeManifest(packageDir, manifest);
    return {
      dir: packageDir,
      manifestPath,
      baseCommit: input.baseCommit,
      resultCommit,
      resultTree,
      files: files.map((file) => ({ ...file, path: join(packageDir as string, file.name) })),
      changes,
      manifest,
    };
  } catch (e) {
    if (packageDir) await removeQuietly(packageDir);
    throw e;
  } finally {
    await removeQuietly(scratch);
  }
}
