import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createMemoryAuditSink } from "../src/audit.ts";
import { createService } from "../src/service.ts";
import { withIndexPackPeak } from "./support/rss.ts";

const repo = process.env.ZQ_GIT_MCP_IT_REPO;
const ref = process.env.ZQ_GIT_MCP_IT_REF ?? "main";
const path = process.env.ZQ_GIT_MCP_IT_PATH;
const length = Number(process.env.ZQ_GIT_MCP_IT_LENGTH ?? 1000);

test(
  "reads a configured file from a real remote and reports the client side peak memory",
  { skip: repo && path ? false : "set ZQ_GIT_MCP_IT_REPO and ZQ_GIT_MCP_IT_PATH with the service environment" },
  async (t) => {
    const config = loadConfig({ ...process.env, ZQ_GIT_MCP_PORT: "0" });
    const audit = createMemoryAuditSink();
    const service = createService(config, { audit });
    const { port } = await service.start();
    try {
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 25);
      const { value, peakBytes } = await withIndexPackPeak(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.secret}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "read_file", arguments: { repo, ref, path, offset: 0, length } },
          }),
        });
        return (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      });
      clearInterval(timer);
      const body = JSON.parse(value.result.content[0]?.text ?? "{}") as { size?: number; kind?: string };
      assert.notEqual(value.result.isError, true, value.result.content[0]?.text);
      t.diagnostic(
        `kind=${body.kind} size=${body.size} service rss growth=${Math.round((peak - baseline) / 1048576)} MiB index-pack peak=${Math.round(peakBytes / 1048576)} MiB cacheHit=${audit.rows().at(-1)?.cache_hit}`,
      );
    } finally {
      await service.stop();
    }
  },
);
