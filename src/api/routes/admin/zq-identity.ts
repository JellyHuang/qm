import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

async function admin(ctx: ApiCtx) {
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return undefined;
  if (!ctx.deps.zqIdentity?.enabled) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return undefined;
  }
  return { id: authorized.id, links: ctx.deps.zqIdentity };
}

export async function getIdentityLinks(ctx: ApiCtx): Promise<void> {
  const found = await admin(ctx);
  if (!found) return;
  return sendJson(ctx.res, 200, { links: await found.links.list() });
}

export async function confirmIdentityLink(ctx: ApiCtx): Promise<void> {
  const found = await admin(ctx);
  if (!found) return;
  const mmUserId = ctx.params.mmUserId ?? "";
  try {
    const link = await found.links.confirm(mmUserId, found.id);
    audit(ctx.deps, {
      principalId: found.id,
      action: "zq-identity.confirm",
      resource: mmUserId,
      scopeLabel: orgScope(ctx.deps),
    });
    return sendJson(ctx.res, 200, { ok: true, link });
  } catch (e) {
    return sendJson(ctx.res, 404, { error: "not_found", message: errMessage(e) });
  }
}

export async function deleteIdentityLink(ctx: ApiCtx): Promise<void> {
  const found = await admin(ctx);
  if (!found) return;
  const mmUserId = ctx.params.mmUserId ?? "";
  await found.links.unlink(mmUserId);
  audit(ctx.deps, {
    principalId: found.id,
    action: "zq-identity.unlink",
    resource: mmUserId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
