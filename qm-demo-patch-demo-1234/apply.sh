#!/bin/sh
QM_ID='demo-1234'
QM_BRANCH='qm/demo-1234'
QM_BASE='0fd2d63c466ae61fdec86f670a5f681f0c075a0c'
QM_AUTHOR_NAME='QM Bot'
QM_AUTHOR_EMAIL='qm-bot@invalid'
QM_PATCH='patches/0001-WP-1234-Adjust-skill-level-3-cost.mbox'
QM_BIN_PATH='data/skill_table.xlsx'
QM_BIN_FILE='files/data/skill_table.xlsx'
QM_BIN_BASE_BLOB='61259be1d755ffe78ae0e37bb2c2a440c087a2fd'
QM_BIN_NEW_BLOB='d71bcab81fe6823c3a2c12b34cc97abab03c5a0f'
QM_PACKAGE_FILES='8bc120c3e55e11b178db62201b780571af773beb	patches/0001-WP-1234-Adjust-skill-level-3-cost.mbox
ec61d37d77ed3e147dfbab664496baf4345a8e82	COMMIT_MESSAGE.txt
d71bcab81fe6823c3a2c12b34cc97abab03c5a0f	files/data/skill_table.xlsx
1bbc954486cd79e846e02eb2ded7e860c5056a30	manifest.json'
PKG=$(cd "${0%/*}" 2>/dev/null && pwd) || PKG=$(pwd)
REPO=.
DRY=0
RESET_AUTHOR=0

