import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMemoryAuditSink, type MemoryAuditSink } from "../../src/audit.ts";
import type { Config } from "../../src/config.ts";
import { createService, type Service } from "../../src/service.ts";

export const SECRET = "test-secret-0123456789";

export function testConfig(root: string, remoteBase: string, overrides: Partial<Config> = {}): Config {
  return {
    secret: SECRET,
    port: 0,
    remoteBase,
    clonesDir: join(root, "data", "clones"),
    scratchDir: join(root, "data", "scratch"),
    cacheDir: join(root, "data", "cache"),
    truncateChars: 60_000,
    scratchCapBytes: 1024 ** 3,
    freeFloorBytes: 0,
    cacheCapBytes: 64 * 1024 * 1024,
    maxFetches: 4,
    maxHeavyJobs: 2,
    maxBigFetches: 2,
    fetchNoProgressMs: 180_000,
    fetchFailureTtlMs: 60_000,
    refreshMs: 60_000,
    audit: "memory",
    tips: "memory",
    blobMeta: "memory",
    auditOnFailure: "serve",
    auditSpoolDir: join(root, "data", "audit-spool"),
    auditSpoolMaxBytes: 64 * 1024 * 1024,
    auditSpoolMaxAgeMs: 7 * 24 * 3600 * 1000,
    xlsxTimeoutMs: 120_000,
    xlsxMaxHeapMb: 768,
    xlsxNoProgressMs: 180_000,
    regexTimeoutMs: 30_000,
    regexMaxChars: 500,
    fetchTimeoutMs: 60_000,
    gitTimeoutMs: 30_000,
    ...overrides,
  };
}

export interface Harness {
  service: Service;
  audit: MemoryAuditSink;
  port: number;
  url: string;
  connect(caller?: string): Promise<Client>;
  call(name: string, args: unknown, caller?: string): Promise<{ body: Record<string, unknown>; isError: boolean }>;
  stop(): Promise<void>;
}

type ServiceOptions = Omit<NonNullable<Parameters<typeof createService>[1]>, "audit">;

export async function startHarness(config: Config, options: ServiceOptions = {}): Promise<Harness> {
  const audit = createMemoryAuditSink();
  const service = createService(config, options.auditTarget ? options : { audit, ...options });
  const { port } = await service.start();
  const url = `http://127.0.0.1:${port}/mcp`;
  const clients: Client[] = [];
  const connect = async (caller = "tester") => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}`, "x-qm-caller": caller } },
      }),
    );
    clients.push(client);
    return client;
  };
  return {
    service,
    audit,
    port,
    url,
    connect,
    async call(name, args, caller) {
      const client = await connect(caller);
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const content = result.content as { type: string; text: string }[];
      return {
        body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>,
        isError: result.isError === true,
      };
    },
    async stop() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      await service.stop();
    },
  };
}
