import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GitMcpContractError, GIT_MCP_TOOLS } from "../src/zq/git-mcp/contract.ts";
import { GitMcpError, GitMcpUnreachable, createGitMcpClient } from "../src/zq/git-mcp/client.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";

const SECRET = "shared-secret-value-0123456789";

const tool = (name: string, properties: Record<string, object> = { repo: { type: "string" } }): Tool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties },
});
const nine = () => GIT_MCP_TOOLS.map((name) => tool(name));
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

test("the client sends the bearer secret and the caller label and returns the parsed update response", async (t) => {
  const server = await startMcpTestServer(t, {
    tools: nine(),
    stateless: true,
    json: true,
    authorize: (authorization) => authorization === `Bearer ${SECRET}`,
    call: (name, args) =>
      text({
        repos: [{ repo: "client", status: "changed", updates: [{ branch: "main", status: "updated", commits: [] }] }],
        ack: [{ repo: "client", branch: "main", from: "a".repeat(40), to: "b".repeat(40) }],
        acknowledged: Array.isArray((args as { ack?: unknown[] }).ack) ? (args as { ack: unknown[] }).ack.length : 0,
      }),
  });
  const client = createGitMcpClient({ url: `${server.url}/mcp`, secret: SECRET });
  const first = await client.checkUpdates("zq-poller");
  assert.equal(first.repos[0]?.status, "changed");
  assert.equal(first.acknowledged, 0);
  const second = await client.checkUpdates("zq-poller", first.ack);
  assert.equal(second.acknowledged, 1);
  const calls = server.requests.filter((request) => request.rpc === "tools/call");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((request) => request.authorization === `Bearer ${SECRET}` && request.caller === "zq-poller"));
});

test("a tool error keeps the service's code and the secret never appears in any error", async (t) => {
  const server = await startMcpTestServer(t, {
    tools: nine(),
    stateless: true,
    json: true,
    authorize: (authorization) => authorization === `Bearer ${SECRET}`,
    call: () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code: "audit_unavailable", message: `failed with ${SECRET}` } }),
        },
      ],
    }),
  });
  const client = createGitMcpClient({ url: `${server.url}/mcp`, secret: SECRET });
  await assert.rejects(client.call("list_repos", {}, "zq-poller"), (e) => {
    assert.ok(e instanceof GitMcpError);
    assert.equal(e.code, "audit_unavailable");
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
  const wrong = createGitMcpClient({ url: `${server.url}/mcp`, secret: "not-the-secret-0123456789" });
  await assert.rejects(wrong.checkUpdates("zq-poller"), (e) => {
    assert.ok(e instanceof GitMcpUnreachable);
    assert.ok(!e.message.includes("not-the-secret"));
    return true;
  });
});

test("a service that cannot be reached is an unreachable error", async () => {
  const client = createGitMcpClient({ url: "http://127.0.0.1:1/mcp", secret: SECRET });
  await assert.rejects(
    client.checkUpdates("zq-poller"),
    (e) => e instanceof GitMcpUnreachable && !e.message.includes(SECRET),
  );
});

test("verify accepts exactly the nine tools and fails loudly on a dropped tool, a write tool or a url argument", async (t) => {
  const ok = await startMcpTestServer(t, { tools: nine(), stateless: true, json: true });
  await createGitMcpClient({ url: `${ok.url}/mcp`, secret: SECRET }).verify();
  const dropped = await startMcpTestServer(t, {
    tools: nine().filter((entry) => entry.name !== "search"),
    stateless: true,
    json: true,
  });
  await assert.rejects(createGitMcpClient({ url: `${dropped.url}/mcp`, secret: SECRET }).verify(), (e) => {
    assert.ok(e instanceof GitMcpContractError);
    assert.deepEqual(e.violation.missing, ["search"]);
    return true;
  });
  const writer = await startMcpTestServer(t, { tools: [...nine(), tool("push_branch")], stateless: true, json: true });
  await assert.rejects(createGitMcpClient({ url: `${writer.url}/mcp`, secret: SECRET }).verify(), (e) => {
    assert.ok(e instanceof GitMcpContractError);
    assert.deepEqual(e.violation.forbidden, ["push_branch"]);
    return true;
  });
  const withUrl = await startMcpTestServer(t, {
    tools: nine().map((entry) =>
      entry.name === "get_diff" ? tool("get_diff", { repo: { type: "string" }, url: { type: "string" } }) : entry,
    ),
    stateless: true,
    json: true,
  });
  await assert.rejects(createGitMcpClient({ url: `${withUrl.url}/mcp`, secret: SECRET }).verify(), (e) => {
    assert.ok(e instanceof GitMcpContractError);
    assert.deepEqual(e.violation.rawInputs, [{ tool: "get_diff", property: "url" }]);
    return true;
  });
});

test("an unsafe url or a missing secret is refused when the client is built", () => {
  for (const url of ["ftp://x/mcp", "http://user:pw@host/mcp", "http://host/mcp?token=1", "not a url"])
    assert.throws(() => createGitMcpClient({ url, secret: SECRET }));
  assert.throws(() => createGitMcpClient({ url: "http://host/mcp", secret: "" }), /secret/);
});
