# Database

> **DRAFT.** Nothing described here has been deployed or executed. No database was contacted. Deploying needs the PM's explicit written approval. The DDL itself is a proposal awaiting human review.

## Gap between the code and the design

On the branch the service has no database code: `src/audit.ts`, `src/tip-store.ts` and `src/ledger.ts` provide memory implementations only (the audit sink keeps the last 10,000 rows in RAM), `src/config.ts` has no database setting, and `createService` takes `audit` and `tips` as injectable deps. Until the Postgres implementations land, run with memory stores (the default) and treat audit as disposable; the steps below apply once they exist. The proposed names are `ZQ_GIT_MCP_DATABASE_URL` (from the DDL proposal) and `ZQ_GIT_MCP_AUDIT_ON_FAILURE`.

## What the proposal says (`docs/zq-git-mcp-ddl-proposal.md` on `origin/oa/spike-git`)

- `zq_git_audit`: existing JSON map table, unchanged at DDL level. Two optional JSON keys are added (`args`, `cache_hit`). The code's row uses the names `caller`, `durationMs`, `cacheHit` and result `refused:<reason>`; the proposal maps them to `principal`, `ms`, `cache_hit` and `denied:<reason>`. That mapping must be settled before go-live.
- New `zq_git_branch_tips(repo, branch, tip_sha, seen_at)`, PK `(repo, branch)`, migration id `zq/zq_git_branch_tips/0001`.
- New `zq_git_blob_meta(repo, oid, size_bytes, sha256, seen_at)`, PK `(repo, oid)`, migration id `zq/zq_git_blob_meta/0001`.
- Role `zq_git_mcp`: INSERT on audit; SELECT, INSERT, UPDATE on the two new tables; no DELETE, TRUNCATE or default privileges. Never use `qm db grant` for it (too broad).
- Open: tenant scoping with row-level security (recommended), `ALTER ROLE ... SET qm.tenant_id`, retention, the connection string delivery.

## Operator steps, in order (a human, after approval)

1. A human reviews and approves the DDL proposal; decide the tenancy variant.
2. Merge the code with the migrations. They run through the app's migrate path; the service never creates tables and has no CREATE privilege.
3. Confirm the three tables exist (the first QM start creates `zq_git_audit` lazily).
4. As database owner, run the role SQL from section 4 of the proposal with a password the operator generates (not in Git): CREATE ROLE, REVOKE, GRANT CONNECT, GRANT USAGE, the table grants, and `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>'` for a single-tenant deployment.
5. Put `ZQ_GIT_MCP_DATABASE_URL=postgres://zq_git_mcp:<password>@<db-host>:5432/<qm_db>` in `/etc/zq-git-mcp/zq-git-mcp.env` only.
6. Start the service. Proposed behaviour: it checks the three tables exist and refuses to start otherwise.
7. Make one call and check one audit row appeared.

## Switches

- Stores: `ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS` and `ZQ_GIT_MCP_BLOB_META` each take `memory` (default) or `postgres`. Any `postgres` needs `ZQ_GIT_MCP_DATABASE_URL`; `ZQ_GIT_MCP_TENANT_ID` (optional uuid) is set as `qm.tenant_id` on each connection. With a `postgres` store the service refuses to start unless `zq_git_audit`, `zq_git_branch_tips` and `zq_git_blob_meta` all exist; it never creates tables.
- Audit fields (the `json` of `zq_git_audit`): `at`, `principal`, `tool`, `repo`, `ref`, `path`, `args`, `bytes`, `truncated`, `result` (`ok`, `error`, `denied:<reason>`), `ms`, `cache_hit`; the row `id` is a uuid and the insert is `ON CONFLICT DO NOTHING`.
- Deleted branches are tombstones (`tip_sha` of 40 zeros, updated in place); the service role needs no DELETE (`../check-updates.md`).
- `ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve|fail`, default `serve`. The PM has not finally confirmed this default.
  - `serve`: the call proceeds; the audit record is appended to a local JSONL spool (mode 0600, in the data directory, bounded by `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES` (default 64 MiB) and `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS` (default 7 days), directory `ZQ_GIT_MCP_AUDIT_SPOOL_DIR`, default `<data>/audit-spool`) and a retry loop replays it into Postgres. The service logs an error line, raises a backlog counter and a degraded flag in the health output, and calls an optional injectable alert hook.
  - `fail`: the call is refused when its audit row cannot be written.

## Database down

In `serve` mode nothing is lost while the spool stays within its bounds: calls continue, records queue locally, and they replay in order after the database returns. Check the backlog through `auditBacklog`, `auditDegraded` and `auditLastError` in the `list_repos` result and the journal error lines; on disk, the segment files under `/home/zq-git-mcp/data/audit-spool`. If the spool reaches its size bound, new rows are dropped, `auditDropped` counts them and an `audit_dropped` line with `reason` `spool_full` is logged for each; treat that as an incident. Do not delete the spool by hand while the service runs. `zq_git_branch_tips` and `zq_git_blob_meta` hold no secrets; if only they are unreachable the same alarm logic applies as defined in the code.

## Rollback

See `upgrade-and-rollback.md`.
