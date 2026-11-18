#!/usr/bin/env bash
# Sourced by the stands. kind rewrites the kubeconfig it is given (its
# current-context too), so a path that is, or leads to, the home kubeconfig is
# refused: by a link, a linked directory, a hard link, or a link to a file not
# yet made. Run directly, it checks itself against a scratch home.

# A directory as the file system names it: the part that exists followed
# through its links before any `..` is taken, the part not yet made with its
# `.` and `..` worked out. Fails where the part that exists cannot be entered.
canonical_dir() (
  set -f
  dir=$1 rest=""
  while [ ! -d "$dir" ]; do
    rest="$(basename "$dir")${rest:+/$rest}"
    dir=$(dirname "$dir")
  done
  out=$(cd -P -- "$dir" && pwd -P) || exit 1
  IFS=/
  for part in $rest; do
    case $part in
      "" | .) ;;
      ..) out=$(dirname "$out") ;;
      *) out="${out%/}/$part" ;;
    esac
  done
  echo "$out"
)

refuse_home_kubeconfig() {
  local path=$1 to dir home
  while [ -L "$path" ]; do
    to=$(readlink "$path")
    case $to in /*) path=$to ;; *) path="$(dirname "$path")/$to" ;; esac
  done
  if ! dir=$(canonical_dir "$(dirname "$path")") || ! home=$(canonical_dir "$HOME/.kube"); then
    echo "cannot resolve $path or $HOME/.kube, so it may be the home kubeconfig" >&2
    exit 1
  fi
  if [ "$dir/$(basename "$path")" = "$home/config" ] || [ "$path" -ef "$HOME/.kube/config" ]; then
    echo "refusing to write $HOME/.kube/config" >&2
    exit 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  scratch=$(mktemp -d)
  trap 'chmod -R u+rwx "$scratch"; rm -rf "$scratch"' EXIT
  export HOME="$scratch/home"
  mkdir -p "$HOME/.kube" "$scratch/sandbox"
  touch "$HOME/.kube/config"
  ln -s "$HOME/.kube/config" "$scratch/link"
  ln -s "$HOME/.kube" "$scratch/kube"
  ln "$HOME/.kube/config" "$scratch/hard"
  ln -s "$HOME/.kube/later" "$scratch/dangling"
  failed=0
  expect() {
    local want=$1 path=$2 got
    if (refuse_home_kubeconfig "$path") 2>/dev/null; then got=allowed; else got=refused; fi
    [ "$got" = "$want" ] || { echo "$path: $got, wanted $want" >&2; failed=1; }
  }
  expect refused "$HOME/.kube/config"
  expect refused "$scratch/link"
  expect refused "$scratch/kube/config"
  expect refused "$scratch/hard"
  expect allowed "$scratch/sandbox/config"
  expect allowed "$scratch/sandbox/new/config"
  rm "$HOME/.kube/config"
  ln -s "$HOME/.kube/config" "$scratch/dangling-home"
  expect refused "$scratch/dangling-home"
  expect allowed "$scratch/dangling"
  rm -rf "$HOME/.kube"
  mkdir "$HOME/sub" "$scratch/locked"
  ln -s "$HOME/sub" "$scratch/sub-link"
  expect refused "$scratch/sub-link/../.kube/config"
  chmod 000 "$scratch/locked"
  expect refused "$scratch/locked/inside/config"
  (refuse_home_kubeconfig "$scratch/locked/inside/config") 2>&1 | grep -q "cannot resolve" ||
    { echo "a path that cannot be entered is not said as such" >&2; failed=1; }
  expect refused "$HOME/./.kube/config"
  expect refused "$HOME/gone/../.kube/config"
  expect refused "$HOME/.kube/./config"
  expect allowed "$scratch/sandbox/new/config"
  expect allowed "$HOME/.kube-sandbox/config"
  [ "$failed" = 0 ] && echo "sandbox guard: ok"
  exit "$failed"
fi
