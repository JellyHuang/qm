import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errMessage } from "../../util/errors.ts";
import { text, type ToolKit } from "./kit.ts";

const DESCRIPTION = `Ask for execution orders (child work packages) to be added to a feature, or to an optimization order (优化单) that several people share, in OpenProject. It does not create anything: it checks the request with OpenProject (preview), then sends the requester a Mattermost card. Only the requester's own click on that card creates the orders, with the requester's own OpenProject login, and the card expires after 15 minutes.
Give the feature's current lock_version (read it from the feature first). Every order needs a type_key, a subject and a description: that person's own scope of work. Say why in reason.
If OpenProject refuses the request, its error code is returned: pass it on to the user as it is.`;

export function zqTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  const zqAddChildOrders = defineTool({
    name: "zq_add_child_orders",
    label: "zq_add_child_orders",
    description: DESCRIPTION,
    parameters: Type.Object({
      feature_id: Type.Number({ description: "The feature (or optimization order) work package id." }),
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
  return { zqAddChildOrders };
}
