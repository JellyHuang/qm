# Database

> **DRAFT.** Nothing described here has been deployed or executed. No database was contacted. Deploying needs the PM's explicit written approval. The DDL itself is a proposal awaiting human review.

## The tables are created by hand, not by QM core

Read this first. It is deliberate and approved.

- `zq_git_branch_tips` and `zq_git_blob_meta` are NOT created by any QM core migration. No migration, no durable-map call and no start of QM core creates them, now or later.
- The service never creates tables either. It has no CREATE privilege and no table creation code.
- A DBA creates both tables by hand, as the database owner, from the approved DDL (below, and sections 2 and 3 of `docs/zq-git-mcp-ddl-proposal.md` on `origin/oa/spike-git`; if the two ever differ, the proposal wins).
- If a table is missing, the service refuses to start, prints the message below and exits with code 1. It does not fall back to memory.
- `zq_git_audit` is different, but not as simple as "core creates it". It is a generic durable-map table (JSON documents, tenant scoped). The only code that ever built it was the old in-process git module of QM core (`deps.map("zq_git_audit")` in `src/zq/runtime.ts`), which commit `7f8eab470` removed. On a database where that old module ran, the table already exists. On a database where it never ran, nothing creates it any more, so the DBA must check (`SELECT to_regclass('zq_git_audit');` returns a name or NULL) and, if it is NULL, create it in the durable-map form of section 1a of the proposal before the service starts. The service treats it like the other two: all three must exist.

Message printed when a table is missing (one line on stderr, then exit 1; the table names are those that are absent):

```
zq-git-mcp failed to start: the database lacks the tables zq_git_branch_tips, zq_git_blob_meta; the service never creates tables
```

The check runs only when `ZQ_GIT_MCP_DATABASE_URL` is set and at least one of `ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS`, `ZQ_GIT_MCP_BLOB_META` is `postgres`. With all three at `memory` (the default) the service never opens a database connection and the tables are not needed. The check only proves that the names exist; a wrong grant or a missing tenant binding shows up later (see the role check below), not at start.

## Order of operations

The DBA steps come BEFORE the service starts with any store set to `postgres`. Never start first and fix later.

1. QM core has already run against this database at least once. The new tables reference `tenants(id)` and use the function `qm_bound_tenant()`, both created by core migrations.
2. A human approves the DDL (done for the tables on 2026-11-16; this is the go-live approval).
3. The DBA, as database owner, creates `zq_git_branch_tips` and `zq_git_blob_meta` from the DDL below. The DBA checks `zq_git_audit` exists and creates it if it does not.
4. The DBA creates the role `zq_git_mcp` with the exact grants and binds the tenant: `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>';` (section "Tenancy, role and retention").
5. The DBA runs the row level security check as the role (same section). Stop here if any check fails.
6. The operator writes `ZQ_GIT_MCP_DATABASE_URL` into `/etc/zq-git-mcp/zq-git-mcp.env` and sets `ZQ_GIT_MCP_AUDIT=postgres`, `ZQ_GIT_MCP_TIPS=postgres`, `ZQ_GIT_MCP_BLOB_META=postgres` (see "When production must set postgres").
7. Only now start the service. Expected: `zq-git-mcp listening on 127.0.0.1:8765, git <version> at <path>`. Stop condition: the refusal message above; do not grant CREATE to the role and do not start the service with memory stores to get past it in production. Go back to step 3.
8. Make one call and check one audit row appeared in `zq_git_audit` for the bound tenant.

Rollback of a failed attempt: set the three stores back to `memory` (or remove the lines), restart. The tables and the role can stay; to remove them see `upgrade-and-rollback.md`.

DDL for step 3 (tenant scoped, approved; run as the database owner; `zq_git_audit` is not part of it):

