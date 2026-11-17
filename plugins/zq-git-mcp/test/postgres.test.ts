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
    assert.match(SQL.tipsRecord, /ON CONFLICT \(tenant_id, repo, branch\) DO NOTHING/);
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
    assert.match(SQL.blobMetaUpsert, /ON CONFLICT \(tenant_id, repo, oid\) DO UPDATE/);
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

describe("tenant binding without a database", () => {
  function fakePool() {
    const log: { client: number; text: string; values: unknown[] | undefined }[] = [];
    const idle: {
      id: number;
      query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }[] = [];
    let next = 0;
    return {
      log,
      pool: {
        async connect() {
          const existing = idle.pop();
          if (existing) return existing;
          const id = ++next;
          const client = {
            id,
            async query(text: string, values?: unknown[]) {
              log.push({ client: id, text, values });
              return { rows: [], rowCount: 1 };
            },
            release() {
              idle.push(client);
            },
          };
          return client;
        },
        async end() {},
        on() {},
      },
    };
  }

  test("a configured tenant is bound once per connection before the first statement and nothing is bound otherwise", async () => {
    const tenant = "11111111-2222-4333-8444-555555555555";
    const bound = fakePool();
    const db = createDatabase({ url: "postgres://unused", tenantId: tenant }, bound.pool);
    await db.query("SELECT 1");
    await db.query("SELECT 2");
    assert.deepEqual(
      bound.log.map((entry) => [entry.client, entry.text]),
      [
        [1, SQL.bindTenant],
        [1, "SELECT 1"],
        [1, "SELECT 2"],
      ],
    );
    assert.deepEqual(bound.log[0]?.values, [tenant]);
    assert.match(SQL.bindTenant, /set_config\('qm\.tenant_id', \$1, false\)/);
    const open = fakePool();
    await createDatabase({ url: "postgres://unused" }, open.pool).query("SELECT 1");
    assert.deepEqual(
      open.log.map((entry) => entry.text),
      ["SELECT 1"],
    );
  });

  test("no statement names a tenant value or deletes anything, so the database default and the policy decide", () => {
    for (const text of Object.values(SQL)) {
      assert.doesNotMatch(text, /tenant_id\s*=\s*\$/);
      assert.doesNotMatch(text, /\bDELETE\b|TRUNCATE|REFERENCES/i);
    }
  });
});

