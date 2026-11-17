# Patch package, phase 4 design: LFS files, apply scripts, git-native import

Status: DESIGN ONLY, written 2026-11-17. No product code, no setting, no table and no deployed component changes with this document. Everything marked "tested" was run in throwaway repositories on this machine (git 2.52.0, Linux, `/bin/sh` is bash in POSIX mode). Nothing was run against GitLab, the git MCP service, Mattermost or a Windows machine.

Name: "phase 4" here is the fourth step of the patch package design (library, repo-source spike, retention, and this format redesign). It is not phase 4 of `docs/zq-git-mcp-wiring-plan.md`; it changes what wiring phase 5 (the tool) builds and what phase 6 (retention and delivery) stores.

Sources read: on `oa/spike-git` the wiring plan (sections 4, 5, 6), `docs/zq-patch-package-repo-source.md` and the staging plan; on `oa/zq-patch-package` `docs/zq/patch-package.md`, `patch-package-retention.md` and `src/zq/patch-package/*` (`text.ts`, `git.ts`, `xlsx.ts`); on `oa/zq-wire-1-access` `docs/zq/git-mcp-agent-access.md`, `plugins/zq-git-mcp/docs/handoff.md`, `src/tools/read-file.ts`, `text-scan.ts`, `lfs.ts`. Repository rules from `CLAUDE.md` apply to the later implementation (no comments in code, no AI attribution, configuration and schema disclosure, behavior tests).

## Plain summary for the PM (15 lines)

1. A package stays one directory (one zip): a `git format-patch` mbox for the text changes, the real files for anything under Git LFS, a commit message file, `manifest.json`, a plain `README.txt`, and one apply script in two forms (`apply.sh`, `apply.ps1`).
2. The builder decides which files are LFS by running git's own attribute engine on the repository's `.gitattributes` files, and also by looking at whether the base file is an LFS pointer. Any LFS file switches the package to "file plus script" for that file; the text files still travel as a patch.
3. The result for the developer is always ONE commit: the patch is applied with `git am`, the LFS files are copied in and staged (git-lfs turns them into pointers and keeps the real file for the push), and the commit is amended once.
4. The script checks everything before it changes anything (package intact, clean working tree, base commit present, git-lfs installed, nobody changed the LFS file since the base). If any later step fails, it puts the repository back exactly as it was.
5. `--dry-run` really applies and then undoes. `--reset-author` makes the developer the author; by default QM Bot stays the author and the developer is the committer.
6. I tested the shell script in more than 25 throwaway-repository scenarios (text, binary, rename, CRLF, conflict, dirty tree, missing base, mixed, LFS only, hooks refusing, tampered package). All behaved as designed. git-lfs and PowerShell are not installed here: the LFS step was tested with a simulated clean filter, and the PowerShell script is a reviewed draft, untested.
7. I disagree with the reviewer in four places that matter: `-c core.autocrlf=false` breaks applying on Windows (tested), `git apply --check --3way` is not a dry run (tested), "git add runs the LFS filter" is only true when git-lfs is installed (else a huge file is committed silently), and the file-plus-script part must refuse to overwrite a newer version of the file.
8. The whole route also works from "Git Bash", which ships with Git for Windows, so the PowerShell script is optional.
9. Nothing in this design pushes, fetches, opens merge requests or deletes branches. Bundles and fast-import are rejected (reasons below).
10. Effort: about 50 hours on top of the repo-source work already estimated (8 to 10 hours), plus a Windows check by a person.
11. The decision "LFS pointers are refused" recorded on 2026-11-17 in `patch-package.md` is replaced by this design once you agree.
12. Open for you: size cap per package, language of the README, who tests on Windows, whether the first release may be sh only, and the GitLab push-rule question for the `qm-bot@invalid` author (section 14).

## 1. The reviewer's analysis, evaluated

| #   | Claim                                                                                | Verdict                                                                | Evidence and correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Keep `git format-patch` plus `git am --3way --keep-cr` for text                      | Agree                                                                  | Tested scenarios 2 to 4, 8 and 20 (section 6): text, binary (`--binary --full-index`), exec bit, rename with edit, CRLF, CJK path with brackets, all clean. Author and message are kept.                                                                                                                                                                                                                                                                                                                                              |
| 2a  | A patch carrying an LFS file has only the pointer; the object is missing locally     | Agree, with a nuance                                                   | E19 (simulated store; E-numbers are scenario numbers of section 6): `git am` of a pointer diff commits the pointer and the object is not in the local store. Deletions and pure renames of LFS paths are fine in the mbox (E8: delete of a pointer and a pure pointer rename applied), so only added or content-changed LFS files need the file route.                                                                                                                                                                                |
| 2b  | LFS status comes from `.gitattributes`, evaluated with `git check-attr` in a scratch | Agree, but not sufficient alone                                        | A1: nested files, negations, macros, patterns work. But (i) the service decides LFS "by content only", a second signal that the builder should also use (base blob is a pointer); (ii) results depend on `core.ignorecase` (A1, last row: `Sub/UPPER.XLSX` is `unspecified` on a case sensitive platform and `lfs` on Windows); (iii) the applier's own attributes can differ. So the script re-checks at apply time by looking at what `git add` produced.                                                                           |
| 2c  | "git add runs the LFS clean filter", so the file route works                         | Agree only if git-lfs is installed and enabled                         | Without it `git add` stores the whole file silently (E21 shows the detection). The script requires `git lfs version` and `filter.lfs.clean`, and after staging verifies that the staged blob is a pointer whose `oid` equals the sha256 recorded in the package; otherwise it rolls back (E10, E10b, E10c, E21).                                                                                                                                                                                                                      |
| 2d  | File plus script is safe                                                             | Not as stated                                                          | It is a blind overwrite: there is no three-way merge for part B. If the LFS file changed on the target branch after the base commit, the script would silently discard that change. The script compares `HEAD:<path>` with the base blob id recorded in the package and refuses (E11).                                                                                                                                                                                                                                                |
| 3a  | Script uses only git commands                                                        | Impossible literally; nearly true                                      | Copying a file and creating a directory are not git operations (`cp`/`mkdir`, `Copy-Item`/`CreateDirectory`). Everything else (checks, hashing, apply, staging, commit, rollback) is git. A pure git alternative exists (`git hash-object -w --path=<target>` runs the clean filter, then `update-index --cacheinfo`, `checkout-index`) but it adds a smudge round trip that cannot be tested here; rejected, see section 6.6.                                                                                                        |
| 3b  | Dry run via `git apply --check` or `git apply --check --3way`                        | Disagree                                                               | E18: `--check` without `--3way` answered correctly in my runs (clean target, moved context, same-line conflict) but cannot know about the three-way fallback of `am --3way` (I found no case where it fails and `am` succeeds, so it is a usable but inexact preview), and `--check --3way` returns exit code 0 when the result has conflicts ("Applied patch to 'a.txt' with conflicts."). Neither is a dry run. A true dry run is "apply, show, undo", which the script does with the same rollback it uses for failures (E1, E25). |
| 3c  | `-c core.autocrlf=false` considerations                                              | Disagree: do not set it                                                | E16: on a Windows-style clone (`core.autocrlf=true` at clone time) `git am --3way --keep-cr` works as is. With `-c core.autocrlf=false` the same patch FAILS ("Patch failed at 0001") because the working tree has CRLF and git stops converting it. The first draft of my script had the override; the tests found it; it is removed.                                                                                                                                                                                                |
| 3d  | Record git blob ids next to sha256, verify with `git hash-object`                    | Agree, with two details                                                | `git hash-object --no-filters` is mandatory: under `core.autocrlf=true` the default call hashes a converted CRLF file differently (E17: `422c2b7a` against `c30dea8a`). A git blob id is the hash of `blob <size>\0<bytes>`, so it is not a sha256 sum; the manifest keeps both, the script can only check the blob id.                                                                                                                                                                                                               |
| 4   | Bundle needs real parent commit objects                                              | Partly wrong, still reject                                             | E26: a bundle of the synthetic-root repository fetches and `cherry-pick`s fine in a real clone, because the synthetic root has the real blob ids. It is rejected for other reasons (unrelated history lands in the clone, two more steps, no GUI support, same LFS problem). See section 8.                                                                                                                                                                                                                                           |
| 5   | Author QM Bot, applier commits as themselves, `--reset-author` as a script parameter | Agree                                                                  | E1, E9, E9b, E9c: exact `git log` output in section 7. `git am` has no reset-author option, so the script amends once; for LFS-only packages it commits directly.                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | Two commits or one for mixed changes                                                 | One commit, by `git am` followed by one `git commit --amend --no-edit` | Section 5. `git apply --3way --index` was tested (E27) and loses message, author and date, and has no abort command.                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 2. Package layout

```
WP-123-0123456789ab/                 name: <ticket>-<12 hex characters, see below>
  README.txt                         three steps, generated from the manifest, plain text, no secrets
  manifest.json                      schema 2
  COMMIT_MESSAGE.txt                 the exact commit message (UTF-8, LF)
  apply.sh                           POSIX sh, LF line endings
  apply.ps1                          PowerShell, UTF-8 with BOM
  parts/
    A/0001-fix-the-thing.patch       text part: git format-patch mbox (absent if there is no text change)
    B/0001.dat                       LFS payloads, ASCII names, content is the new file
    B/0002.dat
```

