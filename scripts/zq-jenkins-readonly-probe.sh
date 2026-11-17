#!/usr/bin/env bash
set -euo pipefail
umask 077

DEFAULT_JOBS="CheckServerConfig,LLM-Wiki,PackageSent,Server-Build,Server-Clang-Tidy,Server-CodeReview,Server-Config,Server-Run"

require() {
  if [[ -z "${!1:-}" ]]; then
    echo "$1 is required" >&2
    exit 2
  fi
}

require ZQ_JENKINS_URL
require JENKINS_QM_BOT_USER
secret="${JENKINS_QM_BOT_TOKEN:-${JENKINS_QM_BOT_PASSWORD:-}}"
if [[ -z "$secret" ]]; then
  echo "JENKINS_QM_BOT_TOKEN or JENKINS_QM_BOT_PASSWORD is required" >&2
  exit 2
fi
for tool in curl jq shred; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

base="${ZQ_JENKINS_URL%/}"
case "$base" in
  http://* | https://*) ;;
  *) echo "ZQ_JENKINS_URL must be an http(s) URL" >&2; exit 2 ;;
esac

work="$(mktemp -d)"
conf="$work/curl.conf"
cleanup() {
  if [[ -f "$conf" ]]; then
    shred -u "$conf" 2>/dev/null || rm -f "$conf"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

credential="${JENKINS_QM_BOT_USER}:${secret}"
credential="${credential//\\/\\\\}"
credential="${credential//\"/\\\"}"
{
  echo 'silent'
  echo 'show-error'
  echo 'max-time = 30'
  echo 'proto = "=http,https"'
  printf 'user = "%s"\n' "$credential"
} >"$conf"
unset secret credential
chmod 600 "$conf"

fetch() {
  curl --config "$conf" --get --output "$work/body.json" --write-out '%{http_code}' "$1" "${@:2}"
}

status="$(fetch "$base/api/json" --data-urlencode 'tree=jobs[name]')" || status="000"
case "$status" in
  200) ;;
  401 | 403) echo "authentication failed: Jenkins answered $status" >&2; exit 1 ;;
  *) echo "Jenkins unreachable or unexpected answer: $status" >&2; exit 1 ;;
esac
visible="$(jq -r '[.jobs[]?.name] | join("\n")' "$work/body.json")"
echo "authenticated: yes"
echo "jobs visible to the account: $(printf '%s' "$visible" | grep -c . || true)"

builds_tree='builds[number,building,result,timestamp,actions[causes[_class,userId],parameters[_class,name,value]]]{0,5}'
missing=0
: >"$work/records.ndjson"

IFS=',' read -r -a jobs <<<"${ZQ_JENKINS_JOBS:-$DEFAULT_JOBS}"
for job in "${jobs[@]}"; do
  job="${job// /}"
  if ! printf '%s\n' "$visible" | grep -Fxq -- "$job"; then
    echo "job $job: not visible"
    missing=$((missing + 1))
    continue
  fi
  encoded="$(jq -rn --arg j "$job" '$j | @uri')"
  status="$(fetch "$base/job/$encoded/api/json" --data-urlencode 'tree=property[parameterDefinitions[name]]')" || status="000"
  if [[ "$status" != "200" ]]; then
    echo "job $job: definition unreadable ($status)"
    missing=$((missing + 1))
    continue
  fi
  jq -c '[.property[]?.parameterDefinitions[]?.name]' "$work/body.json" >"$work/defined.json"
  status="$(fetch "$base/job/$encoded/api/json" --data-urlencode "tree=$builds_tree")" || status="000"
  if [[ "$status" != "200" ]]; then
    echo "job $job: builds unreadable ($status)"
    missing=$((missing + 1))
    continue
  fi
  jq -c --arg job "$job" --arg bot "$JENKINS_QM_BOT_USER" --slurpfile defined "$work/defined.json" '
    def kind:
      if test("TimerTrigger") then "timer"
      elif test("SCMTrigger") then "scm"
      elif test("UpstreamCause") then "upstream"
      elif test("UserIdCause|RebuildCause") then "user"
      elif test("RemoteCause") then "remote"
      else "other" end;
    def scalar: (type == "string") or (type == "number") or (type == "boolean");
    .builds[]? | . as $b
    | ([$b.actions[]?.parameters[]?]) as $params
    | ($params | any(((._class // "") | test("Password|File")) or (.value == null) or (.value | scalar | not))) as $masked
    | ([$params[].name] | sort | unique) as $have
    | {
        job: $job,
        number: $b.number,
        result: (if $b.building then "RUNNING" else ($b.result // "NONE") end),
        time: ($b.timestamp / 1000 | floor | todate),
        causes: ([$b.actions[]?.causes[]? | if (._class | kind) == "user" then (if (.userId // "") == $bot then "bot" else "user" end) else (._class | kind) end] | if length == 0 then ["none"] else . end),
        parameters: (if $masked then "masked" elif $have == ($defined[0] | sort | unique) then "complete" else "incomplete" end)
      }' "$work/body.json" >>"$work/records.ndjson"
done

echo
jq -r '"\(.job)\t#\(.number)\t\(.result)\t\(.time)\tcause=\(.causes | join("+"))\tparameters=\(.parameters)"' "$work/records.ndjson"
echo
jq -rs '
  def count(f): group_by(f) | map("\(.[0] | f)=\(length)") | join(" ");
  "builds read: \(length)",
  "results: \(count(.result))",
  "causes: \(map(.causes[]) | group_by(.) | map("\(.[0])=\(length)") | join(" "))",
  "parameters: \(count(.parameters))"
' "$work/records.ndjson"
echo "jobs not readable: $missing"
if [[ "$missing" -gt 0 ]]; then
  exit 1
fi
