#!/usr/bin/env bash
# Whether any user can read an AppImage and start what it runs, not only the
# owner of its mount: firejail --appimage and the AppImage catalog's test
# mount it as root and start it as someone else. Reads the modes stored in
# the image; --appimage-extract creates every directory as 0700 instead.
#
#   check-appimage.sh <file.AppImage>

set -euo pipefail

image=$(realpath "$1")
offset=$("$image" --appimage-offset)

bad=$(unsquashfs -o "$offset" -lln "$image" | awk '
  length($1) != 10 || $1 !~ /^[-dl]/ { next }
  {
    mode = $1; path = $0
    for (i = 0; i < 5; i++) sub(/^[^ ]+ +/, "", path)
    sub(/^squashfs-root\/?/, "", path)
    other_r = substr(mode, 8, 1) == "r"
    other_x = substr(mode, 10, 1) ~ /[xt]/
    owner_x = substr(mode, 4, 1) ~ /[xs]/
    type = substr(mode, 1, 1)
    if ((type == "d" && !(other_r && other_x)) ||
        (type == "-" && (!other_r || (owner_x && !other_x))))
      print mode " " path
  }')

if [ -n "$bad" ]; then
  while IFS= read -r line; do
    echo "::error::${line#* } in $(basename "$image") is ${line%% *}: only its owner may use it"
  done <<<"$bad"
  exit 1
fi
echo "$(basename "$image"): anyone may read every file, and run what its owner may run"