Note on the name: the directory (and zip, and the id in the manifest and the script) is `<ticket>-<first 12 hex characters of the sha256 over the sorted lines "<name> <sha256>" of the patch and payload files>`. It is content addressed: the same inputs give the same id (rebuilding overwrites, which is intended), different changes for the same ticket never collide, and it does not depend on a result commit, which for a mixed package does not exist on the builder side (the pointer blobs are made on the developer machine).

Why payload names are `0001.dat` and not the repository path: repository paths in `client` can contain Chinese characters, spaces, brackets and very long directory chains. Zip tools and Windows PowerShell 5.1 treat such names badly (code pages, 260 character limit). The mapping from payload to repository path lives in the manifest and in the script data block, and the script writes the file to the real path through git-aware tools.

### 2.1 manifest.json, schema 2 (invented example values)

```json
{
  "schema": 2,
  "kind": "patch-package",
  "id": "WP-123-0123456789ab",
  "generatedBy": "qm zq patch-package 2",
  "generatedAt": "2026-11-17T10:00:00Z",
  "repo": "client",
  "ticket": "WP-123",
  "subject": "Fix the thing",
  "base": { "commit": "e663771131152811ec3cc107a6a307eaa5aa44de" },
  "message": { "file": "COMMIT_MESSAGE.txt", "sha256": "<64 hex>", "gitBlob": "<40 hex>" },
  "author": { "name": "QM Bot", "email": "qm-bot@invalid", "date": "2026-11-17T10:00:00+00:00" },
  "commits": 1,
  "parts": [
    {
      "id": "A",
      "kind": "mbox",
      "files": ["parts/A/0001-fix-the-thing.patch"],
      "applyWith": "git am --3way --keep-cr",
      "resultTree": "<tree id after part A only>"
    },
    {
      "id": "B",
      "kind": "lfs-files",
      "files": ["parts/B/0001.dat", "parts/B/0002.dat"],
      "applyWith": "copy, git add, git commit --amend"
    }
  ],
  "files": [
    {
      "name": "parts/A/0001-fix-the-thing.patch",
      "role": "patch",
      "part": "A",
      "bytes": 4210,
      "sha256": "<64 hex>",
      "gitBlob": "<40 hex>"
    },
    {
      "name": "parts/B/0001.dat",
      "role": "payload",
      "part": "B",
      "bytes": 7000,
      "sha256": "<64 hex>",
      "gitBlob": "<40 hex>"
    },
    { "name": "COMMIT_MESSAGE.txt", "role": "message", "bytes": 98, "sha256": "<64 hex>", "gitBlob": "<40 hex>" },
    { "name": "apply.sh", "role": "script", "bytes": 9300, "sha256": "<64 hex>", "gitBlob": "<40 hex>" },
    { "name": "apply.ps1", "role": "script", "bytes": 9100, "sha256": "<64 hex>", "gitBlob": "<40 hex>" },
    { "name": "README.txt", "role": "readme", "bytes": 1500, "sha256": "<64 hex>", "gitBlob": "<40 hex>" }
  ],
  "changes": [
    {
      "path": "a.txt",
      "status": "M",
      "kind": "text",
      "part": "A",
      "oldMode": "100644",
      "newMode": "100644",
      "additions": 1,
      "deletions": 1
    },
    { "path": "bin.dat", "status": "M", "kind": "binary", "part": "A", "additions": null, "deletions": null },
    {
      "path": "assets/del.png",
      "status": "D",
      "kind": "lfs",
      "part": "A",
      "note": "pointer deletion travels in the patch"
    },
    {
      "path": "data/table.xlsx",
      "status": "M",
      "kind": "lfs",
      "part": "B",
      "newMode": "100644",
      "payload": "parts/B/0001.dat",
      "baseBlob": "<40 hex, the pointer blob at the base>",
      "lfs": { "oid": "<64 hex, sha256 of the new file>", "size": 7000 },
      "comparison": { "available": false, "reason": "lfs" }
    },
    {
      "path": "server/book.xlsx",
      "status": "M",
      "kind": "xlsx",
      "part": "A",
      "comparison": { "available": true, "file": "comparison/book.diff.md" }
    }
  ],
  "instructions": {
    "sh": "sh apply.sh --repo <dir-of-your-clone> [--dry-run] [--reset-author]",
    "powershell": "powershell -NoProfile -ExecutionPolicy Bypass -File .\\apply.ps1 -Repo <dir-of-your-clone> [-DryRun] [-ResetAuthor]",
    "manual": "see README.txt, section 'Without the script'"
  },
  "verified": {
    "partA": "git am --3way --keep-cr onto a scratch repository holding the real base blobs gave the intended tree and message",
    "partB": "payload sha256 and size recorded; the pointer is produced on the developer machine by git-lfs and checked by the script"
  },
  "warnings": []
}
```

`kind` per change is one of `text`, `binary`, `lfs`, `xlsx` (an xlsx that is not under LFS travels in the patch as a binary diff and may carry a comparison table; an xlsx under LFS is `lfs` and carries the note "comparison not available for LFS files"). `part` says which part carries the path. The manifest holds no absolute paths and no credentials. Both `generatedBy` and `generatedAt` are informational and not part of the package id.

### 2.2 What changes against the schema 1 manifest (the library today)

