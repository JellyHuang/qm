#!/usr/bin/env bash
set -u
umask 077
HOST=${GITLAB_HOST:-lab.skyunion.net}
GROUP=${ZQ_SPIKE_GROUP:-ca-programmer-zq}
REPOS=${ZQ_LFS_REPOS:-client clientcode CommonMessage gameconfig jenkinstasks server zq-ui}
SAMPLE=${ZQ_LFS_SAMPLE:-12}
LOCAL=${ZQ_SPIKE_BASE_URL:-}
if [ -n "$LOCAL" ]; then BASE=$LOCAL; else BASE="git@$HOST:$GROUP"; fi
STEP_T=${ZQ_LFS_STEP_TIMEOUT:-300}
[ "$STEP_T" -gt 300 ] && STEP_T=300
FILE_CAP_MB=${ZQ_LFS_FILE_CAP_MB:-200}
TOTAL_CAP_MB=${ZQ_LFS_TOTAL_CAP_MB:-1024}
DISK_CAP_MB=${ZQ_LFS_DISK_CAP_MB:-3072}
FILE_CAP_KB=$((FILE_CAP_MB*1024)); TOTAL_CAP_KB=$((TOTAL_CAP_MB*1024)); DISK_CAP_KB=$((DISK_CAP_MB*1024))
POINTER_LINE='version https://git-lfs.github.com/spec/v1'

GV=$(git --version | awk '{print $3}')
IFS=. read -r GMAJ GMIN _ <<<"$GV"
if [ "${GMAJ:-0}" -lt 2 ] || { [ "${GMAJ:-0}" -eq 2 ] && [ "${GMIN:-0}" -lt 44 ]; }; then echo "FAIL git $GV is older than 2.44"; exit 2; fi

WORK=$(mktemp -d /tmp/zqlfs.XXXXXX) || exit 2
CMDIR=$(mktemp -d /tmp/zqlfscm.XXXXXX) || exit 2
KEY=$WORK/key
KH=$WORK/known_hosts
ERR=$WORK/err.log
: > "$ERR"
mkdir -p "$WORK/home" "$WORK/repos"
export HOME=$WORK/home GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
NPASS=0; NFAIL=0
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
SSH_CM="$SSH_BASE -o ControlMaster=auto -o ControlPath=$CMDIR/%C -o ControlPersist=120"
export GIT_SSH_COMMAND="$SSH_CM"

