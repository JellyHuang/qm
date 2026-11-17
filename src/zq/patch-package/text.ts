import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "./files.ts";
import { createGitRunner, type GitRunner } from "./git.ts";
import { classifyChanges, createRepoReader, isLfsPointer, type BaseReader, type Classification } from "./lfs.ts";
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

type ChangeSource = { kind: "diff"; result: GitMcpDiffResult } | { kind: "workingDir"; dir: string };

export interface ChangeInput {
  repoDir: string;
  baseCommit: string;
  ticket: string;
  subject: string;
  body?: string;
  change: ChangeSource;
  reader?: BaseReader;
}

export interface AssembleOptions {
  settings: PatchPackageSettings;
  commitDate?: Date;
  tmpRoot?: string;
  observeGit?: (subcommand: string, args: readonly string[]) => void;
}

export interface ChangeEntry {
  path: string;
  oldPath?: string;
  status: string;
  kind: "text" | "binary" | "lfs" | "xlsx";
  part: "A" | "B";
  oldMode: string;
  newMode: string;
  additions: number | null;
  deletions: number | null;
  baseBlob?: string;
  lfs?: { oid: string; size: number };
  payload?: number;
}

interface Payload {
  path: string;
  status: "A" | "M";
  mode: string;
  bytes: Buffer;
  sha256: string;
  baseBlob: string;
}

export interface Assembled {
  ticket: string;
  subject: string;
  message: string;
  date: Date;
  patch: string | null;
  resultTree: string | null;
  resultCommit: string | null;
  changes: ChangeEntry[];
  payloads: Payload[];
  warnings: string[];
}

type RawChange = ReturnType<typeof parseRaw>[number];

const ZERO_OID = /^0+$/;
const SUBMODULE_MODE = "160000";
const REGULAR_MODES = ["100644", "100755"];
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
      throw new PatchPackageError("unsupported", `${file.path} is a ${file.kind}; use the working copy route`);
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

function refuseSubmodules(changes: readonly RawChange[]): void {
  for (const change of changes)
    if (change.oldMode === SUBMODULE_MODE || change.newMode === SUBMODULE_MODE)
      throw new PatchPackageError("unsupported", `${change.path} is a submodule; this version does not handle those`);
}

async function pointerOids(git: GitRunner, cwd: string, changes: readonly RawChange[]): Promise<Set<string>> {
  const oids = [...new Set(changes.map((c) => c.newOid).filter((oid) => !ZERO_OID.test(oid)))];
  const found = new Set<string>();
  if (oids.length === 0) return found;
  const listing = (await git.run("cat-file", ["--batch-check"], { cwd, stdin: `${oids.join("\n")}\n` })).toString(
    "utf8",
  );
  for (const line of listing.split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (!oid || type !== "blob" || Number(size) > 1024) continue;
    if (isLfsPointer(await git.run("cat-file", ["blob", oid], { cwd }))) found.add(oid);
  }
  return found;
}

