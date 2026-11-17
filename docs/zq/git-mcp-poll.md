# Git commit poll (phase 2, default off; phase 3 author mapping, default off)

QM asks the zq-git-mcp service for new commits on a schedule. With `ZQ_GIT_POLL=1` alone it only counts and logs them: no author mapping, no messages, no table in QM. With `ZQ_GIT_AUTHOR_MAPPING=1` as well (phase 3, see the last section) it also classifies each commit author and records them. It never sends a message in either case.

## What runs

`createGitMcpRuntime` (`src/zq/git-mcp/runtime.ts`) is built in `src/wiring.ts` next to the zq runtime, independent of `createZqRuntime` and of Mattermost. It returns nothing unless `ZQ_GIT_POLL=1`. When on, one sweeper runs under the leader lease `zq:git-mcp`, so only one instance polls. Each run, immediately at start and then every `ZQ_GIT_POLL_SECONDS`:

1. verify the service's tool list against the contract (a connect and a tool listing, no commit data);
2. poll `check_updates` as caller `qm-poller` (the one label, sent as `X-QM-Caller`; agents never see this tool);
3. hand the commits to the sink; only after the sink succeeded, acknowledge them.

## Switches

| Setting               | Default | Meaning                                                                                                            |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `ZQ_GIT_POLL`         | off     | `1` starts the poll. Needs `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET`; startup fails with a clear error without them |
| `ZQ_GIT_POLL_SECONDS` | 300     | Interval, integer from 30 through 3600; checked even while the poll is off                                         |

`ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET` alone start nothing. No new HTTP endpoint. `ZQ_GIT_POLL=1` alone requests no table and has no schema change.

## Delivery semantics

- At least once: the service moves a stored tip only when QM acknowledges. A failing sink means no acknowledgement and the commits come again on the next run. A lost acknowledgement does the same.
- The sink contract (`CommitSink`, `src/zq/git-mcp/sink.ts`) is idempotent by sha. `dedupeBySha(sink, capacity)` provides that with a bounded in-memory LRU of recent `repo + sha` keys (10,000), a sha is remembered only after the inner sink succeeded. This is a cache, not storage: a durable sink in a later phase must dedupe by sha in its own store, because the cache is empty after a restart.
- An unreachable service is a failure (`unreachable`), never "no updates".

## Restart and first run

The stored tips live in the service. After a QM restart the poller simply continues: only newer commits are reported, and a batch that was not acknowledged is reported again. On the very first observation of a repository the service records baselines and reports nothing; QM logs `baseline recorded for <repo>` and treats it as normal (result `baseline`).

## Failure modes and health

`status()` on the runtime returns `lastPollAt`, `lastResult`, `consecutiveFailures`, `pendingAck` (commits handed over but not acknowledged). Results: `ok`, `baseline`, `standby` (another instance holds the lease), `unreachable`, `service_error`, `handler_failed`, `contract_violation`.

- Contract violation (missing, forbidden or unexpected tools, raw git inputs): error log, no poll while it lasts, checked again every run so polling resumes once the service matches.
- Unreachable service: one error line, then at most one more per 10 minutes with the number of failures not logged; keeps trying each interval.
- A run still in flight when the next one is due is skipped.
- `stop()` halts the schedule and waits for the run in flight.

## Phase 3: author mapping composed into the poll (default off)

Setting: `ZQ_GIT_AUTHOR_MAPPING=1` (default off). Nothing else is new: the retention, reopen, bot, external and domain alias settings are described in `docs/zq/author-mapping.md`.

| Combination                                       | Result                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| defaults, URL and secret only, `ZQ_GIT_POLL=1`    | as phase 2: no author table requested, no directory lookup                                          |
| `ZQ_GIT_AUTHOR_MAPPING=1` without `ZQ_GIT_POLL=1` | startup configuration error: `ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1`                            |
| both on, Mattermost configured                    | the poll handler also runs the author mapper; the two tables below are created at the next start    |
| both on, Mattermost not configured                | startup error: `ZQ_GIT_AUTHOR_MAPPING needs Mattermost`; nothing is built and no table is requested |

Without a Mattermost directory every author would be classified unmapped and written to the durable queue as a false entry, so the combination is refused instead of warned about. The people directory is `createMattermostPeopleDirectory(mattermost.mmUserIdsOfEmail)`, passed to `createGitMcpRuntime` in `src/wiring.ts` only when Mattermost is configured.

Composition: the sink handed to `dedupeBySha` first logs the per-branch count line, then calls `mapper.handle(batches)`. The mapper classifies each commit (person, unmapped, ambiguous, bot, external), writes unmapped and ambiguous authors to the queue, and hands person groupings to the recording sink (memory only, `createRecordingSink`, injectable as `authorSink`). No message of any kind is sent; notification is a later phase behind its own switch. The sha is remembered by the LRU only after the whole handler succeeded; the queue also ignores shas it already counted, so a failed handler followed by a retry, or a restart that redelivers a batch, does not double a count. A directory or store failure fails the handler, nothing is acknowledged and the next run retries. The recording sink is memory only and is empty after a restart.

Tables created at the next start with both switches on, and only then: `zq_git_author_aliases` and `zq_git_unmapped_authors`, the approved DDL in `docs/zq-git-mcp-ddl-proposal.md` section 8 on `oa/spike-git` (listed in `docs/zq/author-mapping.md`). No other table is added. The queue prune function stays unscheduled. Log lines carry only email hashes (`hashEmail`), the reason and a count.

## Rollback

Unset `ZQ_GIT_AUTHOR_MAPPING` (and `ZQ_GIT_POLL` to stop the poll) and restart. The two tables stay and keep their rows.

Phase 2 rollback: unset `ZQ_GIT_POLL` and restart. The service's stored tips stay valid.
