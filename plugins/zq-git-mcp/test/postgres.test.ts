import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import pg from "pg";
import { sleep } from "../src/async.ts";
import type { AuditRow } from "../src/audit.ts";
import { assertTablesPresent, createDatabase, type Queryable } from "../src/postgres/database.ts";
import { SQL, TABLES } from "../src/postgres/sql.ts";
import {
  createPostgresAuditTarget,
  createPostgresBlobMetaLedger,
  createPostgresTipStore,
} from "../src/postgres/stores.ts";
import { TOMBSTONE_TIP } from "../src/tip-store.ts";

type Call = { text: string; values: unknown[] | undefined };

function fakeDb(respond: (call: Call) => { rows?: Record<string, unknown>[]; rowCount?: number } | Error = () => ({})) {
  const calls: Call[] = [];
  const db: Queryable = {
    async query(text, values) {
      const call = { text, values };
      calls.push(call);
      const answer = respond(call);
      if (answer instanceof Error) throw answer;
      return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? 1 };
    },
  };
  return { db, calls };
}

const auditRow: AuditRow = {
  id: "7c1e0000-0000-4000-8000-000000000001",
  at: 1_760_000_000_000,
  principal: "zq-poller",
  tool: "read_file",
  repo: "gameconfig",
  ref: "main",
  path: "cfg/items.xlsx",
  args: { repo: "gameconfig", ref: "main", path: "cfg/items.xlsx" },
  bytes: 4210,
  truncated: false,
  result: "denied:not_found",
  ms: 12,
  cache_hit: false,
};

describe("statements and mapping without a database", () => {
  test("an audit row is inserted idempotently with the table's own field names and no content", async () => {
    const { db, calls } = fakeDb();
    await createPostgresAuditTarget(db).record(auditRow);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, SQL.auditInsert);
    assert.match(calls[0]?.text ?? "", /ON CONFLICT DO NOTHING/);
    const [id, json] = calls[0]?.values ?? [];
    assert.equal(id, auditRow.id);
    const document = JSON.parse(json as string);
    assert.deepEqual(Object.keys(document).sort(), [
      "args",
      "at",
      "bytes",
      "cache_hit",
      "ms",
      "path",
      "principal",
      "ref",
      "repo",
      "result",
      "tool",
      "truncated",
    ]);
    assert.equal(document.result, "denied:not_found");
    assert.equal(document.principal, "zq-poller");
  });

  test("tips are listed, recorded once, advanced from the expected tip and tombstoned with an update only", async () => {
    const { db, calls } = fakeDb(({ text }) =>
      text === SQL.tipsList ? { rows: [{ branch: "main", tip_sha: "a".repeat(40), seen_at_ms: "1700000000000" }] } : {},
    );
    const store = createPostgresTipStore(db);
    assert.deepEqual([...(await store.list("client"))], [["main", { tip: "a".repeat(40), seenAt: 1_700_000_000_000 }]]);
    await store.record("client", "dev", "b".repeat(40), 5);
    assert.equal(calls.at(-1)?.text, SQL.tipsRecord);
    assert.equal(await store.advance("client", "dev", null, "c".repeat(40), 6), true);
    assert.equal(calls.at(-1)?.text, SQL.tipsRecord);
    assert.equal(await store.advance("client", "main", "a".repeat(40), "d".repeat(40), 7), true);
    assert.equal(calls.at(-1)?.text, SQL.tipsAdvance);
    assert.deepEqual(calls.at(-1)?.values, ["client", "main", "a".repeat(40), "d".repeat(40), 7]);
    assert.equal(await store.markDeleted("client", "main", "d".repeat(40), 8), true);
    assert.deepEqual(calls.at(-1)?.values, ["client", "main", "d".repeat(40), TOMBSTONE_TIP, 8]);
    const before = calls.length;
    assert.equal(await store.markDeleted("client", "main", TOMBSTONE_TIP, 9), false);
    assert.equal(calls.length, before);
    for (const call of calls) assert.doesNotMatch(call.text, /DELETE/i);
  });

  test("a stale acknowledgement matches no row and changes nothing", async () => {
    const { db } = fakeDb(() => ({ rowCount: 0 }));
    const store = createPostgresTipStore(db);
    assert.equal(await store.advance("client", "main", "a".repeat(40), "b".repeat(40), 1), false);
    assert.equal(await store.markDeleted("client", "main", "a".repeat(40), 1), false);
    assert.equal(await store.advance("client", "main", null, "b".repeat(40), 1), false);
  });

  test("blob metadata stores size and hash only, keeps the binary flag in memory and survives write failures", async () => {
    const failures: unknown[] = [];
    const { db, calls } = fakeDb(() => new Error("down"));
    const ledger = createPostgresBlobMetaLedger(db, (e) => failures.push(e));
    ledger.record("client", "e".repeat(40), { size_bytes: 99 });
    ledger.markBinary("client", "e".repeat(40), true);
    ledger.record("client", "e".repeat(40), { size_bytes: 99, sha256: "f".repeat(64) });
    await sleep(30);
    assert.deepEqual(ledger.get("client", "e".repeat(40)), { size_bytes: 99, sha256: "f".repeat(64) });
    assert.equal(ledger.binary("client", "e".repeat(40)), true);
    assert.equal(calls.length, 2);
    assert.equal(failures.length, 2);
    assert.equal(calls[0]?.text, SQL.blobMetaUpsert);
    assert.deepEqual(calls[1]?.values, ["client", "e".repeat(40), 99, "f".repeat(64)]);
    for (const call of calls) assert.equal(call.values?.includes(true), false);
  });

  test("a database without the three tables is refused and the message names the missing ones", async () => {
    const present = fakeDb(() => ({ rows: TABLES.map((name) => ({ name, present: true })) }));
    await assertTablesPresent(present.db);
    const missing = fakeDb(() => ({
      rows: [
        { name: "zq_git_audit", present: true },
        { name: "zq_git_branch_tips", present: false },
        { name: "zq_git_blob_meta", present: false },
      ],
    }));
    await assert.rejects(
      assertTablesPresent(missing.db),
      /zq_git_branch_tips, zq_git_blob_meta; the service never creates tables/,
    );
    assert.equal(
      missing.calls.every((call) => !/CREATE/i.test(call.text)),
      true,
    );
  });
});

