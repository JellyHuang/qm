import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject } from "typebox";
import { errMessage } from "../../util/errors.ts";
import type { GitReadonly } from "../../zq/git/readonly.ts";
import { GIT_REPOS } from "../../zq/git/validate.ts";
import { text, type ToolKit } from "./kit.ts";

const REPO = Type.Unsafe<(typeof GIT_REPOS)[number]>({
  type: "string",
  enum: [...GIT_REPOS],
  description: "Which repository to read.",
});
const REF = Type.String({ minLength: 1, description: "Branch name, tag or commit sha." });
const PATH = Type.String({ minLength: 1, description: "Repository-relative file path." });
const NOTE =
  "Read-only view of QM's local copy of a GitLab repository. Output is capped; a cut is reported as truncated. Calls are rate limited and audited.";

export function gitTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;

  function gitTool<P extends TObject>(
    name: string,
    description: string,
    parameters: P,
    run: (git: GitReadonly, principal: string, params: Static<P>) => Promise<unknown>,
  ) {
    return defineTool({
      name,
      label: name,
      description: `${description} ${NOTE}`,
      parameters,
      async execute(callId, params) {
        const tc = ref.current;
        if (!tc) return text("[error] no active tool context");
        const summary = { tool: name, repo: (params as { repo?: string }).repo };
        await recordCall(callId, summary);
        try {
          if (!tc.gitCall) throw new Error("repository reading is not available in this turn");
          const out = await tc.gitCall((git, principal) => run(git, principal, params as Static<P>));
          return recordResult(callId, summary, text(JSON.stringify(out)));
        } catch (e) {
          return recordResult(callId, { ...summary, failed: true }, text(`[error] ${errMessage(e)}`), true);
        }
      },
    });
  }

  const gitRecentCommits = gitTool(
    "git_recent_commits",
    "List recent commits of a repository, with author, date, subject and the files each changed.",
    Type.Object({
      repo: REPO,
      branch: Type.Optional(Type.String({ minLength: 1, description: "Branch; defaults to the default branch." })),
      since: Type.Optional(Type.String({ description: "ISO date or datetime; only commits after it." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    (git, principal, p) => git.recentCommits(principal, p.repo, p),
  );
  const gitCommit = gitTool(
    "git_commit",
    "Show one commit: message, author, committer, parents and per-file stats.",
    Type.Object({ repo: REPO, sha: Type.String({ minLength: 4, description: "Commit sha." }) }),
    (git, principal, p) => git.commit(principal, p.repo, p.sha),
  );
  const gitDiff = gitTool(
    "git_diff",
    "Show the unified diff of a commit, or of a range written base..head, optionally limited to one path.",
    Type.Object({
      repo: REPO,
      target: Type.String({ minLength: 1, description: "A commit sha, or base..head." }),
      path: Type.Optional(PATH),
    }),
    (git, principal, p) => git.diff(principal, p.repo, p.target, p.path),
  );
  const gitFileAt = gitTool(
    "git_file_at",
    "Read the text of one file at a ref. Binary files return their size and object id only.",
    Type.Object({ repo: REPO, ref: REF, path: PATH }),
    (git, principal, p) => git.fileAt(principal, p.repo, p.ref, p.path),
  );
  const gitBlame = gitTool(
    "git_blame",
    "Show who last changed each line in a range of a file at a ref.",
    Type.Object({
      repo: REPO,
      ref: REF,
      path: PATH,
      start: Type.Integer({ minimum: 1 }),
      end: Type.Integer({ minimum: 1 }),
    }),
    (git, principal, p) => git.blame(principal, p.repo, p.ref, p.path, p.start, p.end),
  );
  const gitBranches = gitTool(
    "git_branches",
    "List branches with their tip sha and date, newest first, optionally filtered by a glob pattern.",
    Type.Object({ repo: REPO, pattern: Type.Optional(Type.String({ minLength: 1 })) }),
    (git, principal, p) => git.branches(principal, p.repo, p.pattern),
  );
  return { gitReadTools: [gitRecentCommits, gitCommit, gitDiff, gitFileAt, gitBlame, gitBranches] };
}
