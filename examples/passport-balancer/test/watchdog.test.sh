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
REAL_CURL="$(command -v curl)"
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
# `is-active` is a QUESTION rather than an action: it answers and is NOT
# recorded, so the call log stays a list of the things the watchdog did.
if [ "${1:-}" = "is-active" ]; then
  echo "${WATCHDOG_TEST_CADDY:-active}"
  exit 0
fi
echo "systemctl $*" >> "$WATCHDOG_TEST_CALLS"
SH2
# Same shape for docker: `inspect` answers, `restart` is recorded.
cat > "$WORK/docker" <<'SH2'
#!/usr/bin/env bash
if [ "${1:-}" = "inspect" ]; then
  state="${WATCHDOG_TEST_CONTAINER:-true}"
  # A container that is not there at all: `docker inspect` exits non-zero and
  # prints nothing, which is how the supervisor tells `missing` from `stopped`.
  [ "$state" = "missing" ] && exit 1
  echo "$state"
  exit 0
fi
echo "docker $*" >> "$WATCHDOG_TEST_CALLS"
SH2
# The probe shim. Everything aimed at the stub above is handed to the real
# curl; every other URL answers with whatever the case under test has asked
# for, and a POST to the alert webhook has its body recorded instead.
cat > "$WORK/curl" <<'SH2'
#!/usr/bin/env bash
url="${!#}"
payload=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-d" ] && payload="$arg"
  prev="$arg"
done
case "$url" in
  *"${WATCHDOG_TEST_STUB:-127.0.0.1:18807}"*)
    exec "${WATCHDOG_TEST_CURL_REAL:-/usr/bin/curl}" "$@" ;;
  *127.0.0.1:6300/health*)
    echo "${WATCHDOG_TEST_PROOF_CODE:-200}" ;;
  */prover/health*)
    echo "${WATCHDOG_TEST_PUBLIC_PROVER:-200}" ;;
  */balancer/status*)
    echo "${WATCHDOG_TEST_PUBLIC_BALANCER:-200}" ;;
  *hooks.example.invalid*)
    printf '%s\n' "$payload" >> "${WATCHDOG_TEST_WEBHOOK:-/dev/null}" ;;
  *)
    echo 000 ;;
esac
SH2
cat > "$WORK/node" <<'SH2'
#!/usr/bin/env bash
echo "node $*" >> "$WATCHDOG_TEST_CALLS"
exit "${WATCHDOG_TEST_ROLLBACK_RC:-0}"
SH2
# A canned journal, so the dead-socket leg can be driven without systemd. Whatever
# is in $WATCHDOG_TEST_JOURNAL is what `journalctl -u ...` returns.
cat > "$WORK/journalctl" <<'SH2'
#!/usr/bin/env bash
cat "${WATCHDOG_TEST_JOURNAL:-/dev/null}" 2>/dev/null
SH2
cat > "$WORK/logger" <<'SH2'
#!/usr/bin/env bash
echo "logger $*" >> "$WATCHDOG_TEST_CALLS"
SH2
chmod +x "$WORK/systemctl" "$WORK/node" "$WORK/journalctl" "$WORK/logger" \
  "$WORK/docker" "$WORK/curl"
: > "$WORK/journal"
: > "$WORK/webhook"

# Captured BEFORE $WORK reaches PATH, so the shim above has a real curl to hand
# the stub's own requests to.
export WATCHDOG_TEST_CURL_REAL="$REAL_CURL"
export WATCHDOG_TEST_STUB="127.0.0.1:$PORT"
export WATCHDOG_TEST_WEBHOOK="$WORK/webhook"

