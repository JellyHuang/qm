import assert from "node:assert/strict";
import { test } from "node:test";
import { McpContractError, assertToolContract, parseToolContract } from "../src/mcp/tool-contract.ts";
import {
  GIT_MCP_CONTRACT,
  GIT_MCP_TOOLS,
  GitMcpContractError,
  assertGitMcpListing,
} from "../src/zq/git-mcp/contract.ts";

const clean = () =>
  GIT_MCP_TOOLS.map((name) => ({
    name,
    inputSchema: { type: "object", properties: { repo: { type: "string" }, ref: { type: "string" } } },
  }));

function violation(tools: { name: string; inputSchema?: unknown }[]): GitMcpContractError {
  try {
    assertGitMcpListing(tools);
  } catch (e) {
    assert.ok(e instanceof GitMcpContractError);
    return e;
  }
  throw new Error("expected a contract violation");
}

test("the contract lists exactly the nine read tools and is accepted by the connector registration", () => {
  assert.deepEqual([...GIT_MCP_CONTRACT.required].sort(), [
    "blame",
    "check_updates",
    "diff_xlsx",
    "get_commit",
    "get_diff",
    "list_commits",
    "list_repos",
    "read_file",
    "search",
  ]);
  assert.notEqual(parseToolContract(JSON.parse(JSON.stringify(GIT_MCP_CONTRACT))), "invalid");
  assert.deepEqual(parseToolContract(JSON.parse(JSON.stringify(GIT_MCP_CONTRACT))), GIT_MCP_CONTRACT);
});

test("exactly the nine tools with plain inputs pass", () => {
  assertGitMcpListing(clean());
  assertToolContract("zq-git", clean(), GIT_MCP_CONTRACT);
});

test("a dropped tool fails loudly and names it", () => {
  const tools = clean().filter((tool) => tool.name !== "blame");
  assert.deepEqual(violation(tools).violation.missing, ["blame"]);
  assert.throws(() => assertToolContract("zq-git", tools, GIT_MCP_CONTRACT), McpContractError);
});

test("write, archive, bundle and clone like tools are forbidden whatever their other fields say", () => {
  for (const name of [
    "push",
    "push_branch",
    "write_file",
    "archive_repo",
    "bundle_repo",
    "clone_repo",
    "create_branch",
    "delete_branch",
    "merge_request",
    "update_ref",
    "commit_changes",
    "git_exec",
    "run_command",
  ]) {
    const found = violation([...clean(), { name }]);
    assert.deepEqual(found.violation.forbidden, [name], name);
    assert.throws(() => assertToolContract("zq-git", [...clean(), { name }], GIT_MCP_CONTRACT), McpContractError);
  }
});

test("any other new tool is unexpected, because the service must keep exactly its nine tools", () => {
  const found = violation([...clean(), { name: "sync_repository" }]);
  assert.deepEqual(found.violation.unexpected, ["sync_repository"]);
});

test("a tool that takes a url or raw git arguments is rejected", () => {
  for (const property of ["url", "remote", "args", "argv", "command", "git_args", "rawArgs"]) {
    const tools = clean().map((tool) =>
      tool.name === "read_file"
        ? { ...tool, inputSchema: { type: "object", properties: { [property]: { type: "string" } } } }
        : tool,
    );
    assert.deepEqual(violation(tools).violation.rawInputs, [{ tool: "read_file", property }], property);
  }
});
