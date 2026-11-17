#!/usr/bin/env bash
set -u
umask 077
HOST=${GITLAB_HOST:-lab.skyunion.net}
GROUP=${ZQ_SPIKE_GROUP:-ca-programmer-zq}
REPO=${ZQ_PROBE_REPO:-server}
CTRL=${ZQ_PROBE_CONTROL:-jenkinstasks}
LOCAL=${ZQ_SPIKE_BASE_URL:-}
if [ -n "$LOCAL" ]; then BASE=$LOCAL; else BASE="git@$HOST:$GROUP"; fi
STEP_T=${ZQ_PROBE_STEP_TIMEOUT:-300}
[ "$STEP_T" -gt 300 ] && STEP_T=300
FILE_CAP_MB=${ZQ_PROBE_FILE_CAP_MB:-200}
TOTAL_CAP_MB=${ZQ_PROBE_TOTAL_CAP_MB:-1024}
DISK_CAP_MB=${ZQ_PROBE_DISK_CAP_MB:-3072}
SKIP_RETRY_MB=${ZQ_PROBE_SKIP_RETRY_MB:-20}
EXTS="zip 7z rar mp4 mov psd fbx bin unity3d bundle pak tga tif wav apk dat xlsx"
TEXTRE='[.](md|txt|json|lua|xml|csv|ya?ml|cs|ts|js|py|cpp|h|c|cc|java|go|sh|proto|ini|cfg)$'
FILE_CAP_KB=$((FILE_CAP_MB*1024)); TOTAL_CAP_KB=$((TOTAL_CAP_MB*1024)); DISK_CAP_KB=$((DISK_CAP_MB*1024))
SKIP_RETRY_KB=$((SKIP_RETRY_MB*1024))

GV=$(git --version | awk '{print $3}')
IFS=. read -r GMAJ GMIN _ <<<"$GV"
if [ "${GMAJ:-0}" -lt 2 ] || { [ "${GMAJ:-0}" -eq 2 ] && [ "${GMIN:-0}" -lt 44 ]; }; then echo "FAIL git $GV is older than 2.44"; exit 2; fi

WORK=$(mktemp -d /tmp/zqprobe.XXXXXX) || exit 2
CMDIR=$(mktemp -d /tmp/zqprobecm.XXXXXX) || exit 2
KEY=$WORK/key
KH=$WORK/known_hosts
ERR=$WORK/err.log
: > "$ERR"
mkdir -p "$WORK/home" "$WORK/repos"
export HOME=$WORK/home GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
RES=()
SAMP=
STOPPED=
T0=$(date +%s)
declare -A RS RE PRES SIZE LFSP PATHOF MODEOF TYPEOF REPOOF ROLE LOGC ANC ATTR

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
SSH_CM="$SSH_BASE -o ControlMaster=auto -o ControlPath=$CMDIR/%C -o ControlPersist=120"
export GIT_SSH_COMMAND="$SSH_CM"

