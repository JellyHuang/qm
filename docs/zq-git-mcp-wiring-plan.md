# Wiring plan: git MCP client, author mapping and patch packages

Status: PLAN ONLY, written 2026-11-17. Nothing is implemented by this document and nothing is enabled. Facts below come from reading `oa/zq-git-mcp` (`0f5fd6543`), `oa/zq-author-map` (`d47076db5`), `oa/zq-patch-package` (`0795dd8df`) and `oa/zq-jenkins-rerun` (`3ae3d3ff5`); the Postgres, Mattermost and real-service behaviour was not run. Estimates are the author's judgement, not measurements.

## Plain summary (15 lines)

1. Three features exist only as libraries with tests: the QM-side git MCP client and commit poller (`src/zq/git-mcp`), author mapping, and patch packages. Nothing calls them. `ZQ_GIT_MCP_URL`, `ZQ_GIT_MCP_SECRET` and `ZQ_GIT_AUTHOR_MAPPING` are parsed and then ignored.
2. "Wiring" means four concrete things: (a) a way for the agent to call the 9 git tools, (b) a scheduled poll of `check_updates` that feeds author mapping and then a notification, (c) an agent tool that builds a patch package, (d) retention and delivery of the package.
3. For (a), configuration alone does NOT work today. The registered-connector route is the right one, but the core refuses loopback addresses for MCP servers and the service binds only `127.0.0.1`. One of the two must change (small plugin setting, or an in-process agent tool).
4. The contract forces `check_updates` into the agent's tool list. An agent that echoes an `ack` could advance the stored branch tips and make the poller miss commits. Needs a guard.
5. For (b), the poller, the author mapper and a recording sink are tested; missing are the runtime function, the settings switches, the people directory adapter and the real notification sink. Pattern to copy: the Jenkins poller (own function, own condition, lease key, sweeper).
6. For (c), the patch package builder needs a local git repository that holds the base commit. QM core has no clone and must not get the SSH key. This is a design gap that needs a spike before any code.
7. For (d), the retention design needs a table that the PM has not approved.
8. Seven phases, each default-off behind its own switch, each with a staging check (steps, expected result, stop condition, rollback).
9. Rough effort: phase 1 about 4 to 10 hours, phase 2 8, phase 3 7, phase 4 8, phase 5 13, phase 6 20, phase 7 4; about 65 to 70 hours of work plus review cycles.
10. Default-off proof for every phase: spies show no durable map requested, no sweeper created, no timer, no HTTP request, no agent tool offered.
11. Tables: none new before phase 3 (the two author tables, DDL already approved); the patch retention table in phase 6 is not approved.
12. PM decisions needed: company and retired email domains, bot and external lists, alias seeds (phase 3); Mattermost channel id and who receives unmapped authors, owner map (phase 4); ticket format, author identity, large-binary rule (phase 5); recipient rule, directory, upload limit, table approval (phase 6).
13. PR split: one small PR per phase, each through the merge queue with its Wall of shame report and a configuration and schema disclosure; the four existing branches are merged first as a separate step (see `docs/zq-git-mcp-staging-plan.md`).
14. Nothing here touches production; every staging step is read-only toward GitLab.
15. Recommended first move: the PM chooses the agent-tool route (section 2), because it decides whether the plugin changes.

## 1. What each feature is today and what wiring means

| Feature            | Today (library)                                                                                                                                                                                                                | What "wired" means                                                                                                                                                | Where                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QM-side git client | `createGitMcpClient`, `verify()`, `checkUpdates()` in `src/zq/git-mcp/client.ts`; contract in `contract.ts`                                                                                                                    | agent calls the git tools; a job calls `check_updates`                                                                                                            | agent: connector registration or a tool in `src/agent/agent-tools/`; job: section 3                                                                                                                                 |
| Commit poller      | `createGitCommitPoller` in `poller.ts`: `check_updates`, handler, then ack, up to 20 rounds                                                                                                                                    | a sweeper under a leader lease that runs it every 5 minutes                                                                                                       | new `src/zq/git-mcp/runtime.ts`, built in `src/wiring.ts` next to the zq runtime (line 2657 area), started and stopped where `zq?.start()` and `zq?.stop()` are (lines 3116 and 3156)                               |
| Author mapping     | `createAuthorMapping` (author-map branch) returns `{ mapper, queue, aliases, sink }`, `undefined` unless `ZQ_GIT_AUTHOR_MAPPING=1`; default sink records in memory; `createMattermostPeopleDirectory(mmUserIdsOfEmail)` exists | `mapper.handle` becomes the poller's handler; the directory is fed by `chat.mmUserIdsOfEmail` (already in the `ZqChat` that wiring builds); a real sink sends DMs | same runtime function                                                                                                                                                                                               |
| Patch package      | `buildTextPatchPackage`, `buildXlsxPackage`, `fetchCompleteDiff` (patch-package branch)                                                                                                                                        | an agent tool that builds one and a delivery path to the responsible person                                                                                       | tool: `src/agent/agent-tools/zq.ts` pattern (`zq_add_child_orders` goes through a `ToolContext` method), new `src/zq/patch-package/service.ts`; delivery: Mattermost `upload` (`src/surfaces/mattermost/client.ts`) |

