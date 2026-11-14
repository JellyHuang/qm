import { trimTrailingSlashes } from "../../util/text.ts";

/** QM as the `qm-master` agent of a self-hosted OpenAgents (OA) workspace. */
export interface OpenAgentsConfig {
  /** OA backend base URL as core reaches it (e.g. http://oa-backend:8000 on a shared Docker network). */
  url: string;
  /** Workspace id (UUID) or slug. */
  workspace: string;
  /** Workspace token (secret; owner-equivalent in OA). */
  token: string;
  agentName: string;
  /** Browser URL of the OA UI, used only in links shown to people. */
  publicUrl?: string;
  pollMs: number;
  /** Worker agents QM may delegate to (OA_WORKERS). Anything else is refused. */
  workers: readonly string[];
  /** QM principals (emails) allowed to delegate, in addition to org admins. */
  allowedPrincipals: readonly string[];
  inboundPerHour: number;
}

const DEFAULT_INBOUND_PER_HOUR = 200;

function inboundPerHour(raw: string | undefined): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_INBOUND_PER_HOUR;
}

export function openAgentsConfigFromEnv(env: NodeJS.ProcessEnv): OpenAgentsConfig | undefined {
  const url = env.OA_URL?.trim();
  const workspace = env.OA_WORKSPACE?.trim();
  const token = env.OA_TOKEN?.trim();
  if (!url && !workspace && !token) return undefined;
  if (!url || !workspace || !token) throw new Error("OA_URL, OA_WORKSPACE and OA_TOKEN must be set together");
  const agentName = env.OA_AGENT_NAME?.trim() || "qm-master";
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(agentName)) throw new Error("OA_AGENT_NAME must be a lowercase slug");
  const pollMs = env.OA_POLL_MS ? Number(env.OA_POLL_MS) : 3_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60_000)
    throw new Error("OA_POLL_MS must be an integer from 500 through 60000");
  return {
    url: trimTrailingSlashes(url),
    workspace,
    token,
    agentName,
    ...(env.OA_PUBLIC_URL?.trim() ? { publicUrl: trimTrailingSlashes(env.OA_PUBLIC_URL.trim()) } : {}),
    pollMs,
    workers: (env.OA_WORKERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(s) && s !== agentName),
    allowedPrincipals: (env.OA_ALLOWED_PRINCIPALS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    inboundPerHour: inboundPerHour(env.OA_INBOUND_PER_HOUR),
  };
}
