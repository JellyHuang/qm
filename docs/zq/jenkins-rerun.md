# Jenkins automatic rerun (design, not implemented)

Status: proposal, awaiting Jelly's explicit OK. Plan B (`buildWithParameters`) is the chosen direction; nobody has objected, but nothing is built and no write request is sent until Jelly says OK and approves a controlled verification on a harmless job. No Jenkins call, write or read, exists in QM code.

## Findings from the read-only check

A read-only check against the real Jenkins (version 2.568.3, account `AI-Agent`, handle `jenkins-qm-bot`) found:

- Exactly eight jobs are visible, the whitelist below.
- The parameters of the last completed builds are all readable and none is masked. Empty-string parameters are real values (for example `CONFIG` and `BUILD` of `Server-Run`, `COMMIT_END_HASH` and `VCPKG_INCLUDE_SRC` of `Server-Clang-Tidy`) and are passed back as empty.
- Builds are started by the upstream `Trigger-*` jobs, by hand or by a timer. No "rebuilt" cause exists.
- Console text is readable, but Jenkins ignores `Range` requests and returns the whole log (about 127 KB), so QM reads it fully under a hard size cap and takes the tail itself.
- `Server-Run` #6235 is paused on an input step. A build waiting for input is not a failure and is never rerun; only finished builds with result `FAILURE` qualify.
- **The account has more than the design needs.** The "Rebuild" link on the build page points to `/replay`, and the Replay form opens, so the account holds Run/Replay. It can also open "Edit Build Information", so it holds Run/Update. Jelly decided to leave both as they are; the client contains no code path that uses either.
- **The Rebuild plugin was not detected** (`/rebuild` returns 404; the plugin list needs a permission the account lacks).

## Decision recap

- A failed build is rerun automatically **once**, as a **full rerun with the original parameters**, by posting them to `buildWithParameters` (plan B). The Rebuild plugin is not installed, so it is not used. Pipeline Replay is not used.
- Only failures classified as transient infrastructure or network problems are rerun. Everything else is reported, never rerun.
- A rerun that fails again is not rerun again. QM posts to the backend group channel and mentions the responsible person.

## Rerun mechanism: plan B, `buildWithParameters`

- QM reads every parameter of the failed build (names and values), then posts all of them, verbatim and including empty strings, to `/job/<job>/buildWithParameters`. A job without parameters is started with `/build`.
- Each POST carries a crumb fetched for that request from the crumb issuer, never cached or reused.
- The new build's cause is "Started by user AI-Agent", so Jenkins does not mark it as a rerun. The once-only guarantee therefore rests only on QM's own table:
  - The claim row in `zq_jenkins_reruns` exists before the request is made.
  - The response carries the queue item location. QM resolves it to the new build number and stores that number on the claim row. A failed build whose number is stored on any claim row is never rerun, whatever its cause says.
  - No marker is written into Jenkins (build description needs Run/Update) and no parameter is added or changed to carry one.
- A build that is queued, running, or paused on an input step is never a candidate. Only finished builds with result `FAILURE` qualify.
- The client has one write method, `rerun(job, number)`, and no other POST. It contains no code path that uses Replay or Edit Build Information.
- Nothing is sent before Jelly's explicit OK and a controlled verification on a harmless test job.

## Identity and permissions

One dedicated Jenkins account (`jenkins-qm-bot`, the AI-Agent account), created and handed over by Jelly, authenticated with its password over HTTP Basic. The password lives in QM's credential store under the handle `jenkins-qm-bot`, never in chat, Git or logs. If Jenkins later issues an API token for the account, the token replaces the password with no other change.

Granted permissions, and nothing else:

| Permission   | Why                                               |
| ------------ | ------------------------------------------------- |
| Overall/Read | Reach Jenkins                                     |
| Job/Read     | Read builds, console logs, parameters, changesets |
| Job/Build    | Start the rerun                                   |

Scope: exactly the jobs the account can see, listed in the next section. The design needs only the three permissions above. The read-only check found that the account also holds Run/Replay and Run/Update (it can open the Replay form and Edit Build Information). Jelly decided to leave them as they are. QM's client therefore has no code path that uses them: it can neither replay a pipeline with an edited script nor edit build information. Everything else (Job/Configure, Job/Create, Job/Delete, Run/Delete, Overall/Administer, Credentials, Agent/Configure) is not granted and not used.