| v1 field                                                                                            | v2                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema: 1`, `kind: "text-patch"` or `"xlsx"`                                                       | `schema: 2`, `kind: "patch-package"` (one kind; the xlsx package becomes the same package with `comparison` entries)                                          |
| `ticket`, `subject`, `base.commit`, `author`, `source`                                              | kept (`source` stays `git-mcp-diff`, `working-copy` or the repo-source value `base-files`)                                                                    |
| `commitDate`                                                                                        | moved to `author.date`                                                                                                                                        |
| `result.tree`                                                                                       | moved to `parts[A].resultTree`; a tree for the whole package does not exist, because the developer's pointer blobs are unknown to QM                          |
| `files[]` (`name`, `sha256`, `bytes`)                                                               | kept and extended with `role`, `part`, `gitBlob`                                                                                                              |
| `changes[]` (`path`, `oldPath`, `status`, `oldMode`, `newMode`, `additions`, `deletions`, `binary`) | kept, `binary` replaced by `kind`; added `part`, `payload`, `baseBlob`, `lfs`, `comparison`                                                                   |
| `apply`, `verified` (strings)                                                                       | `apply` replaced by `instructions` (both script command lines and the manual route); `verified` becomes an object                                             |
| xlsx manifest `workbooks[]` (`path`, `kind`, `base`, `head`, `workbook`, `diff`, `differences`)     | `changes[].comparison` plus the comparison file in `files[]` with `role: "comparison"`; `differences` (`total`, `listed`, `complete`) moves into `comparison` |
| new                                                                                                 | `id`, `generatedBy`, `generatedAt`, `repo`, `message`, `commits`, `parts[]`, `instructions`, `warnings`                                                       |

Compatibility: nothing reads schema 1 today (library only, nothing wired), so there is no migration. The retention record in `patch-package-retention.md` is NOT approved and not created; if this design is accepted, its `kind` values become `patch-package` and its `files[]` lists every package file (the zip is larger). That is a change of the unapproved record and needs the PM's approval together with the table.

## 3. How the builder decides what is LFS

Inputs the builder already has or can get from the service: the changed paths, the base commit, and for every non-added path `read_file` at the base (kind `lfs_pointer` with `lfsOid` and `lfsSize`, kind `text`, kind `binary`). It has no clone.

Algorithm for the changed paths P (new path and, for renames, the old path):

1. For every directory D on the way from the repository root to each path (root included), ask the service for `D/.gitattributes` at the base commit. One call to `search` with `kind: "path"` and query `.gitattributes` returns all of them for the ref; otherwise one `read_file` per directory, cached per directory. A missing file is simply absent.
2. Write each file found, at its path, into the scratch repository (exact bytes; see section 10), run `git check-attr -z --stdin filter` there with the changed paths on stdin (the paths need not exist). The scratch has no `.git/info/attributes`, no global attributes (`GIT_ATTR_NOSYSTEM=1` and an empty global config, as `createGitRunner` already sets).
3. Run it twice, with `-c core.ignorecase=false` and `-c core.ignorecase=true`. If the answers differ for a path, refuse that package with `attributes_case_dependent` (the Windows developer and the Linux builder would disagree).
4. Combine with the base side:

| attribute `filter`                           | base blob                 | decision                                                                                            |
| -------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `lfs`                                        | pointer                   | `lfs`                                                                                               |
| `lfs`                                        | not a pointer, or no base | `lfs` (new file, or a file not yet migrated); warning "will be stored as a pointer when committed"  |
| `unset`, `unspecified`                       | pointer                   | refuse `lfs_attribute_mismatch` (the repository content and its rules disagree; a person must look) |
| `unset`, `unspecified`                       | not a pointer             | `text`, `binary` or `xlsx` by content                                                               |
| any other value (`other`, a crypt filter)    | any                       | refuse `unsupported_filter`                                                                         |
| any change to a `.gitattributes` file itself | any                       | refuse `attributes_changed` in v1 (the rules for the package could not be trusted)                  |

5. Deletions and pure renames of `lfs` paths (pointer text identical) stay in part A: they need no object (tested E8). A rename with changed content is a deletion of the old path (part A) plus an addition of the new path (part B).

`git check-attr` experiment (A1, run in a throwaway repository, `.gitattributes` at the root with a macro `[attr]lfs filter=lfs diff=lfs merge=lfs -text`, `*.xlsx filter=lfs ...`, `*.png lfs`, `*.fbx filter=lfs`, `/assets/raw/** filter=lfs`; `assets/ui/.gitattributes` with `*.png -filter`, `icons/*.psd filter=lfs`, `big.dat filter=lfs`; `src/nested/.gitattributes` with `*.fbx !filter` and `*.xlsx filter=other`):

| path                                             | result                                              | why                                                                         |
| ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `a.xlsx`, `b.png`, `m.fbx`, `we ird/sp ace.xlsx` | `lfs`                                               | root rules, macro expansion works                                           |
| `assets/ui/b.png`                                | `unset`                                             | nested `-filter` overrides the root macro                                   |
| `assets/ui/icons/x.psd`, `assets/ui/icons/y.png` | `lfs`, `unset`                                      | nested positive rule and nested negation                                    |
| `assets/ui/big.dat`, `assets/ui/sub/big.dat`     | `lfs`, `lfs`                                        | a pattern without slash matches in subdirectories                           |
| `assets/raw/deep/sub/t.bin`                      | `lfs`                                               | `/assets/raw/**`                                                            |
| `src/nested/m.fbx`                               | `unspecified`                                       | nested `!filter` resets to unspecified                                      |
| `src/nested/s.xlsx`                              | `other`                                             | nested `filter=other` replaces `lfs` (the builder must not treat it as LFS) |
| `docs/readme.md`                                 | `unspecified`                                       | no filter rule                                                              |
| `no/such/dir/new.xlsx`                           | `lfs`                                               | the path and its directories need not exist in the scratch                  |
| `Sub/UPPER.XLSX`                                 | `unspecified`; `lfs` with `-c core.ignorecase=true` | case sensitivity changes the answer (step 3 above)                          |

Further results (A2): CRLF line endings and a UTF-8 BOM in `.gitattributes` are accepted; `.git/info/attributes` adds rules, so the scratch must not have one (a fresh `git init` has none); `git check-attr -z --stdin filter` is the batch form (output `path\0filter\0value\0`). `--cached` and the working tree gave the same answer when the file existed in both.

Compared with a repository that really has git-lfs: `git lfs version` reports "not a git command" on this machine, so git-lfs is NOT installed and no comparison was possible. The `filter` attribute is evaluated by git core, not by git-lfs: git-lfs only installs the `filter.lfs.*` configuration and hooks that run when the attribute says `lfs`. So the check-attr results above are the same on a machine with git-lfs; this is document-level reasoning plus the check-attr tests, not a measured comparison. `git lfs track` writes exactly these `filter=lfs diff=lfs merge=lfs -text` lines.

## 4. Mixed changes: one package, two parts, one commit

Part A: a `git format-patch` mbox of all paths that are not added-or-changed LFS files, built exactly like today (synthetic root from exact base bytes, one commit with the manifest message, `format-patch --binary --full-index --no-signature -M`, then the existing verification by `git am --3way --keep-cr` in a second scratch). Part B: the new bytes of every added or content-changed LFS path, plus one record per path in the script data block (status `A` or `M`, mode, sha256, base blob id, payload name, repository path).

Verification of the package by the builder: part A as today. Part B cannot be verified by a real clean filter in the builder (no git-lfs there); the builder verifies that every payload hashes to the recorded sha256 and that its repository path is not touched by part A.

How the developer's commit is produced (script steps 5 and 6):

| Case          | Steps                                                                                                                                                                                          | Commit metadata                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| text only     | `git am --3way --keep-cr`; with `--reset-author` one `git commit --amend --no-edit --reset-author`                                                                                             | author QM Bot (from the mbox, with its date), committer the developer                |
| text plus LFS | `git am --3way --keep-cr`; copy and `git add` each LFS file; verify pointers; `git commit --amend --no-edit --cleanup=verbatim` (plus `--reset-author` on request)                             | same as above; the amend only replaces the committer date and adds the pointer blobs |
| LFS only      | copy and `git add`; `git commit --cleanup=verbatim --author="QM Bot <qm-bot@invalid>" --date=<recorded> -F COMMIT_MESSAGE.txt`; with `--reset-author` the author and date options are left out | author QM Bot with the recorded date, committer the developer                        |

Why one commit and why this way:

| Option                                                                     | Result                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| two commits (am for text, a second commit for LFS)                         | Needs a second message and breaks "one ticket, one commit, one trailer pair". The second commit has nothing recognisably from QM. Rejected.                                                                                                                 |
| `git apply --3way --index`, then add LFS files, then `git commit -F`       | Tested (E27): applies and merges like `am`, but the commit message, author and date are not taken from the mbox, so the script must re-supply all three, and on conflict there is no abort command (`git reset --hard` is the only way back). Rejected.     |
| `git am` then `git commit --amend`                                         | Chosen. Author, author date and message come from the mbox and are verified by the builder; the amend touches only the local commit created seconds earlier. Rollback after any failure is `git reset --hard <pre-state>` (section 5).                      |
| mbox with an empty commit for LFS-only packages (`git am --empty=keep`)    | Works on git 2.52 (E29), gives one code path for all cases, but needs a newer git than the minimum I want to support (the version that introduced `--empty` is not verified). Possible later simplification if the minimum git version is raised.           |
| a patch of the pointer text plus the object copied into `.git/lfs/objects` | The patch would carry a pointer that QM computed itself, and QM would own the LFS decision; the object store layout is an internal of git-lfs and cannot be tested here. Rejected for v1; the file-plus-script route leaves both to git-lfs on the applier. |

## 5. Apply script design

Parameters: `--repo DIR` (default the current directory, any directory inside the repository works), `--dry-run`, `--reset-author`, `--help`. PowerShell: `-Repo`, `-DryRun`, `-ResetAuthor`. Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing was touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Steps, in order, each stops with an explanation:

1. Package integrity: `git hash-object --no-filters` of every package file against the blob ids in the script's own data block. Why blob ids: sha256 needs a tool that is not git (`sha256sum`, `Get-FileHash`); `git hash-object` is available wherever git is, and the manifest keeps the sha256 for people and for QM. Honest limit: the block is inside the script, so this detects a damaged or incomplete download or zip, not a malicious change (someone able to change a file can change the script). The manifest sha256 of `apply.sh` travels in the delivery message so a careful person can compare it.
2. Repository: it is a non-bare sha1 repository; no `rebase-apply`, `rebase-merge`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`; `git status --porcelain --untracked-files=no` is empty (untracked files are allowed because an untracked file at a path the patch creates already makes `am` fail safely, and the script refuses an untracked file at a path it would add, E15); `HEAD` exists; `git var GIT_COMMITTER_IDENT` works; the base commit exists (`git cat-file -e <base>^{commit}`), otherwise it tells the person to run `git fetch` (QM cannot fetch for them). A `HEAD` that does not contain the base only produces a note: the three-way merge uses the base blobs, which exist locally.
3. LFS preconditions (only if part B exists): `git lfs version` works and `filter.lfs.clean` is configured; for each modified path, `HEAD:<path>` equals the base blob recorded in the package (else the file changed after the base; refuse); each added path does not exist.
4. Preview: `git apply --stat --summary` of the patch (reads it, changes nothing).
5. Apply, after recording a backup ref `refs/qm-apply/<id>` at the pre-state:
   - part A: `git am --3way --keep-cr <files>`. No `-c core.autocrlf` override (section 1, row 3c).
   - part B: for each file copy to the path, `git add`, set the exec bit if recorded, then check that the staged blob is at most 1024 bytes, starts with the LFS version line and contains `oid sha256:<recorded sha256>`. This proves that the clean filter ran on exactly the delivered bytes.
   - commit as in the table of section 4. The developer's own hooks run (pre-commit, commit-msg, git-lfs hooks); a refusing hook is a failure and is rolled back (E22).
6. Show `git log -1 --format=fuller --stat`. With `--dry-run` undo everything and say so; otherwise delete the backup ref and remind the developer that nothing was pushed.

Rollback and why `git reset --hard` is safe here: by step 2 the tracked files are clean, HEAD is known and recorded (variable and backup ref). Every change the script makes afterwards is its own: `am` commits, copied LFS files, staged pointers, one amend. `git am --abort` (when an am is in progress) and `git reset --hard <pre-state>` therefore discard only what the script created; untracked files of the developer are never touched by reset, and the script never copies over an existing untracked file. A new file copied but not yet staged is deleted by the script itself. If the process is killed hard, the backup ref and the message name the pre-state (`git reset --hard refs/qm-apply/<id>`). The temporary worktree alternative (apply in `git worktree add`, then `git merge --ff-only`) was considered and rejected: it checks out a repository where a quarter of the files are LFS (smudge downloads, hooks), cannot show that the developer's real tree accepts the change, and the LFS store sharing between worktrees could not be tested here.

Tested rollbacks: conflict in `am` (E5), LFS step failing after `am` succeeded (E21, the `am` commit is undone), refusing pre-commit hook (E22), staged full file because attributes or git-lfs did not apply (E10c), dry run (E1, E25). In all, HEAD, `git status` and refs were identical before and after.

Minimum git version of the draft: 2.31 (`rev-parse --path-format=absolute`); recommended 2.40 or newer. Not verified on older versions.

### 5.1 apply.sh draft

The first block is generated per package (values below are the ones used in the test E8). The second block is identical for every package and carries a `QM_SCRIPT_VERSION` in the real version. Records are tab separated; paths with control characters or a single quote are refused by the builder (quotes could be escaped as `'\''` if wanted). The script text contains no comments on purpose: the repository rule applies to the template that will generate it, and the script explains itself through the messages it prints.

```sh
#!/bin/sh
QM_ID='WP-123-0123456789ab'
QM_BASE='e663771131152811ec3cc107a6a307eaa5aa44de'
QM_AUTHOR_NAME='QM Bot'
QM_AUTHOR_EMAIL='qm-bot@invalid'
QM_AUTHOR_DATE='2026-11-17T10:00:00+00:00'
QM_MESSAGE_FILE='COMMIT_MESSAGE.txt'
QM_TEXT_PATCHES='parts/A/0001-Fix-the-thing.patch'
QM_PACKAGE_FILES='dc35ee9883c5ed39c5596deb9f7937ecb47ee374<TAB>parts/A/0001-Fix-the-thing.patch
<40 hex><TAB>parts/B/0001.dat
<40 hex><TAB>COMMIT_MESSAGE.txt'
QM_LFS_FILES='M<TAB>100644<TAB><sha256 of the new file><TAB><pointer blob id at the base><TAB>parts/B/0001.dat<TAB>data/table.xlsx
A<TAB>100644<TAB><sha256><TAB>0000000000000000000000000000000000000000<TAB>parts/B/0002.dat<TAB>assets/new hero.png'
PKG=$(cd "${0%/*}" 2>/dev/null && pwd) || PKG=$(pwd)
REPO=.
DRY=0
RESET_AUTHOR=0

usage() {
  printf '%s\n' "Usage: sh apply.sh [--repo DIR] [--dry-run] [--reset-author] [--help]" \
    "  --repo DIR       the git repository to apply to (default: current directory)" \
    "  --dry-run        apply, show the result, then undo everything" \
    "  --reset-author   author the commit as you (default: keep $QM_AUTHOR_NAME as author)"
}

say() { printf 'QM apply: %s\n' "$*"; }
die() {
  code=$1
  shift
  printf 'QM apply: %s\n' "$*" >&2
  exit "$code"
}

while [ $# -gt 0 ]; do
  case $1 in
    --repo)
      [ $# -ge 2 ] || die 2 "--repo needs a directory"
      REPO=$2
      shift 2
      ;;
    --dry-run) DRY=1; shift ;;
    --reset-author) RESET_AUTHOR=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 2 "unknown argument: $1" ;;
  esac
done

TAB=$(printf '\t')
GIT_LITERAL_PATHSPECS=1
export GIT_LITERAL_PATHSPECS
g() { git -C "$REPO" -c core.quotePath=false "$@"; }

CHANGED=0
PRE=
rollback() {
  [ "$CHANGED" = 1 ] || return 0
  CHANGED=0
  if [ -d "$(g rev-parse --path-format=absolute --git-path rebase-apply)" ]; then
    g am --abort >/dev/null 2>&1
  fi
  g reset -q --hard "$PRE" || say "could not reset; your previous state is the commit $PRE (also in refs/qm-apply/$QM_ID)"
  g update-ref -d "refs/qm-apply/$QM_ID" >/dev/null 2>&1
  say "rolled back: your repository is exactly as before (HEAD $PRE)"
}
fail() {
  code=$1
  shift
  printf 'QM apply: %s\n' "$*" >&2
  rollback
  exit "$code"
}
trap 'fail 130 "interrupted"' INT TERM HUP

say "package $QM_ID, base $QM_BASE"

say "step 1/6: checking the package files"
while IFS=$TAB read -r blob name; do
  [ -n "$blob" ] || continue
  [ -f "$PKG/$name" ] || die 3 "the package is incomplete: $name is missing"
  got=$(cd "$PKG" && git hash-object --no-filters -- "$name") || die 3 "cannot hash $name"
  [ "$got" = "$blob" ] || die 3 "$name does not match the manifest (got $got, expected $blob): download the package again"
done <<QM_PACKAGE_FILES
$QM_PACKAGE_FILES
QM_PACKAGE_FILES

say "step 2/6: checking the repository"
TOP=$(g rev-parse --show-toplevel 2>/dev/null) || die 4 "$REPO is not a git repository (use --repo DIR)"
[ "$(g rev-parse --is-bare-repository)" = false ] || die 4 "$REPO is a bare repository"
[ "$(g rev-parse --show-object-format 2>/dev/null || echo sha1)" = sha1 ] || die 4 "only sha1 repositories are supported"
for state in rebase-apply rebase-merge MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  [ ! -e "$(g rev-parse --path-format=absolute --git-path "$state")" ] || die 4 "an operation is in progress ($state): finish or abort it first"
done
[ -z "$(g status --porcelain --untracked-files=no)" ] || die 4 "the working tree has uncommitted changes: commit or stash them, then run again"
PRE=$(g rev-parse --verify -q HEAD) || die 4 "the repository has no commit yet"
g var GIT_COMMITTER_IDENT >/dev/null 2>&1 || die 4 "git does not know who you are: git config user.name and user.email first"
g cat-file -e "$QM_BASE^{commit}" 2>/dev/null || die 4 "the base commit $QM_BASE is not in this repository: run 'git fetch' (QM cannot fetch for you), then run again"
g merge-base --is-ancestor "$QM_BASE" HEAD 2>/dev/null || say "note: HEAD does not contain the base commit; the text part is merged three-way against it"

say "step 3/6: checking the Git LFS files"
HAS_LFS=0
while IFS=$TAB read -r status mode sha256 baseblob payload path; do
  [ -n "$status" ] || continue
  HAS_LFS=1
  if [ "$status" = M ]; then
    now=$(g rev-parse -q --verify "HEAD:$path") || die 4 "$path does not exist at HEAD but the package changes it"
    [ "$now" = "$baseblob" ] || die 4 "$path was changed after the base commit; the package would overwrite that newer version. Ask for a package built on the current commit"
  else
    [ ! -e "$TOP/$path" ] || die 4 "$path already exists: the package adds it as a new file"
  fi
  [ -f "$PKG/$payload" ] || die 3 "the package is incomplete: $payload is missing"
done <<QM_LFS_FILES
$QM_LFS_FILES
QM_LFS_FILES
if [ "$HAS_LFS" = 1 ]; then
  g lfs version >/dev/null 2>&1 || die 4 "Git LFS is not installed: install git-lfs and run 'git lfs install' (without it the big files would be committed as full files)"
  [ -n "$(g config --get filter.lfs.clean)" ] || die 4 "Git LFS is not enabled for you: run 'git lfs install'"
fi

say "step 4/6: previewing"
if [ -n "$QM_TEXT_PATCHES" ]; then
  for patch in $QM_TEXT_PATCHES; do
    g apply --stat --summary "$PKG/$patch" || die 5 "$patch is not a readable patch"
  done
fi

say "step 5/6: applying"
g update-ref "refs/qm-apply/$QM_ID" "$PRE"
CHANGED=1
if [ -n "$QM_TEXT_PATCHES" ]; then
  set --
  for patch in $QM_TEXT_PATCHES; do set -- "$@" "$PKG/$patch"; done
  err=$(g am --3way --keep-cr "$@" 2>&1) || fail 5 "the text patch does not apply to this repository (someone changed the same lines):
$err"
fi
while IFS=$TAB read -r status mode sha256 baseblob payload path; do
  [ -n "$status" ] || continue
  dir=${path%/*}
  [ "$dir" = "$path" ] || mkdir -p "$TOP/$dir" || fail 5 "cannot create the directory $dir"
  cp "$PKG/$payload" "$TOP/$path" || { [ "$status" = A ] && rm -f "$TOP/$path"; fail 5 "cannot write $path"; }
  g add -- "$path" || fail 5 "git add failed for $path"
  [ "$mode" = 100755 ] && g update-index --chmod=+x -- "$path"
  size=$(g cat-file -s ":0:$path") || fail 5 "$path is not staged"
  [ "$size" -le 1024 ] || fail 5 "$path was staged as a full file, not as a Git LFS pointer: your .gitattributes or git-lfs setup does not treat it as LFS. Nothing was committed"
  pointer=$(g cat-file blob ":0:$path")
  case $pointer in
    "version https://git-lfs.github.com/spec/v1"*"oid sha256:$sha256"*) ;;
    *) fail 5 "$path was not turned into the expected Git LFS pointer. Nothing was committed" ;;
  esac
done <<QM_LFS_FILES
$QM_LFS_FILES
QM_LFS_FILES

if [ -n "$QM_TEXT_PATCHES" ]; then
  if [ "$HAS_LFS" = 1 ] || [ "$RESET_AUTHOR" = 1 ]; then
    if [ "$RESET_AUTHOR" = 1 ]; then
      g commit -q --amend --no-edit --cleanup=verbatim --reset-author || fail 5 "git commit failed (a hook of this repository refused it?)"
    else
      g commit -q --amend --no-edit --cleanup=verbatim || fail 5 "git commit failed (a hook of this repository refused it?)"
    fi
  fi
else
  if [ "$RESET_AUTHOR" = 1 ]; then
    g commit -q --cleanup=verbatim -F "$PKG/$QM_MESSAGE_FILE" || fail 5 "git commit failed (a hook of this repository refused it?)"
  else
    g commit -q --cleanup=verbatim --author="$QM_AUTHOR_NAME <$QM_AUTHOR_EMAIL>" --date="$QM_AUTHOR_DATE" -F "$PKG/$QM_MESSAGE_FILE" || fail 5 "git commit failed (a hook of this repository refused it?)"
  fi
fi

say "step 6/6: result"
g log -1 --format=fuller --stat
if [ "$DRY" = 1 ]; then
  rollback
  say "dry run finished: this package applies cleanly; nothing was changed"
  exit 0
fi
CHANGED=0
g update-ref -d "refs/qm-apply/$QM_ID" >/dev/null 2>&1
say "done: one commit was created on your current branch. Nothing was pushed; review it, then push in your usual way."
```

### 5.2 apply.ps1 draft (UNTESTED: `pwsh` and Windows PowerShell are not available on this machine)

Review notes, because it was not run:

- Exit codes: every native call goes through `G`, which stores `$LASTEXITCODE` in `$script:Rc` immediately; PowerShell does not stop on a failing native command, so each call is followed by an explicit check. `$ErrorActionPreference` stays at its default `Continue` on purpose: in Windows PowerShell 5.1, `Stop` combined with `2>&1` on a native command turns any stderr line into a terminating error.
- Quoting: values are passed as separate array elements, never built into one command string; `${path}` is used where a colon follows a variable name; `^{commit}` inside a double-quoted string is literal.
- Encoding: the file must be saved as UTF-8 with BOM (Windows PowerShell 5.1 reads BOM-less files as the ANSI code page and would corrupt Chinese path names in the data block). `$OutputEncoding` and `[Console]::OutputEncoding` are set to UTF-8 without BOM so that repository paths piped to `git cat-file --batch-check` and git's output survive. Repository paths are passed to git through stdin or `--pathspec-from-file` (a UTF-8 file written without BOM), not as command-line arguments, because a command-line round trip of non-ASCII text through Windows PowerShell 5.1 is the least certain part; the package and repository directory arguments are passed as arguments (not verified for non-ASCII user names).
- Line endings: the script and the data block accept LF or CRLF (`-split "\r?\n"`). `COMMIT_MESSAGE.txt` and patches are read by git, never by PowerShell.
- Downloaded files carry the "mark of the web": `Unblock-File .\apply.ps1` or run with `-ExecutionPolicy Bypass`, as in the manifest command line.
- `exit` inside `try` still runs `finally`, where `Rollback` is a no-op once it has run; Ctrl+C reaches `finally` and rolls back.

```powershell
[CmdletBinding()]
param(
  [string]$Repo = '.',
  [switch]$DryRun,
  [switch]$ResetAuthor
)

$QM = @{
  Id          = 'WP-123-0123456789ab'
  Base        = 'e663771131152811ec3cc107a6a307eaa5aa44de'
  AuthorName  = 'QM Bot'
  AuthorEmail = 'qm-bot@invalid'
  AuthorDate  = '2026-11-17T10:00:00+00:00'
  MessageFile = 'COMMIT_MESSAGE.txt'
  TextPatches = @('parts/A/0001-Fix-the-thing.patch')
}
$PackageFiles = @'
dc35ee9883c5ed39c5596deb9f7937ecb47ee374<TAB>parts/A/0001-Fix-the-thing.patch
<40 hex><TAB>parts/B/0001.dat
<40 hex><TAB>COMMIT_MESSAGE.txt
'@
$LfsFiles = @'
M<TAB>100644<TAB><sha256><TAB><base pointer blob id><TAB>parts/B/0001.dat<TAB>data/table.xlsx
'@

$Utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$env:GIT_LITERAL_PATHSPECS = '1'
$Pkg = $PSScriptRoot
$script:Changed = $false
$script:Pre = ''
$script:Rc = 0
$script:RebaseApply = ''

function Say([string]$Message) { Write-Host "QM apply: $Message" }

function G {
  $lines = @($input)
  if ($lines.Count -gt 0) {
    $out = $lines | & git -c core.quotePath=false @args 2>&1
  } else {
    $out = & git -c core.quotePath=false @args 2>&1
  }
  $script:Rc = $LASTEXITCODE
  @($out | ForEach-Object { "$_" })
}

function Records([string]$Text) {
  foreach ($line in ($Text -split "\r?\n")) {
    if ($line -ne '') { , ($line -split "`t") }
  }
}

function Rollback {
  if (-not $script:Changed) { return }
  $script:Changed = $false
  if (Test-Path -LiteralPath $script:RebaseApply) { G am --abort | Out-Null }
  G reset -q --hard $script:Pre | Out-Null
  if ($script:Rc -ne 0) { Say "could not reset; your previous state is the commit $($script:Pre) (also in refs/qm-apply/$($QM.Id))" }
  G update-ref -d "refs/qm-apply/$($QM.Id)" | Out-Null
  Say "rolled back: your repository is exactly as before (HEAD $($script:Pre))"
}

function Fail([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine("QM apply: $Message")
  Rollback
  exit $Code
}

try {
  Say "package $($QM.Id), base $($QM.Base)"

  Say 'step 1/6: checking the package files'
  foreach ($r in Records $PackageFiles) {
    $file = Join-Path $Pkg $r[1]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Fail 3 "the package is incomplete: $($r[1]) is missing" }
    $got = (& git -C $Pkg hash-object --no-filters -- $file 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or "$got" -ne $r[0]) { Fail 3 "$($r[1]) does not match the manifest (expected $($r[0])): download the package again" }
  }

  Say 'step 2/6: checking the repository'
  if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { Fail 4 "$Repo is not a directory" }
  Set-Location -LiteralPath $Repo
  $Top = (G rev-parse --show-toplevel | Select-Object -First 1)
  if ($script:Rc -ne 0) { Fail 4 "$Repo is not a git repository (use -Repo DIR)" }
  if ((G rev-parse --is-bare-repository | Select-Object -First 1) -ne 'false') { Fail 4 "$Repo is a bare repository" }
  $fmt = @(G rev-parse --show-object-format)
  if ($script:Rc -eq 0 -and $fmt[0] -ne 'sha1') { Fail 4 'only sha1 repositories are supported' }
  $GitDir = (G rev-parse --path-format=absolute --git-dir | Select-Object -First 1)
  foreach ($state in 'rebase-apply', 'rebase-merge', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG') {
    $p = (G rev-parse --path-format=absolute --git-path $state | Select-Object -First 1)
    if (Test-Path -LiteralPath $p) { Fail 4 "an operation is in progress ($state): finish or abort it first" }
  }
  $script:RebaseApply = (G rev-parse --path-format=absolute --git-path rebase-apply | Select-Object -First 1)
  if (@(G status --porcelain --untracked-files=no).Count -gt 0) { Fail 4 'the working tree has uncommitted changes: commit or stash them, then run again' }
  $script:Pre = (G rev-parse --verify -q HEAD | Select-Object -First 1)
  if ($script:Rc -ne 0) { Fail 4 'the repository has no commit yet' }
  G var GIT_COMMITTER_IDENT | Out-Null
  if ($script:Rc -ne 0) { Fail 4 'git does not know who you are: git config user.name and user.email first' }
  G cat-file -e "$($QM.Base)^{commit}" | Out-Null
  if ($script:Rc -ne 0) { Fail 4 "the base commit $($QM.Base) is not in this repository: run 'git fetch' (QM cannot fetch for you), then run again" }
  G merge-base --is-ancestor $QM.Base HEAD | Out-Null
  if ($script:Rc -ne 0) { Say 'note: HEAD does not contain the base commit; the text part is merged three-way against it' }

  Say 'step 3/6: checking the Git LFS files'
  $hasLfs = $false
  foreach ($r in Records $LfsFiles) {
    $status, $mode, $sha256, $baseBlob, $payload, $path = $r
    $hasLfs = $true
    if ($status -eq 'M') {
      $info = @("HEAD:$path" | G cat-file --batch-check)
      if ($info[0] -notmatch '^([0-9a-f]{40}) blob \d+$') { Fail 4 "$path does not exist at HEAD but the package changes it" }
      if ($Matches[1] -ne $baseBlob) { Fail 4 "$path was changed after the base commit; the package would overwrite that newer version. Ask for a package built on the current commit" }
    } elseif (Test-Path -LiteralPath (Join-Path $Top $path)) {
      Fail 4 "$path already exists: the package adds it as a new file"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Pkg $payload) -PathType Leaf)) { Fail 3 "the package is incomplete: $payload is missing" }
  }
  if ($hasLfs) {
    G lfs version | Out-Null
    if ($script:Rc -ne 0) { Fail 4 "Git LFS is not installed: install git-lfs and run 'git lfs install' (without it the big files would be committed as full files)" }
    if (@(G config --get filter.lfs.clean).Count -eq 0) { Fail 4 "Git LFS is not enabled for you: run 'git lfs install'" }
  }

  Say 'step 4/6: previewing'
  foreach ($patch in $QM.TextPatches) {
    G apply --stat --summary (Join-Path $Pkg $patch) | ForEach-Object { Write-Host $_ }
    if ($script:Rc -ne 0) { Fail 5 "$patch is not a readable patch" }
  }

  Say 'step 5/6: applying'
  G update-ref "refs/qm-apply/$($QM.Id)" $script:Pre | Out-Null
  $script:Changed = $true
  if ($QM.TextPatches.Count -gt 0) {
    $patchFiles = @($QM.TextPatches | ForEach-Object { Join-Path $Pkg $_ })
    $out = G am --3way --keep-cr @patchFiles
    if ($script:Rc -ne 0) { Fail 5 ("the text patch does not apply to this repository (someone changed the same lines):`n" + ($out -join "`n")) }
  }
  foreach ($r in Records $LfsFiles) {
    $status, $mode, $sha256, $baseBlob, $payload, $path = $r
    $dest = Join-Path $Top $path
    try {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
      [IO.File]::Copy((Join-Path $Pkg $payload), $dest, $true)
    } catch {
      if ($status -eq 'A') { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
      Fail 5 "cannot write ${path}: $($_.Exception.Message)"
    }
    $list = Join-Path $GitDir 'qm-apply-paths.txt'
    [IO.File]::WriteAllText($list, "$path`n", $Utf8)
    G add "--pathspec-from-file=$list" | Out-Null
    $addRc = $script:Rc
    Remove-Item -LiteralPath $list -Force -ErrorAction SilentlyContinue
    if ($addRc -ne 0) { Fail 5 "git add failed for $path" }
    if ($mode -eq '100755') { $path | G update-index --chmod=+x --stdin | Out-Null }
    $info = @(":0:$path" | G cat-file --batch-check)
    if ($info[0] -notmatch '^([0-9a-f]{40}) blob (\d+)$') { Fail 5 "$path is not staged" }
    $oid = $Matches[1]
    if ([int64]$Matches[2] -gt 1024) { Fail 5 "$path was staged as a full file, not as a Git LFS pointer: your .gitattributes or git-lfs setup does not treat it as LFS. Nothing was committed" }
    $pointer = (G cat-file blob $oid) -join "`n"
    if (-not ($pointer.StartsWith('version https://git-lfs.github.com/spec/v1') -and $pointer.Contains("oid sha256:$sha256"))) {
      Fail 5 "$path was not turned into the expected Git LFS pointer. Nothing was committed"
    }
  }

  $commit = @()
  if ($QM.TextPatches.Count -gt 0) {
    if ($hasLfs -or $ResetAuthor) {
      $commit = @('commit', '-q', '--amend', '--no-edit', '--cleanup=verbatim')
      if ($ResetAuthor) { $commit += '--reset-author' }
    }
  } else {
    $commit = @('commit', '-q', '--cleanup=verbatim', '-F', (Join-Path $Pkg $QM.MessageFile))
    if (-not $ResetAuthor) { $commit += @("--author=$($QM.AuthorName) <$($QM.AuthorEmail)>", "--date=$($QM.AuthorDate)") }
  }
  if ($commit.Count -gt 0) {
    G @commit | Out-Null
    if ($script:Rc -ne 0) { Fail 5 'git commit failed (a hook of this repository refused it?)' }
  }

  Say 'step 6/6: result'
  G log -1 --format=fuller --stat | ForEach-Object { Write-Host $_ }
  if ($DryRun) {
    Rollback
    Say 'dry run finished: this package applies cleanly; nothing was changed'
    exit 0
  }
  $script:Changed = $false
  G update-ref -d "refs/qm-apply/$($QM.Id)" | Out-Null
  Say 'done: one commit was created on your current branch. Nothing was pushed; review it, then push in your usual way.'
} finally {
  Rollback
}
```

The generated data block (`$QM`, `$PackageFiles`, `$LfsFiles`) must come after `param(...)`, which has to be the first statement of a script. Its values are the ones of the sh draft. In the real file the `<TAB>` markers are tab characters.

### 5.3 README.txt (generated from the manifest; English draft, language is a PM decision)

```
Patch package WP-123-0123456789ab  (repository: client, ticket: WP-123)
Made by QM (generated 2026-11-17 10:00 UTC). QM did not push anything, did not
open a merge request and cannot see your repository. You apply this and commit.

What it changes: 5 files (3 text, 2 big files under Git LFS). One commit will
be created on your CURRENT branch. Base commit: e663771131152811ec3cc107a6a307eaa5aa44de

Step 1. Unzip the package to a folder OUTSIDE your repository.
Step 2. Open a terminal (Git Bash on Windows works) and check what would happen:
        sh apply.sh --repo /path/to/your/client --dry-run
        Windows PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File .\apply.ps1 -Repo D:\work\client -DryRun
Step 3. Apply it for real (same command without --dry-run). Review the commit
        (git show), then push in your usual way. Add --reset-author to be
        the author of the commit; otherwise "QM Bot" is the author and you are the committer.

If the base commit is missing: run "git fetch" and try again.
If something fails, the script puts your repository back exactly as it was.
Big files (Git LFS) need git-lfs installed and enabled ("git lfs install").

Without the script (for graphical tools):
  a) text changes: apply parts/A/*.patch with your tool's "apply patch (git am)" function,
     or in a terminal: git am --3way --keep-cr parts/A/*.patch
  b) big files: copy parts/B/0001.dat to data/table.xlsx in your working copy (rename it
     to the real path listed in manifest.json), stage it and commit it in your tool.
     Git LFS must be installed so that the staged file becomes a pointer.
Files and checksums: manifest.json. The commit message is in COMMIT_MESSAGE.txt.
```

No secrets, tokens or absolute paths are in this text. The ticket and repo are the only package-specific values besides the base commit and counts.

## 6. Test results of the sh draft (throwaway repositories)

Fixture (E0): a `base` repository with `a.txt` (40 lines), `crlf.txt` (CRLF), `bin.dat` (random bytes), `old_name.txt`, `tools/run.sh` (mode 100755), `src/deep/c.txt`, `中文/文件 [1].txt`, and LFS-pointer files `assets/hero.png`, `data/table.xlsx`, `assets/del.png`, `assets/ren.fbx` with `.gitattributes` for `*.xlsx`, `*.png`, `*.fbx`. Each case clones it, builds a package the way the builder would (scratch repo made of `git show <base>:<path>` contents, one commit, `format-patch`), generates the data block, and runs `sh apply.sh --repo <clone>` from another directory. git-lfs is SIMULATED: a `filter.lfs.clean` script that writes the real LFS pointer format (version, `oid sha256:`, `size`) and stores the object in a local directory, a `filter.lfs.smudge` that restores it, and a stub `git-lfs` that answers `version`. The simulation covers what the script depends on (clean runs on `git add`, pointer content); it does not cover the long-running filter protocol, `pre-push` upload or smudge downloads.

| #   | Scenario                                                                                                                  | Outcome                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | text change, `--dry-run` then real                                                                                        | dry run: exit 0, `HEAD`, status and refs identical afterwards; real: one commit, author QM Bot, committer Dev Person                                                           |
| 2   | binary (20000 to 25000 bytes), exec-bit file, deep path, CJK path with `[1]` and a space                                  | applied; mode `100755` kept; binary diff `Bin 20000 -> 25000 bytes`                                                                                                            |
| 3   | rename with edit                                                                                                          | detected as `old_name.txt => new_name.txt`                                                                                                                                     |
| 4   | CRLF file, `core.autocrlf=true`                                                                                           | CRLF kept in the committed blob                                                                                                                                                |
| 5   | target changed the same line                                                                                              | exit 5, "someone changed the same lines", `am --abort`; HEAD, status, refs identical to before; no conflict markers left                                                       |
| 6   | uncommitted change                                                                                                        | exit 4, nothing touched                                                                                                                                                        |
| 7   | base commit not in the clone                                                                                              | exit 4, message tells to run `git fetch`                                                                                                                                       |
| 8   | mixed: text edit + pointer delete + pure pointer rename (text part), modified xlsx + new `assets/new hero.png` (LFS part) | exit 0; ONE commit; `HEAD:data/table.xlsx` is a pointer (`oid sha256:7b7537d4...`, `size 7000`); worktree file equals the delivered bytes; author QM Bot, committer Dev Person |
| 9   | LFS only                                                                                                                  | author QM Bot, author date `2026-11-17T10:00:00Z` from the script, message with both trailers and no extra blank line (`cat -A` checked)                                       |
| 9b  | LFS only, `--reset-author`                                                                                                | author and committer both Dev Person                                                                                                                                           |
| 9c  | mixed, `--reset-author` and without                                                                                       | with: author Dev Person, author date now; without: author QM Bot, author date 2025-11-13 (from the mbox)                                                                       |
| 10  | LFS paths, no git-lfs binary / no `filter.lfs.clean`                                                                      | exit 4 before any change, two distinct messages                                                                                                                                |
| 10c | filter configured but target `.gitattributes` has no LFS rule                                                             | file staged in full (5000 bytes): exit 5, rolled back, worktree file restored                                                                                                  |
| 11  | LFS file changed on the target after the base                                                                             | exit 4, "would overwrite that newer version"                                                                                                                                   |
| 12  | one byte of a patch changed                                                                                               | exit 3, names the file with got and expected blob id                                                                                                                           |
| 13  | `MERGE_HEAD` present; `rebase-apply` present                                                                              | exit 4 each (a first run of this case passed wrongly because the git-path was relative; fixed with `--path-format=absolute`)                                                   |
| 14  | script run without `--repo` inside the clone, script stored elsewhere                                                     | works                                                                                                                                                                          |
| 15  | untracked file at a path part B adds                                                                                      | exit 4, the file is untouched                                                                                                                                                  |
| 20  | Windows-like clone (`core.autocrlf=true` at clone time), LF file and CRLF file, plus LFS                                  | exit 0, diff shows one line per file, no whole-file rewrite                                                                                                                    |
| 21  | mixed, text applies, then the LFS step fails                                                                              | the `am` commit is undone; state identical                                                                                                                                     |
| 22  | developer's `pre-commit` hook exits 1                                                                                     | exit 5, rolled back, hook output shown                                                                                                                                         |
| 23  | detached HEAD, `--repo` pointing at a subdirectory                                                                        | works                                                                                                                                                                          |
| 24  | patch path that is under an LFS rule on the developer side                                                                | `am` failed and rolled back safely (the committed blob was a pointer in my fixture, so this shows safety, not conversion)                                                      |
| 25  | dry run of a mixed package                                                                                                | state identical; the reflog keeps three entries (am, amend, reset), and an LFS object stays in `.git/lfs/objects` (simulated: in the store directory)                          |

Not covered by these runs: real git-lfs, a real GitLab remote, Windows, `dash` (only bash in POSIX mode was available; the script uses only POSIX constructs, `printf '\t'` for the separator, no arrays, no `local`, no `[[`), a repository with submodules or sparse checkout, interrupted runs (the trap is written but was not exercised).

### 6.1 Other experiments

| #   | Command and result                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E16 | Clone with `-c core.autocrlf=true`, then `git am --3way --keep-cr` of a patch changing an LF-in-repo file and a CRLF-in-repo file: applies ("warning: quoted CRLF detected" is harmless). The same with `-c core.autocrlf=false -c core.safecrlf=false`: "Patch failed at 0001". Without `--keep-cr` and `autocrlf=true`: "Patch failed". |
| E17 | `git hash-object f.txt` (CRLF file in a repo with `core.autocrlf=true`) gives `422c2b7a...`; `git hash-object --no-filters f.txt` and the call from outside any repository give `c30dea8a...`.                                                                                                                                            |
| E18 | `git apply --check` on a target with an unrelated change: exit 0. On a target with a conflict: "patch does not apply", exit 1. `git apply --check --3way` on the conflict: "Applied patch to 'a.txt' with conflicts.", exit 0, working tree unchanged. So the 3-way check cannot say whether a conflict will happen.                      |
| E19 | Pointer-only patch applied with `am`: the pointer is committed; the object for it is not in the (simulated) local LFS store.                                                                                                                                                                                                              |
| E26 | `git bundle create` of the scratch repo, `git fetch <bundle> main:refs/qm/c26`, `git cherry-pick refs/qm/c26`: works; the fetched ref is an unrelated history (2 commits, no merge base with `main`) and stays as junk until pruned.                                                                                                      |
| E27 | `git apply --3way --index <mbox>`: applies and stages; `git log` still shows the old HEAD (no commit, no message or author taken); on a conflict leaves `UU a.txt` with markers and `M bin.dat` staged; `git am --abort` for comparison restores a clean state.                                                                           |
| E28 | `git am` of two patches (`0001`, `0002`) applies in order; kept for multi-commit parts if ever needed.                                                                                                                                                                                                                                    |
| E29 | `git am` of an empty-diff mbox: "Patch is empty" and stops; `git am --empty=keep` creates the empty commit with the message (git 2.52).                                                                                                                                                                                                   |

The harness (bash functions that build the fixture, the package and the script, and the scenarios above) lived in a temporary directory and was not kept; the commands above and the script of section 5.1 reproduce it. The implementation's test suite (section 12) is where it becomes permanent.

## 7. Author, committer and what `git log` shows

QM Bot is the author of the mbox: `From: QM Bot <qm-bot@invalid>`, `Date:` the build time. The applier is the committer through their own git identity (`user.name`, `user.email`); the script never sets `GIT_COMMITTER_*` and requires `git var GIT_COMMITTER_IDENT` to work. Default (`git am`, optionally amended without `--reset-author`):

```
commit dd102a9d...
Author:     QM Bot <qm-bot@invalid>
AuthorDate: Thu Nov 13 02:13:20 2025 +0000
Commit:     Dev Person <dev@example.com>
CommitDate: Tue Nov 17 01:22:03 2026 -0500

    Fix the thing
    ...
    Ticket: WP-123
    AI-Generated: QM
```

With `--reset-author` (`git commit --amend --no-edit --reset-author`, or no `--author` option for LFS-only packages): `Author` and `Commit` are the developer, `AuthorDate` is the time of the commit, the message is unchanged. The `AI-Generated: QM` trailer stays in both cases, so the origin remains visible. Not decided here and left to the GitLab administrator: whether a push rule such as "commit author must match a member or an email pattern" rejects `qm-bot@invalid` (it is the author, not the committer; the default "reject unverified users" checks the committer). If it does, `--reset-author` becomes the default.

`--signoff` is not used (it would add a `Signed-off-by` of the developer without their reading); GPG signing follows the developer's own configuration (`commit.gpgsign`), which the script does not override.

## 8. Rejected options

| Option                                                       | Reason                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git bundle`                                                 | Technically works with the synthetic root (E26), so "needs the real parent commit objects" is not the reason. Rejected because the developer must `fetch` a file, ends with an unrelated root and a ref to clean up, still needs the same LFS handling, no GUI tool opens a bundle as a change, and the result is no more "importable" than an mbox. |
| `git fast-import`                                            | A stream of synthetic history: same unrelated-history problem as the bundle, plus a stream format only a terminal user can feed in, and no author or committer separation for the applier.                                                                                                                                                           |
| pushing a branch, merge request, deleting branches           | PM decision: QM never pushes, never opens merge requests, never deletes branches. The script has no `push`, `fetch`, `remote`, `branch -d` and no network access, and the builder's allowlist (`ALLOWED_GIT_SUBCOMMANDS`) stays free of them; the one new git use in the builder is `check-attr`, to be added to that list.                          |
| `git apply --3way --index`                                   | No message, author or date; no abort (E27).                                                                                                                                                                                                                                                                                                          |
| `git apply --check` as dry run                               | Inexact without `--3way`, wrong with it (E18).                                                                                                                                                                                                                                                                                                       |
| temporary worktree                                           | Section 5.                                                                                                                                                                                                                                                                                                                                           |
| pre-built pointer plus object copied into `.git/lfs/objects` | Section 4 table.                                                                                                                                                                                                                                                                                                                                     |
| LFS download in the builder                                  | Out of scope for v1 (no git-lfs, no credentials, the service never downloads LFS content).                                                                                                                                                                                                                                                           |

## 9. GUI importers (document-level only)

No internet access and no GUI tool were available; nothing here was tested. Each statement is "known behaviour from documentation, unverified" (from memory of vendor documentation) or "unknown".

| Tool                                             | mbox patch from `format-patch`                                                                                                                                                                                                                                                  | Notes for this package                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| TortoiseGit                                      | Known from its documentation, unverified: "Apply Patch Serial" applies patches produced by `format-patch` (it uses `git am`) and keeps author and message; plain "Apply Patch" opens TortoiseGitMerge for a diff. Whether `--3way` and `--keep-cr` are offered or set: unknown. | CRLF files may fail without `--keep-cr` (E16). For GUI users the README gives the terminal command for part A. Part B: manual copy, stage, commit. |
| SourceTree                                       | Known from its documentation, unverified: has an "Apply Patch" action in the repository menu, with a choice between applying to the working copy and creating commits (am style). Exact git options: unknown.                                                                   | If it applies to the working copy only, the author and message are lost; the developer would use the commit message file.                          |
| GitHub Desktop                                   | Known, unverified: no patch import.                                                                                                                                                                                                                                             | Use a terminal or the script.                                                                                                                      |
| VS Code (built-in Git, GitLens, Git Graph)       | Unknown for GitLens and Git Graph; known, unverified: the built-in Git has no "apply patch" command.                                                                                                                                                                            | The integrated terminal runs the script.                                                                                                           |
| Git GUI shipped with Git for Windows (`git gui`) | Known, unverified: no patch import.                                                                                                                                                                                                                                             | Git for Windows also ships Git Bash and `sh.exe`: `sh apply.sh --repo ...` works there. This makes the PowerShell script optional.                 |

Manual route for the LFS part (from the README): copy `parts/B/000N.dat` over the real path (listed in the manifest), stage it and commit in the GUI. If git-lfs is installed and enabled on that machine, the GUI's `git add` runs the clean filter and the commit holds a pointer; if it is not, the GUI commits the full file (the script's pointer check exists because this fails silently). A GUI user cannot run the script's checks, so the README tells them to run `git show --stat` and confirm that the LFS files appear as three-line pointers.

## 10. What the builder needs from the service, and the xlsx flow

Base bytes for non-LFS paths (needed by repo-source route B of `docs/zq-patch-package-repo-source.md`; LFS paths need no base bytes at all, which also removes the LFS download from scope):

| `read_file` mode                              | Exact?                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line mode (`startLine`, `endLine`, none)      | Not exact (read from `text-scan.ts`): lines are joined with `\n`, so a final newline is lost and the output is cut by `budget`; CR bytes stay in the text. Do not use.                                                                                                                                            |
| byte mode on a text file (`offset`, `length`) | Exact if the file is valid UTF-8 and the chunk does not cut a multi-byte character (the service returns `bytes.toString("utf8")`). The builder trims a trailing U+FFFD and continues at the byte count of what it kept. Invalid UTF-8 (GBK files without NUL) comes back with U+FFFD and cannot be reconstructed. |
| `binary` kind (`offset`, `length`)            | Exact: base64 ranges, reassembled.                                                                                                                                                                                                                                                                                |
| every result                                  | Carries `oid` (the git blob id) and `size`. The builder hashes what it assembled with `git hash-object --no-filters` and refuses (no package) when it differs from `oid`: this is the exactness check the repo-source spike asked for.                                                                            |

Consequence: text exactness is verifiable but not guaranteed; a small read-only service change (a `base64` option for text kind, or `encoding: "base64"`) would remove the UTF-8 limit. That is a plugin and contract change and a PM decision; v1 can refuse non-UTF-8 files with a clear message.

Packages for LFS xlsx (the `client` repository): `diff_xlsx` returns `lfs_pointer` or `lfs_pointer_changed`, so no comparison table can be produced, and the existing xlsx builder already renders "LFS file, content not compared" with the old and new `oid` and `size`. In schema 2 such a workbook is a part B file; the package says so in the manifest (`comparison.available: false, reason: "lfs"`) and in the README ("comparison not available for LFS files"). If the base content could be obtained another way (a person with git-lfs fetches it), the table could be produced later; not in v1. A workbook in a non-LFS repository (`server` has a mix) stays a part A binary patch and keeps its comparison table (`comparison/<name>.diff.md`, role `comparison`). The xlsx builder needs the same extra inputs as the text builder (repository, base commit, repository path, subject, body) because the package now contains scripts and a message; it currently has none of them.

## 11. Configuration and schema disclosure

Configuration: unchanged by this document. For the implementation I propose one new setting, `ZQ_PATCH_MAX_PACKAGE_BYTES` (positive integer, default 80 MiB, environment only, bad value refuses startup): the total size of all payload and patch files, above which the builder refuses with an answer that asks for another delivery route. It replaces the "large binary threshold" the PM has not named, applies to every package kind, and is not a feature switch; LFS handling needs no switch because the PM asked for automatic behaviour. The default is chosen under the Mattermost upload limit (default `MaxFileSize` of 100 MiB, from memory, to be checked against the server). No other setting, flag, mode or provider is added; `ZQ_PATCH_AUTHOR_NAME`, `ZQ_PATCH_AUTHOR_EMAIL`, ticket pattern, subject and body limits are unchanged and are baked into the script data block.

Schema and payload shapes: the manifest changes from schema 1 to 2 (section 2.2, with every field kept, moved, transformed or dropped). No database table, no durable map and no API payload changes; the retention record in `patch-package-retention.md` is unapproved and unchanged by this document, with the adjustment of section 2.2 to be decided together with its approval. No migration or backfill; nothing consumes schema 1. The decision text in `patch-package.md` ("Git LFS pointers ... are refused. There is no override.") and the refusal in `refuseLfsAndSubmodules` become obsolete for LFS (submodules stay refused) when this is implemented.

## 12. Effort, tests, risks

Effort in hours, on top of the repo-source route B (8 to 10 hours, not repeated):

| Component                                                                                                                                                                                         | Hours |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| builder: attribute chain fetch, scratch `check-attr`, classification table, refusals, `check-attr` in the git allowlist                                                                           | 7     |
| builder: parts A and B, mixed verification, manifest v2, package layout, size cap setting                                                                                                         | 8     |
| builder: exact byte reading from `read_file` with the blob id check (UTF-8 chunk trimming, base64 ranges)                                                                                         | 4     |
| xlsx builder: LFS and non-LFS workbooks into the v2 package, comparison role                                                                                                                      | 4     |
| script generation: template strings for `apply.sh` and `apply.ps1` (BOM, LF), quoting and escaping of the data block, README                                                                      | 8     |
| tests: real `git am` in throwaway repos for every case in section 6, scripts run under `sh` (and `dash` if installed), simulated LFS filter fixture, check-attr matrix, Windows line ending cases | 12    |
| Windows check by a person (Windows PowerShell 5.1, pwsh 7, Git Bash, real git-lfs, Chinese path and user name), GUI tool check                                                                    | 6     |
| docs: update `patch-package.md`, retention doc, manifest reference, README wording                                                                                                                | 3     |
| Total                                                                                                                                                                                             | 52    |

Test plan for the implementation (tests assert behavior, not source text):

1. Classification: a table-driven test with the E1 fixture (nested files, negation, macro, `other`, ignorecase mismatch, `.gitattributes` changed) through the real builder with a fake service returning `read_file` results.
2. Package build: for each scenario of section 6 build a package from a fake service and a base repository, then run the generated `apply.sh` with `sh` against a clone and assert on HEAD, the log fields, the blob ids and the repository state after a refusal or failure. The simulated LFS filter and `git-lfs` stub become test support. A test with a real git-lfs runs only where `git lfs version` works (skipped otherwise, reported).
3. Windows cases: LF-in-repo and CRLF-in-repo files with `core.autocrlf=true` at clone time (E16, E20); `core.autocrlf=input` and `false` too.
4. Exactness: a fake `read_file` that returns CRLF, a BOM, a file without final newline, multibyte characters at a chunk boundary and invalid UTF-8: the builder either reassembles with the right blob id or refuses.
5. PowerShell: a Windows job (GitHub-hosted runners have Windows PowerShell 5.1, pwsh and Git for Windows; this repository's CI use is not verified here) running the same scenarios; until then the script is reviewed only and flagged "untested" in the PR.
6. Determinism: the same inputs and the same `generatedAt` give byte-identical packages (the library already has this property for the patch).

Risks:

| Risk                                                                                               | Mitigation                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real git-lfs behaves differently from the simulation (long-running filter, `lfs.storage`, hooks)   | Real-LFS test on one machine before release; the script's pointer check is the safety net; the first release marks LFS support "pilot".                        |
| Windows PowerShell script wrong in ways review cannot see                                          | Ship `apply.sh` first (works in Git Bash); ps1 after a Windows run.                                                                                            |
| The package is big (PSD, FBX): Mattermost upload limit, memory in the builder                      | Size cap setting; stream payloads to disk; refuse above the cap with another route.                                                                            |
| Attribute rules differ between base and applier's branch (`.gitattributes` changed since the base) | Apply-time pointer check; builder refuses when the package itself changes `.gitattributes`.                                                                    |
| The base side of a "modified" LFS file is stale                                                    | Base blob id compared at apply time (E11).                                                                                                                     |
| Script modified in transit                                                                         | Integrity check covers damage, not malice; the delivery message carries the manifest and script hashes.                                                        |
| `qm-bot@invalid` rejected by GitLab push rules                                                     | `--reset-author`; ask the administrator.                                                                                                                       |
| User opens `apply.sh` in a Windows editor that saves CRLF                                          | README says not to edit; the script's first lines would print `\r` errors; builder tests keep LF; a CRLF check can be added (decision for the implementation). |
| Developer has `core.hooksPath` hooks that are slow or interactive                                  | Failure is rolled back (E22); documented.                                                                                                                      |

## 13. Not verified

- Real git-lfs (not installed): clean/smudge with the long-running filter, `pre-push` upload, the LFS store of worktrees, `git lfs install` effects. Simulated only.
- PowerShell: `pwsh` is not available; `apply.ps1` was never run, only reviewed.
- Any GUI tool, any Windows machine, a Chinese user name or path with the scripts, `dash`, git versions older than 2.52 (minimum version of the draft is an estimate).
- The service side: `read_file` behaviour comes from reading `read-file.ts` and `text-scan.ts`, not from running the plugin. `search` with `kind: "path"` finding `.gitattributes` files is from the handoff document.
- GitLab push rules, Mattermost upload limit (100 MiB is from memory), the real `client` repository.
- Hour estimates are judgment, not measurement.

## 14. Decisions for the PM

| #   | Decision                                                                                                      | Recommendation                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Replace the 2026-11-17 decision "LFS pointers are refused" by this design (automatic file plus script)        | Yes. It is what you asked for; the refusal stays only for the cases in section 3 (mismatches, other filters, `.gitattributes` changes). |
| 2   | One commit per package (am plus one amend) or two commits for mixed changes                                   | One commit.                                                                                                                             |
| 3   | Maximum package size (`ZQ_PATCH_MAX_PACKAGE_BYTES`) and what happens above it                                 | 80 MiB; above it refuse and answer with another route (shared folder link), decided later.                                              |
| 4   | Ship `apply.sh` first and `apply.ps1` after a real Windows test, or both together                             | `apply.sh` first (Git Bash covers Windows); `apply.ps1` marked untested until a person runs it.                                         |
| 5   | Who tests on Windows and with real git-lfs, and on which machine, before the first real delivery              | A named developer from the `client` team; 2 to 3 hours.                                                                                 |
| 6   | README language (English draft here)                                                                          | Chinese and English side by side.                                                                                                       |
| 7   | Default author: QM Bot (current decision) or the applier by default                                           | Keep QM Bot as author with `--reset-author` available, unless the GitLab administrator says push rules reject `qm-bot@invalid`.         |
| 8   | Allow a small read-only service change for exact text bytes (base64 option) or refuse non-UTF-8 files         | Refuse in v1; reconsider after the first real repository run.                                                                           |
| 9   | Accept that comparison tables are unavailable for LFS xlsx                                                    | Yes for v1.                                                                                                                             |
| 10  | Adjust the unapproved retention record (`kind`, `files[]`) when the table is approved                         | Yes, in the same review.                                                                                                                |
| 11  | Minimum git version for developers (draft: 2.31, recommended 2.40)                                            | State 2.40 in the README.                                                                                                               |
| 12  | Whether the script may refuse when the developer's HEAD does not contain the base commit (draft: only a note) | Keep the note; the three-way merge handles it.                                                                                          |
