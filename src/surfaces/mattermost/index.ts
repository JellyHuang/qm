import type { ServerResponse } from "node:http";
import type { App } from "../../api/app-types.ts";
import type { IdentityService } from "../../identity/identity-service.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { createDeliveryRelay } from "../../delivery/relay.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { LeaderLease } from "../../persistence/leader-lease.ts";
import type { RunStore, Run } from "../../runs/run-store.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import type { KeychainApprovals } from "../../credentials/keychain-approval.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { createSweeper } from "../../util/sweeper.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { createActions } from "./actions.ts";
import { createActionSigner } from "./cards.ts";
import { createMattermostClient, createMattermostSocket } from "./client.ts";
import { createContextAnswers } from "./context.ts";
import { createDirectorySync } from "./directory.ts";
import {
  createAdmission,
  createLinkRegistry,
  type AccessRequest,
  type LinkToken,
  type MattermostLink,
  type PendingTurn,
} from "./identity.ts";
import { createInbound } from "./inbound.ts";
import { createSignInResume, type SignInResume } from "./resume.ts";
import { createLinkPage } from "./link-page.ts";
import { createLivePresenter } from "./live.ts";
import { createOnboarding, type AccessAdmin } from "./onboarding.ts";
import { createMattermostSender, DELIVERY_TYPES, MATTERMOST_CLAIM_MS } from "./outbound.ts";
import { kindOfChannelType, SURFACE, type WsEvent } from "./protocol.ts";
import { createRuntime } from "./runtime.ts";
import type { MattermostConfig } from "./config.ts";
export { createMattermostSurface } from "./surface.ts";

export { SURFACE as MATTERMOST_SURFACE } from "./protocol.ts";
export type { MattermostConfig } from "./config.ts";

export {
  MATTERMOST_ACTIONS_PATH,
  MATTERMOST_LINK_PATH,
  MATTERMOST_LINK_BROWSER_PATH,
  mattermostConfigFromEnv,
  mattermostOwnsDirectMessages,
} from "./config.ts";
import { MATTERMOST_LINK_BROWSER_PATH } from "./config.ts";

const DIRECTORY_SYNC_MS = 15 * 60_000;
const HOUSEKEEPING_MS = 5 * 60_000;
const BOOT_RETRY_MAX_MS = 60_000;
const BACKFILL_LOOKBACK_MS = 10 * 60_000;
const HANDLED_MAX = 5_000;

export function mattermostRunNotice(run: Run): string | undefined {
  if (run.request.surface !== SURFACE || run.request.origin?.kind !== "human" || !run.result) return undefined;
  if (run.result.status === "pending_approval") {
    const reason = run.result.reason?.trim();
    const where = run.request.conversation.kind === "dm" ? "below" : "in a direct message";
    return `⏸ ${reason || "Waiting for your approval"} — I sent the approval request ${where}.`;
  }
  if (run.result.status === "refused" && run.result.refusalKind !== "security_quarantine")
    return unfinishedTurnText(userFacingFailureClause(run.result));
  return undefined;
}

export interface MattermostDeps {
  config: MattermostConfig;
  app: App;
  identity: IdentityService;
  deliveries: DeliveryStore;
  blobs: BlobTransferStore;
  runs: RunStore;
  turnStream: TurnStream;
  leaderLease: LeaderLease;
  map: <T>(table: string) => DurableMap<T>;
  admin: AccessAdmin;
  allowedEmails?: readonly string[];
  allowedDomain?: string;
  keychainApprovals?: KeychainApprovals;
  claimPrincipalDeliveries: boolean;
}

