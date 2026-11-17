# Patch package retention (step 4b)

Status: IMPLEMENTED in code, OFF by default, NOT wired into startup, NOT enabled anywhere, and the table `zq_patch_packages` is NOT created anywhere. The code is `src/zq/patch-package/retention.ts` (store, cleanup, orphan report), `retention-runtime.ts` (factory and sweeper) and `zip.ts`. Nothing calls them from `src/wiring.ts` or `src/zq/runtime.ts`: no code path records a package yet (the agent tool is step 4d) and nothing delivers (step 4c), so there is nothing for a sweeper to look after until those exist. The factory `createPatchRetentionRuntime` returns `undefined` unless `ZQ_PATCH_RETAIN=1`; wiring it is a later, separately consented change. Design sources: `docs/zq-patch-package-phase4-design.md` (sections 2, 13A.7, 13A.8, 14) and `docs/zq-git-mcp-ddl-proposal.md` section 10 on `oa/spike-git`. Where the first record design (the earlier text of this file) disagreed, the phase 4 design and DDL section 10 win; this file now describes what is implemented.

Context: `docs/zq/patch-package.md` describes how a package is built, including the deterministic zip. `ZQ_PATCH_OUTPUT_DIR` still defaults to a temporary directory that is neither persistent nor cleaned; retention is the persistent copy of the zip plus a database record.

## What exists

- `createPatchRetention({ map, settings, now?, log? })` returns `verifyDirectory()`, `retain(package, recipient)`, `cleanup({ now?, batchSize? })` and `orphans()`.
- `createPatchRetentionRuntime({ config, map, leaderLease, createSweeper, now?, log? })` returns `undefined` when `config.patchRetention` is absent (switch off). When on it requests exactly one map, `zq_patch_packages`, creates one sweeper (not started) and returns `{ retention, start(), stop() }`. `start()` first runs `verifyDirectory()` (a failure names `ZQ_PATCH_RETAIN_DIR`) and only then starts the sweeper. The sweeper runs every 60 minutes (a constant, not a setting; the schedule was an open question of the design) under the leader lease `zq:patch-retention`, once per tenant that has rows (`claimTenants`), at most 20 batches per tenant per sweep.
- Nothing is instantiated, no map is requested, no timer is created and no directory is touched when the switch is off (spy tests: the map factory, the sweeper factory and the lease are called 0 times; the directory is not created).

## Storage

- Root: `ZQ_PATCH_RETAIN_DIR`. Layout: `<root>/<tenant id>/<package id>/<package id>.zip`. The tenant directory keeps two tenants with the same (content addressed) package id from sharing or deleting each other's file; this layer is an addition to the design, which has no directory layout beyond "one directory per package id".
- Permissions: tenant and package directories `0700` (set explicitly, so the umask cannot loosen them), zip `0600`. The root is created `0700` if missing; an existing root keeps its own mode.
- Write order (crash safe): the zip bytes go to a temporary file in the package directory (`<id>.zip.<random>.part`, exclusive create, mode `0600`), are `fsync`ed, renamed over `<id>.zip`, and the directory is `fsync`ed; only AFTER that the record is written with `put`. A failed record write removes a directory that did not exist before (and keeps the old zip of an already recorded package).
- Idempotent: recording a package whose recorded zip hash equals the new zip hash, with the zip still intact on disk (size and sha256 checked), writes nothing and returns the existing record. A different zip under the same id (the id covers the patch and payloads, not the manifest, so a changed `repo` label gives the same id) replaces the zip atomically and replaces the record (new `createdAt` and `expiresAt`, `deletedAt` cleared), so there is always one row per id.
- Path traversal: a package id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (no slash, backslash, empty, `.` or `..`), the tenant id must be a uuid, and cleanup refuses (and logs, and does not mark the record) a package path that is not a real directory, for example a symlink. Nothing outside `<root>/<tenant>/` is ever deleted.
- Startup checks: the root is created if missing, must be a directory, and must be readable, writable and searchable, else startup refuses with a message naming `ZQ_PATCH_RETAIN_DIR`. There is no free-space check: the design names none.

