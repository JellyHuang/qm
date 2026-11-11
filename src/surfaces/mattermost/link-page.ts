import type { ServerResponse } from "node:http";
import { swallowAs } from "../../util/errors.ts";
import type { LinkRegistry, MattermostLink } from "./identity.ts";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d1f23;--muted:#5d6470;--accent:#1c58d9;--line:#dde1e7}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--card:#1f2228;--fg:#e8eaee;--muted:#a3a9b4;--accent:#6c9bff;--line:#343842}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px;color:var(--muted)}strong{color:var(--fg)}
a.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
a.alt{color:var(--accent);margin-left:14px}
</style></head><body><main>${body}</main></body></html>`;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(html);
}

export function createLinkPage(deps: {
  links: LinkRegistry;
  path: string;
  onLinked: (link: MattermostLink) => Promise<void>;
}) {
  return async function handle(res: ServerResponse, url: URL, signedInAs: string | undefined): Promise<void> {
    const token = url.searchParams.get("t") ?? "";
    if (!signedInAs) {
      send(res, 401, page("Sign in", "<h1>Sign in first</h1><p>Open this link again after signing in to QM.</p>"));
      return;
    }
    const pending = await deps.links.peekToken(token);
    if (!pending) {
      send(
        res,
        410,
        page(
          "Link expired",
          "<h1>This link has expired</h1><p>Connection links work once and only for a short time. Send the QM bot any message in Mattermost to get a new one.</p>",
        ),
      );
      return;
    }
    const me = signedInAs.trim().toLowerCase();
    if (pending.email !== me) {
      send(
        res,
        403,
        page(
          "Wrong account",
          `<h1>Different account</h1><p>You're signed in to QM as <strong>${escape(me)}</strong>, but the Mattermost account <strong>@${escape(pending.username)}</strong> uses <strong>${escape(pending.email)}</strong>.</p><p>Sign out of QM (account menu in the QM web app), sign in again as <strong>${escape(pending.email)}</strong>, then open this link again.</p>`,
        ),
      );
      return;
    }
    if (url.searchParams.get("confirm") !== "1") {
      const confirmUrl = `${deps.path}?t=${encodeURIComponent(token)}&confirm=1`;
      send(
        res,
        200,
        page(
          "Connect Mattermost",
          `<h1>Connect Mattermost to QM</h1><p>Link the Mattermost account <strong>@${escape(pending.username)}</strong> to your QM account <strong>${escape(me)}</strong>?</p><p>QM will then answer you in Mattermost with your own memory, files and permissions.</p><p><a class="btn" href="${escape(confirmUrl)}">Connect</a></p>`,
        ),
      );
      return;
    }
    const linked = await deps.links.redeemToken(token, me);
    if (!linked || linked === "mismatch") {
      send(
        res,
        410,
        page(
          "Link expired",
          "<h1>This link has already been used</h1><p>Send the QM bot a message in Mattermost to get a new one.</p>",
        ),
      );
      return;
    }
    void deps.onLinked(linked).catch(swallowAs("mattermost: after link", undefined));
    send(
      res,
      200,
      page(
        "Connected",
        `<h1>✅ Connected</h1><p>Mattermost account <strong>@${escape(linked.username)}</strong> is now linked to <strong>${escape(linked.email)}</strong>.</p><p>Head back to Mattermost — QM is picking up your message there.</p>`,
      ),
    );
  };
}
