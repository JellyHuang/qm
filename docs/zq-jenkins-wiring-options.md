# Jenkins poller wiring: can it be built without the other zq maps?

Status: ANALYSIS ONLY, written 2026-11-17. No code was changed. Every line number is from `oa/zq-jenkins-rerun` at `3ae3d3ff5` (code identical to `9d3ffaf95` apart from one unexported constant), files `src/wiring.ts`, `src/zq/runtime.ts`, `src/zq/config.ts`, `src/zq/jenkins/*`, `test/zq-jenkins-config.test.ts`, `test/zq-runtime.test.ts`.

## Plain summary

1. Problem: `ZQ_JENKINS_POLL=1` alone (with Mattermost configured and the Jenkins URL and bot credential set) creates seven tables, not three. The three Jenkins tables are expected. The four others (`zq_identity_map`, `zq_reminders`, `zq_report_drafts`, `zq_run_state`) come from `createZqRuntime`, which builds them at its top, and `src/wiring.ts:2657-2664` now builds the runtime when the poll switch is on.
2. The poller does not need any of those four. Its real dependencies are: the Jenkins settings, three durable maps (`zq_jenkins_builds`, `zq_jenkins_audit`, `zq_jenkins_notices`), the leader lease, the sweeper factory, an optional "post to channel" function, and an optional clock. It never calls OpenProject, the identity map, reminders or reports.
3. So yes, it can be built on its own. The smallest change moves the poller block (`src/zq/runtime.ts:199-247`) into its own function with its own condition, and wiring starts and stops it next to the zq runtime.
4. Recommended: do it (option B below), about 5 hours including tests and review, one small PR, no behaviour change with every switch off.
5. Risk is low: lease keys differ (`zq:jenkins` against `zq:scanner`), so the two never block each other; the sweeper label and the lease key stay the same. The one thing to get right is that wiring must stop the new object at shutdown.
6. A side finding: with `ZQ_JENKINS_POLL=1` and no Mattermost configured, the poller silently does not exist today (the runtime is only built `mattermost && ...`). The config check does not tell the operator.
7. Until option B is done, the approval of the poll switch has to accept the seven tables (paragraph in section 9 of `docs/zq-git-mcp-ddl-proposal.md`).

## 1. What happens today

`src/wiring.ts`:

```
2657  zq =
2658    mattermost &&
2659    (config.zq.scanner.enabled || config.zq.reports.enabled || config.zq.identityMap ||
2660     config.zq.childOrders || config.zq.jenkins.poll.enabled)
2664      ? createZqRuntime({ config: config.zq, call, chat, map: (table) => artifactMap(table), leaderLease, createSweeper })
2688      : null;
3116  zq?.start();      3156  zq?.stop(),
```

`src/zq/runtime.ts`, `createZqRuntime(deps)`:

- Lines 78-87 build the identity map, the reminder store and the report store with `deps.map("zq_identity_map")`, `deps.map("zq_reminders")`, `deps.map("zq_report_drafts")`. Line 158 requests `zq_run_state` for the service, and `people()` (line 90) requests `zq_identity_map` again. Nothing here is conditional on a switch.
- `zq_groups`, `zq_snapshots`, `zq_change_lines`, `zq_change_cursors` and `zq_child_drafts` are conditional on their own switches (lines 115-188), so they are not created by the poll switch.
- Lines 199-247 build the Jenkins poller only when `jenkins.poll.enabled && jenkins.url && jenkins.credential`, requesting `zq_jenkins_builds`, `zq_jenkins_audit` and `zq_jenkins_notices` there.
- Lines 252-258: `start()` starts the scanner sweeper only when `scanner` or `reports` is on, and always starts the poller if it exists; `stop()` stops both.

Why a map request creates a table: `createPostgresMap` registers its migrations the moment the map object is built (`src/persistence/durable-map.ts:176`), and `src/start.ts` runs `migrateRegisteredPgSchemas` at boot. Building the map is the creation, even if nothing is ever read or written.

Verified by reading, not run: this environment has no Postgres, and `test/zq-jenkins-config.test.ts` spies on the map factory but only filters the names that start with `zq_jenkins`, so no existing test shows the four extra names.

## 2. What the poller really needs

From `createJenkinsPoller({...})` in `src/zq/runtime.ts:202-246`:

