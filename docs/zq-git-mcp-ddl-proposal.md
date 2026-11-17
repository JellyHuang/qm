# DDL proposal: GitLab read-only MCP service (for human review)

Status: APPROVED by the PM on 2026-11-16 for the decisions marked APPROVED below (tenant scoped tables, the role grants, no redaction, audit retention, serve on audit failure). Nothing here is applied: no database was contacted, "current" shapes are derived from repo code, and the migrations and the role SQL are still to be written and reviewed.

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

## 2. NEW zq_git_branch_tips (APPROVED, tenant scoped)

CREATE TABLE IF NOT EXISTS zq_git_branch_tips (
tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id),
repo text NOT NULL,
branch text NOT NULL,
tip_sha text NOT NULL,
seen_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY (tenant_id, repo, branch)
);
ALTER TABLE zq_git_branch_tips ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zq_git_branch_tips USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
Migration id proposal: `zq/zq_git_branch_tips/0001`.

Deleted branches are never removed (the service role has no DELETE). A deleted branch is a tombstone row: `tip_sha` = '0000000000000000000000000000000000000000' with `seen_at` updated, written by `UPDATE ... WHERE repo = $1 AND branch = $2 AND tip_sha = $3` (the tip that was reported). A tombstone means "deleted and already reported": it is not a current branch and is not reported again. A branch that returns is a NEW branch; its acknowledgement is the same compare-and-set with `tip_sha = <tombstone>`. Rows are written only by acknowledged polls: first observation `INSERT ... ON CONFLICT (tenant_id, repo, branch) DO NOTHING`, then `UPDATE ... SET tip_sha = $to, seen_at = now() WHERE repo = $1 AND branch = $2 AND tip_sha = $from`. See plugins/zq-git-mcp/docs/check-updates.md.

## 3. NEW zq_git_blob_meta (APPROVED, tenant scoped)

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
CREATE POLICY tenant_isolation ON zq_git_blob_meta USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
Migration id proposal: `zq/zq_git_blob_meta/0001`. sha256 stays nullable (unknown until the content was hashed). The code-only "binary" flag is not stored; it is derived again when a file is read. The service writes `INSERT ... ON CONFLICT (tenant_id, repo, oid) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = COALESCE(EXCLUDED.sha256, zq_git_blob_meta.sha256), seen_at = now()`.

### Tenancy (decided)

Every table in this repo is tenant scoped, so the two new tables are too, with the same pattern as src/tenants/migrations.ts (column default `qm_bound_tenant()`, foreign key to `tenants`, row level security, `tenant_isolation` policy with USING and WITH CHECK). The tenant is bound to the service role once: `ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>'`. The service never names a tenant in a statement; inserts use the column default and reads are filtered by the policy. For development and tests only, the service has the optional setting ZQ_GIT_MCP_TENANT_ID, applied as a session setting on each connection. An unbound connection fails with "No tenant is bound to this query". `zq_git_audit` is unchanged.

## 4. Service role (APPROVED)

Proposed operator-run SQL (as DB owner; NOT carried by migrations):
CREATE ROLE zq_git_mcp LOGIN PASSWORD '<from operator, never in Git>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM zq_git_mcp;
GRANT CONNECT ON DATABASE <qm_db> TO zq_git_mcp;
GRANT USAGE ON SCHEMA public TO zq_git_mcp;
GRANT INSERT ON zq_git_audit TO zq_git_mcp;
GRANT SELECT, INSERT, UPDATE ON zq_git_branch_tips, zq_git_blob_meta TO zq_git_mcp;
ALTER ROLE zq_git_mcp SET qm.tenant_id = '<tenant uuid>';
The approved grants are exactly: INSERT only on zq_git_audit; SELECT, INSERT, UPDATE on zq_git_branch_tips and zq_git_blob_meta. UPDATE is required by the acknowledgement compare-and-set and by the tombstones. No DELETE, no TRUNCATE, no REFERENCES, no TRIGGER, no default privileges, no sequences needed, no grant on tenants or durable_map_versions. The foreign key to tenants is checked as the table owner, so no REFERENCES grant is needed.
RLS on zq_git_audit: INSERT must satisfy WITH CHECK tenant_id = qm_bound_tenant(), which reads setting qm.tenant_id; the ALTER ROLE above provides it and the service omits tenant_id so the DEFAULT applies. Raw INSERTs do not bump durable_map_versions, so core's cached zq_git_audit reads may lag up to 15 s (CACHE_MAX_AGE_MS); acceptable for audit.
Table owner/ordering: grants must run after the tables exist (first QM start after deploy creates audit lazily; new tables via migration).
Can migrations carry roles? No: no precedent, roles are cluster-level, passwords must not be in Git, and the app's own role may lack CREATEROLE. Needs an operator step.
Connection string: service-only config, e.g. env/file `ZQ_GIT_MCP_DATABASE_URL=postgres://zq_git_mcp:<password>@host:5432/<db>` in the service account's private environment file (mode 0600, owned by the service account) or its keychain item; never in Git, never given to QM core, agents or sandboxes, never logged. The exact delivery mechanism is still open.

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

