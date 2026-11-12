# Company fork: core seams for the Mattermost surface

Branch layout:

- `upstream-main`: an untouched mirror of `yc-software/qm`. It currently pins `0ceacbc47`, the commit that the published core image `ghcr.io/yc-software/qm/core@sha256:6971dc02…` was built from.
- `zq/main`: `upstream-main` plus the commits below.

The Mattermost surface itself lives in `src/surfaces/mattermost/`, which has its own README. This file lists every change **outside** that directory. Keep it current: it is the checklist for every upstream merge.

## Seam commit: "let a configured primary chat surface take Slack-only paths"

`src/surfaces/primary-chat.ts` holds one process-wide value. It defaults to `"slack"`; wiring sets it to `"mattermost"` when Mattermost owns direct messages. `isChatSurface(kind)` is true for `"slack"` and for the primary surface.

| File                                  | Change                                                                                                                                                                    | Why                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/reach/reach.ts`                  | A channel found in the directory resolves to `type: primaryChatSurface()` instead of `"slack"`                                                                            | Reaching `#channel` must post through Mattermost                         |
| `src/api/app-helpers.ts`              | Directory refresh and group-DM opening pull from the primary surface                                                                                                      | Directory sync and `openGroup` go to the surface that owns the directory |
| `src/surfaces/surface-tools.ts`       | Group-DM opening uses the primary surface; the agent's `edit` action accepts any chat surface                                                                             | Agent tool parity                                                        |
| `src/api/routes/context.ts`           | A named-channel context pull asks the primary surface                                                                                                                     | `surface-context` for a channel                                          |
| `src/triggers/run-trigger.ts`         | Visibility check treats any chat surface like Slack                                                                                                                       | Crons and monitors posting to Mattermost                                 |
| `src/sessions/session-syscalls.ts`    | `requiresDelegation` covers any chat surface                                                                                                                              | Keeps Slack's "stay responsive, delegate long work" behaviour            |
| `src/delivery/run-result-delivery.ts` | The security-quarantine and budget refusal notice applies to any chat surface                                                                                             | Same failure copy as Slack                                               |
| `src/slack/approval-store.ts`         | Approval cards are delivered for any chat surface's turns                                                                                                                 | Approval buttons in Mattermost                                           |
| `src/api/app-messaging.ts`            | Edit and `threadTs` checks accept any chat surface; a principal-DM session is created with the primary surface; message revisions use the surface's `threadRefCandidates` | Proactive DMs and edit tracking                                          |
| `src/slack/message-revisions.ts`      | `recordMessageRevisions` takes an optional `candidates` function, defaulting to Slack's                                                                                   | Edit tracking for non-Slack thread refs                                  |
| `src/surfaces/contract.ts`            | Optional `Surface.threadRefCandidates(container, ts, sub)`                                                                                                                | As above                                                                 |

With only Slack configured, every one of these behaves exactly as upstream.

## Module commit: "in-process Mattermost surface"

| File                                                      | Change                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`                                           | Parses `MATTERMOST_*` env into `config.mattermost` (see `src/surfaces/mattermost/config.ts`)                                                                                                                                                                 |
| `src/wiring.ts`                                           | Registers the Mattermost `Surface`; sets the primary chat surface; creates the runtime with its deps; chains `mattermostRunNotice` after partner-chat's notice; starts and stops it with background work; exposes the action and link handlers to the server |
| `src/api/deps.ts`                                         | `mattermostActions` and `mattermostLinkPage` server deps                                                                                                                                                                                                     |
| `src/api/routes/mattermost.ts`, `src/api/routes/index.ts` | `POST /v1/surfaces/mattermost/actions` (public, HMAC-checked in the module) and `GET /v1/surfaces/mattermost/link` (signed-in browser route)                                                                                                                 |
| `src/api/browser-session.ts`                              | Browser alias `GET /api/mattermost/link`                                                                                                                                                                                                                     |
| `plugins/portal/src/index.ts`                             | Passes `POST /v1/surfaces/mattermost/actions` through to core, like partner-chat events; exempts `/api/mattermost/link` from the "model provider not configured" redirect, which otherwise fires for deployments that only have a custom provider            |
| `test/mattermost-surface.test.ts`                         | Unit tests (no Postgres needed)                                                                                                                                                                                                                              |

New durable-map tables are created on first use: `mattermost_links`, `mattermost_link_tokens`, `mattermost_access_requests` and `mattermost_pending_turns`. No existing table changes.

## Fix commit: "count a custom model provider as configured"

| File                        | Change                                                                                                           | Why                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/routes/surface.ts` | `modelProviderConfigured` is also true when an enabled custom provider (Admin → Model providers) has a saved key | Upstream only counted Anthropic, OpenAI and OpenRouter keys. With only a custom provider, the portal sent admins to `/settings/onboarding` and showed everyone else "not configured". |

## Feature commit: "per-model image input for custom providers"