# What the droplet answers, unless a case says otherwise. `GRACE=0` because
# every tick here happens in the same second: the real script holds its strikes
# for two minutes after a restart, which is tested on its own below and would
# otherwise make every multi-tick case unwritable.
sv_defaults() {
  export WATCHDOG_TEST_PROOF_CODE=200
  export WATCHDOG_TEST_PUBLIC_PROVER=200
  export WATCHDOG_TEST_PUBLIC_BALANCER=200
  export WATCHDOG_TEST_CADDY=active
  export WATCHDOG_TEST_CONTAINER=true
  export WATCHDOG_ALERT_WEBHOOK=""
  export WATCHDOG_REBOOT=0
  export BALANCER_WATCHDOG_GRACE=0
  unset BALANCER_WATCHDOG_BACKOFF
  unset BALANCER_WATCHDOG_SUPERVISOR_STRIKES
  unset BALANCER_WATCHDOG_HEARTBEAT
}
sv_defaults

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
 "settling":false,"ready":true,"jobsRunning":0,"proofInFlight":false,
 "nodeSocket":"connected","consecutiveSocketFailures":0,
 "aliasSponsorship":"available","accountFunding":"available","proving":"server"}
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
  BALANCER_WATCHDOG_JOURNALCTL="$WORK/journalctl" \
  BALANCER_WATCHDOG_LOGGER="$WORK/logger" \
  WATCHDOG_TEST_JOURNAL="$WORK/journal" \
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
BALANCER_WATCHDOG_JOURNALCTL="$WORK/journalctl" \
BALANCER_WATCHDOG_LOGGER="$WORK/logger" \
WATCHDOG_TEST_JOURNAL="$WORK/journal" \
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
echo
echo "the watchdog's stalled-spend-job leg"

# The 23:46 hang of 2026/09/02, as /status would report it today: the alias job
# holding a lane, its last step `submitted`, nothing at the prover, and — this
# is what made it invisible — a wallet that still answers ready:true.
stalled_bodies() {
  local since="$1"
  local step="$2"
  cat > "$BODIES/status.json" <<JSON
{"synced":true,"balanceAtomic":"4998916000","dustSpecks":"24990017628947616000",
 "pendingTransactions":0,"balancesWatched":0,"balancing":false,"busy":true,
 "settling":false,"ready":true,"lanes":3,"jobsRunning":1,"proofInFlight":false,
 "nodeSocket":"connected","consecutiveSocketFailures":0,
 "aliasSponsorship":"available","accountFunding":"available","proving":"server",
 "jobs":[{"id":"job-7","label":"the registration of rvmtkqu91rwsk.night",
 "step":"$step","ageMs":$((since + 4000)),"sinceProgressMs":$since}]}
JSON
  cat > "$BODIES/wallet-status.json" <<JSON
{"total":1,"available":1,"wallets":[{"index":0,"ready":true,"syncState":"ready",
 "dust":{"balance":"24990017628947616000","utxoCount":4,"isSynced":true}}]}
JSON
}

stalled_bodies 400000 submitted
run stalled-job
if [ "$(calls)" = "systemctl restart passport-balancer" ]; then
  pass "restarts the unit for a job silent 400 s at step submitted with an idle prover"
else
  fail "restarts for a stalled spend job" "$(calls)"
fi

if grep -q 'step submitted' "$WORK/out-stalled-job"; then
  pass "names the step it was stuck at, which is the line the journal never had"
else
  fail "names the step" "$(cat "$WORK/out-stalled-job")"
fi

# A job that is merely SLOW is not a stalled one.
stalled_bodies 40000 proved
run stalled-job-young
if [ -z "$(calls)" ]; then
  pass "leaves a job alone that reported a step 40 s ago"
else
  fail "leaves a young job alone" "$(calls)"
fi

# The distinction the whole watchdog rests on: a proof is minutes of silence and
# perfectly healthy, and aborting one would fail a registration a person is
# watching.
stalled_bodies 400000 proving
sed -i.bak 's/"proofInFlight":false/"proofInFlight":true/' "$BODIES/status.json"
run stalled-job-proving
if [ -z "$(calls)" ]; then
  pass "never restarts while something of ours is at the prover"
else
  fail "never restarts while proving" "$(calls)"
fi

# ---------------------------------------------------------------------------
echo
echo "the watchdog's dead-submission-socket leg"

# The journal of 15:30 to 20:12 UTC on 2026/09/05, in the words it really used:
# every submission refused by a websocket that was not there, and not one
# acknowledgement among them.
dead_socket_journal() {
  cat > "$WORK/journal" <<'JOURNAL'
[job] job-41 the registration of rvmtkqu91rwsk.night — submitting
[alias] the registration failed: RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: WebSocket is not connected
[job] job-42 the activation grant — submitting
[account] deposit-failed: RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: WebSocket is not connected
[asset] no spare mUSD coin: RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: WebSocket is not connected
JOURNAL
}

