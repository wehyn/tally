#!/usr/bin/env bash
# Read-only: is this run's instance worth driving? Exit 0 only if every check passes.
# Usage: doctor.sh <run-dir>
set -uo pipefail
RUN="${1:?usage: doctor.sh <run-dir>}"; source "$RUN/run.env"
fail=0; check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
alive() { kill -0 "$(cat "$RUN/$1.pid")"; }
check "next dev process alive (pid $(cat "$RUN/next.pid"))" "alive next"
check "stub provider alive (pid $(cat "$RUN/stub.pid"))" "alive stub"
check "app health at $BASE_URL" "curl -fsS $BASE_URL/api/health | grep -q '\"service\":\"tally\"'"
check "stub health at $STUB_URL" "curl -fsS $STUB_URL/__health | grep -q tally-stub-provider"
check "port owned by this run's next dev" "ss -ltnp | grep -E \":${BASE_URL##*:} \" | grep -qE \"pid=($(pgrep -g "$(ps -o pgid= "$(cat "$RUN/next.pid")" | tr -d ' ')" | paste -sd'|'))\""
check "DB is this run's ($DB_PATH)" "test -s $DB_PATH"
check "seeded session valid (GET /api/accounts lists Wallet)" "curl -fsS -b $RUN/cookies.txt $BASE_URL/api/accounts | grep -q Wallet"
check "assistant provider configured" "curl -fsS -b $RUN/cookies.txt $BASE_URL/api/settings | grep -q '\"configured\":true'"
echo "checkout $(git -C "$REPO" rev-parse --short HEAD) $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') dirty file(s)"
exit $fail
