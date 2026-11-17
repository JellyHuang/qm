import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryBlobMetaLedger } from "../src/ledger.ts";

test("learned sizes and binary flags are kept per repository and object and merged", () => {
  const ledger = createMemoryBlobMetaLedger();
  const oid = "a".repeat(40);
  assert.equal(ledger.get("client", oid), undefined);
  ledger.record("client", oid, { size: 10 });
  ledger.record("client", oid, { size: 10, binary: true });
  assert.deepEqual(ledger.get("client", oid), { size: 10, binary: true });
  assert.equal(ledger.get("server", oid), undefined);
});
