# Design: git authors are bound by NAME, people bind their own names, the PM keeps an ignore list and answers for unknown authors

Status: DESIGN ONLY, NOT APPROVED. Nothing here is implemented, created or applied: no table exists anywhere and no setting is set. Revision 4 (2026-11-17). It supersedes earlier drafts that keyed people by email, and it proposes amending section 8 of `zq-git-mcp-ddl-proposal.md` before any DBA creates the tables. Every name, email and person in examples is INVENTED; no real author data is, or may be, in this repository. Written against `oa/zq-wire-3-authors` (author mapping), `oa/zq-wire-1-access` (the `zq_git` tool) and sections 8 and 11 of the DDL proposal and wiring plan on this branch. Nothing was run; section 17 lists what is not verified.

## Plain-language summary (10 lines)

1. A git commit carries an author NAME and an author email. Emails change at will and QM account emails are for password reset, so people are recognised by author NAME, exactly as written after light normalisation (case, spaces, full-width forms).
2. Each person tells QM in chat "my git author name(s) are X (and Y)"; they find them with `git config user.name`. One person can bind several names. Names are unique in practice (same-name people rename, like `justin01`), so there is no disambiguation machinery: a name already bound to someone else is refused at bind time.
3. The PM keeps an IGNORE LIST of author names, each with a reason (`automation` for pipeline scripts, `external` for people outside the team). Their commits are dropped silently: no notice, no queue row. Self-bind of an ignored name is refused.
4. Order: explicit person binding > ignore list > bot name rule > external domain list > unmapped queue. Nobody else is dropped; malformed emails go to the queue by name.
5. Bot rule: a name or email local part containing the whole word "bot" (`ZQBot.compiler`); Abbott, Talbot, Botha do not match. It beats any link to a (departed) person's mailbox.
6. Generic names (`admin`, `root`, `HOST123\admin`) can only be bound or ignored with an email condition, which is an optional field used for nothing else.
7. A person can be marked DEPARTED: their commits go to the PM, not to them. A "shared identity" kind was considered and is recommended to be CUT.
8. The PM gets a digest of unknown names with real name and email, as a DM to a named person only (dry-run for now); she answers in chat and the same tool binds or ignores. Logs and audit keep hashes only.
9. Schema: the approved SQL for both tables does not change; the id and JSON shape do (one row per normalised name; kind and reason fields). Not approved; nothing exists to migrate.
10. About 57 hours of work; the Mattermost-email match survives only as a switch that is off by default.

## 1. What exists today (read from `oa/zq-wire-3-authors`)

- `src/zq/git-mcp/authors.ts`: bot (name or email local part in `ZQ_GIT_BOT_NAMES`, exact) and external domain are dropped first; then Mattermost verified email, then the alias table, then a retired-domain retry; one person decides, several are ambiguous, none is unmapped. Only "no `@`" is `invalid_email`.
- `author-aliases.ts`: durable map `zq_git_author_aliases`, id `<normalised email>|<personId>`, value `{ email, personId, mattermostUser, addedBy, addedAt }`; `add` uses `putIfAbsent`.
- `unmapped-queue.ts`: durable map `zq_git_unmapped_authors`, id the normalised email, status `open | resolved | ignored`, `resolve` adds an alias and closes the row.
- `people.ts`: `normaliseEmail` (trim, lower case, drop `+tag`); the Mattermost directory returns Mattermost user ids as `personId`.
- `author-mapping.ts`: only `person` reaches the sink; unmapped and ambiguous go to the queue; logs carry `hashEmail`.
- Agent tool pattern (`oa/zq-wire-1-access`): `zq_git` in `src/agent/agent-tools/zq.ts` calls `tc.callZqGit` (`ToolContext`, `src/tools/primitives.ts`), the caller is `canonicalPerson(createdBy)` after `attestableActor`; read-only turns use the allowlist `READ_ONLY_TOOL_NAMES` in `src/agent/agent-tools.ts`; admin authority is `actorIsOrgAdmin` computed in `src/core/orchestrator.ts` (handed over as `admin.operationsAvailable`); audit is `AuditLog.record({ at, principalId, action, resource, scopeLabel, status?, detail? })` (`src/audit/audit-log.ts`, Postgres implementation `src/admin/postgres-audit-log.ts`, `deps.auditLog` already in the tool context, `recordOnce(key, event)` for idempotent events).

## 2. Scan facts and principles

From the read-only scan of the real repositories (7 repositories, 9178 commits; every value below is invented): one bot author named like `ZQBot.compiler` whose email belongs to a person who left (112 commits); malformed emails (empty local part, no `@`); one email under several names (Chinese and pinyin); `DOMAIN\name`, `user\COMPANY`, `HOST123\admin` forms and case or hyphen differences; author and committer emails differ in 25 commits; one identity with a malformed email that is a pipeline automation (about 6k commits); at least one external person outside the project team.

Principles: (1) the key of a person is the git AUTHOR NAME, normalised; (2) email is an optional condition on a row and an attribute shown to the PM, never an identity; (3) author fields only, never the committer; (4) nothing is guessed: no fuzzy name match, no email-local-part-to-name match; (5) every author that is not bound, ignored, a bot or external reaches the PM.

## 3. Name normalisation

One function (`nameKey`) used by every writer and reader: bind, unbind, ignore, resolver, queue, log hash.

