# Git commit poll (phase 2, default off)

QM asks the zq-git-mcp service for new commits on a schedule and, in this phase, only counts and logs them. No author mapping, no messages, no table in QM.

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

`ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET` alone start nothing. No new HTTP endpoint, no other setting, no schema change, no table.

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

## Rollback

Unset `ZQ_GIT_POLL` and restart. The service's stored tips stay valid.
