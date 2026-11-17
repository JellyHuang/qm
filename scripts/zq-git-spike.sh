#!/usr/bin/env bash
set -u
umask 077
HOST=${GITLAB_HOST:-lab.skyunion.net}
GROUP=${ZQ_SPIKE_GROUP:-ca-programmer-zq}
LOCAL=${ZQ_SPIKE_BASE_URL:-}
if [ -n "$LOCAL" ]; then BASE=$LOCAL; else BASE="git@$HOST:$GROUP"; fi
STEP_T=${ZQ_SPIKE_STEP_TIMEOUT:-900}
CAP_MB=${ZQ_SPIKE_BIG_CAP_MB:-4096}
NCAND=${ZQ_SPIKE_BIG_CANDIDATES:-4}
SYNTH_MB=${ZQ_SPIKE_SYNTH_MB:-1200}
RSS_LIM_MB=${ZQ_SPIKE_RSS_LIMIT_MB:-512}
TEXTREPO=${ZQ_SPIKE_TEXT_REPO:-clientcode}
EXTRA=${ZQ_SPIKE_EXTRA_REPOS:-"$GROUP/qm-test"}
REPOS="client clientcode CommonMessage gameconfig jenkinstasks server zq-ui"

WORK=$(mktemp -d /tmp/zqspike.XXXXXX) || exit 2
CMDIR=$(mktemp -d /tmp/zqcm.XXXXXX) || exit 2
KEY=$WORK/key
KH=$WORK/known_hosts
ERR=$WORK/err.log
: > "$ERR"
mkdir -p "$WORK/home" "$WORK/repos"
export HOME=$WORK/home GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export BASE ERR
RES=()
SAMP=
T0=$(date +%s)

