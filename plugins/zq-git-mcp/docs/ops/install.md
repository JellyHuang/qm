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

## Database prerequisites

Only when a store is `postgres` (the default is `memory`, which needs no database). `zq_git_branch_tips` and `zq_git_blob_meta` are created by a DBA by hand from the approved DDL; no QM core migration creates them and the service never creates tables. A DBA creates the tables and the role with its tenant binding BEFORE the service starts with `ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS` or `ZQ_GIT_MCP_BLOB_META` set to `postgres`. `zq_git_audit` must exist too; only the removed in-process module of QM core ever created it, so the DBA checks it. If a table is missing the service prints `zq-git-mcp failed to start: the database lacks the tables <names>; the service never creates tables` and exits 1. The order and the DDL are in `database.md`.

## Every key in `config.example.env` and its code default

`config.example.env` carries the code defaults, so copying it never changes behaviour away from `src/config.ts`; only the four required settings (secret, data directory, key, fingerprint) need real values. Verified against `plugins/zq-git-mcp/src/config.ts` by loading the file through `loadConfig` (with the secret and key placeholders replaced) and comparing the result with a configuration that has only the four required settings: identical. The file has no comments by repository rule; the explanations are here.

| Key                                 | Value in the example                                 | Code default                           | Notes                                                                                       |
| ----------------------------------- | ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ZQ_GIT_MCP_SECRET`                 | placeholder                                          | none; required, at least 16 characters | bearer secret; replace the placeholder                                                      |
| `ZQ_GIT_MCP_DATA_DIR`               | `/home/zq-git-mcp/data`                              | none; required, absolute path          | the example value is the install layout, not a code default                                 |
| `GITLAB_QM_READONLY_SSH_KEY_B64`    | placeholder                                          | none; required for an ssh remote       | replace the placeholder                                                                     |
| `ZQ_GIT_MCP_SSH_HOST_FINGERPRINT`   | `SHA256:DkCVY8DnWnZqf8eTvxgHTj5IRFmOtYj3IMgVy4PiTCQ` | none; required for an ssh remote       | documented approved value; confirm it on the GitLab server (`checks.md`)                    |
| `ZQ_GIT_MCP_PORT`                   | `8765`                                               | `8765`                                 |                                                                                             |
| `ZQ_GIT_MCP_REMOTE_BASE`            | `git@lab.skyunion.net:ca-programmer-zq/`             | same                                   |                                                                                             |
| `ZQ_GIT_MCP_TRUNCATE_CHARS`         | `60000`                                              | `60000`                                | minimum 1000                                                                                |
| `ZQ_GIT_MCP_SCRATCH_CAP_BYTES`      | `21474836480`                                        | `21474836480` (20 GiB)                 |                                                                                             |
| `ZQ_GIT_MCP_FREE_FLOOR_BYTES`       | `5368709120`                                         | `5368709120` (5 GiB)                   |                                                                                             |
| `ZQ_GIT_MCP_CACHE_CAP_BYTES`        | `2147483648`                                         | `2147483648` (2 GiB)                   |                                                                                             |
| `ZQ_GIT_MCP_MAX_FETCHES`            | `4`                                                  | `4`                                    |                                                                                             |
| `ZQ_GIT_MCP_MAX_HEAVY_JOBS`         | `2`                                                  | `2`                                    |                                                                                             |
| `ZQ_GIT_MCP_MAX_BIG_FETCHES`        | `2`                                                  | `2`                                    |                                                                                             |
| `ZQ_GIT_MCP_FETCH_NO_PROGRESS_MS`   | `180000`                                             | `180000`                               |                                                                                             |
| `ZQ_GIT_MCP_FETCH_FAILURE_TTL_MS`   | `60000`                                              | `60000`                                |                                                                                             |
| `ZQ_GIT_MCP_REFRESH_MS`             | `60000`                                              | `60000`                                |                                                                                             |
| `ZQ_GIT_MCP_XLSX_TIMEOUT_MS`        | `900000`                                             | `900000`                               |                                                                                             |
| `ZQ_GIT_MCP_XLSX_MAX_HEAP_MB`       | `768`                                                | `768`                                  |                                                                                             |
| `ZQ_GIT_MCP_XLSX_NO_PROGRESS_MS`    | `180000`                                             | `180000`                               |                                                                                             |
| `ZQ_GIT_MCP_REGEX_TIMEOUT_MS`       | `30000`                                              | `30000`                                |                                                                                             |
| `ZQ_GIT_MCP_REGEX_MAX_CHARS`        | `500`                                                | `500`                                  |                                                                                             |
| `ZQ_GIT_MCP_FETCH_TIMEOUT_MS`       | `1800000`                                            | `1800000`                              |                                                                                             |
| `ZQ_GIT_MCP_GIT_TIMEOUT_MS`         | `60000`                                              | `60000`                                |                                                                                             |
| `ZQ_GIT_MCP_AUDIT_ON_FAILURE`       | `serve`                                              | `serve`                                | `fail` is an explicit opt-in                                                                |
| `ZQ_GIT_MCP_AUDIT`                  | `memory`                                             | `memory`                               | production sets `postgres` after the DBA step (`database.md`)                               |
| `ZQ_GIT_MCP_TIPS`                   | `memory`                                             | `memory`                               | production sets `postgres` after the DBA step                                               |
| `ZQ_GIT_MCP_BLOB_META`              | `memory`                                             | `memory`                               | production sets `postgres` after the DBA step                                               |
| `ZQ_GIT_MCP_AUDIT_SPOOL_DIR`        | `/home/zq-git-mcp/data/audit-spool`                  | `<data dir>/audit-spool`               | equal to the default with the example data directory; only used with a postgres audit store |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES`  | `67108864`                                           | `67108864` (64 MiB)                    |                                                                                             |
| `ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS` | `604800000`                                          | `604800000` (7 days)                   |                                                                                             |
| `ZQ_GIT_MCP_PATH`                   | `/usr/local/bin:/usr/bin:/bin`                       | same                                   | the directory of `ZQ_GIT_MCP_GIT_BIN` is put first when that is set                         |

