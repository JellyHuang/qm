# GitLab read-only MCP, version 1 (design for review)

Status: design for Jelly's review, written from her decisions so far. Nothing in this document is built beyond what `gitlab-readonly.md` already describes. Points that are not decided are marked **Open**.

This document supersedes the parts of `gitlab-readonly.md` that it contradicts (per-call size caps, per-minute limits, the daily byte budget, full local clones, tools registered in-process).

## Decisions it is based on

1. QM never pushes and never opens merge requests. All people are Developers on the repositories and QM cannot be kept away from `main`, so QM has no write access at all. It delivers **patch packages** to the responsible person, who applies and commits: a patch file, or for spreadsheets the modified file plus a cell-level diff table.
2. A **standalone read-only MCP service** runs on the QM machine. It is the only place that holds the read-only key, and it exposes only view interfaces.
3. Exactly seven repositories are readable: `client`, `clientcode`, `CommonMessage`, `gameconfig`, `jenkinstasks`, `server`, `zq-ui`.
4. No full local copies. Blobless bare clones plus an on-demand file fetch with an LRU cache.
5. No rate, size or daily limits. The only cut is truncating one over-long response so it fits an LLM context. Every call is logged.
6. `diff_xlsx` and `search` are in version 1.
7. No webhook. QM polls about every five minutes with `git ls-remote` through the MCP.
8. A commit author is mapped to a person by commit email.

## Why the key must never leave the service

Anyone who holds the read key can clone every repository it can see, and on this GitLab `git archive --remote` also works with it. Nothing on the server side changes that, so the protection is where the key lives: only inside the MCP service's account, never passed to QM core, agents, sandboxes or logs. The service never runs `git archive`, `git bundle` or any command that hands a repository or a tree to a caller, and its own tools are the only path to the content.

The key currently authenticates as a personal user (`@donghuang`), not as a per-repository deploy key, and it also sees a repository outside the seven (`qm-test`). The allowlist in the service is therefore the only guard on what can be read, and "read-only" holds by the absence of write code. **Open:** replace it with a dedicated read-only key limited to the seven repositories.

## Architecture

- One process, `zq-git-mcp`, owned by a dedicated service account on the QM machine. It speaks MCP and listens only on a local socket or loopback port. QM core talks to it as an MCP client through the existing connector mechanism, with a shared secret between the two that grants nothing else. **Open:** transport (stdio under a supervisor, loopback HTTP, or a Unix socket) and how that secret is provisioned.
- The service holds, for each repository, one **blobless bare clone** (`git clone --bare --filter=blob:none`, partial-clone settings stored in the clone). Measured total for the seven: about 97 MB (client 56 MB, clientcode 18 MB, gameconfig 12 MB, server 9.6 MB).
- File content is fetched on demand through the service's own git calls, which carry the SSH key. A cold single-file fetch takes about 2.6 s, a cached one about 1 ms.
- Blobs are kept in the service's own **LRU blob cache directory** with a hard total cap of **2 GB** and a **per-file cap** (proposed 20 to 50 MB, because `zq-ui` holds very large binary assets and `HEAD` snapshots of it exceed 1 GB). A file over the per-file cap is refused with a clear message and never stored. Eviction removes the least recently used blobs when the 2 GB cap would be exceeded.
- Where the key comes from at start-up and how it is protected on disk are **Open** (the keychain handle `gitlab-qm-readonly-key` is the intended source).

## What stays out of the service

- No writing anywhere in the remote: no push, no branch, no merge request, no comment, no tag, no archive.
- No tool takes a URL, a command or a path to the clone directory. Repository names come from the seven-name list; remote URLs and directories come only from the service's configuration.
- Refs, ranges, shas and paths are validated before any git process starts (the existing validation is reused).

## Tools (version 1)