cleanup() {
  [ -n "$SAMP" ] && kill "$SAMP" 2>/dev/null
  for s in "$CMDIR"/*; do [ -S "$s" ] && ssh -O exit -o ControlPath="$s" x >/dev/null 2>&1; done
  [ -f "$KEY" ] && shred -u "$KEY" 2>/dev/null
  rm -rf "$WORK" "$CMDIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ -z "$LOCAL" ]; then
  [ -n "${GITLAB_QM_READONLY_SSH_KEY_B64:-}" ] || { echo "FAIL key env GITLAB_QM_READONLY_SSH_KEY_B64 is empty"; exit 2; }
  printf '%s' "$GITLAB_QM_READONLY_SSH_KEY_B64" | base64 -d > "$KEY" 2>/dev/null || { echo "FAIL key is not valid base64"; exit 2; }
  unset GITLAB_QM_READONLY_SSH_KEY_B64
  chmod 600 "$KEY"
  [ -n "$(tail -c1 "$KEY")" ] && echo >> "$KEY"
  ssh-keygen -y -f "$KEY" >/dev/null 2>&1 || { echo "FAIL key is not usable (format or passphrase)"; exit 2; }
fi

SSH_BASE="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR"
SSH_PLAIN="$SSH_BASE -o ControlMaster=no -o ControlPath=none"
SSH_CM="$SSH_BASE -o ControlMaster=auto -o ControlPath=$CMDIR/%C -o ControlPersist=120"
setmode() { if [ "$1" = cm ]; then export GIT_SSH_COMMAND="$SSH_CM"; else export GIT_SSH_COMMAND="$SSH_PLAIN"; fi; }
setmode plain

now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
kb() { du -sk "$1" 2>/dev/null | cut -f1; }
G() { timeout -k 10 "$STEP_T" git "$@"; }
url() { printf '%s/%s.git' "$BASE" "$1"; }
pass() { RES+=("PASS  $1  $2"); echo "PASS  $1  $2"; }
info() { RES+=("INFO  $1  $2"); echo "INFO  $1  $2"; }
fail() { RES+=("FAIL  $1  $2"); echo "FAIL  $1  $2"; tail -n 3 "$ERR" | cut -c1-200 | sed 's/^/        err: /'; }

echo 0 > "$WORK/.pd"; echo 0 > "$WORK/.pda"; echo 0 > "$WORK/.pr"
sampler() {
  local k m
  while :; do
    k=$(du -sk "$WORK" 2>/dev/null | cut -f1); k=${k:-0}
    [ "$k" -gt "$(cat "$WORK/.pd" 2>/dev/null || echo 0)" ] && echo "$k" > "$WORK/.pd"
    [ "$k" -gt "$(cat "$WORK/.pda" 2>/dev/null || echo 0)" ] && echo "$k" > "$WORK/.pda"
    m=$(ps -eo rss=,args= | awk '$2 ~ /(^|\/)(git|ssh|git-remote-[a-z]+)$/ && $0 !~ /pack-objects|upload-pack/ {s+=$1} END{print s+0}')
    [ "$m" -gt "$(cat "$WORK/.pr" 2>/dev/null || echo 0)" ] && echo "$m" > "$WORK/.pr"
    sleep 0.3
  done
}
sampler & SAMP=$!
peak_reset() { echo 0 > "$WORK/.pd"; echo 0 > "$WORK/.pr"; }
peak_disk_mb() { echo $(( $(cat "$WORK/.pd") / 1024 )); }
peak_rss_mb() { echo $(( $(cat "$WORK/.pr") / 1024 )); }

clone_bare() {
  local s; s=$(now)
  G clone -q --bare --filter=blob:none "$(url "$1")" "$WORK/repos/$1.git" 2>>"$ERR" || return 1
  CLONE_SECS=$(el "$s" "$(now)")
}
blobs() { git -C "$WORK/repos/$1.git" ls-tree -r HEAD 2>>"$ERR" | awk -F'\t' '{split($1,a," "); if (a[2]=="blob") print a[3] "\t" $2}'; }
pickblobs() {
  local re='\.(md|txt|json|lua|xml|csv|ya?ml|cs|ts|js|py|cpp|h|c|cc|java|go|sh|proto|ini|cfg)$'
  { blobs "$1" | grep -Ei "$re"; blobs "$1" | grep -viE '\.(xlsx|xls)$'; } | awk -F'\t' '!s[$1]++' | head -n "$2"
}
new_tmp_repo() {
  local t; t=$(mktemp -d "$WORK/t.XXXXXX")
  git init -q --bare "$t" && echo "$1/objects" > "$t/objects/info/alternates"
  git -C "$t" config remote.origin.url "$2"
  git -C "$t" config remote.origin.promisor true
  git -C "$t" config fetch.unpackLimit 1
  git -C "$t" config transfer.unpackLimit 1
  echo "$t"
}
fetch_blob() {
  local bare=$1 u=$2 t s rc o sz; shift 2
  t=$(new_tmp_repo "$bare" "$u")
  s=$(now)
  G -C "$t" fetch -q --no-tags --no-write-fetch-head origin "$@" 2>>"$ERR"; rc=$?
  FB_SECS=$(el "$s" "$(now)"); FB_SIZE=0
  if [ $rc -eq 0 ]; then
    for o in "$@"; do
      sz=$(git -C "$t" cat-file -s "$o" 2>/dev/null) || { rc=3; break; }
      FB_SIZE=$((FB_SIZE + sz))
      git -C "$t" cat-file blob "$o" 2>>"$ERR" | cat > /dev/null
    done
  fi
  rm -rf "$t"; return $rc
}
fetch_big() {
  local bare=$1 u=$2 oid=$3 t s pid
  t=$(new_tmp_repo "$bare" "$u")
  s=$(now); BIG_EXCEEDED=0
  setsid timeout -k 10 "$STEP_T" git -C "$t" fetch -q --no-tags --no-write-fetch-head origin "$oid" 2>>"$ERR" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(du -sm "$t" | cut -f1)" -gt "$CAP_MB" ]; then BIG_EXCEEDED=1; kill -TERM -- "-$pid" 2>/dev/null; break; fi
    sleep 1
  done
  wait "$pid"; BIG_RC=$?
  BIG_SECS=$(el "$s" "$(now)")
  BIG_SIZE_MB=$(( $(git -C "$t" cat-file -s "$oid" 2>/dev/null || echo 0) / 1048576 ))
  rm -rf "$t"
}
stats() { sort -n | awk '{a[NR]=$1; s+=$1} END{if(NR==0){print "NA NA NA"; exit} i=int(NR*0.9); if(i<1)i=1; printf "%.2f %.2f %.2f", a[int((NR+1)/2)], a[i], s/NR}'; }

finish() {
  local p f
  p=$(printf '%s\n' "${RES[@]}" | grep -c '^PASS'); f=$(printf '%s\n' "${RES[@]}" | grep -c '^FAIL')
  echo; echo "===== SUMMARY ====="
  printf '%s\n' "${RES[@]}"
  echo "pass=$p fail=$f peak_disk_total_mb=$(( $(cat "$WORK/.pda") / 1024 )) elapsed_s=$(( $(date +%s) - T0 ))"
  [ "$f" -eq 0 ] && exit 0 || exit 1
}

step0() {
  local R=jenkinstasks line oid b a
  clone_bare $R || { fail S0 "cannot clone $R"; finish; }
  info S0 "blobless clone $R: ${CLONE_SECS}s, $(kb "$WORK/repos/$R.git")KB"
  [ -f "$KH" ] && info S0 "host key seen (compare with the server): $(ssh-keygen -lf "$KH" 2>/dev/null | awk '{print $2, $4}' | head -n1)"
  line=$(blobs $R | head -n1); oid=${line%%$'\t'*}
  [ -n "$oid" ] || { fail S0 "no blob found in $R"; finish; }
  b=$(kb "$WORK/repos/$R.git")
  if fetch_blob "$WORK/repos/$R.git" "$(url $R)" "$oid" && [ "$FB_SIZE" -gt 0 ]; then
    a=$(kb "$WORK/repos/$R.git")
    pass S0 "single blob by object id works (allowAnySHA1InWant): ${FB_SIZE}B in ${FB_SECS}s, bare growth $((a-b))KB"
  else
    fail S0 "single blob by object id NOT possible; stopping, the whole fetch plan needs another route"; finish
  fi
}

step1() {
  local R=$TEXTREPO bare list n i oid b a ok=0 bad=0 pf cmf first cmn
  clone_bare $R || { fail S1 "cannot clone $R"; return; }
  bare=$WORK/repos/$R.git; list=$WORK/list; pickblobs $R 103 > "$list"; n=$(wc -l < "$list")
  info S1 "$R blobless clone: ${CLONE_SECS}s, $(kb "$bare")KB, blobs picked: $n"
  [ "$n" -ge 5 ] || { fail S1 "too few blobs ($n)"; return; }
  b=$(kb "$bare"); pf=$WORK/plain.t; cmf=$WORK/cm.t; : > "$pf"; : > "$cmf"; i=0
  while IFS=$'\t' read -r oid _; do
    i=$((i+1))
    if [ $i -le 3 ]; then setmode plain; else setmode cm; fi
    if fetch_blob "$bare" "$(url $R)" "$oid"; then ok=$((ok+1)); else bad=$((bad+1)); fi
    if [ $i -le 3 ]; then echo "$FB_SECS" >> "$pf"; else echo "$FB_SECS" >> "$cmf"; fi
  done < "$list"
  a=$(kb "$bare")
  read -r _ _ avg <<< "$(stats < "$pf")"
  first=$(head -n1 "$cmf"); read -r med p90 _ <<< "$(tail -n +2 "$cmf" | stats)"
  info S3a "cold single-blob read, new SSH connection each time: avg ${avg}s (n=3); with ControlMaster: first ${first}s, later median ${med}s p90 ${p90}s (n=$((ok-4)))"
  if [ "$bad" -eq 0 ] && [ $((a-b)) -lt 1024 ]; then pass S1 "$ok distinct blobs fetched via temp GIT_DIR, bare growth $((a-b))KB (limit 1024KB)"
  else fail S1 "fetched=$ok failed=$bad bare growth $((a-b))KB (limit 1024KB)"; fi
  setmode plain
}

report_big() {
  local label=$1 st
  if [ "$BIG_EXCEEDED" -eq 1 ]; then st="stopped at cap ${CAP_MB}MB (file is larger)"; else st="size ${BIG_SIZE_MB}MB"; fi
  local rss; rss=$(peak_rss_mb)
  if [ "$BIG_RC" -ne 0 ] && [ "$BIG_EXCEEDED" -eq 0 ]; then fail "$label" "fetch failed rc=$BIG_RC"; return; fi
  if [ "$rss" -lt "$RSS_LIM_MB" ]; then
    pass "$label" "$st in ${BIG_SECS}s, client-side peak RSS ${rss}MB (limit ${RSS_LIM_MB}MB), disk peak ${PD}MB"
  else fail "$label" "$st in ${BIG_SECS}s, client-side peak RSS ${rss}MB over limit ${RSS_LIM_MB}MB, disk peak ${PD}MB"; fi
}

step2() {
  local d oid ext line n=0
  if [ "$SYNTH_MB" -gt 0 ]; then
    d=$WORK/synth; mkdir -p "$d/src"; git init -q "$d/src"
    git -C "$d/src" config uploadpack.allowFilter true; git -C "$d/src" config uploadpack.allowAnySHA1InWant true
    head -c $((SYNTH_MB*1024*1024)) /dev/urandom > "$d/src/big.bin"
    git -C "$d/src" add big.bin && git -C "$d/src" -c user.email=a@b -c user.name=a commit -qm s
    git clone -q --bare --filter=blob:none "file://$d/src" "$d/bare.git"
    oid=$(git -C "$d/src" rev-parse HEAD:big.bin)
    peak_reset; fetch_big "$d/bare.git" "file://$d/src" "$oid"; PD=$(peak_disk_mb)
    report_big "S2a-synthetic-${SYNTH_MB}MB-local"
    rm -rf "$d"
  fi
  clone_bare zq-ui || { fail S2b "cannot clone zq-ui"; return; }
  info S2b "zq-ui blobless clone: ${CLONE_SECS}s, $(kb "$WORK/repos/zq-ui.git")KB"
  for ext in zip 7z rar bundle unity3d mp4 mov psd fbx wav bin pak tga tif apk; do
    blobs zq-ui | awk -F'\t' -v e="[.]$ext\$" 'tolower($2) ~ e {print; exit}'
  done | awk -F'\t' '!s[$1]++' | head -n "$NCAND" > "$WORK/cand"
  [ -s "$WORK/cand" ] || blobs zq-ui | shuf -n 3 > "$WORK/cand"
  [ -s "$WORK/cand" ] || { info S2b "no candidate files in zq-ui"; return; }
  setmode cm
  while IFS=$'\t' read -r oid line; do
    n=$((n+1)); ext=${line##*.}
    peak_reset; fetch_big "$WORK/repos/zq-ui.git" "$(url zq-ui)" "$oid"; PD=$(peak_disk_mb)
    report_big "S2b-zq-ui-candidate$n-.${ext}"
  done < "$WORK/cand"
  setmode plain
}

lsr() { timeout 60 env GIT_SSH_COMMAND="$1" git ls-remote "$(url "$2")" >/dev/null 2>>"$ERR"; echo "$?"; }
export -f lsr url
round() {
  local P=$1 mode=$2 s bad cmd; if [ "$mode" = cm ]; then cmd=$SSH_CM; else cmd=$SSH_PLAIN; fi
  s=$(now)
  bad=$(printf '%s\n' $REPOS | xargs -P "$P" -I{} bash -c 'lsr "$0" "$1"' "$cmd" {} | grep -vc '^0$')
  ROUND_SECS=$(el "$s" "$(now)"); ROUND_BAD=${bad:-0}
}
step3() {
  local P out="" total=0 safe=0 i
  for P in 1 2 4 7; do
    round $P plain; out="$out P=$P:${ROUND_SECS}s/fail$ROUND_BAD"; total=$((total+ROUND_BAD)); [ "$ROUND_BAD" -eq 0 ] && safe=$P
  done
  round 7 cm; out="$out | P=7+ControlMaster:${ROUND_SECS}s/fail$ROUND_BAD"; total=$((total+ROUND_BAD))
  local burst=0 bs; bs=$(now)
  for i in 1 2 3 4 5; do round 7 plain; burst=$((burst+ROUND_BAD)); done
  out="$out | burst 5x7 connections: $(el "$bs" "$(now)")s/fail$burst"; total=$((total+burst))
  if [ "$total" -eq 0 ]; then pass S3b "ls-remote x7 repos, no failures: $out"; else fail S3b "failures seen, largest clean parallelism=$safe: $out"; fi
}

step4() {
  local r o rc n readable=0 tried=0 greet
  if [ -n "$LOCAL" ]; then info S4 "skipped in local mode"; return; fi
  greet=$(timeout 30 $SSH_PLAIN "git@$HOST" 2>&1 | head -n1 | cut -c1-120); info S4 "ssh identity line: $greet"
  for r in $REPOS; do
    o=$(timeout 60 git ls-remote "$(url $r)" 2>>"$ERR"); rc=$?
    n=$(printf '%s' "$o" | grep -c .)
    [ $rc -eq 0 ] && info S4 "whitelisted $r readable, refs=$n" || fail S4 "whitelisted $r NOT readable"
  done
  for r in $EXTRA "$GROUP/zz-spike-nonexistent-$RANDOM"; do
    tried=$((tried+1))
    o=$(timeout 60 git ls-remote "git@$HOST:$r.git" 2>>"$ERR"); rc=$?
    if [ $rc -eq 0 ]; then readable=$((readable+1)); info S4 "NOT whitelisted $r READABLE, refs=$(printf '%s' "$o" | grep -c .)"
    else info S4 "NOT whitelisted $r not readable (no access or does not exist)"; fi
  done
  info S4 "non-whitelisted paths tried=$tried readable=$readable (the last one is a nonexistent control and must be 0)"
}

objcount() { git -C "$1" count-objects -v | awk '/^(count|in-pack):/{n+=$2} /^(size|size-pack):/{k+=$2} END{print n, k}'; }
step5() {
  local R=$TEXTREPO bare=$WORK/repos/$TEXTREPO.git list=$WORK/list n i oids=() j=0 s rc ok=0
  [ -s "$list" ] || { info S5 "no list from S1, skipping"; return; }
  setmode cm
  while IFS=$'\t' read -r oid _; do oids+=("$oid"); [ ${#oids[@]} -ge 20 ] && break; done < "$list"
  if fetch_blob "$bare" "$(url $R)" "${oids[@]}"; then
    info S5b "batch: ${#oids[@]} blobs in ONE fetch: ${FB_SECS}s (${FB_SIZE}B); compare with ${#oids[@]} x single-fetch median in S3a"
  else fail S5b "batch fetch failed"; fi
  local pids=()
  for i in 1 2 3 4; do
    ( fetch_blob "$bare" "$(url $R)" "${oids[$i]}"; echo $? > "$WORK/par.$i" ) &
    pids+=($!)
  done
  wait "${pids[@]}"
  for i in 1 2 3 4; do [ "$(cat "$WORK/par.$i" 2>/dev/null)" = 0 ] && ok=$((ok+1)); done
  [ "$ok" -eq 4 ] && pass S5d "4 parallel fetches through one ControlMaster all succeeded" || fail S5d "parallel fetches ok=$ok of 4"

  local best="" bestc=0 c p cnt=0 before after t trace
  while IFS=$'\t' read -r _ p; do
    cnt=$((cnt+1)); [ $cnt -gt 20 ] && break
    c=$(git -C "$bare" log --oneline -- "$p" 2>>"$ERR" | wc -l)
    [ "$c" -le 300 ] && [ "$c" -gt "$bestc" ] && { bestc=$c; best=$p; }
  done < "$list"
  if [ -n "$best" ]; then
    cp -a "$bare" "$WORK/blame.git"; before=$(objcount "$WORK/blame.git"); trace=$WORK/trace; : > "$trace"
    s=$(now); GIT_TRACE="$trace" G -C "$WORK/blame.git" blame -L 1,40 HEAD -- "$best" >/dev/null 2>>"$ERR"; rc=$?
    after=$(objcount "$WORK/blame.git")
    info S5c "blame 40 lines of a file with $bestc commits: rc=$rc ${s:+$(el "$s" "$(now)")}s, objects ${before% *}->${after% *}, size KB ${before#* }->${after#* }, lazy fetch runs=$(grep -c 'run_command:.*fetch' "$trace")"
    rm -rf "$WORK/blame.git"
  else info S5c "no suitable file for blame"; fi

  trig() {
    local label=$1 repo=$2; shift 2
    local d=$WORK/trg.git b a
    rm -rf "$d"; cp -a "$WORK/repos/$repo.git" "$d"; b=$(objcount "$d")
    G -C "$d" "$@" >/dev/null 2>>"$ERR"
    a=$(objcount "$d")
    if [ "$a" = "$b" ]; then info S5e "$label: no blob download"; else info S5e "$label: DOWNLOADS blobs, objects ${b% *}->${a% *}, KB ${b#* }->${a#* }"; fi
    rm -rf "$d"
  }
  trig "jenkinstasks ls-tree -r HEAD" jenkinstasks ls-tree -r HEAD
  trig "jenkinstasks ls-tree -r -l HEAD" jenkinstasks ls-tree -r -l HEAD
  trig "jenkinstasks log --stat -n 5" jenkinstasks log --stat -n 5
  trig "jenkinstasks log -p -n 2" jenkinstasks log -p -n 2
  trig "jenkinstasks log -n 20 --name-status" jenkinstasks log -n 20 --name-status
  [ -d "$WORK/repos/gameconfig.git" ] || clone_bare gameconfig && {
    info S5f "gameconfig blobless clone: ${CLONE_SECS:-NA}s, $(kb "$WORK/repos/gameconfig.git")KB"
    trig "gameconfig ls-tree -r HEAD" gameconfig ls-tree -r HEAD
    trig "gameconfig log -n 50 --name-status" gameconfig log -n 50 --name-status
  }
  setmode plain
}

step0
step1
step2
step3
step4
step5
finish
