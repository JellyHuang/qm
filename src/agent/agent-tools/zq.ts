import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errMessage } from "../../util/errors.ts";
import { GIT_AGENT_OPERATIONS } from "../../zq/git-mcp/agent.ts";
import { text, type ToolKit } from "./kit.ts";

const DESCRIPTION = `Ask for execution orders (child work packages) to be added to a feature in OpenProject. It does not create anything: it checks the request with OpenProject (preview), then sends the requester a Mattermost card. Only the requester's own click on that card creates the orders, with the requester's own OpenProject login, and the card expires after 15 minutes.
Give the feature's current lock_version (read it from the feature first). Every order needs a type_key, a subject and a description: that person's own scope of work. Say why in reason.
If OpenProject refuses the request, its error code is returned: pass it on to the user as it is.`;

const GIT_DESCRIPTION = `Read the seven GitLab repositories through QM's read-only git service. Read-only: nothing can be changed, pushed or fetched into GitLab, and the tool never needs a url or a git command. Set operation, then the arguments that operation needs; other arguments are refused.
- list_repos: the repositories, default branches and service health. No arguments.
- list_commits: repo; optional branch, path, author, since, until (ISO dates), limit. Newest first, metadata only.
- get_commit: repo, sha. Message, parents and the changed file list.
- get_diff: repo, range (a commit, or base..head); without paths only the changed files, with paths (literal or globs) a unified diff.
- read_file: repo, ref, path; optional startLine and endLine, or offset and length for binary files. LFS files return only a pointer (oid and size), never content. Submodules are reported, never fetched.
- blame: repo, ref, path, startLine, endLine.
- search: repo, ref, query, kind (message, path or content); content search needs pathGlob; optional limit, author, regex, ignoreCase, context.
- diff_xlsx: repo, path, base and head refs (all required) for a cell-level comparison of one .xlsx file; optional sheets, offset, limit. If a sheet reports ambiguous keys it also gives suggestedKeyColumns: you may retry yourself with overrides {"<sheet>": {"keyColumns": [...], "headerRow": n}}; it is never retried automatically.
Very large results are cut and marked "truncated": true; when you see it, narrow the request (a path, a line range, a smaller limit, paging with offset) instead of repeating it. Errors come back with the service's error code; pass them on as they are.`;

export function zqTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  const zqAddChildOrders = defineTool({
    name: "zq_add_child_orders",
    label: "zq_add_child_orders",
    description: DESCRIPTION,
    parameters: Type.Object({
      feature_id: Type.Number({ description: "The feature work package id." }),
      lock_version: Type.Number({ description: "The feature's current lockVersion." }),
      reason: Type.String({ minLength: 1, description: "Why the orders are needed." }),
      source_ref: Type.Optional(Type.String({ description: "Where the request came from, e.g. a thread link." })),
      children: Type.Array(
        Type.Object({
          type_key: Type.String({ minLength: 1 }),
          subject: Type.String({ minLength: 1 }),
          description: Type.String({ minLength: 1, description: "This person's own scope of work." }),
          assignee_id: Type.Optional(Type.String({ description: "Suggested executor's OpenProject user id." })),
          fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        { minItems: 1, maxItems: 50 },
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "zq_add_child_orders", feature: params.feature_id });
      try {
        if (!tc.proposeZqChildren) throw new Error("adding execution orders is not available in this turn");
        const out = await tc.proposeZqChildren({
          featureId: params.feature_id,
          lockVersion: params.lock_version,
          reason: params.reason,
          ...(params.source_ref ? { sourceRef: params.source_ref } : {}),
          children: params.children.map((c) => ({
            typeKey: c.type_key,
            subject: c.subject,
            description: c.description,
            ...(c.assignee_id ? { assigneeId: c.assignee_id } : {}),
            ...(c.fields ? { fields: c.fields } : {}),
          })),
        });
        return recordResult(callId, { tool: "zq_add_child_orders", feature: params.feature_id }, text(out));
      } catch (e) {
        return recordResult(
          callId,
          { tool: "zq_add_child_orders", feature: params.feature_id, failed: true },
          text(`[error] ${errMessage(e)}`),
          true,
        );
      }
    },
  });
  const optionalString = () => Type.Optional(Type.String());
  const optionalNumber = () => Type.Optional(Type.Number());
  const zqGit = defineTool({
    name: "zq_git",
    label: "zq_git",
    description: GIT_DESCRIPTION,
    parameters: Type.Object({
      operation: Type.Union(GIT_AGENT_OPERATIONS.map((operation) => Type.Literal(operation))),
      repo: optionalString(),
      ref: optionalString(),
      sha: optionalString(),
      range: optionalString(),
      base: optionalString(),
      head: optionalString(),
      branch: optionalString(),
      path: optionalString(),
      paths: Type.Optional(Type.Array(Type.String())),
      pathGlob: optionalString(),
      query: optionalString(),
      kind: Type.Optional(Type.Union([Type.Literal("message"), Type.Literal("path"), Type.Literal("content")])),
      author: optionalString(),
      since: optionalString(),
      until: optionalString(),
      limit: optionalNumber(),
      offset: optionalNumber(),
      length: optionalNumber(),
      startLine: optionalNumber(),
      endLine: optionalNumber(),
      regex: Type.Optional(Type.Boolean()),
      ignoreCase: Type.Optional(Type.Boolean()),
      context: optionalNumber(),
      sheets: Type.Optional(Type.Array(Type.String())),
      overrides: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({ headerRow: optionalNumber(), keyColumns: Type.Optional(Type.Array(Type.String())) }),
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const summary = { tool: "zq_git", operation: params.operation, ...(params.repo ? { repo: params.repo } : {}) };
      await recordCall(callId, summary);
      try {
        if (!tc.callZqGit) throw new Error("git access is not available in this turn");
        return recordResult(callId, summary, text(await tc.callZqGit(params)));
      } catch (e) {
        return recordResult(callId, { ...summary, failed: true }, text(`[error] ${errMessage(e)}`), true);
      }
    },
  });
  return { zqAddChildOrders, zqGit };
}
