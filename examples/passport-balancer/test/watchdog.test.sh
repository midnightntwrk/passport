#!/usr/bin/env bash
#
# `deploy/passport-balancer-watchdog.sh`, driven against a stub HTTP server.
#
# This script is the only leg of the watchdog that runs OUTSIDE the balancer
# process, and it is therefore the only leg that can act on the failure the
# process cannot see. It is also the leg with no type checker and no test
# runner behind it, which is why this exists: every case below is a pair of
# canned `/status` and `/wallet-status` bodies, and what is asserted is which
# of `systemctl stop`, `node dist/dust-rollback.mjs`, and `systemctl start` the
# script actually called.
#
#   bash test/watchdog.test.sh
#
# `systemctl` and `node` are replaced by recorders through the two environment
# variables the script reads for exactly this purpose, so nothing here touches a
# real unit and nothing needs root.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../deploy/passport-balancer-watchdog.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null' EXIT

PORT="${WATCHDOG_TEST_PORT:-18807}"
BODIES="$WORK/bodies"
mkdir -p "$BODIES"

# A stub that serves whatever is in $BODIES/status.json and
# $BODIES/wallet-status.json at the moment of the request, so a case can be
# rewritten between runs without restarting it.
cat > "$WORK/stub.py" <<'PY'
import http.server, os, sys

root = sys.argv[1]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name = {'/status': 'status.json', '/wallet-status': 'wallet-status.json'}.get(self.path)
        path = os.path.join(root, name) if name else None
        if not path or not os.path.exists(path):
            self.send_response(404)
            self.end_headers()
            return
        with open(path, 'rb') as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

http.server.HTTPServer(('127.0.0.1', int(sys.argv[2])), Handler).serve_forever()
PY

python3 "$WORK/stub.py" "$BODIES" "$PORT" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1 && break
  sleep 0.1
done

# Recorders, one line per call, in the order they were made.
cat > "$WORK/systemctl" <<'SH2'
#!/usr/bin/env bash
echo "systemctl $*" >> "$WATCHDOG_TEST_CALLS"
SH2
cat > "$WORK/node" <<'SH2'
#!/usr/bin/env bash
echo "node $*" >> "$WATCHDOG_TEST_CALLS"
exit "${WATCHDOG_TEST_ROLLBACK_RC:-0}"
SH2
chmod +x "$WORK/systemctl" "$WORK/node"

failures=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; echo "       $2"; failures=$((failures + 1)); }

# The wedge, as `/status` and `/wallet-status` really reported it at 15:53 on
# 2026/09/02: synced, 4,998.916 NIGHT, no DUST at all, and nothing whatsoever
# to explain it.
wedged_status() {
  cat > "$BODIES/status.json" <<JSON
{"synced":true,"balanceAtomic":"4998916000","dustSpecks":"0","pendingTransactions":0,
 "balancesWatched":0,"balancing":false,"busy":false,"settling":false,"ready":false}
JSON
}
wedged_wallet_status() {
  cat > "$BODIES/wallet-status.json" <<JSON
{"total":1,"available":0,"wallets":[{"index":0,"ready":true,"syncState":"ready",
 "dust":{"balance":"0","utxoCount":0,"isSynced":true}}]}
JSON
}
healthy_bodies() {
  cat > "$BODIES/status.json" <<JSON
{"synced":true,"balanceAtomic":"4998916000","dustSpecks":"24990017628947616000",
 "pendingTransactions":0,"balancesWatched":0,"balancing":false,"busy":false,
 "settling":false,"ready":true}
JSON
  cat > "$BODIES/wallet-status.json" <<JSON
{"total":1,"available":1,"wallets":[{"index":0,"ready":true,"syncState":"ready",
 "dust":{"balance":"24990017628947616000","utxoCount":2,"isSynced":true}}]}
JSON
}

run() {
  local state="$WORK/state-$1"
  rm -rf "$state"
  mkdir -p "$state"
  : > "$WORK/calls"
  # A snapshot for the fallback branch to find.
  echo '{}' > "$state/sync-snapshot-stagenet.json"
  WATCHDOG_TEST_CALLS="$WORK/calls" \
  WATCHDOG_TEST_ROLLBACK_RC="${2:-0}" \
  PATH="$WORK:$PATH" \
  BALANCER_WATCHDOG_BASE="http://127.0.0.1:$PORT" \
  BALANCER_WATCHDOG_STATE="$state" \
  BALANCER_WATCHDOG_SYSTEMCTL="$WORK/systemctl" \
  BALANCER_WATCHDOG_NODE="$WORK/node" \
  BALANCER_WATCHDOG_ROLLBACK="/opt/passport-balancer/dist/dust-rollback.mjs" \
    bash "$SCRIPT" > "$WORK/out-$1" 2>&1
  LAST_STATE="$state"
}

