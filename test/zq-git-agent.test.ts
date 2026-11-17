import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createAgentTools, type ToolContextRef } from "../src/agent/agent-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { GIT_AGENT_OPERATIONS, createGitAgent, gitAgent, setGitAgent } from "../src/zq/git-mcp/agent.ts";
import { createGitMcpClient, type GitMcpClient } from "../src/zq/git-mcp/client.ts";
import { GIT_MCP_TOOLS, GitMcpContractError } from "../src/zq/git-mcp/contract.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";

const SECRET = "shared-secret-value-0123456789";
const URL_ENV = { ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp", ZQ_GIT_MCP_SECRET: SECRET };

const tool = (name: string, properties: Record<string, object> = { repo: { type: "string" } }): Tool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties },
});
const nine = () => GIT_MCP_TOOLS.map((name) => tool(name));
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

async function service(
  t: Parameters<typeof startMcpTestServer>[0],
  opts: { tools?: Tool[]; answer?: (name: string, args: Record<string, unknown>) => ReturnType<typeof reply> } = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = await startMcpTestServer(t, {
    tools: opts.tools ?? nine(),
    stateless: true,
    json: true,
    authorize: (authorization) => authorization === `Bearer ${SECRET}`,
    call: (name, args) => {
      calls.push({ name, args });
      return opts.answer?.(name, args) ?? reply({ ok: true, name, truncated: false });
    },
  });
  const client = createGitMcpClient({ url: `${server.url}/mcp`, secret: SECRET });
  return { server, calls, client, agent: createGitAgent({ client }) };
}

const toolCalls = (server: { requests: Array<{ rpc?: string; caller?: string; authorization?: string }> }) =>
  server.requests.filter((request) => request.rpc === "tools/call");

afterEach(() => setGitAgent(undefined));

const VALID: Record<string, Record<string, unknown>> = {
  list_repos: {},
  list_commits: { repo: "gameconfig", limit: 3 },
  get_commit: { repo: "gameconfig", sha: "a".repeat(40) },
  get_diff: { repo: "gameconfig", range: "a..b", paths: ["x.txt"] },
  read_file: { repo: "gameconfig", ref: "main", path: "a.txt", startLine: 1, endLine: 5 },
  blame: { repo: "gameconfig", ref: "main", path: "a.txt", startLine: 1, endLine: 5 },
  search: { repo: "gameconfig", ref: "main", query: "x", kind: "path" },
  diff_xlsx: {
    repo: "gameconfig",
    path: "t.xlsx",
    base: "a",
    head: "b",
    overrides: { Sheet1: { keyColumns: ["id"], headerRow: 1 } },
  },
};

test("the agent can run exactly the eight read operations and never check_updates", () => {
  assert.deepEqual([...GIT_AGENT_OPERATIONS].sort(), GIT_MCP_TOOLS.filter((name) => name !== "check_updates").sort());
  assert.deepEqual([...GIT_AGENT_OPERATIONS].sort(), Object.keys(VALID).sort());
});

test("each of the eight operations reaches the service with its own arguments and returns the service's JSON", async (t) => {
  const h = await service(t);
  for (const operation of GIT_AGENT_OPERATIONS) {
    const out = JSON.parse(await h.agent.call({ operation, ...VALID[operation] }, "internal:alice")) as {
      name: string;
    };
    assert.equal(out.name, operation);
  }
  assert.deepEqual(
    h.calls.map((c) => c.name),
    [...GIT_AGENT_OPERATIONS],
  );
  assert.deepEqual(h.calls[1]?.args, { repo: "gameconfig", limit: 3 });
});

test("an ack argument, an unknown argument and a forged operation are refused before any request is sent", async (t) => {
  const h = await service(t);
  const refused = [
    { operation: "list_commits", repo: "client", ack: [{ repo: "client", branch: "main", from: null, to: "a" }] },
    { operation: "list_repos", ack: [] },
    { operation: "list_commits", repo: "client", argv: ["--all"] },
    { operation: "check_updates" },
    { operation: "check_updates", ack: [{ repo: "client", branch: "main", from: null, to: null }] },
    { operation: "constructor" },
    { operation: "__proto__" },
    { operation: 7 },
    {},
    { operation: "read_file", repo: "client", ref: "main" },
    { operation: "search", repo: "client", ref: "main", query: "x", kind: "everything" },
  ];
  for (const input of refused)
    await assert.rejects(h.agent.call(input, "internal:alice"), Error, JSON.stringify(input));
  assert.equal(h.server.requests.length, 0);
});

