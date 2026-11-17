# DDL proposal: GitLab read-only MCP service (for human review)

Status: APPROVED by the PM on 2026-11-16 for the decisions marked APPROVED below (tenant scoped tables, the role grants, no redaction, audit retention, serve on audit failure). Section 9 (Jenkins tables) was APPROVED by the PM on 2026-11-17; that approval does not enable anything, see that section. Section 8 (author mapping tables): structure change APPROVED (2026-11-17, design level) for the NEW name-keyed shapes of `zq_git_author_aliases` and `zq_git_unmapped_authors`, which replace the old email-keyed shapes as the current proposal (the old shape is a historical note only and is not an authority); see section 8 and docs/zq-author-binding-design.md section 12. Sections 10 and 11 (patch package tables `zq_patch_packages` and `zq_patch_deliveries`): design approved 2026-11-17, NOT created, NOT enabled. Approval of a design is NOT creating a table and NOT enabling anything: DBA table creation and enabling in any environment need Jelly's separate explicit consent plus a rollback plan. Nothing here is applied: no database was contacted, "current" shapes are derived from repo code, and the migrations and the role SQL are still to be written and reviewed.

## Who creates which table (read first, by design)

- `zq_git_branch_tips` and `zq_git_blob_meta` are NOT created by any QM core migration, durable-map call or start of QM core, now or later. The zq-git-mcp service never creates tables either (no CREATE privilege, no table creation code) and refuses to start if one is missing. A DBA creates both by hand, as the database owner, from the DDL in sections 2 and 3, together with the role of section 4 and its tenant binding, BEFORE the service starts with `ZQ_GIT_MCP_TIPS`, `ZQ_GIT_MCP_AUDIT` or `ZQ_GIT_MCP_BLOB_META` set to `postgres`. With all three at `memory` (the default) no table is needed.
- `zq_git_audit` is different: it is the existing durable-map table (generic JSON document table, section 1). Be exact about who creates it: the only code that ever built it was the old in-process git module of QM core (`deps.map("zq_git_audit")`, `src/zq/runtime.ts:197` on `oa/dev`), and the removal commit `7f8eab470` on `oa/zq-git-mcp` deleted that code. A database where the old module ran has the table; a database where it never ran does not, and after the removal nothing creates it. The DBA checks `SELECT to_regclass('zq_git_audit')` and, if NULL, creates it in the form of section 1a before the service starts. The service requires all three tables.
- Order: core has migrated the database (`tenants`, `qm_bound_tenant()` exist); the DBA creates the tables and the role with the tenant binding; the operator sets the stores to `postgres` and the connection string; only then the service starts.
- The refusal message (one line on stderr, exit code 1): `zq-git-mcp failed to start: the database lacks the tables zq_git_branch_tips, zq_git_blob_meta; the service never creates tables` (the names are those that are absent). It only proves that the names exist; a wrong grant or an unbound tenant shows up at the first write.
- Operator documents: `plugins/zq-git-mcp/docs/ops/database.md`, `install.md`, `checks.md`, `checklist.md`, `handoff.md` on `oa/zq-git-mcp`.

## 0. How this repo does tables and roles (facts from the code)

- No .sql files. Migrations are TS objects `{id, statements[]}` registered via `pg.registerMigration` and run by `pg.migrate` (src/persistence/pg-pool.ts), recorded in a ledger table, ids like `durable-map/<table>/0001`.
- `zq_git_audit` is NOT a hand-written typed table. `deps.map<GitAuditRow>("zq_git_audit")` (src/zq/runtime.ts:197) creates it (when that code runs, see "Who creates which table" above) through `createPostgresMap` (src/persistence/durable-map.ts) as a generic JSON document table, then adds tenancy via `durableMapTenancy` (src/tenants/migrations.ts).
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
No migration id: this table is created by hand by a DBA, not by a QM core migration.

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
No migration id: this table is created by hand by a DBA, not by a QM core migration. sha256 stays nullable (unknown until the content was hashed). The code-only "binary" flag is not stored; it is derived again when a file is read. The service writes `INSERT ... ON CONFLICT (tenant_id, repo, oid) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = COALESCE(EXCLUDED.sha256, zq_git_blob_meta.sha256), seen_at = now()`.

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
Table owner/ordering: grants must run after the tables exist (the DBA creates the two new tables by hand and checks that `zq_git_audit` exists, see "Who creates which table").
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

1. The DBA creates the two tables by hand from sections 2 and 3 (idempotent CREATE TABLE IF NOT EXISTS, row level security and policy) and checks that `zq_git_audit` exists; no QM core migration does this. 2. Operator runs the role SQL, including the ALTER ROLE tenant binding. 3. Put the connection string in the service's private config. 4. Set the three stores to `postgres` and start the service; it refuses to start if one of the three tables is missing (message above). 5. Check as the role: own tenant rows only, no SELECT on zq_git_audit, no DELETE, an insert without a bound tenant fails.

### Rollback

DROP TABLE IF EXISTS zq_git_blob_meta;
DROP TABLE IF EXISTS zq_git_branch_tips;
REVOKE ALL ON zq_git_audit FROM zq_git_mcp; DROP OWNED BY zq_git_mcp; DROP ROLE zq_git_mcp;
zq_git_audit is left alone (rows kept; the extra JSON keys are harmless). No migration ledger rows exist for the two new tables (created by hand).

### Tables missing at run time

The service must not create tables (no CREATE privilege). On start (only with a postgres store) it checks the three tables exist and refuses to start with the message `zq-git-mcp failed to start: the database lacks the tables <missing names>; the service never creates tables`. If an audit insert fails mid-run (APPROVED): the default is ZQ_GIT_MCP_AUDIT_ON_FAILURE=serve, so a read tool is never failed by the audit; the row goes to a bounded local on-disk spool (write-ahead buffer, not a system of record) that is replayed into zq_git_audit in order, with a structured error log line, a counter, a degraded health state and an injectable alert hook. `fail` stays available only as an explicit opt-in.

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
7. Operations: run the role-creation SQL (including the tenant binding), put the connection string in the service's own configuration, and confirm the service sees all three tables at start. The two new tables are created by hand by the DBA and the role is created by hand too; no migration does either.
8. A failed audit write never fails a read; rows wait in a bounded local buffer and are replayed, with an alarm. Audit rows older than 180 days are pruned by the table owner or by QM core, in batches.
9. Rollback: drop the two new tables, then drop the database account, five statements in total, at any time. Existing tables and data are unaffected, and old rows stay valid.
10. Still open: how the connection string is delivered, how the role is bound to the tenant in a multi-tenant deployment, and pruning of tombstones.

## 8. Author mapping tables (structure change APPROVED 2026-11-17, design level; NOT created, NOT enabled)

