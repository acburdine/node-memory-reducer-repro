#!/usr/bin/env bash
# Usage: ./run.sh <node-version> <idle-mode> [extra node flags...]
#   IMAGE=<docker image> overrides node:<version>-bookworm-slim (e.g. the patched build from patch/).
# Writes traces/<version>-<mode>[-<flags>].log with host-side elapsed-time prefixes.
set -euo pipefail
cd "$(dirname "$0")"
v=$1; mode=$2; shift 2
suffix=$(echo "$*" | tr -c 'a-zA-Z0-9=\n-' '_' | sed 's/^_*//;s/_*$//')
out=traces/$v-$mode${suffix:+-$suffix}.log
docker run --rm -t --cpus=2 -v "$PWD:/w:ro" -w /w "${IMAGE:-node:$v-bookworm-slim}" \
  node --trace-gc --trace-memory-reducer --trace-mutator-utilization "$@" repro.js "$mode" 2>&1 \
  | perl -MTime::HiRes=time -ne 'BEGIN{$|=1;$t=time} s/\r//; printf "%7.2f| %s", time-$t, $_' > "$out"
echo "$out"
