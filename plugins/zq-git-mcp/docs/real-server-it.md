# Real server integration test

`test/real-server-it.test.ts` starts the service in-process against the real GitLab remote (`git@lab.skyunion.net:ca-programmer-zq/`) with a read-only key and exercises two cases. It only reads; nothing is written to the remote.

1. `gameconfig`: lists the `.xlsx` files under `designer_config/`, reads up to 14 candidates (`string.xlsx` first, the rest evenly spread) to learn their sizes, keeps those with at least two commits and a size of at most 12 MB, and runs `diff_xlsx` on the two most recent commits touching the smallest, a middle and the largest of them. One JSON line per file: `path`, `sizeBytes`, `baseSha12`, `headSha12`, `seconds`, `differences`, `kind`, `summary`, `rssPeakMB`. It asserts the call succeeds, the kind is `xlsx_diff` or `unchanged`, and the process RSS growth stays under the bound.
2. `zq-ui`: reads a 64 KB range of `.psd` files (each capped at 400 MB, stopping at one near 229 MB, otherwise the largest below the cap). One JSON line: `path`, `sizeBytes`, `seconds`, `mbPerSec`, `rssPeakMB`, `childPeakMB` (peak of descendant processes by name, such as `index-pack`, `ssh`, `git`), `packPeakMB`, `sha256`, range, `downloadedMB`. It asserts the RSS growth stays under the bound, which shows `core.bigFileThreshold` streaming works on the real server.

RSS is the test process RSS (the service runs in-process, the xlsx worker is a thread), sampled every 100 ms. Child peaks are `VmHWM` of processes seen in the sample. A blob that exceeds its cap is aborted by cancelling the call once the temporary pack directory grows past the cap.

## Environment

| Variable                              | Meaning                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_GIT_MCP_IT_KEY_B64`               | Base64 private key (read-only). `GITLAB_QM_READONLY_SSH_KEY_B64` is accepted as a fallback. Never printed.                 |
| `ZQ_GIT_MCP_IT_HOST_FINGERPRINT`      | Approved host key fingerprint, `SHA256:...`.                                                                               |
| `ZQ_GIT_MCP_IT_BASE_URL`              | Optional. A `file://` directory with `gameconfig.git` and `zq-ui.git` bare repos; replaces the real remote, no key needed. |
| `ZQ_GIT_MCP_IT_XLSX_RSS_BOUND_MB`     | Default 700.                                                                                                               |
| `ZQ_GIT_MCP_IT_PSD_RSS_BOUND_MB`      | Default 300.                                                                                                               |
| `ZQ_GIT_MCP_IT_XLSX_CANDIDATES`       | Candidates read to learn sizes, default 14.                                                                                |
| `ZQ_GIT_MCP_IT_XLSX_CANDIDATE_CAP_MB` | Per candidate cap, default 60.                                                                                             |
| `ZQ_GIT_MCP_IT_XLSX_PICK_MAX_MB`      | Largest workbook diffed, default 12.                                                                                       |
| `ZQ_GIT_MCP_IT_XLSX_LEARN_BUDGET_MB`  | Size learning budget for xlsx, default 450.                                                                                |
| `ZQ_GIT_MCP_IT_PSD_CAP_MB`            | Per PSD cap, default 400.                                                                                                  |
| `ZQ_GIT_MCP_IT_PSD_TARGET_MB`         | Stop at a PSD within 10% of this size, default 229.                                                                        |
| `ZQ_GIT_MCP_IT_PSD_PATH`              | Optional PSD path to try first, which avoids downloading other candidates.                                                 |
| `ZQ_GIT_MCP_IT_DOWNLOAD_BUDGET_MB`    | No further candidate is started when less than its cap remains, default 1400.                                              |

The test is skipped unless the key and fingerprint, or the base URL, are set.

## Cost

- Runtime: a few minutes to about 20 minutes, depending on the link. Each test has a 20 minute timeout.
- Download: under 1.5 GB by the budget above; typically 450 MB for the size learning plus up to a few hundred MB for the PSD. The first `ensure` also clones the blobless history of each repo.
- Disk: a temporary directory under the system temp dir (`zqgit-it-*`) holds clones, scratch and cache, up to about 3 GB at worst, and is removed at the end. The service also needs 1 GB free on that disk.

## Run

```
cd plugins/zq-git-mcp
npm ci
ZQ_GIT_MCP_IT_KEY_B64=... ZQ_GIT_MCP_IT_HOST_FINGERPRINT=SHA256:... node --test test/real-server-it.test.ts
```