Status: structure change APPROVED (2026-11-17, design level) for the NEW shapes of `zq_git_author_aliases` and `zq_git_unmapped_authors` below (decision 1 of `docs/zq-author-binding-design.md` section 19; the PM answered "follow your recommendations"). The NEW shapes below are the current proposal and replace the old shapes; the old shape is kept at the end of this section as a historical note only and is not an authority for anything. Approval of a design is NOT creating a table and NOT enabling anything. DBA table creation, and enabling `ZQ_GIT_AUTHOR_MAPPING`, `ZQ_GIT_AUTHOR_BIND` or `ZQ_GIT_ASK` in any environment, each need Jelly's separate explicit consent plus a rollback plan. Nothing here is applied and no database was contacted. The tables stay disabled by default: they are auto-created by the durable-map layer only when `ZQ_GIT_AUTHOR_MAPPING=1` is set, and no environment enables that switch. The code on branches `oa/zq-author-map` and `oa/zq-wire-3-authors` still implements the OLD shape and must not be enabled anywhere until phase 3b of the wiring plan (author structure alignment) has aligned it with this section. With the switch off the code builds no durable map, so neither table is registered or created.

Approved decisions affecting this section (PM, 2026-11-17, all recommendations adopted; the full list of 19 is in `docs/zq-author-binding-design.md` section 19):

- People are recognised by the git author NAME (normalised), not by email. This replaces the earlier decision that Mattermost verified emails are the authoritative identity source; the Mattermost email match survives only as an optional fallback switch that is off by default and never authoritative.
- People bind their own names in chat (one person can hold several names, at most 10 by default); the PM maintains the ignore list and answers for unknown authors through the same tool.
- A name already bound to someone else is refused at bind time (plain unique name, no ambiguity states).
- The PM keeps an ignore list of author names, each with a required reason `automation` or `external`; ignored authors are silent (no notice, no queue row).
- Commits by departed people are sent to the PM.
- Resolved queue entries are retained 180 days.
- On audit failure the service keeps serving (serve confirmed).

These are core-side tables used only by QM core. The zq-git-mcp service role (section 4) gets no grant on them. QM core reads and writes them with its normal application role (the one in `DATABASE_URL`, privileges from `qm db grant`), which also runs the migrations.

### Table definitions as the durable-map layer creates them (SQL unchanged by the structure change)

Both tables are generic JSON document tables, created by `createPostgresMap` and `durableMapTenancy` (src/persistence/durable-map.ts, src/tenants/migrations.ts), migration ids `durable-map/<table>/0001`, `durable-map/<table>/0010-tenants/...`, `durable-map/<table>/0020-claim-ids` and `0021-claim-tenants`. For `T` in `zq_git_author_aliases`, `zq_git_unmapped_authors`:

CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY, json JSONB NOT NULL);
ALTER TABLE T ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if T already has rows>;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS T_tenant_pkey ON T(tenant_id, id);
ALTER TABLE T DROP CONSTRAINT T_pkey, ADD CONSTRAINT T_pkey PRIMARY KEY USING INDEX T_tenant_pkey;
ALTER TABLE T ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE T ADD CONSTRAINT T_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON T USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
Plus the functions `claim_T()` and `claim_T_tenants()`. Net result per table: columns `id text`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, no other index, no check or unique constraint, no enum type. `durable_map_versions` already exists and gets a row per tenant and table. The only uniqueness in the database is `(tenant_id, id)`; with the new id convention that is a plain unique key on the normalised name. No indexed JSON field is declared (hundreds of rows, read whole). The table keeps the name `zq_git_author_aliases` although it now also holds ignore rows.

### JSON shapes (NEW, approved at design level; examples are INVENTED)

Name normalisation (`nameKey`, one function for every reader and writer): Unicode NFKC, removal of invisible format characters, whitespace collapse, case folding; details in `docs/zq-author-binding-design.md` section 3. `|` and `%` inside a name are written `%7C` and `%25` in an id.

`zq_git_author_aliases`: id `<nameKey>`, exactly one row per normalised name, so a name can never be bound to two people and can never be both bound and ignored.

| JSON key         | Type and values                        | Rule                                                                                                          |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `nameKey`        | text                                   | the normalised name; equals the id before encoding                                                            |
| `name`           | text                                   | the name as given after NFKC and whitespace collapse (display only)                                           |
| `kind`           | enum string `person` or `ignored`      | absent is read as `person`                                                                                    |
| `personId`       | text                                   | required for `person`, absent for `ignored`                                                                   |
| `mattermostUser` | text                                   | required for `person`, absent for `ignored`                                                                   |
| `reason`         | enum string `automation` or `external` | required for `ignored`, absent for `person`                                                                   |
| `emailCondition` | text, normalised exact email           | optional on both kinds: the row applies only if the commit author email equals it; required for generic names |
| `departedAt`     | epoch ms                               | optional, on `person` rows of a departed person                                                               |
| `addedBy`        | text                                   | the person's own id for a self bind, the admin's id otherwise                                                 |
| `addedAt`        | epoch ms                               |                                                                                                               |

Rules enforced in code on top of the primary key: a self bind of a held or ignored name is refused; `personId` and `mattermostUser` present exactly for `person`; `reason` present exactly for `ignored`; a generic name (`ZQ_GIT_GENERIC_NAMES`) requires `emailCondition`.

Example rows (INVENTED):

- person: id `alice example`, json `{ "nameKey": "alice example", "name": "Alice Example", "kind": "person", "personId": "p-alice", "mattermostUser": "mm-alice", "addedBy": "p-alice", "addedAt": 1763100000000 }`
- person with a condition (generic name): id `host123\admin`, json `{ "nameKey": "host123\\admin", "name": "HOST123\\admin", "kind": "person", "emailCondition": "x@y.example", "personId": "p-fred", "mattermostUser": "mm-fred", "addedBy": "pm", "addedAt": 1763100100000 }`
- ignored automation: id `pipeline-sync`, json `{ "nameKey": "pipeline-sync", "name": "pipeline-sync", "kind": "ignored", "reason": "automation", "emailCondition": "@partnerco", "addedBy": "pm", "addedAt": 1763100200000 }`
- ignored external: id `visiting student`, json `{ "nameKey": "visiting student", "name": "Visiting Student", "kind": "ignored", "reason": "external", "addedBy": "pm", "addedAt": 1763100300000 }`
- the first person row after the PM marked her departed: the same json plus `"departedAt": 1763200000000`.

`zq_git_unmapped_authors`: the queue of authors that are not bound, ignored, a bot or external. No commit message, subject or diff is stored.