The same account reads for monitoring. The QM client for it exposes exactly one write, `rerun(job, number)`; there is no generic POST in the client, so a code path cannot call anything else.

## Job whitelist

Monitoring and automatic rerun cover exactly these eight Jenkins jobs, matched by exact full job name: `CheckServerConfig`, `LLM-Wiki`, `PackageSent`, `Server-Build`, `Server-Clang-Tidy`, `Server-CodeReview`, `Server-Config`, `Server-Run`. The `Trigger-*` jobs and `Triger-Build-Config` are out of scope and are never read or rerun. Any other job name is refused before a request is made.

`jenkinstasks` is a Git repository (one of the seven read-only repositories in `gitlab-readonly.md`), not a Jenkins job, and does not appear in this whitelist.

Accepted risk, decided by Jelly: `Server-Run` has a `DROP_DATABASE` parameter and `PackageSent` publishes a package. A rerun repeats the original parameters exactly, so a failed build that dropped the database or sent a package is repeated as it was. The mitigations are the ones in this document: only transient infrastructure failures qualify, only once per failure, parameters must be read completely, and every rerun is announced and logged. A job can be taken out of the rerun whitelist by configuration at any time without a code change.

## What triggers a rerun

1. A build of a whitelisted job ends with result `FAILURE`. `ABORTED`, `UNSTABLE` and `NOT_BUILT` are ignored.
2. The build is not itself a rerun created by QM (see the once-only rule).
3. The failure is classified `network_transient` by the deterministic pattern list below, with the matching log line quoted as evidence.
4. The job is on the rerun whitelist, the per-job hourly cap is not reached, and the kill switch is on.
5. The original build's parameters were read completely (see Parameters).

Classification is rules over the log tail, the failed stage and exit codes: connection reset or refused, timeouts, name resolution failures, 502 or 503 from artifact repositories, TLS handshake failures, `git fetch` transport errors, agent disconnects. The pattern list is configuration owned by the PM. A language model never decides a rerun; it may only write the explanation for failures classified `unknown`.

Other classes, never rerun, always reported: `config` (parse or validation error, with a changed config file in the build's changeset), `code` (compile or test failure), `unknown`.

## Once per failure, guaranteed by code

- Table `zq_jenkins_reruns` (durable, Postgres), key `job:buildNumber`, written with insert-if-absent **before** the rerun call. If the insert does not create the row, nothing is called.
- A build whose number is recorded as the result of an earlier rerun is never rerun, so a rerun of a rerun cannot happen. The table is the only record: Jenkins's own cause does not say it was a rerun.
- A crash between claim and call is not retried blindly: before acting on a claimed row older than a few minutes, QM asks Jenkins for builds of that job newer than the failed one and for the queue, and records a matching one instead of calling again; if it cannot tell, it does nothing and reports.
- A build that is waiting for input, queued, or still running is never a candidate.
- Per-job hourly cap and a global kill switch (`ZQ_JENKINS_RERUN`, default off).
- A job whose builds have unreadable or masked parameters can never be rerun automatically; it is reported instead.

## Parameters

A rerun carries the original build's parameters exactly: nothing changed, nothing added, nothing dropped.

1. Before the rerun QM reads the full parameter list of the failed build from Jenkins (names, types, values).
2. The rerun is requested with exactly those values, empty strings included.
3. QM refuses to rerun, and treats the build as not rerunnable, when the parameters cannot be read, when the list is incomplete (a parameter defined on the job and missing from the build, or the reverse), when any value is masked or unreadable (password and secret parameters), or when the job defines parameters the chosen mechanism cannot reproduce.
4. A refused rerun is not retried. QM posts to the backend group channel and mentions the responsible person, with the reason ("parameters unreadable" or "parameters incomplete") and the build link.
5. After the rerun QM compares the new build's parameters with the original's and records any difference in the log and the notice.

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
- Permission denied on the rerun: recorded, one alert, no retry.
- CSRF crumb: with password authentication Jenkins requires a crumb for POST requests; QM fetches one from the crumb issuer (it works for this account) for the single rerun request and never caches it.

## Open items before building

- Jelly's explicit OK for plan B, and a controlled verification on a harmless test job before any real job.
- A test job that can be made to fail on purpose with a network-like error, a config error and a code error.
- The backend group channel and the job owner map.
- The pattern list and the whitelist from Jelly.
