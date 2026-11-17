#!/usr/bin/env bash
set -u
umask 077
HOST=${GITLAB_HOST:-lab.skyunion.net}
GROUP=${ZQ_SPIKE_GROUP:-ca-programmer-zq}
LOCAL=${ZQ_SPIKE_BASE_URL:-}
if [ -n "$LOCAL" ]; then BASE=$LOCAL; else BASE="git@$HOST:$GROUP"; fi
STEP_T=${ZQ_SPIKE_STEP_TIMEOUT:-900}
[ "$STEP_T" -gt 900 ] && STEP_T=900
FILE_CAP_MB=${ZQ_SPIKE_FILE_CAP_MB:-500}
TOTAL_CAP_MB=${ZQ_SPIKE_TOTAL_CAP_MB:-5120}
DISK_CAP_MB=${ZQ_SPIKE_DISK_CAP_MB:-10240}
PER_REPO=${ZQ_SPIKE_PER_REPO:-3}
RSS_LIM_MB=${ZQ_SPIKE_RSS_LIMIT_MB:-512}
TEXTREPO=${ZQ_SPIKE_TEXT_REPO:-clientcode}
REPOS="client clientcode CommonMessage gameconfig jenkinstasks server zq-ui"
EXTS="zip 7z rar mp4 mov psd fbx bin unity3d bundle pak tga tif wav apk dat xlsx"
FILE_CAP_KB=$((FILE_CAP_MB*1024)); TOTAL_CAP_KB=$((TOTAL_CAP_MB*1024)); DISK_CAP_KB=$((DISK_CAP_MB*1024))

WORK=$(mktemp -d /tmp/zqspike2.XXXXXX) || exit 2
CMDIR=$(mktemp -d /tmp/zqcm2.XXXXXX) || exit 2
KEY=$WORK/key
KH=$WORK/known_hosts
ERR=$WORK/err.log
: > "$ERR"
mkdir -p "$WORK/home" "$WORK/repos"
export HOME=$WORK/home GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
export BASE ERR
RES=()
SAMP=
STOPPED=
T0=$(date +%s)

