#!/usr/bin/env bash
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
F=$(mktemp -d /tmp/zqprobefx.XXXXXX)
trap 'rm -rf "$F"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@a GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@a

mkwork() {
  git init -q -b main "$F/w.$1"
}
commit_all() {
  git -C "$F/w.$1" add -A
  git -C "$F/w.$1" commit -qm c
}
publish() {
  local d=$1 r=$2
  mkdir -p "$F/$d"
  git clone -q --bare "$F/w.$r" "$F/$d/$r.git"
  git -C "$F/$d/$r.git" config uploadpack.allowFilter true
  git -C "$F/$d/$r.git" config uploadpack.allowAnySHA1InWant true
}

mkwork server
(
  cd "$F/w.server"
  printf '*.zip filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
  mkdir -p a b p
  head -c 3000 /dev/urandom > a/real1.zip
  head -c 4000 /dev/urandom > b/real2.psd
  printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 123456\n' 1 > p/ptr.zip
  echo hi > readme.txt
)
commit_all server
mkwork jenkinstasks
(
  cd "$F/w.jenkinstasks"
  head -c 3000 /dev/urandom > c.zip
  echo t > r.txt
)
commit_all jenkinstasks

for r in server jenkinstasks; do
  publish bitmap "$r"
  git -C "$F/bitmap/$r.git" repack -adbq
  publish plain "$r"
  publish missing "$r"
done
for o in $(git -C "$F/w.server" ls-files -s | awk '$4 ~ /zip$|psd$|txt$/ {print $2}'); do
  rm -f "$F/missing/server.git/objects/${o:0:2}/${o:2}"
done

bad=0
expect() {
  local dir=$1 want=$2 got
  got=$(ZQ_SPIKE_BASE_URL=$F/$dir bash "$HERE/zq-git-probe-server.sh" 2>&1 | sed -n 's/^HYPOTHESIS //p')
  if [ "$got" = "$want" ]; then echo "PASS  $dir: HYPOTHESIS $got"; else echo "FAIL  $dir: HYPOTHESIS $got, expected $want"; bad=1; fi
}
expect bitmap negotiation-haves
expect plain not-reproduced
expect missing server-missing-object
exit $bad