Requires git 2.44 or newer and node 24 or newer.

## Changes after the first real run

- Temporary directories are short (`/tmp/zqit.<pid>` from the wrapper, `zi-*` from the test) because the ssh control socket path must stay under 107 characters.
- `ZQ_GIT_MCP_GIT_BIN`, `ZQ_GIT_MCP_PATH` and `ZQ_GIT_MCP_SSH_BIN` are passed through to the service, so a git built under `/opt` can be used.
- The xlsx test now walks back through the commits of a path. For every file it tries up to `ZQ_GIT_MCP_IT_XLSX_PAIRS` (default 6) pairs of consecutive commits and moves on when a pair gives `file_added`, `file_removed` or an LFS result. Only `xlsx_diff` and `unchanged` count as results. Every attempted pair prints one JSON line, with `suite` `gameconfig-diff-xlsx-attempt` for skipped or failed pairs and `gameconfig-diff-xlsx` for a real one. The largest candidate workbook is always attempted first. The test fails if any call returned an error or if no real diff was produced.

## Structure diagnostics (no content)

`ZQ_GIT_MCP_IT_DIAG_REPO` switches the file to a read-only diagnostic: the other tests are skipped and, for each pair, the same parse pipeline as `diff_xlsx` runs and prints one JSON line per workbook, sheet and side with `suite` `xlsx-diag`. The lines contain sheet names, counts, column letters and the reasons of the header decision, never a cell value or a header text.

| Variable                                            | Meaning                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_GIT_MCP_IT_DIAG_REPO`                           | Repository, for example `gameconfig`                                                                                                                     |
| `ZQ_GIT_MCP_IT_DIAG_PAIRS`                          | `path:baseBlob:headBlob`, comma separated. Blob ids are 7 to 40 hex digits; a short id is resolved from the history of the path, so the path is required |
| `ZQ_GIT_MCP_IT_DIAG_REF`                            | Ref whose history is used to resolve short blob ids, default `main`                                                                                      |
| `ZQ_GIT_MCP_IT_DIAG_PATH`, `_BASE_REF`, `_HEAD_REF` | Alternative: one path and two refs                                                                                                                       |
| `ZQ_GIT_MCP_IT_DIAG_BASE_BLOB`, `_HEAD_BLOB`        | Alternative: two full or short blob ids (a short id needs `_PATH`)                                                                                       |

Through the wrapper: `ZQ_MCP_IT_MODE=diag ZQ_MCP_IT_DIAG_REPO=gameconfig ZQ_MCP_IT_DIAG_PAIRS=<path>:<base>:<head>[,...] scripts/zq-git-mcp-real-it.sh`.

## Pair formats, errors and the override mode

`ZQ_GIT_MCP_IT_DIAG_PAIRS` entries are explicit: `ref:<path>:<baseRef>:<headRef>` (commits or refs) and `blob:<path>:<baseOid>:<headOid>` (blob ids of 7 to 40 hex digits; a short id is resolved from the history of the path). The old `<path>:<a>:<b>` form means `ref`. A value that is a commit given as a blob id is named: "is a commit, not a blob id: use the ref form". A failing diagnostic prints a `{"suite":"xlsx-diag","type":"error"}` line, and the wrapper prints the last 40 lines of the run output with the key removed.

`ZQ_GIT_MCP_IT_OVERRIDE_PATH`, `_BASE_REF`, `_HEAD_REF` (optional `_REPO`, default `gameconfig`, and `_KEY_COLUMNS`, comma separated letters or names) run `diff_xlsx` with the defaults, read `suggestedKeyColumns` of every sheet with key ambiguity, rerun with `overrides` for that sheet (the suggestion, then the suggestion plus one more of the first six columns, at most six attempts) and print one line per default sheet and attempt with `ambiguousKeys` before and after, `changedCells`, `rowsAdded`, `rowsRemoved` and the key letters used, never a value. Against a local fixture (`ZQ_GIT_MCP_IT_BASE_URL`) the test fails if a sheet stays ambiguous. Wrapper: `ZQ_MCP_IT_MODE=override ZQ_MCP_IT_OVERRIDE_PATH=<path> ZQ_MCP_IT_OVERRIDE_BASE_REF=<ref> ZQ_MCP_IT_OVERRIDE_HEAD_REF=<ref> scripts/zq-git-mcp-real-it.sh`.
