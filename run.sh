#!/usr/bin/env bash
# Usage: ./run.sh <node-version> <idle-mode> [extra node flags...]
#   IMAGE=<docker image>  overrides node:<version>-bookworm-slim (e.g. the patched build from patch/).
#   EXTRSS=1              also samples the process's VmRSS from /proc every 5 s, from outside Node
#                         (docker exec, reads the kernel's number; independent of process.memoryUsage),
#                         into traces/<name>-extrss.log.
# Writes traces/<version>-<mode>[-<flags>].log with host-side elapsed-time prefixes.
set -euo pipefail
cd "$(dirname "$0")"
v=$1; mode=$2; shift 2
suffix=$(echo "$*" | tr -c 'a-zA-Z0-9=\n-' '_' | sed 's/^_*//;s/_*$//')
name=$v-$mode${suffix:+-$suffix}
out=traces/$name.log
cname=repro-$name-$$
t0=$(perl -MTime::HiRes=time -e 'print time')
docker run --rm -t --cpus=2 --name "$cname" -v "$PWD:/w:ro" -w /w "${IMAGE:-node:$v-bookworm-slim}" \
  node --trace-gc --trace-memory-reducer --trace-mutator-utilization "$@" repro.js "$mode" 2>&1 \
  | perl -MTime::HiRes=time -ne "BEGIN{\$|=1} s/\r//; printf \"%7.2f| %s\", time-$t0, \$_" > "$out" &
if [ "${EXTRSS:-0}" = 1 ]; then
  ext=traces/$name-extrss.log
  : > "$ext"
  sleep 1
  while docker inspect -f '{{.State.Running}}' "$cname" 2>/dev/null | grep -q true; do
    rss=$(docker exec "$cname" sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{print $2}')
    [ -n "$rss" ] && printf "%7.2f| VmRSS=%d MB\n" "$(perl -MTime::HiRes=time -e "print time-$t0")" "$((rss/1024))" >> "$ext"
    sleep 5
  done
fi
wait
echo "$out"
