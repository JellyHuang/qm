# Company fork: core seams for the Mattermost surface

Branch layout:

- `upstream-main`: an untouched mirror of `yc-software/qm`. It currently pins `0ceacbc47`, the commit that the published core image `ghcr.io/yc-software/qm/core@sha256:6971dc02…` was built from.
- `zq/main`: `upstream-main` plus the commits below.

The Mattermost surface itself lives in `src/surfaces/mattermost/`, which has its own README. This file lists every change **outside** that directory. Keep it current: it is the checklist for every upstream merge.

## Seam commit: "let a configured primary chat surface take Slack-only paths"

`src/surfaces/primary-chat.ts` holds one process-wide value. It defaults to `"slack"`; wiring sets it to `"mattermost"` when Mattermost owns direct messages. `isChatSurface(kind)` is true for `"slack"` and for the primary surface.

| File | Change | Why |
|---|---|---|
| `src/reach/reach.ts` | A channel found in the directory resolves to `type: primaryChatSurface()` instead of `"slack"` | Reaching `#channel` must post through Mattermost |
| `src/api/app-helpers.ts` | Directory refresh and group-DM opening pull from the primary surface | Directory sync and `openGroup` go to the surface that owns the directory |
| `src/surfaces/surface-tools.ts` | Group-DM opening uses the primary surface; the agent's `edit` action accepts any chat surface | Agent tool parity |
| `src/api/routes/context.ts` | A named-channel context pull asks the primary surface | `surface-context` for a channel |
| `src/triggers/run-trigger.ts` | Visibility check treats any chat surface like Slack | Crons and monitors posting to Mattermost |
| `src/sessions/session-syscalls.ts` | `requiresDelegation` covers any chat surface | Keeps Slack's "stay responsive, delegate long work" behaviour |
| `src/delivery/run-result-delivery.ts` | The security-quarantine and budget refusal notice applies to any chat surface | Same failure copy as Slack |
| `src/slack/approval-store.ts` | Approval cards are delivered for any chat surface's turns | Approval buttons in Mattermost |
| `src/api/app-messaging.ts` | Edit and `threadTs` checks accept any chat surface; a principal-DM session is created with the primary surface; message revisions use the surface's `threadRefCandidates` | Proactive DMs and edit tracking |
| `src/slack/message-revisions.ts` | `recordMessageRevisions` takes an optional `candidates` function, defaulting to Slack's | Edit tracking for non-Slack thread refs |
| `src/surfaces/contract.ts` | Optional `Surface.threadRefCandidates(container, ts, sub)` | As above |

With only Slack configured, every one of these behaves exactly as upstream.

## Module commit: "in-process Mattermost surface"

| File | Change |
|---|---|
| `src/config.ts` | Parses `MATTERMOST_*` env into `config.mattermost` (see `src/surfaces/mattermost/config.ts`) |
| `src/wiring.ts` | Registers the Mattermost `Surface`; sets the primary chat surface; creates the runtime with its deps; chains `mattermostRunNotice` after partner-chat's notice; starts and stops it with background work; exposes the action and link handlers to the server |
| `src/api/deps.ts` | `mattermostActions` and `mattermostLinkPage` server deps |
| `src/api/routes/mattermost.ts`, `src/api/routes/index.ts` | `POST /v1/surfaces/mattermost/actions` (public, HMAC-checked in the module) and `GET /v1/surfaces/mattermost/link` (signed-in browser route) |
| `src/api/browser-session.ts` | Browser alias `GET /api/mattermost/link` |
| `plugins/portal/src/index.ts` | Passes `POST /v1/surfaces/mattermost/actions` through to core, like partner-chat events; exempts `/api/mattermost/link` from the "model provider not configured" redirect, which otherwise fires for deployments that only have a custom provider |
| `test/mattermost-surface.test.ts` | Unit tests (no Postgres needed) |

New durable-map tables are created on first use: `mattermost_links`, `mattermost_link_tokens`, `mattermost_access_requests` and `mattermost_pending_turns`. No existing table changes.

## Fix commit: "count a custom model provider as configured"

| File | Change | Why |
|---|---|---|
| `src/api/routes/surface.ts` | `modelProviderConfigured` is also true when an enabled custom provider (Admin → Model providers) has a saved key | Upstream only counted Anthropic, OpenAI and OpenRouter keys. With only a custom provider, the portal sent admins to `/settings/onboarding` and showed everyone else "not configured". |

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
