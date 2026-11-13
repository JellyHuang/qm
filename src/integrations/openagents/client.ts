// Thin REST client for the OpenAgents workspace backend (verified against commit 1aeec218).
// Every call sends the workspace token and identifies as the configured agent.

import { randomUUID } from "node:crypto";
import type { OpenAgentsConfig } from "./config.ts";

export interface OaEvent {
  id: string;
  type: string;
  source: string;
  target?: string;
  payload?: { content?: string; message_type?: string; [k: string]: unknown };
  metadata?: { target_agents?: string[]; [k: string]: unknown };
  timestamp?: number;
  visibility?: string;
}

export interface OaAgent {
  address: string;
  status?: string;
  agent_type?: string;
  presence_state?: string;
}

export class OaError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;

export function createOaClient(cfg: OpenAgentsConfig, fetchImpl: typeof fetch = fetch) {
  let networkId = cfg.workspace;
  let sessionId: string | undefined;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${cfg.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-workspace-token": cfg.token,
        "x-agent-name": cfg.agentName,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: { code?: number; message?: string; data?: unknown } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok || (json?.code !== undefined && json.code !== 0)) {
      const detail = (json?.message ?? text).toString().slice(0, 300);
      throw new OaError(`OpenAgents ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`, res.status);
    }
    return json?.data as T;
  }

  const meta = (extra?: Record<string, unknown>) => ({ ...(sessionId ? { session_id: sessionId } : {}), ...extra });

  return {
    get network(): string {
      return networkId;
    },
    async join(): Promise<void> {
      const d = await call<{ network_id: string; session_id: string }>("POST", "/v1/join", {
        agent_name: cfg.agentName,
        token: cfg.token,
        network: cfg.workspace,
        agent_type: "qm",
      });
      networkId = d.network_id;
      sessionId = d.session_id;
    },
    async heartbeat(): Promise<void> {
      await call("POST", "/v1/heartbeat", { agent_name: cfg.agentName, network: networkId, session_id: sessionId });
    },
    async leave(): Promise<void> {
      await call("POST", "/v1/leave", { agent_name: cfg.agentName, network: networkId, session_id: sessionId });
    },
    async events(q: Record<string, string | number | undefined>) {
      const params = new URLSearchParams({ network: networkId });
      for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
      return call<{ events: OaEvent[]; has_more?: boolean; next_cursor?: string }>("GET", `/v1/events?${params}`);
    },
    async createThread(opts: { title: string; participants: string[] }): Promise<string> {
      const d = await call<OaEvent>("POST", "/v1/events", {
        type: "network.channel.create",
        source: `openagents:${cfg.agentName}`,
        target: "core",
        network: networkId,
        payload: { title: opts.title, master: cfg.agentName, participants: opts.participants, visibility: "public" },
        metadata: meta(),
      });
      const channel = d.target?.startsWith("channel/") ? d.target.slice("channel/".length) : undefined;
      if (!channel) throw new OaError("OpenAgents did not return the new thread name", 502);
      return channel;
    },
    async post(channel: string, content: string, targets: string[], idempotencyKey: string = randomUUID()) {
      return call<OaEvent>("POST", "/v1/events", {
        type: "workspace.message.posted",
        source: `openagents:${cfg.agentName}`,
        target: `channel/${channel}`,
        network: networkId,
        payload: { content, message_type: "chat" },
        metadata: meta(targets.length ? { explicit_targets: targets } : {}),
        idempotency_key: idempotencyKey,
      });
    },
    async history(channel: string, limit: number): Promise<OaEvent[]> {
      const d = await this.events({
        channel,
        type: "workspace.message",
        sort: "desc",
        limit,
        exclude_message_types: "thinking,status,todos",
      });
      return d.events.reverse();
    },
    async agents(): Promise<OaAgent[]> {
      const d = await call<{ agents: OaAgent[] }>("GET", `/v1/discover?network=${encodeURIComponent(networkId)}`);
      return d.agents ?? [];
    },
    async createTask(opts: { title: string; description: string; assignee?: string }) {
      return call<{ id?: string; taskId?: string; number?: number }>("POST", "/v1/tasks", {
        network: networkId,
        title: opts.title,
        description: opts.description,
        status: "todo",
        ...(opts.assignee ? { assignee: opts.assignee } : {}),
      });
    },
  };
}

export type OaClient = ReturnType<typeof createOaClient>;
