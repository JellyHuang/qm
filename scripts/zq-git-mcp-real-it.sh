#!/usr/bin/env bash
set -euo pipefail

plugin_dir="${ZQ_MCP_DIR:?set ZQ_MCP_DIR to a checkout of oa/zq-git-mcp}/plugins/zq-git-mcp"
: "${GITLAB_QM_READONLY_SSH_KEY_B64:?set GITLAB_QM_READONLY_SSH_KEY_B64}"
fingerprint="${ZQ_GIT_MCP_IT_HOST_FINGERPRINT:-SHA256:DkCVY8DnWnZqf8eTvxgHTj5IRFmOtYj3IMgVy4PiTCQ}"
mode="${ZQ_MCP_IT_MODE:-full}"
test_file="test/real-server-it.test.ts"
git_bin="${ZQ_GIT_MCP_GIT_BIN:-git}"

version_at_least() {
  local have="$1" want_major="$2" want_minor="$3"
  local major minor
  major="${have%%.*}"
  minor="${have#*.}"
  minor="${minor%%.*}"
  [ "$major" -gt "$want_major" ] || { [ "$major" -eq "$want_major" ] && [ "$minor" -ge "$want_minor" ]; }
}

[ -f "$plugin_dir/$test_file" ] || { echo "FAIL: $plugin_dir/$test_file not found" >&2; exit 2; }
[ -d "$plugin_dir/node_modules" ] || { echo "FAIL: run npm ci in $plugin_dir first" >&2; exit 2; }

git_version="$("$git_bin" --version | awk '{print $3}')"
node_version="$(node --version | sed 's/^v//')"
echo "git $git_version ($git_bin), node $node_version, mode $mode"
version_at_least "$git_version" 2 44 || { echo "FAIL: git 2.44 or newer is required (set ZQ_GIT_MCP_GIT_BIN)" >&2; exit 2; }
version_at_least "$node_version" 24 0 || { echo "FAIL: node 24 or newer is required" >&2; exit 2; }

work="/tmp/zqit.$$"
mkdir -m 700 "$work"
trap 'rm -rf "$work"' EXIT
log="$work/output.log"

diag_env=()
if [ "$mode" = "diag" ]; then
  : "${ZQ_MCP_IT_DIAG_PAIRS:?set ZQ_MCP_IT_DIAG_PAIRS to path:baseBlob:headBlob[,path:baseBlob:headBlob...] (blob ids of at least 7 hex digits, or full 40 hex)}"
  diag_env=(
    ZQ_GIT_MCP_IT_DIAG_REPO="${ZQ_MCP_IT_DIAG_REPO:-gameconfig}"
    ZQ_GIT_MCP_IT_DIAG_PAIRS="$ZQ_MCP_IT_DIAG_PAIRS"
    ZQ_GIT_MCP_IT_DIAG_REF="${ZQ_MCP_IT_DIAG_REF:-main}"
  )
fi

status=0
env -u GITLAB_QM_READONLY_SSH_KEY_B64 \
  TMPDIR="$work" \
  ZQ_GIT_MCP_IT_KEY_B64="$GITLAB_QM_READONLY_SSH_KEY_B64" \
  ZQ_GIT_MCP_IT_HOST_FINGERPRINT="$fingerprint" \
  ${ZQ_GIT_MCP_GIT_BIN:+ZQ_GIT_MCP_GIT_BIN="$ZQ_GIT_MCP_GIT_BIN"} \
  ${ZQ_GIT_MCP_PATH:+ZQ_GIT_MCP_PATH="$ZQ_GIT_MCP_PATH"} \
  "${diag_env[@]}" \
  timeout --kill-after=30 1800 \
  npm test --prefix "$plugin_dir" -- "$test_file" >"$log" 2>&1 || status=$?

if [ "$mode" = "diag" ]; then
  grep -E '^\{"suite":"xlsx-diag"' "$log" || true
  lines="$(grep -c '^{"suite":"xlsx-diag"' "$log" || true)"
  if [ "$status" -eq 0 ] && [ "$lines" -ge 1 ]; then
    echo "PASS: $lines structure lines (counts, letters and sheet names only)"
    exit 0
  fi
  grep -E '^\s*(✖|error:|message:)' "$log" | head -20 || true
  echo "FAIL: exit $status, $lines structure lines"
  exit 1
fi

grep -E '^\{"suite":' "$log" || true
gameconfig="$(grep -c '^{"suite":"gameconfig-diff-xlsx"' "$log" || true)"
psd="$(grep -c '^{"suite":"zq-ui-psd"' "$log" || true)"

if [ "$status" -eq 0 ] && [ "$gameconfig" -ge 1 ] && [ "$psd" -ge 1 ]; then
  echo "PASS: $gameconfig xlsx diffs, $psd psd read"
  exit 0
fi

grep -E '^\s*(✖|error:|message:)' "$log" | head -20 || true
echo "FAIL: exit $status, $gameconfig xlsx diffs, $psd psd read"
exit 1