# Every other signal said the sponsor was well, which is the whole point of
# reading the journal instead.
healthy_bodies
dead_socket_journal
run dead-socket
if calls | grep -q 'systemctl restart passport-balancer' \
  && calls | grep -q 'logger -t passport-ops'; then
  pass "restarts on three WebSocket failures in two minutes with nothing acknowledged"
else
  fail "restarts on a dead submission socket" "$(calls)"
fi

if grep -q 'THE SUBMISSION SOCKET IS DEAD' "$WORK/out-dead-socket"; then
  pass "names the fault, on a /status that reads perfectly healthy"
else
  fail "names the fault" "$(cat "$WORK/out-dead-socket")"
fi

# ---------------------------------------------------------------------------
# A socket that dropped and came back has acknowledgements among the failures.
# Restarting that one would take a working sponsor down for a transient.
healthy_bodies
cat > "$WORK/journal" <<'JOURNAL'
[alias] the registration failed: WebSocket is not connected
[node] rebuilding the submission connection — a submission failed on a dead socket (rebuild 1)
[job] the node acknowledged this transaction
[account] deposit-failed: WebSocket is not connected
[job] the node acknowledged this transaction
[asset] no spare mUSD coin: WebSocket is not connected
JOURNAL
run recovered-socket
if [ -z "$(calls)" ]; then
  pass "leaves a socket alone that dropped and recovered — a submission got through"
else
  fail "leaves a recovered socket alone" "$(calls)"
fi

# ---------------------------------------------------------------------------
# Two failures is not three.
healthy_bodies
cat > "$WORK/journal" <<'JOURNAL'
[alias] the registration failed: WebSocket is not connected
[account] deposit-failed: WebSocket is not connected
JOURNAL
run two-socket-failures
if [ -z "$(calls)" ]; then
  pass "holds at two failures in the window"
else
  fail "holds at two failures" "$(calls)"
fi

# ---------------------------------------------------------------------------
# Its own cooldown, so a restart loop cannot be built out of a node that is
# genuinely down.
healthy_bodies
dead_socket_journal
run socket-cooldown
: > "$WORK/calls"
WATCHDOG_TEST_CALLS="$WORK/calls" PATH="$WORK:$PATH" \
BALANCER_WATCHDOG_BASE="http://127.0.0.1:$PORT" \
BALANCER_WATCHDOG_STATE="$LAST_STATE" \
BALANCER_WATCHDOG_SYSTEMCTL="$WORK/systemctl" \
BALANCER_WATCHDOG_NODE="$WORK/node" \
BALANCER_WATCHDOG_JOURNALCTL="$WORK/journalctl" \
BALANCER_WATCHDOG_LOGGER="$WORK/logger" \
WATCHDOG_TEST_JOURNAL="$WORK/journal" \
  bash "$SCRIPT" > "$WORK/out-socket-cooldown" 2>&1
if [ -z "$(calls)" ] && grep -q 'cooldown' "$WORK/out-socket-cooldown"; then
  pass "holds its own 600 s cooldown rather than restarting every two minutes"
else
  fail "holds the socket cooldown" "$(calls); $(cat "$WORK/out-socket-cooldown")"
fi

# ---------------------------------------------------------------------------
: > "$WORK/journal"
healthy_bodies
run healthy
if [ -z "$(calls)" ]; then
  pass "does nothing at all to a working sponsor"
else
  fail "does nothing to a working sponsor" "$(calls)"
fi


# ---------------------------------------------------------------------------
echo
echo "the supervisor's whole-path probes"

# A state directory that SURVIVES between ticks, because everything the
# supervisor does is about consecutive ticks: strikes, backoff, escalation.
sv_new() {
  SV_STATE="$WORK/sv-$1"
  rm -rf "$SV_STATE"
  mkdir -p "$SV_STATE"
  echo '{}' > "$SV_STATE/sync-snapshot-stagenet.json"
  : > "$WORK/webhook"
  : > "$WORK/journal"
  sv_defaults
}

