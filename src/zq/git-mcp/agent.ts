import { z } from "zod";
import { attestableActor, canonicalPerson } from "../../directory/person.ts";
import { isSystemActor } from "../../types.ts";
import { GitMcpContractError } from "./contract.ts";
import { GitMcpUnreachable, type GitMcpClient } from "./client.ts";

const VERIFY_EVERY_MS = 5 * 60_000;
const MAX_LABEL = 64;
const GIT_JOB_LABEL = "qm-job";
const GIT_UNATTESTED_LABEL = "qm-unattested";

const GIT_OPERATION_ARGS = {
  list_repos: z.strictObject({}),
  list_commits: z.strictObject({
    repo: z.string(),
    branch: z.string().optional(),
    path: z.string().optional(),
    author: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().optional(),
  }),
  get_commit: z.strictObject({ repo: z.string(), sha: z.string() }),
  get_diff: z.strictObject({ repo: z.string(), range: z.string(), paths: z.array(z.string()).optional() }),
  read_file: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    offset: z.number().optional(),
    length: z.number().optional(),
  }),
  blame: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  search: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    query: z.string(),
    kind: z.enum(["message", "path", "content"]),
    pathGlob: z.string().optional(),
    limit: z.number().optional(),
    author: z.string().optional(),
    regex: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    context: z.number().optional(),
  }),
  diff_xlsx: z.strictObject({
    repo: z.string(),
    path: z.string(),
    base: z.string(),
    head: z.string(),
    sheets: z.array(z.string()).optional(),
    overrides: z
      .record(
        z.string(),
        z.strictObject({ headerRow: z.number().optional(), keyColumns: z.array(z.string()).optional() }),
      )
      .optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
};

export type GitAgentOperation = keyof typeof GIT_OPERATION_ARGS;

export const GIT_AGENT_OPERATIONS = Object.keys(GIT_OPERATION_ARGS) as GitAgentOperation[];

function gitCallerLabel(principalId: string | undefined): string {
  if (!principalId || isSystemActor(principalId)) return GIT_JOB_LABEL;
  const person = attestableActor(canonicalPerson(principalId));
  return person ? person.slice(0, MAX_LABEL) : GIT_UNATTESTED_LABEL;
}

export interface GitAgent {
  call(input: Record<string, unknown>, principalId: string | undefined): Promise<string>;
}

export function createGitAgent(deps: { client: GitMcpClient; now?: () => number; verifyEveryMs?: number }): GitAgent {
  const now = deps.now ?? Date.now;
  const verifyEveryMs = deps.verifyEveryMs ?? VERIFY_EVERY_MS;
  let checkedAt: number | undefined;
  let disabled: string | undefined;
  let pending: Promise<void> | undefined;

  function verified(): Promise<void> {
    if (pending) return pending;
    if (checkedAt !== undefined && now() - checkedAt < verifyEveryMs)
      return disabled ? Promise.reject(new Error(disabled)) : Promise.resolve();
    const run = deps.client.verify().then(
      () => {
        checkedAt = now();
        disabled = undefined;
      },
      (e: unknown) => {
        if (!(e instanceof GitMcpContractError)) {
          checkedAt = undefined;
          throw e;
        }
        checkedAt = now();
        disabled = `zq_git is switched off until the git service matches its tool contract again: ${e.message}`;
        throw new Error(disabled);
      },
    );
    pending = run.finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return {
    async call(input, principalId) {
      const { operation, ...args } = input;
      if (typeof operation !== "string" || !Object.hasOwn(GIT_OPERATION_ARGS, operation))
        throw new Error(`operation must be one of ${GIT_AGENT_OPERATIONS.join(", ")}`);
      const parsed = GIT_OPERATION_ARGS[operation as GitAgentOperation].safeParse(args);
      if (!parsed.success)
        throw new Error(
          `${operation}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`,
        );
      try {
        await verified();
        return JSON.stringify(
          await deps.client.call(operation, parsed.data as Record<string, unknown>, gitCallerLabel(principalId)),
        );
      } catch (e) {
        if (e instanceof GitMcpUnreachable)
          throw new Error(`the git service could not be reached: ${e.message}`, { cause: e });
        throw e;
      }
    },
  };
}

let current: GitAgent | undefined;

export function setGitAgent(agent: GitAgent | undefined): void {
  current = agent;
}

export function gitAgent(): GitAgent | undefined {
  return current;
}
