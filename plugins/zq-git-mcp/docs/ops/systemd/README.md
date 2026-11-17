# zq-git-mcp.service notes

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval.

- Prerequisites: Node >= 24 (`engines` in `package.json`), git >= 2.44 (the service refuses to start below it), `ssh` and `ssh-keyscan` in `/usr/bin` (the code runs them with `PATH=/usr/local/bin:/usr/bin:/bin`).
- `EnvironmentFile` is the 0600 config. systemd reads it as root; the plan still owns it by `zq-git-mcp` (`../install.md`).
- Loopback only: the listen address `127.0.0.1` is hard-coded in `src/service.ts`; no setting changes it.
- `ExecStartPre` hook: `/usr/local/libexec/zq-git-mcp/check-prereqs` is a small script a human writes and reviews (it is not in the repo). It should exit non-zero when `node --version` is below 24, `git --version` is below 2.44, `/etc/zq-git-mcp/zq-git-mcp.env` is not mode 0600, or `/home/zq-git-mcp/data` is not owned by the service user. It is a second line of defence: the service already checks git itself and exits 1 with "git X.Y is too old". Delete the line if no such script is wanted.
- `ProtectHome=tmpfs` plus `BindPaths` hides every other home directory and leaves only the data directory, the only writable path. `MemoryMax` is a suggestion based on the xlsx child heap default (768 MB) times `ZQ_GIT_MCP_MAX_HEAVY_JOBS` (2); tune after measuring. The hardening set is untested on the target host.
- Stop sends SIGTERM; the service closes the listener, kills live git process groups and removes the SSH directory.

## TMPDIR must be short

The unit sets `TMPDIR=/home/zq-git-mcp/data/ssh`. The ssh control socket lives below it as `z-XXXXXX/c` and ssh adds 17 characters while creating it, and a unix socket path may not exceed 107 characters. The service refuses to start when the base is longer than 72 characters. `/home/zq-git-mcp/data/ssh` is 25 characters (worst case socket path 53). A longer user name or data directory needs a shorter `TMPDIR`, for example `/run/zq-git-mcp`.
