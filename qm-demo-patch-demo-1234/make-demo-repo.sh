#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
target=${1:-./qm-demo-repo}

fail() {
  printf 'make-demo-repo.sh: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is not installed"
[ -f "$here/demo-data/skill_table.base.xlsx" ] || fail "demo-data/skill_table.base.xlsx is missing next to this script"
[ -f "$here/manifest.json" ] || fail "manifest.json is missing next to this script"

if [ -e "$target" ]; then
  if [ ! -d "$target" ] || [ -n "$(ls -A "$target")" ]; then
    fail "$target already exists and is not an empty directory; give a new directory name"
  fi
fi
mkdir -p "$target"
target=$(cd "$target" && pwd)

expected=$(sed -n '/"base"/,/}/s/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$here/manifest.json" | head -n 1)
[ -n "$expected" ] || fail "cannot read the base commit from manifest.json"

GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL

cd "$target"
git init -q
git symbolic-ref HEAD refs/heads/main
git config core.autocrlf false
git config core.filemode true
git config commit.gpgsign false

commit_as() {
  GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$2 GIT_AUTHOR_DATE=$3 \
  GIT_COMMITTER_NAME=$1 GIT_COMMITTER_EMAIL=$2 GIT_COMMITTER_DATE=$3 \
    git commit -q --no-verify -m "$4"
}

cat > README.md <<'EOF'
Game config (demo)
==================

Invented example repository. All names and data are made up.
EOF
mkdir -p config
cat > config/skill_levels.lua <<'EOF'
local skills = {}

skills.level_1 = {
  name = "Novice",
  cost = 100,
  cooldown = 10,
}

skills.level_2 = {
  name = "Adept",
  cost = 250,
  cooldown = 8,
}

skills.level_3 = {
  name = "Expert",
  cost = 600,
  cooldown = 6,
}

skills.level_4 = {
  name = "Master",
  cost = 1200,
  cooldown = 4,
}

return skills
EOF
git add README.md config/skill_levels.lua
commit_as "Alice Example" "alice@example.invalid" "2026-01-05T10:00:00+0000" "Add readme and skill level config"

mkdir -p data
cp "$here/demo-data/skill_table.base.xlsx" data/skill_table.xlsx
git add data/skill_table.xlsx
commit_as "Bob Sample" "bob@example.invalid" "2026-01-12T10:00:00+0000" "Add the skill table workbook"

printf '\nSee config/skill_levels.lua and data/skill_table.xlsx.\n' >> README.md
git add README.md
commit_as "Carol Placeholder" "carol@example.invalid" "2026-01-19T10:00:00+0000" "Point the readme at the data files"

git config user.name "Demo User"
git config user.email "demo.user@example.invalid"

actual=$(git rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  printf 'make-demo-repo.sh: the base commit differs from the package.\n' >&2
  printf '  package manifest: %s\n  built here:       %s\n' "$expected" "$actual" >&2
  printf 'The fixed text and dates produce the package commit only with the default git object format (sha1) and unchanged file bytes.\n' >&2
  printf 'Check that git init creates a sha1 repository and that nothing converted line endings. apply.sh will refuse this repository.\n' >&2
  exit 1
fi

pkg=$here
cat <<EOF

Demo repository created in $target
Base commit: $actual (equals the package base commit), branch main.
This throwaway repository has a LOCAL identity only inside it:
  Demo User <demo.user@example.invalid>
Your global git identity is not touched. In a real repository the commit uses YOUR git identity.

Next steps:
  cd $target
  sh $pkg/apply.sh --dry-run
  sh $pkg/apply.sh
  git log -1 --stat
  git show
Undo (put the repository back as it was):
  git reset --keep $actual
EOF
