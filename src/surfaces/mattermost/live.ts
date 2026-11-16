import type { RunStore } from "../../runs/run-store.ts";
import { isTerminal } from "../../runs/run-store.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import { runResultDelivery, type RunNotice } from "../../delivery/run-result-delivery.ts";
import { stripReactionDirectives } from "../../slack/reactions.ts";
import { swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import type { Runtime } from "./runtime.ts";
import { normalizeEmoji } from "./format.ts";

const TICK_MS = 1_200;
const PREVIEW_MAX = 3_000;
const MAX_LIVE_MS = 6 * 3_600_000;
const WORKING = "_⏳ Working…_";
export const ACK_EMOJI = "eyes";

export interface LiveTurn {
  channel: string;
  root?: string;
  triggerPostId: string;
}

interface Active {
  placeholder?: string;
  consumed?: boolean;
  steered?: boolean;
  inflight?: Promise<void>;
  stopped: boolean;
  loop: Promise<void>;
  lastText: string;
  turn: LiveTurn;
}

export function createLivePresenter(deps: {
  rt: Runtime;
  runs: Pick<RunStore, "get">;
  turnStream: Pick<TurnStream, "snapshot">;
  notice?: RunNotice;
}) {
  const { rt } = deps;
  const active = new Map<string, Active>();

  async function ack(turn: LiveTurn): Promise<void> {
    await rt.client
      .addReaction(rt.bot().id, turn.triggerPostId, ACK_EMOJI)
      .catch(swallowAs("mattermost: ack reaction", undefined));
    await rt.client.typing(rt.bot().id, turn.channel, turn.root).catch(swallowAs("mattermost: typing", undefined));
  }

  async function unack(turn: LiveTurn): Promise<void> {
    await rt.client
      .removeReaction(rt.bot().id, turn.triggerPostId, ACK_EMOJI)
      .catch(swallowAs("mattermost: remove ack reaction", undefined));
  }

  function preview(runId: string): string {
    const raw = stripReactionDirectives(deps.turnStream.snapshot(runId) ?? "").trim();
    if (!raw) return WORKING;
    const tail = raw.length > PREVIEW_MAX ? `…${raw.slice(-PREVIEW_MAX)}` : raw;
    return `${tail}\n\n${WORKING}`;
  }

  async function finishWithoutDelivery(runId: string, a: Active): Promise<void> {
    const run = await deps.runs.get(runId).catch(() => null);
    if (!run || !isTerminal(run.status)) return;
    if (runResultDelivery(run, undefined, deps.notice)) return;
    if (a.placeholder && !a.consumed)
      await rt.client.deletePost(a.placeholder).catch(swallowAs("mattermost: drop placeholder", undefined));
    if (run.result?.status === "react") {
      for (const name of run.result.reactions ?? []) {
        const emoji = normalizeEmoji(name);
        if (emoji)
          await rt.client
            .addReaction(rt.bot().id, a.turn.triggerPostId, emoji)
            .catch(swallowAs("mattermost: result reaction", undefined));
      }
    }
    await unack(a.turn);
    active.delete(runId);
  }

  async function watch(runId: string, a: Active): Promise<void> {
    const started = Date.now();
    let ticks = 0;
    while (!a.stopped && Date.now() - started < MAX_LIVE_MS) {
      await sleep(TICK_MS);
      if (a.stopped) return;
      const run = await deps.runs.get(runId).catch(() => undefined);
      if (run && isTerminal(run.status)) {
        await finishWithoutDelivery(runId, a);
        return;
      }
      if (a.placeholder && !a.consumed) {
        const text = preview(runId);
        if (text !== a.lastText && !a.stopped) {
          a.lastText = text;
          a.inflight = rt.client
            .patchPost(a.placeholder, { message: text })
            .then(() => undefined, swallowAs("mattermost: stream preview", undefined));
          await a.inflight;
        }
      }
      if (++ticks % 8 === 0)
        await rt.client
          .typing(rt.bot().id, a.turn.channel, a.turn.root)
          .catch(swallowAs("mattermost: typing", undefined));
    }
  }

  return {
    ack,
    async consume(postId: string): Promise<void> {
      for (const a of active.values()) {
        if (a.placeholder !== postId) continue;
        a.consumed = true;
        await a.inflight;
      }
    },
    unack,
    steer(runId: string): void {
      const a = active.get(runId);
      if (a) a.steered = true;
    },
    async begin(runId: string, turn: LiveTurn, opts: { placeholder: boolean }): Promise<void> {
      const a: Active = { stopped: false, loop: Promise.resolve(), lastText: WORKING, turn };
      active.set(runId, a);
      if (opts.placeholder) {
        try {
          const post = await rt.client.createPost({
            channel_id: turn.channel,
            message: WORKING,
            ...(turn.root ? { root_id: turn.root } : {}),
            props: { qm_run: runId, qm_placeholder: true },
          });
          a.placeholder = post.id;
          const recorded = await rt.app.setRunDeliveryState(runId, { editRef: post.id });
          if (!recorded) {
            a.placeholder = undefined;
            await rt.client.deletePost(post.id).catch(swallowAs("mattermost: drop orphan placeholder", undefined));
          }
        } catch (e) {
          swallowAs("mattermost: post placeholder", undefined)(e);
        }
      }
      a.loop = watch(runId, a).catch(swallowAs("mattermost: live watch", undefined));
    },
    async settle(runId: string): Promise<(LiveTurn & { placeholder?: string; steered?: boolean }) | undefined> {
      const a = active.get(runId);
      if (!a) return undefined;
      a.stopped = true;
      active.delete(runId);
      await a.loop;
      return {
        ...a.turn,
        ...(a.placeholder ? { placeholder: a.placeholder } : {}),
        ...(a.steered ? { steered: true } : {}),
      };
    },
    async stopAll(): Promise<void> {
      const all = [...active.values()];
      active.clear();
      for (const a of all) a.stopped = true;
      await Promise.allSettled(all.map((a) => a.loop));
    },
  };
}

export type LivePresenter = ReturnType<typeof createLivePresenter>;
