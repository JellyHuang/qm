# GitLab commit monitoring, read-only (phase 1 design)

Status: superseded. The in-process module this document describes (the six `git_*` agent tools, `ZQ_GIT_*` settings, per-minute limits, `scripts/zq-git-verify.ts`) was removed from the QM core; the read-only service in `plugins/zq-git-mcp` replaces it, see `gitlab-mcp-v1.md`.

## Scope

QM watches commits in seven repositories and answers questions about them. It never writes to GitLab, never reads merge requests, comments, issues or pipelines through the API, and never holds an API token. Writing (branches, patches, pushes) is a later phase with its own design.

Repositories (exactly these, by short name): `client`, `clientcode`, `CommonMessage`, `gameconfig`, `jenkinstasks`, `server`, `zq-ui`.

## Access

- One read-only SSH deploy key, held in QM's keychain under the handle `gitlab-qm-readonly-key`. It is materialised only for the duration of a git call (a 0600 file in a private temporary directory, removed afterwards) and never printed, logged, committed or passed on a command line.
- Git is run without a shell, with `GIT_SSH_COMMAND` pinning the key (`IdentitiesOnly=yes`) and a pinned `known_hosts` file with strict host-key checking. No agent forwarding, no credential helper, no network access other than the SSH remote.
- Each repository is a persistent **bare clone** (created on the first fetch, with `HEAD` pointed at the remote's default branch) under a configured directory and is only ever updated with `git fetch` (never push, never checkout). Expected sizes: `client` about 5 GB, `zq-ui` about 6.6 GB, `gameconfig` about 900 MB. The first clone is a one-off operator step; fetches run on a schedule and before a query only when the clone is older than a configured age.
- The deploy key can read only the repositories it was granted. QM still enforces the allowlist itself (next section), so a mistakenly broader key does not widen access.

## Enforcement inside QM's tool layer

- The repository argument is an enum of the seven names. Anything else is refused before any git process starts. Names map to remote URLs only in configuration, never from tool input.
- Refs, branch names and paths are validated: no leading `-`, no `..`, no NUL or control characters, bounded length, and ref arguments are always passed after `--end-of-options` where git supports it. Paths are repository-relative and checked against the object database, never against a working tree (there is none).
- Every git invocation is built from fixed argument arrays; user input is only ever a value, never a flag or a subcommand.
- Output is capped before it leaves the tool (below). A cap hit is reported as `truncated: true` with the size that was cut.

## Tools

| Tool                 | Arguments                        | Returns                                                                                                            | Caps                                           |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `git_recent_commits` | repo, branch?, since?, limit?    | commits: sha, author name, author email, date, subject and a message excerpt, branch, files changed (path, status) | 50 commits, 50 files per commit, 1 KiB message |
| `git_commit`         | repo, sha                        | message, author, committer, parents, per-file stat (path, status, added, removed)                                  | 200 files                                      |
| `git_diff`           | repo, sha or `base..head`, path? | unified diff for the requested commit or range, binary files reported as changed with sizes only                   | 64 KiB, 20 files                               |
| `git_file_at`        | repo, ref, path                  | text content of one file at a ref; binary files return size and object id only                                     | 64 KiB                                         |
| `git_blame`          | repo, ref, path, start, end      | per line: sha, author, date, line text                                                                             | 200 lines                                      |
| `git_branches`       | repo, pattern?                   | branch names with their tip sha and date                                                                           | 200 branches                                   |

Deliberately absent: archive, tar, bulk or recursive file export, whole-tree listing, whole-history dumps, any tool that takes a URL or a command. `.xlsx` and other binary files appear as changed with sizes and object ids only in phase 1. A cell-level diff table for spreadsheets is a requirement of the later write phase and is not part of this one.

## Not a repository export path

- Per-call caps above, plus a per-principal and a global rate limit (calls per minute) and a daily byte budget per principal. Over limit means refuse, not queue.
- No combination of tools is meant to reproduce a repository: paths come from commits, content from bounded reads, and nothing returns more than 64 KiB per call.
- Every call, allowed or refused, is recorded durably (below), so unusual volume is visible.

## Audit

A durable table `zq_git_audit` (Postgres, DurableMap) records each call: time, caller principal, tool, repository, ref or range, path, bytes returned, truncated flag, result (`ok`, `denied:<reason>`, `rate_limited`, `error`), and duration. Arguments are stored as given after validation; file content is never stored. This feeds the proactive action log.

## Author mapping

A commit's author email is matched to a person through Mattermost's verified user emails (the same source QM uses to know who a person is). A match gives the Mattermost user; no match is never an automatic contact: the result is "unmatched" and goes to the PM. One commit email maps to at most one person; ambiguous matches count as unmatched.

## Configuration

| Variable                         | Default | Meaning                                                                                                    |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `ZQ_GIT_READONLY`                | off     | `1` builds the module and offers the six `git_*` tools. Needs Mattermost and `ZQ_GIT_DIR`.                 |
| `ZQ_GIT_DIR`                     |         | Directory holding the bare clones (`<repo>.git`).                                                          |
| `ZQ_GIT_REMOTES`                 | none    | JSON object of repository name (allowlist only) to SSH URL, used by fetch only.                            |
| `ZQ_GIT_KNOWN_HOSTS`             |         | Pinned `known_hosts` file for fetch.                                                                       |
| `ZQ_GIT_FETCH_TIMEOUT_MS`        | 30 min  | Time one `git fetch` may run before its whole process group is killed (1000 to 86400000). Reads keep 60 s. |
| `ZQ_GIT_CALLS_PER_MINUTE`        | 30      | Calls one person may make per minute (1 to 10000).                                                         |
| `ZQ_GIT_GLOBAL_CALLS_PER_MINUTE` | 120     | Calls everyone together may make per minute (1 to 100000).                                                 |
| `ZQ_GIT_DAILY_BYTES`             | 20 MiB  | Bytes one person may be returned per UTC day (1 to 10 GiB).                                                |

The deploy key is read from the org keychain credential `gitlab-qm-readonly-key` (the same service-credential store the broker uses) each time a fetch needs it.

## Rate limits and the budget

Limits are checked inside the module before any git process starts, in this order: per-person calls per minute, global calls per minute, per-person daily bytes. A refused call returns `rate_limited: <which limit>` to the agent and is audited with result `rate_limited`, zero bytes, and no git run. Refused calls do not count against the minute windows.

- Calls per minute are fixed one-minute windows held in memory. They are disposable: a restart or deploy only forgets recent counts.
- The daily budget is the sum of `bytes` in `zq_git_audit` for that person since 00:00 UTC, so it is durable and shared by every instance. The budget is strict. A person already at the budget is refused before any git process starts. Otherwise the call runs, its serialized result is measured (the same `bytes` the audit stores), and if the day's bytes so far plus this result exceed the budget the result is discarded and the call is refused with `rate_limited` naming the daily byte budget. The agent gets no partial content, the audit row is `rate_limited` with zero bytes, and a later smaller call that fits is still served the same day. Two truly simultaneous calls are each checked against the bytes recorded so far, so they can jointly pass the check.
- Scheduled fetches (principal `system`) are not subject to these limits.

## Connectivity check

`scripts/zq-git-verify.ts` checks the real key and host from a sandbox. It talks to the seven fixed remotes (`git@lab.skyunion.net:ca-programmer-zq/<repo>.git`) with the pinned host key, reads the key only from the file you name, and only ever runs `ls-remote`, `fetch` and the six read functions.

```
ZQ_GIT_KEY_FILE=/path/to/key ZQ_GIT_DIR=/tmp/zq-git-verify \
  ZQ_GIT_VERIFY_REPOS=gameconfig,CommonMessage,jenkinstasks \
  node scripts/zq-git-verify.ts
```

Optional: `ZQ_GIT_VERIFY_FILTER=blob:none` fetches partial clones (commits and trees, no file contents) so clone size and time can be measured; it is the only accepted value, and with it file reads of missing blobs fail as errors. `ZQ_GIT_VERIFY_DEADLINE_MS` (default 45 minutes, at least 1000) is a hard overall deadline: when it passes, the script prints the step that was running, kills every running git process group, and exits non-zero.

Git runs in its own process group. On a timeout or output cap the whole group (git, ssh, index-pack) is killed, and the call settles within 2 s even if a surviving grandchild still holds the output pipe.

`ZQ_GIT_KEY_FILE` is required. `ZQ_GIT_DIR` defaults to `/tmp/zq-git-verify`. `ZQ_GIT_VERIFY_REPOS` defaults to `gameconfig,CommonMessage,jenkinstasks`; the large repositories only get `ls-remote` unless listed.

Output holds only repository names, counts, shas shortened to 10 characters, byte counts, truncated flags and durations:

1. `step a: remote heads`: per repository `branches=<n> default=<branch>`; `main`, or `master` for `jenkinstasks`.
2. `step b: fetch`: per selected repository `fetched filter=<none|blob:none> ms=<n> bytes=<clone size> head=<branch>`; `head` must be the default branch.
3. `step c: read tools`: for `gameconfig` and `CommonMessage`, one line per tool (`recentCommits`, `commit`, `diff`, `branches`, `fileAt`, `blame`) as `ok bytes=<n> truncated=<bool>` or the error class. `fileAt` and `blame` are skipped with a note when the latest commit changed no text file.
4. `step d: refused repository`: `qm-test` is refused as `denied:repo_not_allowed` with `git processes=0`.
5. `step e: audit`: row counts by result and by tool, and a check that rows carry no content fields.

Each check prints `check <name>: pass` or `FAIL`, and the exit code is non-zero when any check fails.

## Milestones

1. Core module: safe git runner, allowlist, validation, the six tools with caps, the audit table, tests against a local fixture repository (offline).
2. Rate limits, author resolver, switch, registration as QM agent tools (done).
3. Real connectivity test with the real key against one small repository (needs the key and a decision from Jelly on where the clones live).
4. Scheduled fetch and commit watching rules (what QM does when it sees a commit), designed separately.
