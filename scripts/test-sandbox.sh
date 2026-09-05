#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
if ! command -v bwrap >/dev/null 2>&1; then echo "bwrap not found; refusing unsandboxed test:sandbox" >&2; exit 1; fi
node_path=$(command -v node)
args=(--die-with-parent --unshare-all --new-session)
for d in /usr /bin /lib /lib64 /etc/ssl /etc/alternatives; do
  if [ -e "$d" ]; then args+=(--ro-bind "$d" "$d"); fi
done
args+=(--dir /tmp --tmpfs /tmp --proc /proc --dev /dev --bind "$repo" /work --chdir /work --setenv HOME /tmp/home --dir /tmp/home --setenv NODE_ENV test --setenv CI 1)
exec bwrap "${args[@]}" "$node_path" --test