const databaseUrl = process.env.ZQ_GIT_MCP_TEST_DATABASE_URL;

describe("against a real database", { skip: databaseUrl ? false : "set ZQ_GIT_MCP_TEST_DATABASE_URL" }, () => {
  const schema = `zqgit_${randomBytes(6).toString("hex")}`;

  async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  }

  function urlFor(): string {
    const url = new URL(databaseUrl ?? "");
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  }

  test("the tables are required, never created, and the stores work against the proposed shapes", async (t) => {
    await admin((client) => client.query(`CREATE SCHEMA ${schema}`));
    const db = createDatabase({ url: urlFor() });
    try {
      await assert.rejects(db.assertTables(), /lacks the tables/);
      await admin((client) =>
        client.query(`
          CREATE TABLE ${schema}.zq_git_audit (id text PRIMARY KEY, json jsonb NOT NULL);
          CREATE TABLE ${schema}.zq_git_branch_tips (repo text NOT NULL, branch text NOT NULL, tip_sha text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (repo, branch));
          CREATE TABLE ${schema}.zq_git_blob_meta (repo text NOT NULL, oid text NOT NULL, size_bytes bigint NOT NULL, sha256 text, seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (repo, oid));
        `),
      );
      await db.assertTables();

      const audit = createPostgresAuditTarget(db);
      await audit.record(auditRow);
      await audit.record(auditRow);
      const rows = await db.query("SELECT id, json FROM zq_git_audit");
      assert.equal(rows.rows.length, 1);
      const [stored] = rows.rows;
      const document = stored?.json as { principal: string } | undefined;
      assert.equal(document?.principal, "zq-poller");

      const tips = createPostgresTipStore(db);
      await tips.record("client", "main", "a".repeat(40), Date.now());
      await tips.record("client", "main", "b".repeat(40), Date.now());
      assert.equal((await tips.list("client")).get("main")?.tip, "a".repeat(40));
      assert.equal(await tips.advance("client", "main", "b".repeat(40), "c".repeat(40), Date.now()), false);
      assert.equal(await tips.advance("client", "main", "a".repeat(40), "c".repeat(40), Date.now()), true);
      assert.equal(await tips.markDeleted("client", "main", "c".repeat(40), Date.now()), true);
      assert.equal((await tips.list("client")).get("main")?.tip, TOMBSTONE_TIP);
      assert.equal(await tips.advance("client", "main", TOMBSTONE_TIP, "d".repeat(40), Date.now()), true);
      assert.equal(await tips.advance("client", "dev", null, "e".repeat(40), Date.now()), true);
      assert.equal(await tips.advance("client", "dev", null, "f".repeat(40), Date.now()), false);

      const failures: unknown[] = [];
      const ledger = createPostgresBlobMetaLedger(db, (e) => failures.push(e));
      ledger.record("client", "9".repeat(40), { size_bytes: 123 });
      ledger.record("client", "9".repeat(40), { size_bytes: 123, sha256: "8".repeat(64) });
      await sleep(300);
      assert.deepEqual(failures, []);
      const meta = await db.query("SELECT size_bytes, sha256 FROM zq_git_blob_meta WHERE repo = 'client'");
      assert.deepEqual(meta.rows, [{ size_bytes: "123", sha256: "8".repeat(64) }]);
      t.diagnostic(`schema ${schema} verified`);
    } finally {
      await db.close();
      await admin((client) => client.query(`DROP SCHEMA ${schema} CASCADE`));
    }
  });
});
