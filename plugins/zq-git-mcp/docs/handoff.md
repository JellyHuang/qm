# zq-git-mcp handoff

A read-only MCP service for the seven ZQ GitLab repositories (`client`, `clientcode`, `CommonMessage`, `gameconfig`, `jenkinstasks`, `server`, `zq-ui`). QM never pushes, opens merge requests or writes anything to GitLab: the key is a read-only key, the service has no write code, and changes reach people only as patch packages that the person applies and commits. Nothing is deployed. Branch `oa/zq-git-mcp`; the in-process GitLab module of the core was removed in the isolated commit `7f8eab470` (the rollback point). Related documents: `ops/` (install, checks, runbook, rollback, checklist), `audit-and-storage.md`, `check-updates.md`, `diff-xlsx.md`, `real-server-it.md`, `docs/zq/gitlab-mcp-client.md` (QM side), and the DDL proposal `docs/zq-git-mcp-ddl-proposal.md` on `oa/spike-git`.

## 1. Tools

All results are JSON in the MCP text content with a `truncated` flag. A failure is `isError` with `{error:{code,message}}`; a refusal has code `repo_not_allowed`, `bad_*` and so on and never starts a process. Nothing takes a URL or raw git arguments; every input object is strict (unknown keys are refused). Every call is audited (principal from `X-QM-Caller`, or `X-QM-Actor`).

| Tool            | Arguments                                                                                                                                                   | Result and kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_repos`    | none                                                                                                                                                        | `repos[]` (name, defaultBranch, head, cloned, lastFetchAt, cloneSizeBytes), `cache` usage, `git {binary, version}`, audit health (`auditBacklog`, `auditDegraded`, `auditLastError`, `auditDropped`, `auditFailures`)                                                                                                                                                                                                                                                                                                                                                        |
| `list_commits`  | `repo`, `branch?`, `path?`, `author?` (fixed string, case-insensitive), `since?`, `until?`, `limit?` (default 50, at most 10000)                            | `commits[]` (sha, parents, author, committer, subject, message), `branch`, `more`. Metadata only, no blobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_commit`    | `repo`, `sha`                                                                                                                                               | commit fields and `files[]` against the first parent: `kind` `file` or `submodule`, status A/D/M/T/R (exact renames paired by object id), old and new oid and mode, `oldCommit`/`newCommit` for submodules. `lineCounts: "on_demand"`                                                                                                                                                                                                                                                                                                                                        |
| `get_diff`      | `repo`, `range` (`base..head` or one commit), `paths?` (literals or globs, matched against the changed files)                                               | without paths the file list only; with paths `matched` count, files (kind `file`, `submodule`, `lfs_pointer`; sizes, additions, deletions, `binary`, `unavailable`), `diff`, `diffBytes`, `cutBytes`                                                                                                                                                                                                                                                                                                                                                                         |
| `read_file`     | `repo`, `ref`, `path`, `startLine?`, `endLine?`, `offset?`, `length?`                                                                                       | `kind` `text` (content, totalLines, totalBytes, cutChars), `binary` (size, oid, sha256, detectedType, base64 range on request), `lfs_pointer` (`lfsOid`, `lfsSize`), `submodule` (commit). Never refused by size                                                                                                                                                                                                                                                                                                                                                             |
| `blame`         | `repo`, `ref`, `path`, `startLine`, `endLine`                                                                                                               | `lines[]` (line, sha, author, date, text), `cutLines`, `prefetched`, `lazyFetches`, `seconds`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `search`        | `repo`, `ref`, `query`, `kind` (`message`, `path`, `content`), `pathGlob?` (required for content), `limit?`, `author?`, `regex?`, `ignoreCase?`, `context?` | message: commits; path: `paths[]`, `submodulesSkipped`; content: `matches[]`, `matchedCount`, `searched`, `notSearched`, `skipped` (binary, lfsPointers, submodules, unavailable). A regex runs in a worker with a time limit: `regex_timeout`                                                                                                                                                                                                                                                                                                                               |
| `diff_xlsx`     | `repo`, `path`, `base`, `head`, `sheets?`, `overrides?` (`{sheet:{headerRow?, keyColumns?}}`), `offset?`, `limit?` (default 500, at most 10000)             | `kind` `xlsx_diff` (summary per sheet, `table` as Markdown, `differences[]`, `total`, `nextOffset`, `cutDifferences`), `unchanged`, `file_added`, `file_removed`, `lfs_pointer`, `lfs_pointer_changed`, `unsupported` (xls, xlsm, encrypted, not a zip). Difference kinds: `cell_changed`, `formula_changed`, `row_added`, `row_removed`, `column_added`, `column_removed`, `ambiguous_header`, `ambiguous`, `hidden_changed`, `merge_changed`, `sheet_added`, `sheet_removed`; the summary has `ambiguousKeys`, header detection and `suggestedKeyColumns` (`diff-xlsx.md`) |
| `check_updates` | `repo?`, `ack?` (entries `{repo, branch, from, to}` echoed from the previous response)                                                                      | `repos[]` (status `first_run`, `unchanged`, `changed`, `error`; updates per branch with status `new`, `updated`, `rewritten`, `deleted` and metadata-only commits), `ack[]`, `acknowledged`. At least once, see `check-updates.md`                                                                                                                                                                                                                                                                                                                                           |