1. Merge code with migrations for the two tables (idempotent CREATE TABLE IF NOT EXISTS, row level security and policy). 2. Operator runs the role SQL, including the ALTER ROLE tenant binding. 3. Put the connection string in the service's private config. 4. Start the service; it refuses to start if one of the three tables is missing. 5. Check as the role: own tenant rows only, no SELECT on zq_git_audit, no DELETE, an insert without a bound tenant fails.

### Rollback

DROP TABLE IF EXISTS zq_git_blob_meta;
DROP TABLE IF EXISTS zq_git_branch_tips;
REVOKE ALL ON zq_git_audit FROM zq_git_mcp; DROP OWNED BY zq_git_mcp; DROP ROLE zq_git_mcp;
zq_git_audit is left alone (rows kept; the extra JSON keys are harmless). Migration ledger rows stay; remove the ids if re-adding.

### Tables missing at run time

The service must not create tables (no CREATE privilege). On start it checks the three tables exist and refuses to start with a clear message. If an audit insert fails mid-run (APPROVED): the default is ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve, so a read tool is never failed by the audit; the row goes to a bounded local on-disk spool (write-ahead buffer, not a system of record) that is replayed into zq_git_audit in order, with a structured error log line, a counter, a degraded health state and an injectable alert hook. `fail` stays available only as an explicit opt-in.

### Compatibility / retention (APPROVED)

Only audit.ts, limits.ts (to be deleted), scripts/zq-git-verify.ts read zq_git_audit; old rows stay valid since new keys are optional. `GitAuditResult` type needs no new variants. The service's audit row has exactly the table's names: at, principal, tool, repo, ref, path, args, bytes, truncated, result (ok, error, denied:<reason>), ms, cache_hit.

Retention for zq_git_audit is 180 days. The service role has no DELETE, so pruning is a job of the table owner or of QM core. Exact statement (owner, in batches until it deletes nothing; the owner bypasses row level security so it prunes every tenant):
DELETE FROM zq_git_audit WHERE ctid IN (SELECT ctid FROM zq_git_audit WHERE (json->>'at')::double precision < extract(epoch FROM now() - interval '180 days') * 1000 LIMIT 10000);
QM core has an unscheduled helper `pruneGitAudit` (src/zq/git-mcp/audit-retention.ts) that applies the same rule through the durable map's deleteBefore("at", cutoff) under the bound tenant.

No redaction (APPROVED): logged args are stored as they are, including search patterns and workbook header and key names. File content, diffs and commit messages are never stored.

### Explicit statements

No existing column, index, constraint, or JSON key is dropped or changed. Configuration: adds service-only connection string and a DB role; no existing setting changes.

## 6. Decisions and open questions

Decided by the PM on 2026-11-16 (APPROVED):

