# Patch packages (library)

Status: library only. Nothing in QM calls it, no agent tool exposes it, no delivery exists, and nothing is switched on. The builder also produces the deterministic zip (step 4b, below); keeping the zip and its record is `docs/zq/patch-package-retention.md`, off by default and not wired into startup. It implements the "Patch packages" decision in `gitlab-mcp-v1.md`: QM never pushes, never opens a merge request and never writes to any GitLab remote; it hands the responsible person a package that they apply and commit themselves. The format is the one of `docs/zq-patch-package-phase4-design.md` (on `oa/spike-git`), as changed by the PM on 2026-11-17: the applier is author and committer, the commit goes on the current branch by default, and the AI marking is the trailer `AI-Generated: true`.

Everything is local. The code makes no network access, holds no credentials and runs only the git subcommands in `ALLOWED_GIT_SUBCOMMANDS` (`src/zq/patch-package/git.ts`): `init`, `rev-parse`, `read-tree`, `update-ref`, `add`, `apply`, `diff`, `cat-file`, `commit`, `format-patch`, `am`, `check-attr`. There is no `push`, `fetch`, `clone` or `remote`; scratch repositories are created with `git init` and borrow objects from the source repository through `objects/info/alternates`, so no remote can exist in them. The environment sets `GIT_ALLOW_PROTOCOL=none`, an empty global and system config and no hooks. Blob ids are computed in process (`gitBlobId`, tested against `git hash-object --no-filters`), so `hash-object` is not on the list.

## Building a package

```ts
buildPatchPackage(
  { repoDir, baseCommit, ticket, subject, body, repo?, change, reader?, workbooks?, maxPages? },
  { settings, commitDate?, tmpRoot?, observeGit? },
);
```

`repoDir` is a local repository (or worktree) that contains `baseCommit` (a full commit id). `change` is one of:

- `{ kind: "workingDir", dir }`: the contents of `dir` become the new tree. Files missing from `dir` are deletions, so `dir` must be a full working copy of the repository. `.gitignore` rules of `dir` apply to untracked files. Unchanged Git LFS files must be there as their pointer text (or be byte-identical to the base), as a checkout without smudge produces them.
- `{ kind: "diff", result }`: a `get_diff` result for explicit paths. It is applied to the base tree with `git apply --cached`. Packages with a Git LFS part need the working copy route (get_diff carries no file content).

`reader` is the `BaseReader` (`stat(path)`, `bytes(path)`) used for the `.gitattributes` chain and the base blob of every changed path. The default reads the objects of `repoDir`; `createServiceReader(readFile)` in `reader.ts` is the adapter over the git MCP `read_file` tool.

Steps: validate the ticket and message; stage the change in a scratch repository; refuse an empty change, submodules (mode 160000) and paths with control characters; decide for each path whether it is `text`, `binary` or `lfs` (next section); commit the text part with the message below; `git format-patch --binary --full-index --no-signature -M`; verify by `git am --3way --keep-cr --keep-non-patch` onto a second scratch repository at the base commit and compare the resulting tree and commit message with the intended ones; check that no path is in both parts; write the package, the manifest, the README and the scripts; refuse when the package is over `ZQ_PATCH_MAX_PACKAGE_BYTES` (first the sum of the file sizes, then the real zip). Scratch directories are always removed; the package directory is removed on any failure.

The verification checks out only the touched paths (sparse checkout), so a huge repository costs only the changed files.

Commit message, exactly:

```
<subject>

<body>

Ticket: <ticket id>
AI-Generated: true
```

An empty body leaves out the body paragraph. The subject and body must not contain `Ticket:` or `AI-Generated:` lines, the subject must not contain control characters, the body only newlines and tabs. `AI-Generated: true` is the only AI marking, it lives in the message only (no `Co-authored-by`), and it is a single constant (`AI_TRAILER`).

### How a path becomes `lfs`

`classifyChanges` (`lfs.ts`) writes the `.gitattributes` files of the base commit that sit on the path of every changed file (root and nested directories, read through the reader) into a scratch repository that has no `.git/info/attributes`, and runs `git check-attr -z --stdin filter` with `core.ignorecase` set to false and to true. Then:

