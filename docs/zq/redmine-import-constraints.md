# Redmine import: constraints on the QM side

The importer lives with OpenProject. These are the rules QM needs while it runs and the order in which QM is turned on afterwards.

## Before and during the import

1. Every ZQ switch stays unset on the QM instance that reads the target OpenProject: `ZQ_SCANNER`, `ZQ_REMINDER_DELIVERY`, `ZQ_REPORTS`, `ZQ_CHANGE_DIGEST`, `ZQ_FEATURE_CHANNELS`, `ZQ_CHILD_ORDERS`, `ZQ_ROLEPLAY_MM_USER`, `ZQ_ROLEPLAY_PROJECTS`. Nothing reads or writes OpenProject while the import runs.
2. The importer sends no mail or notification (OpenProject side).
3. Imported history is written as readable activity notes, never as whole source documents, so the change feed carries nothing QM could mistake for a new change.

## Why no cursor reset is needed on a fresh QM

QM stores a change-feed cursor per project and person only when `ZQ_CHANGE_DIGEST` is on. The first read of a project has no cursor: QM saves the cursor and ingests no events, so everything imported before that first read is history, not news. Likewise a feature seen for the first time only records a snapshot; lines appear for later changes only. A cursor reset is needed only if the change digest ran before the import: delete the project's rows in `zq_change_cursors` (key `<projectId>:<principalId>`) or let the server answer `cursor_invalid` / `cursor_scope_changed`, which QM treats as a resync that drops the old events.

## Turning QM on after the import (nothing here is done yet)

1. **Key table.** Install the production key table first: `optimizationType`, the people fields (`planner` list, `participants`, `reviewer` as the producer), the completion properties (`delivery_result`, `delivery_submitted_at`), and `stageOwners` for the planning-acceptance stage addressed to `field:responsiblePlanner`. Without it QM reads the wrong or no owners.
2. **Identity links.** Only people with a confirmed OpenProject↔Mattermost link can be scanned; the scan runs as one of them. Unlinked users are counted as `unlinked` and receive nothing.
3. **Dry run.** Set `ZQ_SCANNER=1` with `ZQ_REMINDER_DELIVERY` unset. Reminders are recorded, not sent. Read the scan report: `featuresSeen`, `created`, `ceilingHit`, `noHolder`, `unlinked`, `unsetResponsibility`, `contractProblems`. A large `created` is expected: the whole open backlog counts as new on the first scan.
   `ZQ_RECIPIENT_ALLOWLIST` (comma-separated Mattermost user ids, empty by default = no limit) restricts every recipient QM picks: unlisted people are never scheduled a reminder, never added to a feature group, never sent a card, and a send to an unlisted id is refused. Use it for the first live phase (one person) and widen it only on the owner's say-so.
   `ZQ_MORNING_AT=09:30` (unset = off; needs `ZQ_SCANNER=1` and `ZQ_REMINDER_DELIVERY=1`) sends each linked person, on weekdays at that Shanghai time, one message with their own orders: not started, running, and, once an order is handed in, the lowest-numbered waiting order as the next one. A person with no orders gets nothing. It respects `ZQ_RECIPIENT_ALLOWLIST`.
4. **Role-play pass.** Set `ZQ_ROLEPLAY_MM_USER` and `ZQ_ROLEPLAY_PROJECTS` and turn delivery on: every message goes to the tester only, each stating who it was meant for and which rule fired. Run `scripts/zq-roleplay-report.ts` for a readable list first. Reset with `roleplayReset()` before the real run.
5. **Real run, in this order, one switch at a time:** reminders to a small set of people first (the daily ceiling `ZQ_REMINDER_DAILY_CEILING`, default 200 per person, caps a flood), then the change digest and feature groups, then reports. Each step needs the operator's explicit go.

## Identity

Accounts without a link receive nothing and are reported as `unlinked`. OpenProject users created without an email cannot be linked by email; link them by hand.