now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
kb() { du -sk "$1" 2>/dev/null | cut -f1; }
url() { case $BASE in /*) printf 'file://%s/%s.git' "$BASE" "$1" ;; *) printf '%s/%s.git' "$BASE" "$1" ;; esac; }
bare() { echo "$WORK/repos/$1.git"; }
pass() { NPASS=$((NPASS+1)); echo "PASS  $1  $2"; }
info() { echo "INFO  $1  $2"; }
fail() { NFAIL=$((NFAIL+1)); echo "FAIL  $1  $2"; }
clean() { tr -d '\000-\037' | cut -c1-160; }
NL() { tr '\0' '\n'; }
o12() { printf '%s' "${1:0:12}"; }
mb() { awk -v k="$1" 'BEGIN{printf "%.1f", k/1024}'; }

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
  git -C "$t" config core.bigFileThreshold 1m
  echo "$t"
}
noop_fetch() {
  local t=$1; shift
  capped "$t" git -c fetch.negotiationAlgorithm=noop -C "$t" fetch -q --no-tags --no-write-fetch-head origin "$@"
}
nolazy() { GIT_NO_LAZY_FETCH=1 timeout -k 10 "$STEP_T" git "$@"; }
ext_of() { local b=${1##*/} e; e=${b##*.}; [ "$e" = "$b" ] && e=none; printf '%s' "${e,,}"; }

clone_bare() {
  CAPKB=$TOTAL_CAP_KB
  capped "$(bare "$1")" git -c core.bigFileThreshold=1m -c fetch.unpackLimit=1 -c transfer.unpackLimit=1 -c fetch.negotiationAlgorithm=noop clone -q --bare --filter=blob:none "$(url "$1")" "$(bare "$1")"
  CAPKB=$FILE_CAP_KB
  [ "$CAP_RC" -eq 0 ] && [ "$CAP_EXC" -eq 0 ]
}
blobs() { NL < "$WORK/ls.$1" | awk -F'\t' 'NF>=2 {split($1,a," "); if (a[2]=="blob") print a[3] "\t" substr($0, index($0,"\t")+1)}'; }

gitlinks() {
  local R=$1 n
  n=$(NL < "$WORK/ls.$R" | awk -F'\t' 'NF>=2{split($1,a," "); if (a[1]=="160000") c++} END{print c+0}')
  info GITLINK "$R: $n gitlink entries (mode 160000) at HEAD"
  NL < "$WORK/ls.$R" | awk -F'\t' 'NF>=2{split($1,a," "); if (a[1]=="160000") print substr($0, index($0,"\t")+1)}' | head -n 20 |
    while IFS= read -r p; do info GITLINK "$R: path=$(printf '%s' "$p" | tr -d '\000-\037' | cut -c1-60)"; done
}

attributes() {
  local R=$1 b=$2 u=$3 list T ga oids files=0 lfslines=0 n pats
  list=$(blobs "$R" | awk -F'\t' '{p=$2; sub(/^.*\//,"",p); if (p==".gitattributes") print $1}')
  files=$(printf '%s' "$list" | grep -c .)
  if [ "$files" -eq 0 ]; then
    info ATTR "$R: .gitattributes files=0 lines_with_filter_lfs=0 distinct_patterns=0"
    return 0
  fi
  T=$(new_tmp_repo "$b" "$u")
  mapfile -t oids <<<"$list"
  noop_fetch "$T" "${oids[@]}"
  if [ "$CAP_RC" -ne 0 ] || [ "$CAP_EXC" -ne 0 ]; then
    fail ATTR "$R: fetch of $files .gitattributes blobs failed rc=$CAP_RC err=\"$CAP_ERR\""
    rm -rf "$T"; return 1
  fi
  pass ATTR "$R: fetched $files .gitattributes blobs in ${CAP_SECS}s, ${CAP_G}KB"
  : > "$WORK/lfslines.$R"
  for ga in $list; do
    nolazy -C "$T" cat-file -p "$ga" 2>>"$ERR" | grep 'filter=lfs' >> "$WORK/lfslines.$R"
  done
  lfslines=$(grep -c . "$WORK/lfslines.$R")
  pats=$(awk '{print $1}' "$WORK/lfslines.$R" | awk '!s[$0]++' | cut -c1-80)
  n=$(printf '%s' "$pats" | grep -c .)
  info ATTR "$R: .gitattributes files=$files lines_with_filter_lfs=$lfslines distinct_patterns=$n"
  printf '%s\n' "$pats" | grep . | head -n 10 | while IFS= read -r p; do info ATTR "$R: pattern $(printf '%s' "$p" | tr -d '\000-\037')"; done
  ATTR_REPO=$T
}

lfs_files() {
  local R=$1 head=$2 T=$3 tot
  blobs "$R" | awk -F'\t' '{print $2}' | tr '\n' '\0' > "$WORK/paths.$R"
  tot=$(tr -cd '\0' < "$WORK/paths.$R" | wc -c)
  GIT_NO_LAZY_FETCH=1 timeout -k 10 "$STEP_T" git -C "$T" check-attr --source="$head" -z filter --stdin < "$WORK/paths.$R" 2>>"$ERR" | NL |
    awk 'NR%3==1{p=$0} NR%3==0{ if ($0=="lfs") print p}' > "$WORK/lfs.$R"
  local rc=${PIPESTATUS[0]} n
  n=$(grep -c . "$WORK/lfs.$R")
  if [ "$rc" -ne 0 ]; then fail LFSFILES "$R: check-attr rc=$rc"; return 1; fi
  pass LFSFILES "$R: $n of $tot files at HEAD have filter=lfs"
  while IFS= read -r p; do ext_of "$p"; echo; done < "$WORK/lfs.$R" | awk '{c[$0]++} END{for(k in c) print c[k], k}' | sort -rn | head -n 8 |
    while read -r c e; do info LFSFILES "$R: ext .$e = $c"; done
}

sample() {
  local R=$1 b=$2 u=$3 oid path T sz fl ptr=0 real=0 ab=0 bad=0 pbytes=0 rbytes=0 done_n=0 psz
  [ -s "$WORK/lfs.$R" ] || { info SAMPLE "$R: no lfs-attributed files, nothing to sample"; return; }
  blobs "$R" | awk -F'\t' -v n="$SAMPLE" 'NR==FNR{want[$0]=1; next} ($2 in want){d=$2; sub(/[^\/]*$/,"",d); if(!(d in cnt)) order[++nd]=d; cnt[d]++; item[d,cnt[d]]=$0}
    END{c=0; for(r=1;c<n;r++){any=0; for(i=1;i<=nd&&c<n;i++){d=order[i]; if(r<=cnt[d]){print item[d,r]; c++; any=1}} if(!any) break}}' "$WORK/lfs.$R" - > "$WORK/sample.$R"
  while IFS=$'\t' read -r oid path; do
    halted && break
    T=$(new_tmp_repo "$b" "$u")
    CAPKB=$FILE_CAP_KB
    noop_fetch "$T" "$oid"
    done_n=$((done_n+1))
    if [ "$CAP_EXC" -ne 0 ]; then ab=$((ab+1)); info SAMPLE "$R: #$done_n $(o12 "$oid") .$(ext_of "$path") ABORTED over ${FILE_CAP_MB}MB cap after ${CAP_G}KB"
    elif [ "$CAP_RC" -ne 0 ] || ! GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -e "$oid" 2>/dev/null; then
      bad=$((bad+1)); fail SAMPLE "$R: #$done_n $(o12 "$oid") .$(ext_of "$path") fetch rc=$CAP_RC err=\"$CAP_ERR\""
    else
      sz=$(GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -s "$oid" 2>/dev/null); sz=${sz:-0}
      fl=
      [ "$sz" -lt 1024 ] && fl=$(GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -p "$oid" 2>/dev/null | head -n1 | tr -d '\000-\037\r')
      if [ "$fl" = "$POINTER_LINE" ]; then
        psz=$(GIT_NO_LAZY_FETCH=1 git -C "$T" cat-file -p "$oid" 2>/dev/null | awk '$1=="size"{print $2; exit}' | tr -dc '0-9'); psz=${psz:-0}
        ptr=$((ptr+1)); pbytes=$((pbytes+psz))
        info SAMPLE "$R: #$done_n $(o12 "$oid") .$(ext_of "$path") LFS-POINTER lfs_size=${psz}B pointer_blob=${sz}B"
      else
        real=$((real+1)); rbytes=$((rbytes+sz))
        info SAMPLE "$R: #$done_n $(o12 "$oid") .$(ext_of "$path") REAL-CONTENT downloaded=${sz}B grew=${CAP_G}KB"
      fi
    fi
    rm -rf "$T"
  done < "$WORK/sample.$R"
  pass SAMPLE "$R: sampled=$done_n lfs_pointers=$ptr real_content=$real aborted=$ab failed=$bad lfs_pointer_total_size_mb=$(awk -v b="$pbytes" 'BEGIN{printf "%.2f", b/1048576}') real_content_downloaded_mb=$(awk -v b="$rbytes" 'BEGIN{printf "%.2f", b/1048576}')"
}

repo_stats() {
  local R=$1 b u head T
  b=$(bare "$R"); u=$(url "$R")
  halted && return 1
  if ! clone_bare "$R"; then fail CLONE "$R: blobless clone failed rc=$CAP_RC err=\"$CAP_ERR\""; rm -rf "$b"; return 1; fi
  pass CLONE "$R: blobless clone ${CAP_SECS}s, ${CAP_G}KB"
  git -C "$b" -c core.quotepath=false ls-tree -r -z HEAD 2>>"$ERR" > "$WORK/ls.$R"
  head=$(git -C "$b" rev-parse HEAD 2>/dev/null)
  info TREE "$R: entries at HEAD=$(NL < "$WORK/ls.$R" | grep -c .) blobs=$(blobs "$R" | grep -c .)"
  gitlinks "$R"
  ATTR_REPO=
  attributes "$R" "$b" "$u"
  T=${ATTR_REPO:-}
  if [ -z "$T" ]; then
    T=$(new_tmp_repo "$b" "$u")
  fi
  halted || lfs_files "$R" "$head" "$T"
  rm -rf "$T"
  halted || sample "$R" "$b" "$u"
  rm -rf "$b"
}

if [ -n "$LOCAL" ]; then info P0 "local fixture mode: no SSH, ControlMaster and key handling skipped"
else info P0 "ControlMaster ssh used for every fetch; key read from env, shredded at exit"; fi
info P0 "git $GV, sample=$SAMPLE per repo, per-file cap ${FILE_CAP_MB}MB, total cap ${TOTAL_CAP_MB}MB, disk cap ${DISK_CAP_MB}MB, step timeout ${STEP_T}s"
for R in $REPOS; do
  repo_stats "$R"
done
echo; echo "===== SUMMARY ====="
echo "pass=$NPASS fail=$NFAIL downloaded_mb=$(( $(dltotal_kb) / 1024 )) (cap ${TOTAL_CAP_MB}) peak_disk_mb=$(( $(cat "$WORK/.pda") / 1024 )) (cap ${DISK_CAP_MB}) elapsed_s=$(( $(date +%s) - T0 ))"
exit 0
