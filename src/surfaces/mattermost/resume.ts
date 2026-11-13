// Resume a Mattermost request after the person connects a per-user OAuth MCP server.
//
// When a turn started from a Mattermost message hits "sign in to <server> first", core
// reports { serverId, principalId, runId }. We remember which message that run answered.
// When the same QM principal finishes the OAuth connect for that server, we start a new
// turn in the same conversation telling the assistant to continue the waiting request.
// The resumed turn runs as the same person, so their own token is used.

import type { DurableMap } from "../../persistence/durable-map.ts";
import { swallowAs } from "../../util/errors.ts";

export const RESUME_TTL_MS = 30 * 60_000;
const RUN_TRACK_MAX = 2_000;

export interface SignInResume {
  principalId: string;
  serverId: string;
  postId: string;
  storedAt: number;
}

const key = (principalId: string, serverId: string) => `${principalId}\u0000${serverId}`;

export function createSignInResume(deps: {
  store: DurableMap<SignInResume>;
  resume: (postId: string, serverId: string) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const runs = new Map<string, string>();

  return {
    /** A Mattermost message started this run. */
    track(runId: string, postId: string): void {
      if (runs.size >= RUN_TRACK_MAX) runs.delete(runs.keys().next().value!);
      runs.set(runId, postId);
    },
    /** The Mattermost post a still-tracked run was started from. */
    postFor(runId: string): string | undefined {
      return runs.get(runId);
    },
    async signInRequired(ev: { serverId: string; principalId: string; runId?: string }): Promise<void> {
      const postId = ev.runId ? runs.get(ev.runId) : undefined;
      if (!postId) return;
      await deps.store.put(key(ev.principalId, ev.serverId), {
        principalId: ev.principalId,
        serverId: ev.serverId,
        postId,
        storedAt: now(),
      });
    },
    async connected(serverId: string, principalId: string): Promise<boolean> {
      const held = await deps.store.take(key(principalId, serverId));
      if (!held || held.storedAt + RESUME_TTL_MS <= now()) return false;
      await deps.resume(held.postId, serverId).catch(swallowAs("mattermost: resume after sign-in", undefined));
      return true;
    },
    async sweep(): Promise<void> {
      const at = now();
      for (const [id, r] of await deps.store.entries())
        if (r.storedAt + RESUME_TTL_MS <= at) await deps.store.delete(id);
    },
  };
}

export type SignInResumer = ReturnType<typeof createSignInResume>;
