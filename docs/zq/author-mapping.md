# Author mapping

After `check_updates` (through the poller) reports new commits, each commit author is classified so that a person can later be told about their commits. In this change nobody is contacted: delivery goes through an injected `AuthorNotificationSink`, and the default sink only records.

## Rules

`createAuthorResolver` (`src/zq/git-mcp/authors.ts`) answers one of five kinds, in this order:

1. `bot`: the author name, or the part of the email before the `@`, is in `ZQ_GIT_BOT_NAMES` (for example `ExampleBot.compiler`).
2. `external`: the email domain equals, or is under, a domain in `ZQ_GIT_EXTERNAL_DOMAINS` (for example `@pipeline.invalid`).
3. `unmapped` with reason `invalid_email`: no `@` in the address.
4. `person { personId, mattermostUser, matchedBy }`, found by, in order: `email` (the normalised address in the people directory), `alias` (a row of the alias table), `domain_alias` (the address with its domain replaced through `ZQ_GIT_DOMAIN_ALIASES`, looked up in the directory). The first step that finds anyone decides.
5. `ambiguous { email, candidates }` when that step finds more than one distinct person; `unmapped { email, name, reason: "no_match" }` when no step finds anyone.

Only `person` is ever handed to the sink. `unmapped` and `ambiguous` go to the unmapped queue for the PM. `bot` and `external` are dropped.

Normalisation (`normaliseEmail`): trimmed, lower case, and a plus tag in the local part is removed (`zhang+build@x` is `zhang@x`). Gmail-style dot folding is not applied, because nothing here says the company mail system ignores dots. The domain is never altered except through the configured domain aliases.

## Data sources

The repository has no people table. The one existing email-to-person source is the Mattermost surface: `ZqChat.mmUserIdsOfEmail(email)` (`src/surfaces/mattermost/index.ts`) returns the ids of Mattermost users whose verified email equals the address. The production adapter is `createMattermostPeopleDirectory(mmUserIdsOfEmail)`; a person is a Mattermost user, so `personId` and `mattermostUser` are the same id. It is wired in startup only with `ZQ_GIT_POLL=1` and `ZQ_GIT_AUTHOR_MAPPING=1` and Mattermost configured. The `PeopleDirectory` interface (`findByEmail(email): Promise<Person[]>`) is the seam if the PM names a better source (an HR export, LDAP); `createMemoryPeopleDirectory` serves tests.

Aliases live in the durable table `zq_git_author_aliases` (key `<normalised email>|<personId>`, value `{ personId, mattermostUser, email, addedBy, addedAt }`). An address may have several rows; two people on one alias make the author ambiguous. Example (invented): `zhang.home@example.org|p-zhang` with `{ "email": "zhang.home@example.org", "personId": "p-zhang", "mattermostUser": "mm-zhang", "addedBy": "pm", "addedAt": 1763000000000 }`.

## Unmapped queue

Durable table `zq_git_unmapped_authors`, key the normalised email (`(none)` if empty). Value: `{ email, name, reason: "no_match" | "invalid_email" | "ambiguous", candidates: personId[], status: "open" | "resolved" | "ignored", firstSeenAt, lastSeenAt, count, exampleRepo, exampleSha, recentShas (last 200), closedBy?, closedAt?, personId? }`. Example (invented): `nobody@corp.example → { "name": "Nobody", "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1000, "lastSeenAt": 2000, "count": 3, "exampleRepo": "client", "exampleSha": "c1", "recentShas": ["c1", "c2", "s1"] }`.