1. Both new tables are tenant scoped (tenant_id, composite primary keys, row level security, tenant_isolation policy). Typed tables, not JSON map tables.
2. The role is bound to the tenant with ALTER ROLE ... SET qm.tenant_id; ZQ_GIT_MCP_TENANT_ID is only an optional per-connection setting for development and tests.
3. Exact grants: INSERT on zq_git_audit; SELECT, INSERT, UPDATE on the two new tables; no DELETE anywhere.
4. Logged args are not redacted.
5. An audit write failure never fails a read tool by default (serve, with a spool and alarms); fail is an explicit opt-in.
6. zq_git_audit is kept 180 days, pruned by the table owner or by QM core, not by the service role.
7. blob_meta: sha256 is nullable; the binary flag is not stored; no pruning when the blob cache evicts.
8. The caller label X-QM-Caller (or the actor header) is a self-declared label, stored in `principal` as given.

Still open:

1. How the connection string is delivered to the service (private env file or keychain item).
2. The mechanics of binding the role to the tenant in a multi-tenant deployment (one role per tenant, or one tenant per deployment).
3. Pruning of tombstone rows in zq_git_branch_tips and of old zq_git_blob_meta rows (the service role cannot delete; an owner or core job would).
4. Postgres version for production (CI is 16; production not verified).

## 7. Plain-language summary for the reviewer (APPROVED decisions applied)

1. Two new tables are created. The existing `zq_git_audit` table keeps its structure; no existing table, column, index or constraint is changed.
2. `zq_git_branch_tips` records, per repository and branch, the latest commit last acknowledged, so the service can tell whether anything new arrived. A deleted branch is marked in place with an all-zero commit and is never removed.
3. `zq_git_blob_meta` records the size and fingerprint of files already downloaded, so asking whether a file changed does not need a new download.
4. `zq_git_audit` keeps logging every call. Each row gains two optional items: the call arguments (stored as given, not redacted) and whether the cache was hit. File content, diffs and commit messages are never stored.
5. Who can read and write: one new database account used only by this service. It can only add rows to the audit table, can read, add and update rows in the two new tables, can never delete, and cannot touch any other table.
6. Both new tables are tenant scoped with row-level security like every other table, so there is no exception. The service account is bound to its tenant once, by an ALTER ROLE statement.
7. Operations: run the role-creation SQL (including the tenant binding), put the connection string in the service's own configuration, and confirm the service sees all three tables at start. The tables come from migrations; the role cannot be created by a migration.
8. A failed audit write never fails a read; rows wait in a bounded local buffer and are replayed, with an alarm. Audit rows older than 180 days are pruned by the table owner or by QM core, in batches.
9. Rollback: drop the two new tables, then drop the database account, five statements in total, at any time. Existing tables and data are unaffected, and old rows stay valid.
10. Still open: how the connection string is delivered, how the role is bound to the tenant in a multi-tenant deployment, and pruning of tombstones.

## 8. Author mapping tables (not yet approved)

Status: NOT APPROVED. Nothing here is applied and no database was contacted. The code lives on branch `oa/zq-author-map` (docs/zq/author-mapping.md). It is switched off by `ZQ_GIT_AUTHOR_MAPPING` (default off, set in no environment): with the switch off the code builds no durable map, so neither table is registered or created. Turning the switch on makes the durable-map layer create both tables, so the switch must stay off until this section is approved.

These are core-side tables used only by QM core. The zq-git-mcp service role (section 4) gets no grant on them. QM core reads and writes them with its normal application role (the one in `DATABASE_URL`, privileges from `qm db grant`), which also runs the migrations.

### Table definitions as the durable-map layer creates them

Both tables are generic JSON document tables, created by `createPostgresMap` and `durableMapTenancy` (src/persistence/durable-map.ts, src/tenants/migrations.ts), migration ids `durable-map/<table>/0001`, `durable-map/<table>/0010-tenants/...`, `durable-map/<table>/0020-claim-ids` and `0021-claim-tenants`. For `T` in `zq_git_author_aliases`, `zq_git_unmapped_authors`:

CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY, json JSONB NOT NULL);
ALTER TABLE T ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if T already has rows>;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS T_tenant_pkey ON T(tenant_id, id);
ALTER TABLE T DROP CONSTRAINT T_pkey, ADD CONSTRAINT T_pkey PRIMARY KEY USING INDEX T_tenant_pkey;
ALTER TABLE T ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE T ADD CONSTRAINT T_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON T USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
Plus the functions `claim_T()` and `claim_T_tenants()`. Net result per table: columns `id text`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, no other index. `durable_map_versions` already exists and gets a row per tenant and table.

### JSON shapes (examples are INVENTED)

`zq_git_author_aliases`, id `<normalised email>|<personId>`, one row per (address, person); two people on one address make the author ambiguous.

- Shape: `{ "email": text, "personId": text, "mattermostUser": text, "addedBy": text, "addedAt": epoch ms }`
- Example (INVENTED): id `zhang.home@example.org|p-zhang`, json `{ "email": "zhang.home@example.org", "personId": "p-zhang", "mattermostUser": "mm-zhang", "addedBy": "pm", "addedAt": 1763000000000 }`

`zq_git_unmapped_authors`, id the normalised commit email (`(none)` if empty). No commit message, subject or diff is stored.

- Shape: `{ "email", "name", "reason": "no_match" | "invalid_email" | "ambiguous", "candidates": [personId], "status": "open" | "resolved" | "ignored", "firstSeenAt", "lastSeenAt", "count", "exampleRepo", "exampleSha", "recentShas": [sha] (last 200), "closedBy"?, "closedAt"?, "personId"? }`
- Example (INVENTED): id `nobody@corp.example`, json `{ "email": "nobody@corp.example", "name": "Nobody", "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1763000000000, "lastSeenAt": 1763000900000, "count": 3, "exampleRepo": "client", "exampleSha": "c1", "recentShas": ["c1", "c2", "s1"] }`
- Example (INVENTED), same row after the PM ignored it: `"status": "ignored", "closedBy": "pm", "closedAt": 1763001000000`

### Retention

Open entries are never pruned. Resolved and ignored entries are deleted when the later of `closedAt` and `lastSeenAt` is older than 180 days (`ZQ_GIT_UNMAPPED_RETENTION_DAYS`, default 180), by the core function `queue.prune()` (unscheduled, not called from startup, like `pruneGitAudit`). Aliases are kept until the PM removes them. Ignored authors stay silent forever by default; `ZQ_GIT_IGNORED_REOPEN_DAYS` (default 0, off) reopens them.

### Roles and grants

No new role and no change to section 4. QM core's application role needs what it already has on every durable-map table (SELECT, INSERT, UPDATE, DELETE through `qm db grant`); DELETE is used by pruning and alias removal. The zq-git-mcp service role has no access to these tables.

### Rollout

1. Merge the code with the switch off (creates nothing). 2. PM approves this section. 3. Set `ZQ_GIT_AUTHOR_MAPPING=1` in one environment (staging first); the next start creates both tables. 4. Check as the application role: rows are visible only for the bound tenant, and a connection with no bound tenant fails with "No tenant is bound to this query". 5. Seed aliases.

### Rollback

Set `ZQ_GIT_AUTHOR_MAPPING` back to off, then:
DROP TABLE IF EXISTS zq_git_unmapped_authors;
DROP TABLE IF EXISTS zq_git_author_aliases;
DROP FUNCTION IF EXISTS claim_zq_git_unmapped_authors(), claim_zq_git_unmapped_authors_tenants(), claim_zq_git_author_aliases(), claim_zq_git_author_aliases_tenants();
DELETE FROM durable_map_versions WHERE tbl IN ('zq_git_unmapped_authors', 'zq_git_author_aliases');
Migration ledger rows stay; remove the ids if re-adding. With the switch left on, the next start recreates the tables.

### Existing tables

Unchanged: `zq_git_audit`, `zq_git_branch_tips`, `zq_git_blob_meta`, `durable_map_versions` and every other table, column, index, constraint and JSON key. Configuration added: `ZQ_GIT_AUTHOR_MAPPING`, `ZQ_GIT_IGNORED_REOPEN_DAYS`, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`, `ZQ_GIT_DOMAIN_ALIASES`; no existing setting changes.