| JSON key                             | Type and values                                        | Rule                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                   | text                                                   | `<nameKey>`; for a generic name `<nameKey>\|<email>`; when the name is empty `email:<email>`; `(none)` if both empty                                                                                    |
| `nameKey`                            | text                                                   | empty for `email:` rows                                                                                                                                                                                 |
| `name`                               | text                                                   | last seen display form                                                                                                                                                                                  |
| `emails`                             | array of up to 10 distinct normalised emails           | seen with this name; shown to the PM, not a key                                                                                                                                                         |
| `reason`                             | enum string `no_match`, `invalid_email` or `ambiguous` | `invalid_email` also covers an empty local part or domain; `ambiguous` only arises from the optional Mattermost email fallback                                                                          |
| `candidates`                         | array of personId                                      |                                                                                                                                                                                                         |
| `status`                             | enum string `open`, `resolved` or `ignored`            | the new design writes `open` and `resolved`; `ignored` stays in the code but is no longer written, because the PM's "ignore" answer registers an ignore-list row and closes the queue row as `resolved` |
| `firstSeenAt`, `lastSeenAt`, `count` | epoch ms, epoch ms, integer                            |                                                                                                                                                                                                         |
| `exampleRepo`, `exampleSha`          | text                                                   |                                                                                                                                                                                                         |
| `recentShas`                         | array of sha, last 200                                 |                                                                                                                                                                                                         |
| `askedAt`                            | epoch ms, optional                                     | set when the PM digest asked; cleared on reopen or reason change                                                                                                                                        |
| `closedBy`, `closedAt`, `personId`   | optional                                               |                                                                                                                                                                                                         |

Example (INVENTED): id `alice example`, json `{ "nameKey": "alice example", "name": "Alice Example", "emails": ["alice.example@corp.example", "a@personal.example"], "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1763000000000, "lastSeenAt": 1763000900000, "count": 7, "exampleRepo": "client", "exampleSha": "a1b2c3d", "recentShas": ["a1b2c3d"], "askedAt": 1763003600000 }`

### Resolution order (what the new structure is used for)

An explicit person binding wins; then the ignore list; then the bot name rule (whole word `bot` in the name or in the email local part, `ZQ_GIT_BOT_TOKENS`); then the external domain list; then, only if `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK=1`, a verified exact Mattermost email; otherwise the author goes to the unmapped queue. Ignored authors and bots produce no notice and no queue row. Departed people's commits go to the PM. Full table: `docs/zq-author-binding-design.md` section 5.

### Before and after (structure change)

Both tables are still new and exist nowhere, so there is nothing to migrate, backfill or keep compatible; the SQL is unchanged and only the id convention and JSON keys changed. Field accounting for `zq_git_author_aliases`: `email` TRANSFORMED into the optional `emailCondition` (no longer a key); `personId`, `mattermostUser`, `addedBy`, `addedAt` kept; NEW `nameKey`, `name`, `kind`, `reason`, `departedAt`; id changed from `<normalised email>|<personId>` to `<nameKey>`; nothing dropped except the key role of `email`. For `zq_git_unmapped_authors`: `email` TRANSFORMED into `emails`; id changed from the normalised email to `<nameKey>`; `name`, `reason`, `candidates`, `status`, `firstSeenAt`, `lastSeenAt`, `count`, `exampleRepo`, `exampleSha`, `recentShas`, `closedBy`, `closedAt`, `personId` kept; NEW `nameKey`, `askedAt`; nothing dropped. Full side by side table: `docs/zq-author-binding-design.md` section 12.

### Retention

Open entries are never pruned. Resolved entries are deleted when the later of `closedAt` and `lastSeenAt` is older than 180 days (`ZQ_GIT_UNMAPPED_RETENTION_DAYS`, default 180), by the core function `queue.prune()` (unscheduled, not called from startup, like `pruneGitAudit`). Aliases and ignore rows are kept until an admin removes them. `ZQ_GIT_IGNORED_REOPEN_DAYS` (default 0, off) applies to the queue status `ignored`, which the new design no longer writes. Dropped ignored commits are not stored or audited per commit; counts exist only as log counters carrying the name hash and the reason.

### Roles and grants

No new role and no change to section 4. QM core's application role needs what it already has on every durable-map table (SELECT, INSERT, UPDATE, DELETE through `qm db grant`); DELETE is used by pruning and by unbind and ignore-list removal. The zq-git-mcp service role has no access to these tables.

### Rollout (each step after step 1 needs the PM's separate explicit consent plus a rollback plan)

1. Merge the code (phase 3b of the wiring plan) with every switch off (creates nothing). 2. A DBA re-reads this section. 3. The PM gives explicit consent for one environment (staging first). 4. Set `ZQ_GIT_AUTHOR_MAPPING=1` there; the next start creates both tables. 5. Check as the application role: rows are visible only for the bound tenant, and a connection with no bound tenant fails with "No tenant is bound to this query". 6. Switch on `ZQ_GIT_AUTHOR_BIND` only after step 5. People bind their own names; the PM supplies the ignore list at deployment time through the tool's dry-run import. No author data enters the repository.

### Rollback

Set `ZQ_GIT_AUTHOR_MAPPING` (and `ZQ_GIT_AUTHOR_BIND`, `ZQ_GIT_ASK`) back to off, then:
DROP TABLE IF EXISTS zq_git_unmapped_authors;
DROP TABLE IF EXISTS zq_git_author_aliases;
DROP FUNCTION IF EXISTS claim_zq_git_unmapped_authors(), claim_zq_git_unmapped_authors_tenants(), claim_zq_git_author_aliases(), claim_zq_git_author_aliases_tenants();
DELETE FROM durable_map_versions WHERE tbl IN ('zq_git_unmapped_authors', 'zq_git_author_aliases');
Migration ledger rows stay; remove the ids if re-adding. With the switch left on, the next start recreates the tables.

### Existing tables and configuration