Limits that apply to every tool: the response is cut at `truncateChars` (default 60000) with `truncated:true` and counts of what was cut. There are no size limits on files.

## 2. Configuration

Precedence for every plugin key: environment, then the JSON file named by `ZQ_GIT_MCP_CONFIG`, then the default. The file schema is strict (unknown keys refuse to start) and uses the camelCase names. Core keys are environment only.

### Plugin (`plugins/zq-git-mcp`)

| Key                                       | Default                                  | Meaning                                                             |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `ZQ_GIT_MCP_SECRET`                       | required, at least 16 characters         | bearer secret                                                       |
| `ZQ_GIT_MCP_DATA_DIR`                     | required, absolute                       | clones, scratch, cache, audit spool below it                        |
| `ZQ_GIT_MCP_PORT`                         | 8765                                     | loopback port                                                       |
| `ZQ_GIT_MCP_REMOTE_BASE`                  | `git@lab.skyunion.net:ca-programmer-zq/` | remote prefix; `file://` for tests                                  |
| `GITLAB_QM_READONLY_SSH_KEY_B64`          | required for an ssh remote               | read-only key                                                       |
| `ZQ_GIT_MCP_SSH_HOST_FINGERPRINT`         | required for an ssh remote               | `SHA256:...`, verified against `ssh-keyscan`                        |
| `ZQ_GIT_MCP_GIT_BIN`, `_SSH_BIN`          | system `git`, `ssh`                      | absolute paths                                                      |
| `ZQ_GIT_MCP_PATH`                         | `/usr/local/bin:/usr/bin:/bin`           | child PATH, the git directory is put first                          |
| `ZQ_GIT_MCP_SCRATCH_DIR`, `_CACHE_DIR`    | `<data>/scratch`, `<data>/cache`         | absolute                                                            |
| `ZQ_GIT_MCP_TRUNCATE_CHARS`               | 60000                                    | response size                                                       |
| `ZQ_GIT_MCP_SCRATCH_CAP_BYTES`            | 20 GiB                                   | jobs queue at the cap                                               |
| `ZQ_GIT_MCP_FREE_FLOOR_BYTES`             | 5 GiB                                    | below it the newest job is stopped with "disk space low"            |
| `ZQ_GIT_MCP_CACHE_CAP_BYTES`              | 2 GiB                                    | blob cache, LRU by mtime, a blob over half the cap is not kept      |
| `ZQ_GIT_MCP_MAX_FETCHES`                  | 4                                        | concurrent fetches                                                  |
| `ZQ_GIT_MCP_MAX_HEAVY_JOBS`               | 2                                        | concurrent scratch jobs                                             |
| `ZQ_GIT_MCP_MAX_BIG_FETCHES`              | 2                                        | concurrent fetches of blobs not known to be small (1 MiB)           |
| `ZQ_GIT_MCP_FETCH_TIMEOUT_MS`             | 1800000                                  | one remote git call                                                 |
| `ZQ_GIT_MCP_FETCH_NO_PROGRESS_MS`         | 180000                                   | a fetch whose directory stops growing is killed                     |
| `ZQ_GIT_MCP_FETCH_FAILURE_TTL_MS`         | 60000                                    | negative cache of failed (repo, oid)                                |
| `ZQ_GIT_MCP_GIT_TIMEOUT_MS`               | 60000                                    | local git call                                                      |
| `ZQ_GIT_MCP_REFRESH_MS`                   | 60000                                    | a clone is refetched when older than this                           |
| `ZQ_GIT_MCP_XLSX_TIMEOUT_MS`              | 900000                                   | total diff_xlsx time                                                |
| `ZQ_GIT_MCP_XLSX_NO_PROGRESS_MS`          | 180000                                   | diff_xlsx watchdog                                                  |
| `ZQ_GIT_MCP_XLSX_MAX_HEAP_MB`             | 768                                      | worker heap bound                                                   |
| `ZQ_GIT_MCP_REGEX_TIMEOUT_MS`             | 30000                                    | total regex matching time per search                                |
| `ZQ_GIT_MCP_REGEX_MAX_CHARS`              | 500                                      | longest regex pattern                                               |
| `ZQ_GIT_MCP_AUDIT`, `_TIPS`, `_BLOB_META` | `memory`                                 | `memory` or `postgres`                                              |
| `ZQ_GIT_MCP_DATABASE_URL`                 | none                                     | required when a store is `postgres`, never logged                   |
| `ZQ_GIT_MCP_TENANT_ID`                    | none                                     | optional uuid bound per connection (dev and tests)                  |
| `ZQ_GIT_MCP_AUDIT_ON_FAILURE`             | `serve`                                  | `serve` spools and never fails a read; `fail` is an explicit opt-in |
| `ZQ_GIT_MCP_AUDIT_SPOOL_DIR`              | `<data>/audit-spool`                     | write-ahead spool                                                   |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES`        | 64 MiB                                   | beyond it rows are dropped, loudly                                  |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS`       | 7 days                                   | older rows are dropped at replay, loudly                            |
| `ZQ_GIT_MCP_CONFIG`                       | none                                     | path of the JSON file                                               |

