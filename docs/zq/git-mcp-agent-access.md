# How QM's agents reach the git MCP service

Decision: route B, an in-process agent tool `zq_git` that uses the direct QM-side client (`src/zq/git-mcp/client.ts`). Chosen 2026-11-17 by the reviewer; to be confirmed by the PM. It can be replaced later by route A+C below without changing what the agent sees.

## What it is

- Off by default. `ZQ_GIT_AGENT=1` offers one tool, `zq_git`, with eight read operations: `list_repos`, `list_commits`, `get_commit`, `get_diff`, `read_file`, `blame`, `search`, `diff_xlsx`. It needs `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET`; `ZQ_GIT_AGENT=1` without them stops startup with a configuration error. The URL and secret alone enable nothing.
- `check_updates` is not an operation and no argument named `ack` exists. Each operation has a strict schema, so an unknown argument is refused before anything is sent. The set of operations is a constant in the module, so the tool cannot be made to call any other service tool.
- Every call carries `X-QM-Caller`: the person who asked (their canonical principal id), or `qm-job` for a turn that has no person (scheduled work, system actors). The service writes it into its audit rows. The secret goes only in the `Authorization` header and is removed from every error.
- On first use and every five minutes the tool runs `client.verify()`. A service that drops a tool, adds a write-like tool or a tool taking raw git arguments disables `zq_git` with a clear message until a later check passes.
- The tool is read-only, so it is also offered in read-only turns.
- The service keeps listening on `127.0.0.1` only. No change to the plugin, to `src/util/network.ts`, to `PRIVATE_NETWORK_ALLOWED_ORIGINS`, to the MCP server record or to the admin API.

## Why route B

- No extra network exposure: the service stays on loopback, bearer secret held by core only.
- `check_updates` is unreachable by construction (a fixed operation list), so the agent cannot advance stored branch tips. This needs no guard in the plugin.
- Nothing to relax in core: the connector fetch refuses loopback even when the origin is listed, and this route does not use it.
- Cost: a tool description and eight argument schemas to maintain in core; they mirror the plugin's schemas and are checked by tests against a fake service.
- The poller (`createGitCommitPoller`) keeps its own client and the label it is configured with; it is the only caller of `check_updates`.

## Rejected options

- (a) Plugin bind address made configurable, service on a private address, origin in `PRIVATE_NETWORK_ALLOWED_ORIGINS`, registered as a connector. The allowlist lets core's guarded fetch reach private (not loopback, link-local or metadata) addresses of exactly the listed origins, for every request core makes to that origin. Nothing in core weakens, but the service becomes reachable on the private network and is then protected by the bearer secret and a firewall only; the git SSH key holder is a network service rather than a loopback one. It also exposes `check_updates` (the contract requires it) to agents.
- (c) (a) plus a guard: the plugin refuses `ack` unless the caller label equals a configured poller label, or a core tool allowlist hides `check_updates`. The label is self-declared, so the guard is defence in depth, not a boundary; a core allowlist needs a new field on the persisted MCP server record, which needs human review.
- A Unix socket or reverse arrangement: core's connector fetch is an HTTP(S) address fetch (`createPublicFetch`, which dials a resolved IP and port); it cannot dial a socket path, so this would need new transport code in core.

## What route A+C would need if the PM prefers it

Plugin: a listen-host setting (default `127.0.0.1`, wildcard refused without an explicit acknowledgement) and the `ack` guard with a poller label. Core: the service origin in `PRIVATE_NETWORK_ALLOWED_ORIGINS`, a tool allowlist (`allowedTools`) on the MCP server record applied when listing and when calling, an admin registration with the contract, and a firewall allowing only core. The allowlist field is a payload shape change that is not part of this change and would need approval first.

## Configuration and schema disclosure

| Setting        | Default | Meaning                                                                                         |
| -------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `ZQ_GIT_AGENT` | off     | `1` offers `zq_git`; requires `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET`, otherwise startup fails |

Supported combinations: nothing set (nothing happens); URL and secret only (the existing parse, nothing enabled); URL, secret and `ZQ_GIT_AGENT=1` (the tool). `ZQ_GIT_AGENT=1` alone and a URL without a secret (or the reverse) are startup errors. Environment only, no admin setting.

Schema and persisted or API payload shapes: unchanged. No table, no durable map, no migration, no field on the MCP server record, no admin API change. The service's `zq_git_audit` rows keep their existing shape; the `principal` value is now the person's label, as the approved design already says.
