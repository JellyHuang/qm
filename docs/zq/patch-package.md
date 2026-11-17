# Patch packages (library)

Status: library only. Nothing in QM calls it, no agent tool exposes it, and no setting turns anything on. It implements the "Patch packages" decision in `gitlab-mcp-v1.md`: QM never pushes, never opens a merge request and never writes to any GitLab remote; it hands the responsible person a package that they apply and commit themselves.

Everything is local. The code makes no network access, holds no credentials and runs only the git subcommands in `ALLOWED_GIT_SUBCOMMANDS` (`src/zq/patch-package/git.ts`): `init`, `rev-parse`, `read-tree`, `update-ref`, `add`, `apply`, `diff`, `cat-file`, `commit`, `format-patch`, `am`. There is no `push`, `fetch`, `clone` or `remote`; scratch repositories are created with `git init` and borrow objects from the source repository through `objects/info/alternates`, so no remote can exist in them. The environment sets `GIT_ALLOW_PROTOCOL=none`, an empty global and system config and no hooks.

## Text patches

```ts
buildTextPatchPackage(
  { repoDir, baseCommit, ticket, subject, body, change },
  { settings, commitDate?, tmpRoot?, observeGit? },
);
```

`repoDir` is a local repository (or worktree) that contains `baseCommit` (a full commit id). `change` is one of:

- `{ kind: "workingDir", dir }`: the contents of `dir` become the new tree. Files missing from `dir` are deletions, so `dir` must be a full working copy of the repository. `.gitignore` rules of `dir` apply to untracked files.
- `{ kind: "diff", result }`: a `get_diff` result for explicit paths. It is applied to the base tree with `git apply --cached`.

Steps: validate the ticket and message; create scratch repositories under a `mkdtemp` directory; stage the change; refuse an empty change, submodules (mode 160000), Git LFS pointers and paths with control characters; commit with the message below; `git format-patch --binary --full-index --no-signature -M`; then verify by `git am --3way --keep-cr` of the produced files onto a second scratch repository at the base commit and compare the resulting tree and commit message with the intended ones. Only if both match is the package kept. Scratch directories are always removed; the package directory is removed on any failure.

The verification checks out only the touched paths (sparse checkout), so a huge repository costs only the changed files.

Commit message, exactly:

```
<subject>

<body>

Ticket: <ticket id>
AI-Generated: QM
```

An empty body leaves out the body paragraph. The subject and body must not contain `Ticket:` or `AI-Generated:` lines, the subject must not contain control characters, the body only newlines and tabs.

### Getting a complete diff from get_diff

`get_diff` has no paging parameters. With `paths` it returns the diff of those files cut to `truncateChars` (default 60000, `ZQ_GIT_MCP_TRUNCATE_CHARS`) and flags `truncated: true`. The builder refuses any result with `truncated: true`. `fetchCompleteDiff(client, { repo, range, paths }, caller)` is the safe route: it asks for all paths, and if that was truncated it asks again once per path and stitches the answers, refusing if any single file still does not fit. No change to the plugin was made. A single file whose diff is longer than one response, binary files, exact renames (the tool returns no diff for them), submodules and LFS pointers cannot come through `get_diff`; use the working copy route for those. The plugin would need a streamed route for explicit paths to lift this; that is a possible later change, not part of this one.

The `get_diff` base must equal `baseCommit`, so the diff cannot be applied to a different tree by mistake.

### Package layout

```
<outputDir>/<ticket>-<first 12 characters of the commit id>/
  0001-<subject>.patch
  manifest.json
```

`manifest.json` fields: `schema`, `kind` (`text-patch`), `ticket`, `subject`, `base.commit`, `result.tree`, `author`, `commitDate`, `source` (`git-mcp-diff` or `working-copy`), `files[]` (`name`, `sha256`, `bytes`), `changes[]` (`path`, `oldPath`, `status`, `oldMode`, `newMode`, `additions`, `deletions`, `binary`), `apply`, `verified`. It holds no absolute paths, no environment values and no credentials. The same inputs and `commitDate` produce byte-identical patch files.

The returned object also carries absolute file paths, the result commit id and the result tree id.

### Applying

```
git am --3way --keep-cr <files>
```

`--keep-cr` is required whenever a changed file has CRLF line endings: plain `git am` strips the carriage return from the patch and then fails with "patch does not apply". The manifest `apply` field has the exact command.

## Spreadsheets

```ts
buildXlsxPackage([{ result, file, fetchPage }], { settings, ticket?, name?, maxPages? });
```

`result` is a `diff_xlsx` result (as returned by `GitMcpClient.call("diff_xlsx", ...)`), `file` the modified workbook on disk. `fetchPage(offset)` fetches the next page; `xlsxPager(client, args, caller)` builds it with the same arguments plus `offset`. Pages are followed through `nextOffset` until it is `null`.

Package, in `<outputDir>/xlsx-<name>-<first 12 characters of the head commit>/`:

```
<name>.xlsx        copy of the modified file
<name>.diff.md     comparison table
manifest.json
```