| Rule `filter`                               | Base blob                 | Result                                                                   |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `lfs`                                       | pointer                   | `lfs`                                                                    |
| `lfs`                                       | not a pointer, or no base | `lfs`, with a warning that it will be stored as a pointer when committed |
| `unset`, `unspecified`                      | pointer                   | refused, `lfs_attribute_mismatch`                                        |
| `unset`, `unspecified`                      | not a pointer             | `text` or `binary` by content                                            |
| any other value                             | any                       | refused, `unsupported_filter`                                            |
| the two ignorecase runs differ              | any                       | refused, `attributes_case_dependent`                                     |
| the package changes a `.gitattributes` file | any                       | refused, `attributes_changed`                                            |

A new file that already holds a pointer is refused (`lfs_pointer_content` when the rules say LFS, `lfs_attribute_mismatch` otherwise). Submodules stay refused. A pointer is a blob of at most 1024 bytes that starts with `version https://git-lfs.github.com/spec/v1`.

LFS deletions, pure renames and mode changes (same blob) stay in the text part. An added or content-changed LFS file goes to part B; a rename with changed content is a deletion of the old path (part A) plus an addition of the new path (part B).

### Exact base bytes

`createServiceReader(readFile, { chunkBytes? })` assembles a file from `read_file` byte ranges (UTF-8 text content, or base64 for binary), trims a trailing U+FFFD at a chunk end when more bytes follow and continues at the byte count it kept, hashes the result as a git blob and refuses when it differs from the service `oid` (`oid_mismatch`). A text file that is not valid UTF-8 is refused (`not_utf8`, PM decision 8; reconsider after the first real repository run). An LFS pointer is rebuilt from `lfsOid` and `lfsSize` and checked against the blob `oid` in the same way. The adapter is not wired to a service; tests use a fake `readFile`.

### Package layout

```
<outputDir>/<ticket>-<12 hex>/
  README.txt                 Chinese and English, generated
  manifest.json              schema 2
  COMMIT_MESSAGE.txt         the exact commit message
  apply.sh                   POSIX sh, the script that applies the package
  apply.ps1, apply.cmd       wrappers around the sh of Git for Windows, UNTESTED
  patches/0001.patch         part A, the git format-patch mbox (absent when only LFS files change)
  files/0001.dat ...         part B, the new bytes of each LFS file (absent when there is none)
  comparison/<name>.diff.md  role comparison, only for non-LFS workbooks with a diff_xlsx result
```

The directory name is the ticket and the first 12 hex characters of the sha256 over the sorted lines `<name> <sha256>` of the patch and payload files: the same inputs give the same id. The same inputs and `commitDate` give a byte-identical package (patch, payloads, manifest, script).

### The zip

`PatchPackage.zip` is `{ name, sha256, bytes, data }`: the package as one zip file named `<id>.zip` (`src/zq/patch-package/zip.ts`, a minimal writer on `node:zlib.crc32`; no dependency was added, because core has no zip library and `fflate` belongs to the `zq-git-mcp` plugin package, which core must not import). The zip is built in memory after the package directory is complete, and nothing is written to disk by the builder for it.

- Entries are `<id>/<name>` for every file of the package (the directory listing of the layout above, including `manifest.json` and `apply.sh`), sorted by the bytes of the name, forward slashes only, no absolute or `..` names (a bad name is refused).
- Entries are STORED (method 0, no compression), with the fixed time 1980-01-01 00:00:00, the UTF-8 name flag, no extra fields, no data descriptors, no zip64 and no comments. Unix permissions are in the external attributes (version made by 3, unix): `apply.sh` is `0755`, every other file `0644`. Stored entries make the bytes independent of the zlib version, so the sha256 told to a recipient can always be reproduced, and make the cheap size pre-check exact. The cost is no compression (a large text patch is not shrunk); a package over 4 GiB or 65534 entries is refused.
- The same inputs and `commitDate` give the same zip, byte for byte (tested: two builds, two output directories, identical sha256 and bytes).
- Tested: `unzip -t` and Python `zipfile.testzip()` accept it, the unzipped tree is byte-identical (CRLF text, binary, `apply.cmd` with CRLF) with `apply.sh` executable, and `apply.sh` run from the unzipped tree against a real throwaway clone makes the one commit with every byte intact.

### Manifest, schema 2