# One tick. The call log is truncated first, so an assertion is always about
# what THIS tick did.
sv_tick() {
  : > "$WORK/calls"
  WATCHDOG_TEST_CALLS="$WORK/calls" \
  PATH="$WORK:$PATH" \
  BALANCER_WATCHDOG_BASE="${SV_BASE:-http://127.0.0.1:$PORT}" \
  BALANCER_WATCHDOG_STATE="$SV_STATE" \
  BALANCER_WATCHDOG_SYSTEMCTL="$WORK/systemctl" \
  BALANCER_WATCHDOG_NODE="$WORK/node" \
  BALANCER_WATCHDOG_DOCKER="$WORK/docker" \
  BALANCER_WATCHDOG_JOURNALCTL="$WORK/journalctl" \
  BALANCER_WATCHDOG_LOGGER="$WORK/logger" \
  WATCHDOG_TEST_JOURNAL="$WORK/journal" \
    bash "$SCRIPT" > "$WORK/out-sv" 2>&1
}

sv_ticks() { local n="$1"; while [ "$n" -gt 0 ]; do sv_tick; n=$((n - 1)); done; }
sv_out() { cat "$WORK/out-sv"; }

# ---------------------------------------------------------------------------
sv_new healthy
healthy_bodies
sv_tick
if [ -z "$(calls)" ] && grep -q '^\[supervisor\] ok:' "$WORK/out-sv"; then
  pass "says ok and touches nothing when every hop answers"
else
  fail "ok on a healthy stack" "$(calls); $(sv_out)"
fi

if [ "$(grep -c '^\[supervisor\]' "$WORK/out-sv")" = 1 ]; then
  pass "writes exactly one summary line per tick"
else
  fail "one summary line per tick" "$(sv_out)"
fi

# ---------------------------------------------------------------------------
# Every term of the /status verdict, one at a time. Each must be named in the
# summary and none of them may restart anything on a single tick.
for term in synced socket failures alias funding proving behind; do
  sv_new "term-$term"
  healthy_bodies
  case "$term" in
    synced)   sed -i.bak 's/"synced":true/"synced":false/' "$BODIES/status.json"; want='synced:False' ;;
    socket)   sed -i.bak 's/"nodeSocket":"connected"/"nodeSocket":"dead"/' "$BODIES/status.json"; want='nodeSocket:dead' ;;
    failures) sed -i.bak 's/"consecutiveSocketFailures":0/"consecutiveSocketFailures":4/' "$BODIES/status.json"; want='consecutiveSocketFailures:4' ;;
    alias)    sed -i.bak 's/"aliasSponsorship":"available"/"aliasSponsorship":"unavailable"/' "$BODIES/status.json"; want='aliasSponsorship:unavailable' ;;
    funding)  sed -i.bak 's/"accountFunding":"available"/"accountFunding":"unavailable"/' "$BODIES/status.json"; want='accountFunding:unavailable' ;;
    proving)  sed -i.bak 's/"proving":"server"/"proving":"wasm"/' "$BODIES/status.json"; want='proving:wasm' ;;
    behind)   sed -i.bak 's/"proving":"server"/"proving":"server","appliedBehindHeadBlocks":120/' "$BODIES/status.json"; want='appliedBehindHeadBlocks:120' ;;
  esac
  sv_tick
  if grep -q '^\[supervisor\] degraded:' "$WORK/out-sv" && grep -q "$want" "$WORK/out-sv" && [ -z "$(calls)" ]; then
    pass "reads $term as unhealthy, names it ($want), and restarts nothing on one tick"
  else
    fail "reads $term as unhealthy" "$(calls); $(sv_out)"
  fi
done

# ---------------------------------------------------------------------------
# `nodeSocket` absent is a build that predates the field, not a fault.
sv_new socket-absent
healthy_bodies
sed -i.bak 's/"nodeSocket":"connected",//' "$BODIES/status.json"
sv_tick
if grep -q '^\[supervisor\] ok:' "$WORK/out-sv"; then
  pass "treats a missing nodeSocket as connected rather than as a fault"
else
  fail "missing nodeSocket is not a fault" "$(sv_out)"
fi

# Fifty blocks behind is the allowance, not the fault.
sv_new behind-a-little
healthy_bodies
sed -i.bak 's/"proving":"server"/"proving":"server","appliedBehindHeadBlocks":10/' "$BODIES/status.json"
sv_tick
if grep -q '^\[supervisor\] ok:' "$WORK/out-sv"; then
  pass "allows the wallet to sit ten blocks behind the head"
else
  fail "ten blocks behind is allowed" "$(sv_out)"
fi