## Record (durable map `zq_patch_packages`), as implemented

Same as DDL section 10 field by field. Times are epoch milliseconds. The row is metadata only: no file content, no patch text, no commit message, no credential, no absolute path, no email.

| Key            | Implemented as                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | text, the package id (`<ticket>-<12 hex of the sha256 over the patch and payload lines>`) and the directory name                                                                     |
| `kind`         | the single value `patch-package`                                                                                                                                                     |
| `ticket`       | text, from the builder result                                                                                                                                                        |
| `repo`         | text, optional: present when the builder was given `repo` (DDL: "OPEN, small: confirm the package row carries it"; implemented as carried, absent when unknown)                      |
| `recipient`    | object `{ mmUserId?, source, unresolved? }`, `source` one of `requester`, `author_binding`, `explicit`; supplied by the caller of `retain` (the resolver is step 4d); never an email |
| `baseCommit`   | text, 40 hex                                                                                                                                                                         |
| `resultCommit` | text, optional: see "Open gap" below                                                                                                                                                 |
| `files`        | array of `{ name, sha256, bytes }`: every file of the package including `manifest.json` and `apply.sh`, names relative, sorted                                                       |
| `zip`          | `{ name, sha256, bytes }` of the retained zip, name is `<id>.zip`                                                                                                                    |
| `createdAt`    | integer                                                                                                                                                                              |
| `expiresAt`    | integer, `createdAt` plus `ZQ_PATCH_RETAIN_DAYS` days                                                                                                                                |
| `deletedAt`    | integer, optional, set when the cleanup removed the directory; the row is removed `ZQ_PATCH_RECORD_DAYS` days after it                                                               |

Invented example (INVENTED, for illustration only):

```json
{
  "id": "WP-123-0123456789ab",
  "kind": "patch-package",
  "ticket": "WP-123",
  "repo": "client",
  "recipient": { "mmUserId": "mmuser0000000000000000001", "source": "requester" },
  "baseCommit": "e663771131152811ec3cc107a6a307eaa5aa44de",
  "resultCommit": "<40 hex>",
  "files": [
    { "name": "apply.sh", "sha256": "<64 hex>", "bytes": 21000 },
    { "name": "manifest.json", "sha256": "<64 hex>", "bytes": 2900 },
    { "name": "patches/0001.patch", "sha256": "<64 hex>", "bytes": 4210 }
  ],
  "zip": { "name": "WP-123-0123456789ab.zip", "sha256": "<64 hex>", "bytes": 7340032 },
  "createdAt": 1763000000000,
  "expiresAt": 1765592000000
}
```

### Open gap `resultCommit` (decision taken here, FLAGGED)

DDL section 10 leaves open what `resultCommit` holds for a package with an LFS part and says the answer is due before code builds the map. Implemented: `resultCommit` is the id of the scratch commit the builder made for the TEXT part (the commit the mbox `From <id>` line names, deterministic because author, committer, date and message are fixed). It is absent for an LFS-only package (no text part), and for a mixed package it is the commit of the text part only; the commit the developer finally makes (with pointer blobs) does not exist on the builder side and has a different id. It is a JSON key, so no SQL depends on it. `PatchPackage.resultCommit` is new (`string | null`). The PM or reviewer should confirm this reading or ask for the key to be dropped.

## Schema and migration disclosure

NOTHING IS CREATED. No table, column, index, constraint, function or migration is created or changed by this change, anywhere, by merging, building or running any test (the Postgres test is skipped without `DATABASE_URL` and was not run). The durable-map layer registers the migrations of a table when the map object is built, so the table appears only at the first boot after an operator sets `ZQ_PATCH_RETAIN=1` and wires the runtime (not done here). DDL, the shape the layer would create, and the DBA text are unchanged from `docs/zq-git-mcp-ddl-proposal.md` section 10 (on `oa/spike-git`):

