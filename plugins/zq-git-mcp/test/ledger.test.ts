import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryBlobMetaLedger } from "../src/ledger.ts";

test("size and hash are kept per repository and object and merged, the binary flag lives beside them", () => {
  const ledger = createMemoryBlobMetaLedger();
  const oid = "a".repeat(40);
  assert.equal(ledger.get("client", oid), undefined);
  assert.equal(ledger.binary("client", oid), undefined);
  ledger.record("client", oid, { size_bytes: 10 });
  assert.deepEqual(ledger.get("client", oid), { size_bytes: 10, sha256: null });
  ledger.record("client", oid, { size_bytes: 10, sha256: "f".repeat(64) });
  ledger.record("client", oid, { size_bytes: 10 });
  assert.deepEqual(ledger.get("client", oid), { size_bytes: 10, sha256: "f".repeat(64) });
  ledger.markBinary("client", oid, true);
  assert.equal(ledger.binary("client", oid), true);
  assert.equal(ledger.get("server", oid), undefined);
});