### Core (`ZqConfig`, read by nothing in production yet)

`ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET` (together or not at all), `ZQ_GIT_EXTERNAL_DOMAINS` (comma list, default empty), `ZQ_GIT_BOT_NAMES` (comma list, default empty).

## 3. Architecture

- Storage. One blobless bare clone per repository (`git clone --bare --filter=blob:none`) under `<data>/clones`, created at the first use and updated when older than `ZQ_GIT_MCP_REFRESH_MS`; HEAD follows the remote default branch. The clones never grow because blob reads use a throwaway repository.
- Fetch path. For blob content a temporary bare `GIT_DIR` is created in a scratch job, with `objects/info/alternates` pointing at the clone, `remote.origin.url`, `promisor=true`, `fetch.unpackLimit=1`, `core.bigFileThreshold=1m` and `fetch.negotiationAlgorithm=noop`, and `git fetch origin <oid...>` runs in batches of 100. Noop negotiation is required: a bitmap packed server answers a fetch of a blob the client already has a commit for with an empty pack otherwise. `core.bigFileThreshold=1m` makes `index-pack` stream. The blob is streamed to the blob cache (or a transient file when over half the cache cap) and the temporary repository is deleted. Identical in-flight fetches are coalesced; a failed batch is bisected so only the failing oids enter the negative cache.
- Guards. Every git process runs without a shell in its own process group with a clean environment, and `GIT_NO_LAZY_FETCH=1` except for the explicit fetch step and the blame helper, so an accidental blob download fails loudly. `ls-tree -l`, `log --stat`, `log -p` and `diff --stat` are never used. git 2.44 or newer is required and checked at start.
- ssh. One ControlMaster per service (`ControlPersist=10m`), `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes` with the host key taken from `ssh-keyscan` only if its fingerprint equals the configured one, the key in a 0600 temporary file shredded on exit. The socket is `<TMPDIR>/z-XXXXXX/c`, so `TMPDIR` must be at most 72 characters.
- Quotas and limits. Scratch cap and free floor, one directory per job named for the owner pid and swept at start, blob cache LRU with pins, 4 concurrent fetches, 2 heavy jobs, 2 big fetches, a no-progress watchdog, per request cancellation that kills the process group and removes the scratch.
- `check_updates`. `ls-remote --heads` per repository, a TipStore (memory or `zq_git_branch_tips`), first observation only records, commits are returned oldest first and the stored tip advances only on a later call that carries the `ack` entries (compare-and-set). Deleted branches are tombstones (all-zero tip) so no DELETE grant is needed.
- Audit. Every call is recorded through an AuditSink: memory, or `zq_git_audit` through a write-ahead spool (see `audit-and-storage.md`). Content, diffs and commit messages are never stored; arguments are stored unredacted.
- Postgres. Three tables, all tenant scoped with row level security; the service never creates tables and refuses to start if one is missing. The role is bound with `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<uuid>'`. Grants: INSERT on `zq_git_audit`; SELECT, INSERT, UPDATE on `zq_git_branch_tips` and `zq_git_blob_meta`; nothing else. `zq_git_audit` is kept 180 days, pruned by the table owner or core (`pruneGitAudit`).
- diff_xlsx. A worker thread with a heap bound streams both workbooks with fflate and saxes into a temporary sqlite file in the scratch job, compares by key with SQL and pages the result. Details in `diff-xlsx.md`.

