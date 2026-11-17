# Author mapping

After `check_updates` (through the poller) reports new commits, each commit author is classified so that a person can later be told about their commits. In this change nobody is contacted: delivery goes through an injected `AuthorNotificationSink`, and the default sink only records.

People are recognised by the git author NAME, not by email. Emails change at will and QM account emails exist for password reset, so an email is only an optional condition on a row and an attribute shown to the PM. Only the author fields are read, never the committer. The design is `docs/zq-author-binding-design.md` on `oa/spike-git` (approved at design level on 2026-11-17).

## Names

One function (`src/zq/git-mcp/names.ts`) normalises names for every writer and reader (bind, unbind, ignore, resolver, queue, log hash): Unicode NFKC, invisible format characters removed (zero-width space, BOM, directional marks), whitespace runs collapsed to one space and trimmed, lower case. Not folded: a `DOMAIN\` or `HOST\` prefix, hyphen, underscore, dot and apostrophe variants, Chinese versus pinyin names, accents. Each variant is its own name and is bound on its own. A name has 1 to 100 characters after normalisation.

Emails (conditions and attributes) are trimmed and lower-cased only. A plus tag is no longer stripped.

## Rules

`createAuthorResolver` (`src/zq/git-mcp/authors.ts`) takes the first rule that applies:

1. Person row: the row for this name has `kind: "person"` and its email condition is absent or equals the commit author email. Result `person { personId, mattermostUser, matchedBy: "name" }`, plus `departed: true` when the row says so.
2. Ignore row: the row has `kind: "ignored"` and its condition is absent or matches. Result `ignored { reason }`, dropped: no notice, no queue row, only a log counter.
3. Bot: the name or the local part of a usable email is in `ZQ_GIT_BOT_NAMES` (exact, normalised), or one of its word tokens is in `ZQ_GIT_BOT_TOKENS` (default `bot`). Tokens split on every non-alphanumeric character, between letters and digits and at camelCase boundaries including an acronym run before a capitalised word (`ExampleBot` is `Example`, `Bot`; `renovate[bot]` and `build2bot` match; `Abbott`, `Talbot`, `Botha`, `Robotham` do not). A fused word (`dependabot`, `EXAMPLEBOT`) is one token and does not match; add it to `ZQ_GIT_BOT_NAMES` or the ignore list. The domain is never examined. A bot keeps being a bot even when its email belongs to a departed person.
4. External: a usable email (one `@`, non-empty local part and domain) whose domain equals or is under a domain in `ZQ_GIT_EXTERNAL_DOMAINS`.
5. Mattermost email fallback, only with `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK=1`: a usable email equal to the verified email of exactly one Mattermost user is `person { matchedBy: "mattermost_email" }`; several users are `ambiguous`. Never authoritative: it runs last.
6. Everything else is `unmapped` and queued by name, with reason `no_match`, or `invalid_email` when the email is not usable (no `@`, empty local part or domain, several `@`). A malformed email is never dropped as `invalid_email` or `external`; the author is handled by name.

A bound name always beats the bot, external and fallback rules; a self-bind of a bot-looking name is refused for people (an administrator may do it, audited). Rows 1 and 2 are exclusive for one name because both are the same row id.

Only `person` without `departed` is handed to the sink's `deliver`. `departed` persons go to `deliverToPm` (the PM, not the person) and are not queued. `unmapped` and `ambiguous` go to the unmapped queue. `bot`, `external` and `ignored` are dropped.

Generic names (`ZQ_GIT_GENERIC_NAMES`, default `admin,administrator,root,test,user,git,unknown,pc`; the part after the last backslash, or the whole name, equals an item) can only be bound or ignored together with an email condition, for people and for administrators alike. An unbound generic name is queued under its name and its email. The backslash split is used for this test only, never for matching.

## Data sources

The repository has no people table. The people of a name row are the principals who bound the names (`personId` is the canonical principal id, `mattermostUser` comes from `mmUserIdOf` when Mattermost is configured and otherwise equals the principal id). The only email-to-person source is the Mattermost surface: `ZqChat.mmUserIdsOfEmail(email)` (`src/surfaces/mattermost/index.ts`), used by `createMattermostPeopleDirectory(mmUserIdsOfEmail)` only when `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK=1`; there `personId` and `mattermostUser` are the Mattermost user id. The `PeopleDirectory` interface (`findByEmail(email): Promise<Person[]>`) is the seam; `createMemoryPeopleDirectory` serves tests. How a Mattermost user maps to a QM principal is not verified (see the end).

## The name table

Durable table `zq_git_author_aliases`, one row per normalised name. Id: the name key, with `%` written `%25` and `|` written `%7C`. Value:

| Field            | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `nameKey`        | the normalised name (equals the id before escaping)                                              |
| `name`           | the name after NFKC and whitespace collapse, for display only                                    |
| `kind`           | `person` or `ignored`                                                                            |
| `emailCondition` | optional, normalised exact string; the row applies only to a commit whose author email equals it |
| `personId`       | `person` only: the canonical principal id                                                        |
| `mattermostUser` | `person` only                                                                                    |
| `reason`         | `ignored` only, required: `automation` or `external`                                             |
| `departedAt`     | optional epoch ms on `person` rows of a departed person                                          |
| `addedBy`        | principal id of the actor (the person for a self bind, the administrator otherwise)              |
| `addedAt`        | epoch ms                                                                                         |

Examples (invented): id `alice example`, `{ "nameKey": "alice example", "name": "Alice Example", "kind": "person", "personId": "p-alice", "mattermostUser": "mm-alice", "addedBy": "p-alice", "addedAt": 1763100000000 }`; id `host123\admin`, `{ "nameKey": "host123\\admin", "name": "HOST123\\admin", "kind": "person", "emailCondition": "x@y.example", "personId": "p-fred", "mattermostUser": "mm-fred", "addedBy": "pm", "addedAt": 1763100100000 }`; id `pipeline-sync`, `{ "nameKey": "pipeline-sync", "name": "pipeline-sync", "kind": "ignored", "reason": "automation", "emailCondition": "@partnerco", "addedBy": "pm", "addedAt": 1763100200000 }`.

The only uniqueness is the primary key `(tenant_id, id)`, so a name can never be bound to two people or be bound and ignored; inserts use `insertIfAbsent`, so of two concurrent binds exactly one wins.

## Unmapped queue

Durable table `zq_git_unmapped_authors`. Id: `<nameKey>` (escaped); for a generic name `<nameKey>|<email>`; `email:<email>` when the name is empty; `(none)` when both are empty. Value: `{ nameKey, emails (up to 10 distinct normalised emails seen with this name), name (last seen), reason: "no_match" | "invalid_email" | "ambiguous", candidates: personId[], status: "open" | "resolved" | "ignored", firstSeenAt, lastSeenAt, count, exampleRepo, exampleSha, recentShas (last 200), closedBy?, closedAt?, personId? }`. Example (invented): id `alice example`, `{ "nameKey": "alice example", "name": "Alice Example", "emails": ["alice.example@example.invalid", "a@personal.example"], "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1000, "lastSeenAt": 2000, "count": 7, "exampleRepo": "client", "exampleSha": "a1b2c3d", "recentShas": ["a1b2c3d"] }`.

- Upsert is idempotent: one row per name, and a commit sha already in `recentShas` is not counted again, so a poller retry after a failed handler does not inflate the count. The example is the first commit seen.
- Only author name, emails, repo, sha and times are stored. No commit message, subject or diff.
- `queue.resolve(author, personId, by)` closes the row as `resolved` (a bind or an ignore does this); if the name row is later removed and the author shows up again, the entry reopens.
- `queue.ignore(author, by)` marks it `ignored` (a silenced row that keeps counting); `queue.list(status = "open")` lists by status. The ignore list does not use this status: an ignored name produces no queue row at all.
- `ZQ_GIT_IGNORED_REOPEN_DAYS` (default `0`, off) reopens a queue entry in `ignored` status when the author is seen again that many days after it was ignored.
- Retention: `queue.prune()` (cutoff `unmappedCutoff(now, days)`, default 180 days, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`) deletes resolved and ignored entries whose later of closed time and last-seen time is older than the cutoff. Open entries are never pruned. It is not scheduled and not called from startup, like `pruneGitAudit`.

The field `askedAt` of the design (for the PM digest) is not part of this change.

## Processing

`createAuthorMapper({ resolver, queue, sink, log? })` has `map(batches)`, taking the poller's `CommitBatch[]`, and `handle(batches)`, which has the shape of the poller's `handle`. `map` returns per-commit classification, `byPerson`, `departed`, `unmapped` and `ignored` (counts per name hash and reason). It resolves each distinct name and email pair once, records each unmapped or ambiguous name in the queue, then calls the sink once per person. Delivery is at least once: if the sink throws, `handle` throws, the poller does not acknowledge, and the next tick delivers the same commits again (the queue does not double count).

`createAuthorMapping({ config, directory?, map, sink?, audit?, mattermostUserOf?, now?, log? })` assembles resolver, tables, queue, mapper and, with `ZQ_GIT_AUTHOR_BIND=1`, the identity service from `ZqConfig.gitAuthors`. The default sink is `createRecordingSink()`, which keeps person notices, PM notices for departed people and holder notices in memory and sends nothing. `createGitMcpRuntime` composes `mapper.handle` into the poll handler when `ZQ_GIT_AUTHOR_MAPPING=1` (see `docs/zq/git-mcp-poll.md`, phase 3).

Logs carry only hashes (first 12 hex characters of SHA-256 of the normalised value): `zq git author needs review: <nameHash> <emailHash> <reason> commits=<n>` and `zq git author ignored: <nameHash> reason=<automation|external> commits=<n>`. Names and addresses appear only in the durable tables, in sink calls and in replies to the person or administrator who asked. Dropped (ignored) commits are counted in the log only: no per-commit audit and no durable counter.

## The `zq_git_identity` tool

Offered only with `ZQ_GIT_AUTHOR_BIND=1`, never in a read-only turn. Every reply that binds ends with how to find a git name: run `git config user.name` (and `git config user.email`) inside a repository; it can differ per computer, so bind each name you see, including `DOMAIN\name` forms.

| Operation                                                        | Who                  | Arguments                           | Effect                                                           |
| ---------------------------------------------------------------- | -------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `bind`                                                           | the signed-in person | `names` (1 to 5), optional `email`  | binds the names to the caller                                    |
| `list`                                                           | the signed-in person | none                                | the caller's own names                                           |
| `unbind`                                                         | the signed-in person | `name`                              | removes the caller's own name                                    |
| `bind_for`                                                       | identity admin       | `person`, `names`, optional `email` | the same for another person; closes the queue row                |
| `unbind_for`                                                     | identity admin       | `person`, `name`                    | removes that person's name                                       |
| `depart` / `undepart`                                            | identity admin       | `person`                            | sets or clears `departedAt` on every row of the person           |
| `ignore_add` / `ignore_list` / `ignore_remove` / `ignore_import` | identity admin       | see below                           | the ignore list                                                  |
| `list_unmapped`                                                  | identity admin       | optional `status`                   | queue rows with real names, emails, counts, example repo and sha |

Self operations take the caller from the authenticated actor of the turn (`attestedPerson(createdBy)`); a `person` argument is rejected. They need a human-initiated turn. Identity admins are org admins (`admin.operationsAvailable`) plus the principals in `ZQ_GIT_IDENTITY_ADMINS`, and admin operations work only in the administrator's own private conversation.

Bind rules, in order: normalise (1 to 100 characters); refuse a bot-looking name for a person (an administrator may, audited as `bot_name`); refuse a generic name without an email condition; refuse a departed person's self-bind; if a row for the name exists, refuse always. The reply to a person says to change the git name (for example `<name>01`, `git config user.name`) or ask the PM and does not name the holder; the holder gets a notice that someone tried to claim the name (through the sink, recorded only); the administrator's refusal names the holder. Then the cap `ZQ_GIT_BIND_MAX_PER_PERSON` (self path), then `insertIfAbsent`.

Ignore list: `ignore_add { name, reason: automation | external, email? }` (refused if bound, already ignored, or generic without a condition), `ignore_list { reason? }`, `ignore_remove { name, email? }` (the author reappears in the queue at the next sighting), `ignore_import { entries: [{ name, email?, reason }], apply }`. `apply` defaults to false: the reply lists per entry `would add`, `unchanged` or `refused: <reason>` (duplicate within the entries, bound to a person, generic without a condition, bad reason, exists with another reason or condition) with counts per reason, and nothing changes. With `apply` it adds; a second run is all `unchanged`; it never removes rows missing from the entries and never changes the reason of an existing row. Seed data is supplied by the PM at deployment time and never enters the repository.

Audit uses the existing `AuditLog` (`action` `zq_git.identity.<operation>`, resource a name hash and the person id, status `ok`, `refused`, `not_found` or `dry_run`); names and emails never appear in audit rows, only hashes. The import audit row carries counts and a hash of the payload, never its content.

## Configuration

| Setting                            | Default                                             | Meaning                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZQ_GIT_AUTHOR_MAPPING`            | off                                                 | `1` turns the layer on and needs `ZQ_GIT_POLL=1` (startup error otherwise). Off: no durable map requested, no table touched                                              |
| `ZQ_GIT_AUTHOR_BIND`               | off                                                 | `1` offers `zq_git_identity`; needs `ZQ_GIT_AUTHOR_MAPPING=1` (startup error otherwise)                                                                                  |
| `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK` | off                                                 | `1` adds rule 5; needs `ZQ_GIT_AUTHOR_MAPPING=1` and Mattermost (startup error otherwise). Off: the directory is never called and Mattermost is not required for mapping |
| `ZQ_GIT_BOT_NAMES`                 | empty                                               | Exact bot names or email local parts (normalised)                                                                                                                        |
| `ZQ_GIT_BOT_TOKENS`                | `bot`                                               | Word tokens that make a name or local part a bot; the empty string disables the token rule; each token `^[a-z0-9]{2,32}$`, at most 50                                    |
| `ZQ_GIT_EXTERNAL_DOMAINS`          | empty                                               | Non-company domains, dropped when no row claims the name; usable emails only; sub-domains match                                                                          |
| `ZQ_GIT_GENERIC_NAMES`             | `admin,administrator,root,test,user,git,unknown,pc` | Names that need an email condition to be bound or ignored; empty disables; items without `\`                                                                             |
| `ZQ_GIT_IDENTITY_ADMINS`           | empty                                               | Principals allowed admin operations besides org admins; items of 1 to 256 visible ASCII characters                                                                       |
| `ZQ_GIT_BIND_MAX_PER_PERSON`       | `10`                                                | Names per person on the self path; 1 to 100                                                                                                                              |
| `ZQ_GIT_IGNORED_REOPEN_DAYS`       | `0` (off)                                           | Days after which a still-seen queue entry in `ignored` status reopens; 0 to 3650                                                                                         |
| `ZQ_GIT_UNMAPPED_RETENTION_DAYS`   | `180`                                               | Retention of resolved and ignored queue entries; 1 to 3650                                                                                                               |

Removed: `ZQ_GIT_DOMAIN_ALIASES` (email is no longer a key; the variable is now ignored). `ZQ_GIT_COMPANY_DOMAINS` was never read by this code and is not introduced. Environment variables are the only source and malformed values fail at startup. No setting holds the ignore list: it is audited data in the name table, edited at run time. The PM digest settings (`ZQ_GIT_ASK*`, `ZQ_GIT_PM_RECIPIENT`) are not part of this change.

## Tables and the switch

Table creation is not lazy at startup. `createPostgresMap` (`src/persistence/durable-map.ts`) registers its migrations as soon as the map object is built (`pg.registerMigration`), and `src/start.ts` then runs `migrateRegisteredPgSchemas`, which applies every registered migration. So merely building the two maps would create the tables at boot, and the first read or write would also create them (`ready()` calls `pg.migrate`). There is no skip mode: `src/migrate-main.ts` only runs the same migrations as a separate step. The module is therefore safe by construction. With `ZQ_GIT_AUTHOR_MAPPING` off, which is the default and is set in no environment (CI, dev, staging, production), `createAuthorMapping` returns before touching `deps.map`; tests spy on the map factory to prove it for the defaults and for every partial combination of the other switches; and nothing in startup calls it. `ZQ_GIT_AUTHOR_BIND` and the fallback add no table. Turning the mapping switch on, with the poll on, makes the durable-map layer create both tables at the next start; the structure (one row per name, kind and reason fields) is approved at design level (2026-11-17) and nothing has been created anywhere. With `ZQ_GIT_POLL=1` alone no author table is requested.

For each of `zq_git_author_aliases` and `zq_git_unmapped_authors` (written `T`) the layer creates, in order (`mapMigrations`, `durableMapTenancy`, `tenantTables` and `tenantRowSecurity` in `src/tenants/migrations.ts`):

```sql
CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY, json JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL);
ALTER TABLE T ADD COLUMN tenant_id UUID NOT NULL DEFAULT <first tenant, only if T already has rows>;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS T_tenant_pkey ON T(tenant_id, id);
ALTER TABLE T DROP CONSTRAINT T_pkey, ADD CONSTRAINT T_pkey PRIMARY KEY USING INDEX T_tenant_pkey;
ALTER TABLE T ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant();
ALTER TABLE T ADD CONSTRAINT T_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON T
  USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
```

It also creates the functions `claim_T` and `claim_T_tenants`. No indexed fields are declared, so no other index exists. `durable_map_versions` already exists and gets one row per tenant and table. The SQL is unchanged by the move from email keys to name keys; only the id and JSON shape differ. The Postgres test is gated on `DATABASE_URL`.

## Not verified

The Postgres test (`test/zq-git-mcp-author-mapping-pg.test.ts`) runs only when `DATABASE_URL` is set. No real Mattermost, Postgres, GitLab or people data has been run through this. Open points of the design: how a Mattermost user maps to a QM principal (the fallback returns Mattermost ids, the name rows hold principal ids), how the PM is identified in the real deployment, whether `humanTurn` is set for Mattermost direct messages, and whether the audit viewer shows the new actions.