now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
kb() { du -sk "$1" 2>/dev/null | cut -f1; }
url() { case $BASE in /*) printf 'file://%s/%s.git' "$BASE" "$1" ;; *) printf '%s/%s.git' "$BASE" "$1" ;; esac; }
bare() { echo "$WORK/repos/$1.git"; }
pass() { RES+=("PASS  $1  $2"); echo "PASS  $1  $2"; }
info() { RES+=("INFO  $1  $2"); echo "INFO  $1  $2"; }
fail() { RES+=("FAIL  $1  $2"); echo "FAIL  $1  $2"; }
clean() { tr -d '\000-\037' | cut -c1-160; }
NL() { tr '\0' '\n'; }

echo 0 > "$WORK/.pda"; : > "$WORK/.dl"
dltotal_kb() { awk '{s+=$1} END{print s+0}' "$WORK/.dl"; }
sampler() {
  local k
  while :; do
    k=$(du -sk "$WORK" 2>/dev/null | cut -f1); k=${k:-0}
    [ "$k" -gt "$(cat "$WORK/.pda" 2>/dev/null || echo 0)" ] && echo "$k" > "$WORK/.pda"
    [ "$k" -gt "$DISK_CAP_KB" ] && echo disk > "$WORK/.stop"
    sleep 0.3
  done
}
sampler & SAMP=$!

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

CAPKB=$FILE_CAP_KB
capped() {
  local dir=$1 pid k g base s
  shift
  export CE=$WORK/e.step CW=$WORK/w.step CR=$WORK/r.step
  : > "$CE"; echo 0 > "$CW"; echo 255 > "$CR"
  base=$(kb "$dir"); base=${base:-0}
  CAP_EXC=0; CAP_G=0
  s=$(now)
  setsid bash -c 'timeout -k 10 "$0" "$@" 2>"$CE" | wc -c >"$CW"; echo "${PIPESTATUS[0]}" >"$CR"' "$STEP_T" "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    k=$(kb "$dir"); k=${k:-0}; g=$((k-base))
    if [ "$g" -gt "$CAPKB" ] || [ $(( $(dltotal_kb) + g )) -gt "$TOTAL_CAP_KB" ] || [ -f "$WORK/.stop" ]; then
      [ "$g" -gt "$CAPKB" ] && CAP_EXC=1 || CAP_EXC=2
      kill -TERM -- "-$pid" 2>/dev/null; break
    fi
    sleep 0.5
  done
  wait "$pid" 2>/dev/null
  CAP_SECS=$(el "$s" "$(now)")
  CAP_RC=$(cat "$WORK/r.step" 2>/dev/null || echo 255)
  CAP_OUT=$(cat "$WORK/w.step" 2>/dev/null | tr -d ' ')
  CAP_ERR=$(tail -n1 "$CE" 2>/dev/null | clean); [ -n "$CAP_ERR" ] || CAP_ERR=-
  k=$(kb "$dir"); k=${k:-0}; CAP_G=$((k-base)); [ "$CAP_G" -lt 0 ] && CAP_G=0
  echo "$CAP_G" >> "$WORK/.dl"
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
nolazy() { GIT_NO_LAZY_FETCH=1 timeout -k 10 120 git "$@"; }
o12() { printf '%s' "${1:0:12}"; }
ext_of() { local e=${1##*.}; [ "$e" = "$1" ] && e=none; printf '%s' "${e,,}"; }

clone_bare() {
  CAPKB=$TOTAL_CAP_KB
  capped "$(bare "$1")" git clone -q --bare --filter=blob:none "$(url "$1")" "$(bare "$1")"
  CAPKB=$FILE_CAP_KB
  [ "$CAP_RC" -eq 0 ] && [ "$CAP_EXC" -eq 0 ]
}
lsz() { git -C "$(bare "$1")" -c core.quotepath=false ls-tree -r -z HEAD 2>>"$ERR" > "$WORK/ls.$1"; }
blobs() { NL < "$WORK/ls.$1" | awk -F'\t' 'NF>=2 {split($1,a," "); if (a[2]=="blob") print a[3] "\t" substr($0, index($0,"\t")+1)}'; }
entry_of() { NL < "$WORK/ls.$1" | awk -F'\t' -v o="$2" 'NF>=2 {split($1,a," "); if (a[3]==o) {print a[1], a[2]; exit}}'; }

p1_repo() {
  local R=$1 hist gl oid path m t n=0 exts
  halted && return 1
  if ! clone_bare "$R"; then fail P1 "$R: blobless clone failed rc=$CAP_RC err=\"$CAP_ERR\""; return 1; fi
  lsz "$R"
  info P1 "$R: blobless clone ${CAP_SECS}s, ${CAP_G}KB, git $GV"
  hist=$(NL < "$WORK/ls.$R" | awk -F'\t' 'NF>=2{split($1,a," "); c[a[1]]++; n++; if (a[1]=="160000"||a[2]=="commit") g++}
    END{o=n-c["100644"]-c["100755"]-c["120000"]-c["160000"]; printf "total=%d 100644=%d 100755=%d 120000=%d 160000=%d other=%d", n, c["100644"]+0, c["100755"]+0, c["120000"]+0, c["160000"]+0, o}')
  info P1 "$R: HEAD mode histogram $hist"
  gl=$(NL < "$WORK/ls.$R" | awk -F'\t' 'NF>=2{split($1,a," "); if (a[1]=="160000"||a[2]=="commit") c++} END{print c+0}')
  if [ "$gl" -eq 0 ]; then pass P1 "$R: no gitlink (mode 160000 / type commit) among listed oids"
  else
    fail P1 "$R: $gl gitlink entries (mode 160000 / type commit) among listed oids"
    NL < "$WORK/ls.$R" | awk -F'\t' 'NF>=2{split($1,a," "); if (a[1]=="160000"||a[2]=="commit") print a[3] "\t" substr($0, index($0,"\t")+1)}' | head -n 3 |
      while IFS=$'\t' read -r oid path; do info P1 "$R: gitlink $(o12 "$oid") path=$(printf '%s' "$path" | clean)"; done
  fi
  exts=$(blobs "$R" | awk -F'\t' -v exts="$EXTS" 'BEGIN{ne=split(exts,E," ")} {p=tolower($2); for(i=1;i<=ne;i++) if (p ~ ("[.]" E[i] "$")) {c[E[i]]++; break}} END{for(i=1;i<=ne;i++) if (c[E[i]]) printf "%s=%d ", E[i], c[E[i]]}')
  info P1 "$R: candidate extensions present: ${exts:-none}"
  blobs "$R" | awk -F'\t' -v n=3 -v exts="$EXTS" '
    BEGIN{ne=split(exts,E," ")}
    {p=tolower($2); for(i=1;i<=ne;i++) if (p ~ ("[.]" E[i] "$")) {m++; rk[m]=i; ln[m]=$0; d=$2; sub(/[^\/]*$/,"",d); dr[m]=d; break}}
    END{for(lv=1;lv<=3&&c<n;lv++) for(r=1;r<=ne&&c<n;r++) for(k=1;k<=m&&c<n;k++) if(rk[k]==r && !dn[k]) {
      if(lv==1 && ((dr[k] in ud) || (r in ur))) continue
      if(lv==2 && (dr[k] in ud)) continue
      dn[k]=1; ud[dr[k]]=1; ur[r]=1; c++; print ln[k]}}' > "$WORK/cand.$R"
  blobs "$R" | awk -F'\t' -v re="$TEXTRE" 'tolower($2) ~ re' | shuf | head -n 40 > "$WORK/text.$R"
  : > "$WORK/pick.$R"
  while IFS=$'\t' read -r oid path; do
    n=$((n+1)); read -r m t <<<"$(entry_of "$R" "$oid")"
    MODEOF[$oid]=$m; TYPEOF[$oid]=$t; PATHOF[$oid]=$path; REPOOF[$oid]=$R
    printf 'v2pick\t%s\t%s\n' "$oid" "$path" >> "$WORK/pick.$R"
    info P1 "$R: v2 candidate #$n mode=$m type=$t oid=$(o12 "$oid") ext=.$(ext_of "$path")"
  done < "$WORK/cand.$R"
  [ "$n" -gt 0 ] || info P1 "$R: no candidate with the listed extensions"
  n=0
  while IFS=$'\t' read -r oid path; do
    [ "$n" -ge 3 ] && break
    grep -q "$oid" "$WORK/pick.$R" && continue
    n=$((n+1)); read -r m t <<<"$(entry_of "$R" "$oid")"
    MODEOF[$oid]=$m; TYPEOF[$oid]=$t; PATHOF[$oid]=$path; REPOOF[$oid]=$R
    printf 'text\t%s\t%s\n' "$oid" "$path" >> "$WORK/pick.$R"
    info P1 "$R: random text file #$n mode=$m type=$t oid=$(o12 "$oid") ext=.$(ext_of "$path")"
  done < "$WORK/text.$R"
}

peek() {
  local d=$1 o=$2 sz fl
  [ -n "${LFSP[$o]:-}" ] && return 0
  sz=$(GIT_NO_LAZY_FETCH=1 git -C "$d" cat-file -s "$o" 2>/dev/null) || return 0
  SIZE[$o]=$sz
  if [ "$sz" -ge 1024 ]; then LFSP[$o]=no; return 0; fi
  fl=$(GIT_NO_LAZY_FETCH=1 git -C "$d" cat-file -p "$o" 2>/dev/null | head -n1 | tr -d '\000-\037' | cut -c1-80)
  case $fl in
    "version https://git-lfs"*) LFSP[$o]=yes; info P4 "$(o12 "$o") small blob (${sz}B) first line: $fl" ;;
    *) LFSP[$o]=no ;;
  esac
}

settle() {
  local m=$1 d=$2 o=$3 lab=$4 how=$5 st
  if [ "$CAP_EXC" -ne 0 ]; then st=cap
  elif [ "$CAP_RC" -ne 0 ]; then st=$CAP_RC
  elif [ "$how" = fetch ] && ! GIT_NO_LAZY_FETCH=1 git -C "$d" cat-file -e "$o" 2>/dev/null; then st=99
  else st=0; fi
  RS["$o.$m"]=$st; RE["$o.$m"]=$CAP_ERR
  local msg="$lab $m: rc=$CAP_RC stdout=${CAP_OUT}B grew=${CAP_G}KB ${CAP_SECS}s err=\"$CAP_ERR\""
  if [ "$st" = 0 ]; then pass P2 "$msg"; peek "$d" "$o"
  elif [ "$st" = cap ]; then info P2 "$msg ABORTED by file/total/disk cap"
  else fail P2 "$msg"; fi
}

p2_one() {
  local R=$1 oid=$2 path=$3 b u T C lab
  b=$(bare "$R"); u=$(url "$R")
  lab="$R $(o12 "$oid") .$(ext_of "$path")"
  halted && return
  T=$(new_tmp_repo "$b" "$u")
  capped "$T" git -C "$T" fetch -q --no-tags --no-write-fetch-head origin "$oid"
  settle v2method "$T" "$oid" "$lab" fetch
  PRES[$oid]=$(printf '%s\n' "$oid" | GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file --batch-check 2>/dev/null | sed 's/^[0-9a-f]* //')
  rm -rf "$T"
  if [ "${RS[$oid.v2method]}" = cap ]; then info P2 "$lab: larger than ${FILE_CAP_MB}MB cap, other methods skipped"; return; fi
  if [ "${RS[$oid.v2method]}" = 0 ] && [ "$CAP_G" -gt "$SKIP_RETRY_KB" ]; then info P2 "$lab: ${CAP_G}KB downloaded, other methods skipped to save download"; return; fi
  halted && return
  local v
  for v in 2 0; do
    T=$(new_tmp_repo "$b" "$u")
    capped "$T" git -c protocol.version=$v -C "$T" fetch -q --no-tags --no-write-fetch-head origin "$oid"
    settle "proto$v" "$T" "$oid" "$lab" fetch
    rm -rf "$T"
    halted && return
  done
  T=$(new_tmp_repo "$b" "$u")
  capped "$T" git -c fetch.negotiationAlgorithm=noop -C "$T" fetch -q --no-tags --no-write-fetch-head origin "$oid"
  settle noop "$T" "$oid" "$lab" fetch
  rm -rf "$T"
  halted && return
  C=$WORK/copy.c; rm -rf "$C"; cp -a "$b" "$C"
  capped "$C" git -C "$C" fetch -q --no-tags --no-write-fetch-head origin "$oid"
  settle direct "$C" "$oid" "$lab" fetch
  rm -rf "$C"
  halted && return
  C=$WORK/copy.d; rm -rf "$C"; cp -a "$b" "$C"
  capped "$C" git -C "$C" cat-file -p "$oid"
  settle lazy "$C" "$oid" "$lab" read
  rm -rf "$C"
}

p2_repo() {
  local R=$1 kind oid path
  info P2 "$R: oids are fetched with v2method (alternates + promisor, unpackLimit=1), proto2, proto0, noop (fetch.negotiationAlgorithm=noop, what lazy promisor fetches use), direct (fetch into a copy of the bare clone), lazy (cat-file -p in a copy)"
  [ -s "$WORK/pick.$R" ] || { info P2 "$R: no oids picked"; return; }
  while IFS=$'\t' read -r kind oid path; do
    halted && return
    p2_one "$R" "$oid" "$path"
  done < "$WORK/pick.$R"
}

FAILING=(); WORKING=(); SUBJ=()
classify() {
  local R oid kind path
  [ -e "$WORK/pick.$REPO" ] || : > "$WORK/pick.$REPO"
  for R in "$REPO" "$CTRL"; do
    [ -s "$WORK/pick.$R" ] || continue
    while IFS=$'\t' read -r kind oid path; do
      [ -n "${RS[$oid.v2method]:-}" ] || continue
      if [ "${RS[$oid.v2method]}" = 0 ]; then
        WORKING+=("$oid"); ROLE[$oid]=working
      elif [ "$R" = "$REPO" ] && [ "${RS[$oid.v2method]}" != cap ]; then
        FAILING+=("$oid"); ROLE[$oid]=failing
      fi
    done < "$WORK/pick.$R"
  done
  if [ "${#FAILING[@]}" -eq 0 ]; then
    info P3 "no failing oid reproduced in $REPO; analysing its v2 candidates anyway"
    while IFS=$'\t' read -r kind oid path; do
      [ "$kind" = v2pick ] && { FAILING+=("$oid"); ROLE[$oid]=not-failing-candidate; }
    done < "$WORK/pick.$REPO"
    REPRODUCED=0
  else REPRODUCED=1; fi
  local w=0
  SUBJ=("${FAILING[@]:0:6}")
  for oid in "${WORKING[@]}"; do
    [ "$w" -ge 3 ] && break
    [ "${ROLE[$oid]}" = working ] && { SUBJ+=("$oid"); w=$((w+1)); }
  done
}

p3() {
  local o R b p d nb rl miss tot in tr
  for o in "${SUBJ[@]}"; do
    halted && return
    R=${REPOOF[$o]}; b=$(bare "$R"); p=${PATHOF[$o]}
    nb=$(printf '%s\n' "$o" | GIT_NO_LAZY_FETCH=1 git -C "$b" cat-file --batch-check 2>/dev/null | sed 's/^[0-9a-f]* //')
    info P3 "${ROLE[$o]} $R $(o12 "$o"): cat-file --batch-check NO_LAZY in blobless bare: ${nb:-error}; in v2method temp repo after fetch: ${PRES[$o]:-n/a}"
    d=${p%/*}; [ "$d" = "$p" ] && d=$p
    rl=$WORK/rl.out
    GIT_NO_LAZY_FETCH=1 timeout -k 10 "$STEP_T" git -C "$b" rev-list --objects --missing=print HEAD -- "$d" > "$rl" 2>>"$ERR"; local rc=$?
    miss=$(grep -c '^?' "$rl"); tot=$(wc -l < "$rl")
    grep -q "^?$o" "$rl" && in=yes || in=no
    info P3 "${ROLE[$o]} $R $(o12 "$o"): rev-list --objects --missing=print HEAD -- <dir>: rc=$rc listed=$tot missing_promisor=$miss this_oid_reported_missing=$in"
    tr=$(git -C "$b" -c core.quotepath=false ls-tree -z HEAD -- "$p" 2>>"$ERR" | NL | tr '\t' ' ' | clean)
    info P3 "${ROLE[$o]} $R $(o12 "$o"): ls-tree HEAD -- <path>: $tr"
  done
}

p4() {
  local o R b p d dirs=() list=() ao T ga ln fa v head
  local -A seen
  halted && return
  R=$REPO; b=$(bare "$R")
  head=$(git -C "$b" rev-parse HEAD 2>/dev/null)
  for o in "${FAILING[@]}"; do
    p=${PATHOF[$o]}; d=$p
    while :; do
      case $d in */*) d=${d%/*}; dirs+=("$d/") ;; *) dirs+=(""); break ;; esac
    done
  done
  for d in "${dirs[@]}"; do
    [ -n "${seen[x$d]:-}" ] && continue; seen[x$d]=1
    ga=$(git -C "$b" ls-tree HEAD -- "${d}.gitattributes" 2>/dev/null | awk '$2=="blob"{print $3; exit}')
    if [ -n "$ga" ]; then list+=("$ga"); info P4 "dir depth $(printf '%s' "$d" | tr -cd / | wc -c) has .gitattributes oid=$(o12 "$ga")"; fi
  done
  if [ "${#list[@]}" -eq 0 ]; then
    info P4 "no .gitattributes at the root or along the failing paths; filter=lfs: no, lfs lines: 0"
  else
    T=$(new_tmp_repo "$b" "$(url "$R")")
    capped "$T" git -c fetch.negotiationAlgorithm=noop -C "$T" fetch -q --no-tags --no-write-fetch-head origin "${list[@]}"
    if [ "$CAP_RC" -ne 0 ]; then fail P4 "fetch of ${#list[@]} .gitattributes blobs failed rc=$CAP_RC err=\"$CAP_ERR\""
    else
      pass P4 "fetched ${#list[@]} .gitattributes blobs in ${CAP_SECS}s, ${CAP_G}KB"
      for ga in "${list[@]}"; do
        ln=$(GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -p "$ga" 2>/dev/null | grep -ci lfs)
        fa=$(GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -p "$ga" 2>/dev/null | grep -c 'filter=lfs')
        info P4 ".gitattributes $(o12 "$ga"): filter=lfs $([ "$fa" -gt 0 ] && echo yes || echo no), lines containing lfs: $ln"
      done
      for o in "${FAILING[@]}"; do
        v=$(GIT_NO_LAZY_FETCH=1 git -C "$T" check-attr --source="$head" filter -- "${PATHOF[$o]}" 2>/dev/null | awk -F': ' '{print $NF}')
        ATTR[$o]=${v:-unknown}
        info P4 "$(o12 "$o"): check-attr filter for its path = ${ATTR[$o]}"
      done
    fi
    rm -rf "$T"
  fi
  for o in "${FAILING[@]}"; do
    info P4 "$(o12 "$o"): downloaded size=${SIZE[$o]:-unknown} small-blob lfs pointer=${LFSP[$o]:-unknown}"
  done
}

p5() {
  local b o p c rc lr
  halted && return
  b=$(bare "$REPO")
  info P5 "bare clone for-each-ref total=$(git -C "$b" for-each-ref --format='%(refname)' | wc -l); namespaces: $(git -C "$b" for-each-ref --format='%(refname)' | awk -F/ '{c[$1"/"$2]++} END{for(k in c) printf "%s=%d ", k, c[k]}')"
  info P5 "first 20 refs sample: $(git -C "$b" for-each-ref --count=20 --format='%(refname:short)' | wc -l) listed"
  lr=$(timeout -k 10 "$STEP_T" git -C "$b" ls-remote origin 2>>"$ERR"); local rc2=$?
  info P5 "ls-remote origin rc=$rc2 total=$(printf '%s\n' "$lr" | grep -c .); namespaces: $(printf '%s\n' "$lr" | awk '{n=split($2,a,"/"); k=(n>=2)? a[1]"/"a[2] : $2; c[k]++} END{for(k in c) printf "%s=%d ", k, c[k]}')"
  for o in "${FAILING[@]}"; do
    p=${PATHOF[$o]}
    c=$(nolazy -C "$b" log --all --format=%H -1 -- "$p" 2>>"$ERR")
    LOGC[$o]=$c
    if [ -z "$c" ]; then ANC[$o]=none; info P5 "$(o12 "$o"): git log --all -1 -- <path> found no commit"
    else
      nolazy -C "$b" merge-base --is-ancestor "$c" HEAD 2>>"$ERR"; rc=$?
      ANC[$o]=$rc
      info P5 "$(o12 "$o"): git log --all -1 -- <path> commit=$(o12 "$c") reachable from HEAD: $([ "$rc" -eq 0 ] && echo yes || echo no)"
    fi
  done
}

p6() {
  local o hyp= gl=0 lfs=0 lfsattr=0 proto=0 neg=0 meth=0 unr=1 allfail=1 ctrlok=0 errs="" k
  info SUMMARY "RULE order: not-reproduced, gitlink, lfs, negotiation-haves, protocol-version, fetch-method, unreachable-from-advertised-refs, server-limit, server-missing-object, unknown"
  info SUMMARY "RULE not-reproduced: every v2method fetch of the repo's picked oids succeeded"
  info SUMMARY "RULE gitlink: a failing oid has tree mode 160000 or type commit"
  info SUMMARY "RULE lfs: a failing oid downloaded as a git-lfs pointer, or check-attr filter=lfs for its path while every method fails"
  info SUMMARY "RULE negotiation-haves: v2method fails and proto0/proto2 fail but the same fetch with fetch.negotiationAlgorithm=noop succeeds (server answers an empty pack because the client's have commit already reaches the wanted blob, typical with reachability bitmaps)"
  info SUMMARY "RULE protocol-version: v2method fails but proto2 or proto0 succeeds"
  info SUMMARY "RULE fetch-method: v2method fails but direct fetch into the bare clone copy or lazy cat-file succeeds"
  info SUMMARY "RULE unreachable-from-advertised-refs: for every failing oid git log --all finds no commit or one not reachable from HEAD"
  info SUMMARY "RULE server-limit: every method fails for every failing oid while the control repo works and git's messages mention timeout, limit, size, EOF or hung up"
  info SUMMARY "RULE server-missing-object: same as server-limit but without such wording (server cannot serve the object)"
  for o in "${FAILING[@]}"; do
    [ "${MODEOF[$o]:-}" = 160000 ] || [ "${TYPEOF[$o]:-}" = commit ] && gl=1
    [ "${LFSP[$o]:-}" = yes ] && lfs=1
    [ "${ATTR[$o]:-}" = lfs ] && lfsattr=1
    if [ "${RS[$o.v2method]:-}" != 0 ]; then
      { [ "${RS[$o.proto2]:-x}" = 0 ] || [ "${RS[$o.proto0]:-x}" = 0 ]; } && proto=1
      [ "${RS[$o.noop]:-x}" = 0 ] && neg=1
      { [ "${RS[$o.direct]:-x}" = 0 ] || [ "${RS[$o.lazy]:-x}" = 0 ]; } && meth=1
      for k in v2method proto2 proto0 noop direct lazy; do
        [ "${RS[$o.$k]:-x}" = 0 ] && allfail=0
        errs+=" ${RE[$o.$k]:-}"
      done
    fi
    if [ "${ANC[$o]:-none}" = 0 ]; then unr=0; fi
  done
  for o in "${WORKING[@]}"; do [ "${REPOOF[$o]}" = "$CTRL" ] && ctrlok=1; done
  [ $lfsattr -eq 1 ] && [ $allfail -eq 1 ] && lfs=1
  if [ "$REPRODUCED" -eq 0 ]; then hyp=not-reproduced
  elif [ $gl -eq 1 ]; then hyp=gitlink
  elif [ $lfs -eq 1 ]; then hyp=lfs
  elif [ $neg -eq 1 ] && [ $proto -eq 0 ]; then hyp=negotiation-haves
  elif [ $proto -eq 1 ]; then hyp=protocol-version
  elif [ $meth -eq 1 ]; then hyp=fetch-method
  elif [ $unr -eq 1 ] && [ "${#FAILING[@]}" -gt 0 ]; then hyp=unreachable-from-advertised-refs
  elif [ $allfail -eq 1 ] && [ $ctrlok -eq 1 ]; then
    if printf '%s' "$errs" | grep -Eqi 'time(d )?out|limit|too (large|big)|exceed|early EOF|hung up|signal|broken pipe|size'; then hyp=server-limit; else hyp=server-missing-object; fi
  else hyp=unknown; fi
  info SUMMARY "evidence: failing=${#FAILING[@]} reproduced=$REPRODUCED gitlink=$gl lfs=$lfs proto_differs=$proto noop_works=$neg method_differs=$meth all_unreachable=$unr all_methods_fail=$allfail control_ok=$ctrlok"
  echo "HYPOTHESIS $hyp"
}

finish() {
  local p f
  p=$(printf '%s\n' "${RES[@]}" | grep -c '^PASS'); f=$(printf '%s\n' "${RES[@]}" | grep -c '^FAIL')
  echo; echo "===== SUMMARY ====="
  echo "pass=$p fail=$f downloaded_mb=$(( $(dltotal_kb) / 1024 )) (cap ${TOTAL_CAP_MB}) peak_disk_mb=$(( $(cat "$WORK/.pda") / 1024 )) (cap ${DISK_CAP_MB}) elapsed_s=$(( $(date +%s) - T0 ))"
  p6
  exit 0
}

if [ -n "$LOCAL" ]; then info P0 "local fixture mode: no SSH, ControlMaster and key handling skipped"
else info P0 "ControlMaster ssh used for every fetch; key read from env, shredded at exit"; fi
REPRODUCED=0
p1_repo "$REPO"
p1_repo "$CTRL"
[ -d "$(bare "$REPO")" ] && p2_repo "$REPO"
[ -d "$(bare "$CTRL")" ] && p2_repo "$CTRL"
classify
p3
p4
p5
finish