## 4. Verified facts

Units: MiB is 1,048,576 bytes and every size here is in MiB unless it says otherwise. The fields of the integration test that end in `MB` (`rssPeakMB`, `packPeakMB`, `mbPerSec`, `downloadedMB`) are MiB. `rssPeakMB` is the peak of the process RSS, sampled every 100 ms during that test case, minus the process RSS at the start of the case, never below 0. It is growth, not absolute memory: RSS held by earlier cases is already counted in the starting value, so 0 means the case did not go above what the process already held (the RSS of a process is not returned to the system promptly).

Sources: "reviewer" means a number the reviewer reported from a real-server run, "spike" a number from the real-server spike reports given to the worker, "local" a number the worker measured on its own machine on 2026-11-16 with generated fixtures. A number without a source is not stated here.

Real server (lab.skyunion.net, read-only key):

- Single and batch blob fetch by oid works (spike, before 2026-11-16). The server does not support object-info, so a blob size is only known after the download. A cold single blob took about 2.6 s; 20 blobs in one fetch about 1 s over a ControlMaster against about 2.65 s per new connection; 4 parallel fetches over one master were stable, and 6 single, 4 batches of 20 and 10 mixed fetches over one master finished in 2 to 3 s (spike, before 2026-11-16).
- Noop negotiation fixed the `did not send all necessary objects` failures of the `server` repository (reviewer probe, before 2026-11-16).
- Memory of the fetch, two separate sources. Spike v2 on the real server measured 237 MB peak RSS (unit as reported) at the default configuration for a 229 MiB file. A local 200 MB blob measured 190 MB at the default configuration and 8 MB with `core.bigFileThreshold=1m` (membench probe, as reported to the worker; units as reported).
- Timing of slow links (spike, before 2026-11-16): an 18.96 MB mp4 took 53.8 s (0.35 MB/s) and a 229 MB file took 82 s (units as reported), so the timeouts are generous and progress based, never rate based.
- Real-server integration run, round 2 (reviewer, git 2.47.1 through `ZQ_GIT_MCP_GIT_BIN`, commit `c838d68f9`): full mode passed; `string.xlsx` (4.97 MB as reported, about 4.74 MiB if that is decimal MB) diffed in 6.3 s with an `rssPeakMB` of 215.6; `behavior/1.xlsx` in 0.9 s; `leyline_lv.xlsx` in 0.9 s; the PSD (240,340,614 bytes = 229.2 MiB) was read by range in 88.2 s, about 2.6 MiB/s, with about 160 downloaded (unit as reported) and a git child peak of about 154 (unit as reported); five files were skipped because none of their last six commit pairs gave a diff.
- Real-server integration run, round 3 (reviewer, 2026-11-17): override, diag and full mode all passed; in full mode `string.xlsx` took 41 s with an `rssPeakMB` of 214 and the PSD 93.6 s. A full mode run takes about 4 to 6.5 minutes (reviewer, two runs, rounds 2 and 3).
- `behavior/1.xlsx` after the namespace prefix fix (reviewer, round 2): one sheet, header row 1, key column A unique, 7 changed cells, 2 rows added, 43 to 45 rows. `abtest.xlsx` (reviewer, round 2): header row 1, column A has 9 data rows with 4 distinct values, so the default key is ambiguous; the diagnostic suggested column C. In round 3 the override run with key C resolved the ambiguity (`ambiguousKeys` 4 to 0, reviewer, 2026-11-17).
- LFS on the real repositories (reviewer statistics, before 2026-11-16): `client` has 23.6% of its files under an lfs attribute (all sampled pointers about 130 bytes), `server` about 1% (mixed pointers and real files), the others none. Gitlinks: `client` 5, `server` 6, `clientcode` 1. LFS is decided by content only.

