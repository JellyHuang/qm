import { PatchPackageError } from "./settings.ts";

const MANIFEST_LINE_PREFIX = "QM_MANIFEST_BLOB=";

interface LfsRecord {
  status: "A" | "M";
  mode: string;
  sha256: string;
  baseBlob: string;
  payload: string;
  path: string;
}

export interface ScriptData {
  id: string;
  base: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  messageFile: string;
  textPatches: readonly string[];
  packageFiles: readonly { blob: string; name: string }[];
  lfsFiles: readonly LfsRecord[];
}

const UNSAFE = /['\u0000-\u001f\u007f]/;

function quote(value: string, what: string): string {
  if (UNSAFE.test(value))
    throw new PatchPackageError(
      "unsupported",
      `${what} contains a single quote or a control character, which the apply script cannot carry`,
    );
  return `'${value}'`;
}

export function withoutManifestLine(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.startsWith(MANIFEST_LINE_PREFIX))
    .join("\n");
}

const BODY = `PKG=$(cd "$(dirname -- "$0")" 2>/dev/null && pwd) || PKG=$(pwd)
REPO=.
DRY=0
NEWBRANCH=0
KEEPBOT=0
NL='
'
TAB=$(printf '\\t')

usage() {
  printf '%s\\n' "Usage: sh apply.sh [--repo DIR] [--dry-run] [--new-branch] [--keep-bot-author] [--help]" \\
    "  (default)          create ONE commit on the branch you are on; you are its author and committer" \\
    "  --repo DIR         the git clone to apply to (default: current directory)" \\
    "  --dry-run          do everything, show the result, then undo it completely" \\
    "  --new-branch       safer mode: build the commit on the new local branch $QM_BRANCH, made from the base commit in a temporary worktree; your branch and files are not touched" \\
    "  --keep-bot-author  keep $QM_AUTHOR_NAME as the author of the commit (you stay the committer)" \\
    "  --help             this text" \\
    "Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing was touched), 5 apply failed (rolled back), 130 interrupted (rolled back)." \\
    "This script never pushes and never fetches."
}

say() { printf 'QM apply: %s\\n' "$*"; }
die() {
  code=$1
  shift
  printf 'QM apply: %s\\n' "$*" >&2
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
    --new-branch) NEWBRANCH=1; shift ;;
    --keep-bot-author) KEEPBOT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 2 "unknown argument: $1" ;;
  esac
done

GIT_LITERAL_PATHSPECS=1
export GIT_LITERAL_PATHSPECS
command -v git >/dev/null 2>&1 || die 4 "git is not installed or not on PATH"

TOP=
W=
WT=
TMP=
ORIG=
STATE=idle
TOUCHED=
DIRS=
g() { git -C "$TOP" -c core.quotePath=false "$@"; }
w() { git -C "$W" -c core.quotePath=false "$@"; }

rollback() {
  case $STATE in
    direct)
      STATE=idle
      if [ -d "$(g rev-parse --path-format=absolute --git-path rebase-apply)" ]; then
        g am --abort >/dev/null 2>&1
      fi
      printf '%s' "$TOUCHED" | while IFS=$TAB read -r status saved path; do
        [ -n "$path" ] || continue
        [ "$status" != M ] || cp -p "$TMP/save/$saved" "$TOP/$path"
        [ "$status" != A ] || rm -f "$TOP/$path"
        g reset -q "$ORIG" -- "$path" >/dev/null 2>&1
      done
      printf '%s' "$DIRS" | while IFS= read -r dir; do
        [ -z "$dir" ] || rm -rf "$TOP/$dir"
      done
      if g reset -q --keep "$ORIG" >/dev/null 2>&1; then
        g update-ref -d "$QM_BACKUP" >/dev/null 2>&1
        say "rolled back: your repository is exactly as before (HEAD $ORIG)"
      else
        say "could not restore automatically: your original HEAD is $ORIG (also kept in $QM_BACKUP); run: git reset --keep $ORIG"
      fi
      ;;
    branch)
      STATE=idle
      if [ -n "$WT" ] && [ -d "$WT" ]; then
        git -C "$TOP" worktree remove --force "$WT" >/dev/null 2>&1
      fi
      git -C "$TOP" worktree prune >/dev/null 2>&1
      if git -C "$TOP" show-ref --verify -q "refs/heads/$QM_BRANCH"; then
        git -C "$TOP" branch -D "$QM_BRANCH" >/dev/null 2>&1
      fi
      say "rolled back: the temporary worktree and the branch $QM_BRANCH are gone; your repository is as before"
      ;;
  esac
}
on_exit() {
  rollback
  [ -z "$TMP" ] || rm -rf "$TMP"
}
trap on_exit EXIT
trap 'printf "QM apply: interrupted\\n" >&2; exit 130' INT TERM HUP

say "package $QM_ID, base $QM_BASE"

say "step 1/6: checking the package files and this script against the manifest"
[ -f "$0" ] || die 3 "this script cannot read itself (run it as: sh apply.sh)"
[ -f "$PKG/manifest.json" ] || die 3 "the package is incomplete: manifest.json is missing"
got=$(git hash-object --no-filters -- "$PKG/manifest.json") || die 3 "cannot hash manifest.json"
[ "$got" = "$QM_MANIFEST_BLOB" ] || die 3 "manifest.json does not match this script (got $got, expected $QM_MANIFEST_BLOB): download the package again"
found=$(grep -c '^    "scriptGitBlob": "' "$PKG/manifest.json")
[ "$found" = 1 ] || die 3 "manifest.json does not carry exactly one script hash"
want=$(grep '^    "scriptGitBlob": "' "$PKG/manifest.json" | cut -d'"' -f4)
mine=$(grep -v '^QM_MANIFEST_BLOB=' "$0" | git hash-object --no-filters --stdin) || die 3 "cannot hash this script"
[ "$mine" = "$want" ] || die 3 "this script was changed after the package was made (got $mine, the manifest says $want): download the package again"
while IFS=$TAB read -r blob name; do
  [ -n "$blob" ] || continue
  [ -f "$PKG/$name" ] || die 3 "the package is incomplete: $name is missing"
  got=$(cd "$PKG" && git hash-object --no-filters -- "$name") || die 3 "cannot hash $name"
  [ "$got" = "$blob" ] || die 3 "$name does not match the manifest (got $got, expected $blob): download the package again"
done <<QM_PACKAGE_FILES
$QM_PACKAGE_FILES
QM_PACKAGE_FILES

say "step 2/6: checking your repository (nothing is changed in it)"
TOP=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || die 4 "$REPO is not a git repository (use --repo DIR)"
[ "$(g rev-parse --is-bare-repository)" = false ] || die 4 "$REPO is a bare repository"
for state in rebase-apply rebase-merge MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  [ ! -e "$(g rev-parse --path-format=absolute --git-path "$state")" ] || die 4 "an operation is in progress ($state): finish or abort it first"
done
[ -z "$(g status --porcelain --untracked-files=no)" ] || die 4 "the working tree has uncommitted changes: commit or stash them, then run again"
ORIG=$(g rev-parse --verify -q HEAD) || die 4 "the repository has no commit yet"
if [ -z "$(g config --get user.name)" ] || [ -z "$(g config --get user.email)" ]; then
  die 4 "git does not know who you are: run git config user.name and git config user.email first (you become the author and the committer of the commit)"
fi
g cat-file -e "$QM_BASE^{commit}" 2>/dev/null || die 4 "the base commit $QM_BASE is not in this repository: run 'git fetch' yourself (this script never fetches), then run again"
if [ "$NEWBRANCH" = 1 ]; then
  g check-ref-format "refs/heads/$QM_BRANCH" || die 4 "invalid branch name $QM_BRANCH"
  if g show-ref --verify -q "refs/heads/$QM_BRANCH"; then
    die 4 "the branch $QM_BRANCH already exists: this package was probably applied before. Inspect it, or delete it with 'git branch -D $QM_BRANCH' if you do not need it, then run again"
  fi
  if ! g merge-base --is-ancestor "$QM_BASE" HEAD 2>/dev/null; then
    say "note: your current HEAD does not contain the base commit; that is fine, the branch is built on the base commit itself"
  fi
else
  CURRENT=$(g symbolic-ref -q --short HEAD) || die 4 "you are on a detached HEAD: switch to a branch, or use --new-branch"
  if g rev-parse -q --verify "$QM_BACKUP" >/dev/null 2>&1; then
    die 4 "a previous run of this package did not finish: $QM_BACKUP still points to the HEAD it started from ($(g rev-parse "$QM_BACKUP")). Check your branch, then remove it with 'git update-ref -d $QM_BACKUP' and run again"
  fi
  if upstream=$(g rev-parse --abbrev-ref '@{u}' 2>/dev/null); then
    behind=$(g rev-list --count 'HEAD..@{u}')
    [ "$behind" = 0 ] || die 4 "your branch $CURRENT is $behind commit(s) behind $upstream (as of your last fetch; this script never fetches): pull first, then run again"
    say "upstream check: nothing to pull from $upstream (this reflects your last fetch only)"
  else
    say "note: $CURRENT has no upstream branch, so it was not compared with a remote"
  fi
  if ! g merge-base --is-ancestor "$QM_BASE" HEAD 2>/dev/null; then
    say "note: your current HEAD does not contain the base commit; the text changes are merged three-way against it, and a conflict stops the script and restores everything"
  fi
fi

say "step 3/6: checking the Git LFS files"
HAS_LFS=0
while IFS=$TAB read -r status mode sha256 baseblob payload path; do
  [ -n "$status" ] || continue
  HAS_LFS=1
  have=$(g rev-parse -q --verify "$QM_BASE:$path" 2>/dev/null) || have=
  if [ "$status" = M ]; then
    [ "$have" = "$baseblob" ] || die 4 "$path at the base commit is not the version the package was made for (found \${have:-nothing}, expected $baseblob): ask for a new package"
    if [ "$NEWBRANCH" = 0 ]; then
      now=$(g rev-parse -q --verify "HEAD:$path" 2>/dev/null) || now=
      [ "$now" = "$baseblob" ] || die 4 "$path was changed after the base commit; the package would overwrite that newer version. Ask for a package built on the current commit"
    fi
  else
    [ -z "$have" ] || die 4 "$path already exists at the base commit but the package adds it as a new file: ask for a new package"
    if [ "$NEWBRANCH" = 0 ]; then
      if g rev-parse -q --verify "HEAD:$path" >/dev/null 2>&1 || [ -e "$TOP/$path" ]; then
        die 4 "$path already exists in your working copy but the package adds it as a new file"
      fi
    fi
  fi
done <<QM_LFS_FILES
$QM_LFS_FILES
QM_LFS_FILES
if [ "$HAS_LFS" = 1 ]; then
  g lfs version >/dev/null 2>&1 || die 4 "Git LFS is not installed: install git-lfs and run 'git lfs install' (without it the big files would be committed as full files)"
  [ -n "$(g config --get filter.lfs.clean)" ] || die 4 "Git LFS is not enabled for you: run 'git lfs install'"
fi

TMP=$(mktemp -d "\${TMPDIR:-/tmp}/qm-apply.XXXXXX") || die 4 "cannot create a temporary directory"

say "step 4/6: checking the text patch against the base tree (temporary index, your files are not touched)"
for patch in $QM_TEXT_PATCHES; do
  (
    GIT_INDEX_FILE="$TMP/index"
    export GIT_INDEX_FILE
    g read-tree "$QM_BASE" && g apply --cached --check "$PKG/$patch"
  ) || die 5 "the text patch $patch does not apply to the base commit $QM_BASE"
done

say "step 5/6: applying"
if [ "$NEWBRANCH" = 1 ]; then
  STATE=branch
  WT="$TMP/wt"
  g worktree add -q -b "$QM_BRANCH" "$WT" "$QM_BASE" || die 5 "cannot create the temporary worktree"
  W=$WT
  PARENT=$QM_BASE
else
  g update-ref "$QM_BACKUP" "$ORIG" || die 4 "cannot write $QM_BACKUP"
  STATE=direct
  W=$TOP
  PARENT=$ORIG
fi
if [ -n "$QM_TEXT_PATCHES" ]; then
  set --
  for patch in $QM_TEXT_PATCHES; do set -- "$@" "$PKG/$patch"; done
  err=$(w am --3way --keep-cr --keep-non-patch "$@" 2>&1) || die 5 "the text patch does not apply to this repository (someone changed the same lines?):
$err"
fi
n=0
while IFS=$TAB read -r status mode sha256 baseblob payload path; do
  [ -n "$status" ] || continue
  n=$((n + 1))
  if [ "$STATE" = direct ]; then
    mkdir -p "$TMP/save" || die 5 "cannot create a temporary directory"
    if [ "$status" = M ]; then
      cp -p "$W/$path" "$TMP/save/$n" || die 5 "cannot save $path"
    fi
    TOUCHED="$TOUCHED$status$TAB$n$TAB$path$NL"
    d=\${path%/*}
    if [ "$d" != "$path" ]; then
      miss=
      while [ ! -d "$W/$d" ]; do
        miss=$d
        case $d in */*) d=\${d%/*} ;; *) break ;; esac
      done
      [ -z "$miss" ] || DIRS="$DIRS$miss$NL"
    fi
  fi
  dir=\${path%/*}
  [ "$dir" = "$path" ] || mkdir -p "$W/$dir" || die 5 "cannot create the directory $dir"
  cp "$PKG/$payload" "$W/$path" || die 5 "cannot write $path"
  w add -- "$path" || die 5 "git add failed for $path"
  [ "$mode" != 100755 ] || w update-index --chmod=+x -- "$path" || die 5 "cannot set the executable bit on $path"
  size=$(w cat-file -s ":0:$path") || die 5 "$path is not staged"
  [ "$size" -le 1024 ] || die 5 "$path was staged as a full file, not as a Git LFS pointer: your .gitattributes or git-lfs setup does not treat it as LFS. Nothing was committed"
  pointer=$(w cat-file blob ":0:$path")
  case $pointer in
    "version https://git-lfs.github.com/spec/v1"*"oid sha256:$sha256"*) ;;
    *) die 5 "$path was not turned into the expected Git LFS pointer. Nothing was committed" ;;
  esac
done <<QM_LFS_FILES
$QM_LFS_FILES
QM_LFS_FILES

if [ -n "$QM_TEXT_PATCHES" ]; then
  if [ "$KEEPBOT" = 0 ]; then
    w commit -q --amend --no-edit --cleanup=verbatim --reset-author || die 5 "git commit failed (a hook of this repository refused it?)"
  elif [ "$HAS_LFS" = 1 ]; then
    w commit -q --amend --no-edit --cleanup=verbatim || die 5 "git commit failed (a hook of this repository refused it?)"
  fi
elif [ "$KEEPBOT" = 0 ]; then
  w commit -q --cleanup=verbatim -F "$PKG/$QM_MESSAGE_FILE" || die 5 "git commit failed (a hook of this repository refused it?)"
else
  w commit -q --cleanup=verbatim --author="$QM_AUTHOR_NAME <$QM_AUTHOR_EMAIL>" --date="$QM_AUTHOR_DATE" -F "$PKG/$QM_MESSAGE_FILE" || die 5 "git commit failed (a hook of this repository refused it?)"
fi
[ "$(w rev-list --count "$PARENT..HEAD")" = 1 ] && [ "$(w rev-parse "HEAD~1")" = "$PARENT" ] || die 5 "expected exactly one new commit on top of $PARENT"
NEW=$(w rev-parse HEAD)

say "step 6/6: result"
w log -1 --format=fuller --stat
if [ "$DRY" = 1 ]; then
  rollback
  if [ "$NEWBRANCH" = 1 ]; then
    if g show-ref --verify -q "refs/heads/$QM_BRANCH" || [ "$(g worktree list | wc -l)" -ne 1 ]; then
      die 5 "dry run: could not remove the temporary branch or worktree"
    fi
  else
    if [ "$(g rev-parse HEAD)" != "$ORIG" ] || [ -n "$(g status --porcelain --untracked-files=no)" ] || g rev-parse -q --verify "$QM_BACKUP" >/dev/null 2>&1; then
      die 5 "dry run: the repository could not be restored; your original HEAD is $ORIG, run: git reset --keep $ORIG"
    fi
  fi
  say "dry run finished: this package applies cleanly; everything was undone and nothing was left behind"
  exit 0
fi
if [ "$NEWBRANCH" = 1 ]; then
  git -C "$TOP" worktree remove --force "$WT" >/dev/null 2>&1
  git -C "$TOP" worktree prune >/dev/null 2>&1
  STATE=idle
  say "done: the local branch $QM_BRANCH holds one commit on top of the base commit $QM_BASE ($NEW)"
  say "  your current branch and working tree were not touched"
  say "  review: git log -1 --stat $QM_BRANCH     work on it: git switch $QM_BRANCH"
  say "  undo: git switch - (if you switched), then git branch -D $QM_BRANCH"
else
  STATE=idle
  g update-ref -d "$QM_BACKUP" >/dev/null 2>&1
  say "done: one commit was created on your current branch $CURRENT ($NEW)"
  say "  original HEAD: $ORIG"
  say "  review: git log -1 --stat     git show"
  say "  undo, only while the commit is not pushed (this script never pushes): git reset --keep $ORIG"
fi
say "Nothing was pushed. Push in your usual way when you are satisfied."
exit 0
`;