function entryOf(change: RawChange, numstat: ReturnType<typeof parseNumstat>): Omit<ChangeEntry, "kind" | "part"> {
  const stats = numstat.get(change.path) ?? { additions: null, deletions: null };
  return {
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    status: change.status,
    oldMode: change.oldMode,
    newMode: change.newMode,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

export async function assembleChange(
  input: ChangeInput,
  options: AssembleOptions,
  scratch: string,
): Promise<Assembled> {
  const { settings } = options;
  validateIdentity(settings.authorName, settings.authorEmail);
  const ticket = validateTicket(settings, input.ticket);
  const { subject, body } = validateMessage(settings, input.subject, input.body);
  if (!/^[0-9a-f]{40}$/.test(input.baseCommit))
    throw new PatchPackageError("bad_input", "the base commit must be a full lowercase commit id");
  if (input.change.kind === "diff") refuseUnusableDiff(input.change.result, input.baseCommit);

  const git = createGitRunner({ name: settings.authorName, email: settings.authorEmail }, options.observeGit);
  const date = options.commitDate ?? new Date();
  const stamp = `${Math.floor(date.getTime() / 1000)} +0000`;
  const dateEnv = { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  const message = commitMessage(ticket, subject, body);

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
  const stage = async () => {
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
  };
  await stage();

  const diffRaw = async () =>
    parseRaw(await git.run("diff", ["--cached", "--raw", "-z", "--no-abbrev", "-M", input.baseCommit], { cwd: build }));

  const everything = await diffRaw();
  if (everything.length === 0) throw new PatchPackageError("empty", "the change is empty, there is nothing to package");
  for (const change of everything)
    if (/[\u0000-\u001f]/.test(change.path) || /[\u0000-\u001f]/.test(change.oldPath ?? ""))
      throw new PatchPackageError("unsupported", "paths with control characters are not supported");
  refuseSubmodules(everything);
  const numstat = parseNumstat(
    await git.run("diff", ["--cached", "--numstat", "-z", "-M", input.baseCommit], { cwd: build }),
  );
  const pointers = await pointerOids(git, build, everything);
  const classes = await classifyChanges(
    git,
    input.reader ?? createRepoReader(git, input.repoDir, input.baseCommit),
    everything.map((change) => ({
      path: change.path,
      ...(change.oldPath ? { oldPath: change.oldPath } : {}),
      status: change.status,
      binary: (numstat.get(change.path) ?? { additions: null }).additions === null,
      sameBlob: change.oldOid === change.newOid,
      newPointer: pointers.has(change.newOid),
    })),
    scratch,
  );
  const warnings = [...classes.values()].flatMap((c) => c.warnings);

  const isPayload = (change: RawChange, cls: Classification | undefined) =>
    cls?.kind === "lfs" && change.status !== "D" && change.oldOid !== change.newOid;
  const payloadChanges = everything.filter((change) => isPayload(change, classes.get(change.path)));
  for (const change of payloadChanges) {
    if (!["A", "M", "R"].includes(change.status) || !REGULAR_MODES.includes(change.newMode))
      throw new PatchPackageError(
        "unsupported",
        `${change.path} is a type change or a link; LFS files must be regular files`,
      );
  }
  if (payloadChanges.length > 0 && input.change.kind === "diff")
    throw new PatchPackageError(
      "unsupported",
      `${payloadChanges[0]?.path} is a Git LFS file; get_diff carries no content for it, use the working copy route`,
    );

  let textChanges = everything;
  if (payloadChanges.length > 0) {
    await git.run("read-tree", [input.baseCommit], { cwd: build });
    await git.run("add", ["-A", "--", ".", ...payloadChanges.map((change) => `:(exclude,literal)${change.path}`)], {
      cwd: (input.change as { dir: string }).dir,
      env: { GIT_DIR: join(build, ".git"), GIT_WORK_TREE: (input.change as { dir: string }).dir },
    });
    textChanges = await diffRaw();
  }

  const payloads: Payload[] = [];
  const entries: ChangeEntry[] = [];
  for (const change of everything) {
    const cls = classes.get(change.path) as Classification;
    const payloadIndex = payloadChanges.indexOf(change);
    if (payloadIndex < 0) {
      entries.push({ ...entryOf(change, numstat), kind: cls.kind, part: "A" });
      continue;
    }
    const bytes = await git.run("cat-file", ["blob", change.newOid], { cwd: build });
    const status = change.status === "M" ? "M" : "A";
    payloads.push({
      path: change.path,
      status,
      mode: change.newMode,
      bytes,
      sha256: sha256Hex(bytes),
      baseBlob: cls.baseBlob ?? "0".repeat(40),
    });
    entries.push({
      ...entryOf(change, numstat),
      additions: null,
      deletions: null,
      kind: "lfs",
      part: "B",
      ...(cls.baseBlob ? { baseBlob: cls.baseBlob } : {}),
      lfs: { oid: sha256Hex(bytes), size: bytes.length },
      payload: payloads.length - 1,
    });
  }
  for (const change of textChanges) {
    if (payloads.some((payload) => payload.path === change.path || payload.path === change.oldPath))
      throw new PatchPackageError("verify_failed", `${change.path} is in both parts of the package`);
  }
  const textPaths = new Set(textChanges.map((change) => change.path));
  for (const entry of entries)
    if (entry.part === "A" && !textPaths.has(entry.path) && entry.status !== "D")
      throw new PatchPackageError("verify_failed", `${entry.path} is missing from the text part`);

  let patch: string | null = null;
  let resultTree: string | null = null;
  let resultCommit: string | null = null;
  if (textChanges.length > 0) {
    const messageFile = join(scratch, "message.txt");
    await writeFile(messageFile, message);
    await git.run("commit", ["--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-q", "-F", messageFile], {
      cwd: build,
      env: dateEnv,
    });
    resultCommit = (await git.run("rev-parse", ["HEAD"], { cwd: build })).toString("utf8").trim();
    resultTree = (await git.run("rev-parse", ["HEAD^{tree}"], { cwd: build })).toString("utf8").trim();
    const patchDir = join(scratch, "patches");
    await mkdir(patchDir);
    await git.run(
      "format-patch",
      ["--binary", "--full-index", "--no-signature", "-M", "-o", patchDir, `${input.baseCommit}..${resultCommit}`],
      { cwd: build, env: dateEnv },
    );
    patch = join(scratch, "0001.patch");
    const names = (await readdir(patchDir)).filter((file) => file.endsWith(".patch"));
    if (names.length !== 1)
      throw new PatchPackageError("git_failed", "git format-patch did not produce one patch file");
    await rename(join(patchDir, names[0] as string), patch);

    const verify = await init("verify");
    const sparse = [...new Set(textChanges.flatMap((c) => [c.path, ...(c.oldPath ? [c.oldPath] : [])]))].map(
      sparsePattern,
    );
    await writeFile(join(verify, ".git", "info", "sparse-checkout"), `${sparse.join("\n")}\n`);
    await git.run("read-tree", ["-m", "-u", input.baseCommit], { cwd: verify, env: SPARSE_ENV });
    await git.run("update-ref", ["--no-deref", "HEAD", input.baseCommit], { cwd: verify });
    await git
      .run("am", ["--3way", "--keep-cr", "--keep-non-patch", patch], { cwd: verify, env: SPARSE_ENV })
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
  }
  return { ticket, subject, message, date, patch, resultTree, resultCommit, changes: entries, payloads, warnings };
}
