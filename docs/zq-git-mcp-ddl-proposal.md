# DDL proposal: GitLab read-only MCP service (for human review)

Status: PROPOSAL ONLY. Nothing here is applied or implemented. No database was contacted; "current" shapes are derived from repo code.

## 0. How this repo does tables and roles (facts from the code)

- No .sql files. Migrations are TS objects `{id, statements[]}` registered via `pg.registerMigration` and run by `pg.migrate` (src/persistence/pg-pool.ts), recorded in a ledger table, ids like `durable-map/<table>/0001`.
- `zq_git_audit` is NOT a hand-written typed table. `deps.map<GitAuditRow>("zq_git_audit")` (src/zq/runtime.ts:197) creates it lazily through `createPostgresMap` (src/persistence/durable-map.ts) as a generic JSON document table, then adds tenancy via `durableMapTenancy` (src/tenants/migrations.ts).
- Postgres: CI uses pgvector/pgvector:0.8.1-pg16 (Postgres 16). No other version statement found.
- Roles: no migration creates roles. `qm db grant <role>` (scripts/db.ts, src/persistence/app-role-grants.ts) is an operator step run as the DB owner, and grants SELECT/INSERT/UPDATE/DELETE/TRUNCATE on ALL tables plus default privileges. It is far too broad for the new service role and must NOT be used for it.

## 1. zq_git_audit

### 1a. Current definition (assembled from code; live DB not inspected)