```sql
CREATE TABLE IF NOT EXISTS zq_git_branch_tips (
  tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id),
  repo text NOT NULL,
  branch text NOT NULL,
  tip_sha text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repo, branch)
);
ALTER TABLE zq_git_branch_tips ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zq_git_branch_tips
  USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());

CREATE TABLE IF NOT EXISTS zq_git_blob_meta (
  tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id),
  repo text NOT NULL,
  oid text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repo, oid)
);
ALTER TABLE zq_git_blob_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zq_git_blob_meta
  USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

## When production must set postgres

The code default for `ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS` and `ZQ_GIT_MCP_BLOB_META` is `memory`, and `config.example.env` keeps the defaults. With `memory` a restart loses every audit row and every stored branch tip, and `check_updates` treats the next call as a first observation. That is acceptable only for development and the first smoke tests.

Production must set all of these together, and only after the DBA step above is done and the role check passed:

```
ZQ_GIT_MCP_AUDIT=postgres
ZQ_GIT_MCP_TIPS=postgres
ZQ_GIT_MCP_BLOB_META=postgres
ZQ_GIT_MCP_DATABASE_URL=postgres://zq_git_mcp:<password>@<db-host>:5432/<qm_db>
ZQ_GIT_MCP_TENANT_ID=<tenant uuid>
```

`ZQ_GIT_MCP_DATABASE_URL` is required as soon as one store is `postgres` (the service refuses to start without it: `databaseUrl: required when audit, tips or blobMeta is postgres`). In production the tenant is bound on the role with `ALTER ROLE` and `ZQ_GIT_MCP_TENANT_ID` may be left out; if it is set it must be a real uuid (a placeholder fails with `tenantId: Invalid UUID`). None of these lines is in `config.example.env`, because the example keeps the code defaults.

## What the proposal says (`docs/zq-git-mcp-ddl-proposal.md` on `origin/oa/spike-git`)

- `zq_git_audit`: existing JSON map table, unchanged at DDL level. The service writes the names `at`, `principal`, `tool`, `repo`, `ref`, `path`, `args`, `bytes`, `truncated`, `result` (`ok`, `error`, `denied:<reason>`), `ms`, `cache_hit`.
- New `zq_git_branch_tips`, primary key `(tenant_id, repo, branch)`, and new `zq_git_blob_meta`, primary key `(tenant_id, repo, oid)`; both created by hand (above), with no migration id.
- Role `zq_git_mcp`: INSERT on audit; SELECT, INSERT, UPDATE on the two new tables; no DELETE, TRUNCATE or default privileges. Never use `qm db grant` for it (too broad).

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

## Tenancy, role and retention (approved by the PM)

- Tables: all three are tenant scoped (`tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id)`, primary keys `(tenant_id, id)`, `(tenant_id, repo, branch)`, `(tenant_id, repo, oid)`, row level security with the `tenant_isolation` policy). `zq_git_audit` is unchanged. The DDL is in `docs/zq-git-mcp-ddl-proposal.md` on `oa/spike-git`.
- Role grants, exactly: `INSERT` on `zq_git_audit`; `SELECT, INSERT, UPDATE` on `zq_git_branch_tips` and `zq_git_blob_meta`. No `DELETE`, no `TRUNCATE`, no `REFERENCES`, no default privileges.
- Tenant binding step (operator, once): `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>';`. `ZQ_GIT_MCP_TENANT_ID` is only the optional per-connection setting for development and tests.
- RLS check after the role exists: connect as `zq_git_mcp`, run `SELECT * FROM zq_git_branch_tips` (rows of the bound tenant only), `SELECT * FROM zq_git_audit` (must fail, no SELECT grant), `DELETE FROM zq_git_branch_tips` (must fail), and with `RESET qm.tenant_id` an insert must fail with "No tenant is bound to this query".
- Retention: `zq_git_audit` is kept 180 days. Pruning is not done by the service role. The table owner runs, in batches until it deletes nothing:

```sql
DELETE FROM zq_git_audit
WHERE ctid IN (
  SELECT ctid FROM zq_git_audit
  WHERE (json->>'at')::double precision < extract(epoch FROM now() - interval '180 days') * 1000
  LIMIT 10000
);
```

QM core has an unscheduled helper for the same rule (`pruneGitAudit`, `src/zq/git-mcp/audit-retention.ts`).

- Logged `args` are not redacted: search patterns and workbook header and key names are stored as given.
- `ZQ_GIT_MCP_AUDIT_ON_FAILURE=fail` is an explicit opt-in; the default `serve` never fails a read tool because of an audit write.
