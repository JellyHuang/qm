import { z } from "zod";
import type { KeychainApprovals } from "../../credentials/keychain-approval.ts";
import { decideDeploymentAccess } from "../../slack/deploy-access.ts";
import { samePerson } from "../../directory/person.ts";
import type { TurnRequest } from "../../types.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { approvalDecision, keychainCard, settledProps, cardProps } from "./cards.ts";
import type { LivePresenter } from "./live.ts";
import type { Onboarding } from "./onboarding.ts";
import { parseTarget, postIdOf, SURFACE } from "./protocol.ts";
import type { Runtime } from "./runtime.ts";

const actionBody = z.object({
  user_id: z.string(),
  user_name: z.string().optional(),
  channel_id: z.string().optional(),
  post_id: z.string().optional(),
  context: z.unknown(),
});

export interface ActionResponse {
  update?: { message: string; props?: Record<string, unknown> };
  ephemeral_text?: string;
}

function settled(text: string, color = "#8d8d8d"): ActionResponse {
  return { update: { message: "", props: settledProps({ message: text, text, color }) } };
}

export type ZqDecision = (
  op: "report" | "link" | "children" | "daily" | "onboard",
  id: string,
  approve: boolean,
  clickerMmUserId: string,
) => Promise<string>;

export function createActions(deps: {
  rt: Runtime;
  live: LivePresenter;
  onboarding: Onboarding;
  keychainApprovals?: KeychainApprovals;
  zqDecision?: ZqDecision;
}) {
  const { rt, live } = deps;
  const busy = new Set<string>();

  async function resumeApproval(
    requestId: string,
    choice: "once" | "session" | "always" | "deny",
    clickerId: string,
  ): Promise<ActionResponse> {
    const stored = await rt.app.getApproval(requestId);
    if (!stored?.request)
      return settled("_That approval request expired or was withdrawn — ask again when you're ready._");
    const clicker = await rt.user(clickerId);
    const actor = await rt.actorFor(clicker);
    const requester = stored.request.actor.externalId;
    if (!actor || !samePerson(actor.externalId, requester))
      return { ephemeral_text: "Only the person who asked for this can approve or deny it." };
    if (busy.has(requestId)) return { ephemeral_text: "This approval is being resolved right now — give it a moment." };
    busy.add(requestId);
    try {
      const {
        surface: _surface,
        async: _async,
        idempotencyKey: _idempotencyKey,
        redeliveryKey: _redeliveryKey,
        approval: _approval,
        ...turn
      } = stored.request as TurnRequest & { relayInput?: unknown };
      delete (turn as { relayInput?: unknown }).relayInput;
      const approval = { requestId, approved: choice !== "deny", ...(choice !== "deny" ? { scope: choice } : {}) };
      const result = await rt.app.turn({ ...turn, surface: SURFACE, actor, approval, async: true } as TurnRequest);
      if (result.status === "queued" && result.runId && !result.steered && turn.deliveryTarget) {
        const target = parseTarget(turn.deliveryTarget);
        const origin = turn.origin?.kind === "human" ? turn.origin.messageTs : undefined;
        const triggerPostId = (origin ? postIdOf(origin) : null) ?? target?.root;
        if (target && triggerPostId)
          await live
            .begin(
              result.runId,
              { channel: target.channel, ...(target.root ? { root: target.root } : {}), triggerPostId },
              { placeholder: true },
            )
            .catch(swallowAs("mattermost: approval live", undefined));
      }
      if (result.status === "pending_approval")
        return { ephemeral_text: result.reason ?? "This conversation is still waiting on another approval." };
      return settled(approvalDecision(choice, clicker.username), choice === "deny" ? "#8d8d8d" : "#2eb67d");
    } finally {
      busy.delete(requestId);
    }
  }

  async function handle(rawBody: string): Promise<{ status: number; body: ActionResponse | { error: string } }> {
    let parsed;
    try {
      parsed = actionBody.safeParse(JSON.parse(rawBody));
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (!parsed.success) return { status: 400, body: { error: "bad_request" } };
    const payload = rt.signer.open(parsed.data.context);
    if (!payload) return { status: 200, body: { ephemeral_text: "This button has expired. Ask me again." } };
    const clickerId = parsed.data.user_id;
    try {
      switch (payload.k) {
        case "approval":
          return { status: 200, body: await resumeApproval(payload.requestId, payload.choice, clickerId) };
        case "keychain": {
          if (!deps.keychainApprovals)
            return { status: 200, body: { ephemeral_text: "Credential approvals aren't available." } };
          const actor = await rt.actorFor(await rt.user(clickerId));
          if (!actor)
            return { status: 200, body: { ephemeral_text: "Connect your account to QM first — message me." } };
          const view = await deps.keychainApprovals.decide(payload.askId, actor, payload.choice);
          const card = keychainCard(view);
          return {
            status: 200,
            body: { update: { message: "", props: cardProps(card, rt.signer, rt.config.actionUrl) } },
          };
        }
        case "deploy": {
          const actor = await rt.actorFor(await rt.user(clickerId));
          if (!actor)
            return { status: 200, body: { ephemeral_text: "Connect your account to QM first — message me." } };
          const text = await decideDeploymentAccess(rt.app, rt.identity, payload.value, actor, payload.approve);
          return { status: 200, body: settled(text, payload.approve ? "#2eb67d" : "#8d8d8d") };
        }
        case "zq": {
          if (!deps.zqDecision) return { status: 200, body: { ephemeral_text: "这个功能没有开启。" } };
          const text = await deps.zqDecision(payload.op, payload.id, payload.approve, clickerId);
          return { status: 200, body: settled(text, payload.approve ? "#2eb67d" : "#8d8d8d") };
        }
        case "access": {
          const text = await deps.onboarding.decide(payload.email, payload.approve, await rt.user(clickerId));
          return { status: 200, body: settled(text, payload.approve ? "#2eb67d" : "#8d8d8d") };
        }
      }
    } catch (e) {
      console.error(`[mattermost] action ${payload.k} failed: ${errMessage(e)}`);
      return { status: 200, body: { ephemeral_text: errMessage(e) } };
    }
  }

  return { handle };
}
