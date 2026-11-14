# OpenProject MCP in QM

QM reaches OpenProject only through the existing MCP support; there is no OpenProject client in core. The OpenProject MCP server enforces its own guard: per-user OAuth, a read-only shared token, deletes and bulk updates disabled, and an audit log that records the real actor.

## Register (per-user OAuth)

An organization administrator registers the server once. No secret appears in this file; the client secret is write-only in the admin page or request body.

```
PUT /v1/admin/mcp-servers/openproject
{
  "name": "OpenProject",
  "url": "https://<op-host>:8765/mcp",
  "auth": "oauth-user",
  "clientId": "<OpenProject OAuth application uid>",
  "clientSecret": "<OpenProject OAuth application secret>",
  "oauthScopes": ["api_v3"],
  "toolContract": <contents of the contract below>
}
```

The internal CA of the OpenProject host must be trusted by core (`NODE_EXTRA_CA_CERTS`, see the deployment config). Each person signs in on first use through the `openproject_sign_in` tool. QM then acts with that person's own token, so OpenProject's audit log shows the real actor.

The contract follows OpenProject contract v0.1 (`test/fixtures/openproject-tool-contract.json` holds the exact lists):

- Required reads: `get_current_user`, `list_projects`, `get_project`, `list_types`, `get_type`, `list_statuses`, `get_status`, `get_project_work_package_context`, `list_work_packages`, `search_work_packages`, `get_work_package`, `get_work_packages`, `get_work_package_activities`, `get_work_package_relations`, `list_project_memberships`, `list_roles`, `list_meetings`, `get_meeting`, `list_meeting_agenda_items`, `list_meeting_outcomes`, `list_meeting_sections`, `get_job_status`.
- Required writes: `create_work_package`, `create_subtask`, `update_work_package`, `add_work_package_comment`, `create_work_package_relation`, `create_meeting`, `update_meeting`, `create_meeting_agenda_item`, `update_meeting_agenda_item`, `create_meeting_outcome`, `update_meeting_outcome`, `create_meeting_section`. Writes need `confirm=true` and the person's own OAuth; the shared token is read-only. Keep the default `approval: annotations` so every write still gets an approval card.
- Forbidden: `delete_*` (a trailing `*` matches any tool name with that prefix), `bulk_update_work_packages`, `cancel_recurring_meeting_occurrence`.
- The proposed `zq_*` tools are not in `required` until they exist.

Registering with the contract is what turns a silent server change into a loud failure.

## What fails and how

| Situation                                                                          | Result                                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared-token server lacks a required tool or exposes a forbidden one at admin save | `400 contract_violation` with `missing` and `forbidden`; nothing is stored                                                                          |
| `oauth-user` server, first sign-in after such a change                             | The sign-in call errors with the same message; no tools are stored                                                                                  |
| Contract tightened, or the server changes, after tools were stored                 | The next refresh withdraws that server's tools (only `openproject_sign_in` remains), writes an audit row `mcp.list … error: …` and logs the failure |

## Tests

`test/mcp-tool-contract.test.ts` runs against a mock MCP server that replays `test/fixtures/openproject-mcp-tools.json`, a hand-written listing with the 34 required tools of contract v0.1. It uses no real OpenProject, no real tokens and performs no writes.

## Follow-up rules and identity (`src/zq/`)

- Status keys are `<family>.<suffix>` (`pm`, `fm`, `dv`, `qa`, `mt`) plus `new`. `DEFAULT_FOLLOW_UP_POLICY` classifies each into open, active, blocked (`*.suspended`) or closed. The sets are not the transition graph.
- OpenProject has no status-changed time. `latestStatusChangeAt` derives it from the latest `get_work_package_activities` entry into the current status.
- Community OpenProject does not enforce exit checks, so `exitBlockers` lists the empty custom fields (by name, resolved at runtime, never by id) that must be filled before QM proposes a transition such as `fm.qa` to `fm.formal`.
- `get_current_user` returns id, name and login but no email, and work package summaries carry only the assignee's display name. The identity map therefore records a pending link on first OpenProject sign-in, which an admin or the person confirms; only confirmed links resolve. Email is an optional hint.
- Meeting follow-up is done by scanning `list_meetings`; webhooks are not a source of truth.