| Step                                                                          | Folded or not                           | Reason and risk                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unicode NFKC                                                                  | folded                                  | Full-width Latin and digits become plain; compatibility ideographs and half-width katakana unify; the ideographic space becomes a space                                                                                                                                                                                                                                                                        |
| Remove invisible format characters (zero-width space, BOM, directional marks) | folded                                  | Copy-pasted names carry them; they would make a bind silently never match                                                                                                                                                                                                                                                                                                                                      |
| Trim, collapse whitespace runs to one space                                   | folded                                  | `Alice  Example ` equals `Alice Example`                                                                                                                                                                                                                                                                                                                                                                       |
| Case (`toLowerCase`)                                                          | folded                                  | Git names differ in case between machines; two different people differing only by case is vanishingly unlikely                                                                                                                                                                                                                                                                                                 |
| `domain\` or `host\` prefix                                                   | NOT stripped                            | Stripping `HOST123\admin` gives `admin`, which collides across every host; `user\COMPANY` shows the part before the backslash is not reliably a domain. Cost: a person who commits as `alice.e` and `ACME\alice.e` binds both (the tool accepts several names in one call and suggests it when it sees a backslash). A configurable list of domains to strip was left out: no caller until the scan proves one |
| Hyphen, underscore, dot, apostrophe variants                                  | NOT folded                              | Different strings can be different people; folding silently misattributes; binding each variant is cheap                                                                                                                                                                                                                                                                                                       |
| Chinese name versus pinyin name; simplified versus traditional; accents       | NOT linked or folded                    | Two names of one person are two bindings                                                                                                                                                                                                                                                                                                                                                                       |
| Length                                                                        | 1 to 100 characters after normalisation | an empty name cannot be bound                                                                                                                                                                                                                                                                                                                                                                                  |

Bot detection uses the name after NFKC, invisible-character removal and whitespace collapse but BEFORE lower-casing, because the camelCase boundary in `ZQBot` is lost by lower-casing.

Email conditions and email attributes are normalised by trim and lower case only. Plus-tag stripping is removed from `normaliseEmail`: no plus addressing was seen at the company, stripping can merge different mailboxes (`team+ann@x`, `team+bob@x`), email is no longer an identity key, and removing code beats a flag with no caller. A condition is compared as an exact string, so it also works for a malformed email such as `@partnerco`; it must be non-empty, at most 254 characters and contain no whitespace.

Generic names: a name is generic if the part after the last backslash (or the whole name) equals one of `ZQ_GIT_GENERIC_NAMES` (default `admin,administrator,root,test,user,git,unknown,pc`) after normalisation. The backslash split is used only for this test, never for matching.

## 4. The alias table in one picture: one row per name

`zq_git_author_aliases` holds exactly one row per normalised name (id = the name key, section 12). A row has a `kind`:

| kind      | Meaning                                                     | Extra fields                                        |
| --------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `person`  | the name is this person's                                   | `personId`, `mattermostUser`, optional `departedAt` |
| `ignored` | the PM registered this name as not to be notified or queued | required `reason`: `automation` or `external`       |

Both kinds may carry an optional `emailCondition`: the row applies to a commit only if the commit author email equals it; if it does not, the row is skipped and the author falls through to the next rule. Absent means any email.

Because the primary key is `(tenant_id, id)` and id is the name key, two rows for one name cannot exist, so a name can never be bound to two people, and a name cannot be both bound and ignored. Concurrent binds race on `putIfAbsent`; exactly one wins. This is stronger than the requested safety net "ambiguous at runtime": a rejected write replaces the ambiguity (see D1). `ambiguous` still exists for one source only, the optional Mattermost email fallback (several people share an email).

## 5. Resolution order and decision table

Inputs per commit: author name and author email. The committer is never read.

| #   | Rule                                                                                                                                                                 | Result                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Explicit binding: the row for this name key has `kind person` and its condition is absent or equals the email                                                        | `person (matchedBy "name")`, with `departed: true` if the row says so                                                      |
| 2   | Explicit ignore: the row has `kind ignored` and its condition is absent or equals the email                                                                          | `ignored` (with the row's reason), dropped; no notice, no queue row                                                        |
| 3   | Bot: the name or the local part of a usable email matches the exact list `ZQ_GIT_BOT_NAMES` or a bot word token (section 7)                                          | `bot`, dropped                                                                                                             |
| 4   | External domain (`ZQ_GIT_EXTERNAL_DOMAINS`, default empty), only for a usable email (one `@`, non-empty local part and domain)                                       | `external`, dropped                                                                                                        |
| 5   | Mattermost fallback, only if `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK=1` (default off, never authoritative): usable email equal to the verified email of exactly one person | `person (matchedBy "mattermost_email")`; several people: `ambiguous`                                                       |
| 6   | Everything else                                                                                                                                                      | `unmapped`, queued by name; reason `no_match`, or `invalid_email` when the email is not usable, or `ambiguous` from rule 5 |

Why each position:

- 1 first: an explicit statement by a person or the PM about a name is the strongest evidence; it also lets the PM deliberately claim a bot-looking name.
- 2 second: an ignore is an explicit PM decision about one name. Rows 1 and 2 are mutually exclusive for one name (same id), so their relative order only matters in the data model, not in outcomes; ignore beats the bot, external and fallback rules because it is a named decision and must not depend on pattern luck. An ignored name that also matches the bot pattern is dropped either way; the difference is only the log counter (`ignored` instead of `bot`) and the reason column.
- 3 bot before external and the fallback: the bot named `ZQBot.compiler` stays a bot although its mailbox belongs to a person who left; no email link can turn it into a person (a binding is keyed by name, so binding the departed person's own name does not match the bot's commits).
- 4 external after bot: an explicitly configured external domain is dropped only for authors that no one claimed.
- 5 the Mattermost match is the weakest evidence and only runs for everything left.
- 6 nothing is silently lost: private emails, malformed emails (`@partnerco`, `bobtest`) and new names reach the PM.
- A "shared identity" rule would sit between 2 and 3; it is recommended to be cut (section 9).

Examples (invented; `P` are people):

| Commit author name / email                   | Rows and config                                        | Result                                               |
| -------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `Alice Example` / `alice.example@igg.com`    | `alice example` person P1                              | P1                                                   |
| `艾丽丝` / `a@personal.example`              | `艾丽丝` person P1                                     | P1 (several names, one person)                       |
| `ＡＬＩＣＥ  EXAMPLE` / any                  | `alice example` person P1                              | P1 (NFKC, case, whitespace)                          |
| `ACME\alice.e` / any                         | only `alice.e` bound                                   | unmapped (prefix kept)                               |
| `justin01` / any                             | `justin01` person P2                                   | P2 (renamed duplicate name)                          |
| `Justin` / any                               | `justin` bound to P2                                   | P2                                                   |
| `pipeline-sync` / `@partnerco`               | ignored, reason automation, no condition               | ignored, no notice, no queue row                     |
| `pipeline-sync` / empty email                | same                                                   | ignored                                              |
| `pipeline-sync` / `x@elsewhere.example`      | ignored with condition `@partnerco`                    | does not match; unmapped (queued)                    |
| `Visiting Student` / `vs@univ.example`       | ignored, reason external                               | ignored                                              |
| `ZQBot.compiler` / the left employee's email | nothing on that name                                   | bot                                                  |
| `ZQBot.compiler` / any                       | ignored, reason automation                             | ignored (same outcome as bot)                        |
| `ZQBot.compiler` / any                       | PM binds it to P3 explicitly                           | P3                                                   |
| `Dana Example` / her email                   | person P4 with `departedAt`                            | person P4 departed, PM notified                      |
| `Eve` / `@partnerco`                         | `eve` person P5                                        | P5                                                   |
| `Eve` / `@partnerco`                         | nothing                                                | unmapped (`invalid_email`)                           |
| `Frank` / `frank@partnerco`                  | `partnerco` external, `frank` unbound                  | external, dropped                                    |
| `HOST123\admin` / `x@y.example`              | nothing                                                | unmapped; queued under name and email (generic)      |
| `HOST123\admin` / `x@y.example`              | `host123\admin` person P6 with condition `x@y.example` | P6                                                   |
| `Gina` / `gina@igg.com`                      | fallback on, Mattermost has this verified email        | P7 (rule 5)                                          |
| same, fallback off (default)                 |                                                        | unmapped; digest shows the Mattermost user as a hint |

What changes against today's code (exact list):

1. The key changes from email to name; the email-keyed `find`, the primary directory lookup and the retired-domain retry (`domain_alias`) go away.
2. Order: today bot and external first, then Mattermost email, then alias. New: binding, ignore, bot, external, fallback, unmapped. A bound name is never dropped as bot or external.
3. The Mattermost match is off by default and last. `ZQ_GIT_DOMAIN_ALIASES` is removed.
4. Malformed emails: no `@`, empty local part or empty domain are `invalid_email`, never external; handled by name.
5. `normaliseEmail` loses plus-tag stripping.
6. Queue key and row shape change (section 12).
7. The bot rule gains word tokens.
8. Results carry `departed` and a new `ignored` kind; the mapper routes departed persons to the PM and drops ignored commits with a counter.
9. Author-only matching is pinned by a test.

Existing code that changes (on `oa/zq-wire-3-authors`): `src/zq/git-mcp/authors.ts` (resolver, `classifyAuthor`), `author-aliases.ts` (key, shape, `find(name, email)`), `unmapped-queue.ts` (key, `emails`, `askedAt`), `people.ts` (`normaliseEmail`, directory only for the fallback and the hint), `author-mapping.ts` (departed routing, ignored counter, name hashes in logs), `runtime.ts` (directory optional), `src/zq/config.ts` (section 11).

Existing tests that change:

- `test/zq-git-mcp-authors.test.ts`: every table row that asserts a person through the directory ("company email", "company email in other case", "directory email stored in mixed case", "plus addressing", "second address of the same person", "domain alias", "two people share the address") is rewritten to bind by name, the old cases kept only under the fallback switch; "an address that matches the directory wins over an alias" is deleted; "an alias maps an extra commit address and removing it unmaps the author" is rewritten for names; "an alias must be an email address" becomes name validation (non-empty, not generic without condition); "two people sharing an alias make the author ambiguous" becomes "a second bind of a held name is refused"; "bot by local part with plus tag" is rewritten (no plus stripping); "no at sign" gains empty local part and a name binding; "normalisation lower-cases, trims and drops plus tags only" becomes the name and email tables; "the classifier alone leaves company addresses to the mapping stage" is rewritten.
- `test/zq-git-mcp-author-mapping.test.ts`: tests that build people through `createMemoryPeopleDirectory` use name rows; "bots, external and unmapped authors produce no sink call" keeps its expectation and adds malformed-email and ignored cases; queue-key, resolve, ignore, reopen and pruning tests change for the name key and `emails`; "logs carry only a hash" also checks names.
- `test/zq-git-mcp-authors-wiring.test.ts`: the same fixture change; "a failing directory leaves the commits un-acknowledged" needs the fallback on, with a new alias-store failure case; the log test checks that neither names nor emails appear.
- `test/zq-git-mcp-author-mapping-pg.test.ts` (gated on `DATABASE_URL`): new ids and fields round-trip.
- Config tests: new defaults and validation; `ZQ_GIT_DOMAIN_ALIASES` tests deleted.
- Docs: `docs/zq/author-mapping.md`, `docs/zq/git-mcp-poll.md` (remove the external-domain example that equals a malformed email's domain, describe names), section 8 of the DDL proposal, step 4 of section 11 of the wiring plan.

## 6. Name already taken, generic names, bind-time rules

Names are unique in practice because people with the same name rename on the git side (`justin01`). Main path therefore: exact match on the normalised name, nothing else.

Bind-time rules, same for self and admin paths, in this order:

1. Normalise; reject empty or longer than 100 characters.
2. Reject a name the bot rule classes as a bot (`ZQBot.compiler`) for self-binds; an admin may bind it on purpose (audited).
3. Reject a generic name unless an email condition is given (people and admins alike); the same for ignoring.
4. If a row for this name key exists: REFUSE, always (no accept-and-flag, no conditioned second bind). The reply is clear and says what to do: "The git name `<name>` is already bound (or ignored) in QM. If it is not yours, change your git name, for example to `<name>01` (`git config user.name`), and bind that; if you think it is yours, ask the PM, who can review it." It does not name the holder. The holder receives a notice that someone tried to bind their name, and the audit records the attempt (status `refused`). The admin path refuses too, with the holder's identity shown to the admin; the admin resolves it by `unbind_for` first.
5. Enforce `ZQ_GIT_BIND_MAX_PER_PERSON`.
6. Insert with `putIfAbsent` (two concurrent binds: exactly one wins; the loser gets the refusal of rule 4).

Trade-offs of refusing instead of accept-and-flag: no lockout is possible for people with unique names, which is the real case; a squatter can block a name until the PM unbinds (visible in the audit and to the holder); no ambiguity states exist to maintain. The risk left: a real second person with the identical name who cannot rename is told to ask the PM, who can bind that name with an email condition on one of them and ignore the other collision by hand (rare, manual, acceptable per the scan).

The optional email condition is KEPT but is no longer a disambiguation tool. Recommendation: keep one optional JSON field `emailCondition` because three things need it and it costs one comparison in the resolver: generic names (`admin`), ignore entries tied to a specific malformed or mailbox email, and a person or the PM who wants a narrow binding. Removed with it: specificity ordering between rows, equal-pair flagging, conditioned binding of a held name, the `<name>|<email>` uniqueness of bindings.

## 7. The "bot" word rule

Rule (PM, 2026-11-17): an author whose name or email local part contains "bot", case-insensitive, is a bot: not queued, no notification; configurable. It is rule 3: after explicit rows, before external and unmapped.

| Option                    | Abbott      | Talbot      | Botha       | Robotham    | ZQBot.compiler | dependabot | Verdict                                                              |
| ------------------------- | ----------- | ----------- | ----------- | ----------- | -------------- | ---------- | -------------------------------------------------------------------- |
| A. plain substring        | bot (wrong) | bot (wrong) | bot (wrong) | bot (wrong) | bot            | bot        | rejected: real people would vanish                                   |
| B. start or end of string | no          | bot (wrong) | bot (wrong) | no          | bot            | bot        | rejected                                                             |
| C. whole-word token       | no          | no          | no          | no          | bot            | not bot    | recommended                                                          |
| D. regex list             | depends     |             |             |             |                |            | rejected: unsafe patterns, backtracking per commit, hard to validate |

Recommendation C. Tokenise the name and the local part of a usable email: split on every non-alphanumeric character (`. _ - space [ ] ( ) + \` and so on), split letters from digits, split camelCase including an acronym run before a capitalised word (`ZQBot` becomes `ZQ`, `Bot`); lower-case; bot if any token equals a configured token. The domain is never examined. Known limit: a fused word (`dependabot`, `ZQBOT`) is one token and is not matched; it fails safe by reaching the queue, and the scan's real fused names go into `ZQ_GIT_BOT_NAMES` or the tokens (or the ignore list).

Configuration: `ZQ_GIT_BOT_TOKENS`, default `bot`; unset means the default, the empty string means no token rule; each token `^[a-z0-9]{2,32}$`, at most 50, otherwise a startup error naming the setting and item. `ZQ_GIT_BOT_NAMES` (exact, compared normalised) is unchanged.

Difference from the ignore list: the bot rule is a pattern and a config list (deployment-side, restart to change); the ignore list is explicit, per name, per reason, edited at run time by the PM through an audited tool.

Bot test table (default tokens; "unmapped" means an unbound author with a normal email):

| Case                                 | Name or local part                                                       | Expected                                |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------- |
| ZQBot.compiler                       | `ZQBot.compiler`                                                         | bot                                     |
| jenkins-bot                          | `jenkins-bot`                                                            | bot                                     |
| bot-deploy                           | `bot-deploy`                                                             | bot                                     |
| build.bot@igg.com                    | local part `build.bot`                                                   | bot                                     |
| Abbott, Talbot, Botha, Robotham, Bob | each                                                                     | unmapped                                |
| uppercase BOT                        | `BOT`                                                                    | bot                                     |
| bound bot-looking name               | admin binds `ZQBot.compiler` to P2                                       | person P2 (explicit row beats the rule) |
| bot with a departed person's email   | name `ZQBot.compiler`, departed Dana bound by her own name, Dana's email | bot                                     |
| empty token list                     | `ZQ_GIT_BOT_TOKENS=`, `ZQBot.compiler`                                   | unmapped                                |
| bracket form / digit boundary        | `renovate[bot]` / `build2bot`                                            | bot / bot                               |
| fused                                | `dependabot`, `ZQBOT`                                                    | unmapped (documented limit)             |
| exact list                           | `ZQ_GIT_BOT_NAMES=dependabot`, author `Dependabot`                       | bot                                     |
| domain ignored                       | `ann@bot.example.com`                                                    | unmapped                                |
| bad token                            | `ZQ_GIT_BOT_TOKENS=bo.t`                                                 | startup error                           |
| scan fixtures                        | the real author names of the scan as invented values of the same shape   | added later, one row each               |

## 8. The ignore list: automation and external authors

Purpose: pipeline scripts (automatic commits) and people outside the project team (for example a visiting teaching assistant) must produce no notification and no unmapped-queue entry, while remaining countable.

Representation: rows of `zq_git_author_aliases` with `kind: "ignored"`. No new table, no new setting. Fields: the name key (id), display `name`, required `reason`, optional `emailCondition`, `addedBy`, `addedAt`.

Reason enum: `automation | external`. Required, no default, so a later report or counter can tell them apart (counts per reason, a later decision to treat external authors differently). No further value is proposed: `bot` is a rule (section 7), `departed` is a person flag (section 9), and a third reason has no known caller. The enum is a JSON string, so adding a value later is additive and needs no table change.

Registration (admin/PM path only, never self-bind), all audited:

| Operation       | Arguments                                                               | Effect                                                                                                                    |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ignore_add`    | `name`, `reason`, optional `email`                                      | adds a row; refused if the name is held by a person or already ignored (section 6 rule 4), or generic without a condition |
| `ignore_list`   | optional `reason`                                                       | lists rows with real names, reasons, conditions, added by and when (dropped-commit counts are not stored, see below)      |
| `ignore_remove` | `name`, optional `email`                                                | removes the row; the author reappears in the queue at the next sighting                                                   |
| `ignore_import` | `entries` (list of `name`, `email?`, `reason`), `apply` (default false) | bulk add, below                                                                                                           |

