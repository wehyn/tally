#!/usr/bin/env bash
# Start an isolated Tally dev instance + stub provider, seed a user and account, print READY.
# Usage: launch.sh [run-id]     (run from anywhere; operates on the checkout containing this skill)
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
RUN_ID="${1:-$(date +%Y%m%d-%H%M%S)-$$}"
RUN="${TALLY_VERIFY_ROOT:-/tmp/tally-verify}/$RUN_ID"
USER_NAME=verifier
USER_PASS=verify-password-123

# One `next dev` per checkout: Next locks .next/dev. Refuse rather than double-drive someone's server.
for pid in $(pgrep -f 'next dev|next-server' || true); do
  if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$REPO" ]; then
    echo "REFUSING: pid $pid is already running Next in $REPO. Use another worktree, or stop the run that owns it (cleanup.sh <its run dir>)." >&2; exit 1
  fi
done
[ -d "$REPO/node_modules/next" ] || (cd "$REPO" && npm ci)
(cd "$REPO" && npx playwright install chromium >/dev/null)   # no-op when this Playwright's browser is cached

mkdir -p "$RUN/data" "$RUN/evidence" "$RUN/logs"
trap 'echo "LAUNCH FAILED; logs in $RUN/logs. Tear down with: $SKILL_DIR/bin/cleanup.sh $RUN" >&2' ERR
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
APP_PORT="${TALLY_VERIFY_PORT:-$(free_port)}"
STUB_PORT="$(free_port)"

# Each child runs in its own session and records its own pid (== process group id) so cleanup can
# kill exactly the group it started: npm -> sh -> next -> next-server all share that group.
setsid bash -c 'echo $$ >"$1/stub.pid"; exec node "$2/bin/stub-provider.mjs" --port "$3" --log "$1/evidence/provider-requests.jsonl"' _ "$RUN" "$SKILL_DIR" "$STUB_PORT" </dev/null >"$RUN/logs/stub.log" 2>&1 &

start_next() {
  rm -f "$RUN/next.pid"
  TALLY_DATA_DIR="$RUN/data" \
  CODEX_LB_BASE_URL="http://127.0.0.1:$STUB_PORT/v1" CODEX_LB_MODEL=stub-model CODEX_LB_API_KEY=stub-key \
  CODEX_LB_PRIVACY_DISCLOSURE="Verification stub provider on 127.0.0.1; prompts never leave this machine." \
    setsid bash -c 'echo $$ >"$1/next.pid"; cd "$2" && exec npx next dev -H 127.0.0.1 -p "$3"' _ "$RUN" "$REPO" "$APP_PORT" </dev/null >>"$RUN/logs/next.log" 2>&1 &
  for _ in $(seq 1 20); do [ -s "$RUN/next.pid" ] && return 0; sleep 0.1; done
}
start_next

BASE="http://127.0.0.1:$APP_PORT"
cat >"$RUN/run.env" <<ENV
RUN_ID=$RUN_ID
RUN_DIR=$RUN
REPO=$REPO
BASE_URL=$BASE
STUB_URL=http://127.0.0.1:$STUB_PORT
TALLY_USER=$USER_NAME
TALLY_PASS=$USER_PASS
DB_PATH=$RUN/data/tally.sqlite
ENV

wait_for() { for _ in $(seq 1 "$2"); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "TIMEOUT waiting for $1 (see $RUN/logs)" >&2; return 1; }
wait_for "http://127.0.0.1:$STUB_PORT/__health" 15
# Next 16 (when it detects an agent) can print a security "upgrade recommendation" shortly after the
# first request and exit; it says to retry, and the retry continues. Restart once for that exit only.
restarted=0
wait_next() {
  for _ in $(seq 1 "$2"); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    if ! pgrep -g "$(cat "$RUN/next.pid")" >/dev/null; then
      if [ $restarted = 0 ] && grep -q 'stopped to show the upgrade' "$RUN/logs/next.log"; then
        echo "note: next dev stopped for its upgrade notice (see $RUN/logs/next.log); restarting once" >&2
        restarted=1; start_next
      else echo "next dev exited; see $RUN/logs/next.log" >&2; return 1; fi
    fi
    sleep 1
  done
  echo "TIMEOUT waiting for $1 (see $RUN/logs)" >&2; return 1
}
wait_next "$BASE/api/health" 90
sleep 5                      # the upgrade stop lands a few seconds after the first request
wait_next "$BASE/login" 120  # also compiles the auth route (~20s cold)

# Seed through the real HTTP API (first user becomes admin). This also runs migrations on the empty DB.
JAR="$RUN/cookies.txt"
post() { curl -fsS -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }
post /api/auth/register "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" >"$RUN/logs/seed-register.json"
post /api/accounts '{"name":"Wallet","type":"cash","balance":"1000.00"}' >"$RUN/logs/seed-account.json"
grep -q '"isDefault":true' "$RUN/logs/seed-account.json" || { echo "SEED FAILED: Wallet is not the default account" >&2; exit 1; }

echo "READY run=$RUN base=$BASE user=$USER_NAME"
