# Jenkins automatic rerun (design, not implemented)

Status: design only. No Jenkins call, write or read, exists in QM. Nothing is built until the dedicated account is delivered and Jelly confirms the whitelist.

## Decision recap

- A failed build is rerun automatically **once**, as a **full rebuild** through the Rebuild plugin, keeping the original parameters. Pipeline Replay is not used.
- Only failures classified as transient infrastructure or network problems are rerun. Everything else is reported, never rerun.
- A rerun that fails again is not rerun again. QM posts to the backend group channel and mentions the responsible person.

## Identity and permissions

One dedicated Jenkins account, created and handed over by Jelly, authenticated with an API token (HTTP Basic, user plus token). The token lives in QM's credential store, never in chat, Git or logs.

Granted permissions, and nothing else:

| Permission   | Why                                               |
| ------------ | ------------------------------------------------- |
| Overall/Read | Reach Jenkins                                     |
| Job/Read     | Read builds, console logs, parameters, changesets |
| Job/Build    | Start the rebuild                                 |

Scope: the `jenkinstasks` folder and the jobs of the seven repositories, matched by full job name. Not granted: Job/Configure, Job/Create, Job/Delete, Run/Replay, Run/Update, Run/Delete, Overall/Administer, Credentials, Agent/Configure. Without Run/Replay the account cannot replay a pipeline with an edited script even if a bug asked it to.

The same account reads for monitoring. The QM client for it exposes exactly one write, `rebuild(job, number)`; there is no generic POST in the client, so a code path cannot call anything else.

## What triggers a rerun

1. A build of a whitelisted job ends with result `FAILURE`. `ABORTED`, `UNSTABLE` and `NOT_BUILT` are ignored.
2. The build is not itself a rebuild created by QM (see the once-only rule).
3. The failure is classified `network_transient` by the deterministic pattern list below, with the matching log line quoted as evidence.
4. The job is on the rerun whitelist, the per-job hourly cap is not reached, and the kill switch is on.
5. The original build's parameters were read completely (see Parameters).

Classification is rules over the log tail, the failed stage and exit codes: connection reset or refused, timeouts, name resolution failures, 502 or 503 from artifact repositories, TLS handshake failures, `git fetch` transport errors, agent disconnects. The pattern list is configuration owned by the PM. A language model never decides a rerun; it may only write the explanation for failures classified `unknown`.

Other classes, never rerun, always reported: `config` (parse or validation error, with a changed config file in the build's changeset), `code` (compile or test failure), `unknown`.

## Once per failure, guaranteed by code

- Table `zq_jenkins_reruns` (durable, Postgres), key `job:buildNumber`, written with insert-if-absent **before** the rebuild call. If the insert does not create the row, nothing is called.
- A build whose cause is "rebuilt from build N" where N is in the table is never rerun, so a rerun of a rerun cannot happen.
- A crash between claim and call is not retried blindly: before acting on a claimed row older than a few minutes, QM asks Jenkins whether a build with a rebuild cause from that build already exists, and records it instead of calling again.
- Per-job hourly cap and a global kill switch (`ZQ_JENKINS_RERUN`, default off).
- A job whose builds have unreadable or masked parameters can never be rerun automatically; it is reported instead.

## Parameters

A rerun carries the original build's parameters exactly: nothing changed, nothing added, nothing dropped.

1. Before the rebuild QM reads the full parameter list of the failed build from Jenkins (names, types, values).
2. The rebuild is requested with exactly those values.
3. QM refuses to rerun, and treats the build as not rerunnable, when the parameters cannot be read, when the list is incomplete (a parameter defined on the job and missing from the build, or the reverse), when any value is masked or unreadable (password and secret parameters), or when the job defines parameters the Rebuild plugin cannot reproduce.
4. A refused rerun is not retried. QM posts to the backend group channel and mentions the responsible person, with the reason ("parameters unreadable" or "parameters incomplete") and the build link.
5. After the rebuild QM compares the new build's parameters with the original's and records any difference in the log and the notice.

## When the rerun fails too

No further rerun. QM posts to the configured backend group channel and mentions the responsible person:

- The responsible person is the author of the latest commit in the failed build's changeset, mapped through the Git to OpenProject to Mattermost bindings. If that cannot be resolved, the job's configured owner is mentioned. If neither exists, the message goes to the channel without a mention.
- The message has the job, both build numbers and links, the classification with its evidence line, and a masked tail of the log. Secrets in the log are masked before posting.

When the rerun succeeds, a short notice goes to the same channel.

## Audit

Every decision is written to the proactive action log: trigger, rule and version, evidence, decision (rerun, skipped as not transient, duplicate, capped, kill switch, no permission), the Jenkins response, and the later outcome. A rerun is also announced in the channel when it is started.

## Observation

Preferred: Jenkins notifies QM when a build finishes (Notification or Generic Webhook plugin), verified by a shared secret. Fallback: poll each whitelisted job's last failed build on the scan cron, with a stored cursor per job.

## Configuration (planned)

- `ZQ_JENKINS_URL`, the credential for the dedicated account.
- `ZQ_JENKINS_RERUN` (`1` enables, default off).
- Whitelist of job names, transient pattern list, hourly cap, backend channel, job owner map.

## Failure handling

- Jenkins unreachable or token rejected: no rerun, one alert to the channel per outage, retry on the next scan.
- Permission denied on rebuild: recorded, one alert, no retry.
- CSRF crumb: a request with API-token Basic authentication does not need one; if the instance requires it, QM fetches a crumb for that request only.

## Open items before building

- Confirm the Rebuild plugin's endpoint and behaviour on this Jenkins (version, parameterised and pipeline jobs).
- A test job that can be made to fail on purpose with a network-like error, a config error and a code error.
- The backend group channel and the job owner map.
- The pattern list and the whitelist from Jelly.