| Dependency                                                                                 | Source today                                                          | Needs the zq runtime?                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Jenkins client (url, user, password, jobs)                                                 | `config.jenkins`                                                      | no, plain settings                                                                            |
| Policy (failure results, rerun jobs, causes, window, hourly cap, bot users, danger params) | `config.jenkins`                                                      | no                                                                                            |
| Three durable maps through `createJenkinsStore`                                            | `deps.map`                                                            | no, but the map factory must be passed in                                                     |
| Leader lease, key `zq:jenkins`                                                             | `deps.leaderLease`                                                    | no, the shared `leaderLease` of wiring                                                        |
| Sweeper factory                                                                            | `deps.createSweeper`                                                  | no, the shared one of wiring                                                                  |
| Notice sink                                                                                | `chat.postToChannel` when `notify.live`, else `createRecordingSink()` | only the one function `postToChannel`; the other eight `ZqChat` members are unused by Jenkins |
| Owner lookup                                                                               | `jenkins.owners[job] ?? jenkins.defaultOwner`                         | no, config                                                                                    |
| Clock                                                                                      | `deps.now` (tests only)                                               | no                                                                                            |
| Error log                                                                                  | `console.error`                                                       | no                                                                                            |
| `deps.call` (MCP calls), `identity`, `reminders`, `reports`, `contract`, `reader`          |                                                                       | not used                                                                                      |

So the zq runtime contributes only `postToChannel`, the lease and the sweeper factory, all of which wiring already holds.

## 3. Options

### A. Leave it and document (0 hours)

Already done in section 9 of the DDL proposal. Enabling the poll switch creates seven tables. Acceptable if the PM approves it knowingly, but it ties the Jenkins approval to the approval of four unrelated zq tables, and any later change that adds a base map to `createZqRuntime` silently adds a table to Jenkins-only installs.

### B. Build the poller as its own function with its own condition (recommended, about 5 hours)

New function `createJenkinsRuntime(deps)` in a new file `src/zq/jenkins/runtime.ts`:

```
createJenkinsRuntime({
  config: ZqConfig["jenkins"],
  map: <T>(table: string) => DurableMap<T>,
  leaderLease: LeaderLease,
  createSweeper,
  postToChannel?: (channelId: string, text: string) => Promise<void>,
  now?: () => number,
}): { start(): void; stop(): Promise<void> } | undefined
```

It returns `undefined` unless `poll.enabled && url && credential`, and otherwise contains exactly the block now at `runtime.ts:199-247` (client, store, policy, `noticeMode`, `sink`, `owner`, `onError`, the lease-wrapped sweeper).

Exact places to change:

1. `src/zq/jenkins/runtime.ts` (new): the moved block and its imports (`createJenkinsClient`, `createRecordingSink`, `createJenkinsPoller`, `createJenkinsStore` and the three record types).
2. `src/zq/runtime.ts`: delete lines 16-24 (imports) and 199-247, and in `start()` and `stop()` remove the two `jenkinsPoller` uses (lines 254 and 257). The `ZqRuntime` interface does not change.
3. `src/wiring.ts:2657-2664`: drop `|| config.zq.jenkins.poll.enabled` from the condition. After `zq = ...` (line 2688), add the Jenkins runtime, for example:
   `jenkins = mattermost && config.zq.jenkins.poll.enabled ? createJenkinsRuntime({ config: config.zq.jenkins, map: (table) => artifactMap(table), leaderLease, createSweeper, postToChannel: (channelId, text) => mattermost!.postToChannel(channelId, text) }) : undefined;`
   The `mattermost &&` keeps today's behaviour exactly (poller only exists with Mattermost). Dropping it is a separate decision (section 5).
4. `src/wiring.ts:3116` and `:3156`: add `jenkins?.start()` next to `zq?.start()` and `jenkins?.stop()` into the list that holds `zq?.stop()`. Without the stop the timer would leak at shutdown; a test must cover it.
5. `docs/zq/jenkins-auto-rerun.md` and section 9 of `docs/zq-git-mcp-ddl-proposal.md`: replace the "created together with four base tables" warning by the new, accurate sentence.

What stays unchanged on purpose: the lease key `zq:jenkins`, the sweeper label `zq jenkins poller` (set inside the poller), the three table names, the config parsing in `src/zq/config.ts` (no setting is added or changed), and the `ZqChat` interface.