Rules that hold for every phase: with all switches off nothing changes. The durable-map layer registers a table's migrations the moment the map object is built and `src/start.ts` applies them at boot, so a map must never be requested unless its own switch is on. Setting `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET` alone must never start anything; each phase has its own switch. Source of truth for what is in the settings: `src/zq/config.ts` lines 95 to 135 (`gitMcp`, `gitAuthors`).

## 2. How the agent would call the 9 git tools

### 2.1 What the repo already allows by configuration

Admin MCP registration (`PUT /v1/admin/mcp-servers/<id>`, `src/api/routes/admin/mcp-servers.ts`, admin only) stores an `McpServer` record: url, `auth: "bearer"`, `bearerToken`, `readOnly`, `toolContract`, `attestActor`, `approval` (`annotations` default, `all`, `none`). `createMcpToolService` (`src/mcp/mcp-tool-service.ts`) lists the server's tools, checks them against `toolContract` at save and every refresh, and offers them to every scope's agents under the name `<serverId>_<tool>` (for example `zq-git_list_commits`). `docs/zq/gitlab-mcp-client.md` has the registration body. The same service object is what the zq runtime uses for OpenProject jobs (`call: (name, args, principalId) => mcpToolService.call(...)`, `src/wiring.ts:2666`). With `attestActor` the signed-in person goes to the service as `x-qm-actor`, which the service uses as the audit label.

So the agent can use the tools with configuration only, if the registration succeeds.

### 2.2 Two problems found

1. Loopback is refused. The connector fetch is `publicFetch` (`src/util/network.ts`, `createPublicFetch`): private addresses are refused unless the exact origin is in `PRIVATE_NETWORK_ALLOWED_ORIGINS`, and loopback, link-local and metadata addresses are refused even when listed ("which PRIVATE_NETWORK_ALLOWED_ORIGINS never allows"; the config parser rejects such an entry at startup). The registration example in `docs/zq/gitlab-mcp-client.md` uses `http://127.0.0.1:8765/mcp`. The service binds `127.0.0.1` hard-coded (`plugins/zq-git-mcp/src/service.ts:163`). As written, the registration cannot work. The poller's own client (`createGitMcpClient`) uses the MCP SDK transport directly, not `publicFetch`, so loopback works for jobs.
2. `check_updates` is exposed to agents. The contract requires exactly the nine names, so the registered server offers `check_updates` as well. It records first observations and, when given `ack` entries, advances the stored tips. An agent that passes an ack could make the poller skip commits. This is a state-changing tool offered through a `readOnly: true` registration.

### 2.3 Options

| Option                                                                         | What changes                                                                                                                                                                                   | Effort                 | Notes                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Connector registration, service reachable on a private non-loopback address | plugin: a bind-host setting (default `127.0.0.1`, unchanged by default), docs; core config: `PRIVATE_NETWORK_ALLOWED_ORIGINS` lists the service origin; admin registers the server             | about 4 hours plus ops | Weakens "loopback only": the service is then reachable on the private network and is protected by the bearer secret only. Needs the PM's approval and a firewall rule. Agents get the 9 tools with no QM code                        |
| B. In-process agent tool using the direct client                               | a tool (for example `zq_git`) in `src/agent/agent-tools/`, a `ToolContext` method, wiring; exposes the 8 read tools, not `check_updates`                                                       | about 8 to 10 hours    | Keeps the service on loopback and keeps `check_updates` out of the agent's reach. Costs a tool description to maintain (the removed `git_*` tools were this) and loses `attestActor`; the caller label would be set by QM per person |
| C. A plus a guard                                                              | A, plus the plugin refuses `ack` unless the caller label is the poller's (`ZQ_GIT_MCP_ACK_CALLER`), or marks `check_updates` as destructive so the `annotations` approval policy asks a person | about 3 more hours     | Needed with A; not needed with B                                                                                                                                                                                                     |

Recommendation: B if the service stays on the same host as QM and the PM wants loopback only; A with C if QM runs where loopback is not shared (containers) and a private address is acceptable. This is the first PM decision. Whether annotations are honoured for `check_updates` in the plugin was not verified.