Settings that are deliberately not in the example file because the code default is "unset" (add them only as described):

| Key                                              | Code default                                   | When to add it                                                                                   |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ZQ_GIT_MCP_DATABASE_URL`                        | unset                                          | required once any store is `postgres`; `postgres://zq_git_mcp:<password>@<db-host>:5432/<qm_db>` |
| `ZQ_GIT_MCP_TENANT_ID`                           | unset                                          | optional, a real uuid; production binds the tenant on the role instead                           |
| `ZQ_GIT_MCP_GIT_BIN`, `ZQ_GIT_MCP_SSH_BIN`       | unset (git and ssh found on `ZQ_GIT_MCP_PATH`) | absolute path, when git is not in a system directory (`checks.md`)                               |
| `ZQ_GIT_MCP_SCRATCH_DIR`, `ZQ_GIT_MCP_CACHE_DIR` | `<data dir>/scratch`, `<data dir>/cache`       | absolute path, to move them                                                                      |
| `ZQ_GIT_MCP_CONFIG`                              | unset                                          | path of a JSON file with the same settings in camelCase; the environment wins                    |

Mismatches found in the earlier version of the example file and fixed: `ZQ_GIT_MCP_AUDIT`, `ZQ_GIT_MCP_TIPS` and `ZQ_GIT_MCP_BLOB_META` were `postgres` (code default `memory`), so a copy-paste switched the stores on before the tables existed; `ZQ_GIT_MCP_TENANT_ID=<tenant-uuid-optional>` is not a uuid and made `loadConfig` throw `tenantId: Invalid UUID`; `ZQ_GIT_MCP_DATABASE_URL` carried a placeholder that is not a default; and the file held comment lines, which the repository rule forbids. Keep `TMPDIR` (the base of the ssh runtime directory) at most 72 characters; this is set in the systemd unit, not in this file (`install.md`, "Short paths for the ssh socket").

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
