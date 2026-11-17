import pg from "pg";
import { SQL, TABLES } from "./sql.ts";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface Database extends Queryable {
  assertTables(): Promise<void>;
  close(): Promise<void>;
}

interface PoolLike {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    release(): void;
  }>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
}

export function createDatabase(
  options: { url: string; tenantId?: string | undefined },
  pool: PoolLike = new pg.Pool({ connectionString: options.url, max: 4 }),
): Database {
  const bound = new WeakSet<object>();
  pool.on("error", () => undefined);

  const db: Database = {
    async query(text, values) {
      const client = await pool.connect();
      try {
        if (options.tenantId && !bound.has(client)) {
          await client.query(SQL.bindTenant, [options.tenantId]);
          bound.add(client);
        }
        const result = await client.query(text, values);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      } finally {
        client.release();
      }
    },
    assertTables: () => assertTablesPresent(db),
    async close() {
      await pool.end();
    },
  };
  return db;
}

export async function assertTablesPresent(db: Queryable): Promise<void> {
  const result = await db.query(SQL.tablesPresent, [[...TABLES]]);
  const missing = result.rows.filter((row) => row.present !== true).map((row) => String(row.name));
  if (missing.length > 0)
    throw new Error(`the database lacks the tables ${missing.join(", ")}; the service never creates tables`);
}
