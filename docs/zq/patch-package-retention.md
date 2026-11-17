# Patch package retention and delivery: design

Status: DESIGN ONLY. Nothing in this document is implemented, wired, scheduled or enabled. The table described here is NOT approved and must not be created. No code reads any setting named here, and no environment sets one. This follows the PM decisions of 2026-11-17: packages are kept 30 days in a persistent directory with a database record, and are delivered by Mattermost direct message with a zip attachment.

Context: `docs/zq/patch-package.md` describes how a package (a verified text patch directory, or an xlsx package) is built into `ZQ_PATCH_OUTPUT_DIR`, which defaults to a temporary directory. That directory is neither persistent nor cleaned, and nothing is delivered.

## Storage

- Directory: a persistent location configured by `ZQ_PATCH_RETAIN_DIR` (absolute path, no default; unset means retention is off). It must not be under the system temporary directory; the feature would refuse a path under `os.tmpdir()`. Each package keeps its existing directory name `<ticket>-<first 12 characters of the commit id>`.
- Record: one Postgres row per package in a durable map named `zq_patch_packages`. The row holds metadata only: no file content, no patch text, no commit message body, no credential, no absolute path.
- Expiry: `expiresAt = createdAt + 30 days` (`ZQ_PATCH_RETAIN_DAYS`).

## Record shape (durable map `zq_patch_packages`)

Id: `<ticket>-<first 12 characters of the commit id>` (the directory name). The same id makes recording idempotent: recording the same package twice updates the same row. All timestamps are epoch milliseconds.

```json
{
  "id": "WP-123-0123456789ab",
  "kind": "text-patch",
  "ticket": "WP-123",
  "recipient": "mm-zhang",
  "baseCommit": "<40 hex characters>",
  "resultCommit": "<40 hex characters>",
  "files": [
    { "name": "0001-fix-the-thing.patch", "sha256": "<64 hex characters>", "bytes": 4210 },
    { "name": "manifest.json", "sha256": "<64 hex characters>", "bytes": 1190 }
  ],
  "zip": { "name": "WP-123-0123456789ab.zip", "sha256": "<64 hex characters>", "bytes": 5120 },
  "createdAt": 1763000000000,
  "expiresAt": 1765592000000,
  "delivery": "pending",
  "attempts": 0
}
```

Optional keys, absent when unset: `deliveredAt`, `lastError` (an error code, never a response body), `postId` (the Mattermost post id of the delivered message), `deletedAt`.

`delivery` is one of `pending`, `sending`, `delivered`, `failed`, `expired` (the retention window ended before delivery succeeded). `recipient` is the Mattermost user name of the responsible person as resolved by the existing identity map; it is not an email address.

Invented example rows (INVENTED, for illustration only):

1. A delivered package: id `WP-123-0123456789ab`, `recipient` `mm-zhang`, `delivery` `delivered`, `attempts` 1, `deliveredAt` 1763000090000, `postId` `p4x9`, `createdAt` 1763000000000, `expiresAt` 1765592000000.
2. A package whose delivery failed: id `456-ba9876543210`, `kind` `xlsx`, `ticket` `456`, `recipient` `mm-li`, `delivery` `failed`, `attempts` 5, `lastError` `mattermost_rejected`.

Before and after: a new table. No existing table, column, index, constraint or JSON key changes. There is no migration, backfill or compatibility effect, because nothing exists yet.

## DDL, as the durable-map layer would create it (NOT approved, do not create)

The table would be created by `createPostgresMap` and `durableMapTenancy` (`src/persistence/durable-map.ts`, `src/tenants/migrations.ts`) the moment a map named `zq_patch_packages` is built, in the same shape as every other durable map:

```sql
CREATE TABLE IF NOT EXISTS zq_patch_packages (id TEXT PRIMARY KEY, json JSONB NOT NULL);
ALTER TABLE zq_patch_packages ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if rows exist>;
CREATE UNIQUE INDEX CONCURRENTLY zq_patch_packages_tenant_pkey ON zq_patch_packages (tenant_id, id);
ALTER TABLE zq_patch_packages DROP CONSTRAINT zq_patch_packages_pkey, ADD CONSTRAINT zq_patch_packages_pkey PRIMARY KEY USING INDEX zq_patch_packages_tenant_pkey;
ALTER TABLE zq_patch_packages ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE zq_patch_packages ADD CONSTRAINT zq_patch_packages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE zq_patch_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zq_patch_packages USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

Result: `id text`, `json jsonb NOT NULL`, `tenant_id uuid NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, row level security with the `tenant_isolation` policy, no other index, plus the claim functions the layer adds and a `durable_map_versions` row. Grants: QM core's application role only, as for every durable map; no service role.

