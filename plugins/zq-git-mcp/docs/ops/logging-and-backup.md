# Logging and backup

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval.

## What is logged, and where

- Process output goes to stdout/stderr, so systemd sends it to journald (`journalctl -u zq-git-mcp`). The code writes: one start line `zq-git-mcp listening on 127.0.0.1:<port>`, `zq-git-mcp failed to start: <reason>` on failure (exit 1), and `[swallowed] <context>: <detail>` warnings for errors it deliberately ignores (for example the SSH warm-up).
- Every tool call, allowed, refused or failed, is an audit record (`at`, `principal` (the caller label), `tool`, `repo`, `ref`, `path`, `args`, `bytes`, `truncated`, `result` (`ok`, `error`, `denied:<reason>`), `ms`, `cache_hit`). File content, diffs and commit messages are never stored. On the branch the sink is memory only (last 10,000 rows, lost on restart); with Postgres it becomes the durable `zq_git_audit` table (`database.md`).
- Audit failure alarm (`ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve`): one JSON error line per event (`audit_write_failed`, `audit_dropped`, `audit_recovered`), the health fields `auditBacklog`, `auditDegraded`, `auditLastError`, `auditDropped`, `auditFailures` in the `list_repos` result, and the injectable `alarm` hook of `createService`.

Rotation: journald handles it; set `SystemMaxUse=` and `MaxRetentionSec=` in `journald.conf` to the retention the PM decides. If a file log is ever added, a logrotate rule (weekly, rotate 8, compress, `copytruncate`, mode 0640 owner `zq-git-mcp`) fits. Logs must not contain the key or secret; the journal is readable by admins, so check the first start for leaks.

## Durable vs disposable

| Item                                             | Class                                      |
| ------------------------------------------------ | ------------------------------------------ |
| Postgres rows: audit, branch tips, blob metadata | durable (once wired)                       |
| `data/clones`                                    | disposable, re-cloned on demand            |
| `data/cache` blob cache                          | disposable                                 |
| `data/scratch`                                   | disposable, swept at start                 |
| `data/ssh/zqgit-ssh-*`                           | disposable, recreated each start           |
| audit spool file                                 | write-ahead buffer, durable until replayed |
| `/etc/zq-git-mcp/zq-git-mcp.env`                 | the only thing to back up                  |

The audit spool is a write-ahead buffer, not a backup source. It is counted in the disk budget (`checks.md`) and needs no backup: when the database is healthy it drains to empty.

## What to back up

Only the config files: `/etc/zq-git-mcp/zq-git-mcp.env` (and the optional JSON file named by `ZQ_GIT_MCP_CONFIG`), plus the unit file. Store them where only the PM-approved admins can read them; the file holds the SSH key and secrets. Back up the database with the QM database backups, not by this service. Nothing under `/home/zq-git-mcp/data` is backed up.

## Rebuild after data loss

1. Recreate the directories (`install.md`), restore the env file at mode 0600, start the service.
2. Clones, cache and scratch refill on demand: first use of each repository clones it blobless (seconds to minutes, about 100 MB for all seven); a cold single-file fetch took about 2.6 s in the design measurements.
3. Branch tips come from Postgres, so `check_updates` continues without a reset. With the memory store a restart is a first observation: no commits are reported until the next change.
4. If the data directory is lost while the audit spool is non-empty, the records in it that were not yet replayed are lost for good. The window is bounded by the spool bounds (`ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES`, `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS`), and only exists while the database was unreachable. Record the incident; the calls themselves were served and the repository content is unaffected.

## Audit retention and content

- `zq_git_audit` rows are kept 180 days; the service role has no DELETE, so the table owner (or QM core's `pruneGitAudit`) prunes them in batches, see `database.md`. Run it daily and check that the oldest `json->>'at'` is within 180 days.
- Logged `args` are stored unredacted (search patterns, workbook header and key names). Restrict who can read `zq_git_audit` accordingly. File content, diffs and commit messages are never stored.
