# Jenkins automatic failure rerun (design)

Status: proposal and sandbox implementation. Nothing is deployed, nothing is enabled by default, and no real Jenkins is contacted by any test. This document applies the PM's rules and replaces the failure-classification rule of `docs/zq/jenkins-rerun.md` (a failed build is rerun once whatever the failure looked like; classification only records a hash). The rest of that document (read-only findings, plan B `buildWithParameters`, permissions, parameter fidelity, the eight jobs) still holds.

## PM rules

- Cover the eight confirmed jobs: `CheckServerConfig`, `LLM-Wiki`, `PackageSent`, `Server-Build`, `Server-Clang-Tidy`, `Server-CodeReview`, `Server-Config`, `Server-Run`. The list is the configuration value `ZQ_JENKINS_JOBS`; the code holds it only as the default of that setting.
- A failed build is rerun at most once.
- If the rerun also fails, QM notifies the backend group and mentions the responsible person. The group and the person lookup are configuration. Nothing is sent for real by default.

## State machine per failed build

One record per original build, key `<job>:<number>`, in the durable table `zq_jenkins_builds`.

| State             | Meaning                                                                                               | Next                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `observed`        | First sighting of a finished build with a counted result inside the time window. The row is the claim | `eligible`, `skipped`                                                                 |
| `eligible`        | Every rule passed. In dry-run the row stays here and one `dry_run_would_rerun` audit row says so      | `rerun_requested` (live only), `skipped` (re-evaluated, e.g. `superseded`, `too_old`) |
| `rerun_requested` | Claimed by exactly one instance (compare and swap). The POST is made only after the claim             | `rerun_running`, `skipped` (`request_rejected`, `circuit_open`, `claim_uncertain`)    |
| `rerun_running`   | The queue item resolved to a new build number, stored as `rerunNumber`                                | `rerun_succeeded`, `rerun_failed`                                                     |
| `rerun_succeeded` | The rerun finished `SUCCESS`. Terminal, no notification                                               |                                                                                       |
| `rerun_failed`    | The rerun finished with any other result, or vanished. A `rerun_failed` notice is queued              | `notified`                                                                            |
| `notified`        | The notice was delivered. Terminal                                                                    |                                                                                       |
| `skipped`         | Terminal, with `reason`. Some reasons also queue a `needs_attention` or `circuit_open` notice         |                                                                                       |

Skip reasons: `job_not_enabled`, `is_rerun`, `bot_triggered`, `manual_trigger`, `cause_not_allowed`, `chain_rerun`, `superseded`, `parameters_unreadable`, `parameters_incomplete`, `circuit_open`, `too_old`, `request_rejected`, `claim_uncertain`.

A build that is queued, running, or paused on an input step (`building` or no result) is never recorded and never acted on until it has a terminal result. A result that is not in the failure set (`SUCCESS`, and by default `UNSTABLE`, `ABORTED`, `NOT_BUILT`) is never recorded. A failed build older than the time window at first sight is not recorded either; it is only counted in the tick summary.

## Rules, in the order the decision engine applies them

`src/zq/jenkins/decision.ts` is a pure function of the build, the job's newer builds, the table and the configuration.