An ignored-versus-bound conflict is refused at registration in both directions: `ignore_add` on a bound name says "bound to <person>, unbind first"; `bind` or `bind_for` on an ignored name says the name is on the ignore list. Because both are the same row id this is also enforced by the primary key.

What is logged: per poll batch one line per ignored name hash, `zq git author ignored: <nameHash> reason=<automation|external> commits=<n>`, counts and the 12-hex name hash only; the poll's existing per-branch count line still counts all commits including ignored ones, because it runs before mapping. No per-commit audit event is written for dropped commits (it would be about 6k rows for one script); registration, removal and import are audited, with hashes only. Dropped commits are not stored anywhere, so counts per reason come from the log counter; if the PM wants durable counts, that is a later, separate decision (it would need a store).

Seed data. The real names and emails of ignored authors MUST NOT appear in any repository file, test or doc. They are supplied by the PM and imported at deployment time through the admin tool path (`ignore_import` in her private conversation) or a deployment-side import (below). Import path:

- Format: a list of entries `{ name, email?, reason }` (in the tool call) or, for the deployment-side file, one CSV line per entry `name,email,reason` (UTF-8, header line, email may be empty). The file lives outside Git (a deployment secret or config volume); it is never committed.
- Dry-run preview first: `apply` defaults to false; the reply to the admin lists, per entry, `would add`, `unchanged`, or `refused: <reason>` (name bound to a person, generic without a condition, invalid reason, duplicate within the file), with counts per reason. The preview is shown only to the admin who ran it (it may contain the names she supplied); logs and audit keep hashes.
- Idempotent: an entry that already exists with the same name key, condition and reason is `unchanged`; running the same import twice changes nothing.
- Re-import: add-only. It never removes rows that are missing from the file, and never changes the reason of an existing row (that is reported as `refused: exists with another reason`; the admin uses `ignore_remove` then `ignore_add`). Removal is always an explicit operation.
- Audit: one event for the import (`zq_git.identity.ignore_import`, counts per outcome and a SHA-256 of the file or payload, never its content), plus one `ignore_add` event per added row with the name hash.
- Deployment-side variant: a thin one-shot CLI command (for example `qm zq-git import-ignored <file> [--apply]`) that reads the file and calls the same service function; it is not a startup setting, so nothing is silently re-applied at each boot and nothing secret is baked into configuration. Recommendation: build the tool path first (the list is small and the PM owns it); add the CLI only if the list grows beyond what she wants to paste (about 3 hours).
- No secrets: the entries are names and optional emails only; credentials never enter the file, the payload, the audit or Git.

