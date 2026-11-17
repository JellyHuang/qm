#!/usr/bin/env bash
set -u
umask 077
MB=${ZQ_BENCH_MB:-200}
RUNS=${ZQ_BENCH_RUNS:-1}
STEP_T=${ZQ_BENCH_STEP_TIMEOUT:-300}
INTERVAL=${ZQ_BENCH_INTERVAL:-0.2}

GV=$(git --version | awk '{print $3}')
WORK=$(mktemp -d /tmp/zqmembench.XXXXXX) || exit 2
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM
export HOME=$WORK/home GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
mkdir -p "$HOME"

now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
rss_kb() { ps -eo rss=,args= | awk '$2 ~ /(^|\/)(git|ssh)$/ && $0 !~ /pack-objects|upload-pack/ {s+=$1} END{print s+0}'; }

W=$WORK/src
git init -q "$W"
git -C "$W" config user.email bench@example.invalid
git -C "$W" config user.name bench
head -c $((MB*1048576)) /dev/urandom > "$W/big.bin"
echo small > "$W/small.txt"
git -C "$W" add -A
git -C "$W" commit -q -m bench
OID=$(git -C "$W" rev-parse HEAD:big.bin)
git clone -q --bare "$W" "$WORK/server.git"
rm -rf "$W"
git -C "$WORK/server.git" config uploadpack.allowFilter true
git -C "$WORK/server.git" config uploadpack.allowAnySHA1InWant true
git -C "$WORK/server.git" repack -q -a -d
git clone -q --bare --filter=blob:none "file://$WORK/server.git" "$WORK/client.git"
echo "INFO membench git=$GV blob_mb=$MB oid=${OID:0:12} pack_kb=$(du -sk "$WORK/server.git/objects/pack" | cut -f1) interval_s=$INTERVAL runs=$RUNS"

BENCH_PEAK=0; BENCH_SECS=0; BENCH_RC=0
bench() {
  local t=$1 mode=$2 pid s m peak=0
  shift 2
  s=$(now)
  if [ "$mode" = cfg ]; then
    timeout -k 10 "$STEP_T" git -c fetch.negotiationAlgorithm=noop "$@" -C "$t" fetch -q --no-tags --no-write-fetch-head origin "$OID" 2>/dev/null &
  else
    timeout -k 10 "$STEP_T" git -c fetch.negotiationAlgorithm=noop -C "$t" fetch -q --no-tags --no-write-fetch-head origin "$OID" 2>/dev/null &
  fi
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    m=$(rss_kb); [ "$m" -gt "$peak" ] && peak=$m
    sleep "$INTERVAL"
  done
  wait "$pid"; BENCH_RC=$?
  BENCH_SECS=$(el "$s" "$(now)")
  BENCH_PEAK=$peak
}

new_tmp() {
  local t; t=$(mktemp -d "$WORK/t.XXXXXX")
  git init -q --bare "$t"
  echo "$WORK/client.git/objects" > "$t/objects/info/alternates"
  git -C "$t" config remote.origin.url "file://$WORK/server.git"
  git -C "$t" config remote.origin.promisor true
  git -C "$t" config fetch.unpackLimit 1
  git -C "$t" config transfer.unpackLimit 1
  echo "$t"
}

run_variant() {
  local label=$1 repocfg=$2 mode=$3 i t ok
  shift 3
  for i in $(seq 1 "$RUNS"); do
    t=$(new_tmp)
    [ -n "$repocfg" ] && git -C "$t" config core.bigFileThreshold "$repocfg"
    bench "$t" "$mode" "$@"
    if [ "$BENCH_RC" -eq 0 ] && git -C "$t" cat-file -e "$OID" 2>/dev/null; then ok=ok; else ok=failed; fi
    echo "INFO membench variant=$label run=$i result=$ok wall_s=$BENCH_SECS peak_rss_mb=$((BENCH_PEAK/1024)) rc=$BENCH_RC"
    LAST_PEAK=$((BENCH_PEAK/1024)); LAST_SECS=$BENCH_SECS
    rm -rf "$t"
  done
}

run_variant default "" plain
P_DEF=$LAST_PEAK
run_variant bigFileThreshold=1m 1m plain
P_BFT=$LAST_PEAK
run_variant windowMemory=64m+bigFileThreshold=1m "" cfg -c pack.windowMemory=64m -c core.bigFileThreshold=1m
P_WM=$LAST_PEAK

if [ "$P_BFT" -lt $((P_DEF/2)) ] && [ "$P_BFT" -lt $((MB/4)) ]; then V=yes; else V=no; fi
echo "INFO membench verdict bigFileThreshold makes index-pack stream: $V (rule: yes when threshold peak < half of default peak and < quarter of blob size); peaks default=${P_DEF}MB threshold=${P_BFT}MB windowMemory+threshold=${P_WM}MB blob=${MB}MB"