calls() { cat "$WORK/calls"; }

echo "the watchdog's DUST-wedge leg"

# ---------------------------------------------------------------------------
wedged_status
wedged_wallet_status
run first-strike
if calls | grep -q 'systemctl stop' \
  && calls | grep -q 'node /opt/passport-balancer/dist/dust-rollback.mjs' \
  && calls | grep -q 'systemctl start'; then
  pass "repairs on the FIRST strike, stopping the unit before it rewrites the snapshot"
else
  fail "repairs on the FIRST strike" "$(calls)"
fi

if [ "$(calls | head -1)" = "systemctl stop passport-balancer" ]; then
  pass "stops before it repairs — a running service would overwrite the repair within a minute"
else
  fail "stops before it repairs" "$(calls | head -1)"
fi

# ---------------------------------------------------------------------------
run second-run-cooldown
touch "$LAST_STATE/x" 2>/dev/null
# Re-run against the same state directory, which now carries the resync clock.
WATCHDOG_TEST_CALLS="$WORK/calls" PATH="$WORK:$PATH" \
BALANCER_WATCHDOG_BASE="http://127.0.0.1:$PORT" \
BALANCER_WATCHDOG_STATE="$LAST_STATE" \
BALANCER_WATCHDOG_SYSTEMCTL="$WORK/systemctl" \
BALANCER_WATCHDOG_NODE="$WORK/node" \
  bash "$SCRIPT" > "$WORK/out-cooldown" 2>&1
if grep -q 'cooldown' "$WORK/out-cooldown"; then
  pass "holds its own 300 s cooldown rather than resyncing every two minutes"
else
  fail "holds its own cooldown" "$(cat "$WORK/out-cooldown")"
fi

# ---------------------------------------------------------------------------
# Each term of the signature, removed one at a time. Every one of them must
# stop the repair, because each rules out an innocent explanation and the
# conjunction is the only thing that makes the diagnosis certain.
for term in busy balancing pending outstanding settling unsynced empty; do
  wedged_wallet_status
  case "$term" in
    busy)        wedged_status; sed -i.bak 's/"busy":false/"busy":true/' "$BODIES/status.json" ;;
    balancing)   wedged_status; sed -i.bak 's/"balancing":false/"balancing":true/' "$BODIES/status.json" ;;
    pending)     wedged_status; sed -i.bak 's/"pendingTransactions":0/"pendingTransactions":1/' "$BODIES/status.json" ;;
    outstanding) wedged_status; sed -i.bak 's/"balancesWatched":0/"balancesWatched":1/' "$BODIES/status.json" ;;
    settling)    wedged_status; sed -i.bak 's/"settling":false/"settling":true/' "$BODIES/status.json" ;;
    unsynced)    wedged_status; sed -i.bak 's/"synced":true/"synced":false/' "$BODIES/status.json" ;;
    empty)       wedged_status; sed -i.bak 's/"balanceAtomic":"4998916000"/"balanceAtomic":"0"/' "$BODIES/status.json" ;;
  esac
  run "hold-$term"
  if calls | grep -q 'dust-rollback'; then
    fail "holds when $term" "$(calls)"
  else
    pass "holds when $term — that reading has an innocent explanation"
  fi
done

# ---------------------------------------------------------------------------
# The fallback: a rollback that cannot repair the snapshot must still get the
# service back, by moving the snapshot aside for a cold walk.
wedged_status
wedged_wallet_status
run fallback 3
if calls | grep -q 'systemctl start' && ls "$LAST_STATE"/sync-snapshot-stagenet.json.wedged-* >/dev/null 2>&1; then
  pass "falls back to a cold walk when the rollback cannot repair the snapshot"
else
  fail "falls back to a cold walk" "$(calls); $(ls "$LAST_STATE")"
fi

# ---------------------------------------------------------------------------
healthy_bodies
run healthy
if [ -z "$(calls)" ]; then
  pass "does nothing at all to a working sponsor"
else
  fail "does nothing to a working sponsor" "$(calls)"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all watchdog cases pass"
  exit 0
fi
echo "$failures watchdog case(s) failed"
exit 1