The table is NOT approved. It must not be created, and no code may build a map with this name until the PM approves this section. As with the Jenkins tables, the map must only be built behind its own switch (`ZQ_PATCH_RETAIN=1`) so that default configuration creates nothing.

## Cleanup job

An unscheduled function `cleanupExpiredPackages({ now, batchSize })` in the retention module, not called from startup and not registered with any sweeper until a schedule is approved (like `pruneGitAudit`).

- Selects at most `batchSize` (default 50, `ZQ_PATCH_CLEANUP_BATCH`) rows whose `expiresAt` is at or before `now`, oldest first. One call does at most one batch; the caller loops.
- For each row: delete the package directory, then mark the row (`deletedAt`, and `delivery` `expired` if it was not delivered). A later pass removes rows whose `deletedAt` is older than 30 days (`ZQ_PATCH_RECORD_DAYS`), so the audit trail outlives the files. The directory name comes from the row id after the id is validated against `^[A-Za-z0-9._-]+$` and resolved inside `ZQ_PATCH_RETAIN_DIR`; a path that resolves outside is refused and logged, never deleted.
- Order: directory first, record second. If the process dies after the directory is deleted, the record still says the package exists; the next run finds the directory missing, which counts as success, and finishes the record. The reverse order would risk an orphaned directory with no record, which nothing would ever clean. A leftover record is harmless and self-healing; a leftover directory is a silent leak.
- Idempotent: running twice, or concurrently on two instances, gives the same end state. Deleting a missing directory is success, and marking an already marked record changes nothing.
- Batched: bounded work per call, so one run cannot hold the process or the database for long.
- A second function reports directories under `ZQ_PATCH_RETAIN_DIR` with no record (orphans) without deleting them; removing orphans is an operator decision.

## Delivery

Through a Mattermost direct message from the QM bot to `recipient`, with the package as a zip attachment. The message names the ticket, the subject, the base commit and the sha256 of `manifest.json`, so the recipient can check the attachment against the message. The zip is built from the package directory with a fixed file order and fixed timestamps and is itself recorded (`zip.sha256`). The message carries no patch content.

Failure handling and idempotency:

- The row moves `pending`, then `sending` (compare-and-set, with the attempt count incremented before the call), then `delivered` with `postId` and `deliveredAt`.
- A `sending` row older than 10 minutes is treated as uncertain and is not blindly resent. The sender first looks in the direct message channel for a post carrying the package id in its props; if found the row becomes `delivered`, if not it returns to `pending`.
- Each post carries the package id in its props, which is the idempotency key for that check. A package is never posted twice by a retry.
- Retries use exponential backoff (60 seconds, doubling, capped at 1 hour), at most 5 attempts (`ZQ_PATCH_DELIVERY_ATTEMPTS`), then `failed` and a notice to the PM that the recipient could not be reached. A user who cannot be resolved, or whose account is deactivated, goes straight to `failed` and to the PM without retries.
- A zip over the Mattermost upload limit is not split: the row is `failed` with `lastError` `too_large`, and the PM is told.
- Delivery is attempted only while the package is not expired; after `expiresAt` the row becomes `expired`.

## Configuration items that would exist (none exist today)

| Name                         | Default | Meaning                                                    |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `ZQ_PATCH_RETAIN`            | off     | Switch; off builds no map and creates no table             |
| `ZQ_PATCH_RETAIN_DIR`        | unset   | Persistent absolute directory, not under the temporary dir |
| `ZQ_PATCH_RETAIN_DAYS`       | 30      | Days a package and its files are kept                      |
| `ZQ_PATCH_RECORD_DAYS`       | 30      | Days a record outlives its files                           |
| `ZQ_PATCH_CLEANUP_BATCH`     | 50      | Rows handled per cleanup call                              |
| `ZQ_PATCH_DELIVERY_ATTEMPTS` | 5       | Delivery attempts before `failed`                          |

No existing setting changes. No environment sets any of these.

## Open questions

1. PM approval of the table and its DDL.
2. Where the persistent directory lives in each environment, who owns its disk, and whether it is backed up (the files can be rebuilt from the base commit and the change; the record cannot).
3. Who the recipient is (the commit author, the ticket assignee, or a fixed person) and where that mapping comes from.
4. The Mattermost upload size limit in production, and whether oversize packages need an alternative.
5. The schedule for the cleanup job and the delivery retries, and which sweeper runs them.
6. Whether expired records should be deleted at all, or kept as audit.
7. Large binary refusal: the size threshold is not named (see `docs/zq/patch-package.md`).
8. The final ticket format (the provisional default is `WP-<digits>` or a plain number).
