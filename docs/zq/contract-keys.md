# Contract key table

QM reads stage, lifecycle and duty keys from one JSON file named by `ZQ_CONTRACT_FILE`. OpenProject owns it and fills it in; QM matches on the keys and never on Chinese display names. `test/fixtures/zq-contract-keys.json` is the shape with draft values.

| Key                             | Meaning                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                       | Version of the table; bump it when a key changes                                                                                                                                                                  |
| `featureType`                   | `type_key` of the 功能总单                                                                                                                                                                                        |
| `typeDuties`                    | `type_key` of every child order mapped to the duty that assigns people to it (`art_lead`, `client_lead`, `server_lead`, `planning_lead`)                                                                          |
| `stages.feature`, `stages.task` | Stage key to Chinese label                                                                                                                                                                                        |
| `stageOwners`                   | Feature stage key to the people QM addresses: `duty:<duty>` (a project duty holder) or `field:<name>` (a person on the feature): `responsiblePlanner`, `pm`, `reviewer`, `qaOwner`, `acceptor`, `regressionOwner` |
| `fields`                        | Names of the properties of `zq_get_work_package` that carry the responsible planner, the estimate, the planned start and the planned end                                                                          |
| `duties`                        | Duty key to the name OpenProject uses for it (`producer`, `pm`, `art_lead`, `client_lead`, `server_lead`, `planning_lead`, `qa_lead`)                                                                             |
| `tools`                         | Optional tool names, each unavailable until OpenProject publishes it                                                                                                                                              |

Lifecycle keys are fixed: `normal`, `delayed`, `suspended`, `cancelled`.

## What QM reads from `zq_list_work_packages`

Called with `{ limit: 100, offset }` and paged by `next_offset` until it is `null` (`total` is never trusted). QM reads each normalized object (`stage_key` is the stage; `status_key` is a same-value alias used when `stage_key` is missing; if both are present and differ, that order is skipped and reported as a contract problem): `{ id, subject, project_id, type_key, stage_key (falls back to status_key), lifecycle, parent_id, assignee: {id, login, name, type} | null, due_date, status_changed_at?, <fields.*> }`. `fields` names the properties for the responsible planner (`{id, login, name} | null`), the estimate (hours, or an ISO 8601 duration), and the planned start and end. A date without a time is a Shanghai calendar day: it ends at 23:59:59.999 +08:00. An assignee whose `type` is not `User` (a group) does not count as a person assigned. An error comes back as `{ error: { code, message } }`; `not_found` on an optional tool means the feature is not visible and the answer is left out, any other code fails that person's scan.

## Optional tools

- `tools.exitCheck`, called with `{ id }`: `{ ready: boolean, blockers: [{ code, message }] }`.
- `tools.meetingsForFeature`, called with `{ id }` and paged by `next_offset`: `{ results: [{ id, title, end_time, state }] }`; `state` is `draft | open | in_progress | closed | cancelled`.
- `tools.dutyHolders`, called with `{ project_id, duty }` and paged: `{ results: [{ id, login, name }] }`; empty means nobody holds the duty, several means several.

## Empty responsibility fields

A person field named by `stageOwners` that is empty on the feature is never replaced by a duty group. QM sends no reminder for it and instead emits `responsibility-not-set` to the duties in `ZQ_UNSET_RESPONSIBILITY_DUTIES` (none by default, so it is only counted in the scan report).
