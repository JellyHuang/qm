import { MATTERMOST_ACTIONS_PATH, MATTERMOST_LINK_PATH } from "../../surfaces/mattermost/config.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

async function mattermostActions(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.mattermostActions) {
    req.resume();
    return sendJson(res, 404, { error: "not_found" });
  }
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: "payload_too_large" });
    throw e;
  }
  const out = await deps.mattermostActions(rawBody);
  return sendJson(res, out.status, out.body as Record<string, unknown>);
}

async function mattermostLink(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, actor } = ctx;
  if (!deps.mattermostLinkPage) return sendJson(res, 404, { error: "not_found" });
  if (actor?.imp) return sendJson(res, 403, { error: "forbidden", message: "Unavailable while impersonating." });
  return deps.mattermostLinkPage(res, url, actor?.p);
}

export const mattermostRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: MATTERMOST_ACTIONS_PATH, auth: "public", handle: mattermostActions },
];

export const mattermostRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: MATTERMOST_LINK_PATH,
    browser: "self",
    actor: "person",
    auth: "source",
    handle: mattermostLink,
  },
];
