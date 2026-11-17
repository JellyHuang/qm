# Audit, tips and blob metadata storage

By default everything is in memory. Postgres is opt-in, per store, and never creates tables.

## Settings

| Setting                             | Default              | Meaning                                                                                                                                                  |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_GIT_MCP_AUDIT`                  | `memory`             | `memory` or `postgres`: where audit rows go                                                                                                              |
| `ZQ_GIT_MCP_TIPS`                   | `memory`             | `memory` or `postgres`: where `check_updates` keeps branch tips                                                                                          |
| `ZQ_GIT_MCP_BLOB_META`              | `memory`             | `memory` or `postgres`: whether blob size and sha256 are also written to `zq_git_blob_meta`                                                              |
| `ZQ_GIT_MCP_DATABASE_URL`           | none                 | `postgres://` url. Required when any store is `postgres`. Never logged.                                                                                  |
| `ZQ_GIT_MCP_TENANT_ID`              | none                 | Optional tenant uuid set as the session setting `qm.tenant_id` on each connection. Without it the database role's own binding applies (tenancy is open). |
| `ZQ_GIT_MCP_AUDIT_ON_FAILURE`       | `serve`              | `serve` or `fail`: what a failed audit write does to the call                                                                                            |
| `ZQ_GIT_MCP_AUDIT_SPOOL_DIR`        | `<data>/audit-spool` | Directory of the write-ahead spool (mode 0700)                                                                                                           |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES`  | 64 MiB               | Total spool size; beyond it new rows are dropped, loudly                                                                                                 |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS` | 7 days               | Spooled rows older than this are dropped at replay, loudly                                                                                               |

Precedence is the one of every setting: environment over the JSON file (`ZQ_GIT_MCP_CONFIG`) over the default. A postgres store without a database url, a url that is not `postgres://`, or a tenant that is not a uuid stops the service at start; the message never contains the url.

At start with any postgres store the service checks that `zq_git_audit`, `zq_git_branch_tips` and `zq_git_blob_meta` exist and refuses to start if one is missing. It never creates a table. The SQL is in `src/postgres/sql.ts` only; the tables are the ones of `docs/zq-git-mcp-ddl-proposal.md` and are unchanged.

## Audit row

One shape everywhere (memory, spool, Postgres): `id` (a uuid, the table's `id` column), then the document `at`, `principal` (the `X-QM-Caller` label, or `X-QM-Actor` when only that arrives from the connector), `tool`, `repo`, `ref`, `path`, `args`, `bytes`, `truncated`, `result` (`ok`, `error` or `denied:<reason>`), `ms`, `cache_hit`. The insert is `INSERT INTO zq_git_audit (id, json) ... ON CONFLICT DO NOTHING`, so replaying a row twice is harmless. File content, diffs and commit messages are never stored; `search` queries are arguments and are stored as given.

## When the audit write fails

- `fail`: the call is not served. The caller gets `audit_unavailable` and nothing else; the failure is counted and raised as an alarm.
- `serve` (default): the call is served. The row goes to the spool and a background loop replays the spool into Postgres in order with backoff (1 s, doubling to 60 s), also once at start. New rows queue behind a non-empty spool, so order is kept. A replay that fails halfway rewrites the remaining rows, so no row is inserted twice.

The spool is a write-ahead buffer in front of the durable table, not a system of record. The system of record is `zq_git_audit`; the spool only covers the time Postgres is unreachable, so an outage costs neither calls nor audit rows. Rows are lost only when the spool hits its size bound, a row is older than the age bound at replay, or the disk write itself fails, and each of those is counted and alarmed, never silent. This follows the repository's "durable by default" rule: nothing the operator reads back later lives in RAM alone.

Files: `<spool dir>/segment-000000000001.jsonl`, one JSON row per line, mode 0600, segments of 4 MiB, removed when fully replayed.

## Health and alarms

`list_repos` carries `auditBacklog` (rows waiting in the spool), `auditDegraded` (true while there is a backlog, the last write failed, or rows were dropped), `auditLastError` (clipped, urls removed), `auditDropped` and `auditFailures` (counters since start). No other tool result contains audit information.

Each failure writes one structured JSON line to stderr (`kind` `audit_write_failed`, `audit_dropped` with `reason` `spool_full`, `spool_unwritable` or `expired`, and `audit_recovered`) and calls the injectable alarm hook `deps.alarm(event)` of `createService`. No network call is made by default; QM can pass a function that notifies someone.

## Blob metadata

With `ZQ_GIT_MCP_BLOB_META=postgres` the size and sha256 learned after a download are upserted into `zq_git_blob_meta(repo, oid, size_bytes, sha256, seen_at)` in the background (sha256 stays null until known). The binary flag is not persisted; it stays in memory and is derived again when a file is read. Reads are always served from memory.