Local fixtures (offline, in the plugin tests; local, 2026-11-16):

- A 128 MiB blob: `index-pack` peak 5 MiB with `core.bigFileThreshold=1m` against 133 MiB without.
- A 256 MiB text file and a 160 MiB binary are read and hashed with bounded process memory, through the transient path and through the cache.
- diff_xlsx on 400k rows (an 11 MiB workbook with 6 MiB of shared strings): 18.6 s, process RSS growth 239 MiB; the growth stays flat from 50k to 800k rows (122, 138 and 119 MiB at 2.2, 9.1 and 36 s).
- Tests: the plugin suite has 235 tests (234 pass, 1 skipped real-server hook; local run, 2026-11-16). Core has the contract, client, poller, author and retention tests (29 pass in the last core run, local, 2026-11-16).

## 5. Known limitations

- LFS content cannot be downloaded: a file under LFS is reported as `lfs_pointer` with oid and size.
- There are no per-call size limits; the only cut is the response truncation. A very large file is still streamed and takes the time it takes.
- `diff_xlsx` recomputes the whole comparison for every page (`offset`, `limit`); the blob cache avoids refetching. Sheets are matched by name, so a renamed sheet is `sheet_removed` plus `sheet_added`. More than ten title rows fool the header rule (use `headerRow`). The key defaults to the first column. Only `.xlsx` is supported (no xls, xlsm or encrypted files).
- Regular expression content search runs with a time limit (`regex_timeout`) and a pattern length limit.
- Tags are not polled; only branch heads.
- A search query and `diff_xlsx` overrides are stored in the audit as given.
- Known behaviour, `abtest.xlsx` (reviewer, round 3, 2026-11-17): the override with key column C resolves the key ambiguity, and the run then reports 0 changed cells, 0 rows added and 0 rows removed although the two blobs differ. That is not a defect: the two commits differ only in data that is not a cell value or a row (for example styles or document metadata), which `diff_xlsx` does not compare.
- A response cut by `truncateChars` is cut by whole items or characters; a client must page or narrow.
- The memory stores lose audit rows and branch tips on restart; `check_updates` then treats the next call as a first observation.
- The service is a single instance; the per-repository lock is in process (the database compare-and-set is the multi instance guard).

## 6. Not yet verified

- Postgres with real row level security: the gated test is written but was never run against a database.
- ssh and ControlMaster in the production layout (service user, `TMPDIR`, systemd unit); the units and docs are drafts.
- The systemd unit.
- A CI job for the plugin (planned with the QM side work).
- The full core test suite with `DATABASE_URL` after the removal commit.
- Real Excel-saved workbooks beyond the ones tested (two real files and generated fixtures).
- Auto detection of header and key on the remaining real gameconfig files.

## 7. Decisions and actions before staging

1. DDL approval. The tenanted tables, grants, retention and no-redaction decisions are approved by the PM (2026-11-16) in the proposal; the migrations and the role SQL still have to be written and reviewed.
2. Create the role `zq_git_mcp`, run the grants and `ALTER ROLE ... SET qm.tenant_id`, decide the tenant uuid and the delivery of `ZQ_GIT_MCP_DATABASE_URL`.
3. Provision the shared secret on the QM side and in the service environment file (mode 0600, service user only).
4. Place the read-only key (`GITLAB_QM_READONLY_SSH_KEY_B64`) only in the service environment file and set `ZQ_GIT_MCP_SSH_HOST_FINGERPRINT`, verified by a human with `ssh-keygen -lf`.
5. git 2.44 or newer on the host (or `ZQ_GIT_MCP_GIT_BIN`), node 24, a short `TMPDIR`.
6. Merge decision for the removal commit `7f8eab470` (the rollback point; revert it to restore the in-process module) and the QM-side wiring: register the server with `GIT_MCP_CONTRACT`, run `verify()`, create the poller job with its 5 minute schedule and the handler that turns commits into notifications, and the author mapping.
7. Whether `check_updates` auto keying (below) is wanted.

## 8. Rollback summary

Service: stop it, point `current` at the previous release, start it (config unchanged). Database: drop `zq_git_blob_meta` and `zq_git_branch_tips`, revoke and drop the role; `zq_git_audit` rows stay. Core: the QM side is additive; `7f8eab470` is the isolated removal and can be reverted alone. Details in `ops/upgrade-and-rollback.md`.

