# GitLab MCP: the QM side

QM reads the seven GitLab repositories only through the `zq-git-mcp` service (`plugins/zq-git-mcp`). Nothing here is wired into production yet; this document describes the pieces in `src/zq/git-mcp/`.

## Register the service as an MCP server

An organization administrator registers it once, like OpenProject. The service listens on loopback and takes a shared secret, so the registration uses bearer auth:

```
PUT /v1/admin/mcp-servers/zq-git
{
  "name": "ZQ Git",
  "url": "http://127.0.0.1:8765/mcp",
  "auth": "bearer",
  "bearerToken": "<shared secret>",
  "readOnly": true,
  "toolContract": <GIT_MCP_CONTRACT>
}
```

`GIT_MCP_CONTRACT` (`src/zq/git-mcp/contract.ts`) requires exactly `list_repos`, `list_commits`, `get_commit`, `get_diff`, `read_file`, `blame`, `search`, `diff_xlsx`, `check_updates`, and forbids names starting with `push`, `write`, `archive`, `bundle`, `clone`, `delete`, `merge`, `create`, `update`, `remove`, `upload`, `commit_`, `fetch`, `pull`, `exec`, `run` or `git_`. With the contract, the existing connector code rejects a server that drops a tool or adds a forbidden one at save and at every refresh (`contract_violation`, tools withdrawn), as for OpenProject.

The names alone cannot say whether a tool takes a url or raw git arguments, or whether a differently named tool appeared. `GitMcpClient.verify()` therefore lists the tools and runs `assertGitMcpListing`: any tool outside the nine is `unexpected`, and any input property named like `url`, `remote`, `args`, `argv`, `command` or `git_args` is a violation. `verify()` is meant to run at start and at every refresh by the job that uses the client.

When the server is registered with `attestActor` (catalog, shared bearer), the connector sends the signed-in person in `x-qm-actor`; the service uses it as the audit label when no `X-QM-Caller` is present.

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
| `ZQ_GIT_EXTERNAL_DOMAINS` | empty   | Comma list of non-company email domains (`@yizhu`, `partner.example`); subdomains match too |
| `ZQ_GIT_BOT_NAMES`        | empty   | Comma list of bot author names or email local parts (`ZQBot.compiler`)                      |

They are parsed into `ZqConfig.gitMcp` and `ZqConfig.gitAuthors` and read by nothing in production yet. Environment variables are the only source.

## Audit retention

`zq_git_audit` rows are kept 180 days. `pruneGitAudit` (`src/zq/git-mcp/audit-retention.ts`) applies the rule through the durable map's `deleteBefore("at", cutoff)`; it is not scheduled anywhere. The service's database role has no DELETE, so pruning is a core or operator job (statement in `plugins/zq-git-mcp/docs/audit-and-storage.md`).
