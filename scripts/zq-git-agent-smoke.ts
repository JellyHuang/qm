import { GIT_AGENT_OPERATIONS, createGitAgent } from "../src/zq/git-mcp/agent.ts";
import { createGitMcpClient } from "../src/zq/git-mcp/client.ts";

const REPO = "gameconfig";
const LABEL_PERSON = "internal:smoke";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type Check = { name: string; run: () => Promise<string> };

async function main(): Promise<void> {
  const client = createGitMcpClient({ url: required("ZQ_GIT_MCP_URL"), secret: required("ZQ_GIT_MCP_SECRET") });
  const agent = createGitAgent({ client });
  const ask = async (input: Record<string, unknown>) =>
    JSON.parse(await agent.call(input, LABEL_PERSON)) as Record<string, unknown>;
  let firstPath: string | undefined;
  let defaultBranch = "main";

  const checks: Check[] = [
    {
      name: "tool contract",
      run: async () => {
        await client.verify();
        return "verified";
      },
    },
    {
      name: "operation list",
      run: async () => {
        const names: readonly string[] = GIT_AGENT_OPERATIONS;
        if (names.length !== 8 || names.includes("check_updates")) throw new Error("unexpected operation list");
        return `${names.length} operations, no check_updates`;
      },
    },
    {
      name: "list_repos",
      run: async () => {
        const repos = (await ask({ operation: "list_repos" })).repos as { name: string; defaultBranch: string }[];
        defaultBranch = repos.find((r) => r.name === REPO)?.defaultBranch ?? defaultBranch;
        if (repos.length === 0) throw new Error("no repositories");
        return `${repos.length} repositories`;
      },
    },
    {
      name: "list_commits",
      run: async () => {
        const commits = (await ask({ operation: "list_commits", repo: REPO, limit: 3 })).commits as unknown[];
        if (!Array.isArray(commits) || commits.length === 0) throw new Error("no commits");
        return `${commits.length} commits`;
      },
    },
    {
      name: "search path",
      run: async () => {
        const paths = (
          await ask({ operation: "search", repo: REPO, ref: defaultBranch, query: ".", kind: "path", limit: 20 })
        ).paths as { path: string }[];
        firstPath = paths[0]?.path;
        if (!firstPath) throw new Error("no paths");
        return `${paths.length} paths`;
      },
    },
    {
      name: "read_file",
      run: async () => {
        if (!firstPath) throw new Error("no path to read");
        const out = await ask({
          operation: "read_file",
          repo: REPO,
          ref: defaultBranch,
          path: firstPath,
          startLine: 1,
          endLine: 5,
        });
        return `${Object.keys(out).length} fields`;
      },
    },
    {
      name: "forged check_updates is refused",
      run: async () => {
        const refused = await agent.call({ operation: "check_updates" }, LABEL_PERSON).then(
          () => false,
          () => true,
        );
        if (!refused) throw new Error("check_updates was accepted");
        return "refused";
      },
    },
  ];

  let failed = 0;
  for (const check of checks) {
    try {
      console.log(`PASS ${check.name}: ${await check.run()}`);
    } catch (e) {
      failed++;
      const secret = process.env.ZQ_GIT_MCP_SECRET ?? "";
      const message = e instanceof Error ? e.message : String(e);
      console.log(`FAIL ${check.name}: ${secret ? message.split(secret).join("[secret]") : message}`);
    }
  }
  console.log(failed === 0 ? "PASS all" : `FAIL ${failed} of ${checks.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main().catch((e: unknown) => {
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