Effort: moving the block and the wiring edit 1.5 hours; tests 2 hours; docs 0.5 hour; review fixes and the CI cycle through the merge queue 1 hour. Total about 5 hours. No schema change, no configuration change.

### C. Make the four base maps lazy inside `createZqRuntime` (about 4 hours, not recommended)

Build `identity`, `reminders`, `reports` and the service state only when a switch needs them. It leaves one place for everything, but it touches the scanner, reports and identity paths that have working tests and are in use, and `identityAdmin` (returned always and handed to the web admin) needs the identity map even when `identityMap` is off. More risk for the same result as B.

### D. A second flag that tells the runtime to skip the base maps (not recommended)

It adds a setting and a special case, which the repository rules ask to avoid.

## 4. Risks of option B and how they are covered

| Risk                                                         | Why it is small                                                                                                                                                                         | Cover                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Behaviour with every switch off changes                      | the poller is built only when `poll.enabled`; the runtime condition loses only the poll term, so with all switches off both are null, exactly as now                                    | test: with default configuration no map is requested (spy), no sweeper is created, no request goes out              |
| The poller no longer stops at shutdown                       | `stop()` moves out of `ZqRuntime`; the wiring list must include it                                                                                                                      | test on the new function (`start` then `stop` stops the sweeper once); a read of the wiring list in review          |
| Lease or sweeper interaction                                 | the poller already uses its own key `zq:jenkins` and its own sweeper; the scanner uses `zq:scanner`; the keys are independent, so a long scan cannot hold up the poller and the reverse | existing poller tests keep passing; add one test that two leases with the two keys run independently, only if cheap |
| Installs with poll and another zq switch                     | same tables as before (union of both), same keys and labels                                                                                                                             | test with `ZQ_SCANNER=1` and `ZQ_JENKINS_POLL=1`: requested names are the union and both sweepers exist             |
| An existing test builds the poller through `createZqRuntime` | `test/zq-jenkins-config.test.ts` line 115 calls `createZqRuntime` with Jenkins settings and finds the poller sweeper in the list                                                        | those tests move to `createJenkinsRuntime` (same assertions); `test/zq-runtime.test.ts` is untouched                |
| Silent no-op without Mattermost                              | exists today                                                                                                                                                                            | keep, or decide in section 5                                                                                        |

Needed from others: nothing. No PM decision is required for B itself.

## 5. Open decision (one line each)

- Should `ZQ_JENKINS_POLL=1` work without Mattermost (dry-run records notices in memory and reruns still need the live switch)? Today it silently does nothing. B can keep that (`mattermost &&`) or drop it (poller exists in every deployment that sets the switch). Recommendation: keep it in the first PR so that nothing new becomes reachable, and make it a visible startup error or a documented dependency in a later change.

## 6. Tests that would prove it

All in `test/zq-jenkins-config.test.ts` (moved to the new function), using the existing fake Jenkins server and the spy pattern already used there:

1. Default configuration, URL and credential set but no poll switch: `createJenkinsRuntime` returns `undefined`; the spy on `map` has no request at all; no sweeper was created; the fake Jenkins saw zero requests.
2. Only `ZQ_JENKINS_POLL=1` (plus URL and credential): the spy requested exactly `["zq_jenkins_builds", "zq_jenkins_audit", "zq_jenkins_notices"]` (sorted comparison), nothing else. This is the assertion that fails on the current code, which also requests the four base names, so it proves the fix.
3. The same case run through the wiring-level condition: a test of the pure condition, or a test that builds both `createZqRuntime` (switches off) and `createJenkinsRuntime` (poll on) with one shared spy and asserts the union is only the three names. This catches a regression where someone puts the poll term back into the runtime condition.
4. `start()` creates one sweeper labelled `zq jenkins poller`, `stop()` stops it, and a second `stop()` is harmless.
5. With `ZQ_SCANNER=1` and `ZQ_JENKINS_POLL=1`: the requested names are the union of the scanner set and the three; both sweepers exist and neither blocks the other's lease key.
6. The existing dry-run test (poll on, nothing is posted or sent) and the audit pruning test keep passing unchanged except for the constructor name.

Typecheck, eslint, oxlint and knip run as for any change; the new file exports one function that wiring imports, so knip stays clean.

## 7. Not verified here

No code was written or run for this analysis; the claims about which maps are requested come from reading `runtime.ts` and the map factory, and the suggested test 2 has not been executed against the current code (it would fail there by design). No database was contacted.
