import { z } from "zod";
import { defineTool } from "./types.ts";

export const listRepos = defineTool({
  name: "list_repos",
  description:
    "List the seven readable repositories with their default branch, last fetch time, clone size on disk and the blob cache use.",
  input: z.strictObject({}),
  async run(ctx) {
    return { repos: await ctx.repos.list(), cache: ctx.cache.usage(), ...ctx.auditHealth(), truncated: false };
  },
});
