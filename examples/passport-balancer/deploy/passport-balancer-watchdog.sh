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
# THE SECOND RULE, AND WHY IT FIRES ON THE FIRST STRIKE
# -----------------------------------------------------
# On 2026/09/02 the balancer twice held 4,998 NIGHT and reported no spendable
# DUST for an hour. The ledger's `spend()` had set `pending_until = ctime + 3 h`
# on both coins and the revert that should have cleared them found nothing left
# to clear; the in-process ladder cannot reach that, and a restart resumes from
# the snapshot that carries the flags forward.
#
# The rule above cannot catch it either, and that is the point of this second
# one: a wedged wallet is SYNCED, so `/wallet-status` answers `ready: true` and
# the check above exits happily while nothing can be sponsored.
#
# So the wedge is matched on its own signature, taken from both endpoints at
# once and every term required:
#
#     /status         synced:true, balanceAtomic > 0, pendingTransactions:0,
#                     balancesWatched:0, balancing:false, busy:false,
#                     settling:false
#     /wallet-status  dust balance "0" and utxoCount 0
#
# Every one of those rules out an innocent explanation — a syncing wallet, an
# empty one, a spend of its own in flight, a balancing handed to somebody else,
# a claim on the coins, or change still settling — and what is left is the
# ledger withholding coins the wallet owns.
#
# It acts on the FIRST strike, not the third, and the difference is the
# evidence: the rule above infers a fault from silence and waits six minutes to
# be sure, while this one reads a state that has exactly one cause. Six minutes
# of a demo is the whole demo. The repair is `dist/dust-rollback.mjs` against
# the stopped service's snapshot — which is a restart plus a rewrite, roughly
# ten seconds — falling back to moving the snapshot aside for a cold walk, which
# is the 89.5 s the operator measured by hand at 16:24 on 2026/09/02.
#
# Every decision is written to the journal under `passport-balancer-watchdog`,
# so `journalctl -u passport-balancer-watchdog` is the whole audit trail.

set -uo pipefail

BASE="${BALANCER_WATCHDOG_BASE:-http://127.0.0.1:8807}"
UNIT="${BALANCER_WATCHDOG_UNIT:-passport-balancer}"
STATE_DIR="${BALANCER_WATCHDOG_STATE:-/var/lib/passport-balancer}"
STRIKES_FILE="$STATE_DIR/watchdog-strikes"
RESTART_FILE="$STATE_DIR/watchdog-last-restart"
DUST_RESYNC_FILE="$STATE_DIR/watchdog-last-dust-resync"
SNAPSHOT="$STATE_DIR/sync-snapshot-${BALANCER_WATCHDOG_NETWORK:-stagenet}.json"
ROLLBACK="${BALANCER_WATCHDOG_ROLLBACK:-/opt/passport-balancer/dist/dust-rollback.mjs}"

# Consecutive failed checks before the unit is restarted. Never below 2.
STRIKES="${BALANCER_WATCHDOG_STRIKES:-3}"
# Seconds between two restarts by this script.
COOLDOWN="${BALANCER_WATCHDOG_COOLDOWN:-1800}"
# Per-request budget. Generous: a loaded proof server can make the event loop
# late without the service being unwell.
TIMEOUT="${BALANCER_WATCHDOG_TIMEOUT:-10}"
# Seconds between two DUST resyncs by this script. Its own clock, and much
# shorter than the restart cooldown: a wedge is proved rather than inferred, and
# the repair costs the service ten seconds rather than a chain walk.
DUST_COOLDOWN="${BALANCER_WATCHDOG_DUST_COOLDOWN:-300}"

log() { echo "[watchdog] $*"; }

# `systemctl` and `node` are overridable so `test/watchdog.test.sh` can drive
# this script against a stub HTTP server without a systemd on the box.
SYSTEMCTL="${BALANCER_WATCHDOG_SYSTEMCTL:-systemctl}"
NODE="${BALANCER_WATCHDOG_NODE:-node}"

mkdir -p "$STATE_DIR"

strikes=$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)
case "$strikes" in ''|*[!0-9]*) strikes=0 ;; esac

wallet_status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/wallet-status" 2>/dev/null)
curl_rc=$?
status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/status" 2>/dev/null)

# --------------------------------------------------------------------------
# The DUST wedge, asked FIRST because a wedged wallet is a synced one and the
# readiness check below would exit happily on it.
# --------------------------------------------------------------------------

dust_wedged() {
  [ $curl_rc -eq 0 ] || return 1
  [ -n "$status" ] || return 1
  # No spendable DUST, by both of the figures that describe it.
  printf '%s' "$wallet_status" | grep -q '"balance":"0"' || return 1
  printf '%s' "$wallet_status" | grep -q '"utxoCount":0' || return 1
  # Following the chain, so this is not a wallet that is merely behind.
  printf '%s' "$status" | grep -q '"synced":true' || return 1
  # Holding NIGHT, so it is not simply empty. Any non-zero string will do; the
  # balancer publishes it as atomic units in a JSON string.
  printf '%s' "$status" | grep -Eq '"balanceAtomic":"[1-9][0-9]*"' || return 1
  # Nothing of its own in flight, nothing it balanced outstanding, nothing
  # claiming the coins, and no change still on its way.
  printf '%s' "$status" | grep -q '"pendingTransactions":0' || return 1
  printf '%s' "$status" | grep -q '"balancesWatched":0' || return 1
  printf '%s' "$status" | grep -q '"balancing":false' || return 1
  printf '%s' "$status" | grep -q '"busy":false' || return 1
  printf '%s' "$status" | grep -q '"settling":false' || return 1
  return 0
}

if dust_wedged; then
  now=$(date +%s)
  last_resync=$(cat "$DUST_RESYNC_FILE" 2>/dev/null || echo 0)
  case "$last_resync" in ''|*[!0-9]*) last_resync=0 ;; esac
  if [ $((now - last_resync)) -lt "$DUST_COOLDOWN" ]; then
    log "the DUST looks wedged, but the last resync was $((now - last_resync)) s ago and the cooldown is ${DUST_COOLDOWN} s"
    exit 0
  fi

  log "THE DUST IS WEDGED: NIGHT held, no spendable DUST, nothing pending, nothing outstanding, nothing in flight — repairing"
  echo "$now" > "$DUST_RESYNC_FILE"

  # Stopped first, and this is not optional. The running service rewrites the
  # snapshot every minute, so a repair applied under it would be overwritten by
  # the wedged state within sixty seconds.
  "$SYSTEMCTL" stop "$UNIT"

  if "$NODE" "$ROLLBACK" --path "$SNAPSHOT"; then
    log "the snapshot was repaired in place"
  else
    rollback_rc=$?
    # Exit 3 is "nothing to repair", which under a live wedge means the stored
    # state is older than the fault. Either way the fallback is the same and it
    # is the one the operator ran by hand at 16:24 on 2026/09/02: move the
    # snapshot aside and let the next start walk the chain, which took 89.5 s.
    aside="$SNAPSHOT.wedged-$now"
    if mv "$SNAPSHOT" "$aside" 2>/dev/null; then
      log "the rollback exited $rollback_rc — moved the snapshot to $aside for a cold walk instead"
    else
      log "the rollback exited $rollback_rc and the snapshot could not be moved either — starting the unit back up regardless"
    fi
  fi

  "$SYSTEMCTL" start "$UNIT"
  echo 0 > "$STRIKES_FILE"
  log "$UNIT started again after the DUST repair"
  exit 0
fi

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
"$SYSTEMCTL" restart "$UNIT"
