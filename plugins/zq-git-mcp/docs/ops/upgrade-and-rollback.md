# Upgrade and rollback

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval, with this rollback plan attached.

## Upgrade

1. Build the new release in `/opt/zq-git-mcp/releases/<new-id>/` (`plugins/zq-git-mcp` and `plugins/chassis`; `npm ci --omit=dev`). Run `npm test` and `npm run typecheck` there before switching.
2. Read the release notes for new or renamed settings; diff `config.example.env` against `/etc/zq-git-mcp/zq-git-mcp.env`. The config schema is strict: an unknown key in the JSON config file refuses to start.
3. If the release needs new database tables or grants, a DBA applies them by hand first (`database.md`); QM core migrations never create the tables of this service.
4. Point `/opt/zq-git-mcp/current` at the new release and `systemctl restart zq-git-mcp`.
5. Read the journal, run the smoke tests (`checklist.md`).

Downtime: a single instance, so a restart is a short outage (seconds; stop waits for in-flight calls up to `TimeoutStopSec`). Callers must treat unreachable as an error and retry. `check_updates` is at-least-once, so no commit is lost across the restart. True zero downtime would need two instances on different ports behind QM-side failover, which is not designed.

## Rollback of the service

1. `systemctl stop zq-git-mcp`.
2. Point `/opt/zq-git-mcp/current` back at the previous release.
3. Config unchanged (the env file is not touched by an upgrade unless a step above says so; if new keys were added, the old release ignores unknown environment variables).
4. `systemctl start zq-git-mcp`; smoke tests.

## Rollback of the database proposal

From section Rollback of the DDL proposal, run as database owner, only after the service is stopped or no longer configured with the database:

```
DROP TABLE IF EXISTS zq_git_blob_meta;
DROP TABLE IF EXISTS zq_git_branch_tips;
REVOKE ALL ON zq_git_audit FROM zq_git_mcp; DROP OWNED BY zq_git_mcp; DROP ROLE zq_git_mcp;
```

`zq_git_audit` and its rows stay (the extra JSON keys are harmless). No migration ledger rows exist for these tables (they are created by hand). Empty or replay the audit spool first if it is non-empty, or accept losing it.

## Rollback of core wiring

Commit `7f8eab470` ("Remove the in-process GitLab module from the core") is isolated on purpose. It removes: `src/zq/git/*` (audit, authors, limits, readonly, runner, validate), the six `git_*` agent tools (`src/agent/agent-tools/git.ts` and its registration), `ToolContext.gitCall` and its wiring in `src/wiring.ts` and `src/zq/runtime.ts`, the `ZQ_GIT_*` settings with the per-minute limits and the daily byte budget (`src/zq/config.ts`), the keychain key read inside the QM process, `scripts/zq-git-verify.ts`, three tests, and parts of `docs/zq/SEAMS.md` and `docs/zq/gitlab-readonly.md`. The commit author resolver (`authors.ts`) goes with it and returns with the QM-side client.

Restore order: first make sure the QM-side MCP client is in place and verified against the service. Only if the service must be abandoned, run `git revert 7f8eab470` on the branch that carries it (never rewrite the branch, the commit keeps its hash). The revert brings back the in-process module, the limits and the key read inside the QM process, so the key must then be placed in the QM keychain again, which is the situation this design removes; do it only with the PM's decision. Do not revert it while the QM side still depends on the service.

## Pre-go-live checklist

See `checklist.md`.
