import "./support/auto-fake-sprites.ts";
import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createInsecureTestServer } from "../src/api/server.ts";
import { setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { contractViolation, parseToolContract, type McpToolContract } from "../src/mcp/tool-contract.ts";
import { buildApp } from "./support/build-app.ts";
import { loopbackFetch, startMcpTestServer } from "./support/mcp-test-server.ts";
import { testConfig } from "./support/test-config.ts";
import { testMap } from "./support/test-database.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-mcp-tools.json", import.meta.url), "utf8"),
) as { tools: Tool[] };

const CONTRACT = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-tool-contract.json", import.meta.url), "utf8"),
) as McpToolContract;
const HOST = "op.example.com";
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function without(...names: string[]): Tool[] {
  return recorded.tools.filter((t) => !names.includes(t.name));
}

function opServer(url: string, partial?: Partial<McpServer>): McpServer {
  return {
    id: "openproject",
    name: "OpenProject",
    url,
    auth: "oauth-user",
    credentialScope: "per-user",
    credentialHost: HOST,
    clientId: "op-client",
    oauthAuthorizeUrl: `https://${HOST}/oauth/authorize`,
    oauthTokenUrl: `https://${HOST}/oauth/token`,
    oauthScopes: ["api_v3"],
    toolContract: CONTRACT,
    readOnly: false,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("the recorded OpenProject listing satisfies the contract", () => {
  assert.equal(contractViolation(recorded.tools, CONTRACT), undefined);
  assert.equal(contractViolation(recorded.tools, undefined), undefined);
});

test("a missing required tool and an exposed forbidden tool are both reported", () => {
  const tools = [
    ...without("add_work_package_comment", "update_work_package"),
    { name: "delete_work_package" },
    { name: "delete_meeting" },
    { name: "bulk_update_work_packages" },
  ];
  assert.deepEqual(contractViolation(tools, CONTRACT), {
    missing: ["update_work_package", "add_work_package_comment"],
    forbidden: ["delete_work_package", "delete_meeting", "bulk_update_work_packages"],
  });
});

test("tool contracts parse strictly", () => {
  assert.equal(parseToolContract(undefined), undefined);
  assert.equal(parseToolContract({}), undefined);
  assert.deepEqual(parseToolContract({ forbidden: ["delete_*"] }), { required: [], forbidden: ["delete_*"] });
  assert.deepEqual(parseToolContract({ required: ["a", "a"], forbidden: ["b"] }), {
    required: ["a"],
    forbidden: ["b"],
  });
  for (const bad of [
    [],
    "x",
    { required: "a" },
    { required: [1] },
    { required: ["a b"] },
    { required: ["a"], forbidden: ["a"] },
    { required: ["delete_x"], forbidden: ["delete_*"] },
    { required: ["a*"] },
    { required: ["a"], extra: 1 },
  ]) {
    assert.equal(parseToolContract(bad), "invalid", JSON.stringify(bad));
  }
});

test("sign-in against a server that dropped a required tool fails loudly and loads nothing", async (t) => {
  const store = createMcpServerStore(testMap<McpServer>());
  const mcp = await startMcpTestServer(t, { tools: without("add_work_package_comment") });
  const service = createMcpToolService({
    fetch: loopbackFetch,
    servers: store,
    userTokens: {
      connectorAccessToken: async () => "alice-token",
      connectorTokenStatus: async () => ({ connected: true }),
    },
  });
  t.after(() => {
    service.close();
    setPublicOAuthClients([]);
  });
  await store.put(opServer(`${mcp.url}/mcp`));
  await service.refresh();
  await assert.rejects(
    service.call("openproject_sign_in", {}, "internal:alice"),
    /missing required tools: add_work_package_comment/,
  );
  assert.equal((await store.get("openproject"))?.tools, undefined);
  assert.deepEqual(
    (await service.toolDefsFor("internal:alice")).map((d) => d.name),
    ["openproject_sign_in"],
  );
});

test("sign-in against a conforming server loads the recorded tools", async (t) => {
  const store = createMcpServerStore(testMap<McpServer>());
  const mcp = await startMcpTestServer(t, { tools: recorded.tools });
  const service = createMcpToolService({
    fetch: loopbackFetch,
    servers: store,
    userTokens: {
      connectorAccessToken: async () => "alice-token",
      connectorTokenStatus: async () => ({ connected: true }),
    },
  });
  t.after(() => {
    service.close();
    setPublicOAuthClients([]);
  });
  await store.put(opServer(`${mcp.url}/mcp`));
  await service.refresh();
  assert.match(await service.call("openproject_sign_in", {}, "internal:alice"), /Signed in to OpenProject/);
  const names = (await service.toolDefsFor("internal:alice")).map((d) => d.name);
  assert.ok(names.includes("openproject_list_work_packages"));
  assert.equal(names.length, recorded.tools.length);
});

test("tools already stored are withdrawn when the contract is tightened", async (t) => {
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({
    fetch: loopbackFetch,
    servers: store,
    userTokens: {
      connectorAccessToken: async () => "alice-token",
      connectorTokenStatus: async () => ({ connected: true }),
    },
  });
  t.after(() => {
    service.close();
    setPublicOAuthClients([]);
  });
  await store.put(
    opServer("https://op.example.com/mcp", {
      toolContract: undefined,
      tools: recorded.tools.map((x) => ({
        name: x.name,
        description: x.description ?? "",
        inputSchema: x.inputSchema,
      })),
    }),
  );
  await service.refresh();
  assert.equal((await service.toolDefsFor("internal:alice")).length, recorded.tools.length);
  await store.put(
    opServer("https://op.example.com/mcp", {
      tools: without("get_work_package").map((x) => ({
        name: x.name,
        description: x.description ?? "",
        inputSchema: x.inputSchema,
      })),
    }),
  );
  await service.refresh();
  assert.deepEqual(
    (await service.toolDefsFor("internal:alice")).map((d) => d.name),
    ["openproject_sign_in"],
  );
});

test("admin save rejects a shared-token server that violates its contract, and stores a conforming one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-contract-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(testMap<McpServer>());
  const mcp = await startMcpTestServer(t, {
    tools: [...recorded.tools, { name: "delete_work_package", inputSchema: { type: "object" } }],
  });
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
    mcpToolService: service,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/openproject`;
  const put = (body: object) =>
    fetch(url, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ url: `${mcp.url}/mcp`, auth: "none", ...body }),
    });

  assert.equal((await put({ toolContract: { required: ["a"], forbidden: ["a"] } })).status, 400);
  const rejected = await put({ toolContract: CONTRACT });
  assert.equal(rejected.status, 400);
  const body = (await rejected.json()) as { error: string; forbidden: string[]; missing: string[] };
  assert.equal(body.error, "contract_violation");
  assert.deepEqual(body.forbidden, ["delete_work_package"]);
  assert.equal(await store.get("openproject"), null);

  const accepted = await put({
    toolContract: { required: CONTRACT.required, forbidden: ["bulk_update_work_packages"] },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await store.get("openproject"))?.toolContract?.forbidden, ["bulk_update_work_packages"]);
  assert.equal((await put({})).status, 200);
  assert.ok((await store.get("openproject"))?.toolContract, "an update without toolContract keeps it");
  assert.equal((await put({ toolContract: null })).status, 200);
  assert.equal((await store.get("openproject"))?.toolContract, undefined);
});
