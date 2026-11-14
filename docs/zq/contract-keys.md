# Contract key table

QM reads stage, lifecycle and duty keys from one JSON file named by `ZQ_CONTRACT_FILE`. OpenProject owns it and fills it in; QM matches on the keys and never on Chinese display names. `test/fixtures/zq-contract-keys.json` is the shape with draft values.

| Key                             | Meaning                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                       | Version of the table; bump it when a key changes                                                                                             |
| `featureType`                   | `type_key` of the 功能总单                                                                                                                   |
| `typeDuties`                    | `type_key` of every child order mapped to the duty that assigns people to it (`art_lead`, `client_lead`, `server_lead`, `planning_lead`)     |
| `stages.feature`, `stages.task` | Stage key to Chinese label                                                                                                                   |
| `stageOwners`                   | Feature stage key to the people QM addresses: `duty:<duty>` (a project duty holder), `field:responsiblePlanner` (the planner on the feature) |
| `fields`                        | Names of the properties of `zq_get_work_package` that carry the responsible planner, the estimate, the planned start and the planned end     |
| `duties`                        | Duty key to the name OpenProject uses for it (`producer`, `pm`, `art_lead`, `client_lead`, `server_lead`, `planning_lead`, `qa_lead`)        |
| `tools`                         | Optional tool names, each unavailable until OpenProject publishes it                                                                         |

Lifecycle keys are fixed: `normal`, `delayed`, `suspended`, `cancelled`.

## What QM expects from `zq_get_work_package`

`{ id, subject, type_key, status_key, lifecycle, project_id, parent_id?, status_changed_at?, assignee?: {id, login, name}, due_date?, <fields.*> }`, where the responsible planner is `{id, login, name} | null`, the estimate is a number of hours or an ISO 8601 duration, and the planned dates are ISO 8601.

## Optional tools

- `tools.exitCheck`, called with `{ id }`: `{ ready: boolean, blockers: [{ code, message }] }`.
- `tools.meetingsForFeature`, called with `{ id }` and paged by `next_offset`: `{ results: [{ id, title, end_time, state }] }`; `state` is `draft | open | in_progress | closed | cancelled`.
- `tools.dutyHolders`, called with `{ project_id, duty }` and paged: `{ results: [{ id, login, name }] }`; empty means nobody holds the duty, several means several.
