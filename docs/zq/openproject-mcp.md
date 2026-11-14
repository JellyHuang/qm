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
  "toolContract": {
    "required": ["list_projects", "list_work_packages", "get_work_package", "update_work_package", "add_comment"],
    "forbidden": ["delete_work_package", "bulk_update_work_packages"]
  }
}
```

The internal CA of the OpenProject host must be trusted by core (`NODE_EXTRA_CA_CERTS`, see the deployment config). Each person signs in on first use through the `openproject_sign_in` tool. QM then acts with that person's own token, so OpenProject's audit log shows the real actor.

The tool names above are provisional until the OpenProject side publishes its contract; change `required` and `forbidden` to match it. Registering with the contract is what turns a silent server change into a loud failure.

## What fails and how

| Situation                                                                          | Result                                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared-token server lacks a required tool or exposes a forbidden one at admin save | `400 contract_violation` with `missing` and `forbidden`; nothing is stored                                                                          |
| `oauth-user` server, first sign-in after such a change                             | The sign-in call errors with the same message; no tools are stored                                                                                  |
| Contract tightened, or the server changes, after tools were stored                 | The next refresh withdraws that server's tools (only `openproject_sign_in` remains), writes an audit row `mcp.list … error: …` and logs the failure |

## Tests

`test/mcp-tool-contract.test.ts` runs against a mock MCP server that replays `test/fixtures/openproject-mcp-tools.json`, a hand-written listing shaped like the OpenProject server. It uses no real OpenProject, no real tokens and performs no writes.