| File                                             | Change                                                                                                                                                                                                      | Why                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model/custom-providers.ts`                  | Optional per-model `images` boolean. `true` gives the model `input: ["text", "image"]`, in both the runtime registry and the generated `models.json`; unset or `false` keeps upstream's text-only behaviour | Upstream hard-codes custom models as text-only, so pi strips every image ("image omitted: model does not support images") even for vision models behind a gateway |
| `plugins/web-ui/src/admin/settings-providers.ts` | The Models textarea takes a sixth column, `images (true/false)`                                                                                                                                             | Switch it per model from Admin → Models → Custom providers                                                                                                        |
| `test/custom-providers.test.ts`                  | Covers the default, `true`, `false`, and rejected values                                                                                                                                                    |                                                                                                                                                                   |

Saved providers without the field behave exactly as before.

## Feature commit: "admin page for MCP servers"

| File                                                       | Change                                                                                                                              | Why                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `plugins/web-ui/src/admin/mcp-servers.ts` (new)            | Admin → Organization → **MCP servers**: list, add, edit, delete; test on save; discovered tools; write-only token and secret fields | Upstream has the `/v1/admin/mcp-servers` API but no UI |
| `plugins/web-ui/src/admin/sections.ts`                     | Registers the `mcp-servers` view                                                                                                    |                                                        |
| `plugins/web-ui/test/admin/mcp-servers-page.test.ts` (new) | Page tests                                                                                                                          |                                                        |

No backend change. The page uses the existing admin browser-session aliases (`/api/admin/mcp-servers`). Registering or changing a server stays portal-only for the agent (`MCP_SERVERS` in `src/api/routes/admin.ts`).

## Feature commit: "per-user OAuth MCP servers: confidential clients, dead-token cleanup, resume after sign-in"

For MCP servers that act as each person with their own OAuth token, for example OpenProject.

| File                                                                                            | Change                                                                                                                                                                                                              | Why                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/connectors/oauth.ts`, `src/mcp/mcp-tool-service.ts`, `src/api/routes/admin/mcp-servers.ts` | An `oauth-user` server can carry a write-only `clientSecret`, which is sent with PKCE on code exchange and refresh. A blank field keeps the stored secret; a new client id drops it                                 | Issuers such as OpenProject use confidential clients. Upstream supports public clients only           |
| `src/credentials/keychain.ts`                                                                   | A per-user MCP OAuth link (`clientRef` `public:*`) whose refresh fails with `invalid_grant` is deleted                                                                                                              | The person is asked to connect again. Built-in connectors keep upstream's "needs reconnect" behaviour |
| `src/mcp/mcp-tool-service.ts`                                                                   | A 401 from an `oauth-user` server deletes that person's token and returns the sign-in prompt. `onSignInRequired({ serverId, principalId, runId })` reports every sign-in prompt. `call()` takes an optional `runId` | Revoked or foreign tokens. Lets a surface resume the request                                          |
| `src/tools/primitives.ts`                                                                       | Passes the run id to `mcp.call`                                                                                                                                                                                     |                                                                                                       |
| `src/api/routes/connectors.ts`, `src/api/deps.ts`                                               | `onConnectorConnected(provider, principalId)` runs after a successful OAuth callback                                                                                                                                |                                                                                                       |
| `src/wiring.ts`                                                                                 | Connects both hooks to the Mattermost module                                                                                                                                                                        |                                                                                                       |
| `src/surfaces/mattermost/resume.ts` (new), `inbound.ts`, `index.ts`                             | Remembers which Mattermost message a run answered. After the same person connects that server, starts one follow-up turn in the same conversation. Held for 30 minutes, in the `mattermost_signin_resumes` table    | "Connect OpenProject, then your request continues"                                                    |
| `plugins/web-ui/src/admin/mcp-servers.ts`                                                       | Client-secret field for per-user OAuth. Corrected the misleading "read-only" label: that flag trusts every tool as read-only and does **not** block writes                                                          |                                                                                                       |

Tests: `test/mcp-oauth-user.test.ts`, `test/mcp-admin.test.ts`, `test/keychain-connector-refresh.test.ts`, `test/mattermost-surface.test.ts`, `plugins/web-ui/test/admin/mcp-servers-page.test.ts`.

## Feature commit: "configurable MCP tool-list cap"

| File                                           | Change                                                                                                             | Why                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/config.ts`                                | `MCP_MAX_TOOLS` (1 to 5000; unset keeps upstream's 64)                                                             | Servers with more than 64 tools were silently cut off                                                       |
| `src/mcp/mcp-tool-service.ts`, `src/wiring.ts` | The cap applies to the shared listing, the per-user sign-in listing and the admin probe. Catalog mode is unchanged | MCP tools reach the model deferred (`tool_search` / `mcp_call`), so a larger list doesn't grow every prompt |

## Upgrading to a new upstream release

1. Back up QM (`systemctl start qm-backup`).
2. Update the mirror and merge:
   ```bash
   git fetch upstream
   git checkout upstream-main && git merge --ff-only <release commit>
   git checkout zq/main && git merge upstream-main
   ```
3. On conflicts, re-apply each row above. Then search for new hard-coded `"slack"` checks in delivery, reach, approvals and context code: `grep -rn '"slack"' src --include=*.ts`.
4. Typecheck, lint and test:
   ```bash
   npx tsrs --noEmit
   npx eslint src/surfaces/mattermost
   node --test test/mattermost-surface.test.ts
   ```
   Also run the Postgres tests for touched areas with `DATABASE_URL=… node scripts/run-pg-tests.mjs …`.
5. Commit, then run `qm up`. The wrapper builds core from this checkout and refuses a dirty tree.
6. Smoke test:
   - run `postdeploy-smoke` in core;
   - send a DM to `@qm`;
   - `@qm` in a channel and in a thread;
   - check that an approval button works.
7. Rollback: run `QM_UPSTREAM=1 qm up` to go back to the published upstream images. No schema migration has to be undone.
