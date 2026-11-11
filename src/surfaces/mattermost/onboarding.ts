import { swallowAs, errMessage } from "../../util/errors.ts";
import { accessRequestCard, cardProps, settledProps } from "./cards.ts";
import { verifiedEmail, LINK_TOKEN_TTL_MS, type AccessRequest, type MattermostLink } from "./identity.ts";
import { wsEventSchema, type MattermostUser, type WsEvent } from "./protocol.ts";
import type { Runtime } from "./runtime.ts";
import type { Incoming, Inbound } from "./inbound.ts";

export interface AccessAdmin {
  orgAdmins(): Promise<string[]>;
  isOrgAdmin(email: string): Promise<boolean>;
  grant(email: string, by: string): Promise<void>;
}

export function createOnboarding(deps: { rt: Runtime; admin: AccessAdmin }) {
  const { rt } = deps;
  let inbound: Inbound | undefined;

  async function dm(
    user: MattermostUser,
    message: string,
    props?: Record<string, unknown>,
  ): Promise<string | undefined> {
    const channel = await rt.dmWith(user.id);
    const post = await rt.client.createPost({ channel_id: channel, message, ...(props ? { props } : {}) });
    return post.id;
  }

  async function noteInPlace(inc: Pick<Incoming, "post" | "kind">, message: string): Promise<void> {
    if (inc.kind === "dm") return;
    const root = inc.post.root_id || inc.post.id;
    await rt.client
      .ephemeral(inc.post.user_id, { channel_id: inc.post.channel_id, message, root_id: root })
      .catch(swallowAs("mattermost: onboarding ephemeral", undefined));
  }

  async function sendLink(user: MattermostUser, email: string): Promise<void> {
    const token = await rt.links.issueToken(user, email);
    const url = `${rt.config.linkUrl}?t=${encodeURIComponent(token)}`;
    const minutes = Math.round(LINK_TOKEN_TTL_MS / 60_000);
    await dm(
      user,
      [
        "👋 **Welcome to QM!** Before we start, connect your Mattermost account to your QM account. You only need to do this once.",
        "",
        `1. Open **[Connect to QM](${url})** (the link works for ${minutes} minutes and only once).`,
        `2. Sign in to QM with **${email}** — QM emails you a sign-in link.`,
        "3. Confirm the connection. I'll pick up your message right after.",
      ].join("\n"),
    );
  }

  async function notifyAdmins(request: AccessRequest): Promise<number> {
    const cards: Array<{ channelId: string; postId: string }> = [];
    for (const email of await deps.admin.orgAdmins()) {
      const admin = await rt.mmUserForPrincipal(email).catch(() => null);
      if (!admin) continue;
      try {
        const channel = await rt.dmWith(admin.id);
        const post = await rt.client.createPost({
          channel_id: channel,
          message: "",
          props: cardProps(accessRequestCard(request), rt.signer, rt.config.actionUrl),
        });
        cards.push({ channelId: channel, postId: post.id });
      } catch (e) {
        console.error(`[mattermost] couldn't notify admin ${email} about an access request: ${errMessage(e)}`);
      }
    }
    if (cards.length) await rt.links.noteAccessCards(request.email, [...(request.cards ?? []), ...cards]);
    return cards.length;
  }

  async function settleCards(request: AccessRequest, text: string): Promise<void> {
    for (const c of request.cards ?? []) {
      await rt.client
        .patchPost(c.postId, {
          message: "",
          props: settledProps({
            message: text,
            title: "QM access request",
            text,
            color: request.status === "approved" ? "#2eb67d" : "#8d8d8d",
          }),
        })
        .catch(swallowAs("mattermost: settle access card", undefined));
    }
  }

  return {
    attach(i: Inbound) {
      inbound = i;
    },
    async begin(author: MattermostUser, inc: Incoming, ev: WsEvent): Promise<void> {
      const email = verifiedEmail(author);
      if (!email) {
        await inbound?.reply(
          inc,
          "I can't set you up yet: your Mattermost account has no verified email address. Ask a Mattermost admin to verify it, then message me again.",
        );
        return;
      }
      await rt.links.holdTurn(author.id, { event: ev.event, data: ev.data, broadcast: ev.broadcast });
      if (await rt.admission.admitted(email)) {
        await sendLink(author, email);
        await noteInPlace(inc, "I sent you a direct message to get you connected to QM first.");
        return;
      }
      const existing = await rt.links.accessRequest(email);
      if (existing?.status === "denied") {
        await inbound?.reply(
          inc,
          "An admin declined QM access for your account. Contact your QM admin if you think this is a mistake.",
        );
        return;
      }
      const { request, notify } = await rt.links.requestAccess(author, email);
      const told = notify ? await notifyAdmins(request) : 1;
      const message = told
        ? "QM needs an admin's approval before you can use it. I've asked the QM admins — I'll message you here as soon as you're approved."
        : "QM needs an admin's approval before you can use it, but I couldn't reach a QM admin on Mattermost. Please ask your QM admin to approve you.";
      if (inc.kind === "dm") await inbound?.reply(inc, message);
      else {
        await dm(author, message).catch(swallowAs("mattermost: access notice", undefined));
        await noteInPlace(inc, "I sent you a direct message about getting access to QM.");
      }
    },
    async decide(email: string, approve: boolean, approver: MattermostUser): Promise<string> {
      const approverEmail = verifiedEmail(approver);
      if (!approverEmail || !(await deps.admin.isOrgAdmin(approverEmail)))
        throw new Error("Only a QM org admin can decide access requests.");
      const pending = await rt.links.accessRequest(email);
      if (!pending) throw new Error("That access request no longer exists.");
      if (pending.status !== "pending")
        return `Already ${pending.status}${pending.decidedBy ? ` by ${pending.decidedBy}` : ""}.`;
      if (approve) await deps.admin.grant(email, approverEmail);
      const decided = await rt.links.decideAccess(email, approve, approverEmail);
      if (!decided) return "Already decided.";
      const summary = approve
        ? `✅ Approved by @${approver.username} — ${decided.displayName} (${email}) can now use QM.`
        : `❌ Denied by @${approver.username} — ${decided.displayName} (${email}).`;
      await settleCards({ ...decided, cards: pending.cards ?? [] }, summary);
      const requester = await rt.user(decided.mmUserId).catch(() => null);
      if (requester) {
        if (approve)
          await sendLink(requester, email).catch(swallowAs("mattermost: send link after approval", undefined));
        else
          await dm(
            requester,
            "An admin declined your request to use QM. Contact your QM admin if you think this is a mistake.",
          ).catch(swallowAs("mattermost: deny notice", undefined));
      }
      return summary;
    },
    async linked(link: MattermostLink): Promise<void> {
      const user = await rt.user(link.mmUserId).catch(() => null);
      if (!user) return;
      rt.forgetUser(user.id);
      const held = await rt.links.releaseTurn(user.id);
      await dm(
        user,
        `✅ Connected! This Mattermost account is now linked to QM account **${link.email}**.${held ? " Picking up your message now…" : " Message me any time."}\n\n_Type \`unlink\` here to disconnect._`,
      ).catch(swallowAs("mattermost: link confirmation", undefined));
      if (!held || !inbound) return;
      const ev = wsEventSchema.safeParse(held);
      if (ev.success) await inbound.replay(ev.data).catch(swallowAs("mattermost: replay held message", undefined));
    },
  };
}

export type Onboarding = ReturnType<typeof createOnboarding>;
