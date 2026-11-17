import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errMessage } from "../../util/errors.ts";
import { GIT_NAME_HINT, IDENTITY_OPERATIONS, MAX_NAMES_PER_CALL } from "../../zq/git-mcp/identity.ts";
import { text, type ToolKit } from "./kit.ts";

const DESCRIPTION = `Ask for execution orders (child work packages) to be added to a feature in OpenProject. It does not create anything: it checks the request with OpenProject (preview), then sends the requester a Mattermost card. Only the requester's own click on that card creates the orders, with the requester's own OpenProject login, and the card expires after 15 minutes.
Give the feature's current lock_version (read it from the feature first). Every order needs a type_key, a subject and a description: that person's own scope of work. Say why in reason.
If OpenProject refuses the request, its error code is returned: pass it on to the user as it is.`;

const IDENTITY_DESCRIPTION = `Tell QM which git author names are yours, so commits under those names are attributed to you. ${GIT_NAME_HINT}
bind: your own names (1 to ${MAX_NAMES_PER_CALL}), optionally with email, which then must equal the commit author email for the name to match. list: your own names. unbind: remove one of your own names. These always act on you, never on anyone else.
A name that someone else holds is refused: say what the reply says and do not guess who holds it.
Administrators only (in their own private conversation): bind_for, unbind_for, depart, undepart (person), ignore_add, ignore_list, ignore_remove, ignore_import (names QM must not notify anyone about, with reason automation or external; import is a dry run until apply is true), list_unmapped.`;

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
  const zqGitIdentity = defineTool({
    name: "zq_git_identity",
    label: "zq_git_identity",
    description: IDENTITY_DESCRIPTION,
    parameters: Type.Object({
      operation: Type.Union(IDENTITY_OPERATIONS.map((operation) => Type.Literal(operation))),
      names: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_NAMES_PER_CALL })),
      name: Type.Optional(
        Type.String({ minLength: 1, description: "One git author name (unbind, ignore operations)." }),
      ),
      email: Type.Optional(Type.String({ description: "Optional author email condition." })),
      person: Type.Optional(Type.String({ description: "Administrators only: the person's principal id." })),
      reason: Type.Optional(Type.String({ description: "ignore_add and ignore_list: automation or external." })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("ignored")])),
      entries: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1 }),
            email: Type.Optional(Type.String()),
            reason: Type.String({ description: "automation or external" }),
          }),
          { minItems: 1, maxItems: 500 },
        ),
      ),
      apply: Type.Optional(Type.Boolean({ description: "ignore_import: false (default) only previews." })),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "zq_git_identity", operation: params.operation });
      try {
        if (!tc.callZqGitIdentity) throw new Error("git author names are not available in this turn");
        const out = await tc.callZqGitIdentity(params);
        return recordResult(callId, { tool: "zq_git_identity", operation: params.operation }, text(out));
      } catch (e) {
        return recordResult(
          callId,
          { tool: "zq_git_identity", operation: params.operation, failed: true },
          text(`[error] ${errMessage(e)}`),
          true,
        );
      }
    },
  });
  return { zqAddChildOrders, zqGitIdentity };
}
