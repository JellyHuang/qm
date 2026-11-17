import { blame } from "./blame.ts";
import { getCommit } from "./get-commit.ts";
import { getDiff } from "./get-diff.ts";
import { listCommits } from "./list-commits.ts";
import { listRepos } from "./list-repos.ts";
import { readFile } from "./read-file.ts";
import type { ToolDef } from "./types.ts";

export const TOOLS: readonly ToolDef[] = [listRepos, listCommits, getCommit, readFile, getDiff, blame];