test("the service sees the person's label, a defined job label for turns without a person, and the secret only as the bearer", async (t) => {
  const h = await service(t);
  await h.agent.call({ operation: "list_repos" }, "internal:alice");
  await h.agent.call({ operation: "list_repos" }, "system:cron");
  await h.agent.call({ operation: "list_repos" }, undefined);
  await h.agent.call({ operation: "list_repos" }, "has space\nand newline");
  const callers = toolCalls(h.server).map((request) => request.caller);
  assert.deepEqual(callers, ["internal:alice", "qm-job", "qm-job", "qm-unattested"]);
  for (const request of h.server.requests)
    assert.ok(!JSON.stringify({ ...request, authorization: 0 }).includes(SECRET));
  assert.ok(toolCalls(h.server).every((request) => request.authorization === `Bearer ${SECRET}`));
});

test("a truncated result passes through with its flag and a service error keeps its code without the secret", async (t) => {
  const h = await service(t, {
    answer: (name) =>
      name === "read_file"
        ? reply({ text: "x".repeat(100), truncated: true, cut: { items: 0, chars: 5 } })
        : {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: { code: "bad_arguments", message: `rejected ${SECRET}` } }),
              },
            ],
          },
  });
  const out = JSON.parse(await h.agent.call({ operation: "read_file", ...VALID.read_file }, "internal:alice")) as {
    truncated: boolean;
  };
  assert.equal(out.truncated, true);
  await assert.rejects(h.agent.call({ operation: "list_repos" }, "internal:alice"), (e) => {
    assert.ok(e instanceof Error && /bad_arguments/.test(e.message) && !e.message.includes(SECRET));
    return true;
  });
});

test("an unreachable service and a wrong secret are clear errors that do not carry the secret", async (t) => {
  const down = createGitAgent({ client: createGitMcpClient({ url: "http://127.0.0.1:1/mcp", secret: SECRET }) });
  await assert.rejects(down.call({ operation: "list_repos" }, "internal:alice"), (e) => {
    assert.ok(e instanceof Error && /could not be reached/.test(e.message) && !e.message.includes(SECRET));
    return true;
  });
  const h = await service(t);
  const wrong = createGitAgent({
    client: createGitMcpClient({ url: `${h.server.url}/mcp`, secret: "not-the-secret-0123456789" }),
  });
  await assert.rejects(wrong.call({ operation: "list_repos" }, "internal:alice"), (e) => {
    assert.ok(e instanceof Error && !e.message.includes("not-the-secret"));
    return true;
  });
  assert.equal(h.calls.length, 0);
});

test("a service that adds a write-like tool, drops a tool or takes raw git arguments is not served, with no tool call sent", async (t) => {
  const drifted = [
    [...nine(), tool("push_branch")],
    nine().filter((entry) => entry.name !== "blame"),
    [...nine().filter((entry) => entry.name !== "list_repos"), tool("list_repos", { args: { type: "array" } })],
    [...nine(), tool("run_anything")],
  ];
  for (const tools of drifted) {
    const h = await service(t, { tools });
    await assert.rejects(h.agent.call({ operation: "list_repos" }, "internal:alice"), /tool contract/);
    assert.equal(toolCalls(h.server).length, 0);
  }
});