External authors: they are ignored with reason `external`, which means no notice and no queue row. Whether external authors should later be notified or mapped differently is a PM decision (section 19); the reason column keeps that option open without another migration.

## 9. Departed people, and the shared-identity kind (cut)

Departed. An admin operation `depart { person }` sets `departedAt` on every `person` row of that person; `undepart` clears it. The flag lives on the row, not in a person table: the repository has no people table and a person is exactly the set of their rows; a row added later by an admin for a departed person copies the flag; a self-bind by a departed person is refused while the flag is set. The resolver returns `person` with `departed: true`; the mapper does not hand those commits to the person but to the PM notice path (`ZQ_GIT_PM_RECIPIENT`, dry-run first) with the real name, repository, branch, short sha and count, deduplicated by sha like person notices, and they are not queued. Interaction with the bot rule: none by email, because rows are keyed by name; a bot that shares a departed person's mailbox but has its own name matches none of that person's rows and stays a bot. Only an explicit row on the bot's own name could change that, and that is an explicit decision.

Shared identity (a name pointing to a group of people or "needs PM assignment"). Recommendation: CUT. The scan's one shared-looking identity turned out to be pipeline automation, which the ignore list covers; no other caller is known, and a group kind needs members, owner routing, a committer-field policy and its own tests. Committer field: not used at all (author only everywhere; 34 differing committers in one history are noise for a name-keyed design). If a real shared identity appears later it is an additive `kind: "shared"` row with `members` and an owner in the same table, resolved at the position between the ignore list and the bot rule, notifying the PM or a configured owner once per commit and never a member, created only by the admin path, refused for self-bind; no schema or table change would be needed. Its test cases (not written now): shared commit notifies the owner once and no member; self-bind of a shared name is refused; group members are listed; it differs from `bot` (a pattern, dropped) and from `ambiguous` (an unresolved conflict, queued).

## 10. The binding tool and notifications

Name: `zq_git_identity`, a new tool next to `zq_git` in `src/agent/agent-tools/zq.ts`, offered only when `ZQ_GIT_AUTHOR_BIND=1`. Not in `READ_ONLY_TOOL_NAMES`, so it is absent from read-only turns (the list is an allowlist, verified in `agent-tools.ts`); it writes durable rows, so that is correct, and `list` is unavailable there too.

Tool description and each successful reply: "Your git author name is whatever your commits carry. On your computer run `git config user.name` (and `git config user.email`) inside a repository to see it; it can differ per computer, so bind each name you see, including forms like `DOMAIN\name`."

| Operation                                                        | Who              | Arguments                                                      | Effect                                                           |
| ---------------------------------------------------------------- | ---------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `bind`                                                           | signed-in person | `names` (1 to 5), optional `email` (condition for these names) | binds the names to the caller                                    |
| `list`                                                           | signed-in person | none                                                           | the caller's own rows                                            |
| `unbind`                                                         | signed-in person | `name`                                                         | removes the caller's own row                                     |
| `bind_for`                                                       | identity admin   | `person`, `names`, optional `email`                            | the same for another person; closes the matching queue row       |
| `unbind_for`                                                     | identity admin   | `person`, `name`                                               | removes that person's row                                        |
| `depart` / `undepart`                                            | identity admin   | `person`                                                       | section 9                                                        |
| `ignore_add` / `ignore_list` / `ignore_remove` / `ignore_import` | identity admin   | section 8                                                      | the ignore list                                                  |
| `list_unmapped`                                                  | identity admin   | optional `status`                                              | queue rows with real names, emails, counts, example repo and sha |

