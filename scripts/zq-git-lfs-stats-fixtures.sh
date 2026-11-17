#!/usr/bin/env bash
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
F=$(mktemp -d /tmp/zqlfsfx.XXXXXX)
trap 'rm -rf "$F"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@a GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@a

pointer() {
  printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize %s\n' "$1" "$2" > "$3"
}

W=$F/w
git init -q -b main "$W"
(
  cd "$W"
  printf '*.zip filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
  mkdir -p art/raw docs "données"
  printf '*.tga filter=lfs diff=lfs merge=lfs -text\n' > art/.gitattributes
  printf '*.psd -filter\n' > art/raw/.gitattributes
  pointer 1 5242880 one.zip
  head -c 3000 /dev/urandom > two.zip
  pointer 2 10485760 art/a.tga
  head -c 4000 /dev/urandom > art/b.tga
  pointer 3 1048576 art/raw/c.psd
  head -c 2000 /dev/urandom > art/raw/d.psd
  pointer 4 2097152 "données/é fichier.zip"
  head -c 1500 /dev/urandom > "données/ü.psd"
  echo plain > docs/readme.txt
  head -c 2500 /dev/urandom > docs/plain.zip.txt
  git add -A
  git commit -qm c
  sub=$(git rev-parse HEAD)
  git update-index --add --cacheinfo "160000,$sub,vendor/submodule"
  git commit -qm gitlink
)
mkdir -p "$F/base"
git clone -q --bare "$W" "$F/base/fx.git"
git -C "$F/base/fx.git" config uploadpack.allowFilter true
git -C "$F/base/fx.git" config uploadpack.allowAnySHA1InWant true
git -C "$F/base/fx.git" repack -adbq

out=$(ZQ_SPIKE_BASE_URL=$F/base ZQ_LFS_REPOS="fx absent" ZQ_LFS_SAMPLE=20 bash "$HERE/zq-git-lfs-stats.sh" 2>&1)
printf '%s\n' "$out"

bad=0
has() {
  if printf '%s\n' "$out" | grep -Fq -- "$1"; then echo "PASS  has: $1"; else echo "FAIL  missing: $1"; bad=1; fi
}
has "ATTR  fx: .gitattributes files=3 lines_with_filter_lfs=3 distinct_patterns=3"
has "LFSFILES  fx: 6 of 13 files at HEAD have filter=lfs"
has "ext .zip = 3"
has "GITLINK  fx: 1 gitlink entries"
has "path=vendor/submodule"
has "SAMPLE  fx: sampled=6 lfs_pointers=3 real_content=3 aborted=0 failed=0 lfs_pointer_total_size_mb=17.00"
has "FAIL  CLONE  absent"
exit $bad
