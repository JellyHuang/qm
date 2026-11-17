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

scrubbed_tail() {
  K="$GITLAB_QM_READONLY_SSH_KEY_B64" awk '
    BEGIN { key = ENVIRON["K"] }
    { line = $0; while (key != "" && (at = index(line, key)) > 0) line = substr(line, 1, at - 1) "[key]" substr(line, at + length(key)); print line }
  ' "$1" | tail -n 40
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

mode_env=()
case "$mode" in
  full) ;;
  diag)
    : "${ZQ_MCP_IT_DIAG_PAIRS:?set ZQ_MCP_IT_DIAG_PAIRS to ref:<path>:<baseRef>:<headRef> or blob:<path>:<baseOid>:<headOid>, comma separated (a path:base:head entry means ref)}"
    mode_env=(
      ZQ_GIT_MCP_IT_DIAG_REPO="${ZQ_MCP_IT_DIAG_REPO:-gameconfig}"
      ZQ_GIT_MCP_IT_DIAG_PAIRS="$ZQ_MCP_IT_DIAG_PAIRS"
      ZQ_GIT_MCP_IT_DIAG_REF="${ZQ_MCP_IT_DIAG_REF:-main}"
    )
    ;;
  override)
    : "${ZQ_MCP_IT_OVERRIDE_PATH:?set ZQ_MCP_IT_OVERRIDE_PATH, ZQ_MCP_IT_OVERRIDE_BASE_REF and ZQ_MCP_IT_OVERRIDE_HEAD_REF}"
    : "${ZQ_MCP_IT_OVERRIDE_BASE_REF:?set ZQ_MCP_IT_OVERRIDE_BASE_REF}"
    : "${ZQ_MCP_IT_OVERRIDE_HEAD_REF:?set ZQ_MCP_IT_OVERRIDE_HEAD_REF}"
    mode_env=(
      ZQ_GIT_MCP_IT_OVERRIDE_REPO="${ZQ_MCP_IT_OVERRIDE_REPO:-gameconfig}"
      ZQ_GIT_MCP_IT_OVERRIDE_PATH="$ZQ_MCP_IT_OVERRIDE_PATH"
      ZQ_GIT_MCP_IT_OVERRIDE_BASE_REF="$ZQ_MCP_IT_OVERRIDE_BASE_REF"
      ZQ_GIT_MCP_IT_OVERRIDE_HEAD_REF="$ZQ_MCP_IT_OVERRIDE_HEAD_REF"
      ZQ_GIT_MCP_IT_OVERRIDE_KEY_COLUMNS="${ZQ_MCP_IT_OVERRIDE_KEY_COLUMNS:-}"
    )
    ;;
  *) echo "FAIL: ZQ_MCP_IT_MODE is full, diag or override" >&2; exit 2 ;;
esac

status=0
env -u GITLAB_QM_READONLY_SSH_KEY_B64 \
  TMPDIR="$work" \
  ZQ_GIT_MCP_IT_KEY_B64="$GITLAB_QM_READONLY_SSH_KEY_B64" \
  ZQ_GIT_MCP_IT_HOST_FINGERPRINT="$fingerprint" \
  ${ZQ_GIT_MCP_GIT_BIN:+ZQ_GIT_MCP_GIT_BIN="$ZQ_GIT_MCP_GIT_BIN"} \
  ${ZQ_GIT_MCP_PATH:+ZQ_GIT_MCP_PATH="$ZQ_GIT_MCP_PATH"} \
  ${mode_env[@]+"${mode_env[@]}"} \
  timeout --kill-after=30 1800 \
  npm test --prefix "$plugin_dir" -- "$test_file" >"$log" 2>&1 || status=$?

if [ "$mode" != "full" ]; then
  suite="xlsx-diag"
  [ "$mode" = "override" ] && suite="xlsx-override"
  grep -E "^\{\"suite\":\"$suite\"" "$log" || true
  lines="$(grep -c "^{\"suite\":\"$suite\"" "$log" || true)"
  errors="$(grep -c "^{\"suite\":\"$suite\",\"type\":\"error\"" "$log" || true)"
  if [ "$status" -eq 0 ] && [ "$lines" -ge 1 ] && [ "$errors" -eq 0 ]; then
    echo "PASS: $lines $suite lines (counts, letters and sheet names only)"
    exit 0
  fi
  echo "---- last lines of the run output (the key is removed) ----"
  scrubbed_tail "$log"
  echo "FAIL: exit $status, $lines $suite lines, $errors errors"
  exit 1
fi

grep -E '^\{"suite":' "$log" || true
gameconfig="$(grep -c '^{"suite":"gameconfig-diff-xlsx"' "$log" || true)"
psd="$(grep -c '^{"suite":"zq-ui-psd"' "$log" || true)"

if [ "$status" -eq 0 ] && [ "$gameconfig" -ge 1 ] && [ "$psd" -ge 1 ]; then
  echo "PASS: $gameconfig xlsx diffs, $psd psd read"
  exit 0
fi

echo "---- last lines of the run output (the key is removed) ----"
scrubbed_tail "$log"
echo "FAIL: exit $status, $gameconfig xlsx diffs, $psd psd read"
exit 1