## 9. Staging validation plan

1. Install the release, the environment file and the unit; start; expect `zq-git-mcp listening on 127.0.0.1:8765, git <version> at <path>` and a refused start for a too long `TMPDIR`, a git below 2.44, a wrong fingerprint and a missing table (each tried once).
2. `list_repos` shows seven repositories, none cloned, the git version, audit health with `auditDegraded:false`.
3. `list_commits` on `gameconfig`, then `get_commit`: the first call clones (seconds), the second is instant.
4. `read_file` on a small text file twice (cold 2 to 3 s, then a cache hit in `cache_hit` of the audit row), a `.png` (binary, sha256) and an LFS file (`lfs_pointer`).
5. `get_diff` with and without `paths`, `blame` on a file with a rename, `search` of all three kinds, a content search without `pathGlob` (refused).
6. `diff_xlsx` on `string.xlsx` and `behavior/1.xlsx` (expect `xlsx_diff`), on `abtest.xlsx` (ambiguous with `suggestedKeyColumns`, then the override run), and the structure diagnostics.
7. `check_updates`, read-only toward GitLab: the first call per repository records the tips and reports nothing; a second call reports `unchanged`. To see commits without pushing anything, set one stored tip back in the staging database (`UPDATE zq_git_branch_tips SET tip_sha = <an older commit of that branch> WHERE repo = ... AND branch = ...`, our own table); the next poll reports the commits after it, the call that passes the `ack` entries advances the tip, and the poll after that reports nothing. An unacknowledged poll repeats the same commits (stop the poller between the two calls). For the tombstone flow insert a row for a branch name that does not exist on the remote, with a real commit as `tip_sha`; the next poll reports it as `deleted`, the acknowledged call marks it, and the following poll is quiet. Nothing in this step writes to GitLab.
8. Database: with the Postgres stores on, check the audit rows and tips in the tables, RLS (own tenant only, no SELECT on the audit table, no DELETE). Stop the database, make calls (served, spooled, alarm), restart it (replayed in order once).
9. Kill a running `diff_xlsx` and a fetch (cancel the request): no process and no scratch directory remains. Fill the scratch cap and the free floor on a test volume.
10. Run the real server integration test in all three wrapper modes (full, diag, override); it only reads.
11. Staging validation is read-only toward GitLab end to end: no push, no branch, no merge request, no tag. If the patch package flow has to be validated, generate a `.patch` locally (for example with `git format-patch` in a throwaway clone, or from the `get_diff` text with a mail header) and apply it with `git am` in a local throwaway clone that has no remote, then delete the clone.

## 10. Evaluation: should the QM client retry `diff_xlsx` with the suggested key by itself?

Plan only, nothing is built.

Design if it were done: in `src/zq/git-mcp` a wrapper around the client call. After a `diff_xlsx` result with a sheet where `ambiguousKeys > 0` and `suggestedKeyColumns` is not empty, and only when the caller passed no override for that sheet, it repeats the call once with `overrides: { <sheet>: { keyColumns: <suggested> } }` for every such sheet at once. The result of the second call is returned with a marker `autoKeyed: [{ sheet, keyColumns, ambiguousKeysBefore }]` next to the original summary of the first call, and the audit shows two calls with the same principal.

Risks:

- A wrong key compared silently. The suggestion is only unique and non empty over the data, not meaningful: a column of row numbers, a computed column or a value that changes between versions makes every row look removed and added. The suggestion order (first unique column in header order, then pairs) has no notion of meaning.
- It hides a data quality problem. Duplicate or empty keys in the first column are often a finding by themselves (a broken id column in the design table); an unattended fix removes the signal that someone should look.
- Double cost. The second run repeats the whole parse and compare; for the largest workbooks that is the main cost (about 45 µs per row).
- The paging of the first call no longer matches the second.

Recommendation: do not retry automatically in version 1. Return `suggestedKeyColumns` to the caller (the agent or the job), which can show it to a person or retry deliberately; the real-server `override` mode already exercises this loop. If unattended retry becomes necessary (for example for patch packages), make it opt in per job (`autoKey: true` in the client, never a tool argument), limit it to one retry, only for ambiguity caused by duplicate or empty keys of the default key, never when the keys differ between the sides unless the caller allows it, always mark the result as `autoKeyed` with the columns used, and make the notification to the person say so.