export function renderApplyScript(data: ScriptData, manifestBlob?: string): string {
  const head = [
    "#!/bin/sh",
    ...(manifestBlob ? [`${MANIFEST_LINE_PREFIX}${quote(manifestBlob, "the manifest id")}`] : []),
    `QM_ID=${quote(data.id, "the package id")}`,
    `QM_BRANCH=${quote(`qm/${data.id}`, "the branch name")}`,
    `QM_BACKUP=${quote(`refs/qm/backup/${data.id}`, "the backup ref")}`,
    `QM_BASE=${quote(data.base, "the base commit")}`,
    `QM_AUTHOR_NAME=${quote(data.authorName, "the author name")}`,
    `QM_AUTHOR_EMAIL=${quote(data.authorEmail, "the author email")}`,
    `QM_AUTHOR_DATE=${quote(data.authorDate, "the author date")}`,
    `QM_MESSAGE_FILE=${quote(data.messageFile, "the message file name")}`,
    `QM_TEXT_PATCHES=${quote(data.textPatches.join(" "), "a patch name")}`,
  ];
  const files = data.packageFiles.map((f) => `${f.blob}\t${quote(f.name, "a file name").slice(1, -1)}`).join("\n");
  const lfs = data.lfsFiles
    .map((r) =>
      [r.status, r.mode, r.sha256, r.baseBlob, r.payload, quote(r.path, "a repository path").slice(1, -1)].join("\t"),
    )
    .join("\n");
  return `${head.join("\n")}\nQM_PACKAGE_FILES='${files}'\nQM_LFS_FILES='${lfs}'\n${BODY}`;
}
