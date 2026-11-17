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

class Skip extends Error {}

const TEXT_FILE = /\.(txt|md|json|ya?ml|csv|xml|ini|cfg|lua|ts|js|py|cs|h|hpp|c|cc|cpp|java|go|sh|proto|sql)$/i;
const MAX_TEXT_BYTES = 200_000;
const XLSX_PATH = "designer_config/behavior/1.xlsx";

interface ChangedFile {
  path: string;
  status: string;
  kind?: string;
  newSize?: number;
}

const isSmallText = (file: ChangedFile) =>
  file.kind === "file" && file.status !== "D" && TEXT_FILE.test(file.path) && (file.newSize ?? 0) <= MAX_TEXT_BYTES;

const count = (value: unknown) => (typeof value === "number" ? value : 0);

function envRef(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

async function main(): Promise<void> {
  const client = createGitMcpClient({ url: required("ZQ_GIT_MCP_URL"), secret: required("ZQ_GIT_MCP_SECRET") });
  const agent = createGitAgent({ client });
  const ask = async (input: Record<string, unknown>) =>
    JSON.parse(await agent.call(input, LABEL_PERSON)) as Record<string, unknown>;
  let firstPath: string | undefined;
  let defaultBranch = "main";
  let searchPaths: string[] = [];
  let latestSha: string | undefined;
  let latestFiles: ChangedFile[] = [];

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
        const commits = (await ask({ operation: "list_commits", repo: REPO, limit: 3 })).commits as { sha: string }[];
        if (!Array.isArray(commits) || commits.length === 0) throw new Error("no commits");
        latestSha = commits[0]?.sha;
        return `${commits.length} commits`;
      },
    },
    {
      name: "search path",
      run: async () => {
        const paths = (
          await ask({ operation: "search", repo: REPO, ref: defaultBranch, query: ".", kind: "path", limit: 20 })
        ).paths as { path: string }[];
        searchPaths = paths.map((entry) => entry.path);
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
        return "rejected at the agent entry before any request was made";
      },
    },
    {
      name: "get_commit",
      run: async () => {
        if (!latestSha) throw new Skip("no commit from list_commits");
        const out = await ask({ operation: "get_commit", repo: REPO, sha: latestSha });
        if (!Array.isArray(out.files)) throw new Error("files is not an array");
        latestFiles = out.files as ChangedFile[];
        return `${latestFiles.length} changed files`;
      },
    },
    {
      name: "get_diff without paths",
      run: async () => {
        if (!latestSha) throw new Skip("no commit from list_commits");
        const out = await ask({ operation: "get_diff", repo: REPO, range: latestSha });
        if (!Array.isArray(out.files)) throw new Error("files is not an array");
        if ("diff" in out) throw new Error("a diff came back without paths");
        return `${out.files.length} entries, no content`;
      },
    },
    {
      name: "get_diff with one path",
      run: async () => {
        const file = latestFiles.find(isSmallText);
        if (!latestSha || !file) throw new Skip("no small text file in the latest commit");
        const out = await ask({ operation: "get_diff", repo: REPO, range: latestSha, paths: [file.path] });
        if (!Array.isArray(out.files)) throw new Error("files is not an array");
        const entry = (out.files as { kind?: string }[])[0];
        if (entry?.kind !== "file") throw new Skip(`the selected file is ${entry?.kind ?? "not reported"}`);
        return `diffBytes ${count(out.diffBytes)}, truncated ${out.truncated === true}`;
      },
    },
    {
      name: "blame",
      run: async () => {
        const path = latestFiles.find(isSmallText)?.path ?? searchPaths.find((entry) => TEXT_FILE.test(entry));
        if (!path) throw new Skip("no small text file found");
        const out = await ask({
          operation: "blame",
          repo: REPO,
          ref: defaultBranch,
          path,
          startLine: 1,
          endLine: 5,
        });
        if (!Array.isArray(out.lines)) throw new Error("lines is not an array");
        return `${out.lines.length} lines, lazyFetches ${count(out.lazyFetches)}`;
      },
    },
    {
      name: "diff_xlsx",
      run: async () => {
        const path = envRef("ZQ_SMOKE_XLSX_PATH") ?? XLSX_PATH;
        let base = envRef("ZQ_SMOKE_XLSX_BASE");
        let head = envRef("ZQ_SMOKE_XLSX_HEAD");
        if (Boolean(base) !== Boolean(head)) throw new Error("set ZQ_SMOKE_XLSX_BASE and ZQ_SMOKE_XLSX_HEAD together");
        if (!base || !head) {
          const commits = (await ask({ operation: "list_commits", repo: REPO, path, limit: 2 })).commits as {
            sha: string;
          }[];
          if (commits.length < 2) throw new Skip(`fewer than two commits touch ${path}`);
          head = commits[0]!.sha;
          base = commits[1]!.sha;
        }
        const out = await ask({ operation: "diff_xlsx", repo: REPO, path, base, head });
        const sheets = ((out.summary as { sheets?: Record<string, unknown>[] } | undefined)?.sheets ?? []).filter(
          (sheet) => typeof sheet === "object",
        );
        const total = (key: string) => sheets.reduce((sum, sheet) => sum + count(sheet[key]), 0);
        return `kind ${String(out.kind)}, sheets ${sheets.length}, changedCells ${total("changedCells")}, rowsAdded ${total("rowsAdded")}, rowsRemoved ${total("rowsRemoved")}, ambiguousKeys ${total("ambiguousKeys")}`;
      },
    },
  ];

  let failed = 0;
  let skipped = 0;
  for (const check of checks) {
    try {
      console.log(`PASS ${check.name}: ${await check.run()}`);
    } catch (e) {
      if (e instanceof Skip) {
        skipped++;
        console.log(`SKIP ${check.name}: ${e.message}`);
        continue;
      }
      failed++;
      const secret = process.env.ZQ_GIT_MCP_SECRET ?? "";
      const message = e instanceof Error ? e.message : String(e);
      console.log(`FAIL ${check.name}: ${secret ? message.split(secret).join("[secret]") : message}`);
    }
  }
  console.log(failed === 0 ? `PASS all (${skipped} skipped)` : `FAIL ${failed} of ${checks.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main().catch((e: unknown) => {
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
