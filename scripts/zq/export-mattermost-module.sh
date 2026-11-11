#!/bin/bash
set -euo pipefail
REPO=$(git rev-parse --show-toplevel)
DEST=${1:-/opt/zq-ai/git/qm-mattermost.git}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git clone -q -b main "$DEST" "$WORK/module" 2>/dev/null || git init -q -b main "$WORK/module"
rsync -a --delete --exclude .git "$REPO/src/surfaces/mattermost/" "$WORK/module/"
cp "$REPO/test/mattermost-surface.test.ts" "$WORK/module/mattermost-surface.test.ts"
cp "$REPO/docs/zq/SEAMS.md" "$WORK/module/SEAMS.md"
cd "$WORK/module"
git add -A
if git diff --cached --quiet; then echo "module repo already matches $(git -C "$REPO" rev-parse --short HEAD)"; exit 0; fi
git -c user.name="$(git -C "$REPO" config user.name)" -c user.email="$(git -C "$REPO" config user.email)" \
  commit -q -m "Sync from qm-zq $(git -C "$REPO" rev-parse --short HEAD)"
git push -q "$DEST" HEAD:main
echo "exported src/surfaces/mattermost at $(git -C "$REPO" rev-parse --short HEAD) to $DEST"