## 3. Polling job: poller, author mapper, sink

Chain per tick (as tested today): `check_updates` -> batches -> `handle(batches)` -> only after success `check_updates` with `ack`, repeated up to 20 rounds. Failure of the handler means no ack, so the same commits return (at least once). The queue counts a sha once, so retries do not inflate counts.

Handler composition (new code only for the two bold parts):

1. poller (`createGitCommitPoller`, exists)
2. **runtime function** `createGitMcpRuntime(deps)` in `src/zq/git-mcp/runtime.ts`, same shape as the Jenkins one in `docs/zq-jenkins-wiring-options.md`: returns `undefined` unless its switch is on; takes `config`, `map`, `leaderLease`, `createSweeper`, `chat` pieces and `now`; wraps the sweeper in `leaderLease.hold("zq:git-mcp", ...)`; calls `client.verify()` at start and on each refresh and reports a contract violation as an error rather than polling.
3. author mapper (`createAuthorMapping(...).mapper.handle`, exists on the author-map branch; people directory from `createMattermostPeopleDirectory(chat.mmUserIdsOfEmail)`)
4. **sink**: phase 3 the recording sink; phase 4 a Mattermost sink that sends one DM per person (`chat.sendDm(mmUserIdOf(person))`) with repo, branch, sha and subject only, plus a digest of unmapped authors to the PM.

Where: `src/wiring.ts`, directly after the zq runtime is built (line 2688) and in the start and stop lists (3116, 3156). `createZqRuntime` is not touched.

Settings introduced (all default off, environment only, parsed in `src/zq/config.ts`):

| Phase | Switch                                    | Default     | Meaning                                                                                          |
| ----- | ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| 2     | `ZQ_GIT_POLL`                             | off         | needs `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET`; polls and acknowledges, handler only logs counts |
| 2     | `ZQ_GIT_POLL_SECONDS`                     | 300         | interval, bounded like `ZQ_JENKINS_POLL_SECONDS`                                                 |
| 3     | `ZQ_GIT_AUTHOR_MAPPING`                   | off, exists | needs `ZQ_GIT_POLL`; creates the two author tables; records, sends nothing                       |
| 4     | `ZQ_GIT_NOTIFY`                           | off         | needs the mapping on; sends DMs instead of recording                                             |
| 4     | `ZQ_GIT_NOTIFY_CHANNEL`                   | unset       | Mattermost channel id for the unmapped-author digest (PM decision)                               |
| 5     | `ZQ_PATCH_AGENT`                          | off         | offers the patch package tool to the agent                                                       |
| 6     | `ZQ_PATCH_RETAIN` and its five companions | off         | design in `docs/zq/patch-package-retention.md`, not approved                                     |

