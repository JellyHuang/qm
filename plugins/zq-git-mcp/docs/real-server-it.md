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