| Tool           | Arguments                                                           | Returns                                                                                                   |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list_repos`   | none                                                                | the seven repositories with default branch, last fetch time, clone size and cache use                     |
| `list_heads`   | repo                                                                | every branch with its tip sha, from `git ls-remote`, for the five-minute polling (**name is a proposal**) |
| `list_commits` | repo, branch?, since?, path?, author?, limit?                       | commits with sha, author name and email, date, subject and message, files changed, branch                 |
| `get_commit`   | repo, sha                                                           | message, author, committer, parents, per-file statistics                                                  |
| `get_diff`     | repo, sha or `base..head`, path?                                    | unified diff; binary files shown as changed with sizes only                                               |
| `read_file`    | repo, ref, path, line range?                                        | text content at a ref; binary files return size and object id only; over the per-file cap refused         |
| `blame`        | repo, ref, path, start line, end line                               | per line: sha, author, date, text                                                                         |
| `search`       | repo, ref, pattern, path glob?, kind (`message`, `path`, `content`) | matches with location and a short context                                                                 |
| `diff_xlsx`    | repo, path, base ref, head ref, sheet?, header row?, key column?    | cell-level diff table (below)                                                                             |

All responses carry `truncated` and the number of items or characters cut when a single response is cut to fit an LLM context. The cut size is a configuration value, not a quota: calling again with narrower arguments is always allowed.

**Open for `search`:** on a blobless clone, content search must fetch the blobs it reads. Proposal: `message` and `path` search run on commits and trees without fetching blobs; `content` search runs only over files at one ref, restricted by a path glob, and fetches through the same cache and caps as `read_file`. Without a glob it is refused with the reason. To be confirmed.

**Open for size checks:** with no blob content locally, a blob's size is unknown before it is fetched. Proposal: the service starts the fetch, aborts and discards it as soon as the per-file cap is exceeded, and reports that the file is too large.

## `diff_xlsx`

Input: two versions of one `.xlsx` file (`base` and `head`, any refs), optionally a sheet name, a header row number and a key column per sheet.

- Both versions are read through `read_file` rules (cache, per-file cap) and parsed as OOXML.
- For each sheet present in either version, the header row is detected automatically as the first row that is mostly non-empty text; a per-sheet override replaces the detection.
- Rows are matched by the first column (the key), or by the override column.
- Output is a table, one row per difference: sheet, key, column header, old value, new value, and a change kind (`row_added`, `row_removed`, `cell_changed`, `sheet_added`, `sheet_removed`, `column_added`, `column_removed`). Values are the cell values as displayed; formulas are shown when the value cannot be read.
- Duplicate keys, empty keys and merged cells are reported explicitly as `ambiguous` instead of being guessed at.
- This table is also what QM attaches to a patch package for a spreadsheet change.

**Open:** which OOXML reader to use (a dependency or a small own reader over the zip and XML parts), how formula cells and rich text are shown, and the header-detection rule for sheets whose first rows are titles.

## Polling and commit watching

- QM core calls `list_heads` for each repository about every five minutes, compares the tips with the last tips it stored (a durable table in QM's Postgres), and for changed branches asks `list_commits` from the previous tip.
- No webhook is used. Polling stores only branch name and tip sha per repository, nothing from the content.
- What QM does when it sees a commit (who is told, what is checked) is a separate design.
- A commit author's email is resolved to a person by the existing author resolver; an email that matches nobody, or more than one person, goes to the PM and nobody is contacted automatically.

## Patch packages

QM computes a patch from the diff it was asked to propose (a text patch, or the modified file together with the `diff_xlsx` table) and sends it to the responsible person in Mattermost. The person applies it and commits it. Producing the package is QM's work and uses only the read tools above; the service never writes.

## Logging

Every call, allowed, refused or failed, is written to the durable table `zq_git_audit`: time, caller, tool, repository, ref or range, path, bytes returned, truncated flag, result, duration. File content, diffs and commit messages are never stored. The audit table is kept; the per-minute and daily limits are not.

## Reuse and removal

| Existing code (`src/zq/git/`, `scripts/`)                                                                                         | Fate                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `validate.ts` (allowlist, ref, path, sha, range checks)                                                                           | Kept; moves into the service                                                                                                         |
| `runner.ts` (no shell, clean environment, process-group kill, grace settle, fetch timeout)                                        | Kept; moves into the service; adds the SSH command for on-demand fetches                                                             |
| `audit.ts` and the `zq_git_audit` table                                                                                           | Kept                                                                                                                                 |
| `authors.ts` (email to person)                                                                                                    | Kept; stays on the QM side                                                                                                           |
| `readonly.ts` read functions                                                                                                      | Adapted: tool names and arguments follow the table above; per-call caps replaced by response truncation; reads fetch blobs on demand |
| `fetchRepo` (creates the bare clone, follows the default branch, optional `blob:none`)                                            | Adapted: blobless is the only mode; clones are partial-clone clones                                                                  |
| `limits.ts`: per-person and global calls per minute, the strict daily byte budget, `GitRateLimited` and the `rate_limited` result | **Removed**, with `ZQ_GIT_CALLS_PER_MINUTE`, `ZQ_GIT_GLOBAL_CALLS_PER_MINUTE`, `ZQ_GIT_DAILY_BYTES` and their tests                  |
| Per-call output caps (64 KiB diff, 200 blame lines, 50 commits and so on)                                                         | **Removed**; replaced by truncating one over-long response                                                                           |
| In-process agent tools (`git_recent_commits` and the others) and `ToolContext.gitCall`                                            | **Removed**; QM uses the MCP service as a client instead                                                                             |
| Key read through the org keychain inside the QM process                                                                           | **Removed from the QM process**; the key is read only by the service                                                                 |
| `scripts/zq-git-verify.ts`                                                                                                        | Adapted: runs against the service                                                                                                    |

New: the MCP service, the LRU blob cache, `list_heads`, `search`, `diff_xlsx`, the polling job and its tips table.

## Milestones

1. **Spike and decisions.** Measure the on-demand fetch path on the QM machine (one blob, one diff, cache hit, over-cap abort), decide where fetched objects are kept and how the 2 GB cap is enforced, and settle the open transport and key-source points. Output: this document with the open points closed.
2. **Service skeleton.** The MCP process, configuration, the seven partial clones, `list_repos`, `list_heads`, `list_commits`, `get_commit`, audit, response truncation. Remove the limits and the in-process tools. Offline tests against local fixture repositories.
3. **File content.** `read_file`, `get_diff`, `blame` with the blob cache, the per-file cap and eviction.
4. **Search.** `search` with its three kinds.
5. **Spreadsheets.** `diff_xlsx` with fixtures for header detection, key matching and the overrides.
6. **QM side.** MCP client registration, the five-minute polling job and its durable tips table, author mapping, handing patch packages to people.
7. **Operations.** Service unit and runbook, key handling, log retention, and the real connectivity check against the seven repositories.

## Open points, collected

1. A dedicated read-only key limited to the seven repositories instead of the personal one.
2. Transport and the shared secret between QM core and the service.
3. Where the key is read from at start-up and how it is protected on disk.
4. The exact per-file cap (20 to 50 MB) and how fetched objects are kept inside the 2 GB cap.
5. Size checks before a fetch (abort-on-exceed proposal).
6. The scope of content `search`.
7. The OOXML reader, formula display and the header-detection rule for `diff_xlsx`.
8. The name and shape of `list_heads` and the response truncation size.
9. Retention of `zq_git_audit`.