cleanup() {
  [ -n "$SAMP" ] && kill "$SAMP" 2>/dev/null
  kill $(jobs -p) 2>/dev/null
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
clean() { tr -d '\000-\037' | cut -c1-160; }

echo 0 > "$WORK/.pd"; echo 0 > "$WORK/.pda"; echo 0 > "$WORK/.pr"; : > "$WORK/.dl"
dltotal_kb() { awk '{s+=$1} END{print s+0}' "$WORK/.dl"; }
sampler() {
  local k m
  while :; do
    k=$(du -sk "$WORK" 2>/dev/null | cut -f1); k=${k:-0}
    [ "$k" -gt "$(cat "$WORK/.pd" 2>/dev/null || echo 0)" ] && echo "$k" > "$WORK/.pd"
    [ "$k" -gt "$(cat "$WORK/.pda" 2>/dev/null || echo 0)" ] && echo "$k" > "$WORK/.pda"
    [ "$k" -gt "$DISK_CAP_KB" ] && echo disk > "$WORK/.stop"
    m=$(ps -eo rss=,args= | awk '$2 ~ /(^|\/)(git|ssh|git-remote-[a-z]+)$/ && $0 !~ /pack-objects|upload-pack/ {s+=$1} END{print s+0}')
    [ "$m" -gt "$(cat "$WORK/.pr" 2>/dev/null || echo 0)" ] && echo "$m" > "$WORK/.pr"
    sleep 0.3
  done
}
sampler & SAMP=$!
peak_reset() { echo 0 > "$WORK/.pd"; echo 0 > "$WORK/.pr"; }
peak_disk_mb() { echo $(( $(cat "$WORK/.pd") / 1024 )); }
peak_rss_mb() { echo $(( $(cat "$WORK/.pr") / 1024 )); }

halted() {
  if [ -z "$STOPPED" ]; then
    if [ -f "$WORK/.stop" ]; then
      STOPPED=1; fail CAP "disk cap ${DISK_CAP_MB}MB exceeded (peak $(( $(cat "$WORK/.pda") / 1024 ))MB); run stopped"
    elif [ "$(dltotal_kb)" -gt "$TOTAL_CAP_KB" ]; then
      STOPPED=1; fail CAP "cumulative download cap ${TOTAL_CAP_MB}MB exceeded ($(( $(dltotal_kb) / 1024 ))MB); run stopped"
    fi
  fi
  [ -n "$STOPPED" ]
}

clone_bare() {
  local s; s=$(now)
  G clone -q --bare --filter=blob:none "$(url "$1")" "$WORK/repos/$1.git" 2>>"$ERR" || return 1
  CLONE_SECS=$(el "$s" "$(now)")
  kb "$WORK/repos/$1.git" >> "$WORK/.dl"
}
bare() { echo "$WORK/repos/$1.git"; }
lsz() { git -C "$(bare "$1")" -c core.quotepath=false ls-tree -r -z HEAD 2>>"$ERR" > "$WORK/ls.$1"; }
blobs() { tr '\0' '\n' < "$WORK/ls.$1" | awk -F'\t' 'NF>=2 {split($1,a," "); if (a[2]=="blob") print a[3] "\t" substr($0, index($0,"\t")+1)}'; }
objcount() { git -C "$1" count-objects -v | awk '/^(count|in-pack):/{n+=$2} /^(size|size-pack):/{k+=$2} END{print n+0, k+0}'; }
new_tmp_repo() {
  local t; t=$(mktemp -d "$WORK/t.XXXXXX")
  git init -q --bare "$t" && echo "$1/objects" > "$t/objects/info/alternates"
  git -C "$t" config remote.origin.url "$2"
  git -C "$t" config remote.origin.promisor true
  git -C "$t" config fetch.unpackLimit 1
  git -C "$t" config transfer.unpackLimit 1
  echo "$t"
}
fetch_into() {
  local bare=$1 u=$2 s pid k; shift 2
  FG_T=$(new_tmp_repo "$bare" "$u"); FG_EXC=0
  s=$(now)
  setsid timeout -k 10 "$STEP_T" git -C "$FG_T" fetch -q --no-tags --no-write-fetch-head origin "$@" 2>>"$ERR" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    k=$(kb "$FG_T"); k=${k:-0}
    if [ "$k" -gt "$FILE_CAP_KB" ] || [ $(( $(dltotal_kb) + k )) -gt "$TOTAL_CAP_KB" ] || [ -f "$WORK/.stop" ]; then
      [ "$k" -gt "$FILE_CAP_KB" ] && FG_EXC=1 || FG_EXC=2
      kill -TERM -- "-$pid" 2>/dev/null; break
    fi
    sleep 0.5
  done
  wait "$pid"; FG_RC=$?
  FG_SECS=$(el "$s" "$(now)")
  FG_KB=$(kb "$FG_T"); echo "${FG_KB:-0}" >> "$WORK/.dl"
}
have_all() { local o; for o in "$@"; do git -C "$FG_T" cat-file -e "$o" 2>/dev/null || return 1; done; }

V1() {
  local R oid line path ext n szb mb mbps rss pd tag
  LARGEST_B=0; LARGEST_D="none"
  for R in $REPOS; do
    halted && return
    clone_bare "$R" || { fail V1 "$R: cannot clone"; continue; }
    lsz "$R"
    info V1 "$R: blobless clone ${CLONE_SECS}s, $(kb "$(bare "$R")")KB, blobs in HEAD: $(blobs "$R" | wc -l)"
    blobs "$R" | awk -F'\t' -v n="$PER_REPO" -v exts="$EXTS" '
      BEGIN{ne=split(exts,E," ")}
      {p=tolower($2); for(i=1;i<=ne;i++) if (p ~ ("[.]" E[i] "$")) {m++; rk[m]=i; ln[m]=$0; d=$2; sub(/[^\/]*$/,"",d); dr[m]=d; break}}
      END{for(lv=1;lv<=3&&c<n;lv++) for(r=1;r<=ne&&c<n;r++) for(k=1;k<=m&&c<n;k++) if(rk[k]==r && !dn[k]) {
        if(lv==1 && ((dr[k] in ud) || (r in ur))) continue
        if(lv==2 && (dr[k] in ud)) continue
        dn[k]=1; ud[dr[k]]=1; ur[r]=1; c++; print ln[k]}}' > "$WORK/cand.$R"
    n=0
    if [ ! -s "$WORK/cand.$R" ]; then info V1 "$R: no candidate with the listed extensions"; continue; fi
    setmode cm
    while IFS=$'\t' read -r oid path; do
      halted && break
      n=$((n+1)); ext=${path##*.}; tag="V1 $R #$n .$ext"
      peak_reset; fetch_into "$(bare "$R")" "$(url "$R")" "$oid"
      pd=$(peak_disk_mb); rss=$(peak_rss_mb)
      if [ "$FG_EXC" -eq 1 ]; then
        info V1 "$R #$n .$ext: file is LARGER than the ${FILE_CAP_MB}MB protection cap; aborted after ${FG_SECS}s, disk peak ${pd}MB"
        [ $(( FILE_CAP_MB * 1048576 )) -gt "$LARGEST_B" ] && { LARGEST_B=$(( FILE_CAP_MB * 1048576 )); LARGEST_D="$R .$ext (> ${FILE_CAP_MB}MB, aborted) $(printf '%s' "$path" | clean)"; }
      elif [ "$FG_EXC" -eq 2 ]; then
        info V1 "$R #$n .$ext: aborted, cumulative or disk cap reached"
      elif [ "$FG_RC" -ne 0 ] || ! have_all "$oid"; then
        fail V1 "$R #$n .$ext: fetch failed rc=$FG_RC"
      else
        szb=$(git -C "$FG_T" cat-file -s "$oid" 2>/dev/null || echo 0)
        mb=$(awk -v b="$szb" 'BEGIN{printf "%.2f", b/1048576}')
        mbps=$(awk -v b="$szb" -v s="$FG_SECS" 'BEGIN{printf "%.2f", (s>0)? b/1048576/s : 0}')
        [ "$szb" -gt "$LARGEST_B" ] && { LARGEST_B=$szb; LARGEST_D="$R .$ext ${mb}MB $(printf '%s' "$path" | clean)"; }
        if [ "$rss" -lt "$RSS_LIM_MB" ]; then
          pass V1 "$R #$n .$ext: ${mb}MB in ${FG_SECS}s = ${mbps}MB/s, client peak RSS ${rss}MB (limit ${RSS_LIM_MB}MB), disk peak ${pd}MB"
        else
          fail V1 "$R #$n .$ext: ${mb}MB in ${FG_SECS}s = ${mbps}MB/s, client peak RSS ${rss}MB over limit ${RSS_LIM_MB}MB, disk peak ${pd}MB"
        fi
      fi
      rm -rf "$FG_T"
    done < "$WORK/cand.$R"
    setmode plain
  done
  info V1 "largest real file found: $LARGEST_D"
}

V2() {
  local R=jenkinstasks f=$WORK/trace.v2 yes
  halted && return
  GIT_TRACE_PACKET="$f" G -c protocol.version=2 ls-remote "$(url $R)" >/dev/null 2>>"$ERR"
  if grep -qi 'object-info' "$f" 2>/dev/null; then yes=yes; else yes=no; fi
  rm -f "$f"
  info V2 "object-info capability advertised by server: $yes"
}

V3() {
  local R=jenkinstasks d=$WORK/repos/v3.git b a rc m=0 bad=0 miss oid has1
  halted && return
  G clone -q --bare --filter=blob:none "$(url $R)" "$d" 2>>"$ERR" || { fail V3 "cannot clone $R"; return; }
  kb "$d" >> "$WORK/.dl"
  info V3 "fresh blobless $R: objects/KB $(objcount "$d")"
  oid=$(git -C "$d" ls-tree -r HEAD 2>>"$ERR" | awk '$2=="blob"{print $3; exit}')
  git -C "$d" rev-parse -q --verify HEAD~1 >/dev/null 2>&1 && has1=1 || has1=0
  v3case() {
    local label=$1 want=$2; shift 2
    b=$(objcount "$d")
    GIT_NO_LAZY_FETCH=1 timeout -k 10 120 git -C "$d" "$@" >/dev/null 2>>"$ERR"; rc=$?
    a=$(objcount "$d")
    if [ "$want" = any ]; then
      if [ "$a" = "$b" ]; then info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, no download (rc 0 means sizes are answered locally, rc!=0 means refused)"
      else bad=$((bad+1)); info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, UNEXPECTED growth with GIT_NO_LAZY_FETCH=1"; fi
    elif [ "$want" = fail ]; then
      if [ $rc -ne 0 ] && [ "$a" = "$b" ]; then info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, refused without download (as expected)"
      else bad=$((bad+1)); info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, UNEXPECTED (wanted failure without growth)"; fi
    else
      if [ $rc -eq 0 ] && [ "$a" = "$b" ]; then info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, works without download (as expected)"
      else bad=$((bad+1)); info V3 "$label: rc=$rc objects/KB ${b} -> ${a}, UNEXPECTED (wanted success without growth)"; fi
    fi
  }
  v3case "cat-file -s <missing blob>" fail cat-file -s "$oid"
  v3case "ls-tree -r -l HEAD" any ls-tree -r -l HEAD
  v3case "log --stat -n 5" fail log --stat -n 5
  v3case "log -p -n 2" fail log -p -n 2
  if [ "$has1" = 1 ]; then v3case "diff-tree -r -z --raw --no-renames HEAD~1 HEAD" ok diff-tree -r -z --raw --no-renames HEAD~1 HEAD
  else info V3 "diff-tree skipped, repository has one commit"; fi
  v3case "show -s --format=...%x00..." ok show -s --format=%H%x00%an%x00%ae%x00%aI%x00%s HEAD
  v3case "log -n 20 --name-status -z" ok log -n 20 --name-status -z
  if [ "$bad" -eq 0 ]; then pass V3 "NO_LAZY_FETCH: missing-object commands fail cleanly, metadata-only commands succeed, no object growth"
  else fail V3 "NO_LAZY_FETCH: $bad commands behaved unexpectedly"; fi
  rm -rf "$d"
}

pick_text() {
  blobs "$1" | awk -F'\t' 'tolower($2) ~ /[.](md|txt|json|lua|xml|csv|ya?ml|cs|ts|js|py|cpp|h|c|cc|java|go|sh|proto|ini|cfg)$/'
}

V4() {
  local R=$TEXTREPO bare p c best="" bestc=0 head t s rc b a n oids=() cm tr1 tr2 tr3 secs_fetch seen=0
  halted && return
  bare=$(bare "$R")
  [ -d "$bare" ] || { clone_bare "$R" || { fail V4 "cannot clone $R"; return; }; lsz "$R"; }
  while IFS=$'\t' read -r _ p; do
    seen=$((seen+1)); [ $seen -gt 40 ] && break
    c=$(timeout 60 git -C "$bare" log --format=%H -- "$p" 2>>"$ERR" | wc -l)
    [ "$c" -le 300 ] && [ "$c" -gt "$bestc" ] && { bestc=$c; best=$p; }
  done < <(pick_text "$R")
  if [ -z "$best" ] || [ "$bestc" -lt 2 ]; then info V4 "no text file with 2..300 commits among the first 40 candidates"; return; fi
  head=$(git -C "$bare" rev-parse HEAD)
  while read -r cm; do
    o=$(git -C "$bare" rev-parse -q --verify "$cm:$best" 2>/dev/null) && echo "$o"
  done < <(git -C "$bare" log --format=%H -- "$best" 2>>"$ERR") | awk '!s[$0]++' > "$WORK/v4.oids"
  mapfile -t oids < "$WORK/v4.oids"
  setmode cm
  fetch_into "$bare" "$(url "$R")" "${oids[@]}"
  t=$FG_T; secs_fetch=$FG_SECS
  if [ "$FG_EXC" -ne 0 ] || [ "$FG_RC" -ne 0 ] || ! have_all "${oids[@]}"; then
    if [ "$FG_EXC" -eq 1 ]; then info V4 "history blobs of the chosen file are LARGER than the ${FILE_CAP_MB}MB cap; aborted, skipped"
    else fail V4 "batch fetch of ${#oids[@]} history blobs failed rc=$FG_RC"; fi
    rm -rf "$t"; setmode plain; return
  fi
  info V4 "file with $bestc commits: ${#oids[@]} distinct blobs fetched in ONE fetch: ${secs_fetch}s, $(kb "$t")KB"
  git -C "$t" update-ref refs/heads/b "$head"; git -C "$t" symbolic-ref HEAD refs/heads/b
  b=$(objcount "$t")
  s=$(now); GIT_NO_LAZY_FETCH=1 G -C "$t" blame -L 1,40 HEAD -- "$best" >/dev/null 2>>"$ERR"; rc=$?
  a=$(objcount "$t")
  info V4 "blame in prefetched temp repo, GIT_NO_LAZY_FETCH=1: rc=$rc $(el "$s" "$(now)")s, objects/KB ${b} -> ${a}, lazy fetch runs=0 (disabled)"
  [ $rc -eq 0 ] && pass V4 "prefetching the file's historical blobs in one batch is enough for blame (no lazy fetch needed)" || fail V4 "blame needed more objects than the batch provided"
  tr2=$WORK/trace.v4b; : > "$tr2"
  s=$(now); GIT_TRACE="$tr2" G -C "$t" blame -L 1,40 HEAD -- "$best" >/dev/null 2>>"$ERR"; rc=$?
  a=$(objcount "$t")
  info V4 "blame in prefetched temp repo, lazy fetch allowed: rc=$rc $(el "$s" "$(now)")s, objects/KB ${b} -> ${a}, lazy fetch runs=$(grep -c 'run_command:.*fetch' "$tr2")"
  rm -rf "$t"
  cp -a "$bare" "$WORK/blame.git"; b=$(objcount "$WORK/blame.git"); tr3=$WORK/trace.v4c; : > "$tr3"
  s=$(now); GIT_TRACE="$tr3" G -C "$WORK/blame.git" blame -L 1,40 HEAD -- "$best" >/dev/null 2>>"$ERR"; rc=$?
  a=$(objcount "$WORK/blame.git")
  info V4 "plain blame in a copy of the bare clone (v1 S5c style): rc=$rc $(el "$s" "$(now)")s, objects/KB ${b} -> ${a}, lazy fetch runs=$(grep -c 'run_command:.*fetch' "$tr3")"
  rm -rf "$WORK/blame.git"
  setmode plain
}

V5_one() {
  local R=$1 bare c p0 b a nfiles old new t rc s i found=0 raw=$WORK/v5.raw
  bare=$(bare "$R")
  [ -d "$bare" ] || { clone_bare "$R" || { fail V5 "$R: cannot clone"; return; }; lsz "$R"; }
  for c in $(git -C "$bare" rev-list --no-merges --min-parents=1 -n 20 HEAD 2>>"$ERR"); do
    git -C "$bare" diff-tree -r -z --raw --no-renames "$c^" "$c" 2>>"$ERR" | tr '\0' '\n' > "$raw"
    read -r old new < <(awk '/^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ M$/ {split($0,a," "); if (a[1]!=":160000") {print a[3], a[4]; exit}}' "$raw")
    if [ -n "${old:-}" ]; then found=1; break; fi
  done
  if [ $found -eq 0 ]; then info V5 "$R: no recent commit with a modified file"; return; fi
  b=$(objcount "$bare")
  G -C "$bare" diff-tree -r -z --raw --no-renames "$c^" "$c" >/dev/null 2>>"$ERR"; rc=$?
  a=$(objcount "$bare")
  nfiles=$(grep -c '^:[0-7]' "$raw")
  if [ $rc -eq 0 ] && [ "$a" = "$b" ]; then pass V5 "$R: commit file list ($nfiles files) via diff-tree, no blob downloaded, objects/KB ${b} -> ${a}"
  else fail V5 "$R: diff-tree rc=$rc objects/KB ${b} -> ${a}"; fi
  setmode cm
  fetch_into "$bare" "$(url "$R")" "$old" "$new"
  t=$FG_T
  if [ "$FG_EXC" -ne 0 ] || [ "$FG_RC" -ne 0 ] || ! have_all "$old" "$new"; then
    [ "$FG_EXC" -eq 1 ] && info V5 "$R: chosen file is LARGER than the ${FILE_CAP_MB}MB cap, skipped" || fail V5 "$R: old/new blob batch fetch failed rc=$FG_RC"
    rm -rf "$t"; setmode plain; return
  fi
  s=$(now)
  local ns pb
  ns=$(GIT_NO_LAZY_FETCH=1 timeout -k 10 120 git -C "$t" diff --numstat "$old" "$new" 2>>"$ERR"); rc=$?
  pb=$(GIT_NO_LAZY_FETCH=1 timeout -k 10 120 git -C "$t" diff "$old" "$new" 2>>"$ERR" | wc -c)
  if [ $rc -eq 0 ] && [ -n "$ns" ]; then
    pass V5 "$R: old+new blob in one fetch ${FG_SECS}s, numstat '$(printf '%s' "$ns" | awk '{print "+" $1 " -" $2}')', patch ${pb}B, diff step $(el "$s" "$(now)")s, NO_LAZY set"
  else fail V5 "$R: numstat/patch failed rc=$rc"; fi
  rm -rf "$t"; setmode plain
}
V5() { halted && return; V5_one jenkinstasks; halted && return; V5_one clientcode; }

V6() {
  local R n=0 tot ok bad q p oid want
  for R in $REPOS; do
    halted && return
    [ -f "$WORK/ls.$R" ] || { clone_bare "$R" && lsz "$R" || { fail V6 "$R: cannot clone"; continue; }; }
    tot=0; ok=0; bad=0
    while IFS= read -r -d '' rec; do
      case $rec in *$'\t'*) ;; *) continue ;; esac
      p=${rec#*$'\t'}
      case $p in *[!\ -~]*) ;; *) continue ;; esac
      tot=$((tot+1)); [ $tot -gt 200 ] && continue
      want=$(printf '%s' "${rec%%$'\t'*}" | awk '{print $3}')
      oid=$(git -C "$(bare "$R")" rev-parse -q --verify "HEAD:$p" 2>/dev/null)
      [ "$oid" = "$want" ] && ok=$((ok+1)) || bad=$((bad+1))
    done < "$WORK/ls.$R"
    q=$(git -C "$(bare "$R")" -c core.quotepath=true ls-tree -r HEAD 2>/dev/null | grep -c '	"')
    info V6 "$R: non-ASCII paths=$tot, round-trip via -z and core.quotepath=false ok=$ok bad=$bad (first 200 checked), lines git quotes with default config=$q"
    [ "$bad" -gt 0 ] && n=$((n+bad))
  done
  [ "$n" -eq 0 ] && pass V6 "non-ASCII paths round-trip through -z with core.quotepath=false in all repos" || fail V6 "$n non-ASCII paths did not round-trip"
}