Top level fields: `schema` (2), `kind` (`patch-package`), `id`, `generatedBy`, `generatedAt`, `repo` (if given), `ticket`, `subject`, `source` (`git-mcp-diff` or `working-copy`), `base.commit`, `message` (`file`, `sha256`, `gitBlob`), `author` (`name`, `email`, `date`, `role`: the QM identity is a marker inside the package, not the author of the applied commit), `applyDefaults` (the applier is author and committer; the flags; the undo line), `commits` (1), `parts[]` (`id` A or B, `kind`, `files`, `applyWith`, `resultTree` for A), `files[]` (`name`, `role`, `part`, `untested`, `bytes`, `sha256`, `gitBlob`), `changes[]`, `selfCheck`, `instructions`, `verified`, `untested`, `warnings`.

`changes[]`: `path`, `oldPath`, `status`, `kind` (`text`, `binary`, `lfs`, `xlsx`), `part`, `oldMode`, `newMode`, `additions`, `deletions`, and for part B `payload`, `baseBlob` (the pointer blob at the base, absent for a new file) and `lfs` (`oid` = sha256 of the new file, `size`); `comparison` for workbooks. It holds no absolute paths, no environment values and no credentials.

Schema 1 to 2, every field (nothing reads schema 1; no migration, no table or API change):