export function createMattermost(deps: MattermostDeps) {
  const client = createMattermostClient({ url: deps.config.url, token: deps.config.token });
  const links = createLinkRegistry({
    links: deps.map<MattermostLink>("mattermost_links"),
    tokens: deps.map<LinkToken>("mattermost_link_tokens"),
    access: deps.map<AccessRequest>("mattermost_access_requests"),
    pending: deps.map<PendingTurn>("mattermost_pending_turns"),
  });
  const admission = createAdmission({
    identity: deps.identity,
    ...(deps.allowedEmails ? { allowedEmails: deps.allowedEmails } : {}),
    ...(deps.allowedDomain ? { allowedDomain: deps.allowedDomain } : {}),
  });
  const rt = createRuntime({
    config: deps.config,
    client,
    app: deps.app,
    identity: deps.identity,
    links,
    admission,
    signer: createActionSigner(deps.config.actionSecret),
  });
  const live = createLivePresenter({ rt, runs: deps.runs, turnStream: deps.turnStream, notice: mattermostRunNotice });
  const onboarding = createOnboarding({ rt, admin: deps.admin });
  const resumer = createSignInResume({
    store: deps.map<SignInResume>("mattermost_signin_resumes"),
    resume: (postId, serverId) => inbound.resume(postId, serverId),
  });
  const inbound = createInbound({
    rt,
    live,
    onboarding,
    blobs: deps.blobs,
    onQueued: (runId, postId) => resumer.track(runId, postId),
  });
  onboarding.attach(inbound);
  const actions = createActions({
    rt,
    live,
    onboarding,
    ...(deps.keychainApprovals ? { keychainApprovals: deps.keychainApprovals } : {}),
  });
  const linkPage = createLinkPage({ links, path: MATTERMOST_LINK_BROWSER_PATH, onLinked: (l) => onboarding.linked(l) });
  const directory = createDirectorySync({ rt });
  const context = createContextAnswers({ rt, syncDirectory: () => directory.run() });
  const send = createMattermostSender({
    rt,
    live,
    blobs: deps.blobs,
    openArtifact: async (artifactId, viewerId) => {
      const opened = await deps.app.openFileForViewer(artifactId, viewerId);
      if (!opened) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    },
    ...(deps.keychainApprovals ? { keychainApprovals: deps.keychainApprovals } : {}),
  });
  const types = deps.claimPrincipalDeliveries ? DELIVERY_TYPES : ([SURFACE] as const);
  const relays = types.map((type) =>
    createDeliveryRelay(deps.deliveries, { type, send, claimMs: MATTERMOST_CLAIM_MS }),
  );

  const handled = new Set<string>();
  let lastEventAt = Date.now();
  const dispatch = async (ev: WsEvent): Promise<void> => {
    lastEventAt = Date.now();
    if (ev.event === "posted") {
      const raw = typeof ev.data["post"] === "string" ? ev.data["post"] : "";
      const id = /"id":"([a-z0-9]{26})"/.exec(raw)?.[1];
      if (id) {
        if (handled.has(id)) return;
        if (handled.size >= HANDLED_MAX) handled.clear();
        handled.add(id);
      }
    }
    await inbound.handle(ev);
  };

  async function backfill(): Promise<void> {
    const since = Math.max(lastEventAt - 5_000, Date.now() - BACKFILL_LOOKBACK_MS);
    const channels = await client.myChannels(rt.bot().teamId).catch(() => []);
    for (const ch of channels) {
      const kind = kindOfChannelType(ch.type);
      if (!kind || ch.delete_at) continue;
      const posts = await client.channelPosts(ch.id, { since, perPage: 200 }).catch(() => []);
      for (const post of posts.sort((a, b) => a.create_at - b.create_at)) {
        if (post.create_at < since || post.user_id === rt.bot().id) continue;
        await dispatch({
          event: "posted",
          data: { channel_type: ch.type, post: JSON.stringify(post) },
          broadcast: { channel_id: ch.id },
        }).catch(swallowAs("mattermost: backfill post", undefined));
      }
    }
  }

  const socket = createMattermostSocket({
    url: deps.config.url,
    token: deps.config.token,
    onEvent: dispatch,
    onConnected: async (reconnected) => {
      console.log(`[mattermost] connected as @${rt.bot().username}${reconnected ? " (reconnected)" : ""}`);
      if (reconnected) await backfill();
      await context.drainPending();
    },
  });

  const directorySweeper = createSweeper(() => directory.run(), DIRECTORY_SYNC_MS, {
    label: "mattermost directory",
    immediate: true,
  });
  const housekeeping = createSweeper(
    async () => {
      await links.sweep();
      await resumer.sweep();
    },
    HOUSEKEEPING_MS,
    { label: "mattermost housekeeping" },
  );

  let stopped = true;
  let stopSignal: () => void = () => {};
  let leaderLoop: Promise<void> | undefined;
  let bootLoop: Promise<void> | undefined;

  async function boot(): Promise<boolean> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const [me, team] = await Promise.all([client.me(), client.team(deps.config.team)]);
        rt.setBot({ id: me.id, username: me.username, teamId: team.id, teamName: team.name });
        return true;
      } catch (e) {
        console.error(`[mattermost] can't reach ${deps.config.url} yet: ${errMessage(e)} — retrying`);
        await sleep(delay);
        delay = Math.min(BOOT_RETRY_MAX_MS, delay * 2);
      }
    }
    return false;
  }

  async function lead(): Promise<void> {
    while (!stopped) {
      await deps.leaderLease
        .hold("mattermost:socket", async (lost) => {
          socket.start();
          directorySweeper.start();
          await Promise.race([lost, new Promise<void>((r) => (stopSignal = r))]);
          await Promise.allSettled([socket.stop(), directorySweeper.stop()]);
        })
        .catch(swallowAs("mattermost: leader lease", undefined));
      if (!stopped) await sleep(5_000);
    }
  }

  return {
    usernameOf: (id: string) => rt.cachedUsername(id),
    async handleAction(rawBody: string) {
      return actions.handle(rawBody);
    },
    async handleLinkPage(res: ServerResponse, url: URL, signedInAs: string | undefined) {
      return linkPage(res, url, signedInAs);
    },
    /** Core: a run started here needs the person to sign in to a per-user OAuth MCP server. */
    signInRequired(ev: { serverId: string; principalId: string; runId?: string }): void {
      void resumer.signInRequired(ev).catch(swallowAs("mattermost: remember sign-in resume", undefined));
    },
    /** Core: the person finished an OAuth connect; continue any Mattermost request waiting on it. */
    async connectorConnected(provider: string, principalId: string): Promise<void> {
      await resumer.connected(provider, principalId);
    },
    start(): void {
      if (!stopped) return;
      stopped = false;
      bootLoop = (async () => {
        if (!(await boot())) return;
        context.attach();
        for (const relay of relays) relay.start();
        housekeeping.start();
        leaderLoop = lead();
      })();
    },
    async stop(): Promise<void> {
      stopped = true;
      stopSignal();
      await bootLoop;
      await Promise.allSettled([
        ...relays.map((r) => r.stop()),
        housekeeping.stop(),
        live.stopAll(),
        leaderLoop ?? Promise.resolve(),
      ]);
    },
  };
}

export type Mattermost = ReturnType<typeof createMattermost>;