# A /status that cannot be read is never healthy — the one reading that must
# not be mistaken for silence meaning consent.
sv_new unreadable
healthy_bodies
SV_BASE="http://127.0.0.1:19999" sv_tick
if grep -q 'balancer=unreadable\|balancer=unreachable' "$WORK/out-sv"; then
  pass "never reads an unanswerable /status as healthy"
else
  fail "an unreadable /status is not healthy" "$(sv_out)"
fi
unset SV_BASE

# ---------------------------------------------------------------------------
echo
echo "the supervisor's targeted restarts"

sv_unhealthy_bodies() {
  healthy_bodies
  sed -i.bak 's/"aliasSponsorship":"available"/"aliasSponsorship":"unavailable"/' "$BODIES/status.json"
}

# ---------------------------------------------------------------------------
sv_new balancer-two
sv_unhealthy_bodies
sv_ticks 2
if [ -z "$(calls)" ]; then
  pass "holds at two unhealthy ticks — two minutes is not a fault"
else
  fail "holds at two unhealthy ticks" "$(calls)"
fi

sv_tick
if calls | grep -q 'systemctl restart passport-balancer' && calls | grep -q 'logger -t passport-ops'; then
  pass "restarts the balancer on the third consecutive unhealthy tick, with an ops marker"
else
  fail "restarts the balancer at three strikes" "$(calls); $(sv_out)"
fi

if grep -q 'aliasSponsorship:unavailable' "$WORK/out-sv"; then
  pass "says in the journal WHICH term of /status was wrong"
else
  fail "names the failing term" "$(sv_out)"
fi

# ---------------------------------------------------------------------------
# A spend in flight is a person waiting on a registration. Nothing is restarted
# under one until the streak is long enough that the job is stuck, not slow.
sv_new balancer-busy
sv_unhealthy_bodies
sed -i.bak 's/"busy":false/"busy":true/' "$BODIES/status.json"
sed -i.bak 's/"jobsRunning":0/"jobsRunning":1/' "$BODIES/status.json"
sed -i.bak 's/"proofInFlight":false/"proofInFlight":true/' "$BODIES/status.json"
sv_ticks 3
if [ -z "$(calls)" ] && grep -q 'a spend is in flight' "$WORK/out-sv"; then
  pass "will not restart a sponsor that is mid-spend, and says so"
else
  fail "busy blocks the restart" "$(calls); $(sv_out)"
fi

sv_ticks 7
if calls | grep -q 'systemctl restart passport-balancer'; then
  pass "restarts anyway at ten ticks — a job that has held a lane that long is stuck, not busy"
else
  fail "the busy override fires at ten ticks" "$(calls); $(sv_out)"
fi

# ---------------------------------------------------------------------------
# Nothing strikes a service inside the grace window after it was restarted:
# a unit that is still starting is not a unit that has failed.
sv_new balancer-grace
sv_unhealthy_bodies
export BALANCER_WATCHDOG_BACKOFF=0
sv_ticks 3
export BALANCER_WATCHDOG_GRACE=120
sv_ticks 3
if [ -z "$(calls)" ] && grep -q 'strike 0 of 3' "$WORK/out-sv"; then
  pass "holds its strikes for two minutes after a restart, while the service comes back"
else
  fail "the grace window holds strikes" "$(calls); $(sv_out)"
fi
sv_defaults

# ---------------------------------------------------------------------------
# The backoff ladder: a dependency that is genuinely down must not be turned
# into a restart every minute.
sv_new balancer-backoff
sv_unhealthy_bodies
sv_ticks 3
sv_ticks 3
if [ -z "$(calls)" ] && grep -q 'backoff after 1 restart(s) is 600 s' "$WORK/out-sv"; then
  pass "waits ten minutes before a second restart of the same unit"
else
  fail "the backoff ladder holds the second restart" "$(calls); $(sv_out)"
fi

# ---------------------------------------------------------------------------
# Caddy. A unit that is not running is restarted; one that is running but not
# serving is RELOADED, because restarting it writes the 1AM key into the
# journal and a reload does not.
sv_new caddy-down
healthy_bodies
export WATCHDOG_TEST_CADDY=inactive
export WATCHDOG_TEST_PUBLIC_BALANCER=000
export WATCHDOG_TEST_PUBLIC_PROVER=000
sv_ticks 3
if calls | grep -q 'systemctl restart caddy'; then
  pass "restarts Caddy when systemctl says it is not running"
