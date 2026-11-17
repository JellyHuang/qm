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
- [ ] The database DDL is approved by a human and the role is created (`database.md`); tenancy variant decided
- [ ] The audit failure policy `ZQ_GIT_MCP_AUDIT_ON_FAILURE` (default `serve`) is confirmed by the PM
- [ ] Alarm wiring tested in staging by stopping the database: error log line, backlog and degraded flag, alert fired, backlog drained after restart
- [ ] The data directory is on `/home` with space for scratch (20 GiB cap + 5 GiB floor), cache (2 GiB), clones and the audit spool
- [ ] Smoke tests pass: `list_repos`, `list_commits`, `read_file` on a small file, `diff_xlsx` on a gameconfig file, `check_updates` (first poll, then ack, then a poll that reports nothing new)
- [ ] The real-server integration tests pass (`test/real-server.test.ts` with `ZQ_GIT_MCP_IT_REPO`, `ZQ_GIT_MCP_IT_PATH` set)
- [ ] Monitoring and alerts exist for service down; QM-side polling treats an unreachable service as an error, not as "no updates"
- [ ] Journald retention is set; the journal showed no key or secret on first start
- [ ] The rollback plan (`upgrade-and-rollback.md`) is attached to the approval
- [ ] Approval: the PM approves the deployment in writing

Approved by: ______________ Date: ______________