- Upsert is idempotent: one row per normalised address, and a commit sha already in `recentShas` is not counted again, so a poller retry after a failed handler does not inflate the count. The example is the first commit seen.
- Only author name, email, repo, sha and times are stored. No commit message, subject or diff.
- `queue.resolve(email, person, by)` adds an alias and marks the entry `resolved`; it leaves the open list. If the alias is later removed and the author shows up again, the entry reopens.
- `queue.ignore(email, by)` marks it `ignored`; it keeps counting but is not listed as open.
- `queue.list(status = "open")` lists by status.
- Ignored authors stay silent for good by default: they keep counting but are never listed as open. `ZQ_GIT_IGNORED_REOPEN_DAYS` (default `0`, off) reopens an ignored entry when the author is seen again that many days after it was ignored.
- Retention: `queue.prune()` (cutoff `unmappedCutoff(now, days)`, default 180 days, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`) deletes resolved and ignored entries whose later of closed time and last-seen time is older than the cutoff. Open entries are never pruned. It is not scheduled and not called from startup, like `pruneGitAudit`.

## Processing

`createAuthorMapper({ resolver, queue, sink, log? })` has `map(batches)`, taking the poller's `CommitBatch[]`, and `handle(batches)`, which has the shape of the poller's `handle`. `map` returns per-commit classification, `byPerson` (person to commits across repositories and branches: repo, branch, sha, date) and `unmapped` items. It resolves each distinct address once, records each unmapped or ambiguous address in the queue, then calls the sink once per person. The sink never sees bot, external, unmapped or ambiguous authors. Delivery is at least once: if the sink throws, `handle` throws, the poller does not acknowledge, and the next tick delivers the same commits again (the queue does not double count).

`createAuthorMapping({ config, directory, map, sink?, now?, log? })` assembles resolver, tables, queue and mapper from `ZqConfig.gitAuthors`. The default sink is `createRecordingSink()`, which keeps notices in memory and sends nothing. `createGitMcpRuntime` composes `mapper.handle` into the poll handler when `ZQ_GIT_AUTHOR_MAPPING=1` (see `docs/zq/git-mcp-poll.md`, phase 3). The sink stays the recording sink.

Logs carry only `hashEmail(email)` (first 12 hex characters of SHA-256 of the normalised address), a reason and a count. Addresses appear only in the durable tables and in sink calls.

## Configuration

| Setting                          | Default   | Meaning                                                                                                                                                                   |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_GIT_BOT_NAMES`               | empty     | Existing. Bot author names or email local parts                                                                                                                           |
| `ZQ_GIT_EXTERNAL_DOMAINS`        | empty     | Existing. Non-company domains; sub-domains match                                                                                                                          |
| `ZQ_GIT_AUTHOR_MAPPING`          | off       | New. `1` turns the layer on and needs `ZQ_GIT_POLL=1` (startup error otherwise) and Mattermost (startup error otherwise). Off: no durable map requested, no table touched |
| `ZQ_GIT_IGNORED_REOPEN_DAYS`     | `0` (off) | New. Days after which a still-seen ignored author reopens; 0 to 3650                                                                                                      |
| `ZQ_GIT_UNMAPPED_RETENTION_DAYS` | `180`     | New. Retention of resolved and ignored queue entries; 1 to 3650                                                                                                           |
| `ZQ_GIT_DOMAIN_ALIASES`          | empty     | New. Comma list of `old.example=corp.example`; an address on the left domain is also tried on the right domain                                                            |

Environment variables are the only source. A malformed pair fails at startup. There is no company-domain allowlist: any address that is not bot or external and matches nobody goes to the PM.

## Tables and the switch

Table creation is not lazy at startup. `createPostgresMap` (`src/persistence/durable-map.ts`) registers its migrations as soon as the map object is built (`pg.registerMigration`), and `src/start.ts` then runs `migrateRegisteredPgSchemas`, which applies every registered migration. So merely building the two maps would create the tables at boot, and the first read or write would also create them (`ready()` calls `pg.migrate`). There is no skip mode: `src/migrate-main.ts` only runs the same migrations as a separate step. The module is therefore safe by construction. With `ZQ_GIT_AUTHOR_MAPPING` off, which is the default and is set in no environment (CI, dev, staging, production), `createAuthorMapping` returns before touching `deps.map`; a test spies on the map factory to prove it; and nothing in startup calls it. Turning the switch on, with the poll on and Mattermost configured, makes the durable-map layer create both tables at the next start; the DDL is approved (`docs/zq-git-mcp-ddl-proposal.md` on `oa/spike-git`, section 8, approved 2026-11-17). With `ZQ_GIT_POLL=1` alone no author table is requested.

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

It also creates the functions `claim_T` and `claim_T_tenants`. No indexed fields are declared, so no other index exists. `durable_map_versions` already exists and gets one row per tenant and table. The Postgres test is gated on `DATABASE_URL`.

## What the PM must supply

- The company email domains and any retired domains (as `ZQ_GIT_DOMAIN_ALIASES`).
- The bot list and the external domain list.
- Alias seeds: personal or old commit addresses of staff (added with `queue.resolve` or `aliases.add`).
- Confirmation of the email-to-Mattermost source (Mattermost verified emails today).

## Not verified

Tables are created by the durable-map layer the same way as other zq tables; the Postgres test (`test/zq-git-mcp-author-mapping-pg.test.ts`) runs only when `DATABASE_URL` is set. No real people data has been run through this.