Unchanged: `zq_git_audit`, `zq_git_branch_tips`, `zq_git_blob_meta`, `durable_map_versions` and every other table, column, index, constraint and JSON key. Configuration, design approved and not implemented (full table with defaults, precedence and validation in `docs/zq-author-binding-design.md` section 11): kept `ZQ_GIT_AUTHOR_MAPPING`, `ZQ_GIT_IGNORED_REOPEN_DAYS`, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`, `ZQ_GIT_BOT_NAMES`, `ZQ_GIT_EXTERNAL_DOMAINS`; added (all default off or empty) `ZQ_GIT_AUTHOR_BIND`, `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK`, `ZQ_GIT_BOT_TOKENS` (default `bot`), `ZQ_GIT_GENERIC_NAMES`, `ZQ_GIT_IDENTITY_ADMINS`, `ZQ_GIT_BIND_MAX_PER_PERSON` (10), `ZQ_GIT_ASK`, `ZQ_GIT_PM_RECIPIENT`, `ZQ_GIT_ASK_DIGEST_MINUTES` (60), `ZQ_GIT_ASK_MAX_ITEMS` (20), `ZQ_GIT_ASK_REASK_DAYS` (0); removed `ZQ_GIT_DOMAIN_ALIASES` (retired-domain email retry; email is no longer a key); `ZQ_GIT_COMPANY_DOMAINS` is not carried over. No existing setting changes meaning except that the Mattermost email match no longer maps by default.

### Historical note: the OLD section 8 shape (original approval of 2026-11-17, SUPERSEDED, not an execution basis)

The first version of this section, approved on 2026-11-17 before the structure change, keyed rows by email. It is kept only so that a reader of the earlier text can see what changed. Nothing may be created, run or enabled from it, and no document may treat it as an authority. `zq_git_author_aliases` was keyed by `<normalised email>|<personId>` with json `{ "email", "personId", "mattermostUser", "addedBy", "addedAt" }` (example id `zhang.home@example.org|p-zhang`), where two people on one address made the author ambiguous. `zq_git_unmapped_authors` was keyed by the normalised commit email (`(none)` if empty) with json `{ "email", "name", "reason", "candidates", "status", "firstSeenAt", "lastSeenAt", "count", "exampleRepo", "exampleSha", "recentShas", "closedBy"?, "closedAt"?, "personId"? }` (example id `nobody@corp.example`). Its configuration included `ZQ_GIT_DOMAIN_ALIASES`, and its decision list named Mattermost verified emails as the authoritative source and "no Gmail dot folding".

## 9. Jenkins auto-rerun tables (APPROVED by the PM, 2026-11-17)

Source: branch `oa/zq-jenkins-rerun` of this repository, `docs/zq/jenkins-auto-rerun.md` (design) and `src/zq/jenkins/store.ts`.

Status: APPROVED by the PM, 2026-11-17. Approval of this DDL does NOT enable anything. The three tables stay disabled by default: they are auto-created by the durable-map layer only when `ZQ_JENKINS_POLL=1` is set (with `ZQ_JENKINS_URL` and the bot credential), and no environment enables that switch by default. Nothing here has been applied; no database was contacted.

Approved decisions affecting this section (PM, 2026-11-17):

- Jobs `Server-Run` and `PackageSent` are excluded.
- Human-triggered builds are not rerun.
- UNSTABLE is not a failure.
- At most 3 reruns per job per hour.
- The window is 30 minutes.
- Notices are written in Chinese and sent for failures only.
- The owner map is static.
- `zq_jenkins_audit` is retained 90 days.
- A chain rooted at a human is still rerun.
- If the record of the cause is lost, the build falls back to the bot cause.
- `ZQ_JENKINS_BOT_IDS=AI-Agent`.
- Audit failure policy: serve (confirmed).

The shapes below come from the code in `src/zq/jenkins/store.ts` and from how the durable-map layer builds a table (`src/persistence/durable-map.ts`, `src/tenants/migrations.ts`).

### When the tables come into existence

The durable-map layer registers a table's migrations the moment the map object is built, and `src/start.ts` runs `migrateRegisteredPgSchemas` at boot. So constructing a map creates its table at the next start, in every environment. The Jenkins code is therefore built so that the three maps are never built unless `ZQ_JENKINS_POLL=1`:

- `src/zq/runtime.ts` calls `deps.map("zq_jenkins_builds")`, `deps.map("zq_jenkins_audit")` and `deps.map("zq_jenkins_notices")` only inside the branch that creates the poller, which needs `ZQ_JENKINS_POLL=1`, `ZQ_JENKINS_URL` and the bot credential. With the default configuration no `deps.map` call is made for these names.
- A test (`test/zq-jenkins-config.test.ts`) puts a spy on the map factory: zero requests for `zq_jenkins_*` under default configuration and with only a URL and credential set; exactly the three names when the poll switch is on.
- `src/wiring.ts` creates the runtime when the poll switch is on, in addition to the existing switches. With the poll switch off its condition is unchanged.

### WARNING: ZQ_JENKINS_POLL=1 alone also creates four existing zq tables

Not part of the three tables approved above, and it must be weighed when the enablement of `ZQ_JENKINS_POLL=1` is approved. The three Jenkins maps are built inside `createZqRuntime` (`src/zq/runtime.ts`), and `createZqRuntime` builds four base maps unconditionally at its top, before any switch is looked at: `zq_identity_map`, `zq_reminders`, `zq_report_drafts` and `zq_run_state`. `src/wiring.ts` builds the runtime when Mattermost is configured and any of `config.zq.scanner.enabled`, `config.zq.reports.enabled`, `config.zq.identityMap`, `config.zq.childOrders` or `config.zq.jenkins.poll.enabled` is true. So in an environment with Mattermost where no other zq switch is on, `ZQ_JENKINS_POLL=1` creates seven tables at the next start: the three Jenkins tables of this section and these four. With `ZQ_JENKINS_POLL` off and the other switches off nothing changes (the runtime is not built).

These four tables are existing (not new) tables of the zq line: they are created today by switching on any of the other zq features, and are documented in `docs/zq/SEAMS.md` (on `oa/dev`). They are not new schema introduced by the Jenkins branch, but enabling the poller creates them in an environment that never had them. DDL as the durable-map layer creates it: the same statements as in "DDL the durable-map layer would create" below, with `<table>` replaced by each of the four names (no secondary index fields are declared for any of them; the maps are requested as `deps.map<T>("<name>")`, and `src/wiring.ts` passes only the table name):

| Table              | Key (`id`)                                                                                  | JSON value (from `docs/zq/SEAMS.md`)                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zq_identity_map`  | `mmUserId`                                                                                  | `{ mmUserId, opUserId, opLogin, opName?, emailHint?, source: "signin" or "admin", status: "pending" or "confirmed", proposedAt, proposedBy, confirmedAt?, confirmedBy? }`                                        |
| `zq_reminders`     | `<rule>:<subjectId>:<recipientMmUserId>:<dayKey>`                                           | `{ id, rule, subjectId, subjectTitle?, recipientMmUserId, text, dayKey, dueAt, mode: "dry-run" or "live", status: "pending", "sent" or "cancelled", createdAt, sentAt? }`                                        |
| `zq_report_drafts` | `<mmUserId>:<period>:<until>` (weekly project drafts `project:<projectId>:weekly:<Monday>`) | `{ id, mmUserId, period: "daily" or "weekly", since, until, text, status: "pending", "confirmed" or "discarded", kind?, projectId?, addressees?, createdAt, decidedAt?, decidedBy?, claimToken?, writtenBack? }` |
| `zq_run_state`     | `scanner`, `report:daily`, `report:weekly`                                                  | `{ lastRunAt, lastReport? }`                                                                                                                                                                                     |

