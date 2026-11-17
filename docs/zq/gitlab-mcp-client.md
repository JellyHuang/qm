# GitLab MCP: the QM side

QM reads the seven GitLab repositories only through the `zq-git-mcp` service (`plugins/zq-git-mcp`). Only the `zq_git` agent tool is wired (off unless `ZQ_GIT_AGENT=1`); this document describes the pieces in `src/zq/git-mcp/`.

## How agents reach the service

Agents use the in-process tool `zq_git` when `ZQ_GIT_AGENT=1` (needs `ZQ_GIT_MCP_URL` and `ZQ_GIT_MCP_SECRET`); see `docs/zq/git-mcp-agent-access.md`. It offers the eight read operations and never `check_updates`. Registering the service as a connector is not used and cannot work against the service as deployed: it listens on `127.0.0.1`, and core's connector fetch refuses loopback addresses even when the origin is listed in `PRIVATE_NETWORK_ALLOWED_ORIGINS` (the list only opens private addresses, never loopback, link-local or metadata addresses).

For a hypothetical deployment where the service listens on a private non-loopback address, not used and not supported by the plugin today, the registration would list that origin in `PRIVATE_NETWORK_ALLOWED_ORIGINS` and use bearer auth:

```
PUT /v1/admin/mcp-servers/zq-git
{
  "name": "ZQ Git",
  "url": "http://<private-address>:8765/mcp",
  "auth": "bearer",
  "bearerToken": "<shared secret>",
  "readOnly": true,
  "toolContract": <GIT_MCP_CONTRACT>
}
```

Such a registration would also offer `check_updates` to agents, because the contract requires all nine tools.

`GIT_MCP_CONTRACT` (`src/zq/git-mcp/contract.ts`) requires exactly `list_repos`, `list_commits`, `get_commit`, `get_diff`, `read_file`, `blame`, `search`, `diff_xlsx`, `check_updates`, and forbids names starting with `push`, `write`, `archive`, `bundle`, `clone`, `delete`, `merge`, `create`, `update`, `remove`, `upload`, `commit_`, `fetch`, `pull`, `exec`, `run` or `git_`.

The names alone cannot say whether a tool takes a url or raw git arguments, or whether a differently named tool appeared. `GitMcpClient.verify()` therefore lists the tools and runs `assertGitMcpListing`: any tool outside the nine is `unexpected`, and any input property named like `url`, `remote`, `args`, `argv`, `command` or `git_args` is a violation. The `zq_git` tool runs it on first use and every five minutes and refuses to serve while it fails.

## Client

`createGitMcpClient({ url, secret })` talks to the service directly, for jobs that have no person. Every call sends `Authorization: Bearer <secret>` and `X-QM-Caller: <person or job label>`. The secret comes from configuration, is never logged, and is removed from any error message. Failures are typed: `GitMcpUnreachable` (cannot connect, wrong secret, transport), `GitMcpError` (the service answered with an error, with its code) and `GitMcpContractError` (from `verify`).

## Commit polling

`createGitCommitPoller` (`src/zq/git-mcp/poller.ts`) is an interface plus a tested implementation; it is not scheduled anywhere. Every five minutes through an injected sweeper it calls `check_updates`, hands the new commits to an injected handler, and only after the handler succeeded calls `check_updates` again with the `ack` entries of that response (the service keeps its stored tips until then, see `plugins/zq-git-mcp/docs/check-updates.md`). That second call is also the next poll, so rounds repeat until nothing is new, at most 20 per tick.

- Handler fails: no acknowledgement; the next tick receives the same commits again (at least once).
- Service unreachable, wrong secret or a service error: `onError` is called with `kind` `unreachable` or `service` and the tick ends with status `errors`. A repository whose remote could not be read is `kind: "repo"`. None of these is reported as "no updates".

## Authors

`AuthorResolver.resolve({ email, name })` answers `person` (with the Mattermost user), `unmapped`, `bot` or `external`. `classifyAuthor` applies the rules, which are data from configuration: a bot is an author whose name or the part of the email before the `@` is listed in `ZQ_GIT_BOT_NAMES` (for example `ZQBot.compiler`); an external author has an email domain equal to, or under, a domain listed in `ZQ_GIT_EXTERNAL_DOMAINS` (for example `@yizhu`). Bots and external authors never reach the mapper. `createAuthorResolver({ rules, map })` asks `map` only for the rest; without `map`, and for `unmappedAuthors`, every other author is `unmapped`. Nothing contacts anyone automatically; an unmapped author goes to the PM, as the design says.

## Settings

| Setting                   | Default | Meaning                                                                                     |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `ZQ_GIT_MCP_URL`          | unset   | `http(s)` address of the service's `/mcp` endpoint; must be set together with the secret    |
| `ZQ_GIT_MCP_SECRET`       | unset   | The shared bearer secret; never logged, never put in an error                               |
| `ZQ_GIT_AGENT`            | off     | `1` offers the `zq_git` agent tool; needs the URL and the secret, else startup fails        |
| `ZQ_GIT_EXTERNAL_DOMAINS` | empty   | Comma list of non-company email domains (`@yizhu`, `partner.example`); subdomains match too |
| `ZQ_GIT_BOT_NAMES`        | empty   | Comma list of bot author names or email local parts (`ZQBot.compiler`)                      |

They are parsed into `ZqConfig.gitMcp`, `ZqConfig.gitAgent` and `ZqConfig.gitAuthors`; only `gitAgent` is read in production. Environment variables are the only source.

## Audit retention

`zq_git_audit` rows are kept 180 days. `pruneGitAudit` (`src/zq/git-mcp/audit-retention.ts`) applies the rule through the durable map's `deleteBefore("at", cutoff)`; it is not scheduled anywhere. The service's database role has no DELETE, so pruning is a core or operator job (statement in `plugins/zq-git-mcp/docs/audit-and-storage.md`).
