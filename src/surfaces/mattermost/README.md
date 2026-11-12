# Mattermost surface

Mattermost as a QM chat surface. It runs in-process with core, like the Slack surface, and gives users the same AI chat experience as QM's Slack integration. Changes to core outside this directory are listed in [`docs/zq/SEAMS.md`](../../../docs/zq/SEAMS.md).

```
Mattermost ⇄ REST v4 + WebSocket (bot token) ⇄ this module (inside core) → app.turn / outbox / directory
Mattermost → POST /v1/surfaces/mattermost/actions (interactive buttons, HMAC-signed context)
Browser    → GET  /api/mattermost/link (account linking, behind QM sign-in)
```

## Files

| File            | Role                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`     | `MATTERMOST_*` env → config                                                                                                                                       |
| `client.ts`     | Thin REST v4 client; WebSocket with auth, ping, reconnect and backoff                                                                                             |
| `protocol.ts`   | Ids, delivery targets (`<channel>[:<root>]`), thread refs (`mm:dm:…`, `mm:ch:…`, `mm:grp:…`), and the numeric `ts` that encodes a post id for QM's message mirror |
| `runtime.ts`    | Bot identity, user and channel caches, actor and audience resolution                                                                                              |
| `identity.ts`   | Account links, one-time link tokens, access requests, held messages                                                                                               |
| `onboarding.ts` | First-contact flow: link invite, or admin-approval request; replays the held message after linking                                                                |
| `link-page.ts`  | The "Connect Mattermost to QM" confirmation pages                                                                                                                 |
| `inbound.ts`    | WebSocket events → mirror, mention and thread gating, context, files → `app.turn`                                                                                 |
| `live.ts`       | 👀 acknowledgement, "Working…" placeholder, streaming preview edits, cleanup                                                                                      |
| `outbound.ts`   | Delivery relay for `mattermost`, `principal` and `group` destinations                                                                                             |
| `cards.ts`      | Interactive cards (approvals, credentials, app access, QM access) and button signing                                                                              |
| `actions.ts`    | Button callbacks                                                                                                                                                  |
| `directory.ts`  | People, channel and group sync into QM's directory                                                                                                                |
| `context.ts`    | Mid-turn context pulls (`surface-context`), opening group messages                                                                                                |
| `resume.ts`     | Continues a request after the person signs in to a per-user OAuth MCP server (e.g. OpenProject)                                                                   |
| `surface.ts`    | The `Surface` object registered with core                                                                                                                         |

## Behaviour

- **DM the bot.** It replies in the DM, one continuous session per DM. A reply in a DM thread stays in that thread.
- **@mention the bot in a channel or group message.** It replies in the thread, one session per thread.
- **Followed threads.** Later messages in a thread the bot is part of reach it as ambient turns, and QM's turn detection decides whether to answer. A new top-level message needs a fresh @mention.
- **Live progress.** The bot adds 👀 to your message and posts "⏳ Working…". It edits that post with the streaming text about once a second, then replaces it with the final answer and removes 👀.
- **Reactions.**
  - The agent writes `[[react: …]]` directives, which are applied to messages.
  - A user's reaction on one of the bot's own messages reaches the agent as an ambient turn.
- **Files.** Up to 10 files per message, 100 MB each, in both directions.
- **Proactive messages.**
  - DMs to a person: a `principal` delivery to their email.
  - Channel posts: reach to `#channel`.
  - Group messages: reach with `participants`.
  - Crons and monitors post the same way.
- **Approvals.**
  - Command approvals arrive as a card with _Allow once / session / always / Deny_ in the requester's DM. A channel thread shows "waiting for your approval".
  - Credential (keychain) and app-access requests use cards as well.
- **Identity.** Mattermost and QM keep separate accounts. On first contact the bot sends a one-time link (15 minutes, single use). The person signs in to QM with the same email as their verified Mattermost email and confirms. The link is stored by Mattermost user id; their held message is then answered.
  - If the email is not yet allowed in QM, QM org admins get an _Approve / Deny_ card in Mattermost.
  - Approving admits the email as a QM teammate (the same as the Admin → Invite teammate action) and sends the link.
  - `unlink` and `whoami` work in a DM.
- **Per-user tools (OAuth MCP servers).** When a request needs the person's own account on a tool such as OpenProject, the bot replies with a _Connect_ link. After they sign in there, the bot continues the same request in the same conversation, as them. A revoked connection is forgotten and asks to connect again.
- **Isolation.** These rules come from core:
  - a DM uses the person's personal scope;
  - a channel uses `channel:<id>`;
  - a group message uses `group:<id>`.
  - The audience is the channel's members by verified email. The bot refuses to answer where someone has no verified email.

## Not available compared with Slack

These are intentionally out of scope:

- **The pinned AI-assistant panel (`agent_view`).** Mattermost has no bot API for UI panes.
- **Slack Connect external access.** It is a paid Mattermost feature, and everyone on this server is internal.
- **Per-user workspace search with a user token.** The bot can read channels it is in.

## Configuration

| Env                               | Meaning                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATTERMOST_URL`                  | Mattermost base URL as core reaches it (here `http://mm-zq-app:8065` over the internal `qm-mm` network)                                      |
| `MATTERMOST_BOT_TOKEN`            | Bot access token (secret, in `.env`, passed via `secretEnv`)                                                                                 |
| `MATTERMOST_TEAM`                 | Team name (`zq`)                                                                                                                             |
| `MATTERMOST_ACTION_URL`           | Base URL Mattermost uses for button callbacks (here `http://qm-zq-core:8000`; must be in Mattermost's `AllowedUntrustedInternalConnections`) |
| `MATTERMOST_QM_PUBLIC_URL`        | Public QM URL for link pages (defaults to `PUBLIC_WEB_URL`)                                                                                  |
| `MATTERMOST_ACTION_SECRET`        | Optional; defaults to a key derived from `CORE_SIGNING_SECRET`                                                                               |
| `MATTERMOST_OWNS_DIRECT_MESSAGES` | `0` leaves `principal` and `group` deliveries and channel reach to Slack (default `1`)                                                       |
| `MATTERMOST_LABEL`                | Surface label shown to the agent (default "Mattermost")                                                                                      |