test("the contract is checked again after the interval: a drifting service is switched off and a repaired one serves again", async () => {
  let drifting = true;
  let verifies = 0;
  let calls = 0;
  let now = 1_000;
  const client: GitMcpClient = {
    verify: async () => {
      verifies++;
      if (drifting)
        throw new GitMcpContractError({ missing: [], forbidden: ["push_branch"], unexpected: [], rawInputs: [] });
    },
    call: async () => {
      calls++;
      return { ok: true };
    },
    checkUpdates: async () => {
      throw new Error("the agent must never poll");
    },
  };
  const agent = createGitAgent({ client, now: () => now, verifyEveryMs: 60_000 });
  await assert.rejects(agent.call({ operation: "list_repos" }, "internal:alice"), /switched off.*push_branch/);
  now += 30_000;
  await assert.rejects(agent.call({ operation: "list_repos" }, "internal:alice"), /switched off/);
  assert.equal(verifies, 1);
  drifting = false;
  now += 31_000;
  assert.deepEqual(JSON.parse(await agent.call({ operation: "list_repos" }, "internal:alice")), { ok: true });
  assert.equal(verifies, 2);
  await agent.call({ operation: "list_repos" }, "internal:alice");
  assert.equal(verifies, 2);
  assert.equal(calls, 2);
});

test("with the switch off there is no zq_git tool in any turn and nothing is requested", async (t) => {
  const h = await service(t);
  assert.equal(gitAgent(), undefined);
  const ref: ToolContextRef = { current: {} as ToolContext, scopeLabel: "personal:U1" };
  for (const readOnly of [false, true])
    assert.ok(!createAgentTools(ref, { readOnly }).some((entry) => entry.name === "zq_git"));
  assert.equal(h.server.requests.length, 0);
});

test("with the switch on the agent gets one zq_git tool, also in read-only turns, that runs the eight operations and nothing else", async (t) => {
  const h = await service(t);
  assert.equal(h.server.requests.length, 0);
  setGitAgent(h.agent);
  const ref: ToolContextRef = {
    current: { callZqGit: (input) => gitAgent()!.call(input, "internal:alice") } as ToolContext,
    scopeLabel: "personal:U1",
  };
  for (const readOnly of [false, true]) {
    const tools = createAgentTools(ref, { readOnly });
    assert.equal(tools.filter((entry) => entry.name === "zq_git").length, 1);
    assert.ok(!tools.some((entry) => entry.name.includes("check_updates")));
  }
  const zqGit = createAgentTools(ref, { readOnly: true }).find((entry) => entry.name === "zq_git")!;
  const run = (params: unknown) =>
    (zqGit.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)("c1", params);
  const schema = JSON.stringify(zqGit.parameters);
  assert.ok(!schema.includes("check_updates") && !schema.includes('"ack"'));
  assert.match(zqGit.description, /read-only/i);
  assert.match(zqGit.description, /pointer/);
  assert.match(zqGit.description, /truncated/);
  assert.match(zqGit.description, /suggestedKeyColumns/);

  const ok = await run({ operation: "list_commits", repo: "gameconfig", limit: 3 });
  assert.match(ok.content[0]!.text, /"name":"list_commits"/);
  const calledBefore = h.calls.length;
  for (const params of [{ operation: "check_updates" }, { operation: "list_repos", ack: [] }]) {
    const out = await run(params);
    assert.match(out.content[0]!.text, /^\[error\]/);
  }
  assert.equal(h.calls.length, calledBefore);
  assert.equal(toolCalls(h.server)[0]?.caller, "internal:alice");
});

test("the switch needs the service address and secret and nothing else enables it", () => {
  assert.equal(zqConfigFromEnv({}).gitAgent, false);
  assert.equal(zqConfigFromEnv(URL_ENV).gitAgent, false);
  assert.equal(zqConfigFromEnv({ ...URL_ENV, ZQ_GIT_AGENT: "1" }).gitAgent, true);
  assert.equal(zqConfigFromEnv({ ...URL_ENV, ZQ_GIT_AGENT: "0" }).gitAgent, false);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_GIT_AGENT: "1" }),
    /ZQ_GIT_AGENT needs ZQ_GIT_MCP_URL and ZQ_GIT_MCP_SECRET/,
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_AGENT: "1", ZQ_GIT_MCP_URL: URL_ENV.ZQ_GIT_MCP_URL }), /go together/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_AGENT: "1", ZQ_GIT_MCP_SECRET: SECRET }), /go together/);
});