```sql
CREATE TABLE IF NOT EXISTS zq_patch_packages (id TEXT PRIMARY KEY, json JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL);
ALTER TABLE zq_patch_packages ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if rows exist>;
CREATE UNIQUE INDEX CONCURRENTLY zq_patch_packages_tenant_pkey ON zq_patch_packages (tenant_id, id);
ALTER TABLE zq_patch_packages DROP CONSTRAINT zq_patch_packages_pkey, ADD CONSTRAINT zq_patch_packages_pkey PRIMARY KEY USING INDEX zq_patch_packages_tenant_pkey;
ALTER TABLE zq_patch_packages ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE zq_patch_packages ADD CONSTRAINT zq_patch_packages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE zq_patch_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zq_patch_packages USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

Result: `id text`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, row level security `tenant_isolation`, the layer's claim functions, no secondary index, no declared indexed field, no CHECK, no enum type. Grants: QM's application role only.

Implemented against DDL section 10, field by field: `id`, `kind`, `ticket`, `repo`, `recipient`, `baseCommit`, `files`, `zip`, `createdAt`, `expiresAt`, `deletedAt` exactly as designed; `resultCommit` as decided above (the open gap). Not in the row, as designed: `delivery`, `attempts`, `deliveredAt`, `lastError`, `postId` (moved to `zq_patch_deliveries`, step 4c, not built). No field was added, renamed or dropped against the DDL text. The tenant directory in the file layout is not a row field.

Access pattern: the code reads rows with `all()` and `get(id)` and writes with `put`, `update` and `deleteIf`; it uses `claimTenants()` only in the sweeper. A few dozen rows a day make a full scan cheap, so no index field is declared (as the DDL says).

## Cleanup (`cleanup({ now, batchSize })`)

- Selects at most `batchSize` (default `ZQ_PATCH_CLEANUP_BATCH`, 50) rows with no `deletedAt` whose `expiresAt` is at or before `now`, oldest first, re-reads each row, then deletes the package directory FIRST and marks `deletedAt` SECOND. A crash between the two leaves a harmless record; the next run finds the directory missing (counts as success) and marks it. The reverse order would leak a directory with no record.
- Then removes at most `batchSize` rows whose `deletedAt` is `ZQ_PATCH_RECORD_DAYS` or more days old (`deleteIf` re-checks the row).
- Idempotent and safe on two instances: a second run changes nothing. Returns `{ deleted, purged, refused }`; `refused` lists ids whose path was not a plain directory or whose id was not a plain name; they are logged and retried (and logged) every sweep until an operator looks.
- The step of the design that moves delivery rows to `abandoned` (`package_expired`) before deleting the directory belongs to step 4c: `zq_patch_deliveries` does not exist yet.

## Orphan report (`orphans()`)

Reports, deletes nothing: `orphanDirectories` are entries of the tenant directory with no record (a crash after the zip was written and before the record: recording the package again repairs it; otherwise it stays until an operator removes it), and `missingZips` are live records whose zip is missing, the wrong size or the wrong hash (recording the package again rewrites the zip). Nothing calls it on a schedule.

## Configuration disclosure

All settings are environment only. Exactly the five of the design are implemented; none was added or renamed. No existing setting changes.

| Setting                  | Default | Meaning and validation                                                                                                                                        |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_PATCH_RETAIN`        | off     | `1` turns retention on, anything else is off (like every other `ZQ_*` switch). Off: nothing below is read, validated or created                               |
| `ZQ_PATCH_RETAIN_DIR`    | unset   | absolute path, no `..` segment, not under the temporary directory (checked against `os.tmpdir()` and its real path); required when on; trailing slash removed |
| `ZQ_PATCH_RETAIN_DAYS`   | 30      | integer 1 to 3650, days a package and its zip are kept                                                                                                        |
| `ZQ_PATCH_RECORD_DAYS`   | 30      | integer 1 to 3650, days a record outlives its files                                                                                                           |
| `ZQ_PATCH_CLEANUP_BATCH` | 50      | integer 1 to 1000, rows handled per cleanup call                                                                                                              |

