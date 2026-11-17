# Checks

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval.

## git >= 2.44

`src/git-version.ts` runs `git --version` at start and parses `git version X.Y`. Below 2.44 (needed for `GIT_NO_LAZY_FETCH`), or unparsable output, the start fails: the process prints `zq-git-mcp failed to start: git X.Y is too old: 2.44 or newer is required for GIT_NO_LAZY_FETCH` and exits 1. Human check before install: `git --version` as the service user. Note `git` is found through the service's `PATH`; make sure the first one is the new one.

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
- Audit spool (when the database is configured with `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve`): a bounded JSONL file in the data directory; its bound setting is TBD (milestone 5 code). Add it to the budget.
- Dead job directories (`<pid>-<uuid>` in scratch) of crashed processes are removed at the next start.

## ssh ControlMaster directory

The runtime directory `zqgit-ssh-*` under `TMPDIR` (`/home/zq-git-mcp/data/ssh`) must be 0700 and owned by `zq-git-mcp`, with `key` and `known_hosts` at 0600. While the service runs: `ls -ld /home/zq-git-mcp/data/ssh/zqgit-ssh-*` and `ls -l` inside it as the service user or root. ControlPath is `<dir>/%C` with `ControlPersist=10m`. After a clean stop the directory is gone.

## Loopback binding

The listener is hard-coded to `127.0.0.1` (default port 8765). Check: `ss -ltnp | grep 8765` must show `127.0.0.1:8765` and nothing on `0.0.0.0` or `[::]`. From another host the port must be unreachable. Without the bearer secret `POST /mcp` returns 401; other paths return 404; GET returns 405 after authentication.

## Audit alarm wiring

Applies when `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve` (default, not finally confirmed by the PM). When an audit write fails the service must (a) log an error line, (b) raise a backlog counter and a degraded flag in its health output, and (c) call an optional alert hook. The health field names, the hook and the spool bounds are TBD (milestone 5 code on the branch; not present at the time of writing, and `src/server.ts` serves only `/mcp` today). Before go-live prove the chain end to end in a staging environment: stop the staging database, make a tool call, confirm the call is served, the error line appears in the journal, the degraded flag and backlog show, and the monitoring alert fires; start the database and confirm the backlog drains to zero and degraded clears. Never run this test against production.
