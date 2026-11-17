import { contractViolation, type McpToolContract } from "../../mcp/tool-contract.ts";

export const GIT_MCP_TOOLS = [
  "list_repos",
  "list_commits",
  "get_commit",
  "get_diff",
  "read_file",
  "blame",
  "search",
  "diff_xlsx",
  "check_updates",
] as const;

export const GIT_MCP_CONTRACT: McpToolContract = {
  required: [...GIT_MCP_TOOLS],
  forbidden: [
    "push*",
    "write*",
    "archive*",
    "bundle*",
    "clone*",
    "delete*",
    "merge*",
    "create*",
    "update*",
    "remove*",
    "upload*",
    "commit_*",
    "fetch*",
    "pull*",
    "exec*",
    "run*",
    "git_*",
  ],
};

const RAW_INPUT = /^(url|uri|href|remote|origin|args|argv|command|cmd|git_args|raw_args|rawargs|options|flags)$/i;

interface GitMcpListedTool {
  name: string;
  inputSchema?: unknown;
}

interface GitMcpViolation {
  missing: string[];
  forbidden: string[];
  unexpected: string[];
  rawInputs: { tool: string; property: string }[];
}

export class GitMcpContractError extends Error {
  readonly violation: GitMcpViolation;
  constructor(violation: GitMcpViolation) {
    const parts = [
      ...(violation.missing.length ? [`missing tools: ${violation.missing.join(", ")}`] : []),
      ...(violation.forbidden.length ? [`forbidden tools: ${violation.forbidden.join(", ")}`] : []),
      ...(violation.unexpected.length ? [`unexpected tools: ${violation.unexpected.join(", ")}`] : []),
      ...(violation.rawInputs.length
        ? [
            `tools that take a url or raw git arguments: ${violation.rawInputs.map((r) => `${r.tool}.${r.property}`).join(", ")}`,
          ]
        : []),
    ];
    super(`the zq-git-mcp service does not match its tool contract (${parts.join("; ")})`);
    this.name = "GitMcpContractError";
    this.violation = violation;
  }
}

function propertiesOf(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const properties = (schema as { properties?: unknown }).properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}

export function assertGitMcpListing(tools: readonly GitMcpListedTool[]): void {
  const names = new Set(tools.map((tool) => tool.name));
  const known = new Set<string>(GIT_MCP_TOOLS);
  const byName = contractViolation(tools, GIT_MCP_CONTRACT);
  const rawInputs = tools.flatMap((tool) =>
    propertiesOf(tool.inputSchema)
      .filter((property) => RAW_INPUT.test(property))
      .map((property) => ({ tool: tool.name, property })),
  );
  const forbidden = byName?.forbidden ?? [];
  const unexpected = [...names].filter((name) => !known.has(name) && !forbidden.includes(name));
  if (byName || unexpected.length || rawInputs.length)
    throw new GitMcpContractError({ missing: byName?.missing ?? [], forbidden, unexpected, rawInputs });
}
