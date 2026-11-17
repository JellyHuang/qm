# zq-git-mcp operations runbook

> **DRAFT.** Nothing described here has been deployed or executed. No server, user, service or database was touched while writing it. Deploying needs the PM's explicit written approval (see `checklist.md`).

The service is a read-only MCP server over seven GitLab repositories (`client`, `clientcode`, `CommonMessage`, `gameconfig`, `jenkinstasks`, `server`, `zq-ui`). It is the only holder of the read-only SSH key. It listens on `127.0.0.1` only (`POST /mcp`, bearer secret, `X-QM-Caller` label). Sources: `src/config.ts`, `src/service.ts`, and `docs/zq/gitlab-mcp-v1.md` and `docs/zq-git-mcp-ddl-proposal.md` on `origin/oa/spike-git`.

## Files in this folder

| File                         | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `install.md`                 | users, directories, modes, release layout             |
| `systemd/zq-git-mcp.service` | unit file text (notes in `systemd/README.md`)         |
| `config.example.env`         | every setting with a placeholder                      |
| `checks.md`                  | git version, host key, disk, ssh dir, loopback, alarm |
| `database.md`                | role and tables, audit failure policy                 |
| `logging-and-backup.md`      | logs, durable vs disposable, spool, rebuild           |
| `upgrade-and-rollback.md`    | upgrade, rollback, core wiring                        |
| `checklist.md`               | pre-go-live checklist and approval                    |

## Order of steps

1. The PM approves in writing, with the rollback plan from `upgrade-and-rollback.md` attached.
2. Prerequisites: Node >= 24, git >= 2.44, `openssh-client` on the host (`checks.md`).
3. Create the system user and directories (`install.md`).
4. Place the release under `/opt/zq-git-mcp` (`install.md`).
5. A human verifies the GitLab host key fingerprint on the GitLab server (`checks.md`).
6. Write `/etc/zq-git-mcp/zq-git-mcp.env` from `config.example.env`, mode 0600, owner `zq-git-mcp`. The key goes only there.
7. Database: tables, role, connection string (`database.md`). The code on the branch does not read a database setting yet; see the gap listed there.
8. Install the unit, `systemctl daemon-reload`, start it, read the journal (`logging-and-backup.md`).
9. Run the smoke tests, the loopback check and the alarm test (`checklist.md`, `checks.md`).
10. Provision the shared secret on the QM side and register the tool contract. Do not revert commit `7f8eab470` until the QM-side client exists (`upgrade-and-rollback.md`).

## Start-up behaviour (from `src/service.ts`)

In order: git version check (refuse if < 2.44), SSH start (refuse if no host key offered by the server matches the pinned fingerprint), scratch sweep of dead-pid job dirs, cache scan, SSH warm-up (failure is only logged), listen on `127.0.0.1:<port>`. Clones are created lazily on first use of a repository, not at start.