usage() {
  printf '%s\n' "Usage: sh apply.sh [--repo DIR] [--dry-run] [--reset-author] [--help]" \
    "  --repo DIR       the git clone to apply to (default: current directory)" \
    "  --dry-run        do everything in a temporary worktree, show the result, delete it all" \
    "  --reset-author   author the commit as you (default: author stays $QM_AUTHOR_NAME)" \
    "  --help           this text" \
    "Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed, 5 apply failed, 130 interrupted." \
    "Creates the local branch $QM_BRANCH from the base commit. Never pushes, never fetches," \
    "never changes your current branch or your working tree."
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
command -v git >/dev/null 2>&1 || die 4 "git is not installed or not on PATH"

TMP=
WT=
CREATED=0
KEEP=0
cleanup() {
  [ -n "$TOP" ] || return 0
  if [ -n "$WT" ] && [ -d "$WT" ]; then
    git -C "$TOP" worktree remove --force "$WT" >/dev/null 2>&1
  fi
  [ -z "$TMP" ] || rm -rf "$TMP"
  git -C "$TOP" worktree prune >/dev/null 2>&1
  if [ "$CREATED" = 1 ] && [ "$KEEP" = 0 ]; then
    git -C "$TOP" branch -D "$QM_BRANCH" >/dev/null 2>&1
  fi
}
TOP=
trap cleanup EXIT
trap 'printf "QM apply: interrupted, undoing everything\n" >&2; exit 130' INT TERM HUP

say "package $QM_ID, base $QM_BASE"

say "step 1/7: checking the package files against the manifest (git hash-object --no-filters)"
while IFS=$TAB read -r blob name; do
  [ -n "$blob" ] || continue
  [ -f "$PKG/$name" ] || die 3 "the package is incomplete: $name is missing"
  got=$(cd "$PKG" && git hash-object --no-filters -- "$name") || die 3 "cannot hash $name"
  [ "$got" = "$blob" ] || die 3 "$name does not match the manifest (got $got, expected $blob): download the package again"
done <<QM_PACKAGE_FILES
$QM_PACKAGE_FILES
QM_PACKAGE_FILES

say "step 2/7: checking your repository (nothing is changed in it)"
TOP=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || die 4 "$REPO is not a git repository (use --repo DIR)"
g() { git -C "$TOP" -c core.quotePath=false "$@"; }
[ "$(g rev-parse --is-bare-repository)" = false ] || die 4 "$REPO is a bare repository"
for state in rebase-apply rebase-merge MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  [ ! -e "$(g rev-parse --path-format=absolute --git-path "$state")" ] || die 4 "an operation is in progress ($state): finish or abort it first"
done
[ -z "$(g status --porcelain --untracked-files=no)" ] || die 4 "the working tree has uncommitted changes: commit or stash them, then run again"
ORIG_SHA=$(g rev-parse --verify -q HEAD) || die 4 "the repository has no commit yet"
ORIG_REF=$(g symbolic-ref -q HEAD || echo "(detached HEAD)")
g var GIT_COMMITTER_IDENT >/dev/null 2>&1 || die 4 "git does not know who you are: run git config user.name and git config user.email first"
g cat-file -e "$QM_BASE^{commit}" 2>/dev/null || die 4 "the base commit $QM_BASE is not in this repository: run 'git fetch' yourself (this script never fetches), then run again"
if ! g merge-base --is-ancestor "$QM_BASE" HEAD 2>/dev/null; then
  say "note: your current HEAD does not contain the base commit; that is fine, the branch is built on the base commit itself"
elif [ "$(g rev-parse "$QM_BASE")" != "$ORIG_SHA" ]; then
  say "note: your current HEAD is newer than the base commit; the new branch starts from the base commit, not from HEAD"
fi
g check-ref-format "refs/heads/$QM_BRANCH" || die 4 "invalid branch name $QM_BRANCH"
! g show-ref --verify -q "refs/heads/$QM_BRANCH" || die 4 "the branch $QM_BRANCH already exists: this package was probably applied before. Inspect it, or delete it with 'git branch -D $QM_BRANCH' if you do not need it, then run again"

say "step 3/7: checking the binary file $QM_BIN_PATH at the base commit"
have=$(g rev-parse -q --verify "$QM_BASE:$QM_BIN_PATH") || die 4 "$QM_BIN_PATH does not exist at the base commit"
[ "$have" = "$QM_BIN_BASE_BLOB" ] || die 4 "$QM_BIN_PATH at the base commit is $have but the package was made for $QM_BIN_BASE_BLOB: the package would not replace the version it was made against. Nothing was changed. Ask for a new package"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/qm-apply.XXXXXX") || die 4 "cannot create a temporary directory"

say "step 4/7: git apply --check of the text patch against the base tree (temporary index, your files are not touched)"
(
  GIT_INDEX_FILE="$TMP/index"
  export GIT_INDEX_FILE
  g read-tree "$QM_BASE" && g apply --cached --check "$PKG/$QM_PATCH"
) || die 5 "the text patch does not apply to the base commit $QM_BASE"
say "  ok. Limits of this check: it only proves the patch applies to the exact base tree; it does not run hooks, does not test the binary file, and does not prove the result is correct. The real apply follows in step 5."

say "step 5/7: creating branch $QM_BRANCH at the base commit in a temporary worktree and applying (git am --keep-non-patch --3way --keep-cr)"
CREATED=1
WT="$TMP/wt"
g worktree add -q -b "$QM_BRANCH" "$WT" "$QM_BASE" || die 5 "cannot create the temporary worktree"
w() { git -C "$WT" -c core.quotePath=false "$@"; }
err=$(w am --keep-non-patch --3way --keep-cr "$PKG/$QM_PATCH" 2>&1) || die 5 "git am failed:
$err"

say "step 6/7: adding the binary file $QM_BIN_PATH to the same commit"
dir=${QM_BIN_PATH%/*}
[ "$dir" = "$QM_BIN_PATH" ] || mkdir -p "$WT/$dir" || die 5 "cannot create the directory $dir"
cp "$PKG/$QM_BIN_FILE" "$WT/$QM_BIN_PATH" || die 5 "cannot write $QM_BIN_PATH"
w add -- "$QM_BIN_PATH" || die 5 "git add failed for $QM_BIN_PATH"
if [ "$RESET_AUTHOR" = 1 ]; then
  w commit -q --amend --no-edit --cleanup=verbatim --reset-author || die 5 "git commit failed (a hook of this repository refused it?)"
else
  w commit -q --amend --no-edit --cleanup=verbatim || die 5 "git commit failed (a hook of this repository refused it?)"
fi
got=$(w rev-parse -q --verify "HEAD:$QM_BIN_PATH") || die 5 "$QM_BIN_PATH is missing from the new commit"
[ "$got" = "$QM_BIN_NEW_BLOB" ] || die 5 "$QM_BIN_PATH was stored as $got, expected $QM_BIN_NEW_BLOB: a filter or attribute of this repository changed the file. Nothing was kept"
[ "$(g rev-list --count "$QM_BASE..$QM_BRANCH")" = 1 ] || die 5 "expected exactly one new commit on $QM_BRANCH"
NEW_SHA=$(g rev-parse "$QM_BRANCH")

say "step 7/7: result"
g log -1 --format=fuller --stat "$QM_BRANCH"
if [ "$DRY" = 1 ]; then
  say "dry run finished: the package applies cleanly. The temporary worktree and the branch $QM_BRANCH are being deleted; nothing was changed"
  exit 0
fi
KEEP=1
cleanup
trap - EXIT
[ "$(g rev-parse --verify -q HEAD)" = "$ORIG_SHA" ] || say "warning: HEAD moved while the script ran; this should not happen"
say "done."
say "  branch:  $QM_BRANCH"
say "  commit:  $NEW_SHA"
say "  you are still on: $ORIG_REF at $ORIG_SHA (unchanged; your working tree was not touched)"
say "  review:  git log $QM_BRANCH    and    git diff $QM_BASE..$QM_BRANCH"
say "  work on it: git switch $QM_BRANCH     undo: git branch -D $QM_BRANCH (after git switch - if you switched)"
say "Nothing was pushed. Push in your usual way when you are satisfied."
exit 0