1. No terminal result: wait. Result not in `ZQ_JENKINS_FAILURE_RESULTS` (default `FAILURE`): ignore.
2. Older than `ZQ_JENKINS_MAX_AGE_MINUTES` (default 30) since it finished: `too_old`. This is what stops a restart, or the first start, from rerunning history. It is re-checked on every `eligible` row, so switching from dry-run to live later does not rerun stale failures.
3. The build number is the `rerunNumber` of any record of this job: `is_rerun`. A build whose cause is a user cause by the bot account itself: `bot_triggered` (covers a rerun whose POST succeeded but whose row was lost).
4. Job not in `ZQ_JENKINS_RERUN_JOBS` (default: every monitored job): `job_not_enabled`.
5. Causes. Each cause is classed `timer`, `scm`, `upstream`, `user`, `remote` or `other`. Every cause class of the build must be in `ZQ_JENKINS_RERUN_CAUSES` (default `timer,scm,upstream`). A failing human-triggered build (`user`) is therefore `manual_trigger`, and an unknown cause is `cause_not_allowed`. If the PM adds `user`, a human rebuild whose parameters equal those of a build QM reran in the last 24 hours is `chain_rerun`, so a human retry of a failure QM already retried is not retried a second time.
6. Superseded: any newer build of the same job (other than QM's own reruns) is still running or finished `SUCCESS`: `superseded`. A newer failure does not supersede.
7. Parameters (see below): masked, unreadable or incomplete: `parameters_unreadable` or `parameters_incomplete`, and a `needs_attention` notice.
8. Circuit breaker: the job already has `ZQ_JENKINS_RERUN_HOURLY_CAP` (default 3) claims in the last hour: `circuit_open`, and one `circuit_open` notice per job per clock hour. After a claim, each instance re-counts claims ordered by claim time and key and releases its own claim if it ranks beyond the cap, so two instances cannot together exceed it.
9. Otherwise `eligible`, and when `ZQ_JENKINS_RERUN=1` the rerun is claimed and sent.

## Exactly how duplicates are prevented

- Idempotency key: `<job>:<number>` of the original build. The first poller to see a failure inserts the row with `insertIfAbsent`. Every later transition is a compare and swap on the row's current state (`DurableMap.update`, which Postgres runs under a row lock): the caller learns whether it won and only the winner acts.
- The claim (`eligible` to `rerun_requested`) happens before the POST. A second poller, a restart, or an overlapping tick finds the row and does nothing for that build.
- The row is durable (Postgres). Nothing is deduplicated in memory. Restarting re-reads the table; two instances polling at once both see the same rows and only one wins each transition. In production the poller also runs under the leader lease `zq:jenkins`, so normally only one instance polls.
- The rerun is recognised as ours by three independent facts: its number is stored on the original's row; its cause is a user cause by the bot account; and it is never a candidate because it is a rerun (`is_rerun` before anything else).
- A crash between claim and POST: the row stays `rerun_requested` without a queue id. After 5 minutes QM looks at the job's newer builds for one started by the bot, not on any row, with identical parameters. A match is linked (`rerun_running`). A matching queue item means wait. Otherwise the row becomes `skipped: claim_uncertain` with a notice, and QM never POSTs again. A network error on the POST is treated the same way, because the request may have reached Jenkins. A definite HTTP rejection (crumb, 401, 403, 404) means no build was created: `skipped: request_rejected` with a notice.
- A crash between a state change and the notice: notices are rows with a deterministic key, inserted before the transition, and inserting twice is a no-op.
- Notices are delivered at most once: a notice is claimed `pending` to `sending` before the sink is called. A crash while `sending` loses that notice and leaves it visibly `sending`; a send error puts it back to `pending` for up to 5 attempts.

## Parameters

The rerun carries the original parameters verbatim, empty strings and duplicate names included, URL-encoded by `URLSearchParams`; a job without parameters is started with `build`. Before the POST QM re-reads the original build. It refuses when any parameter is masked or has no readable value (password, file, non-scalar), or when the names in the build differ from the names the job defines. Parameter values are never written to the audit table, the notices, the logs or errors: only names, counts and a SHA-256 fingerprint of the sorted pairs. After the rerun starts, QM compares the new build's parameters with the original's and stores the names that differ.

## Polling, windows, results

- Polling only; no webhook. `ZQ_JENKINS_POLL_SECONDS` (default 120). One sweeper tick reads the last 20 builds of each monitored job, advances in-flight rows, and delivers notices.
- The tick records, per tick, counts of ignored, waiting, observed, skipped and requested builds.
- Failure classification is a placeholder: for each observed failure QM reads the console, keeps only the SHA-256 of its last 4 KiB (`consoleTailHash`) and drops the text. The text is never stored or sent.

## Audit

`zq_jenkins_audit`, one row per decision, written once (deterministic key, `insertIfAbsent`): `{ id, at, job, number?, event, from?, to?, reason?, actor, detail? }`. Events: `observed`, every transition, `dry_run_would_rerun`, `notice_queued`, `notice_sent`, `poll_error` (at most one per job, kind and hour). `actor` is `poller`. `detail` carries names and counts only. `pruneAudit()` deletes rows older than 90 days; it exists but is not scheduled (see Tables).

## Notification

- Kinds: `rerun_failed` (the rerun also failed), `needs_attention` (parameters unreadable or incomplete, request rejected, claim uncertain), `circuit_open`.
- Content: job, build number and URL, result, rerun number, URL and result when present, and the mention of the responsible person. No parameter values, no log content, no credentials. Texts are Chinese like the other zq texts.
- Target: the channel id `ZQ_JENKINS_NOTIFY_CHANNEL`. Responsible person: `ZQ_JENKINS_OWNERS` (`job=username` pairs), else `ZQ_JENKINS_DEFAULT_OWNER`, else no mention. The lookup is an injected function, so the OpenProject binding lookup of the older design can replace it without touching the engine.
- Delivery goes through an injected sink. By default and in tests it is a recording sink (rows are marked `dry-run`). The real sink (`postToChannel`) is used only when `ZQ_JENKINS_NOTIFY=1`.

## Safety model and rollback

Three independent switches, all off:

1. `ZQ_JENKINS_POLL=1` starts the poller. Without `ZQ_JENKINS_RERUN`, it only observes, records and audits (dry-run).
2. `ZQ_JENKINS_RERUN=1` allows the real rerun POST. It needs `ZQ_JENKINS_POLL=1`.
3. `ZQ_JENKINS_NOTIFY=1` allows real channel posts. It needs `ZQ_JENKINS_POLL=1` and `ZQ_JENKINS_NOTIFY_CHANNEL`.

With default configuration nothing polls, nothing is requested and nothing is sent (tested). Rollback: unset `ZQ_JENKINS_RERUN` (reruns stop at the next restart), or unset `ZQ_JENKINS_POLL` (everything stops). Rows stay as the record. No table exists until the PM approves the DDL in Tables: with `ZQ_JENKINS_POLL` off the three maps are never built, so nothing is created.

## Credentials

The credential `jenkins-qm-bot` reaches QM through its own environment, never Git:

- `JENKINS_QM_BOT_USER` (the account name, for example `AI-Agent`)
- `JENKINS_QM_BOT_TOKEN` (an API token, preferred) or `JENKINS_QM_BOT_PASSWORD`; the token wins when both are set.

They are sent only as an HTTP Basic header. The client wraps every failure so that the secret, and its base64 form, cannot appear in an error message; neither appears in a row or a notice.

## Tables (not yet approved)

Status: NOT YET APPROVED. No table is created until the PM approves this DDL. Nothing here has been applied; no database was contacted. The shapes below come from the code in `src/zq/jenkins/store.ts` and from how the durable-map layer builds a table (`src/persistence/durable-map.ts`, `src/tenants/migrations.ts`).

### When the tables come into existence

The durable-map layer registers a table's migrations the moment the map object is built, and `src/start.ts` runs `migrateRegisteredPgSchemas` at boot. So constructing a map creates its table at the next start, in every environment. The Jenkins code is therefore built so that the three maps are never built unless `ZQ_JENKINS_POLL=1`:

- `src/zq/runtime.ts` calls `deps.map("zq_jenkins_builds")`, `deps.map("zq_jenkins_audit")` and `deps.map("zq_jenkins_notices")` only inside the branch that creates the poller, which needs `ZQ_JENKINS_POLL=1`, `ZQ_JENKINS_URL` and the bot credential. With the default configuration no `deps.map` call is made for these names.
- A test (`test/zq-jenkins-config.test.ts`) puts a spy on the map factory: zero requests for `zq_jenkins_*` under default configuration and with only a URL and credential set; exactly the three names when the poll switch is on.
- `src/wiring.ts` creates the runtime when the poll switch is on, in addition to the existing switches. With the poll switch off its condition is unchanged.

### DDL the durable-map layer would create (per table, three times)

For each of `zq_jenkins_builds`, `zq_jenkins_audit`, `zq_jenkins_notices` (no secondary index fields are declared, so there is no index besides the primary key):

```sql
CREATE TABLE IF NOT EXISTS <table> (id TEXT PRIMARY KEY, json JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL);
ALTER TABLE <table> ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant if rows exist>;
CREATE UNIQUE INDEX CONCURRENTLY <table>_tenant_pkey ON <table> (tenant_id, id);
ALTER TABLE <table> DROP CONSTRAINT <table>_pkey, ADD CONSTRAINT <table>_pkey PRIMARY KEY USING INDEX <table>_tenant_pkey;
ALTER TABLE <table> ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE <table> ADD CONSTRAINT <table>_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table> USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

Result per table: `id TEXT NOT NULL`, `json JSONB NOT NULL`, `tenant_id UUID NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, row level security with the `tenant_isolation` policy, no CHECK constraints. Migration ids are `durable-map/<table>/0001` and `durable-map/<table>/0010-tenants/*`; the claim functions `claim_<table>` and `claim_<table>_tenants` are also created by the layer. Every write also bumps `durable_map_versions (tenant_id, tbl)`.

### Shapes

All timestamps are epoch milliseconds. All example rows are INVENTED.

`zq_jenkins_builds`, `id` = `<job>:<number>` of the original build (the idempotency key):

```json
{
  "job": "Server-Build",
  "number": 812,
  "state": "rerun_failed",
  "reason": null,
  "url": "https://jenkins.example/job/Server-Build/812/",
  "result": "FAILURE",
  "finishedAt": 1763000040000,
  "observedAt": 1763000070000,
  "updatedAt": 1763000400000,
  "causes": ["timer"],
  "fingerprint": "<sha256 of the sorted name/value pairs>",
  "parameterCount": 4,
  "consoleTailHash": "<sha256 of the last 4 KiB>",
  "claimedAt": 1763000100000,
  "queueId": 501,
  "rerunNumber": 813,
  "rerunUrl": "https://jenkins.example/job/Server-Build/813/",
  "rerunResult": "FAILURE",
  "parameterDifferences": []
}
```

Keys that are absent are not stored (`reason`, `consoleTailHash`, `claimedAt`, `queueId`, `rerunNumber`, `rerunUrl`, `rerunResult`, `parameterDifferences`). `state` is one of `observed`, `eligible`, `rerun_requested`, `rerun_running`, `rerun_succeeded`, `rerun_failed`, `notified`, `skipped`. `reason` (with `skipped`) is one of `job_not_enabled`, `is_rerun`, `bot_triggered`, `manual_trigger`, `cause_not_allowed`, `chain_rerun`, `superseded`, `parameters_unreadable`, `parameters_incomplete`, `circuit_open`, `too_old`, `request_rejected`, `claim_uncertain`. `causes` values are `timer`, `scm`, `upstream`, `user`, `remote`, `other`. No parameter value, no console text and no credential is stored: only a count, a fingerprint and a hash.

`zq_jenkins_audit`, `id` = `<job>:<number>:<event>` (state changes use the new state as the event), `notice` events use `<notice id>:notice_queued|notice_sent|notice_failed`, errors use `poll:<job>:<kind>:<hour>`:

```json
{
  "id": "Server-Build:812:rerun_requested",
  "at": 1763000100000,
  "job": "Server-Build",
  "number": 812,
  "event": "rerun_requested",
  "from": "eligible",
  "to": "rerun_requested",
  "actor": "poller"
}
```

Optional keys: `number`, `from`, `to`, `reason`, `detail` (names and counts only). `actor` is always `poller`.

`zq_jenkins_notices`, `id` = `<job>:<number>:<kind>`, or `breaker:<job>:<hour>`:

```json
{
  "id": "Server-Build:812:rerun_failed",
  "kind": "rerun_failed",
  "job": "Server-Build",
  "number": 812,
  "channelId": "backend-group",
  "text": "Jenkins ...",
  "mode": "dry-run",
  "status": "pending",
  "attempts": 0,
  "createdAt": 1763000400000
}
```

`kind` is `rerun_failed`, `needs_attention` or `circuit_open`; `status` is `pending`, `sending`, `sent` or `failed`; `mode` is `dry-run` or `live`; `sentAt` is added when sent. The text has the job, build numbers, URLs, results and an owner mention; no parameters, no log content.

Before and after: all three tables are new. Nothing existing is changed, moved or dropped. The earlier proposed `zq_jenkins_reruns` is not created.

### Retention

`zq_jenkins_audit` is recommended at 90 days. `createJenkinsStore(...).pruneAudit()` (`src/zq/jenkins/store.ts`) deletes rows whose `at` is older than 90 days through the same function as `pruneGitAudit`; it is tested and NOT scheduled, so nothing deletes anything until the PM approves a schedule. `zq_jenkins_builds` and `zq_jenkins_notices` have no pruning (one row per failed build; low volume); a retention for them is an open decision.

### Grants

Core application role only (the role QM core already runs as, with the existing `qm db grant` privileges: SELECT, INSERT, UPDATE, DELETE, TRUNCATE). No service role is created and no new grant is needed. The tenant is bound per connection by the core as for every other map.

### Rollout and rollback

Rollout: merge the code with every switch off (no table is created); after the PM approves, set `ZQ_JENKINS_URL`, the credential and `ZQ_JENKINS_POLL=1` (dry-run); the next start creates the three tables and the poller only observes. Real reruns and notices are separate switches (`ZQ_JENKINS_RERUN`, `ZQ_JENKINS_NOTIFY`).

Rollback: unset `ZQ_JENKINS_POLL` (the maps are no longer built; the tables and rows stay and are inert). To remove the data, after the poller is off: `DROP TABLE IF EXISTS zq_jenkins_notices, zq_jenkins_audit, zq_jenkins_builds;`. Dropping `zq_jenkins_builds` discards the once-only record, so do it only with `ZQ_JENKINS_RERUN` unset.

## Configuration

| Setting                                         | Default              | Meaning                                                                                                  |
| ----------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `ZQ_JENKINS_URL`                                | unset                | Jenkins base URL, required by the switches below                                                         |
| `JENKINS_QM_BOT_USER`, `_TOKEN`, `_PASSWORD`    | unset                | Credential, see above; the poll switch needs the user and one secret                                     |
| `ZQ_JENKINS_POLL`                               | off                  | Run the poller (observe only)                                                                            |
| `ZQ_JENKINS_RERUN`                              | off                  | Send real reruns (existing name)                                                                         |
| `ZQ_JENKINS_NOTIFY`, `_NOTIFY_CHANNEL`          | off, unset           | Real notices and their channel id                                                                        |
| `ZQ_JENKINS_JOBS`                               | the eight jobs       | Monitored jobs (existing)                                                                                |
| `ZQ_JENKINS_RERUN_JOBS`                         | every monitored job  | Jobs that may be rerun; changed from "none" so the PM's eight-job scope holds by default (existing name) |
| `ZQ_JENKINS_RERUN_HOURLY_CAP`                   | `3`                  | Claims per job per hour (existing)                                                                       |
| `ZQ_JENKINS_POLL_SECONDS`                       | `120`                | 30 to 3600                                                                                               |
| `ZQ_JENKINS_MAX_AGE_MINUTES`                    | `30`                 | 1 to 1440                                                                                                |
| `ZQ_JENKINS_FAILURE_RESULTS`                    | `FAILURE`            | Subset of `FAILURE,UNSTABLE,ABORTED,NOT_BUILT`                                                           |
| `ZQ_JENKINS_RERUN_CAUSES`                       | `timer,scm,upstream` | Cause classes whose failures may be rerun; add `user`, `remote`, `other` to widen                        |
| `ZQ_JENKINS_OWNERS`, `ZQ_JENKINS_DEFAULT_OWNER` | unset                | Responsible-person lookup (`Server-Build=alice,Server-Run=bob`, and a fallback)                          |

Precedence: environment only; a setting that is unset takes the default shown; an invalid value refuses startup.

## Probe

`scripts/zq-jenkins-readonly-probe.sh` checks a real Jenkins with only GET requests: authentication, the eight jobs, and the last five builds of each (result, time, cause class, whether the parameters read completely). It prints counts only. It reads `ZQ_JENKINS_URL`, `JENKINS_QM_BOT_USER` and `JENKINS_QM_BOT_TOKEN` or `JENKINS_QM_BOT_PASSWORD`.

## Open decisions for the PM

1. Default rerun scope: all eight jobs, including `Server-Run` (`DROP_DATABASE` parameter) and `PackageSent` (publishes). Recommendation: start live with the six that have no destructive side effect, keep those two out through `ZQ_JENKINS_RERUN_JOBS` until a verified sandbox run.
2. Should a failed human-triggered build be rerun? Recommendation: no (the default); add `user` only after the first weeks of dry-run data.
3. Should `UNSTABLE` count as failure? Recommendation: no.
4. Hourly cap per job. Recommendation: 3, as now; the breaker also notifies, so a bad hour is visible.
5. Time window of 30 minutes. Recommendation: keep; it is also the longest outage after which a failure is silently not retried.
6. Responsible person: static job-to-person map, or the last committer through the Git, OpenProject and Mattermost bindings as the older design says. Recommendation: static map now, committer lookup later behind the same function.
7. Notice wording and language, and whether a successful rerun should post a one-line notice. Recommendation: Chinese, failures only (the PM's rule), no success notice.
8. Audit retention. Recommendation: 90 days for the audit table via `pruneAudit()` (exists, unscheduled); decide whether the other two tables are ever pruned.
9. Outage alert: Jenkins unreachable or the credential rejected is only logged and audited once per hour, not posted. Recommendation: post one notice per outage once the channel exists.
10. A bot cause is recognised by account name. Recommendation: confirm the exact `userId` Jenkins shows for the AI-Agent account (it may differ from the login name); the read-only probe prints cause classes so this can be checked.
