import { createHmac } from "node:crypto";
import { trimTrailingSlashes } from "../../util/text.ts";

export const MATTERMOST_ACTIONS_PATH = "/v1/surfaces/mattermost/actions";
export const MATTERMOST_LINK_PATH = "/v1/surfaces/mattermost/link";
export const MATTERMOST_LINK_BROWSER_PATH = "/api/mattermost/link";

export interface MattermostConfig {
  url: string;
  token: string;
  team: string;
  actionSecret: string;
  actionUrl: string;
  linkUrl: string;
  publicWebUrl?: string;
  label?: string;
  ownsDirectMessages: boolean;
}

export function mattermostConfigFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { publicUrl?: string; signingSecret?: string },
): MattermostConfig | undefined {
  const url = env.MATTERMOST_URL?.trim();
  const token = env.MATTERMOST_BOT_TOKEN?.trim();
  const team = env.MATTERMOST_TEAM?.trim();
  if (!url || !token || !team) return undefined;
  const publicUrl = trimTrailingSlashes(env.MATTERMOST_QM_PUBLIC_URL?.trim() || opts.publicUrl || "");
  if (!publicUrl) throw new Error("MATTERMOST_URL is set, but QM has no public URL for Mattermost buttons and links");
  const secret =
    env.MATTERMOST_ACTION_SECRET?.trim() ||
    (opts.signingSecret ? createHmac("sha256", opts.signingSecret).update("mattermost-actions:v1").digest("hex") : "");
  if (secret.length < 32)
    throw new Error("MATTERMOST_ACTION_SECRET (or CORE_SIGNING_SECRET) is required for Mattermost");
  return {
    url: trimTrailingSlashes(url),
    token,
    team,
    actionSecret: secret,
    actionUrl: actionUrlFrom(env.MATTERMOST_ACTION_URL, publicUrl),
    linkUrl: `${publicUrl}${MATTERMOST_LINK_BROWSER_PATH}`,
    publicWebUrl: publicUrl,
    ownsDirectMessages: env.MATTERMOST_OWNS_DIRECT_MESSAGES?.trim() !== "0",
    ...(env.MATTERMOST_LABEL?.trim() ? { label: env.MATTERMOST_LABEL.trim() } : {}),
  };
}

function actionUrlFrom(override: string | undefined, publicUrl: string): string {
  const base = trimTrailingSlashes(override?.trim() || publicUrl);
  return base.endsWith(MATTERMOST_ACTIONS_PATH) ? base : `${base}${MATTERMOST_ACTIONS_PATH}`;
}

export function mattermostOwnsDirectMessages(config: { mattermost?: MattermostConfig }): boolean {
  return config.mattermost?.ownsDirectMessages === true;
}
