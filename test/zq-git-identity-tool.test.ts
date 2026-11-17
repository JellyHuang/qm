import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createToolContext, type ToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId } from "../src/types.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorMapping } from "../src/zq/git-mcp/author-mapping.ts";
import { setZqGitIdentity } from "../src/zq/git-mcp/identity.ts";
import { memoryMap } from "./support/memory-map.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

const ENV = {
  ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp",
  ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789",
  ZQ_GIT_POLL: "1",
  ZQ_GIT_AUTHOR_MAPPING: "1",
  ZQ_GIT_AUTHOR_BIND: "1",
};

function service() {
  const tables = new Map<string, Map<string, unknown>>();
  const mapping = createAuthorMapping({
    config: zqConfigFromEnv(ENV).gitAuthors,
    map: <T>(table: string): DurableMap<T> => {
      if (!tables.has(table)) tables.set(table, new Map());
      return memoryMap<T>(tables.get(table) as Map<string, T>);
    },
  })!;
  setZqGitIdentity(mapping.identity);
  return mapping;
}

function ctxFor(extra: Partial<ToolContextDeps> = {}): ToolContext {
  const actor = extra.createdBy ?? "p-alice";
  return createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => handle,
    writableScopeId: scopeId("personal", actor),
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: actor,
    humanTurn: true,
    audienceScopeId: scopeId("personal", actor),
    ...extra,
  });
}

afterEach(() => setZqGitIdentity(undefined));

test("self operations act on the authenticated actor, never on a person argument", async () => {
  const mapping = service();
  const alice = ctxFor({ createdBy: "p-alice" });
  assert.match(await alice.callZqGitIdentity!({ operation: "bind", names: ["Alice Example"] }), /bound/);
  await assert.rejects(
    alice.callZqGitIdentity!({ operation: "bind", names: ["Other Name"], person: "p-bob" }),
    /only for administrators/,
  );
  const row = await mapping.aliases.get("alice example");
  assert.equal(row?.kind === "person" && row.personId, "p-alice");
  assert.equal(await mapping.aliases.get("other name"), null);
  const bob = ctxFor({ createdBy: "p-bob" });
  assert.match(await bob.callZqGitIdentity!({ operation: "list" }), /You have no git names bound/);
});

test("turns that are not human-initiated and actors QM cannot attest cannot use it", async () => {
  service();
  await assert.rejects(
    ctxFor({ humanTurn: false }).callZqGitIdentity!({ operation: "bind", names: ["x"] }),
    /conversation with a person/,
  );
  await assert.rejects(ctxFor({ createdBy: "" }).callZqGitIdentity!({ operation: "list" }), /signed-in person/);
});

test("administrator operations need the admin flag and the administrator's own private conversation", async () => {
  const mapping = service();
  const admin = { call: async () => ({}) as never, operationsAvailable: true };
  const args = { operation: "bind_for", person: "p-bob", names: ["Bob Example"] } as const;
  await assert.rejects(ctxFor({ createdBy: "p-pm" }).callZqGitIdentity!(args), /identity administrators/);
  await assert.rejects(
    ctxFor({ createdBy: "p-pm", admin, audienceScopeId: scopeId("channel", "C1") }).callZqGitIdentity!(args),
    /private conversation/,
  );
  assert.match(await ctxFor({ createdBy: "p-pm", admin }).callZqGitIdentity!(args), /bound/);
  const row = await mapping.aliases.get("bob example");
  assert.equal(row?.kind === "person" && row.personId, "p-bob");
  assert.equal(row?.addedBy, "p-pm");
});

test("without the service registered the context says names are not enabled", async () => {
  await assert.rejects(ctxFor().callZqGitIdentity!({ operation: "list" }), /not enabled/);
});

test("the tool is offered only when the service is registered and never in read-only turns", () => {
  const names = (opts?: { readOnly?: boolean }) =>
    new Set(createAgentTools({ current: ctxFor() }, opts).map((tool) => tool.name));
  assert.ok(!names().has("zq_git_identity"));
  service();
  assert.ok(names().has("zq_git_identity"));
  assert.ok(!names({ readOnly: true }).has("zq_git_identity"));
  setZqGitIdentity(undefined);
  assert.ok(!names().has("zq_git_identity"));
});

test("the tool runs the operation through the context and reports a refusal as an error text", async () => {
  service();
  const tool = createAgentTools({ current: ctxFor() }).find((t) => t.name === "zq_git_identity")!;
  const run = async (params: Record<string, unknown>) =>
    (
      (await tool.execute("call", params as never, undefined, undefined, {} as never)) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text;
  assert.match(await run({ operation: "bind", names: ["Alice Example"] }), /git config user\.name/);
  assert.match(await run({ operation: "list" }), /Alice Example/);
  assert.match(await run({ operation: "ignore_list" }), /^\[error\] only identity administrators/);
});