par_one() {
  local out=$1 R=$2; shift 2
  fetch_into "$(bare "$R")" "$(url "$R")" "$@"
  if [ "$FG_EXC" -eq 0 ] && [ "$FG_RC" -eq 0 ] && have_all "$@"; then echo 0 > "$out"; else echo 1 > "$out"; fi
  rm -rf "$FG_T"
}
par_run() {
  local label=$1 ns=$2 nb=$3 i s f=0 k
  rm -f "$WORK"/par.*
  s=$(now)
  for i in $(seq 1 "$ns"); do par_one "$WORK/par.s$i" "$TEXTREPO" "${OIDS[$((i-1))]}" & done
  for i in $(seq 1 "$nb"); do
    k=$((6 + (i-1)*20)); par_one "$WORK/par.b$i" "$TEXTREPO" "${OIDS[@]:$k:20}" &
  done
  wait $(jobs -p | grep -v "^$SAMP$")
  PAR_SECS=$(el "$s" "$(now)")
  f=$(cat "$WORK"/par.* 2>/dev/null | grep -vc '^0$')
  PAR_FAIL=$f
  info V7 "$label: wall ${PAR_SECS}s, failures $f of $((ns+nb))"
}
V7() {
  local R=$TEXTREPO bad=0
  halted && return
  [ -f "$WORK/ls.$R" ] || { clone_bare "$R" && lsz "$R" || { fail V7 "cannot clone $R"; return; }; }
  mapfile -t OIDS < <(pick_text "$R" | cut -f1 | awk '!s[$0]++' | head -n 86)
  if [ "${#OIDS[@]}" -lt 86 ]; then info V7 "only ${#OIDS[@]} distinct text blobs in $R, need 86"; return; fi
  setmode cm
  if [ -z "$LOCAL" ]; then
    G ls-remote "$(url "$R")" >/dev/null 2>>"$ERR"
    if ssh -O check -o ControlPath="$CMDIR/$(ls "$CMDIR" | head -n1)" x >/dev/null 2>&1; then info V7 "ControlMaster socket established: yes"; else info V7 "ControlMaster socket established: no"; fi
  else info V7 "ControlMaster check skipped in local mode (no SSH)"; fi
  par_run "6 parallel single-blob fetches" 6 0; bad=$((bad+PAR_FAIL))
  halted && { setmode plain; return; }
  par_run "4 parallel batch fetches of 20 blobs" 0 4; bad=$((bad+PAR_FAIL))
  halted && { setmode plain; return; }
  par_run "6 single + 4 batch simultaneously" 6 4; bad=$((bad+PAR_FAIL))
  [ "$bad" -eq 0 ] && pass V7 "all parallel fetches succeeded through one ControlMaster" || fail V7 "$bad parallel fetches failed"
  setmode plain
}

finish() {
  local p f
  p=$(printf '%s\n' "${RES[@]}" | grep -c '^PASS'); f=$(printf '%s\n' "${RES[@]}" | grep -c '^FAIL')
  echo; echo "===== SUMMARY ====="
  printf '%s\n' "${RES[@]}"
  echo "pass=$p fail=$f downloaded_mb=$(( $(dltotal_kb) / 1024 )) (cap ${TOTAL_CAP_MB}) peak_disk_mb=$(( $(cat "$WORK/.pda") / 1024 )) (cap ${DISK_CAP_MB}) elapsed_s=$(( $(date +%s) - T0 ))"
  [ "$f" -eq 0 ] && exit 0 || exit 1
}

V1
V2
V3
V4
V5
V6
V7
finish