Existing settings that keep their meaning: `ZQ_GIT_MCP_URL`, `ZQ_GIT_MCP_SECRET` (together or not at all), `ZQ_GIT_EXTERNAL_DOMAINS`, `ZQ_GIT_BOT_NAMES`, `ZQ_GIT_DOMAIN_ALIASES`, `ZQ_GIT_IGNORED_REOPEN_DAYS`, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`, `ZQ_PATCH_*` (six).

## 4. Who consumes a patch package and how the agent asks for one

Consumer: the responsible person (a developer), who applies the package with `git am --3way --keep-cr` and commits it themselves. QM never pushes and never opens a merge request. The decided delivery channel is a Mattermost direct message with the zip attached; the recipient rule (author of the commit, assignee of the ticket, or a fixed person) is not decided.

Agent request: a tool `zq_patch_package` with arguments `repo`, `base` (full commit id), `paths`, `ticket`, `subject`, `body`, and for spreadsheets the workbook the agent produced. It follows the `zq_add_child_orders` pattern: tool in `src/agent/agent-tools/`, a `ToolContext` method, a service function, offered only when the switch is on and the turn is not read-only. The tool never delivers by itself in phase 5: it builds the package into the output directory and answers with the manifest summary; delivery is phase 6. Text changes use `fetchCompleteDiff` to read a diff with explicit paths (refused if one file is longer than one response), or a working copy; spreadsheets use `xlsxPager` plus the modified file.

Design gap, found by reading `text.ts`: `buildTextPatchPackage` needs `repoDir`, a local repository that contains `baseCommit`; the scratch repositories borrow objects through alternates, with no remote and `GIT_ALLOW_PROTOCOL=none`. The service holds blobless clones that cannot serve blobs offline, and the SSH key must never reach QM. Options for the spike (phase 5, first step): (a) build the base files of the touched paths from `read_file` into a small scratch repository and apply the diff to that, so no clone is needed (preferred, needs a new builder input); (b) a read-only deploy key on a QM-side clone (breaks the "key only in the service" rule); (c) build inside the service as a tenth tool (breaks the nine-tool contract). The choice affects the plugin and the contract, so it is a PM and design decision. The spike is written up in `docs/zq-patch-package-repo-source.md` (recommends option (a), with a local experiment and the decisions it needs).

## 5. Phases, estimates, risks and staging checks

Every phase is merged with its switch off. "Default-off test" lists the spies that must show nothing happens; they are written first and must fail on a version that wires unconditionally. Staging is always read-only toward GitLab.

### Phase 1: agent access to the read tools (2.3 option A+C or B)

- Work: A+C: plugin bind-host setting and ack guard (about 4 to 5 hours with tests), docs, config entry, registration by an admin. B: tool, `ToolContext` method, tests (8 to 10 hours). Risks: A widens the network exposure; B adds a tool surface to maintain.
- Switch: A: registration by an admin is the switch (no registration, no tools). B: `ZQ_GIT_AGENT=1`. No tables in QM.
- Default-off test: A: nothing in core changes. B: the agent tool list has no `zq_git*` tool with the switch off and the map spy has no request.
- Staging check: register (A) or switch on (B); ask the agent to run `list_repos`, `list_commits` on `gameconfig` and `read_file` on a small file; expect JSON results, audit rows in the service with the person label (A: `x-qm-actor`; B: the caller label). Stop if any call mutates anything, or `check_updates` is callable with an ack by the agent (A without C). Rollback: delete the registration (A) or unset the switch (B).

### Phase 2: poll in dry-run (about 8 hours)

- Work: `createGitMcpRuntime`, config switch, wiring, handler that logs counts only, verify at start and refresh. Tests: fake service with the real client (the existing poller test pattern). Risk: double polling in a blue-green deploy, covered by the lease key `zq:git-mcp`; a handler that throws blocks the ack by design.
- Default-off test: with only URL and secret set, the fake service sees zero requests, no sweeper is created, no map requested. With `ZQ_GIT_POLL=1` only: one sweeper, requests to the fake service only, no map requested (this phase creates no table in QM).
- Staging check: set the switch with the service on memory stores. Expect: the first poll records baselines and reports nothing; the journal shows counts; a second poll reports `unchanged`. To see commits, move one stored tip back in the staging database as described in the service handoff (step 7), and expect the commits once, then none after the ack. Stop on: any error line of kind `unreachable` that repeats, contract violation, or the same commits delivered twice after an ack. Rollback: unset `ZQ_GIT_POLL`; the service state stays valid.

### Phase 3: author mapping, recording only (about 7 hours)

- Work: compose `mapper.handle` into the poller; directory adapter from `chat.mmUserIdsOfEmail`; settings (`ZQ_GIT_AUTHOR_MAPPING` exists). Tables: `zq_git_author_aliases` and `zq_git_unmapped_authors`, DDL approved in section 8 of `docs/zq-git-mcp-ddl-proposal.md`, created when the switch is on at the next start. PM supplies the domains and lists first.
- Default-off test: with the switch off (also with `ZQ_GIT_POLL=1`) the map spy requests neither author table; with it on, exactly these two. This runtime does not go through `createZqRuntime`, so it requests none of the base zq tables.
- Staging check: expect two new tables with tenant policy; unmapped queue rows for authors without a match; zero Mattermost messages; the recording sink holds the notices in memory only. Stop on: a message sent, an address in a log line (only `hashEmail` may appear), or a table created while the switch was off. Rollback: unset the switch; tables and rows stay inert; `DROP TABLE` as in section 8.

### Phase 4: live notification (about 8 hours)

- Work: the Mattermost sink (text in Chinese like the other zq notices; no commit message body, only subject), digest to the PM, `ZQ_GIT_NOTIFY`, `ZQ_GIT_NOTIFY_CHANNEL`. Risk: DMs to the wrong person; mitigated by dry-run first (phase 3 queue reviewed by the PM) and a one-person allowlist during staging (setting to be added in this phase, default empty means everyone mapped).
- Default-off test: with the switch off, the chat spy sees zero sends; with it on and the allowlist set, only the listed person receives.
- Staging check: one test user maps to one commit author; push is not needed, move a tip back; expect exactly one DM with repo, branch, sha, subject; a second poll sends nothing. Stop on: a duplicate DM, a DM to anyone else, a message in a channel other than the configured one. Rollback: unset `ZQ_GIT_NOTIFY` (back to recording).

### Phase 5: patch package tool, local output only (about 13 hours)

- Work: the repo-source spike (section 4, 3 hours), then the service function and the tool (about 6), tests (about 4). The ticket format and author identity are provisional defaults until the PM decides.
- Default-off test: with `ZQ_PATCH_AGENT` off the agent tool list has no patch tool and no directory is created; the git runner spy sees no process.
- Staging check: ask for a package for a small text change and a small xlsx change; expect a directory with the `.patch`, `manifest.json` and `verified: true`, and `git am --3way --keep-cr` of it in a throwaway clone without a remote reproduces the intended tree. Stop on: any `git push`, `fetch`, `clone` or `remote` call (the runner allowlist already forbids them), a package in a temporary directory that survives a reboot being treated as retained. Rollback: unset the switch; the output directory can be deleted.

### Phase 6: retention and delivery (about 20 hours)

- Work: as `docs/zq/patch-package-retention.md`: table `zq_patch_packages` (NOT approved), zip, DM with attachment, retries, cleanup. Needs a PM approval of the table before any code builds that map.
- Default-off test: with `ZQ_PATCH_RETAIN` off no map named `zq_patch_packages` is requested and no timer exists.
- Staging check: build, deliver to a test user, expect one DM with the zip and the manifest hash; kill the sender mid-way and expect no double post; expire a package and expect the directory gone and the record marked. Stop on: a double delivery, a delivery to a deactivated user without a `failed` row. Rollback: unset the switch; drop the table only after the PM agrees.

### Phase 7: scheduled pruning (about 4 hours)

- Work: one sweeper under a lease that runs the three existing unscheduled prune functions (`pruneGitAudit`, the unmapped queue `prune`, the Jenkins `pruneAudit`), behind a new switch (name to be chosen), default off.
- Default-off test: nothing scheduled and no delete issued when off. Staging check: run once against rows older than the window; expect only those rows deleted and open queue entries untouched. Rollback: unset the switch.

## 6. PM decisions needed

| Phase | Decision                                                                                                                                                                                                                       | Why it blocks                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1     | route A or B; if A, the private address and firewall rule                                                                                                                                                                      | decides whether the plugin changes                                           |
| 3     | company email domains and retired domains, bot names, external domains, alias seeds, confirmation that Mattermost verified emails are the directory                                                                            | the mapping rules are data; an empty list sends every author to the PM queue |
| 4     | Mattermost channel id for the digest, who "the PM" is for unmapped authors, message wording, the owner map (who is responsible when an author maps to nobody; the Jenkins owner map `ZQ_JENKINS_OWNERS` is a separate setting) | notices need a destination                                                   |
| 5     | ticket id format (default `WP-<digits>` or a number is provisional), author identity (default `QM Bot <qm-bot@invalid>` decided), large binary threshold, the repo-source route for the builder                                | the package text and its limits                                              |
| 6     | recipient rule, persistent directory and backup, Mattermost upload limit, approval of the table, expiry of records                                                                                                             | retention and delivery                                                       |

## 7. Pull request split

Each PR is small, targets this fork's branch, lands through the merge queue when its checks and reviews pass (no `--admin`), and carries: the Wall of shame report (Haiku triage then one fresh reviewer per relevant lens, verdict and score tied to the head commit), a configuration disclosure (every new switch with default, precedence and supported combinations), and a schema disclosure (tables, keys, JSON shapes, before and after rows labelled as invented, or the statement "no schema change"). No PR mentions an upstream issue or PR by number.

0. Merge the four existing branches in the order of `docs/zq-git-mcp-staging-plan.md` (merge commits, not squash) after the knip fixes; this is the base of everything here.
1. Phase 1 plugin PR (bind host and ack guard) if option A, else the tool PR (B).
2. Phase 2: runtime function, switch, wiring, tests. No schema change, one new switch pair.
3. Phase 3: composition and directory adapter. Schema: the two approved author tables, only with the switch on.
4. Phase 4: sink and notification switches.
5. Phase 5: builder input spike result (docs), then the tool.
6. Phase 6: only after the table approval; one PR for the table and cleanup, one for delivery.
7. Phase 7: prune sweeper.

A PR that grows beyond its phase is split again. Front-end demo evidence is not needed (no UI); Slack and Mattermost surfaces need screenshots or logs per the repository rule, and phases 4 and 6 need a live dev instance check.

## 8. What this plan does not verify

The registration failure for loopback is read from `src/util/network.ts` and not reproduced against a running core. The plugin's handling of tool annotations, the Mattermost sink text and the `read_file`-based builder input are untested ideas. Hour figures are estimates. No database, Mattermost, Jenkins or GitLab was contacted.
