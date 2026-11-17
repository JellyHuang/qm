# Checks

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval.

## git >= 2.44

`src/git-version.ts` runs `git --version` at start and parses `git version X.Y`. Below 2.44 (needed for `GIT_NO_LAZY_FETCH`), or unparsable output, the start fails: the process prints `zq-git-mcp failed to start: git X.Y is too old: 2.44 or newer is required for GIT_NO_LAZY_FETCH` and exits 1. Human check before install: `git --version` as the service user. Note `git` is found through the service's `PATH`; make sure the first one is the new one.

## Database tables (only with a postgres store)

Applies when `ZQ_GIT_MCP_DATABASE_URL` is set and `ZQ_GIT_MCP_AUDIT`, `_TIPS` or `_BLOB_META` is `postgres`. `zq_git_branch_tips` and `zq_git_blob_meta` are created by a DBA by hand; no QM core migration creates them and the service never does. `zq_git_audit` must also exist (only the removed in-process module of QM core ever created it). Human check before the first start, as the database owner: `SELECT t, to_regclass(t) IS NOT NULL AS present FROM unnest(ARRAY['zq_git_audit','zq_git_branch_tips','zq_git_blob_meta']) AS t;` must show `present` true for all three. The service runs the same query at start and, if a table is missing, prints `zq-git-mcp failed to start: the database lacks the tables <names>; the service never creates tables` and exits 1. Order and DDL: `database.md`.

## Host key fingerprint

`ZQ_GIT_MCP_SSH_HOST_FINGERPRINT` is required for an ssh remote and must match `SHA256:<43 base64 chars>`. At start the service runs `ssh-keyscan -T 15 <host>`, keeps only host keys whose SHA256 equals the pinned value, and writes them to a private `known_hosts` with `StrictHostKeyChecking=yes`. No match: the start fails with "no host key offered by <host> matches the pinned fingerprint".

The pinned value must come from a human reading it on the GitLab server, not from `ssh-keyscan` output on the QM machine. On the GitLab server:

```
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

(repeat for the `rsa` and `ecdsa` files; any one that matches is enough). The output line `256 SHA256:... root@host (ED25519)` carries the value. The documented approved example is `SHA256:DkCVY8DnWnZqf8eTvxgHTj5IRFmOtYj3IMgVy4PiTCQ`; confirm it against the server before use. Record who checked and when.

## Disk space

- Scratch: `ZQ_GIT_MCP_SCRATCH_CAP_BYTES` default 20 GiB. New heavy jobs wait while scratch use is at the cap. `ZQ_GIT_MCP_FREE_FLOOR_BYTES` default 5 GiB: a job is refused with "disk space low" when free space on the scratch filesystem is below it, and the newest running job is aborted every 2 s check when free space drops below it. So the filesystem holding `/home/zq-git-mcp/data/scratch` needs well over 25 GiB: `df -h /home/zq-git-mcp/data`.
- Blob cache: `ZQ_GIT_MCP_CACHE_CAP_BYTES` default 2 GiB, least recently used eviction; a blob larger than half the cap is not kept. Add this to the budget.
- Clones: about 100 MB for the seven, growing with history.
- Audit spool (when the database is configured with `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve`): segment files `segment-<n>.jsonl` in `ZQ_GIT_MCP_AUDIT_SPOOL_DIR` (default `<data>/audit-spool`), bounded by `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES` (default 64 MiB) and `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS` (default 7 days). Add it to the budget.
- Dead job directories (`<pid>-<uuid>` in scratch) of crashed processes are removed at the next start.

## ssh ControlMaster directory

The runtime directory `z-<6 characters>` under `TMPDIR` (`/home/zq-git-mcp/data/ssh`) must be 0700 and owned by `zq-git-mcp`, with `key` and `known_hosts` at 0600. While the service runs: `ls -ld /home/zq-git-mcp/data/ssh/zqgit-ssh-*` and `ls -l` inside it as the service user or root. ControlPath is `<dir>/%C` with `ControlPersist=10m`. After a clean stop the directory is gone.

## Loopback binding

The listener is hard-coded to `127.0.0.1` (default port 8765). Check: `ss -ltnp | grep 8765` must show `127.0.0.1:8765` and nothing on `0.0.0.0` or `[::]`. From another host the port must be unreachable. Without the bearer secret `POST /mcp` returns 401; other paths return 404; GET returns 405 after authentication.

## Audit alarm wiring

Applies when `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve` (default, not finally confirmed by the PM). When an audit write fails the service must (a) log an error line, (b) raise a backlog counter and a degraded flag in its health output, and (c) call an optional alert hook. The health fields are `auditBacklog`, `auditDegraded`, `auditLastError`, `auditDropped` and `auditFailures`, returned by the `list_repos` tool. The log lines are JSON with `kind` `audit_write_failed`, `audit_dropped` (`reason` `spool_full`, `spool_unwritable` or `expired`) and `audit_recovered`. The hook is the `alarm` function of `createService` (`AuditAlarm` in `src/audit-pipeline.ts`); no network call is made unless QM supplies one. Before go-live prove the chain end to end in a staging environment: stop the staging database, make a tool call, confirm the call is served, the error line appears in the journal, the degraded flag and backlog show, and the monitoring alert fires; start the database and confirm the backlog drains to zero and degraded clears. Never run this test against production.

## ssh socket path length

The ssh ControlMaster socket is `<TMPDIR>/z-XXXXXX/c`, and ssh adds a 17 character temporary suffix while it creates it. Unix sockets are limited to 107 characters, so the service refuses to start when `<TMPDIR>` is longer than 72 characters (limit 100 with a margin) and says so: "the ssh control socket path would be N characters ... shorten TMPDIR or the data directory". The recommended `/home/zq-git-mcp/data/ssh` is 25 characters, so the socket path is at most 53. Check on the host: `echo -n /home/zq-git-mcp/data/ssh | wc -c` (add 28 for the worst case, and keep the sum under 100).

## Git and ssh binaries

`ZQ_GIT_MCP_GIT_BIN` (absolute path) is used for every git start and for the version check; `ZQ_GIT_MCP_PATH` (default `/usr/local/bin:/usr/bin:/bin`) is the PATH given to git, ssh and their helpers, with the directory of `ZQ_GIT_MCP_GIT_BIN` put first so a git installed under `/opt` finds its own helpers. `ZQ_GIT_MCP_SSH_BIN` (absolute, optional) replaces the `ssh` found on that PATH. At start the service prints the git version and path (`zq-git-mcp listening on ..., git 2.47 at /opt/git247/bin/git`), and `list_repos` returns `git: { binary, version }`. A git older than 2.44 stops the start and the error names the path and the version.
