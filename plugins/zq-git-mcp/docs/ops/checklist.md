# Pre-go-live checklist

> **DRAFT.** Nothing described here has been deployed or executed. Deployment needs the PM's explicit written approval.

- [ ] The read-only SSH key is stored only in `/etc/zq-git-mcp/zq-git-mcp.env` (`GITLAB_QM_READONLY_SSH_KEY_B64`), nowhere else, not in Git, not in the QM keychain, not in logs
- [ ] The config file is mode 0600, owned by `zq-git-mcp`; `/etc/zq-git-mcp` is 0750 and `/home/zq-git-mcp` is 0700
- [ ] An ordinary session (a normal user, an agent sandbox) cannot read the config, the data directory or `/proc/<pid>/environ` of the service
- [ ] A human verified the host key fingerprint on the GitLab server with `ssh-keygen -lf` and it equals `ZQ_GIT_MCP_SSH_HOST_FINGERPRINT`
- [ ] `git --version` >= 2.44 and Node >= 24 on the host; the start refuses an old git
- [ ] Loopback binding confirmed with `ss -ltnp` (only `127.0.0.1:8765`); 401 without the bearer secret
- [ ] The shared secret (`ZQ_GIT_MCP_SECRET`, >= 16 characters) is provisioned on the QM side and nowhere else
- [ ] The tool contract (`list_repos`, `list_commits`, `get_commit`, `get_diff`, `read_file`, `blame`, `search`, `diff_xlsx`, `check_updates`) is registered on the QM side; `list_heads` of the design does not exist, `check_updates` replaces it
- [ ] `plugins/chassis` is installed next to `plugins/zq-git-mcp` (the service imports it by relative path)
- [ ] The store switches (`ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS`, `ZQ_GIT_MCP_BLOB_META`) are set deliberately; the default is `memory` and a restart then loses audit rows and branch tips, so production must set `postgres` (see the next items)
- [ ] The DBA created `zq_git_branch_tips` and `zq_git_blob_meta` by hand from the approved DDL (no QM core migration creates them) and confirmed `zq_git_audit` exists (the removed in-process module was its only creator), all BEFORE the first start with a postgres store
- [ ] The role `zq_git_mcp` exists with the tenant binding before the service starts; a start with a missing table was tried once in staging and printed `the database lacks the tables ...; the service never creates tables`
- [ ] Production sets `ZQ_GIT_MCP_AUDIT=postgres`, `ZQ_GIT_MCP_TIPS=postgres`, `ZQ_GIT_MCP_BLOB_META=postgres` and `ZQ_GIT_MCP_DATABASE_URL` (and `ZQ_GIT_MCP_TENANT_ID` if the role is not bound) only after the previous two items are done; `config.example.env` keeps the code default `memory`
- [ ] The database DDL is approved by a human and the role is created (`database.md`); the tenanted variant is approved
- [ ] The audit failure policy stays `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve` (a read tool never fails because of the audit); `fail` only as an explicit opt-in
- [ ] The role grants are exactly `INSERT` on `zq_git_audit` and `SELECT, INSERT, UPDATE` on `zq_git_branch_tips` and `zq_git_blob_meta`; no `DELETE` anywhere
- [ ] `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<uuid>'` was run and the row level security check in `database.md` passed (own tenant only, unbound insert fails, no SELECT on the audit table)
- [ ] The 180 day retention job for `zq_git_audit` is scheduled by the table owner or by QM core and a first run was checked
- [ ] Alarm wiring tested in staging by stopping the database: error log line, backlog and degraded flag, alert fired, backlog drained after restart
- [ ] The data directory is on `/home` with space for scratch (20 GiB cap + 5 GiB floor), cache (2 GiB), clones and the audit spool
- [ ] Smoke tests pass: `list_repos`, `list_commits`, `read_file` on a small file, `diff_xlsx` on a gameconfig file, `check_updates` (first poll, then ack, then a poll that reports nothing new)
- [ ] The real-server integration tests pass (`test/real-server.test.ts` with `ZQ_GIT_MCP_IT_REPO`, `ZQ_GIT_MCP_IT_PATH` set)
- [ ] Monitoring and alerts exist for service down; QM-side polling treats an unreachable service as an error, not as "no updates"
- [ ] Journald retention is set; the journal showed no key or secret on first start
- [ ] The rollback plan (`upgrade-and-rollback.md`) is attached to the approval
- [ ] Approval: the PM approves the deployment in writing

Approved by: ______________ Date: ______________

- [ ] `TMPDIR` (the ssh runtime base) is at most 72 characters; the service started without the control socket path error
- [ ] If git is not in `/usr/bin`, `ZQ_GIT_MCP_GIT_BIN` is set and the start line and `list_repos` show the expected git path and a version of at least 2.44
