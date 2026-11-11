import { createHash, randomBytes } from "node:crypto";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { IdentityService } from "../../identity/identity-service.ts";
import { externalMemberActive } from "../../identity/external-members.ts";
import type { ActorAssertion } from "../../types.ts";
import { displayNameOf, type MattermostUser } from "./protocol.ts";

export const LINK_TOKEN_TTL_MS = 15 * 60_000;
export const PENDING_TURN_TTL_MS = 30 * 60_000;
const ACCESS_REQUEST_RENOTIFY_MS = 24 * 3_600_000;

export interface MattermostLink {
  mmUserId: string;
  email: string;
  username: string;
  linkedAt: number;
  linkedBy: string;
}

export interface LinkToken {
  mmUserId: string;
  email: string;
  username: string;
  expiresAt: number;
}

export interface AccessRequest {
  email: string;
  mmUserId: string;
  username: string;
  displayName: string;
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  notifiedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  cards?: Array<{ channelId: string; postId: string }>;
}

export interface PendingTurn {
  mmUserId: string;
  storedAt: number;
  event: Record<string, unknown>;
}

export interface IdentityStores {
  links: DurableMap<MattermostLink>;
  tokens: DurableMap<LinkToken>;
  access: DurableMap<AccessRequest>;
  pending: DurableMap<PendingTurn>;
}

export interface Admission {
  admitted(email: string): Promise<boolean>;
}

export function createAdmission(deps: {
  identity: IdentityService;
  allowedEmails?: readonly string[];
  allowedDomain?: string;
}): Admission {
  return {
    async admitted(raw) {
      const email = raw.trim().toLowerCase();
      if (!email.includes("@")) return false;
      await deps.identity.refresh();
      if (deps.identity.deactivationSource(email) === "manual") return false;
      if (!deps.identity.isInternal(deps.identity.classify(email))) return false;
      const member = deps.identity.externalMember(email);
      if (member) return externalMemberActive(member);
      return (
        deps.allowedEmails?.includes(email) === true ||
        Boolean(deps.allowedDomain && email.endsWith(`@${deps.allowedDomain}`))
      );
    },
  };
}

export function verifiedEmail(user: MattermostUser): string | null {
  const email = user.email.trim().toLowerCase();
  if (!email.includes("@") || user.is_bot || user.delete_at) return null;
  if (user.email_verified === false) return null;
  return email;
}

export function principalFor(link: MattermostLink, user: MattermostUser): ActorAssertion {
  return { externalId: link.email, displayName: displayNameOf(user) };
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createLinkRegistry(stores: IdentityStores, now: () => number = Date.now) {
  return {
    async linkFor(user: MattermostUser): Promise<MattermostLink | null> {
      const link = await stores.links.get(user.id);
      if (!link) return null;
      const email = verifiedEmail(user);
      if (email !== link.email) {
        await stores.links.delete(user.id);
        console.log(`[mattermost] dropped the link for @${user.username}: their email changed or is unverified`);
        return null;
      }
      return link;
    },
    async linksByEmail(email: string): Promise<MattermostLink[]> {
      const want = email.trim().toLowerCase();
      return (await stores.links.all()).filter((l) => l.email === want);
    },
    async allLinks(): Promise<MattermostLink[]> {
      return stores.links.all();
    },
    async issueToken(user: MattermostUser, email: string): Promise<string> {
      const token = randomBytes(24).toString("base64url");
      await stores.tokens.put(tokenKey(token), {
        mmUserId: user.id,
        email,
        username: user.username,
        expiresAt: now() + LINK_TOKEN_TTL_MS,
      });
      return token;
    },
    async peekToken(token: string): Promise<LinkToken | null> {
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
      const found = await stores.tokens.get(tokenKey(token));
      if (!found || found.expiresAt <= now()) return null;
      return found;
    },
    async redeemToken(token: string, actorEmail: string): Promise<MattermostLink | "mismatch" | null> {
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
      const peeked = await stores.tokens.get(tokenKey(token));
      if (!peeked || peeked.expiresAt <= now()) return null;
      if (peeked.email !== actorEmail.trim().toLowerCase()) return "mismatch";
      const taken = await stores.tokens.take(tokenKey(token));
      if (!taken || taken.expiresAt <= now()) return null;
      const link: MattermostLink = {
        mmUserId: taken.mmUserId,
        email: taken.email,
        username: taken.username,
        linkedAt: now(),
        linkedBy: "self",
      };
      await stores.links.put(taken.mmUserId, link);
      return link;
    },
    async unlink(mmUserId: string): Promise<MattermostLink | null> {
      return stores.links.take(mmUserId);
    },
    async sweep(): Promise<void> {
      const at = now();
      for (const [id, t] of await stores.tokens.entries()) if (t.expiresAt <= at) await stores.tokens.delete(id);
      for (const [id, p] of await stores.pending.entries())
        if (p.storedAt + PENDING_TURN_TTL_MS <= at) await stores.pending.delete(id);
    },
    async holdTurn(mmUserId: string, event: Record<string, unknown>): Promise<void> {
      await stores.pending.put(mmUserId, { mmUserId, storedAt: now(), event });
    },
    async releaseTurn(mmUserId: string): Promise<Record<string, unknown> | null> {
      const held = await stores.pending.take(mmUserId);
      return held && held.storedAt + PENDING_TURN_TTL_MS > now() ? held.event : null;
    },
    async accessRequest(email: string): Promise<AccessRequest | null> {
      return stores.access.get(email);
    },
    async requestAccess(user: MattermostUser, email: string): Promise<{ request: AccessRequest; notify: boolean }> {
      const at = now();
      const existing = await stores.access.get(email);
      if (existing?.status === "pending") {
        const notify = existing.notifiedAt + ACCESS_REQUEST_RENOTIFY_MS <= at;
        if (notify) await stores.access.merge(email, { notifiedAt: at });
        return { request: { ...existing, ...(notify ? { notifiedAt: at } : {}) }, notify };
      }
      const request: AccessRequest = {
        email,
        mmUserId: user.id,
        username: user.username,
        displayName: displayNameOf(user),
        status: "pending",
        requestedAt: at,
        notifiedAt: at,
      };
      await stores.access.put(email, request);
      return { request, notify: true };
    },
    async noteAccessCards(email: string, cards: Array<{ channelId: string; postId: string }>): Promise<void> {
      await stores.access.merge(email, { cards });
    },
    async decideAccess(email: string, approve: boolean, by: string): Promise<AccessRequest | null> {
      let decided: AccessRequest | null = null;
      await stores.access.update(email, (r) => {
        if (r.status !== "pending") return r;
        decided = { ...r, status: approve ? "approved" : "denied", decidedBy: by, decidedAt: now() };
        return decided;
      });
      return decided;
    },
  };
}

export type LinkRegistry = ReturnType<typeof createLinkRegistry>;
