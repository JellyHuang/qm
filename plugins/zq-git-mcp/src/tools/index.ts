import { getCommit } from "./get-commit.ts";
import { listCommits } from "./list-commits.ts";
import { listRepos } from "./list-repos.ts";
import type { ToolDef } from "./types.ts";

export const TOOLS: readonly ToolDef[] = [listRepos, listCommits, getCommit];
