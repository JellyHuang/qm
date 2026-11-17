import type { GitMcpClient } from "../git-mcp/client.ts";
import { PatchPackageError } from "./settings.ts";
import type { GitMcpDiffResult } from "./text.ts";

function asResult(body: Record<string, unknown>): GitMcpDiffResult {
  const files = body.files;
  if (typeof body.head !== "string" || !Array.isArray(files) || typeof body.diff !== "string")
    throw new PatchPackageError("bad_input", "get_diff did not return a diff for explicit paths");
  return {
    base: typeof body.base === "string" ? body.base : null,
    head: body.head,
    files: files as GitMcpDiffResult["files"],
    diff: body.diff,
    truncated: body.truncated === true,
  };
}

export async function fetchCompleteDiff(
  client: Pick<GitMcpClient, "call">,
  args: { repo: string; range: string; paths: readonly string[] },
  caller: string,
): Promise<GitMcpDiffResult> {
  if (args.paths.length === 0 || args.paths.some((path) => /[*?]/.test(path)))
    throw new PatchPackageError("bad_input", "give explicit file paths, without wildcards");
  const whole = asResult(await client.call("get_diff", { ...args, paths: [...args.paths] }, caller));
  if (!whole.truncated) return whole;
  if (args.paths.length === 1)
    throw new PatchPackageError(
      "truncated_diff",
      `the diff of ${args.paths[0]} is longer than one get_diff response; use the working copy route`,
    );
  const parts: GitMcpDiffResult[] = [];
  for (const path of args.paths) {
    const part = asResult(await client.call("get_diff", { ...args, paths: [path] }, caller));
    if (part.truncated)
      throw new PatchPackageError(
        "truncated_diff",
        `the diff of ${path} is longer than one get_diff response; use the working copy route`,
      );
    parts.push(part);
  }
  const first = parts[0] as GitMcpDiffResult;
  if (parts.some((part) => part.base !== first.base || part.head !== first.head))
    throw new PatchPackageError("bad_input", "the range moved while the diff was being collected");
  return {
    base: first.base,
    head: first.head,
    files: parts.flatMap((part) => part.files),
    diff: parts.map((part) => (part.diff === "" || part.diff.endsWith("\n") ? part.diff : `${part.diff}\n`)).join(""),
    truncated: false,
  };
}
