# Install layout

> **DRAFT.** Nothing described here has been deployed or executed. Deploying needs the PM's explicit written approval.

## User

A dedicated system account `zq-git-mcp`, no login shell, home `/home/zq-git-mcp`, member of no other group. Nothing else runs as it.

## Directories

| Path                                                         | Owner                 | Mode    | Content                                                                                             |
| ------------------------------------------------------------ | --------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `/opt/zq-git-mcp/releases/<id>/plugins/{zq-git-mcp,chassis}` | root                  | 0755    | code; `zq-git-mcp` imports `../../chassis/src/*` by relative path, so both ship together            |
| `/opt/zq-git-mcp/current`                                    | root                  | symlink | the active release                                                                                  |
| `/etc/zq-git-mcp/`                                           | root:zq-git-mcp       | 0750    | config directory                                                                                    |
| `/etc/zq-git-mcp/zq-git-mcp.env`                             | zq-git-mcp:zq-git-mcp | 0600    | all settings including the key and shared secret                                                    |
| `/home/zq-git-mcp/data`                                      | zq-git-mcp            | 0700    | `ZQ_GIT_MCP_DATA_DIR`                                                                               |
| `data/clones`                                                | zq-git-mcp            | 0700    | seven blobless bare clones (about 97 MB measured in the design)                                     |
| `data/cache`                                                 | zq-git-mcp            | 0700    | LRU blob cache, cap 2 GiB (the "blobs" directory)                                                   |
| `data/scratch`                                               | zq-git-mcp            | 0700    | per-job scratch, cap 20 GiB, free floor 5 GiB                                                       |
| `data/ssh`                                                   | zq-git-mcp            | 0700    | parent of the runtime SSH directory (below)                                                         |
| `data/audit-spool` (`ZQ_GIT_MCP_AUDIT_SPOOL_DIR`)            | zq-git-mcp            | 0700    | `segment-<n>.jsonl` files (0600), bounded write-ahead buffer, only used with a postgres audit store |

`clones`, `scratch` and `cache` are fixed names under `dataDir` in `src/config.ts`; `ZQ_GIT_MCP_SCRATCH_DIR` and `ZQ_GIT_MCP_CACHE_DIR` can move the last two (absolute paths). Data under `/home` keeps growth away from the root filesystem; check the space (`checks.md`).

## The ssh private directory

The code does not keep the key in the data directory. `src/ssh.ts` creates `mkdtemp(os.tmpdir()/z-*)` at start, writes `key` and `known_hosts` (0600), keeps the ControlMaster socket there, and on stop overwrites the key with zeros and removes the directory. To keep it on the data volume under the service user, the unit sets `TMPDIR=/home/zq-git-mcp/data/ssh`. mkdtemp creates it 0700.

## Why the key and config are readable only by the service user

Anyone holding the read key can clone every repository it sees (it currently authenticates as a personal GitLab user and also sees a repository outside the seven), so anything it can read could be read with any git client. The key is read-only, and the service never runs archive, bundle or clone like commands for a caller. The service allowlist is the only guard. So the key lives only in the service's own 0600 file, is never given to QM core, agents, sandboxes or logs, and ordinary sessions must not be able to read `/etc/zq-git-mcp` or `/home/zq-git-mcp`. The same file holds the shared secret that lets QM call the service and the database password. The key is an environment variable (`GITLAB_QM_READONLY_SSH_KEY_B64`, base64 of the private key file), so it is also visible in `/proc/<pid>/environ` to the same user and root only.

## Commands (for a human to run after approval; not executed)

```
useradd --system --create-home --home-dir /home/zq-git-mcp --shell /usr/sbin/nologin zq-git-mcp
chmod 0700 /home/zq-git-mcp
install -d -o root -g zq-git-mcp -m 0750 /etc/zq-git-mcp
install -d -o zq-git-mcp -g zq-git-mcp -m 0700 /home/zq-git-mcp/data /home/zq-git-mcp/data/ssh
install -o zq-git-mcp -g zq-git-mcp -m 0600 /dev/null /etc/zq-git-mcp/zq-git-mcp.env
```

Build the release with `npm ci --omit=dev` inside `plugins/zq-git-mcp` (lockfile present). It starts with `node src/index.ts` (`npm start`); Node 24 runs the TypeScript directly.

## plugins/chassis ships with the service

The service imports `../../chassis/src/...` by relative path (error helpers, node:http helpers). Install the whole `plugins/zq-git-mcp` directory together with `plugins/chassis` and keep the two side by side (`<root>/plugins/zq-git-mcp`, `<root>/plugins/chassis`); the service does not start without it. `chassis` has no dependencies and imports nothing from QM core.

## Short paths for the ssh socket

Keep `TMPDIR` (the base of the ssh runtime directory) at most 72 characters. The socket is `<TMPDIR>/z-XXXXXX/c` plus 17 characters added by ssh while it creates the socket; unix sockets stop at 107 characters. With `TMPDIR=/home/zq-git-mcp/data/ssh` (25 characters) the worst case is 53 characters. The service checks this at start and refuses to run when it would exceed 100.

## Settings for a git or ssh outside the system directories

`ZQ_GIT_MCP_GIT_BIN=/opt/git247/bin/git`, optional `ZQ_GIT_MCP_SSH_BIN` and `ZQ_GIT_MCP_PATH` (default `/usr/local/bin:/usr/bin:/bin`); see `checks.md`.
