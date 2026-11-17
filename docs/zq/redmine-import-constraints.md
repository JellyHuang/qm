# Redmine import: constraints on the QM side

The importer lives with OpenProject. These are the rules QM needs while it runs.

## Before

1. Leave `ZQ_SCANNER`, `ZQ_REPORTS`, `ZQ_CHANGE_DIGEST` and `ZQ_FEATURE_CHANNELS` off on the instance that reads the target OpenProject. Imported history in old stages would otherwise produce reminders, groups and change digests for thousands of old tickets.
2. `ZQ_REMINDER_DELIVERY` stays off too; with the scanner off nothing is scheduled, but this is the second guard.
3. Run the first imports into a test project that is not in any real person's scope, and never in a project listed in `ZQ_ROLEPLAY_PROJECTS` unless the aim is to rehearse.
4. The importer itself must not send mail or notifications (OpenProject side).

## After

1. Let the OpenProject change feed take the imported tickets in as history: restart the scanner only after the import has finished.
2. The first scan after a restart records baselines silently for tickets QM has not seen, and the change feed resyncs when its cursor is invalid or its scope changed (`cursor_invalid`, `cursor_scope_changed`), dropping the old events. To force that for a project, delete its cursor rows (`zq_change_cursors`, key `<projectId>:<principalId>`) before turning the scanner on.
3. Turn the scanner on with `ZQ_REMINDER_DELIVERY` off first (dry-run reminders are recorded, not sent), read the scan report for `created`, `ceilingHit` and `unlinked`, and only then enable delivery.
4. Imported tickets in terminal stages generate no reminders. Imported tickets in open stages will, once, on the first delivering scan; the daily ceiling (`ZQ_REMINDER_DAILY_CEILING`) applies per person.

## Identity

Accounts without an email (for example historical placeholder users) cannot be linked to Mattermost users and are reported as `unlinked` in the scan; they receive nothing.
