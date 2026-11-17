import type { BlobStore } from "./blobs.ts";
import type { Repos } from "./repos.ts";
import type { GitRunner } from "./runner.ts";
import { resolveRev } from "./tools/commit-format.ts";
import { parseRawDiff } from "./tools/raw-diff.ts";
import { lookupEntry, resolveCommit } from "./tools/tree.ts";
import type { ToolLimits } from "./tools/types.ts";
import { runXlsxWorker } from "./tools/xlsx-run.ts";
import { GitDenied, checkOid, checkPath, checkRepo, type GitRepo } from "./validate.ts";

export interface DiagnoseInput {
  repo: string;
  path?: string;
  baseRef?: string;
  headRef?: string;
  baseBlob?: string;
  headBlob?: string;
  ref?: string;
}

interface DiagnoseDeps {
  repos: Repos;
  runner: GitRunner;
  blobs: BlobStore;
  limits: ToolLimits;
}

const HEX = /^[0-9a-f]{7,40}$/;

async function blobFromPrefix(
  reader: { git: (repo: GitRepo, args: readonly string[]) => ReturnType<GitRunner["run"]> },
  repo: GitRepo,
  ref: string,
  path: string | undefined,
  value: string,
): Promise<string> {
  const commitHint =
    "this value is a commit, not a blob id: use the ref form ref:<path>:<base>:<head> or take the blob id from `git ls-tree <ref> <path>`";
  if (/^[0-9a-f]{40}$/.test(value)) {
    const type = await reader.git(repo, ["cat-file", "-t", value]).then(
      (out) => out.stdout.toString("utf8").trim(),
      () => "blob",
    );
    if (type === "commit" || type === "tree")
      throw new GitDenied("not_a_blob", `${value.slice(0, 12)} is a ${type}; ${commitHint}`);
    return value;
  }
  if (!HEX.test(value)) throw new GitDenied("bad_oid", "an object id is 7 to 40 lowercase hex digits");
  if (path === undefined)
    throw new GitDenied(
      "bad_oid",
      "a short object id can only be resolved with the path of the file: give the path (and the ref) or the full 40 hex object id, which `git ls-tree <ref> <path>` prints",
    );
  const commit = await resolveCommit(reader, repo, ref);
  const history = await reader.git(repo, [
    "log",
    "--format=%H",
    "-z",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--end-of-options",
    commit,
    "--",
    checkPath(path),
  ]);
  const oids = new Set(
    parseRawDiff(history.stdout.toString("utf8").replaceAll("\0\n", "\0")).flatMap((change) =>
      [change.oldOid, change.newOid].filter((oid): oid is string => !!oid && oid.startsWith(value)),
    ),
  );
  if (
    oids.size === 0 &&
    (await resolveRev(reader, repo, `${value}^{commit}`).then(
      () => true,
      () => false,
    ))
  )
    throw new GitDenied("not_found", `${value} matches no blob of ${path} but is a commit; ${commitHint}`);
  if (oids.size !== 1)
    throw new GitDenied(
      "not_found",
      `${oids.size} blobs of that path start with ${value}; give more digits or the full object id`,
    );
  return [...oids][0] ?? "";
}

export async function diagnoseXlsx(
  deps: DiagnoseDeps,
  input: DiagnoseInput,
  signal: AbortSignal = new AbortController().signal,
): Promise<Record<string, unknown>[]> {
  const repo = checkRepo(input.repo);
  const reader = {
    git: (name: GitRepo, args: readonly string[]) => deps.runner.run(deps.repos.dir(name), args, { signal }),
  };
  await deps.repos.ensure(repo);
  let baseOid: string;
  let headOid: string;
  if (input.baseBlob && input.headBlob) {
    const ref = input.ref ?? "main";
    baseOid = await blobFromPrefix(reader, repo, ref, input.path, input.baseBlob);
    headOid = await blobFromPrefix(reader, repo, ref, input.path, input.headBlob);
  } else if (input.path && input.baseRef && input.headRef) {
    const path = checkPath(input.path);
    const entries = await Promise.all(
      [input.baseRef, input.headRef].map(async (ref) =>
        lookupEntry(reader, repo, await resolveCommit(reader, repo, ref), path),
      ),
    );
    baseOid = entries[0]?.oid ?? "";
    headOid = entries[1]?.oid ?? "";
  } else {
    throw new GitDenied(
      "bad_arguments",
      "give repo with path, baseRef and headRef, or repo with baseBlob and headBlob",
    );
  }
  checkOid(baseOid);
  checkOid(headOid);
  const lines = await deps.blobs.withBlobs(
    repo,
    [baseOid, headOid],
    async (paths, stats) => {
      const result = await runXlsxWorker(
        {
          baseFile: paths.get(baseOid) ?? "",
          headFile: paths.get(headOid) ?? "",
          dir: stats.dir ?? "",
          overrides: {},
          sheets: undefined,
          offset: 0,
          limit: 1,
          budget: 1000,
          mode: "diagnose",
        },
        deps.limits,
        stats.signal ?? signal,
      );
      if (result.type !== "diagnostics")
        throw new Error(
          `the diagnostic run ended as ${result.type}${result.type === "unsupported" ? `: ${result.reason}` : ""}`,
        );
      return result.lines;
    },
    { signal, scratch: true },
  );
  return [{ type: "input", repo, baseOid, headOid, sameBlob: baseOid === headOid }, ...lines];
}
