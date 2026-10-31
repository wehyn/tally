#!/usr/bin/env bash
# Stop only the processes this run started (by recorded process group) and delete scratch state.
# Keeps $RUN/evidence and $RUN/logs. Usage: cleanup.sh <run-dir>
set -uo pipefail
RUN="${1:?usage: cleanup.sh <run-dir>}"
for name in next stub; do
  f="$RUN/$name.pid"; [ -f "$f" ] || continue
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    # Wait for the whole group (npm can exit before next-server does), then force what remains.
    for _ in $(seq 1 20); do pgrep -g "$pid" >/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$f"
done
rm -rf "$RUN/data" "$RUN/cookies.txt"
echo "CLEANED $RUN (evidence kept: $RUN/evidence, logs: $RUN/logs)"