Precedence: environment, then the default. A bad value, or `ZQ_PATCH_RETAIN=1` without a usable directory, refuses startup with a message that names the setting. Supported combinations: retention on or off independently of everything else; the builder works without it. `ZQ_PATCH_MAX_PACKAGE_BYTES` (unchanged) is measured on the zip whether or not retention is on. `ZQ_PATCH_DELIVERY` and `ZQ_PATCH_DELIVERY_*` do not exist yet (step 4c; the design requires retention on for them). The 60-minute sweep interval, the 20 batches per sweep and the `zq:patch-retention` lease name are constants. `ZQ_PATCH_RETAIN_DAYS` and the other values are config, not per-package choices.

## Staging steps (nothing here has been run against a real database, service or environment)

Needs the PM's separate explicit consent for each environment, and a person with the DBA role for the table. Step 0: the wiring of `createPatchRetentionRuntime` into startup does not exist yet; these steps apply after it is added by a later change.

Off (default):

1. Boot with every `ZQ_PATCH_*` setting unset. Expected: no `zq_patch_packages` table (`SELECT tablename FROM pg_tables WHERE tablename LIKE 'zq\_patch\_%'` returns no row), no retention directory, no timer, no log line about retention. Stop if any of those exists.
2. Set `ZQ_PATCH_RETAIN_DAYS=abc` (switch still unset). Expected: boots normally (ignored while off).

On:

1. `ZQ_PATCH_RETAIN=1` without a directory, with a relative one, with one under the temporary directory, and with `ZQ_PATCH_RETAIN_DAYS=0`. Expected: each refuses startup naming the setting. Stop if any boots.
2. A valid, persistent, backed-up, application-owned directory and `ZQ_PATCH_RETAIN=1`. Expected: boots; the table `zq_patch_packages` exists with columns `id`, `json`, `tenant_id`, primary key `(tenant_id, id)` and policy `tenant_isolation`, and NO `zq_patch_deliveries`; the directory exists with mode `0700`. Stop if another table appears or the mode is wider.
3. Build and record a package by hand (a script calling `retain`): one row with the content addressed id, `zip.sha256` equal to `sha256sum` of the file, the file mode `0600` in a `0700` directory; do it twice: still one row, `createdAt` unchanged. Run `cleanup` by hand with a moved clock: the directory goes, `deletedAt` is set; a second run changes nothing. Run `orphans()`: reports only, deletes nothing. Stop if a row holds an email or an absolute path, if a directory is left after a cleanup, or if anything outside the retention directory changed.
4. Rolling back is below.

Rollback: unset `ZQ_PATCH_RETAIN` and restart. The map is no longer built; the table, its rows and the files stay and are inert. Removing the data needs the PM's decision, DBA text in DDL section 10 (`DROP TABLE IF EXISTS zq_patch_packages;` and the claim functions, `DELETE FROM durable_map_versions WHERE tbl = 'zq_patch_packages';`); the files under `ZQ_PATCH_RETAIN_DIR` are removed separately.

## Not decided or not built

1. Who owns the persistent directory's disk, and whether it is backed up (the files can be rebuilt from the base commit and the change; the record cannot).
2. Wiring into `src/wiring.ts`, the agent tool that calls `retain` (4d), delivery and its table (4c).
3. Whether the sweep interval should be a setting; whether expired records should be kept longer as audit (`ZQ_PATCH_RECORD_DAYS` covers it).
4. Not verified: a real Postgres (the gated test needs `DATABASE_URL`), Windows, a filesystem without `fsync` guarantees, a full disk, two QM instances at once on a shared directory (the lease serialises the sweeper; recording is idempotent and atomic per file).