Created by migration `durable-map/zq_git_audit/0001`:
CREATE TABLE IF NOT EXISTS zq_git_audit (id TEXT PRIMARY KEY, json JSONB NOT NULL)
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)
Then tenancy (`durable-map/zq_git_audit/0010-tenants/*`, tenantTables):
ALTER TABLE zq_git_audit ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant if rows exist>
CREATE UNIQUE INDEX CONCURRENTLY zq_git_audit_tenant_pkey ON zq_git_audit(tenant_id, id)
ALTER TABLE zq_git_audit DROP CONSTRAINT zq_git_audit_pkey, ADD CONSTRAINT zq_git_audit_pkey PRIMARY KEY USING INDEX zq_git_audit_tenant_pkey
ALTER TABLE zq_git_audit ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()
ALTER TABLE zq_git_audit ADD CONSTRAINT zq_git_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
ALTER TABLE zq_git_audit ENABLE ROW LEVEL SECURITY
CREATE POLICY tenant_isolation ON zq_git_audit USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())
Resulting columns: id TEXT NOT NULL (random UUID string per call), json JSONB NOT NULL, tenant_id UUID NOT NULL DEFAULT qm_bound_tenant(). PK (tenant_id, id). No other indexes, no secondary index fields (map created with none). No CHECK constraints.
Each put also bumps durable_map_versions(tenant_id, tbl) (the map's cache version).
json shape (GitAuditRow, src/zq/git/audit.ts), keys omitted when undefined:
at number (epoch ms), principal string, tool string, repo? string, ref? string, path? string,
bytes number, truncated boolean, result "ok" | "denied:<reason>" | "rate_limited" | "error", ms number
Only other readers: audit.rows(), audit.bytesSince() (used by limits.ts, to be removed) and scripts/zq-git-verify.ts. Nothing else reads it.

### 1b. Field mapping for the new service

caller (X-QM-Caller label) -> existing `principal`: reused, unchanged (value now the label)
timestamp -> `at`: unchanged
tool name -> `tool`: unchanged
repo -> `repo`: unchanged
ref/range -> `ref`: unchanged (range stored as "base..head" string)
path -> `path`: unchanged
args as JSON -> `args`: ADDED (new optional JSON key; validated args only, never content)
bytes returned -> `bytes`: unchanged
truncated flag -> `truncated`: unchanged
result -> `result`: reused. "refused" is written as existing `denied:<reason>`; "error" unchanged; "truncated" is NOT a result, it is the `truncated` flag with result "ok". `rate_limited` becomes unused (limits removed).
duration_ms -> `ms`: unchanged name (not renamed)
cache_hit -> `cache_hit`: ADDED (new optional boolean JSON key)
Unused: `rate_limited` result value.
DDL change: NONE. json is schemaless; the two new keys need no ALTER. Columns, indexes, constraints: unchanged. No existing column or key is dropped or changed. Content, diffs, commit messages are never stored (args hold names/refs/paths/line ranges/patterns only; `search` pattern is an argument, flag in open questions).
Statement: zq_git_audit is UNCHANGED at the DDL level.

## 2. NEW zq_git_branch_tips

CREATE TABLE IF NOT EXISTS zq_git_branch_tips (
repo text NOT NULL,
branch text NOT NULL,
tip_sha text NOT NULL,
seen_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY (repo, branch)
);
Migration id proposal: `zq/zq_git_branch_tips/0001`.

## 3. NEW zq_git_blob_meta

CREATE TABLE IF NOT EXISTS zq_git_blob_meta (
repo text NOT NULL,
oid text NOT NULL,
size_bytes bigint NOT NULL,
sha256 text,
seen_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY (repo, oid)
);
Migration id proposal: `zq/zq_git_blob_meta/0001`. sha256 nullable (an over-cap blob is aborted before it can be hashed); drop NULL-ability if you want it required.

### Tenancy gap (decision needed)

Every table in this repo is tenant-scoped (tenant_id + RLS + `qm_bound_tenant()`). The two plain tables above, as specified, are not. Variant if you want them tenanted: add `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id)`, PK (tenant_id, repo, branch) / (tenant_id, repo, oid), ENABLE ROW LEVEL SECURITY and the same tenant_isolation policy.

## 4. Service role

Proposed operator-run SQL (as DB owner; NOT carried by migrations):
CREATE ROLE zq_git_mcp LOGIN PASSWORD '<from operator, never in Git>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM zq_git_mcp;
GRANT CONNECT ON DATABASE <qm_db> TO zq_git_mcp;
GRANT USAGE ON SCHEMA public TO zq_git_mcp;
GRANT INSERT ON zq_git_audit TO zq_git_mcp;
GRANT SELECT, INSERT, UPDATE ON zq_git_branch_tips, zq_git_blob_meta TO zq_git_mcp;
No DELETE, TRUNCATE, REFERENCES, TRIGGER, no default privileges, no sequences needed (no serial columns), no grant on tenants or durable_map_versions.
RLS wrinkle on zq_git_audit: INSERT must satisfy WITH CHECK tenant_id = qm_bound_tenant(), which reads setting qm.tenant_id. Without it the insert fails ("No tenant is bound"). Proposal: `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>'` (single-tenant deployment), and the service omits tenant_id so the DEFAULT applies. The FK to tenants is checked as table owner, so no REFERENCES grant is needed. Also, raw INSERTs do not bump durable_map_versions, so core's cached zq_git_audit reads may lag up to 15 s (CACHE_MAX_AGE_MS); acceptable for audit.
Table owner/ordering: grants must run after the tables exist (first QM start after deploy creates audit lazily; new tables via migration).
Can migrations carry roles? No: no precedent, roles are cluster-level, passwords must not be in Git, and the app's own role may lack CREATEROLE. Needs an operator step.
Connection string: service-only config, e.g. env/file `ZQ_GIT_MCP_DATABASE_URL=postgres://zq_git_mcp:<password>@host:5432/<db>` in the service account's private environment file (mode 0600, owned by the service account) or its keychain item; never in Git, never given to QM core, agents or sandboxes, never logged. Exact mechanism is open (same open point as the SSH key source).

## 5. Examples (INVENTED, for illustration)

Before (zq_git_audit, existing shape):
id=7c1e... tenant_id=11111111-... json={"at":1760000000000,"principal":"zq-pm","tool":"git_recent_commits","repo":"server","bytes":4210,"truncated":false,"result":"ok","ms":380}
After (new service row, same table, two extra optional keys):
id=9b3a... tenant_id=11111111-... json={"at":1760000300000,"principal":"zq-core","tool":"read_file","repo":"gameconfig","ref":"main","path":"cfg/items.xlsx","args":{"lines":[1,200]},"bytes":65536,"truncated":true,"result":"ok","ms":2610,"cache_hit":false}
refused: {... "tool":"read_file","result":"denied:file_too_large","bytes":0,"truncated":false,"ms":900,"cache_hit":false}
zq_git_branch_tips: ('server','main','a1b2c3d4e5f6...40hex','2026-11-16 10:05:00+00')
after next poll with new commit: same PK, tip_sha='f6e5d4c3...', seen_at='2026-11-16 10:10:00+00'
zq_git_blob_meta: ('gameconfig','e69de29b...40hex',18874368,'9f86d081...64hex','2026-11-16 10:06:12+00')

### Rollout

1. Merge code with migrations for the two tables (idempotent CREATE TABLE IF NOT EXISTS). 2. Operator runs the role SQL. 3. Put the connection string in the service's private config. 4. Start the service.

### Rollback

DROP TABLE IF EXISTS zq_git_blob_meta;
DROP TABLE IF EXISTS zq_git_branch_tips;
REVOKE ALL ON zq_git_audit FROM zq_git_mcp; DROP OWNED BY zq_git_mcp; DROP ROLE zq_git_mcp;
zq_git_audit is left alone (rows kept; the extra JSON keys are harmless). Migration ledger rows stay; remove the ids if re-adding.

### Tables missing at run time

Proposal: the service must not create tables (no CREATE privilege). On start it checks the three tables exist and refuses to serve (fail closed with a clear message) rather than serve unaudited calls. If audit insert fails mid-run: open question (fail the call vs serve and log to stderr).

### Compatibility / retention

Only audit.ts, limits.ts (to be deleted), scripts/zq-git-verify.ts read zq_git_audit; old rows stay valid since new keys are optional. `GitAuditResult` type needs no new variants. Retention: none today (rows kept forever); design doc leaves it open. deleteBefore("at", cutoff) exists in DurableMap for a future sweep run by core, not by the service role (it has no DELETE).

### Explicit statements

No existing column, index, constraint, or JSON key is dropped or changed. Configuration: adds service-only connection string and a DB role; no existing setting changes.

## 6. Open questions

1. Typed tables as specified vs the repo convention (JSON map tables via createPostgresMap) and tenant_id+RLS: which?
2. Single tenant binding via ALTER ROLE ... SET qm.tenant_id acceptable?
3. May QM core (poll job) also read/write branch_tips? Then core needs grants, or only the service writes it. Who deletes branch tips of removed branches (no DELETE grant)?
4. blob_meta: sha256 nullable? Any pruning when LRU evicts blobs (no DELETE for the service)?
5. Is `args` safe to store for `search` (pattern may be sensitive) and `diff_xlsx` (header/key names)? Redact or omit?
6. Fail closed vs serve when audit insert fails.
7. Audit retention period and who prunes.
8. Is the caller label (X-QM-Caller) trusted, or just a self-declared label? Stored in `principal` either way.
9. Postgres version for production (CI is 16; production not verified).
10. Password/connection string delivery mechanism.

## 7. Plain-language summary for the reviewer

1. Two new tables are created. The existing `zq_git_audit` table keeps its structure.
2. `zq_git_branch_tips` records, per repository and branch, the latest commit last seen, so the service can tell whether anything new arrived.
3. `zq_git_blob_meta` records the size and fingerprint of files already downloaded, so asking whether a file changed does not need a new download.
4. `zq_git_audit` keeps logging every call. Each row gains two optional items: the call arguments and whether the cache was hit. File content, diffs and commit messages are never stored.
5. Who can read and write: one new database account used only by this service. It can only add rows to the audit table, can read, add and update rows in the two new tables, cannot delete, and cannot touch any other table.
6. Tenant isolation, recommended: make both new tables tenant-scoped with row-level security, like every other table, so there is no exception. The cost is that the service account must be bound to that tenant.
7. Operations has three steps: run the role-creation SQL, put the connection string in the service's own configuration, and confirm the service sees all three tables at start. The tables themselves come from migrations; the role cannot be created by a migration.
8. Rollback: drop the two new tables, then drop the database account, five statements in total, at any time.
9. Existing tables and data are unaffected: no column, index or constraint is changed or removed, and old rows stay valid.
10. Open for the reviewer: redact search patterns in logged arguments or not, whether a failed audit write fails the call, audit retention, how the service account is bound to the tenant, and how the connection string is delivered.