const databaseUrl = process.env.ZQ_GIT_MCP_TEST_DATABASE_URL;
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("against a real database", { skip: databaseUrl ? false : "set ZQ_GIT_MCP_TEST_DATABASE_URL" }, () => {
  const suffix = randomBytes(6).toString("hex");
  const schema = `zqgit_${suffix}`;
  const role = `zq_git_mcp_${suffix}`;

  async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  }

  function urlFor(asRole: boolean): string {
    const url = new URL(databaseUrl ?? "");
    url.searchParams.set("options", `-c search_path=${schema}${asRole ? ` -c role=${role}` : ""}`);
    return url.toString();
  }

  const tenanted = (table: string) => `
    ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ${schema}.${table}
      USING (tenant_id = ${schema}.qm_bound_tenant()) WITH CHECK (tenant_id = ${schema}.qm_bound_tenant());`;

  const DDL = `
    CREATE TABLE ${schema}.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION ${schema}.qm_bound_tenant() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE AS $f$
    DECLARE bound text := current_setting('qm.tenant_id', true);
    BEGIN
      IF bound IS NULL OR bound = '' THEN
        RAISE insufficient_privilege USING MESSAGE = 'No tenant is bound to this query';
      END IF;
      RETURN bound::uuid;
    END $f$;
    CREATE TABLE ${schema}.zq_git_audit (
      id text NOT NULL, json jsonb NOT NULL,
      tenant_id uuid NOT NULL DEFAULT ${schema}.qm_bound_tenant() REFERENCES ${schema}.tenants(id),
      PRIMARY KEY (tenant_id, id));
    ${tenanted("zq_git_audit")}
    CREATE TABLE ${schema}.zq_git_branch_tips (
      tenant_id uuid NOT NULL DEFAULT ${schema}.qm_bound_tenant() REFERENCES ${schema}.tenants(id),
      repo text NOT NULL, branch text NOT NULL, tip_sha text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, repo, branch));
    ${tenanted("zq_git_branch_tips")}
    CREATE TABLE ${schema}.zq_git_blob_meta (
      tenant_id uuid NOT NULL DEFAULT ${schema}.qm_bound_tenant() REFERENCES ${schema}.tenants(id),
      repo text NOT NULL, oid text NOT NULL, size_bytes bigint NOT NULL, sha256 text, seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, repo, oid));
    ${tenanted("zq_git_blob_meta")}
    CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT INSERT ON ${schema}.zq_git_audit TO ${role};
    GRANT SELECT, INSERT, UPDATE ON ${schema}.zq_git_branch_tips, ${schema}.zq_git_blob_meta TO ${role};
    INSERT INTO ${schema}.tenants (id) VALUES ('${TENANT_A}'), ('${TENANT_B}');`;

  test("the tables are required, never created, tenant isolated and the role is minimal", async (t) => {
    await admin((client) => client.query(`CREATE SCHEMA ${schema}`));
    try {
      const before = createDatabase({ url: urlFor(false), tenantId: TENANT_A });
      try {
        await assert.rejects(before.assertTables(), /lacks the tables/);
      } finally {
        await before.close();
      }
      await admin((client) => client.query(DDL));
      const db = createDatabase({ url: urlFor(true), tenantId: TENANT_A });
      try {
        await db.assertTables();

        const audit = createPostgresAuditTarget(db);
        await audit.record(auditRow);
        await audit.record(auditRow);
        const stored = await admin((client) => client.query(`SELECT tenant_id, json FROM ${schema}.zq_git_audit`));
        assert.equal(stored.rows.length, 1);
        assert.equal(stored.rows[0]?.tenant_id, TENANT_A);
        await assert.rejects(db.query("SELECT * FROM zq_git_audit"), /permission denied/);

        await admin((client) =>
          client.query(
            `INSERT INTO ${schema}.zq_git_branch_tips (tenant_id, repo, branch, tip_sha) VALUES ('${TENANT_B}', 'client', 'other', '${"9".repeat(40)}')`,
          ),
        );
        const tips = createPostgresTipStore(db);
        await tips.record("client", "main", "a".repeat(40), Date.now());
        await tips.record("client", "main", "b".repeat(40), Date.now());
        assert.deepEqual([...(await tips.list("client")).keys()], ["main"]);
        assert.equal((await tips.list("client")).get("main")?.tip, "a".repeat(40));
        assert.equal(await tips.advance("client", "main", "b".repeat(40), "c".repeat(40), Date.now()), false);
        assert.equal(await tips.advance("client", "main", "a".repeat(40), "c".repeat(40), Date.now()), true);
        assert.equal(await tips.markDeleted("client", "main", "c".repeat(40), Date.now()), true);
        assert.equal((await tips.list("client")).get("main")?.tip, TOMBSTONE_TIP);
        assert.equal(await tips.advance("client", "main", TOMBSTONE_TIP, "d".repeat(40), Date.now()), true);
        assert.equal(await tips.advance("client", "dev", null, "e".repeat(40), Date.now()), true);
        assert.equal(await tips.advance("client", "dev", null, "f".repeat(40), Date.now()), false);
        assert.equal(await tips.advance("client", "other", "9".repeat(40), "8".repeat(40), Date.now()), false);

        const failures: unknown[] = [];
        const ledger = createPostgresBlobMetaLedger(db, (e) => failures.push(e));
        ledger.record("client", "9".repeat(40), { size_bytes: 123 });
        ledger.record("client", "9".repeat(40), { size_bytes: 123, sha256: "8".repeat(64) });
        await sleep(400);
        assert.deepEqual(failures, []);
        const meta = await admin((client) =>
          client.query(`SELECT tenant_id, size_bytes, sha256 FROM ${schema}.zq_git_blob_meta`),
        );
        assert.deepEqual(meta.rows, [{ tenant_id: TENANT_A, size_bytes: "123", sha256: "8".repeat(64) }]);

        for (const statement of [
          "DELETE FROM zq_git_branch_tips",
          "TRUNCATE zq_git_blob_meta",
          "DELETE FROM zq_git_audit",
        ])
          await assert.rejects(db.query(statement), /permission denied/, statement);
      } finally {
        await db.close();
      }

      const unbound = createDatabase({ url: urlFor(true) });
      try {
        await assert.rejects(
          createPostgresAuditTarget(unbound).record({ ...auditRow, id: "unbound" }),
          /No tenant is bound/,
        );
        await assert.rejects(
          createPostgresTipStore(unbound).record("client", "x", "1".repeat(40), Date.now()),
          /No tenant is bound/,
        );
      } finally {
        await unbound.close();
      }
      t.diagnostic(`schema ${schema} verified`);
    } finally {
      await admin(async (client) => {
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
        await client.query(`DROP ROLE IF EXISTS ${role}`);
      });
    }
  });
});