Self operations have no `person` argument; the caller is `attestedPerson(deps.createdBy, "zq_git_identity")` from `src/directory/person.ts`, the way `zq_git` derives its label. System actors, bot- or webhook-initiated turns and turns that are not human-initiated (`humanTurn`) are refused, so tool output or a fetched page cannot make the agent bind. Identity admins are `actorIsOrgAdmin` or a principal listed in `ZQ_GIT_IDENTITY_ADMINS`; admin operations are refused outside the person's own private conversation (`attestableAudience`). Person reference for admin operations: a Mattermost username or a canonical principal id resolved through the directory and identity links (the mapping from Mattermost users to principals is unverified, section 17).

Abuse and audit. Self-assertion means anyone can claim a free name; the gain is attribution misdirection only (commits with that name are attributed to the claimant; with notifications on, the claimant receives them). No git, repository or data access results. Decisions of 2026-11-17 apply: no per-bind PM confirmation; a claim on a held name is refused, the holder is notified of the attempt and it is audited; a claim on a free name is silent (the PM sees all rows and can unbind). Notices go through a sink that is dry-run (recorded in memory, logged by hash) until phase 4's live sink exists.

Audit reuses `deps.auditLog.record` (Postgres in production), no new table:

| Event           | `action`                                                          | `resource`                   | `status`                   | `detail`                            |
| --------------- | ----------------------------------------------------------------- | ---------------------------- | -------------------------- | ----------------------------------- |
| self bind       | `zq_git.identity.bind`                                            | `<nameHash>` -> `<personId>` | `ok`, `refused`            | `reason=<code> holder_notified=<yes | no>`                            |
| unbind          | `zq_git.identity.unbind`                                          | same                         | `ok`, `not_found`          |                                     |
| admin ops       | `zq_git.identity.bind_for` / `unbind_for` / `depart` / `undepart` | same or `<personId>`         | `ok`, `refused`            | `by=admin`                          |
| ignore list     | `zq_git.identity.ignore_add` / `ignore_remove` / `ignore_import`  | `<nameHash>` or `import`     | `ok`, `refused`, `dry_run` | `reason=automation                  | external`, counts, payload hash |
| digest          | `zq_git.ask.digest`                                               | `entries=<n>`                | `ok`, `dry_run`            | hashes                              |
| departed notice | `zq_git.departed.notice`                                          | `<personId>`                 | `ok`, `dry_run`            | `commits=<n>`                       |

`principalId` is the actor, `scopeLabel` the turn's audience scope. Names and emails never appear in audit or logs; `hashName` and `hashEmail` are the first 12 hex characters of SHA-256 of the normalised value (the existing `hashEmail` pattern).

