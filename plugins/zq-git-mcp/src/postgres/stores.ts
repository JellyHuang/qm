import type { AuditTarget } from "../audit.ts";
import { createMemoryBlobMetaLedger, type BlobMetaLedger } from "../ledger.ts";
import { TOMBSTONE_TIP, type TipStore } from "../tip-store.ts";
import type { Queryable } from "./database.ts";
import { SQL } from "./sql.ts";

export function createPostgresAuditTarget(db: Queryable): AuditTarget {
  return {
    async record(row) {
      const { id, ...document } = row;
      await db.query(SQL.auditInsert, [id, JSON.stringify(document)]);
    },
  };
}

export function createPostgresTipStore(db: Queryable): TipStore {
  return {
    async list(repo) {
      const result = await db.query(SQL.tipsList, [repo]);
      return new Map(
        result.rows.map((row) => [String(row.branch), { tip: String(row.tip_sha), seenAt: Number(row.seen_at_ms) }]),
      );
    },
    async record(repo, branch, tip, seenAt) {
      await db.query(SQL.tipsRecord, [repo, branch, tip, seenAt]);
    },
    async advance(repo, branch, from, to, seenAt) {
      if (from === null) return ((await db.query(SQL.tipsRecord, [repo, branch, to, seenAt])).rowCount ?? 0) === 1;
      return ((await db.query(SQL.tipsAdvance, [repo, branch, from, to, seenAt])).rowCount ?? 0) === 1;
    },
    async markDeleted(repo, branch, from, seenAt) {
      if (from === TOMBSTONE_TIP) return false;
      return ((await db.query(SQL.tipsAdvance, [repo, branch, from, TOMBSTONE_TIP, seenAt])).rowCount ?? 0) === 1;
    },
  };
}

export function createPostgresBlobMetaLedger(db: Queryable, onError: (e: unknown) => void): BlobMetaLedger {
  const memory = createMemoryBlobMetaLedger();
  let writes: Promise<unknown> = Promise.resolve();
  return {
    get: memory.get,
    binary: memory.binary,
    markBinary: memory.markBinary,
    record(repo, oid, meta) {
      memory.record(repo, oid, meta);
      const stored = memory.get(repo, oid);
      writes = writes
        .then(() =>
          db.query(SQL.blobMetaUpsert, [repo, oid, stored?.size_bytes ?? meta.size_bytes, stored?.sha256 ?? null]),
        )
        .catch(onError);
    },
  };
}