`<name>.diff.md` starts with the refs and ticket, then (if any) a callout for ambiguous keys with the `suggestedKeyColumns` per sheet, then the per-sheet summary (header rows, key columns, row, cell and column counts), then the table `sheet | key | column | old | new | kind`. Values are escaped (`\`, `|`, newlines), long values are already shortened by the tool. A pointer to LFS content is rendered as "LFS file, content not compared". The table is written to disk page by page, so memory does not grow with the number of differences. If pages are missing (no pager, a page failed, the offset did not advance, `maxPages` reached, default 10000) the file ends with a `TABLE CUT:` line and the manifest says `complete: false`.

Refused: an `unchanged` result, a removed file, an unsupported result (not `.xlsx`, macro or encrypted workbook), a modified file that is not on disk, duplicate file names.

Manifest: `schema`, `kind` (`xlsx`), `ticket` if given, and per workbook `path`, `kind`, `base` and `head` (`ref`, `commit`), `workbook` and `diff` (`name`, `sha256`, `bytes`), `differences` (`total`, `listed`, `complete`).

## Settings

Parsed in `src/zq/config.ts` as `ZqConfig.patchPackage`. Precedence: the settings object the caller passes to the builder (normally `config.patchPackage`), built from the environment, then the default. Bad values refuse startup.

| Setting                     | Env                       | Default                         |
| --------------------------- | ------------------------- | ------------------------------- |
| Ticket id pattern           | `ZQ_PATCH_TICKET_PATTERN` | `^(WP-)?[0-9]{1,9}$`            |
| Author and committer name   | `ZQ_PATCH_AUTHOR_NAME`    | `QM Bot`                        |
| Author and committer email  | `ZQ_PATCH_AUTHOR_EMAIL`   | `qm-bot@invalid`                |
| Output directory (absolute) | `ZQ_PATCH_OUTPUT_DIR`     | `<os tmpdir>/qm-patch-packages` |
| Subject length, 20 to 200   | `ZQ_PATCH_SUBJECT_MAX`    | 72                              |
| Body length, 100 to 50000   | `ZQ_PATCH_BODY_MAX`       | 5000                            |

The default ticket pattern accepts an OpenProject work package id written as `WP-<digits>` (for example `WP-123`) or a plain number (`123`), 1 to 9 digits. It is case sensitive: `wp-123` is refused, as are an empty id, `WP-`, `12a`, whitespace, control characters and ids longer than 64 characters. The pattern is a regular expression tested against the whole id and stays configurable through `ZQ_PATCH_TICKET_PATTERN`; an invalid expression refuses startup. The previous Jira-style default (`ABC-123`) is replaced. The PM has not yet named the final ticket format, so this default is provisional. The accepted id is written unchanged into the commit message trailer `Ticket: <id>`, into the manifest, and into the package directory name `<id>-<commit>`.

The default ticket pattern accepts an OpenProject work package id written as `WP-<digits>` (for example `WP-123`) or a plain number (`123`), 1 to 9 digits. It is case sensitive: `wp-123` is refused, as are an empty id, `WP-`, `12a`, whitespace, control characters and ids longer than 64 characters. The pattern is a regular expression tested against the whole id and stays configurable through `ZQ_PATCH_TICKET_PATTERN`; an invalid expression refuses startup. The previous Jira-style default (`ABC-123`) is replaced. The PM has not yet named the final ticket format, so this default is provisional. The accepted id is written unchanged into the commit message trailer `Ticket: <id>`, into the manifest, and into the package directory name `<id>-<commit>`.

The name or the email must contain `QM`, so the identity is recognisable. The committer date is the build time unless `commitDate` is passed, which tests use for byte-identical output.

## Decisions recorded (PM, 2026-11-17)

- The author and committer are `QM Bot <qm-bot@invalid>` (the defaults above).
- Git LFS pointers, submodules and large binaries are refused. There is no override.
- The subject is at most 72 characters and the body at most 5000.
- Delivery channel: Mattermost direct message to the responsible person with the zip attached. This is a decision only; nothing is wired. The design for keeping and delivering packages is in `docs/zq/patch-package-retention.md`.

## Decisions recorded (PM, 2026-11-17)

- The author and committer are `QM Bot <qm-bot@invalid>` (the defaults above).
- Git LFS pointers, submodules and large binaries are refused. There is no override. Today the code enforces this for LFS pointers and submodules only; refusing large binaries needs a size threshold the PM has not named, so it is decided but not yet implemented (a text patch of any size is still accepted).
- The subject is at most 72 characters and the body at most 5000.
- Delivery channel: Mattermost direct message to the responsible person with the zip attached. This is a decision only; nothing is wired. The design for keeping and delivering packages is in `docs/zq/patch-package-retention.md`.

## Limits and not supported

- Git LFS pointers and submodules are refused. Symlinks are carried as git carries them.
- One commit and one patch file per package; the patch size is not limited (git writes the file, QM only hashes it by streaming).
- `.xlsx` only for the spreadsheet route; the workbook is delivered as is, QM never edits it.
- Nothing is delivered anywhere: how the package reaches the responsible person, how long it is kept and who cleans the output directory are open (see the decisions list in the hand-over report).
- The default output directory is a temporary directory; it does not survive a reboot on most systems.