else
  fail "restarts a dead Caddy" "$(calls); $(sv_out)"
fi

sv_new caddy-not-serving
healthy_bodies
export WATCHDOG_TEST_PUBLIC_BALANCER=502
sv_ticks 3
if calls | grep -q 'systemctl reload caddy' && ! calls | grep -q 'systemctl restart caddy'; then
  pass "reloads rather than restarts a Caddy that is active but not serving — a restart writes the gateway key to the journal"
else
  fail "reloads a Caddy that is not serving" "$(calls); $(sv_out)"
fi

# The public prover path failing BECAUSE the prover is down is the prover's
# fault, and Caddy must not be blamed for it.
sv_new caddy-blameless
healthy_bodies
export WATCHDOG_TEST_PUBLIC_PROVER=502
export WATCHDOG_TEST_PROOF_CODE=502
sv_ticks 3
if calls | grep -q 'docker restart passport-proof-server' && ! calls | grep -q 'caddy'; then
  pass "blames the proof server rather than Caddy when only the prover path fails"
else
  fail "does not blame Caddy for the prover" "$(calls); $(sv_out)"
fi

# ---------------------------------------------------------------------------
# The proof server.
sv_new proof-health
healthy_bodies
export WATCHDOG_TEST_PROOF_CODE=502
sv_ticks 2
if [ -z "$(calls)" ]; then
  pass "holds at two failed /health checks on the proof server"
else
  fail "holds at two proof-server strikes" "$(calls)"
fi
sv_tick
if calls | grep -q 'docker restart passport-proof-server'; then
  pass "restarts the proof-server container after three failed /health checks"
else
  fail "restarts the proof server at three strikes" "$(calls); $(sv_out)"
fi

sv_new proof-stopped
healthy_bodies
export WATCHDOG_TEST_CONTAINER=false
sv_ticks 3
if calls | grep -q 'docker restart passport-proof-server' && grep -q 'container=stopped' "$WORK/out-sv"; then
  pass "restarts a proof-server container that is not running, and says so"
else
  fail "restarts a stopped container" "$(calls); $(sv_out)"
fi

# ---------------------------------------------------------------------------
echo
echo "the supervisor's escalation"

# Three restarts inside the window that have not helped, and restarting is
# admitted not to be the repair.
sv_escalate() {
  sv_new "$1"
  sv_unhealthy_bodies
  export BALANCER_WATCHDOG_BACKOFF=0
  export BALANCER_WATCHDOG_SUPERVISOR_STRIKES=1
  sv_ticks 3
}

sv_escalate escalation
sv_tick
if [ -f "$SV_STATE/supervisor-escalated" ] && [ -z "$(calls | grep 'systemctl restart passport-balancer')" ]; then
  pass "stops restarting after three restarts in the window and writes the escalated marker"
else
  fail "escalates after three restarts" "$(calls); $(cat "$SV_STATE/supervisor-escalated" 2>/dev/null); $(sv_out)"
fi

sv_tick
if [ -z "$(calls)" ] && grep -q '^\[supervisor\] ESCALATED:' "$WORK/out-sv"; then
  pass "restarts nothing at all while escalated, and says why every tick"
else
  fail "does nothing while escalated" "$(calls); $(sv_out)"
fi

healthy_bodies
sv_tick
if [ ! -f "$SV_STATE/supervisor-escalated" ] && grep -q 'ESCALATION CLEARED' "$WORK/out-sv"; then
  pass "leaves escalation the moment the balancer reads healthy again"
else
  fail "leaves escalation when healthy" "$(sv_out)"
fi

# The reboot, which is off unless the environment file switches it on.
sv_escalate escalation-noreboot
sv_tick
sv_tick
if [ -z "$(calls | grep reboot)" ]; then
  pass "never reboots the droplet with WATCHDOG_REBOOT unset"
else
  fail "no reboot by default" "$(calls)"
fi

sv_escalate escalation-reboot
sv_tick
export WATCHDOG_REBOOT=1
sv_tick
if calls | grep -q 'systemctl reboot'; then
  pass "reboots once when WATCHDOG_REBOOT=1 and the marker is set"
else
  fail "reboots under WATCHDOG_REBOOT=1" "$(calls); $(sv_out)"
fi
sv_tick
if [ -z "$(calls | grep reboot)" ]; then
  pass "reboots at most once every six hours, not once a minute"