Asking the PM "who is this?". Trigger: open queue rows not yet asked. Target: `ZQ_GIT_PM_RECIPIENT`, a named person, a direct message and never a channel (the wiring plan's `ZQ_GIT_NOTIFY_CHANNEL` is not used for this; a channel-like value is a startup error). Dry-run first: with phase 4's live switch (`ZQ_GIT_NOTIFY`) unset the sink only records the latest digest in memory and logs hashed counts; nothing is sent or marked asked, so the first live run asks everything still open. Content (decided: the PM sees the real name and email; logs and audit keep hashes). Invented sketch, Chinese in production like other zq notices:

```
New git authors QM cannot place (3):
1. "Alice Example"  emails: alice.example@igg.com, a@personal.example  7 commits  e.g. client@a1b2c3d   Mattermost hint: user aexample has the first email
2. "HOST123\admin"  email: x@y.example  2 commits  e.g. server@9f8e7d6   generic name: needs an email condition
3. "Eve"  email: @partnerco (not a valid email)  352 commits
Reply e.g. "Alice Example and 艾丽丝 are Alice", "ignore 3 as automation" or "ignore 2 as external".
```

No commit message or diff. The agent turns the reply into `bind_for` or `ignore_add` calls; the queue row is closed `resolved`. The Mattermost hint is an exact verified-email equality only; there is no similarity matching of names or local parts.

Dedupe and batching: optional `askedAt` on the queue row; eligible rows are open, never asked, first seen at least `ZQ_GIT_ASK_DIGEST_MINUTES` ago (default 60, so a new person's commits coalesce); at most `ZQ_GIT_ASK_MAX_ITEMS` (default 20) per digest, largest counts first; `askedAt` set after a successful live send (at-least-once). Re-ask: never, except when a resolved row reopens (a row was removed and the author reappears), or after `ZQ_GIT_ASK_REASK_DAYS` if above 0. It runs at the end of the poll cycle under the existing leader lease `zq:git-mcp`, so there is one asker and no new sweeper.

New-user onboarding reminder (DESIGN ONLY, not implemented; wiring point after phase 4): when a signed-in person talks to the bot and `zq_git_identity list` is empty, the bot adds one line: "Tell me your git author name(s): run `git config user.name` on your computer." Once per person, deduped with `auditLog.recordOnce("zq_git.identity.remind|<personId>", ...)` (durable, no table); never in channels, never for system actors, never after a bind. Hook: the turn-start path in `src/core/orchestrator.ts` where the actor is resolved. About 4 hours then.

## 11. Configuration proposal

All environment variables parsed in `src/zq/config.ts`. Not approved; nothing is set anywhere.

| Setting                            | Default                                             | Effect                                                                             | Precedence and interaction                                                 | Supported combinations                                                                           | Startup validation                                           |
| ---------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `ZQ_GIT_AUTHOR_BIND`               | off                                                 | `1` offers `zq_git_identity` (bind, ignore list, departed, admin)                  | needs the alias store                                                      | only with `ZQ_GIT_AUTHOR_MAPPING=1`                                                              | error "needs ZQ_GIT_AUTHOR_MAPPING=1"                        |
| `ZQ_GIT_MATTERMOST_EMAIL_FALLBACK` | off                                                 | `1` adds rule 5 (verified exact email, never authoritative)                        | after rows, bot, external                                                  | off: the directory is not called for mapping and Mattermost is not required for mapping to start | `1` without mapping or without Mattermost: error             |
| `ZQ_GIT_BOT_NAMES`                 | empty (existing)                                    | exact normalised names or local parts that are bots                                | rule 3                                                                     | unchanged                                                                                        | unchanged                                                    |
| `ZQ_GIT_BOT_TOKENS`                | `bot`                                               | word tokens that make a name or local part a bot                                   | rule 3                                                                     | empty string disables the token rule                                                             | `^[a-z0-9]{2,32}$`, at most 50                               |
| `ZQ_GIT_EXTERNAL_DOMAINS`          | empty (existing)                                    | dropped when unclaimed, usable emails only                                         | rule 4                                                                     | unchanged                                                                                        | unchanged                                                    |
| `ZQ_GIT_GENERIC_NAMES`             | `admin,administrator,root,test,user,git,unknown,pc` | names (last backslash segment) that need an email condition to be bound or ignored | bind and ignore rules, queue key                                           | empty disables                                                                                   | items non-empty, no `\`                                      |
| `ZQ_GIT_IDENTITY_ADMINS`           | empty                                               | principals allowed admin operations besides org admins                             | org admin OR listed                                                        | empty: org admins only                                                                           | items visible ASCII, 1 to 256 characters                     |
| `ZQ_GIT_BIND_MAX_PER_PERSON`       | 10                                                  | names per person (self path)                                                       |                                                                            |                                                                                                  | integer 1 to 100                                             |
| `ZQ_GIT_ASK`                       | off                                                 | `1` runs the PM digest and departed notices                                        | needs mapping; live delivery needs phase 4's `ZQ_GIT_NOTIFY`, else dry-run |                                                                                                  | needs `ZQ_GIT_PM_RECIPIENT`                                  |
| `ZQ_GIT_PM_RECIPIENT`              | empty                                               | the one person (DM) for digest and departed notices                                | never a channel                                                            |                                                                                                  | non-empty when `ZQ_GIT_ASK=1`; `#` or `~` prefix is an error |
| `ZQ_GIT_ASK_DIGEST_MINUTES`        | 60                                                  | wait before asking, and cadence                                                    |                                                                            |                                                                                                  | integer 5 to 10080                                           |
| `ZQ_GIT_ASK_MAX_ITEMS`             | 20                                                  | entries per digest                                                                 |                                                                            |                                                                                                  | integer 1 to 100                                             |
| `ZQ_GIT_ASK_REASK_DAYS`            | 0 (never)                                           | re-ask an open entry after N days                                                  |                                                                            |                                                                                                  | integer 0 to 3650                                            |

No setting holds the ignore list and none takes a seed file: the ignore list is audited data in the alias table, edited at run time by the PM (a configuration list would need a deploy per change, would not carry a reason or audit, and would put names in deployment config). Removed or not carried over: `ZQ_GIT_DOMAIN_ALIASES` (retired-domain email retry; email is no longer a key); `ZQ_GIT_COMPANY_DOMAINS` (`igg.com`) is not needed because mapping no longer depends on the email domain (`igg.com` stays in examples; add it back if the PM wants digest ordering by it). Unchanged: `ZQ_GIT_AUTHOR_MAPPING`, `ZQ_GIT_IGNORED_REOPEN_DAYS`, `ZQ_GIT_UNMAPPED_RETENTION_DAYS`, `ZQ_GIT_POLL*`.

An environment that sets nothing new: mapping is by bound names only, bots by the `bot` token, no tool, no digest. An environment that already sets `ZQ_GIT_AUTHOR_MAPPING=1` changes behaviour on upgrade (the Mattermost match no longer maps); none exists today.

## 12. Schema and persisted shape: OLD (approved) versus NEW (proposed, NOT APPROVED)

Nothing is created: the approved section 8 tables exist in no environment (`ZQ_GIT_AUTHOR_MAPPING` is off everywhere). The approved text can therefore be amended before any DBA step; there is no migration, backfill or data compatibility question. This document changes no live system and does not approve anything.

### 12.1 SQL level: unchanged

For each table `T` (`zq_git_author_aliases`, `zq_git_unmapped_authors`) the durable-map layer creates what the approved text lists: `id TEXT`, `json JSONB NOT NULL`, `tenant_id UUID NOT NULL DEFAULT qm_bound_tenant()`, primary key `(tenant_id, id)`, policy `tenant_isolation`, foreign key `T_tenant` to `tenants(id)`, functions `claim_T()` and `claim_T_tenants()`, no other index, no check or unique constraint, no enum type. The only uniqueness in the database is `(tenant_id, id)`. The new id convention makes that a plain unique key on the normalised name (below); no indexed JSON field is needed (hundreds of rows, read whole, as the approved code does). The table keeps its name `zq_git_author_aliases` although it now also holds ignore rows; renaming would change an approved table name for no benefit.

### 12.2 `zq_git_author_aliases`

|                  | OLD (approved section 8)                                        | NEW (proposed)                                                                                                                     |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| id               | `<normalised email>\|<personId>`, one row per (address, person) | `<nameKey>`, one row per normalised name; `\|` and `%` inside the name are written `%7C` and `%25`. A name can never have two rows |
| `email`          | text, the key                                                   | TRANSFORMED into the optional `emailCondition` (normalised, exact string; absent = any email); no longer a key                     |
| `nameKey`        | absent                                                          | NEW text, the normalised name (equals the id before encoding)                                                                      |
| `name`           | absent                                                          | NEW text, the name as given after NFKC and whitespace collapse (display only)                                                      |
| `kind`           | absent                                                          | NEW enum string `person` or `ignored`; absent is read as `person`                                                                  |
| `personId`       | text, required                                                  | kept; required for `person`, absent for `ignored`                                                                                  |
| `mattermostUser` | text, required                                                  | kept; required for `person`, absent for `ignored`                                                                                  |
| `reason`         | absent                                                          | NEW enum string `automation` or `external`; required for `ignored`, absent for `person`                                            |
| `departedAt`     | absent                                                          | NEW optional epoch ms, on `person` rows of a departed person                                                                       |
| `addedBy`        | text                                                            | kept (equals `personId` for a self bind, the admin's id otherwise)                                                                 |
| `addedAt`        | epoch ms                                                        | kept                                                                                                                               |
| dropped          |                                                                 | none dropped; the key role of `email` is the only removed meaning                                                                  |

OLD row (invented): id `zhang.home@example.org|p-zhang`, json `{ "email": "zhang.home@example.org", "personId": "p-zhang", "mattermostUser": "mm-zhang", "addedBy": "pm", "addedAt": 1763000000000 }`.

NEW rows (invented):

- person: id `alice example`, json `{ "nameKey": "alice example", "name": "Alice Example", "kind": "person", "personId": "p-alice", "mattermostUser": "mm-alice", "addedBy": "p-alice", "addedAt": 1763100000000 }`
- person with a condition (generic name): id `host123\admin`, json `{ "nameKey": "host123\\admin", "name": "HOST123\\admin", "kind": "person", "emailCondition": "x@y.example", "personId": "p-fred", "mattermostUser": "mm-fred", "addedBy": "pm", "addedAt": 1763100100000 }`
- ignored automation: id `pipeline-sync`, json `{ "nameKey": "pipeline-sync", "name": "pipeline-sync", "kind": "ignored", "reason": "automation", "emailCondition": "@partnerco", "addedBy": "pm", "addedAt": 1763100200000 }`
- ignored external: id `visiting student`, json `{ "nameKey": "visiting student", "name": "Visiting Student", "kind": "ignored", "reason": "external", "addedBy": "pm", "addedAt": 1763100300000 }`
- the first person row after the PM marked her departed: the same json plus `"departedAt": 1763200000000`.

Uniqueness and constraints enforced in code, on top of the primary key: a self bind of a held or ignored name is refused; `personId` and `mattermostUser` present exactly for `person`; `reason` present exactly for `ignored`; a generic name requires `emailCondition`.

### 12.3 `zq_git_unmapped_authors`

|                                                                                                                                                                                           | OLD (approved section 8)                 | NEW (proposed)                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| id                                                                                                                                                                                        | normalised email (`(none)` if empty)     | `<nameKey>`; for a generic name `<nameKey>\|<email>`; when the name is empty `email:<email>`; `(none)` if both empty     |
| `email`                                                                                                                                                                                   | text                                     | TRANSFORMED into `emails`: array of up to 10 distinct normalised emails seen with this name (shown to the PM, not a key) |
| `name`                                                                                                                                                                                    | text                                     | kept (last seen display form)                                                                                            |
| `nameKey`                                                                                                                                                                                 | absent                                   | NEW text (empty for `email:` rows)                                                                                       |
| `reason`                                                                                                                                                                                  | `no_match \| invalid_email \| ambiguous` | kept, same variants; `invalid_email` now also covers an empty local part or domain                                       |
| `candidates`, `status` (`open \| resolved \| ignored`), `firstSeenAt`, `lastSeenAt`, `count`, `exampleRepo`, `exampleSha`, `recentShas` (last 200), `closedBy?`, `closedAt?`, `personId?` |                                          | kept unchanged                                                                                                           |
| `askedAt`                                                                                                                                                                                 | absent                                   | NEW optional epoch ms, cleared on reopen or reason change                                                                |
| dropped                                                                                                                                                                                   |                                          | none                                                                                                                     |

OLD row (invented): id `nobody@corp.example`, json `{ "email": "nobody@corp.example", "name": "Nobody", "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1763000000000, "lastSeenAt": 1763000900000, "count": 3, "exampleRepo": "client", "exampleSha": "c1", "recentShas": ["c1", "c2", "s1"] }`.
NEW row (invented): id `alice example`, json `{ "nameKey": "alice example", "name": "Alice Example", "emails": ["alice.example@igg.com", "a@personal.example"], "reason": "no_match", "candidates": [], "status": "open", "firstSeenAt": 1763000000000, "lastSeenAt": 1763000900000, "count": 7, "exampleRepo": "client", "exampleSha": "a1b2c3d", "recentShas": ["a1b2c3d"], "askedAt": 1763003600000 }`.

The queue status `ignored` of the existing code (a silenced row that keeps counting) is not used by this design: the PM's "ignore" answer registers an ignore-list row and closes the queue row as `resolved`, so ignored authors produce no queue row at all, as required. The status stays in the code untouched; removing it is a later simplification.

### 12.4 Rollout, compatibility, rollback

No tables exist, so nothing is migrated, backfilled or kept compatible; the approved section 8 is amended (shapes, ids, examples, and a note that it supersedes "Mattermost verified emails are the authoritative source"). If a DBA had already created the generic tables they would still be valid because the SQL is unchanged. Rollback as in section 8: unset the switches; `DROP TABLE` only if the tables were created. Configuration changes are in section 11. This section is a proposal and is NOT approved; it creates nothing.

## 13. Minimal code changes and effort

| File                                                                                                   | Change                                                                                                           | Hours                        |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `src/zq/git-mcp/names.ts` (new)                                                                        | `nameKey`, bot tokeniser, generic test, `hashName`, id encoding                                                  | 4                            |
| `src/zq/git-mcp/authors.ts`                                                                            | new order and result kinds (`person`, `ignored`, departed)                                                       | 4                            |
| `src/zq/git-mcp/author-aliases.ts`                                                                     | one row per name, kinds, `find`, list per person, departed set, conflict refusal                                 | 5                            |
| `src/zq/git-mcp/unmapped-queue.ts`                                                                     | name key, `emails`, `askedAt`, resolve by name                                                                   | 4                            |
| `src/zq/git-mcp/identity.ts` (new)                                                                     | bind rules, ignore list and import (dry-run, idempotent), holder notice, audit                                   | 9                            |
| `src/zq/git-mcp/asker.ts` (new)                                                                        | digest, departed notice, sink                                                                                    | 5                            |
| `src/zq/config.ts`                                                                                     | settings and validation, removal of `domainAliases`                                                              | 3                            |
| `people.ts`, `author-mapping.ts`, `runtime.ts`, `src/wiring.ts`                                        | optional directory, departed and ignored routing and counters, asker under the lease, audit and recipient wiring | 5                            |
| `src/agent/agent-tools/zq.ts`, `agent-tools.ts`, `src/tools/primitives.ts`, `src/core/orchestrator.ts` | tool, context method, admin flag, human-turn check                                                               | 5                            |
| docs                                                                                                   | `author-mapping.md`, `git-mcp-poll.md`, DDL section 8, wiring plan section 11                                    | 2                            |
| tests (changed and new, section 14)                                                                    |                                                                                                                  | 12                           |
| dev-instance check of the tool in Mattermost (required for agent behaviour)                            |                                                                                                                  | 3                            |
| Optional CLI wrapper for the deployment-side import                                                    |                                                                                                                  | 3                            |
| Total                                                                                                  |                                                                                                                  | about 57, plus 3 for the CLI |

## 14. Test plan (behaviour through the real resolver, tool and queue; all fixtures invented)

Resolver and normalisation:

- `pinyin and CJK names bound to one person both map to them`
- `NFKC: full-width and half-width forms of a name map the same`
- `case, trim and inner whitespace variants map the same`
- `first-l, first_l and first.l are three different names`
- `DOMAIN\name prefix is kept: plain name does not match the prefixed one, prefixed binding does`
- `HOST123\admin is generic: unbound goes to the queue under name and email; binding or ignoring it needs an email condition, also for an admin`
- `a renamed duplicate (justin01) maps to its own person and the plain name to the other`
- `a row with an email condition that does not match falls through to the next rule`
- `malformed email (empty local part, no at sign, empty domain) with a bound name maps; unbound goes to the queue as invalid_email and is never external`
- `bound name beats the bot rule and the external list; unbound bot name is bot even when its email belongs to a departed bound person`
- `departed person's commits go to the PM path and not to the person; undepart restores`
- `bot sharing a departed person's email stays a bot`
- `author only: a different committer email changes nothing`
- `no fuzzy: an email local part equal to a person's name does not map; the Mattermost match is only a hint when the fallback is off and maps only when on`
- `bot token table of section 7`, one test per row
- `plus tag is not stripped`

Ignore list:

- `ignored name with a malformed email: no notice, no queue row`
- `ignored name with a missing email: same`
- `ignored name with an email condition that does not match falls through and is queued`
- `ignored name that matches the bot pattern: dropped, counted as ignored not bot, same outcome`
- `a commit by an ignored identity produces zero notifications and zero queue rows (sink, asker and queue spies)`
- `the poll log counts ignored commits per name hash and reason and contains no name`
- `ignored versus bound conflict at registration is refused in both directions; the same for a concurrent pair (putIfAbsent, exactly one wins)`
- `self-bind of an ignored name is refused; self-bind of a bot-looking name is refused; admin may bind it with an audit row`
- `ignore_add, ignore_list and ignore_remove are admin-only, require a reason in automation or external, and are audited with hashes`
- `ignore_remove returns the author to the queue at the next sighting`
- `ignore_import dry-run (default) changes nothing and lists would-add, unchanged and refused per entry with counts per reason; apply adds; a second run is all unchanged; re-import never removes missing rows or changes a reason; a duplicate within the file and a name bound to a person are refused`

Tool (fake audit log and notice sink):

- `bind adds the caller's rows, several names in one call; the reply tells the user to run git config user.name and user.email`
- `person argument is rejected on self operations`; `system, bot-initiated and non-human turns cannot bind`
- `list shows only the caller's rows`; `unbind cannot remove another person's row`
- `a bind of a name already held is refused with the rename hint, the holder is notified once, the audit row says refused, the reply does not name the holder`
- `admin refusal shows the holder to the admin`
- `the cap is enforced`
- `non-admin cannot call admin operations; admin in a channel is refused, in a DM works`
- `bind_for closes the queue row`
- `the tool is absent in read-only turns and when ZQ_GIT_AUTHOR_BIND is off`
- `audit and log lines contain only hashes of names and emails`

Asker: `one digest per interval and only rows older than the interval`; `largest first and the cap carries the rest`; `dry-run records and marks nothing`; `live: asked once, a failed send re-sends`; `reopen re-asks`; `digest shows real names and emails, logs and audit show hashes`; `a channel-like recipient is a startup error`; `the digest never lists an ignored name`.

Config: defaults and each validation error of section 11; `fallback off does not require Mattermost`; `bind without mapping is an error`; default-off checks (no table when mapping is off) unchanged. Postgres test (gated on `DATABASE_URL`): new ids and fields round-trip, a second insert of the same name id is rejected.

Shared identity: no tests, the kind is cut (section 9).

## 15. Staging steps

1. Mapping and poll on, bind off: every author unmapped and queued by name, no message (replaces step 4 of section 11 of the wiring plan).
2. Bind on: a test user binds a name in a DM; one poll later their commits are `person`; audit row with hashes; no name or email in logs.
3. A second test user binds the same name: refused with the hint; the first user is told; a differently spelled name works.
4. As PM: `ignore_import` dry-run with a small invented list, then apply; push commits under an ignored name: zero messages, zero queue rows, a log counter with the hash and reason.
5. Mark a test user departed: their commits produce a recorded PM notice, none to them.
6. `ZQ_GIT_ASK=1`, recipient a staging account, `ZQ_GIT_NOTIFY` unset: digest recorded in memory, zero posts; then live (phase 4): one DM to the recipient, once.
7. Stop conditions: a message in dry-run, a name or email in any log or audit row, any channel post, a self operation affecting another person, the tool offered in a read-only turn, a queue row for an ignored name.
   Rollback: unset `ZQ_GIT_AUTHOR_BIND` and `ZQ_GIT_ASK`; tables and rows stay inert.

## 16. Risks

1. Name-keyed matching trusts that names are unique: if two real people share an exact name and one bound it, the other's commits are attributed to the first (silently wrong). The scan says people rename; the refusal at bind time and the holder notice make it visible; the PM can bind an email-conditioned row for one of them. This is the main weakness of name keys.
2. A person who changes `user.name` is unmapped until they bind again; fail-safe (queue), never wrong.
3. Cold start: nobody is mapped until they bind; digest cap and ordering limit the load; the onboarding reminder helps later.
4. Self-assertion on a free name is misdirection only, accepted by decision.
5. An ignore row hides all commits under that name; a wrong ignore is invisible by design. Mitigations: admin-only, audited, reason required, generic names need a condition, `ignore_list` shows everything, the log counter shows volume per name hash.
6. Fused bot names reach the queue until added.
7. Real names and emails appear in a DM and in recorded memory (PM only); logs and audit keep hashes.
8. Two identity spaces (principal versus Mattermost id) until reconciled (section 17).
9. Not stripping `DOMAIN\` costs extra bindings per person.

## 17. Not verified

1. How a Mattermost user maps to a QM principal (inbound author keys are a verified email or `mattermost:<id>`, while today's directory uses the Mattermost id as `personId`); needed for DMs and for resolving the person in `bind_for`.
2. How the PM is identified in the real deployment (org admin versus listed principal), and whether `humanTurn` is set for Mattermost DMs.
3. That the audit log accepts these free-text actions and the viewer shows them.
4. Whether Mattermost can DM a named recipient from the poll runtime (phase 4 sink, not built).
5. That `DurableMap.putIfAbsent` is atomic across instances for the new id (used today by `author-aliases.ts`; Postgres behaviour not exercised here).
6. No code, test, typecheck or dev instance was run; everything comes from reading the branches.

## 18. Disagreements with the brief

- D1. Instead of keeping ambiguity as a runtime safety net for name collisions, the key is the plain unique name, so a second person on one name is impossible by construction (primary key and `putIfAbsent`) rather than detected later. If the PM prefers rows keyed by `<name>|<personId>` so that data can collide and be reported ambiguous, the shapes of section 12 change (id convention, one more rule in the resolver) and I would not recommend it.
- D2. Shared identity is recommended to be cut (pipeline automation turned out to be the only case, and the ignore list covers it).
- D3. The ignore list is data in the existing alias table with a required reason, not configuration; the exact bot and external lists stay configuration as decided.
- D4. Explicit person bindings beat the bot rule (as instructed), so a self-bind of a bot-looking name is refused: a guard not in the brief.
- D5. The Mattermost email match is last and off; "never authoritative" is implemented by position and default, not by a marker on results.
- D6. `ZQ_GIT_COMPANY_DOMAINS` and `ZQ_GIT_DOMAIN_ALIASES` are dropped because they have no caller once email is not a key.
- D7. The approved section 8 should be AMENDED rather than extended because nothing is created yet; this needs the PM's approval and a DBA re-read.
- D8. Dropped ignored commits are not audited per commit and not stored; counts exist only as log counters (a durable counter is a separate decision).

## 19. PM decisions, with recommendation

Already decided and applied (not open): company domain `igg.com` (examples only); xiaoxiao is a Mattermost bot, not an author; bot and external domain lists come from the scan and stay configuration; people are keyed by author name and unique names are assumed; email is only an optional condition; the Mattermost match is off by default and never authoritative; the PM message shows the real name and email, goes only to the named PM by DM, never a channel, logs and audit keep hashes; a claim on a held name is refused and the holder is notified; the order is person binding, ignore list, bot, external, unmapped; departed people notify the PM; ignored authors (automation and external) produce no notice and no queue row; seed data is supplied by the PM at deployment time and never enters the repository.

Open:

| #   | Decision                                                                         | Recommendation                                                                                             |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Approve amending section 8 of the DDL proposal to the NEW shapes (no SQL change) | Approve                                                                                                    |
| 2   | Collisions: plain unique name, refuse a held name (D1)                           | Approve; no ambiguity states                                                                               |
| 3   | Keep the optional email condition                                                | Keep, used for generic names, ignore entries and narrow bindings only                                      |
| 4   | Shared identity kind                                                             | Cut; add later as an additive kind if a real case appears                                                  |
| 5   | Ignore reason enum and whether it is required                                    | `automation \| external`, required, no further values now                                                  |
| 6   | Should external authors ever be notified or mapped differently later             | Not now (silent); the reason column leaves the option open; revisit with real counts per reason            |
| 7   | Seed import path                                                                 | Tool path first (dry-run default, add-only, idempotent, audited); the CLI wrapper only if the list is long |
| 8   | Durable counters for ignored commits                                             | Log counters only for now                                                                                  |
| 9   | `DOMAIN\` prefix                                                                 | Keep it in the key; people bind both forms; no stripping list                                              |
| 10  | Hyphen, underscore, dot, Chinese/pinyin variants                                 | Not folded; bind each                                                                                      |
| 11  | Generic names list and rule                                                      | Default list; always need an email condition (bind and ignore, people and admins)                          |
| 12  | Departed flag location                                                           | On every `person` row of the person; admin `depart` / `undepart`; commits go to the PM                     |
| 13  | Self-bind of a bot-looking name                                                  | Refused for people, allowed for an admin with audit                                                        |
| 14  | Identity admins                                                                  | Org admins plus an explicit list; start with her only                                                      |
| 15  | Digest cadence, size, re-ask                                                     | 60 minutes, 20 entries, never re-ask except reopen                                                         |
| 16  | Per-person name cap                                                              | 10                                                                                                         |
| 17  | Mattermost email fallback                                                        | Keep the switch, default off                                                                               |
| 18  | Drop `ZQ_GIT_COMPANY_DOMAINS` and `ZQ_GIT_DOMAIN_ALIASES`                        | Drop both                                                                                                  |
| 19  | Onboarding reminder audience                                                     | After phase 4; everyone until they bind, once per person                                                   |