Per table, what the layer creates (same as for every durable map): `id TEXT NOT NULL`, `json JSONB NOT NULL`, `tenant_id UUID NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, a foreign key `<table>_tenant` to `tenants(id)`, row level security with the `tenant_isolation` policy, the functions `claim_<table>` and `claim_<table>_tenants`, and a row per tenant in `durable_map_versions` on every write. Migration ids `durable-map/<table>/0001`, `0010-tenants/*`, `0020-claim-ids`, `0021-claim-tenants`. The tables are created empty; with only the poller on, the scanner, reports and identity code do not run, so no row is written to them (the scanner sweeper starts only when `scanner` or `reports` is on, see `start()` in `src/zq/runtime.ts`). They are inert but present. Nothing in them is read by the poller.

What to decide when approving enablement: (1) accept that seven tables appear, or (2) have the Jenkins poller built without the base maps first (options, effort and tests in `docs/zq-jenkins-wiring-options.md`; no code change is made by this document). Verify in staging after the first start with only `ZQ_JENKINS_POLL=1` (and Mattermost configured): `SELECT tablename FROM pg_tables WHERE tablename LIKE 'zq\_%' ORDER BY 1;` lists the three Jenkins tables and these four, and nothing else. Rollback is the same as below; to remove the four as well: `DROP TABLE IF EXISTS zq_run_state, zq_report_drafts, zq_reminders, zq_identity_map;` only if no other zq feature was ever used in that database (otherwise they hold real data).

### DDL the durable-map layer would create (per table, three times)

For each of `zq_jenkins_builds`, `zq_jenkins_audit`, `zq_jenkins_notices` (no secondary index fields are declared, so there is no index besides the primary key):

```sql
CREATE TABLE IF NOT EXISTS <table> (id TEXT PRIMARY KEY, json JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL);
ALTER TABLE <table> ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant if rows exist>;
CREATE UNIQUE INDEX CONCURRENTLY <table>_tenant_pkey ON <table> (tenant_id, id);
ALTER TABLE <table> DROP CONSTRAINT <table>_pkey, ADD CONSTRAINT <table>_pkey PRIMARY KEY USING INDEX <table>_tenant_pkey;
ALTER TABLE <table> ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE <table> ADD CONSTRAINT <table>_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table> USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

Result per table: `id TEXT NOT NULL`, `json JSONB NOT NULL`, `tenant_id UUID NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, row level security with the `tenant_isolation` policy, no CHECK constraints. Migration ids are `durable-map/<table>/0001` and `durable-map/<table>/0010-tenants/*`; the claim functions `claim_<table>` and `claim_<table>_tenants` are also created by the layer. Every write also bumps `durable_map_versions (tenant_id, tbl)`.

### Shapes

All timestamps are epoch milliseconds. All example rows are INVENTED.

`zq_jenkins_builds`, `id` = `<job>:<number>` of the original build (the idempotency key):

```json
{
  "job": "Server-Build",
  "number": 812,
  "state": "rerun_failed",
  "reason": null,
  "url": "https://jenkins.example/job/Server-Build/812/",
  "result": "FAILURE",
  "finishedAt": 1763000040000,
  "observedAt": 1763000070000,
  "updatedAt": 1763000400000,
  "causes": ["timer"],
  "fingerprint": "<sha256 of the sorted name/value pairs>",
  "parameterCount": 4,
  "consoleTailHash": "<sha256 of the last 4 KiB>",
  "claimedAt": 1763000100000,
  "queueId": 501,
  "rerunNumber": 813,
  "rerunUrl": "https://jenkins.example/job/Server-Build/813/",
  "rerunResult": "FAILURE",
  "parameterDifferences": []
}
```

Keys that are absent are not stored (`reason`, `consoleTailHash`, `claimedAt`, `queueId`, `rerunNumber`, `rerunUrl`, `rerunResult`, `parameterDifferences`). `state` is one of `observed`, `eligible`, `rerun_requested`, `rerun_running`, `rerun_succeeded`, `rerun_failed`, `notified`, `skipped`. `reason` (with `skipped`) is one of `job_not_enabled`, `dangerous_parameters`, `is_rerun`, `bot_triggered`, `manual_trigger`, `cause_not_allowed`, `chain_rerun`, `superseded`, `parameters_unreadable`, `parameters_incomplete`, `circuit_open`, `too_old`, `request_rejected`, `claim_uncertain`. `causes` values are `timer`, `scm`, `upstream`, `user`, `remote`, `other`. No parameter value, no console text and no credential is stored: only a count, a fingerprint and a hash.

`zq_jenkins_audit`, `id` = `<job>:<number>:<event>` (state changes use the new state as the event), `notice` events use `<notice id>:notice_queued|notice_sent|notice_failed`, errors use `poll:<job>:<kind>:<hour>`:

```json
{
  "id": "Server-Build:812:rerun_requested",
  "at": 1763000100000,
  "job": "Server-Build",
  "number": 812,
  "event": "rerun_requested",
  "from": "eligible",
  "to": "rerun_requested",
  "actor": "poller"
}
```

Optional keys: `number`, `from`, `to`, `reason`, `detail` (names and counts only). `actor` is always `poller`.

`zq_jenkins_notices`, `id` = `<job>:<number>:<kind>`, or `breaker:<job>:<hour>`:

```json
{
  "id": "Server-Build:812:rerun_failed",
  "kind": "rerun_failed",
  "job": "Server-Build",
  "number": 812,
  "channelId": "backend-group",
  "text": "Jenkins ...",
  "mode": "dry-run",
  "status": "pending",
  "attempts": 0,
  "createdAt": 1763000400000
}
```

`kind` is `rerun_failed`, `needs_attention` or `circuit_open`; `status` is `pending`, `sending`, `sent` or `failed`; `mode` is `dry-run` or `live`; `sentAt` is added when sent. The text has the job, build numbers, URLs, results and an owner mention; no parameters, no log content.

Before and after: all three tables are new. Nothing existing is changed, moved or dropped. The earlier proposed `zq_jenkins_reruns` is not created.

### Retention

`zq_jenkins_audit` is retained 90 days (approved). `createJenkinsStore(...).pruneAudit()` (`src/zq/jenkins/store.ts`) deletes rows whose `at` is older than 90 days through the same function as `pruneGitAudit`; it is tested and NOT scheduled, so nothing deletes anything until a schedule is wired. `zq_jenkins_builds` and `zq_jenkins_notices` have no pruning (one row per failed build; low volume); a retention for them is an open decision.

### Grants

Core application role only (the role QM core already runs as, with the existing `qm db grant` privileges: SELECT, INSERT, UPDATE, DELETE, TRUNCATE). No service role is created and no new grant is needed. The tenant is bound per connection by the core as for every other map.

### Rollout and rollback

Rollout: merge the code with every switch off (no table is created); set `ZQ_JENKINS_URL`, the credential and `ZQ_JENKINS_POLL=1` (dry-run); the next start creates the three tables and the poller only observes. Real reruns and notices are separate switches (`ZQ_JENKINS_RERUN`, `ZQ_JENKINS_NOTIFY`).

Rollback: unset `ZQ_JENKINS_POLL` (the maps are no longer built; the tables and rows stay and are inert). To remove the data, after the poller is off: `DROP TABLE IF EXISTS zq_jenkins_notices, zq_jenkins_audit, zq_jenkins_builds;`. Dropping `zq_jenkins_builds` discards the once-only record, so do it only with `ZQ_JENKINS_RERUN` unset.

## 10. Patch package record table `zq_patch_packages` (design approved 2026-11-17, NOT created, NOT enabled)

Status: design approved by the PM on 2026-11-17 (decisions 10 and 14 of `docs/zq-patch-package-phase4-design.md` section 14, "follow your recommendations"). The table is NOT created and NOT enabled. Approval of a design is not creating a table and not enabling anything: DBA creation, and any environment's `ZQ_PATCH_RETAIN=1`, need Jelly's separate explicit consent plus a rollback plan. Nothing here is applied and no database was contacted.

Sources and precedence: `docs/zq/patch-package-retention.md` on `oa/zq-patch-package` (the first record design) and `docs/zq-patch-package-phase4-design.md` sections 2.2, 13A.7 and 14 (the amendment). Where they disagree, the phase 4 design supersedes. The disagreements, each resolved in favour of phase 4:

- Id: retention doc `<ticket>-<first 12 characters of the commit id>`; phase 4 `<ticket>-<first 12 hex characters of the sha256 over the sorted lines "<name> <sha256>" of the patch and payload files>` (content addressed, section 2). The phase 4 id is used.
- `kind`: retention doc `text-patch` or `xlsx`; phase 4 one value `patch-package` (section 2.2).
- `files[]`: retention doc lists the patch and manifest; phase 4 lists every package file (patch, payloads, message, scripts, README, manifest, comparisons).
- `recipient`: retention doc a user name string; phase 4 a resolved object written by the agent tool (13A.7).
- Delivery fields (`delivery`, `attempts`, `deliveredAt`, `lastError`, `postId`) and the `delivery` value `expired`: in the retention doc, in this table; phase 4 moves them to `zq_patch_deliveries` (section 11).
- Delivery behaviour in the retention doc (a stale `sending` row returns to `pending` after the probe, an unresolvable user goes to `failed`) is replaced by the at-most-once state machine of phase 4 13A.4 and 13A.5 (section 11).
- Open gap in both documents: `resultCommit`. The retention doc keeps it; phase 4 13A.7 says it is kept, but section 2 says a mixed package has no result commit on the builder side (the pointer blobs are made on the developer machine) and moves `result.tree` to `parts[A].resultTree`. Neither document says what the field holds for a package with an LFS part. It is listed below as kept per 13A.7 and the question is OPEN; it is a JSON key, so the SQL below does not depend on the answer, and the answer is due before any code builds the map.

### DDL the durable-map layer would create

Created by `createPostgresMap` and `durableMapTenancy` the moment a map named `zq_patch_packages` is built, in the same shape as every durable map (migration ids `durable-map/zq_patch_packages/0001`, `0010-tenants/*`, `0020-claim-ids`, `0021-claim-tenants`), with `<table>` = `zq_patch_packages`:

```sql
CREATE TABLE IF NOT EXISTS <table> (id TEXT PRIMARY KEY, json JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL);
ALTER TABLE <table> ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if rows exist>;
CREATE UNIQUE INDEX CONCURRENTLY <table>_tenant_pkey ON <table> (tenant_id, id);
ALTER TABLE <table> DROP CONSTRAINT <table>_pkey, ADD CONSTRAINT <table>_pkey PRIMARY KEY USING INDEX <table>_tenant_pkey;
ALTER TABLE <table> ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE <table> ADD CONSTRAINT <table>_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table> USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

Result: `id text NOT NULL`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, foreign key `zq_patch_packages_tenant` to `tenants(id)`, row level security with the `tenant_isolation` policy, the functions `claim_zq_patch_packages()` and `claim_zq_patch_packages_tenants()`, a row per tenant in `durable_map_versions` on every write, no other index, no secondary index field, no CHECK constraint, no enum type. Grants: QM core's application role only, as for every durable map; no service role.

### Row shape (JSON), all times epoch milliseconds

| JSON key       | Type and values                                                                                        | Notes                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id             | text, primary key part                                                                                 | the package id and the directory name, content addressed; recording the same package twice updates the same row                                                                                                                                                                               |
| `kind`         | enum string `patch-package`                                                                            | one value; the retention doc's `text-patch` and `xlsx` are retired                                                                                                                                                                                                                            |
| `ticket`       | text                                                                                                   |                                                                                                                                                                                                                                                                                               |
| `repo`         | text                                                                                                   | per phase 4 section 2.1 (manifest `repo`) and 13A.7 (copied into the delivery row); absent from the retention doc's record. OPEN, small: confirm the package row carries it                                                                                                                   |
| `recipient`    | object `{ mmUserId?: text, source: "requester" or "author_binding" or "explicit", unresolved?: text }` | a resolved decision written by the agent tool; a user name can change, the id cannot. `unresolved` holds the resolver kind that was not `person` (13A.3 names `unmapped`, `ambiguous`, `bot`, `external`; the name-keyed resolver of the author binding design adds `ignored` and `departed`) |
| `baseCommit`   | text, 40 hex                                                                                           |                                                                                                                                                                                                                                                                                               |
| `resultCommit` | text, 40 hex                                                                                           | kept per 13A.7; what it holds for a package with an LFS part is OPEN (see above)                                                                                                                                                                                                              |
| `files`        | array of `{ name: text, sha256: text, bytes: integer }`                                                | every package file (section 2 layout); the manifest's `role`, `part` and `gitBlob` are in `manifest.json`, not in this record                                                                                                                                                                 |
| `zip`          | `{ name: text, sha256: text, bytes: integer }`                                                         | the retained zip; built with a fixed file order and timestamps                                                                                                                                                                                                                                |
| `createdAt`    | integer                                                                                                |                                                                                                                                                                                                                                                                                               |
| `expiresAt`    | integer                                                                                                | `createdAt` plus `ZQ_PATCH_RETAIN_DAYS` (30 days)                                                                                                                                                                                                                                             |
| `deletedAt`    | integer, optional                                                                                      | set when the cleanup removed the directory; the row is removed `ZQ_PATCH_RECORD_DAYS` (30) after it                                                                                                                                                                                           |

The record holds metadata only: no file content, no patch text, no commit message body, no credential, no absolute path, no email.

Dropped from the retention doc's record and moved to `zq_patch_deliveries`: `delivery` (values `pending`, `sending`, `delivered`, `failed`, `expired`), `attempts`, `deliveredAt`, `lastError`, `postId`. `recipient` is TRANSFORMED from a user name string into the object above. `delivery` value `expired` is DROPPED: it is expressed as the package `deletedAt` plus a delivery row `abandoned` with reason `package_expired`. Kept: `id`, `kind` (new value), `ticket`, `baseCommit`, `resultCommit`, `files` (new content), `zip`, `createdAt`, `expiresAt`, `deletedAt`.

Example rows (INVENTED, for illustration only):

```json
{
  "id": "WP-123-0123456789ab",
  "kind": "patch-package",
  "ticket": "WP-123",
  "repo": "client",
  "recipient": { "mmUserId": "mmuser0000000000000000001", "source": "requester" },
  "baseCommit": "e663771131152811ec3cc107a6a307eaa5aa44de",
  "files": [
    { "name": "parts/A/0001-fix-the-thing.patch", "sha256": "<64 hex>", "bytes": 4210 },
    { "name": "parts/B/0001.dat", "sha256": "<64 hex>", "bytes": 7000 },
    { "name": "manifest.json", "sha256": "<64 hex>", "bytes": 2900 }
  ],
  "zip": { "name": "WP-123-0123456789ab.zip", "sha256": "<64 hex>", "bytes": 7340032 },
  "createdAt": 1763000000000,
  "expiresAt": 1765592000000
}
```

A package whose recipient could not be resolved, after its files were removed:

```json
{
  "id": "456-ba9876543210",
  "kind": "patch-package",
  "ticket": "456",
  "repo": "server",
  "recipient": { "source": "author_binding", "unresolved": "unmapped" },
  "baseCommit": "<40 hex>",
  "files": [{ "name": "manifest.json", "sha256": "<64 hex>", "bytes": 1190 }],
  "zip": { "name": "456-ba9876543210.zip", "sha256": "<64 hex>", "bytes": 51200 },
  "createdAt": 1763100000000,
  "expiresAt": 1765692000000,
  "deletedAt": 1765700000000
}
```

### When the table comes into existence

The durable-map layer registers a table's migrations the moment the map object is built, and `src/start.ts` runs the registered migrations at boot. The map is therefore built only behind `ZQ_PATCH_RETAIN=1` (with `ZQ_PATCH_RETAIN_DIR`); with the default configuration no `deps.map("zq_patch_packages")` call is made. A spy test on the map factory (to be written first, as for the Jenkins tables) shows zero requests for `zq_patch_packages` under default configuration and with only `ZQ_PATCH_AGENT` or `ZQ_PATCH_DELIVERY=off` set, and exactly this name (plus `zq_patch_deliveries` when delivery is `dry-run` or `send`) when retention is on.

### Retention interplay with `zq_patch_deliveries`

The cleanup (`cleanupExpiredPackages`, unscheduled until a schedule is approved) deletes the package directory first and marks the record (`deletedAt`) second, so a crash leaves a harmless record, never an orphan directory. A package row is removed `ZQ_PATCH_RECORD_DAYS` after its `deletedAt`; the delivery rows of the package are removed at their own `purgeAt` (`expiresAt` plus `ZQ_PATCH_RECORD_DAYS`), nearly the same moment, in the same cleanup pass. Before the directory is deleted the cleanup moves that package's `planned`, `failed` and `dry_run` delivery rows to `abandoned` (`package_expired`), with the usual PM notice for the first two; a `sending` row is left to the probe. Delivery never sends from a package past `expiresAt`. Full text: `docs/zq-patch-package-phase4-design.md` 13A.8.

### Settings that gate it (design approved, none exist yet)

`ZQ_PATCH_RETAIN` (off), `ZQ_PATCH_RETAIN_DIR` (unset, absolute, not under the temporary directory), `ZQ_PATCH_RETAIN_DAYS` (30), `ZQ_PATCH_RECORD_DAYS` (30), `ZQ_PATCH_CLEANUP_BATCH` (50); plus the agent switch `ZQ_PATCH_AGENT` of the wiring plan. No existing setting changes.

### Rollout and rollback

Rollout (each step after the first needs the PM's separate explicit consent plus a rollback plan): merge the code with `ZQ_PATCH_RETAIN` off (creates nothing); a DBA re-reads this section; set `ZQ_PATCH_RETAIN=1` and `ZQ_PATCH_RETAIN_DIR` in staging; the next start creates the table; check as the application role that rows are visible only for the bound tenant. Rollback: unset `ZQ_PATCH_RETAIN` (the map is no longer built; the table and rows stay and are inert). To remove the data, only on the PM's decision and after delivery is off: `DROP TABLE IF EXISTS zq_patch_packages;` `DROP FUNCTION IF EXISTS claim_zq_patch_packages(), claim_zq_patch_packages_tenants();` `DELETE FROM durable_map_versions WHERE tbl = 'zq_patch_packages';` Migration ledger rows stay; remove the ids if re-adding. The retained files under `ZQ_PATCH_RETAIN_DIR` are not database objects and are removed separately.

Before and after: a new table; no existing table, column, index, constraint or JSON key changes; there is no migration, backfill or compatibility effect, because nothing exists yet.

## 11. Patch package delivery table `zq_patch_deliveries` (design approved 2026-11-17, NOT created, NOT enabled)

Status: design approved by the PM on 2026-11-17 (decision 14 of the phase 4 design, "Two tables, approved together"; decisions 13 and 15 to 21 cover its behaviour). NOT created and NOT enabled. Approval of a design is not creating a table and not enabling anything: DBA creation, and any environment's `ZQ_PATCH_DELIVERY=dry-run` or `send`, need Jelly's separate explicit consent plus a rollback plan. Nothing here is applied and no database was contacted. Source: `docs/zq-patch-package-phase4-design.md` 13A.4, 13A.5, 13A.7 and 13A.8 (supersedes the delivery section of `docs/zq/patch-package-retention.md`). The two documents' delivery rules disagree as listed in section 10; phase 4 is used.

### DDL the durable-map layer would create

Identical to section 10 with `<table>` = `zq_patch_deliveries`: `id text`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, foreign key `zq_patch_deliveries_tenant` to `tenants(id)`, row level security with the `tenant_isolation` policy, grants to the application role only, the functions `claim_zq_patch_deliveries()` and `claim_zq_patch_deliveries_tenants()`, a `durable_map_versions` row per tenant. No secondary index: a few dozen rows a day are scanned with `all()`, and a declared indexed field would add an index and claim functions for no gain. No CHECK constraint, no enum type.

### Row shape (JSON), all times epoch milliseconds

| JSON key                                                                                      | Type and values                                                              | Notes                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                                                                            | text, primary key part                                                       | `<packageId>:<recipientMmUserId>:<generation>`, the idempotency key; for an unresolved recipient `<packageId>:unresolved:<generation>`                                                                                                        |
| `packageId`                                                                                   | text                                                                         | the package directory and `zq_patch_packages` id                                                                                                                                                                                              |
| `ticket`, `repo`                                                                              | text                                                                         | copied so the row stays readable after the package record is purged                                                                                                                                                                           |
| `recipientId`                                                                                 | text, optional                                                               | Mattermost user id; absent when unresolved                                                                                                                                                                                                    |
| `recipientSource`                                                                             | enum string `requester`, `author_binding` or `explicit`                      |                                                                                                                                                                                                                                               |
| `generation`                                                                                  | integer, at least 1                                                          | 1 unless a person re-sends on purpose                                                                                                                                                                                                         |
| `state`                                                                                       | enum string `planned`, `dry_run`, `sending`, `sent`, `failed` or `abandoned` | transitions in 13A.4                                                                                                                                                                                                                          |
| `reason`                                                                                      | text, optional                                                               | with `abandoned`: `mattermost_auth`, `mattermost_forbidden`, `recipient_gone`, `too_large`, `mattermost_rejected`, `package_damaged`, `package_expired` (13A.5), `superseded`, `recipient_unresolved`, `recipient_not_allowed` (13A.3, 13A.4) |
| `attempts`                                                                                    | integer                                                                      | incremented at claim time                                                                                                                                                                                                                     |
| `zipSha256`, `zipBytes`, `manifestSha256`, `applyShSha256`, `applyPs1Sha256`, `messageSha256` | text, integer, text, text, text, text                                        | hashes and size only: what the recipient was told                                                                                                                                                                                             |
| `claim`                                                                                       | text, optional                                                               | random token of the sweeper that holds `sending`                                                                                                                                                                                              |
| `createdAt`, `updatedAt`                                                                      | integer                                                                      |                                                                                                                                                                                                                                               |
| `nextAttemptAt`, `sendingAt`, `sentAt`, `dryRunAt`, `pmNotifiedAt`                            | integer, optional                                                            | with `failed`, the current attempt, `sent`, `dry_run`, and the one PM notice                                                                                                                                                                  |
| `postId`                                                                                      | text, optional                                                               | with `sent`                                                                                                                                                                                                                                   |
| `lastError`                                                                                   | `{ code: text, status?: integer }`, optional                                 | a code and an HTTP status, never a response body; the set of codes is not enumerated by the design (13A.5 names causes, the example uses `mattermost_5xx`)                                                                                    |
| `purgeAt`                                                                                     | integer                                                                      | the package `expiresAt` plus `ZQ_PATCH_RECORD_DAYS`; `deleteBefore("purgeAt", now)` removes the row                                                                                                                                           |

The row never holds file content, patch text, a commit message body, a response body, a token or an email address. In logs the recipient appears only as a 12 hex character hash of the Mattermost user id.

Example rows (INVENTED, for illustration only). A delivered row, after one 503:

```json
{
  "id": "WP-123-0123456789ab:mmuser0000000000000000001:1",
  "packageId": "WP-123-0123456789ab",
  "ticket": "WP-123",
  "repo": "client",
  "recipientId": "mmuser0000000000000000001",
  "recipientSource": "requester",
  "generation": 1,
  "state": "sent",
  "attempts": 2,
  "zipSha256": "<64 hex>",
  "zipBytes": 7340032,
  "manifestSha256": "<64 hex>",
  "applyShSha256": "<64 hex>",
  "applyPs1Sha256": "<64 hex>",
  "messageSha256": "<64 hex>",
  "createdAt": 1763000000000,
  "updatedAt": 1763000185000,
  "sentAt": 1763000185000,
  "postId": "p4x9k2",
  "lastError": { "code": "mattermost_5xx", "status": 503 },
  "purgeAt": 1768184000000
}
```

A stuck row, window W4 (`createPost` timed out; the sweeper never retries directly because a post may exist):

```json
{
  "id": "456-ba9876543210:mmuser0000000000000000002:1",
  "packageId": "456-ba9876543210",
  "ticket": "456",
  "repo": "server",
  "recipientId": "mmuser0000000000000000002",
  "recipientSource": "author_binding",
  "generation": 1,
  "state": "sending",
  "attempts": 1,
  "zipSha256": "<64 hex>",
  "zipBytes": 51200,
  "manifestSha256": "<64 hex>",
  "applyShSha256": "<64 hex>",
  "applyPs1Sha256": "<64 hex>",
  "messageSha256": "<64 hex>",
  "claim": "c7e1d0a49b",
  "createdAt": 1763100000000,
  "updatedAt": 1763100003000,
  "sendingAt": 1763100003000,
  "purgeAt": 1768284000000
}
```

### Why a second table, and what it asks of the package record

Delivery is one to many (a re-send, a named second recipient, a superseded generation) and the package row can hold only one; the idempotency key needs its own row id per package and recipient; the delivery row outlives the package and is pruned on its own date; and the sweeper's claim updates would otherwise contend with cleanup updates on the same row. The field by field accounting against the retention record is in section 10 ("Dropped from the retention doc's record").

### When the table comes into existence, retention interplay, and gating

The map is built only when `ZQ_PATCH_DELIVERY` is `dry-run` or `send` (values `off`, `dry-run`, `send`; default `off`; any other value, including `1`, refuses startup). `dry-run` and `send` also need `ZQ_PATCH_RETAIN=1`, `ZQ_PATCH_RETAIN_DIR` and a Mattermost connection, or startup is refused; `send` also needs `ZQ_PATCH_DELIVERY_PM_CHANNEL`. Spy expectation (written first): with `ZQ_PATCH_DELIVERY` off, with unset, and with only the retention switch on, the map factory sees zero requests for `zq_patch_deliveries`; with `dry-run` or `send` it sees exactly `zq_patch_packages` and `zq_patch_deliveries`; no timer, no sweeper and no Mattermost request exist when the switch is off. `dry-run` writes a durable row in state `dry_run` and never calls `directChannel`, `upload` or `createPost`; a `dry_run` row of an unexpired package is promoted to `planned` if the switch later becomes `send` (the allowlist `ZQ_PATCH_DELIVERY_ALLOW` and staging cover that). Delivery rows are not deleted when the zip is: they live until `purgeAt`, 30 days later, so for 30 days after the zip is gone a person can see that, to whom and with which hashes it was sent (decision 21). A delivery sweeper runs only under the lease `zq:patch-delivery`; the claim under row lock covers the overlap of two instances in a blue-green deploy.

### Settings that gate it (design approved, none exist yet)

`ZQ_PATCH_DELIVERY` (`off`), `ZQ_PATCH_DELIVERY_PM_CHANNEL` (unset), `ZQ_PATCH_DELIVERY_ALLOW` (unset, comma separated Mattermost user ids; empty means every resolved recipient), `ZQ_PATCH_DELIVERY_ATTEMPTS` (5), and the reused `ZQ_PATCH_MAX_PACKAGE_BYTES` (80 MiB). Constants, not settings: backoff 60 s doubling to a 1 h cap, uncertainty window 10 minutes, sweeper tick 30 s. No existing setting changes.

### Rollout and rollback

Rollout (each step after the first needs the PM's separate explicit consent plus a rollback plan): merge the code with `ZQ_PATCH_DELIVERY` off (creates nothing); a DBA re-reads this section; with retention already on in staging, set `dry-run`; the next start creates the table; read back the `dry_run` rows; only later `send` with the one-person allowlist. Rollback: set `ZQ_PATCH_DELIVERY=off` (the map is no longer built; table and rows stay and are inert). To remove the data, only on the PM's decision: `DROP TABLE IF EXISTS zq_patch_deliveries;` `DROP FUNCTION IF EXISTS claim_zq_patch_deliveries(), claim_zq_patch_deliveries_tenants();` `DELETE FROM durable_map_versions WHERE tbl = 'zq_patch_deliveries';` Dropping it discards the once-only record of what was sent, so do it only with delivery off.

Before and after: a new table; no existing table, column, index, constraint or JSON key changes; no migration, backfill or compatibility effect. Configuration: the five settings above are added (all off or unset by default), none changes.