else
  fail "one reboot per six hours" "$(calls)"
fi
sv_defaults

# ---------------------------------------------------------------------------
echo
echo "the supervisor's alerting hook"

SECRET_URL="https://hooks.example.invalid/services/T000/B000/xoxb-not-a-real-secret"

sv_new alert-silent
sv_unhealthy_bodies
sv_ticks 3
if [ ! -s "$WORK/webhook" ]; then
  pass "posts nothing anywhere with WATCHDOG_ALERT_WEBHOOK unset"
else
  fail "silent when unset" "$(cat "$WORK/webhook")"
fi

sv_new alert-payload
sv_unhealthy_bodies
export WATCHDOG_ALERT_WEBHOOK="$SECRET_URL"
sv_ticks 3
if grep -q 'restarting passport-balancer' "$WORK/webhook"; then
  pass "posts a line to the webhook when it restarts something"
else
  fail "posts on an action" "$(cat "$WORK/webhook")"
fi

if python3 - "$WORK/webhook" <<'PY'
import json, sys
lines = [line for line in open(sys.argv[1]) if line.strip()]
assert lines, 'nothing was posted'
for line in lines:
    body = json.loads(line)
    assert list(body) == ['text'], body
    assert isinstance(body['text'], str) and body['text'], body
PY
then
  pass "every payload is a plain {\"text\": \"...\"} object and nothing else"
else
  fail "the payload shape" "$(cat "$WORK/webhook")"
fi

if ! grep -q 'xoxb-not-a-real-secret' "$WORK/out-sv"; then
  pass "never writes the webhook URL to the journal"
else
  fail "the webhook URL stays out of the journal" "$(sv_out)"
fi

# The heartbeat, so a webhook that has quietly stopped delivering is noticed on
# a quiet day rather than during an outage.
sv_new alert-heartbeat
healthy_bodies
export WATCHDOG_ALERT_WEBHOOK="$SECRET_URL"
sv_ticks 2
if [ "$(grep -c heartbeat "$WORK/webhook")" = 1 ]; then
  pass "sends one heartbeat a day, not one a tick"
else
  fail "one heartbeat a day" "$(cat "$WORK/webhook")"
fi

sv_new alert-escalation
sv_unhealthy_bodies
export WATCHDOG_ALERT_WEBHOOK="$SECRET_URL"
export BALANCER_WATCHDOG_BACKOFF=0
export BALANCER_WATCHDOG_SUPERVISOR_STRIKES=1
sv_ticks 4
if grep -q 'ESCALATED' "$WORK/webhook"; then
  pass "alerts on entering escalation, which is the one state nobody will see otherwise"
else
  fail "alerts on escalation" "$(cat "$WORK/webhook")"
fi
sv_defaults

# ---------------------------------------------------------------------------
echo
echo "the supervisor's self-protection"

sv_new duration
healthy_bodies
sv_started=$(date +%s)
sv_tick
sv_elapsed=$(( $(date +%s) - sv_started ))
if [ "$sv_elapsed" -lt 30 ]; then
  pass "finishes a tick in ${sv_elapsed} s, inside the timer's minute"
else
  fail "finishes inside the timer's minute" "took ${sv_elapsed} s"
fi

if grep -q 'PROBE_TIMEOUT="${BALANCER_WATCHDOG_PROBE_TIMEOUT:-5}"' "$SCRIPT" \
  && grep -q 'TIMEOUT="${BALANCER_WATCHDOG_TIMEOUT:-5}"' "$SCRIPT"; then
  pass "gives every request a five-second budget, so seven of them fit in a minute"
else
  fail "five-second request budgets" "$(grep TIMEOUT= "$SCRIPT")"
fi

# Idempotent: the same droplet, twice, decides the same thing.
sv_new idempotent
healthy_bodies
sv_tick
cp "$WORK/out-sv" "$WORK/out-sv-first"
sv_tick
if [ "$(sed 's/[0-9]//g' "$WORK/out-sv-first")" = "$(sed 's/[0-9]//g' "$WORK/out-sv")" ]; then
  pass "decides the same thing twice about the same droplet"
else
  fail "idempotent" "$(diff "$WORK/out-sv-first" "$WORK/out-sv")"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all watchdog cases pass"
  exit 0
fi
echo "$failures watchdog case(s) failed"
exit 1
