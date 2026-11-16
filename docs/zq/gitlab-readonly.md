# GitLab commit monitoring, read-only (phase 1 design)

Status: design. Implemented in milestones; each milestone is switched off by default.

## Scope

QM watches commits in seven repositories and answers questions about them. It never writes to GitLab, never reads merge requests, comments, issues or pipelines through the API, and never holds an API token. Writing (branches, patches, pushes) is a later phase with its own design.

Repositories (exactly these, by short name): `client`, `clientcode`, `CommonMessage`, `gameconfig`, `jenkinstasks`, `server`, `zq-ui`.

## Access

- One read-only SSH deploy key, held in QM's keychain under the handle `gitlab-qm-readonly-key`. It is materialised only for the duration of a git call (a 0600 file in a private temporary directory, removed afterwards) and never printed, logged, committed or passed on a command line.
- Git is run without a shell, with `GIT_SSH_COMMAND` pinning the key (`IdentitiesOnly=yes`) and a pinned `known_hosts` file with strict host-key checking. No agent forwarding, no credential helper, no network access other than the SSH remote.
- Each repository is a persistent **bare clone** under a configured directory and is only ever updated with `git fetch` (never push, never checkout). Expected sizes: `client` about 5 GB, `zq-ui` about 6.6 GB, `gameconfig` about 900 MB. The first clone is a one-off operator step; fetches run on a schedule and before a query only when the clone is older than a configured age.
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

A commit's author email is matched to a person through the identity map. A match gives the Mattermost user; no match is never an automatic contact: the result is "unmatched" and goes to the PM. One commit email maps to at most one person; ambiguous matches count as unmatched.

## Configuration (planned)

- `ZQ_GIT_READONLY` (`1` enables, default off).
- `ZQ_GIT_DIR` (clone directory), the repository name to SSH URL map, the pinned `known_hosts` file, the keychain handle.
- Rate limits and the daily byte budget.

## Milestones

1. Core module: safe git runner, allowlist, validation, the six tools with caps, the audit table, tests against a local fixture repository (offline).
2. Rate limits, author resolver, switch, registration as QM agent tools.
3. Real connectivity test with the real key against one small repository (needs the key and a decision from Jelly on where the clones live).
4. Scheduled fetch and commit watching rules (what QM does when it sees a commit), designed separately.