| Schema 1 field                                                                            | Schema 2                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema: 1`, `kind: "text-patch"` or `"xlsx"`                                             | `schema: 2`, `kind: "patch-package"` (one kind; workbooks are `changes[].comparison`)                                                                                                         |
| `ticket`, `subject`, `base.commit`                                                        | kept                                                                                                                                                                                          |
| `source`                                                                                  | kept (`git-mcp-diff` or `working-copy`)                                                                                                                                                       |
| `author` (`name`, `email`)                                                                | kept as a package marker, gains `date` (from `commitDate`) and `role`                                                                                                                         |
| `commitDate`                                                                              | moved to `author.date`                                                                                                                                                                        |
| `result.tree`                                                                             | moved to `parts[A].resultTree`; absent for an LFS-only package                                                                                                                                |
| `files[]` (`name`, `sha256`, `bytes`)                                                     | kept, extended with `role`, `part`, `gitBlob`, `untested`; lists every file except the manifest                                                                                               |
| `changes[]` (`path`, `oldPath`, `status`, `oldMode`, `newMode`, `additions`, `deletions`) | kept                                                                                                                                                                                          |
| `changes[].binary`                                                                        | replaced by `changes[].kind` (`text`, `binary`, `lfs`, `xlsx`)                                                                                                                                |
| `apply` (string)                                                                          | replaced by `instructions` and `applyDefaults`                                                                                                                                                |
| `verified` (string)                                                                       | now an object (`partA`, `partB`)                                                                                                                                                              |
| xlsx `workbooks[]` (`path`, `kind`, `base`, `head`, `workbook`, `diff`, `differences`)    | dropped: the workbook is a normal change; `changes[].comparison` holds `available`, `file`, `differences` (`total`, `listed`, `complete`); `base` and `head` refs live in the comparison file |
| new                                                                                       | `id`, `generatedBy`, `generatedAt`, `repo`, `message`, `commits`, `parts[]`, `selfCheck`, `untested`, `warnings`; per change `part`, `payload`, `baseBlob`, `lfs`                             |

Self-check: `apply.sh` embeds the git blob id of `manifest.json` on one line (`QM_MANIFEST_BLOB=`), and the manifest records the git blob id and sha256 of `apply.sh` computed over the script without that line (`selfCheck.scriptGitBlob`, `selfCheck.scriptSha256`; the `apply.sh` entry of `files[]` carries the same values and says what is excluded). At start the script hashes `manifest.json` against the embedded id and hashes itself minus that line against the manifest, and refuses with exit 3 on any mismatch; the other package files are checked against blob ids embedded in the script. This detects damaged or incomplete downloads and mixed-up files. It does not detect someone who changes the files together with the script, who can recompute everything: the only protection against that is comparing the hashes through another channel.

### Applying

`sh apply.sh --repo <dir> [--dry-run] [--new-branch] [--keep-bot-author]`. Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Default (PM decision of 2026-11-17): one local commit on the branch that is checked out, with the applier (the local `git config user.name` and `user.email`) as author and committer. If either is empty the script refuses before touching anything. The script requires a branch (a detached HEAD is refused with a hint to use `--new-branch`), clean tracked files (untracked files are allowed), no operation in progress, and a branch that is not behind its upstream as of the last fetch (no fetch is made; no upstream gives a note). If the base commit is not in the history of HEAD it prints a note and merges three-way. It records the original HEAD and the ref `refs/qm/backup/<id>`, runs `git am --3way --keep-cr --keep-non-patch`, copies the LFS files, stages them and checks that every staged blob is a pointer (at most 1024 bytes, the version line, `oid sha256:<recorded sha256>`), then makes the commit with `git commit --amend --no-edit --reset-author` (LFS-only: `git commit -F COMMIT_MESSAGE.txt`). Any failure or interrupt restores the original HEAD with `git am --abort` if needed and `git reset --keep`, undoes the LFS copies, removes the backup ref and the temporary files. The script never uses a hard reset, never pushes, never fetches. On success it prints `git log -1 --stat`, the original HEAD, and the undo line `git reset --keep <original HEAD>` (valid only before the commit is pushed).

LFS files: the script requires `git lfs version` and a configured `filter.lfs.clean` and refuses otherwise (without them the file would be committed in full). It does not compare the stored blob with the delivered file. For each part B path it checks the base blob id against `BASE:<path>`, and in the default mode that `HEAD:<path>` is still the same blob (a newer version is never overwritten blindly) and that an added path does not exist yet.

`--new-branch`: the safer mode of the demo package. The commit is built in a temporary worktree on the new local branch `qm/<id>` made from the base commit; the current branch and files are not touched, a dirty tree is refused, an existing branch of that name is refused, and a failure removes the worktree and the branch it made. `--keep-bot-author` keeps the package author as the author (the applier is still the committer). `--dry-run` does the whole thing, shows the result, rolls back through the same code path and verifies that nothing is left.

README and scripts carry no comments. `apply.ps1` and `apply.cmd` are labelled UNTESTED in the README and the manifest: nobody has run them on Windows. `apply.sh` was tested on Linux, with git 2.52, under `sh` (bash in POSIX mode) and `bash`; `dash` was not available, and git-lfs was simulated by a stub filter in the tests.

Without the script: `git am --3way --keep-cr --keep-non-patch patches/0001.patch`, then copy each `files/NNNN.dat` to its repository path, stage and commit it with git-lfs installed (the README lists the paths).

### Getting a complete diff from get_diff

`get_diff` has no paging parameters. With `paths` it returns the diff of those files cut to `truncateChars` (default 60000, `ZQ_GIT_MCP_TRUNCATE_CHARS`) and flags `truncated: true`. The builder refuses any result with `truncated: true`. `fetchCompleteDiff(client, { repo, range, paths }, caller)` is the safe route: it asks for all paths, and if that was truncated it asks again once per path and stitches the answers, refusing if any single file still does not fit. No change to the plugin was made. A single file whose diff is longer than one response, binary files, exact renames (the tool returns no diff for them), submodules and LFS pointers cannot come through `get_diff`; use the working copy route for those.

The `get_diff` base must equal `baseCommit`, so the diff cannot be applied to a different tree by mistake.

## Spreadsheets

Workbooks travel inside the same package as every other file. Pass `workbooks: [{ result, fetchPage }]` to `buildPatchPackage`: `result` is a `diff_xlsx` result (as returned by `GitMcpClient.call("diff_xlsx", ...)`) for a path that is among the changed files, and `fetchPage(offset)` fetches the next page (`xlsxPager(client, args, caller)` builds it with the same arguments plus `offset`; pages are followed through `nextOffset` until it is `null`).

- A workbook that is not under Git LFS stays in the text part (a binary patch) and gets `comparison/<name>.diff.md` (role `comparison`), which starts with the refs and ticket, then (if any) a callout for ambiguous keys with the `suggestedKeyColumns` per sheet, then the per-sheet summary, then the table `sheet | key | column | old | new | kind`. Values are escaped (`\`, `|`, newlines). The table is written to disk page by page, so memory does not grow with the number of differences. If pages are missing (no pager, a page failed, the offset did not advance, `maxPages` reached, default 10000) the file ends with a `TABLE CUT:` line and the manifest says `complete: false`.
- A workbook under Git LFS is a part B file. No comparison table is made (QM does not have the LFS content): the manifest says `comparison: { available: false, reason: "lfs", note: "comparison not available for LFS files" }` and the README repeats the note.

Refused: an `unchanged` result, a removed file, an unsupported result (not `.xlsx`, macro or encrypted workbook), a result for a path that is not among the changes, duplicate file names.

## Settings

Parsed in `src/zq/config.ts` as `ZqConfig.patchPackage`. Precedence: the settings object the caller passes to the builder (normally `config.patchPackage`), built from the environment, then the default. Bad values refuse startup.

| Setting                     | Env                          | Default                         |
| --------------------------- | ---------------------------- | ------------------------------- |
| Ticket id pattern           | `ZQ_PATCH_TICKET_PATTERN`    | `^(WP-)?[0-9]{1,9}$`            |
| Package author name         | `ZQ_PATCH_AUTHOR_NAME`       | `QM Bot`                        |
| Package author email        | `ZQ_PATCH_AUTHOR_EMAIL`      | `qm-bot@invalid`                |
| Output directory (absolute) | `ZQ_PATCH_OUTPUT_DIR`        | `<os tmpdir>/qm-patch-packages` |
| Subject length, 20 to 200   | `ZQ_PATCH_SUBJECT_MAX`       | 72                              |
| Body length, 100 to 50000   | `ZQ_PATCH_BODY_MAX`          | 5000                            |
| Package size cap in bytes   | `ZQ_PATCH_MAX_PACKAGE_BYTES` | 83886080 (80 MiB)               |

`ZQ_PATCH_MAX_PACKAGE_BYTES` (step 4a, unchanged name and default): a positive integer (at most 2^53 - 1), environment only, a bad value refuses startup. It is not a feature switch and nothing reads it unless a builder is called. Since step 4b it is measured on the REAL zip: first a cheap check of the sum of the file sizes (the zip cannot be smaller, because entries are stored), which refuses before any zip is built, then the final check on the size of the zip itself. Over the cap the builder refuses with `too_large`, the message names the setting and asks for another delivery route, and the package directory is removed. The 4a upper-bound estimate (`zipSizeBound`) no longer exists.

The author name and email are now a marker inside the package (the mbox `From:` line, the manifest `author`, the script data used by `--keep-bot-author`); the applied commit is authored by the applier unless `--keep-bot-author` is given. The name or the email must contain `QM`, so the marker is recognisable.

The default ticket pattern accepts an OpenProject work package id written as `WP-<digits>` (for example `WP-123`) or a plain number (`123`), 1 to 9 digits. It is case sensitive: `wp-123` is refused, as are an empty id, `WP-`, `12a`, whitespace, control characters and ids longer than 64 characters. The pattern is a regular expression tested against the whole id and stays configurable through `ZQ_PATCH_TICKET_PATTERN`; an invalid expression refuses startup. The previous Jira-style default (`ABC-123`) is replaced. The PM has not yet named the final ticket format, so this default is provisional. The accepted id is written unchanged into the commit message trailer `Ticket: <id>`, into the manifest, and into the package directory name `<id>-<hash>`.

The committer date of the text part is the build time unless `commitDate` is passed, which tests use for byte-identical output.

## Decisions recorded (PM)

- 2026-11-17: Git LFS files are supported by the file plus script route above; the earlier decision that LFS pointers are refused is replaced. Submodules stay refused.
- 2026-11-17: the applier is the author and the committer; the commit goes on the current branch by default; `--new-branch` is the safe mode. The earlier default author `QM Bot <qm-bot@invalid>` and the pre-launch check on GitLab push rules for it (design decision 7) are void.
- 2026-11-17: the AI marking is the single trailer `AI-Generated: true`.
- 2026-11-17: one commit per package, README in Chinese and English, size cap 80 MiB, non-UTF-8 text files refused, comparison tables unavailable for LFS workbooks.
- The subject is at most 72 characters and the body at most 5000.
- Delivery channel: Mattermost direct message to the responsible person with the zip attached. This is a decision only; nothing is wired. The design for keeping and delivering packages is in `docs/zq/patch-package-retention.md`.
- Still open before the first real package reaches a developer: who tests `apply.ps1`, Windows and a real git-lfs (design decision 5).

## Limits and not supported

- Submodules are refused. Symlinks are carried as git carries them in the text part; an LFS file must be a regular file.
- One commit per package; the patch size is not limited by itself, only the package as a whole (`ZQ_PATCH_MAX_PACKAGE_BYTES`).
- Comparison tables only for `.xlsx` workbooks that are not under LFS; the workbook is delivered as is, QM never edits it.
- Not done in this step: no delivery, no agent tool, no wiring of retention into startup, no repository-source route that builds the working copy from service reads. Those are the later steps 4b to 4d.
- Not verified: a real git-lfs (the tests simulate the clean filter with a stub), Windows and PowerShell, `dash`, the real `read_file` service, git older than 2.52.
