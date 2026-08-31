#!/usr/bin/env bash
#
# The external half of the balancer's watchdog: the one failure the service
# cannot see from inside itself.
#
# `src/health.ts` runs a health loop IN the balancer process, and it can repair
# an unsynced wallet, a dropped indexer subscription, or key material that never
# loaded. What it cannot do — by definition — is notice that the process has
# stopped answering HTTP, because the loop that would notice is on the same
# event loop that is no longer running. That is this script's whole job, and it
# is deliberately the only thing it does.
#
# THE RULE IT ENFORCES
# --------------------
# Restart `passport-balancer` when, and only when:
#
#   1. `/wallet-status` has been unreachable or has reported `ready: false` on
#      STRIKES consecutive checks, INTERVAL apart. Three checks two minutes
#      apart is six minutes of continuous failure — comfortably longer than the
#      ~2 minutes a shielded proof takes and longer than the ~2 minute
#      post-spend syncing flap, so a busy sponsor is never mistaken for a dead
#      one; and
#   2. `/status` does not report a spend in flight. `balancing` is a claim on
#      the wallet's coin state and `busy` is a whole spend job, proving
#      included; either one means somebody is mid-transaction and a restart
#      would abandon it. A `/status` that cannot be read at all does NOT block
#      the restart — that is the wedged case this exists for; and
#   3. the last restart this script performed was more than COOLDOWN seconds
#      ago. The clock is a file, so it survives the restart it bounds.
#
# Every decision is written to the journal under `passport-balancer-watchdog`,
# so `journalctl -u passport-balancer-watchdog` is the whole audit trail.

set -uo pipefail

BASE="${BALANCER_WATCHDOG_BASE:-http://127.0.0.1:8807}"
UNIT="${BALANCER_WATCHDOG_UNIT:-passport-balancer}"
STATE_DIR="${BALANCER_WATCHDOG_STATE:-/var/lib/passport-balancer}"
STRIKES_FILE="$STATE_DIR/watchdog-strikes"
RESTART_FILE="$STATE_DIR/watchdog-last-restart"

# Consecutive failed checks before the unit is restarted. Never below 2.
STRIKES="${BALANCER_WATCHDOG_STRIKES:-3}"
# Seconds between two restarts by this script.
COOLDOWN="${BALANCER_WATCHDOG_COOLDOWN:-1800}"
# Per-request budget. Generous: a loaded proof server can make the event loop
# late without the service being unwell.
TIMEOUT="${BALANCER_WATCHDOG_TIMEOUT:-10}"

log() { echo "[watchdog] $*"; }

mkdir -p "$STATE_DIR"

strikes=$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)
case "$strikes" in ''|*[!0-9]*) strikes=0 ;; esac

wallet_status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/wallet-status" 2>/dev/null)
curl_rc=$?

if [ $curl_rc -eq 0 ] && printf '%s' "$wallet_status" | grep -q '"ready":true'; then
  if [ "$strikes" -ne 0 ]; then
    log "healthy again after $strikes failed check(s) — clearing"
  fi
  echo 0 > "$STRIKES_FILE"
  exit 0
fi

if [ $curl_rc -ne 0 ]; then
  reason="/wallet-status did not answer (curl exit $curl_rc)"
else
  reason="/wallet-status answered ready:false"
fi

# A spend in flight is a reason to WAIT, not a reason to strike: the sponsor is
# working, and a proof that outlives the check window would otherwise accumulate
# strikes for doing its job. The strike count is left exactly where it was.
status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/status" 2>/dev/null)
if [ -n "$status" ] && printf '%s' "$status" | grep -Eq '"(balancing|busy)":true'; then
  log "$reason, but /status reports a spend in flight — holding at $strikes strike(s)"
  exit 0
fi

strikes=$((strikes + 1))
echo "$strikes" > "$STRIKES_FILE"
log "$reason — strike $strikes of $STRIKES"

if [ "$strikes" -lt "$STRIKES" ]; then
  exit 0
fi

now=$(date +%s)
last=$(cat "$RESTART_FILE" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  log "would restart $UNIT, but the last watchdog restart was $((now - last)) s ago and the cooldown is ${COOLDOWN} s"
  exit 0
fi

log "RESTARTING $UNIT after $strikes consecutive failed checks — $reason"
echo "$now" > "$RESTART_FILE"
# Cleared here rather than after the restart: the count is about the failures
# that justified this restart, and carrying them forward would make the next
# single failure look like the fourth.
echo 0 > "$STRIKES_FILE"
systemctl restart "$UNIT"
