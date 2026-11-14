// GET /v1/build-info: read-only build metadata for operators and the agent's control-plane token.
// Deliberately limited to commit, build time and health: no config, env or secrets.

import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const STARTED_AT = new Date();
const READY_TIMEOUT_MS = 1_000;

async function health(ctx: ApiCtx): Promise<"ok" | "degraded"> {
  if (ctx.deps.draining?.aborted) return "degraded";
  const check = ctx.deps.checkReadiness;
  if (!check) return "ok";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => check(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("readiness deadline"));
        }, READY_TIMEOUT_MS);
      }),
    ]);
    return "ok";
  } catch {
    return "degraded";
  } finally {
    clearTimeout(timer);
  }
}

export async function getBuildInfo(ctx: ApiCtx): Promise<void> {
  const build = ctx.deps.buildInfo;
  return sendJson(ctx.res, 200, {
    commit: build?.commit ?? null,
    builtAt: build?.builtAt ?? null,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    health: await health(ctx),
  });
}

export const buildInfoRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/build-info", auth: "either", handle: getBuildInfo },
];
