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
# THE THIRD RULE: A SUBMISSION SOCKET THAT IS NOT THERE
# ----------------------------------------------------
# On 2026/09/05 the balancer's node websocket died at 14:48 UTC and every
# submission from 15:30:27 to the operator's restart at 20:12 failed instantly —
# 520 of them, every name registration, every activation grant, and every mUSD
# mint — while /wallet-status answered ready:true and /status answered
# synced:true, busy:false, and both sponsorships available. Neither rule above
# can see that, and neither could the in-process ladder, whose `refresh` remedy
# re-read the wallet and never touched the connection.
#
# The service now rebuilds that socket itself and exits when it cannot. This is
# the backstop, and its evidence is the one place the fault was always plain:
#
#     journalctl  >= SOCKET_STRIKES 'WebSocket is not connected' lines inside
#                 SOCKET_WINDOW, with NO 'the node acknowledged this
#                 transaction' line among them
#
# The acknowledgement is written by `src/submission.ts` on every submission the
# node takes, so its absence across the window is what separates a socket that
# is gone from one that dropped and came back. A restart under this rule writes
# a `logger -t passport-ops` marker as well as its own journal line.
#
# THE SUPERVISOR: THE WHOLE PATH, EVERY MINUTE
# --------------------------------------------
# The three rules above are named faults with matched signatures, and each one
# was written after the fault it matches had already happened. The supervisor
# is the general case, and it exists because on 2026/09/05 the sponsor was
# alive and unable to submit for five hours and nothing restarted it.
#
# Every tick it probes the whole path a person actually walks, in both
# directions from the front door:
#
#     /status            synced, nodeSocket connected (or absent),
#     (127.0.0.1:8807)   consecutiveSocketFailures < 3, aliasSponsorship and
#                        accountFunding available, proving == server, and
#                        appliedBehindHeadBlocks <= 50 where it is published.
#                        Read with python3, not grep: three of those terms are
#                        numbers and a grep cannot tell a missing key from a
#                        false one.
#     127.0.0.1:6300     the proof server's /health
#     docker             the proof server container is running
#     systemctl          caddy is active
#     the public name    https://<host>/balancer/status and /prover/health,
#                        resolved to the loopback so the probe measures OUR
#                        Caddy rather than a DNS answer
#
# and restarts BY UNIT rather than by hypothesis: the balancer after three
# unhealthy ticks, Caddy when it is down or the public path fails while the
# local probes pass, the proof server container when it is not running or its
# /health has failed three ticks. Nothing is restarted while `/status` reports
# a spend in flight until the unhealthy streak reaches ten, at which point the
# job is not in flight, it is stuck.
#
# Every unit carries an exponential backoff of its own — 10 min, 20, 40, capped
# at 2 h — so a dependency that is genuinely down cannot be turned into a
# restart loop, and after three restarts of the balancer inside two hours that
# have not fixed it the script writes a `supervisor-escalated` marker, stops
# restarting anything at all, and says so every tick. `WATCHDOG_REBOOT=1` in
# /etc/passport-balancer-watchdog.env adds one droplet reboot per six hours at
# that point; it is off by default.
#
# TWO STOCK FLOORS sit beside all of that and do none of it. `WATCHDOG_NIGHT_
# FLOOR` (500 NIGHT) and `WATCHDOG_DUST_FLOOR_SPECKS` (5e18) alert at most once
# per six hours each and take no other action, because the fault they match —
# a sponsor running out of money — is the one fault a restart cannot repair.
# Either set to 0 is off.
#
# `WATCHDOG_ALERT_WEBHOOK`, from the same file, receives a plain
# `{"text": "..."}` on every action and on entering or leaving escalation, plus
# a heartbeat at most once a day so a webhook that has quietly stopped
# delivering is noticed on a quiet day rather than during an outage. It is
# never logged. With nothing set, nothing is posted.
#
# Every decision is written to the journal under `passport-balancer-watchdog`,
# so `journalctl -u passport-balancer-watchdog` is the whole audit trail, and
# every tick writes exactly one `[supervisor] ok|degraded: …` line whichever
# leg ends it.

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
# Per-request budget. Five seconds, and the whole tick is five probes and two
# of these: the timer now fires every minute, so a check must finish inside it
# or two of them overlap and both strike for the same failure. A slow /status
# is itself a symptom, and it takes three of them in a row to restart anything.
TIMEOUT="${BALANCER_WATCHDOG_TIMEOUT:-5}"
# Seconds between two DUST resyncs by this script. Its own clock, and much
# shorter than the restart cooldown: a wedge is proved rather than inferred, and
# the repair costs the service ten seconds rather than a chain walk.
#
# TEN MINUTES, NOT FIVE, and it is an alignment rather than a new figure. The
# in-process ladder settled on `resyncDustMinUptimeMs: 600_000` on 2026/09/06 —
# a resync ends with `process.exit(1)`, so a wallet that comes back still wedged
# exits again on its first tick, and ten minutes is the period that cycle was
# deliberately given. This script's own clock was still five, which meant the
# two supervisors disagreed about how often the same repair may be attempted and
# the shorter one won: a wedge that survived its repair could be resynced from
# out here at five minutes while the process itself was still holding off.
DUST_COOLDOWN="${BALANCER_WATCHDOG_DUST_COOLDOWN:-600}"
# How long a running spend job may report no step, with nothing at the prover,
# before this script restarts the unit. Five minutes, and deliberately twice the
# in-process watchdog's own window: the process gets first refusal on its own
# stall, and this is the backstop for the case where the abort itself cannot
# land. On 2026/09/02 two jobs held a lane silently for 37 and 23 minutes and
# only an operator ended them — /status now publishes enough to see that from
# out here.
JOB_STALL="${BALANCER_WATCHDOG_JOB_STALL:-300}"
# The journal window the dead-submission-socket leg reads, and how many
# transport failures in it are enough. Three in two minutes with not one
# submission acknowledged between them is the signature of 2026/09/05, where the
# real figure was 520 failures and no acknowledgements at all in five hours.
SOCKET_WINDOW="${BALANCER_WATCHDOG_SOCKET_WINDOW:-2 min}"
SOCKET_STRIKES="${BALANCER_WATCHDOG_SOCKET_STRIKES:-3}"
# Seconds between two restarts by this leg. Its own clock, and shorter than the
# general one: the fault is proved by the journal rather than inferred from
# silence, and every minute of it is every registration failing.
SOCKET_COOLDOWN="${BALANCER_WATCHDOG_SOCKET_COOLDOWN:-600}"
SOCKET_RESTART_FILE="$STATE_DIR/watchdog-last-socket-restart"

log() { echo "[watchdog] $*"; }

# `systemctl` and `node` are overridable so `test/watchdog.test.sh` can drive
# this script against a stub HTTP server without a systemd on the box.
SYSTEMCTL="${BALANCER_WATCHDOG_SYSTEMCTL:-systemctl}"
NODE="${BALANCER_WATCHDOG_NODE:-node}"
# Likewise `journalctl` and `logger`, so the socket leg can be driven against a
# canned journal.
JOURNALCTL="${BALANCER_WATCHDOG_JOURNALCTL:-journalctl}"
LOGGER="${BALANCER_WATCHDOG_LOGGER:-logger}"

mkdir -p "$STATE_DIR"

# --------------------------------------------------------------------------
# THE SUPERVISOR: the whole path, every tick.
#
# Everything above is a NAMED fault with a matched signature. The supervisor is
# the opposite: it asks whether the path a person actually walks — browser →
# Caddy → balancer → node, and browser → Caddy → prover — answers at all, and
# it asks it of every hop, because on 2026/09/05 the sponsor was alive and
# unable to submit for five hours and not one of the rules above was true.
#
# It restarts by unit rather than by hypothesis, holds an exponential backoff
# per unit so a dependency that is genuinely down cannot be turned into a
# restart loop, and stops altogether — with a marker and an alert — once
# restarting has visibly stopped helping.
# --------------------------------------------------------------------------

# Overridable for `test/watchdog.test.sh`, which drives every probe through a
# PATH shim rather than a network.
PYTHON="${BALANCER_WATCHDOG_PYTHON:-python3}"
DOCKER="${BALANCER_WATCHDOG_DOCKER:-docker}"
CURL="${BALANCER_WATCHDOG_CURL:-curl}"

# The public name Caddy serves. Configurable because the droplet's sslip.io
# name follows its IP address, and a second sponsor would have another.
PUBLIC_HOST="${BALANCER_WATCHDOG_PUBLIC_HOST:-67-205-177-162.sslip.io}"
# Resolved to the loopback rather than looked up, so the probe measures OUR
# Caddy and never a DNS answer or somebody else's cache. SNI and Host stay the
# public name, so TLS still verifies properly and the vhost still matches.
PUBLIC_RESOLVE="${BALANCER_WATCHDOG_PUBLIC_RESOLVE:-$PUBLIC_HOST:443:127.0.0.1}"
PROOF_HEALTH="${BALANCER_WATCHDOG_PROOF_HEALTH:-http://127.0.0.1:6300/health}"
PROOF_CONTAINER="${BALANCER_WATCHDOG_PROOF_CONTAINER:-passport-proof-server}"
CADDY_UNIT="${BALANCER_WATCHDOG_CADDY_UNIT:-caddy}"
# Per-probe budget. Five seconds each, and there are five of them, so the whole
# tick fits inside the timer's minute with room for the journal read.
PROBE_TIMEOUT="${BALANCER_WATCHDOG_PROBE_TIMEOUT:-5}"

# Consecutive unhealthy ticks before a unit is restarted. One minute apart, so
# three is three minutes of continuous fault.
SUPERVISOR_STRIKES="${BALANCER_WATCHDOG_SUPERVISOR_STRIKES:-3}"
# A spend in flight blocks a restart until the streak reaches this, at which
# point the job is not in flight, it is stuck, and the person waiting on it has
# been waiting ten minutes.
SUPERVISOR_BUSY_OVERRIDE="${BALANCER_WATCHDOG_BUSY_OVERRIDE:-10}"
# The backoff ladder, per unit: 10 min, 20, 40, capped at 2 h. A dependency
# that is down stays down, and restarting our own service into it every minute
# only adds a cold start to somebody else's outage.
SUPERVISOR_BACKOFF="${BALANCER_WATCHDOG_BACKOFF:-600}"
SUPERVISOR_BACKOFF_CAP="${BALANCER_WATCHDOG_BACKOFF_CAP:-7200}"
# Healthy for this long and the ladder is forgotten — otherwise a unit that
# needed one restart a month ago would wait two hours for its next one.
SUPERVISOR_HEALTHY_RESET="${BALANCER_WATCHDOG_HEALTHY_RESET:-1800}"
# Restarts inside the window after which restarting is admitted not to work.
SUPERVISOR_ESCALATE_RESTARTS="${BALANCER_WATCHDOG_ESCALATE_RESTARTS:-3}"
SUPERVISOR_ESCALATE_WINDOW="${BALANCER_WATCHDOG_ESCALATE_WINDOW:-7200}"
# A restarting service reads unhealthy for a few seconds through no fault of
# its own, so nothing strikes it while it is coming back.
SUPERVISOR_GRACE="${BALANCER_WATCHDOG_GRACE:-120}"
# One reboot per six hours, and only when WATCHDOG_REBOOT=1 is set in the
# environment file. Off by default: a reboot is the one action here that takes
# the droplet away from an operator who may be looking at it.
SUPERVISOR_REBOOT_INTERVAL="${BALANCER_WATCHDOG_REBOOT_INTERVAL:-21600}"
# A line to the webhook at most this often, so a webhook that has quietly
# stopped delivering is noticed on a quiet day rather than during an outage.
SUPERVISOR_HEARTBEAT="${BALANCER_WATCHDOG_HEARTBEAT:-86400}"

# The thresholds `/status` is judged against.
SOCKET_FAILURES_MAX="${BALANCER_WATCHDOG_SOCKET_FAILURES_MAX:-3}"
BEHIND_HEAD_MAX="${BALANCER_WATCHDOG_BEHIND_HEAD_MAX:-50}"

# --------------------------------------------------------------------------
# THE TWO FLOORS, AND WHY THEY ALERT AND DO NOTHING ELSE.
#
# Every other rule in this script matches a fault a restart can repair. These
# two match the one fault it cannot: a sponsor that is running out of money.
# Restarting a wallet with 40 NIGHT in it produces a wallet with 40 NIGHT in it
# and a cold chain walk, and no amount of supervision refills an address — only
# a person with the faucet can. So the floors are ALERT-ONLY. They take no
# strike, they restart nothing, they never reach the escalation ladder, and
# they cannot turn `ok` into `degraded`: the summary line still describes the
# path, and the floor is carried beside it.
#
# The figures are stock levels rather than fault thresholds, which is why they
# are generous. 500 NIGHT is roughly a week of grants at the deployed ceilings,
# so an alert is a reminder with a week in hand rather than an emergency. The
# DUST floor of 5e18 Specks is about a fifth of a healthy balance — the sponsor
# held 24,990,017,628,947,616,000 on a good day — and low DUST with NIGHT still
# held is a different fault from an empty wallet, one the wedge leg above owns;
# what this catches is the slow version of it that no single reading looks
# wrong enough to report.
#
# ONCE PER SIX HOURS, per floor, and that is the whole of the rate limiting. A
# balance below a floor stays below it — nothing here spends it back up — so a
# floor that alerted every minute would post 1,440 identical lines a day and be
# muted within the hour, which is the same as not having it. Six hours is four
# reminders a day: enough that a top-up cannot be forgotten, few enough that
# each one is still read.
#
# `WATCHDOG_NIGHT_FLOOR` is in whole NIGHT, because that is the unit a person
# tops up in. `WATCHDOG_DUST_FLOOR_SPECKS` is in Specks, because DUST has no
# other unit anybody uses. Either set to 0 switches its floor off.
# --------------------------------------------------------------------------
NIGHT_FLOOR="${WATCHDOG_NIGHT_FLOOR:-500}"
DUST_FLOOR_SPECKS="${WATCHDOG_DUST_FLOOR_SPECKS:-5000000000000000000}"
# Seconds between two alerts about the same floor.
FLOOR_ALERT_INTERVAL="${WATCHDOG_FLOOR_ALERT_INTERVAL:-21600}"
NIGHT_FLOOR_FILE="$STATE_DIR/supervisor-last-night-floor-alert"
DUST_FLOOR_FILE="$STATE_DIR/supervisor-last-dust-floor-alert"
# What `proving` must read. Empty switches the term off, for a deployment that
# proves in-process on purpose.
PROVING_EXPECT="${BALANCER_WATCHDOG_PROVING_EXPECT:-server}"

ESCALATED_FILE="$STATE_DIR/supervisor-escalated"
HEARTBEAT_FILE="$STATE_DIR/supervisor-last-heartbeat"
REBOOT_FILE="$STATE_DIR/supervisor-last-reboot"
RESTART_LOG="$STATE_DIR/supervisor-restart-log-balancer"

slog() { echo "[supervisor] $*"; }

# A file holding one non-negative integer, or 0 for anything else. Every clock
# and counter below is one of these, because they must survive the restart they
# bound and a file is the only store that does.
read_num() {
  local value
  value=$(cat "$1" 2>/dev/null || echo 0)
  case "$value" in ''|*[!0-9]*) echo 0 ;; *) echo "$value" ;; esac
}

NOW=$(date +%s)

# --------------------------------------------------------------------------
# The alerting hook.
#
# `WATCHDOG_ALERT_WEBHOOK` comes from /etc/passport-balancer-watchdog.env via
# the unit's `EnvironmentFile=-`, so it is not in this repository and not on
# any command line. It is never logged: the only thing written about it is
# whether a post was attempted.
# --------------------------------------------------------------------------

alert() {
  [ -n "${WATCHDOG_ALERT_WEBHOOK:-}" ] || return 0
  local payload
  payload=$(WATCHDOG_ALERT_TEXT="$*" "$PYTHON" -c 'import json,os;print(json.dumps({"text":os.environ["WATCHDOG_ALERT_TEXT"]}))' 2>/dev/null) || return 0
  # `-s` and not `-sS`: an error from curl would carry the URL, and the URL is
  # the secret. Failure to alert is never allowed to fail the tick.
  "$CURL" -s -o /dev/null -X POST \
    -H 'content-type: application/json' \
    --max-time "$PROBE_TIMEOUT" \
    -d "$payload" \
    "$WATCHDOG_ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

# --------------------------------------------------------------------------
# Per-unit strikes, restart clocks, and the backoff ladder.
# --------------------------------------------------------------------------

sv_strike_file()  { echo "$STATE_DIR/supervisor-strikes-$1"; }
sv_restart_file() { echo "$STATE_DIR/supervisor-last-restart-$1"; }
sv_count_file()   { echo "$STATE_DIR/supervisor-restarts-$1"; }
sv_healthy_file() { echo "$STATE_DIR/supervisor-healthy-since-$1"; }

# The last time ANYTHING in this script restarted the balancer, not merely the
# supervisor: the legs above have their own clocks, and a strike for a service
# that the DUST leg stopped four seconds ago is a strike for our own doing.
sv_last_balancer_restart() {
  local newest=0 file value
  for file in "$(sv_restart_file balancer)" "$RESTART_FILE" "$SOCKET_RESTART_FILE" "$DUST_RESYNC_FILE"; do
    value=$(read_num "$file")
    [ "$value" -gt "$newest" ] && newest=$value
  done
  echo "$newest"
}

# 0, then 600 s, 1200, 2400, … capped. The count is the number of restarts of
# this unit that have not yet been followed by a settled period of health.
sv_backoff() {
  local count="$1" wait="$SUPERVISOR_BACKOFF" i
  [ "$count" -le 0 ] && { echo 0; return; }
  i=1
  while [ "$i" -lt "$count" ]; do
    wait=$((wait * 2))
    [ "$wait" -ge "$SUPERVISOR_BACKOFF_CAP" ] && { wait=$SUPERVISOR_BACKOFF_CAP; break; }
    i=$((i + 1))
  done
  echo "$wait"
}

# Bookkeeping for one component, given whether this tick found it healthy.
# Returns the strike count on stdout. Healthy resets the strikes, and a long
# enough spell of health also forgets the backoff ladder.
sv_account() {
  local comp="$1" healthy="$2" strikes since count last
  if [ "$healthy" = 1 ]; then
    echo 0 > "$(sv_strike_file "$comp")"
    since=$(read_num "$(sv_healthy_file "$comp")")
    if [ "$since" -eq 0 ]; then
      echo "$NOW" > "$(sv_healthy_file "$comp")"
    elif [ $((NOW - since)) -ge "$SUPERVISOR_HEALTHY_RESET" ]; then
      count=$(read_num "$(sv_count_file "$comp")")
      [ "$count" -ne 0 ] && echo 0 > "$(sv_count_file "$comp")"
    fi
    echo 0
    return
  fi
  rm -f "$(sv_healthy_file "$comp")" 2>/dev/null
  strikes=$(read_num "$(sv_strike_file "$comp")")
  # Nothing strikes a unit inside the grace window after it was restarted: it
  # is coming back, and counting that is counting our own restart against it.
  if [ "$comp" = balancer ]; then
    last=$(sv_last_balancer_restart)
  else
    last=$(read_num "$(sv_restart_file "$comp")")
  fi
  if [ "$last" -ne 0 ] && [ $((NOW - last)) -lt "$SUPERVISOR_GRACE" ]; then
    echo "$strikes"
    return
  fi
  strikes=$((strikes + 1))
  echo "$strikes" > "$(sv_strike_file "$comp")"
  echo "$strikes"
}

# Whether a restart of this component is allowed right now: enough strikes,
# not mid-spend, and past its own backoff. The reason it is not is left in
# `sv_hold_reason` for the summary line.
sv_hold_reason=""
sv_may_restart() {
  local comp="$1" strikes="$2" last count wait
  sv_hold_reason=""
  [ "$strikes" -ge "$SUPERVISOR_STRIKES" ] || { sv_hold_reason="strike $strikes of $SUPERVISOR_STRIKES"; return 1; }
  if [ "$sv_busy" = 1 ] || [ "$sv_jobs" -gt 0 ]; then
    if [ "$strikes" -lt "$SUPERVISOR_BUSY_OVERRIDE" ]; then
      sv_hold_reason="a spend is in flight (busy=$sv_busy jobs=$sv_jobs) and the streak is $strikes of $SUPERVISOR_BUSY_OVERRIDE"
      return 1
    fi
  fi
  if [ "$comp" = balancer ]; then
    last=$(sv_last_balancer_restart)
  else
    last=$(read_num "$(sv_restart_file "$comp")")
  fi
  count=$(read_num "$(sv_count_file "$comp")")
  wait=$(sv_backoff "$count")
  if [ "$last" -ne 0 ] && [ $((NOW - last)) -lt "$wait" ]; then
    sv_hold_reason="the last $comp restart was $((NOW - last)) s ago and the backoff after $count restart(s) is ${wait} s"
    return 1
  fi
  return 0
}

# Records a restart against a component: its clock, its ladder, its strikes.
sv_record_restart() {
  local comp="$1" count
  count=$(read_num "$(sv_count_file "$comp")")
  echo "$NOW" > "$(sv_restart_file "$comp")"
  echo $((count + 1)) > "$(sv_count_file "$comp")"
  echo 0 > "$(sv_strike_file "$comp")"
  rm -f "$(sv_healthy_file "$comp")" 2>/dev/null
  if [ "$comp" = balancer ]; then
    # The 2 h window the escalation rule reads. Trimmed to the last ten lines
    # so the file cannot grow without bound on a droplet nobody is watching.
    echo "$NOW" >> "$RESTART_LOG"
    tail -10 "$RESTART_LOG" > "$RESTART_LOG.tmp" 2>/dev/null && mv "$RESTART_LOG.tmp" "$RESTART_LOG"
  fi
}

# How many balancer restarts fall inside the escalation window.
sv_recent_balancer_restarts() {
  local count=0 line
  while read -r line; do
    case "$line" in ''|*[!0-9]*) continue ;; esac
    [ $((NOW - line)) -le "$SUPERVISOR_ESCALATE_WINDOW" ] && count=$((count + 1))
  done < <(cat "$RESTART_LOG" 2>/dev/null)
  echo "$count"
}

# --------------------------------------------------------------------------
# The summary line, and the daily heartbeat, written whichever leg exits.
# --------------------------------------------------------------------------

SV_FACTS=""
SV_ACTIONS=""
SV_DEGRADED=0
sv_note() { SV_ACTIONS="${SV_ACTIONS:+$SV_ACTIONS; }$*"; }

sv_summary() {
  local last
  if [ "$SV_DEGRADED" = 0 ]; then
    slog "ok: ${SV_FACTS:-no probes ran}${SV_ACTIONS:+ — $SV_ACTIONS}"
  else
    slog "degraded: ${SV_FACTS:-no probes ran}${SV_ACTIONS:+ — $SV_ACTIONS}"
  fi
  last=$(read_num "$HEARTBEAT_FILE")
  if [ $((NOW - last)) -ge "$SUPERVISOR_HEARTBEAT" ]; then
    echo "$NOW" > "$HEARTBEAT_FILE"
    alert "passport supervisor heartbeat — ${SV_FACTS:-no probes ran}"
  fi
}

# --------------------------------------------------------------------------
# The probes. Five of them, each five seconds at worst, none of them able to
# fail the tick.
# --------------------------------------------------------------------------


# Prints the HTTP status code, or 000 when nothing answered at all.
sv_http_code() {
  local url="$1" resolve="${2:-}" code
  if [ -n "$resolve" ]; then
    code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" --resolve "$resolve" "$url" 2>/dev/null)
  else
    code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$url" 2>/dev/null)
  fi
  case "$code" in ''|*[!0-9]*) code=000 ;; esac
  echo "$code"
}

# `/status` read whole rather than grepped: these are seven terms, three of
# them numeric, and a `grep` for `"synced":true` cannot tell a missing key from
# a false one. Prints `verdict|busy|jobs|floors|reasons`.
#
# `floors` is separated from `reasons` deliberately and is not a reason: a
# sponsor running low on NIGHT is answering every request perfectly and must not
# be struck, restarted, or called degraded for it. See the floors' own note
# above. The comparison happens HERE rather than in the shell because these are
# balances: 24,990,017,628,947,616,000 Specks overflows a 64-bit shell integer
# and would compare as a negative number.
SV_STATUS_PY=$(cat <<'PY'
import json, os, sys

try:
    body = json.load(sys.stdin)
except Exception:
    print('unreadable|0|0||status-unparseable')
    raise SystemExit(0)
if not isinstance(body, dict):
    print('unreadable|0|0||status-not-an-object')
    raise SystemExit(0)

def number(value, fallback=0):
    try:
        return int(value)
    except Exception:
        return fallback

reasons = []
# `synced`, which is the sponsor's READINESS answer, and deliberately not
# `syncedStrict` beside it. A wallet that has applied its own submission ahead
# of the indexer's last progress report is strictly incomplete and perfectly
# able to pay: judging the strict field struck a healthy sponsor once a spend
# on 2026/09/08. `syncedStrict` and `syncAhead` are published for an operator
# reading the body by hand, and are not grounds for a strike.
if body.get('synced') is not True:
    reasons.append('synced:%s' % body.get('synced'))
# `connected`, or the key missing altogether on a build that predates it.
# `reconnecting` and `dead` are both the fault of 2026/09/05.
socket = body.get('nodeSocket')
if socket is not None and socket != 'connected':
    reasons.append('nodeSocket:%s' % socket)
failures = number(body.get('consecutiveSocketFailures', 0))
if failures >= number(os.environ.get('SV_SOCKET_FAILURES_MAX'), 3):
    reasons.append('consecutiveSocketFailures:%d' % failures)
for key in ('aliasSponsorship', 'accountFunding'):
    if body.get(key) != 'available':
        reasons.append('%s:%s' % (key, body.get(key)))
expect = os.environ.get('SV_PROVING_EXPECT') or ''
if expect and body.get('proving') != expect:
    reasons.append('proving:%s' % body.get('proving'))
# Only judged where the service publishes it.
behind = body.get('appliedBehindHeadBlocks')
if isinstance(behind, (int, float)) and not isinstance(behind, bool):
    if behind > number(os.environ.get('SV_BEHIND_HEAD_MAX'), 50):
        reasons.append('appliedBehindHeadBlocks:%d' % int(behind))

busy = 1 if (body.get('busy') is True or body.get('balancing') is True) else 0
jobs = number(body.get('jobsRunning', 0))

# The stock levels, named only where they are under. A floor of 0 is off, and a
# balance the service did not publish is not a balance of nothing — an older
# build, or a `/status` that could not read the wallet, must not be reported as
# an empty sponsor.
floors = []
night_floor = number(os.environ.get('SV_NIGHT_FLOOR'), 0)
if night_floor > 0:
    held = body.get('balanceAtomic')
    if isinstance(held, str) and held.isdigit():
        # `balanceAtomic` is atomic NIGHT; NIGHT_DECIMALS is 6. See `src/wallet.ts`.
        atomic = int(held)
        if atomic < night_floor * 1000000:
            floors.append('night=%s' % (atomic / 1000000.0))
dust_floor = number(os.environ.get('SV_DUST_FLOOR_SPECKS'), 0)
if dust_floor > 0:
    specks = body.get('dustSpecks')
    if isinstance(specks, str) and specks.isdigit() and int(specks) < dust_floor:
        floors.append('dust=%s' % specks)

print('%s|%d|%d|%s|%s' % ('ok' if not reasons else 'unhealthy', busy, jobs,
                          ';'.join(floors), ','.join(reasons)))
PY
)

sv_read_status() {
  printf '%s' "$status" \
    | SV_SOCKET_FAILURES_MAX="$SOCKET_FAILURES_MAX" \
      SV_BEHIND_HEAD_MAX="$BEHIND_HEAD_MAX" \
      SV_PROVING_EXPECT="$PROVING_EXPECT" \
      SV_NIGHT_FLOOR="$NIGHT_FLOOR" \
      SV_DUST_FLOOR_SPECKS="$DUST_FLOOR_SPECKS" \
      "$PYTHON" -c "$SV_STATUS_PY" 2>/dev/null \
    || echo 'unreadable|0|0||status-unparseable'
}

strikes=$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)
case "$strikes" in ''|*[!0-9]*) strikes=0 ;; esac

wallet_status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/wallet-status" 2>/dev/null)
curl_rc=$?
status=$(curl -fsS --max-time "$TIMEOUT" "$BASE/status" 2>/dev/null)

# --------------------------------------------------------------------------
# The tick's probes, taken BEFORE any leg acts, so the summary line describes
# the same droplet whichever leg exits and the strike counters keep advancing
# even on a tick some earlier rule ends.
# --------------------------------------------------------------------------

if [ -z "$status" ]; then
  sv_verdict=unreachable
  sv_busy=0
  sv_jobs=0
  sv_floors=""
  sv_reasons="/status did not answer"
else
  sv_parsed=$(sv_read_status)
  sv_verdict=${sv_parsed%%|*}
  sv_rest=${sv_parsed#*|}
  sv_busy=${sv_rest%%|*}
  sv_rest=${sv_rest#*|}
  sv_jobs=${sv_rest%%|*}
  sv_rest=${sv_rest#*|}
  sv_floors=${sv_rest%%|*}
  sv_reasons=${sv_rest#*|}
fi
case "$sv_busy" in ''|*[!0-9]*) sv_busy=0 ;; esac
case "$sv_jobs" in ''|*[!0-9]*) sv_jobs=0 ;; esac

sv_proof_code=$(sv_http_code "$PROOF_HEALTH")
sv_public_prover=$(sv_http_code "https://$PUBLIC_HOST/prover/health" "$PUBLIC_RESOLVE")
sv_public_balancer=$(sv_http_code "https://$PUBLIC_HOST/balancer/status" "$PUBLIC_RESOLVE")

sv_caddy=$("$SYSTEMCTL" is-active "$CADDY_UNIT" 2>/dev/null | tr -d '[:space:]')
[ -n "$sv_caddy" ] || sv_caddy=unknown
sv_container=$("$DOCKER" inspect -f '{{.State.Running}}' "$PROOF_CONTAINER" 2>/dev/null | tr -d '[:space:]')
case "$sv_container" in true) sv_container=running ;; false) sv_container=stopped ;; *) sv_container=missing ;; esac

# Healthy, one component at a time.
sv_balancer_ok=0; [ "$sv_verdict" = ok ] && sv_balancer_ok=1
sv_proof_ok=0
[ "$sv_proof_code" = 200 ] && [ "$sv_container" = running ] && sv_proof_ok=1
# Caddy is judged on the public path as well as on its own unit: a Caddy that
# is `active` and answering 502 for everything is down as far as anybody
# outside the droplet is concerned.
sv_caddy_ok=0
if [ "$sv_caddy" = active ] && [ "$sv_public_balancer" = 200 ]; then
  # The prover path is allowed to be as unwell as the prover behind it — that
  # is the proof server's fault, not Caddy's, and it has its own leg.
  if [ "$sv_public_prover" = 200 ] || [ "$sv_proof_ok" = 0 ]; then sv_caddy_ok=1; fi
fi

sv_balancer_strikes=$(sv_account balancer "$sv_balancer_ok")
sv_proof_strikes=$(sv_account proof "$sv_proof_ok")
sv_caddy_strikes=$(sv_account caddy "$sv_caddy_ok")

SV_FACTS="balancer=$sv_verdict${sv_reasons:+ ($sv_reasons)} busy=$sv_busy jobs=$sv_jobs; proof=$sv_proof_code container=$sv_container; caddy=$sv_caddy public=$sv_public_balancer/$sv_public_prover${sv_floors:+; floors $sv_floors}"

# --------------------------------------------------------------------------
# The floors. Alert, at most once per six hours per floor, and nothing else.
#
# Deliberately placed AFTER `SV_FACTS` is built and BEFORE the escalation gate:
# the figure belongs on the summary line whatever else the tick decides, and a
# supervisor that has stopped restarting things has not stopped needing money.
# It reads only what has already been fetched, so it costs no probe and cannot
# fail the tick. `sv_floor_alert` is the whole of the logic: a clock per floor,
# on disk because it has to outlive the restarts everything else here performs.
# --------------------------------------------------------------------------
sv_floor_alert() {
  local file="$1" text="$2" last
  last=$(read_num "$file")
  if [ $((NOW - last)) -lt "$FLOOR_ALERT_INTERVAL" ]; then
    return 0
  fi
  echo "$NOW" > "$file"
  slog "$text"
  alert "$text"
}

case "$sv_floors" in
  *night=*)
    sv_floor_night=${sv_floors#*night=}
    sv_floor_night=${sv_floor_night%%;*}
    sv_floor_alert "$NIGHT_FLOOR_FILE" \
      "passport sponsor is low on NIGHT — holding ${sv_floor_night} NIGHT, under the ${NIGHT_FLOOR} NIGHT floor. Nothing is broken and nothing has been restarted; the address needs topping up from the faucet before it runs out." ;;
esac
case "$sv_floors" in
  *dust=*)
    sv_floor_dust=${sv_floors#*dust=}
    sv_floor_dust=${sv_floor_dust%%;*}
    sv_floor_alert "$DUST_FLOOR_FILE" \
      "passport sponsor is low on DUST — ${sv_floor_dust} Specks, under the ${DUST_FLOOR_SPECKS} Speck floor. DUST is generated by the NIGHT this wallet holds, so this is either a wallet spending faster than it generates or NIGHT that has left it; nothing has been restarted." ;;
esac
if [ "$sv_balancer_ok" = 1 ] && [ "$sv_proof_ok" = 1 ] && [ "$sv_caddy_ok" = 1 ]; then
  SV_DEGRADED=0
else
  SV_DEGRADED=1
  SV_FACTS="$SV_FACTS; strikes balancer=$sv_balancer_strikes proof=$sv_proof_strikes caddy=$sv_caddy_strikes"
fi

# One summary line per tick, whichever leg below ends the script, and the
# daily heartbeat with it.
trap sv_summary EXIT

# --------------------------------------------------------------------------
# ESCALATION, asked before anything can act.
#
# Once restarting has been tried SUPERVISOR_ESCALATE_RESTARTS times inside the
# window and the balancer is still unhealthy, restarting is not the repair and
# doing it again only hides the fault from whoever has to find it. Every
# restart path in this script — this one and the three signature legs above —
# is off while the marker is there, and it is removed the moment the balancer
# reads healthy again.
# --------------------------------------------------------------------------

if [ -f "$ESCALATED_FILE" ]; then
  if [ "$sv_balancer_ok" = 1 ]; then
    rm -f "$ESCALATED_FILE" 2>/dev/null
    echo 0 > "$(sv_count_file balancer)"
    : > "$RESTART_LOG"
    sv_note "the balancer is healthy again — escalation cleared, restarts allowed"
    slog "ESCALATION CLEARED: the balancer answers healthy again"
    alert "passport supervisor: escalation cleared — the balancer is healthy again"
  else
    sv_note "ESCALATED since $(cat "$ESCALATED_FILE" 2>/dev/null | head -1) — not restarting anything; this needs a person"
    slog "ESCALATED: $SV_FACTS — restarting has been tried and did not help, so nothing is being restarted"
    if [ "${WATCHDOG_REBOOT:-0}" = 1 ]; then
      sv_last_reboot=$(read_num "$REBOOT_FILE")
      if [ $((NOW - sv_last_reboot)) -ge "$SUPERVISOR_REBOOT_INTERVAL" ]; then
        echo "$NOW" > "$REBOOT_FILE"
        slog "WATCHDOG_REBOOT is set and the last reboot was $((NOW - sv_last_reboot)) s ago — rebooting the droplet"
        "$LOGGER" -t passport-ops "supervisor rebooting the droplet: escalated and WATCHDOG_REBOOT=1"
        alert "passport supervisor: escalated and WATCHDOG_REBOOT=1 — rebooting the droplet"
        "$SYSTEMCTL" reboot
      fi
    fi
    exit 0
  fi
fi

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

# --------------------------------------------------------------------------
# A DEAD SUBMISSION SOCKET.
#
# Asked before the readiness check for the same reason as the wedge: on
# 2026/09/05 this failure was invisible from both endpoints. /wallet-status
# answered ready:true and /status answered synced:true, busy:false, and both
# sponsorships available, for the four and a half hours in which every single
# transaction the service submitted failed instantly on a websocket that was not
# there — 520 of them, every name registration, every activation grant, and
# every mUSD mint. The service now rebuilds that socket itself and exits when it
# cannot; this is the backstop for the case where neither happens, and its
# evidence is the one place the fault was always visible: the journal.
#
# Three transport failures inside the window with NO submission acknowledged
# between them. The acknowledgement line is `./src/submission.ts`'s, written on
# every submission the node takes, so its absence across the window is what
# separates a socket that is gone from one that dropped and came back.
# --------------------------------------------------------------------------

journal=$("$JOURNALCTL" -u "$UNIT" --since "-$SOCKET_WINDOW" --no-pager -o cat 2>/dev/null)

socket_dead() {
  [ -n "$journal" ] || return 1
  ws_failures=$(printf '%s\n' "$journal" | grep -c 'WebSocket is not connected')
  [ "$ws_failures" -ge "$SOCKET_STRIKES" ] || return 1
  # Not one submission got through in the same window. A socket that dropped and
  # recovered has acknowledgements among the failures; this one has none.
  printf '%s\n' "$journal" | grep -q 'the node acknowledged this transaction' && return 1
  return 0
}

if socket_dead; then
  now=$(date +%s)
  last_socket=$(cat "$SOCKET_RESTART_FILE" 2>/dev/null || echo 0)
  case "$last_socket" in ''|*[!0-9]*) last_socket=0 ;; esac
  if [ $((now - last_socket)) -lt "$SOCKET_COOLDOWN" ]; then
    log "the submission socket looks dead ($ws_failures failures), but the last socket restart was $((now - last_socket)) s ago and the cooldown is ${SOCKET_COOLDOWN} s"
    exit 0
  fi
  log "THE SUBMISSION SOCKET IS DEAD: $ws_failures 'WebSocket is not connected' line(s) in the last $SOCKET_WINDOW with nothing acknowledged — restarting $UNIT"
  # The one marker an operator greps for after the fact, and the only line this
  # script writes outside its own unit's journal.
  "$LOGGER" -t passport-ops "balancer restarted: submission socket dead, $ws_failures WebSocket failures in the last $SOCKET_WINDOW with no acknowledged submission"
  echo "$now" > "$SOCKET_RESTART_FILE"
  echo 0 > "$STRIKES_FILE"
  "$SYSTEMCTL" restart "$UNIT"
  exit 0
fi

# --------------------------------------------------------------------------
# A spend job that has gone silent while holding a lane.
#
# Asked BEFORE the readiness check, because this failure looks perfectly
# healthy from outside: on 2026/09/02 /wallet-status answered ready:true
# throughout both hangs. The whole signature is in /status now — a job running,
# nothing of ours at the prover, and no step reported for minutes. A job that is
# proving reports nothing too, which is why proofInFlight is not optional here.
# --------------------------------------------------------------------------

job_stalled() {
  [ -n "$status" ] || return 1
  printf '%s' "$status" | grep -q '"proofInFlight":false' || return 1
  printf '%s' "$status" | grep -Eq '"jobsRunning":[1-9]' || return 1
  # The worst of the running jobs, in milliseconds. `sort -n | tail -1` rather
  # than the first match: with several lanes the stalled one need not be first.
  stalled_ms=$(printf '%s' "$status" \
    | grep -Eo '"sinceProgressMs":[0-9]+' \
    | grep -Eo '[0-9]+' \
    | sort -n \
    | tail -1)
  [ -n "$stalled_ms" ] || return 1
  [ "$((stalled_ms / 1000))" -ge "$JOB_STALL" ] || return 1
  return 0
}

if job_stalled; then
  now=$(date +%s)
  last=$(cat "$RESTART_FILE" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -lt "$COOLDOWN" ]; then
    log "a spend job has been silent for $((stalled_ms / 1000)) s, but the last watchdog restart was $((now - last)) s ago and the cooldown is ${COOLDOWN} s"
    exit 0
  fi
  step=$(printf '%s' "$status" | grep -Eo '"step":"[^"]*"' | head -1 | cut -d'"' -f4)
  log "A SPEND JOB IS WEDGED: silent for $((stalled_ms / 1000)) s at step ${step:-unknown} with nothing at the prover — restarting $UNIT"
  echo "$now" > "$RESTART_FILE"
  echo 0 > "$STRIKES_FILE"
  "$SYSTEMCTL" restart "$UNIT"
  exit 0
fi

# --------------------------------------------------------------------------
# THE SUPERVISOR'S ACTIONS.
#
# At most one restart per tick, front door first: a Caddy that is not answering
# makes every other probe from outside the droplet look broken, so it is asked
# first and the ones behind it are given another minute to be judged on their
# own.
# --------------------------------------------------------------------------

# --- Caddy ----------------------------------------------------------------
# The distinction that matters here is `reload` against `restart`. A restart
# writes Caddy's whole environment into the journal — `ExecStart` carries
# `--environ` — and that environment holds the 1AM gateway key. So a Caddy that
# is running but not serving is reloaded, which does not, and only a Caddy that
# is not running at all is restarted.
if [ "$sv_caddy_ok" = 0 ]; then
  if sv_may_restart caddy "$sv_caddy_strikes"; then
    sv_record_restart caddy
    if [ "$sv_caddy" = active ]; then
      slog "RELOADING $CADDY_UNIT: it is active but the public path answers $sv_public_balancer/$sv_public_prover while the local probes pass"
      sv_note "reloaded $CADDY_UNIT"
      "$LOGGER" -t passport-ops "caddy reloaded: public path answering $sv_public_balancer/$sv_public_prover with the local balancer and prover reachable"
      alert "passport supervisor: reloading caddy — public $sv_public_balancer/$sv_public_prover, local probes pass"
      "$SYSTEMCTL" reload "$CADDY_UNIT"
    else
      slog "RESTARTING $CADDY_UNIT: systemctl reports it $sv_caddy"
      sv_note "restarted $CADDY_UNIT"
      "$LOGGER" -t passport-ops "caddy restarted: systemctl reported it $sv_caddy"
      alert "passport supervisor: restarting caddy — systemctl reports it $sv_caddy"
      "$SYSTEMCTL" restart "$CADDY_UNIT"
    fi
    exit 0
  fi
  sv_note "$CADDY_UNIT is unwell but held: $sv_hold_reason"
fi

# --- The proof server -----------------------------------------------------
# `restart=always` already brings the container back from a crash; what it
# cannot do is notice a prover that is up and no longer answering, which is
# what /health is for.
if [ "$sv_proof_ok" = 0 ]; then
  if sv_may_restart proof "$sv_proof_strikes"; then
    sv_record_restart proof
    slog "RESTARTING $PROOF_CONTAINER: /health answered $sv_proof_code and the container reads $sv_container, for $sv_proof_strikes tick(s)"
    sv_note "restarted $PROOF_CONTAINER"
    "$LOGGER" -t passport-ops "proof server restarted: /health $sv_proof_code, container $sv_container, $sv_proof_strikes consecutive ticks"
    alert "passport supervisor: restarting $PROOF_CONTAINER — /health $sv_proof_code, container $sv_container"
    "$DOCKER" restart "$PROOF_CONTAINER"
    exit 0
  fi
  sv_note "$PROOF_CONTAINER is unwell but held: $sv_hold_reason"
fi

# --- The balancer ---------------------------------------------------------
# This is the leg that would have ended the five hours of 2026/09/05: the
# service was alive, answering, and unable to submit, and every term of the
# verdict above is one of the things it was publishing at the time.
if [ "$sv_balancer_ok" = 0 ]; then
  if sv_may_restart balancer "$sv_balancer_strikes"; then
    sv_recent=$(sv_recent_balancer_restarts)
    if [ "$sv_recent" -ge "$SUPERVISOR_ESCALATE_RESTARTS" ]; then
      # Three restarts inside the window have not fixed it, so a fourth will
      # not either. The marker is the whole point: it stops this script and it
      # tells whoever reads the state directory why nothing is happening.
      printf '%s escalated after %s restart(s) in %s s, still unhealthy: %s\n' \
        "$(date -u +%Y/%m/%dT%H:%M:%SZ)" "$sv_recent" "$SUPERVISOR_ESCALATE_WINDOW" "$sv_reasons" \
        > "$ESCALATED_FILE"
      slog "ESCALATING: $sv_recent restart(s) of $UNIT inside ${SUPERVISOR_ESCALATE_WINDOW} s and it is still unhealthy ($sv_reasons) — no further restarts"
      sv_note "escalated; no further restarts"
      "$LOGGER" -t passport-ops "supervisor escalated: $sv_recent balancer restarts in ${SUPERVISOR_ESCALATE_WINDOW} s and still unhealthy ($sv_reasons)"
      alert "passport supervisor: ESCALATED — $sv_recent restarts of $UNIT in ${SUPERVISOR_ESCALATE_WINDOW} s and it is still unhealthy ($sv_reasons). No further restarts; this needs a person."
      exit 0
    fi
    sv_record_restart balancer
    # Kept in step with the legs above, which share this clock.
    echo "$NOW" > "$RESTART_FILE"
    echo 0 > "$STRIKES_FILE"
    slog "RESTARTING $UNIT after $sv_balancer_strikes unhealthy tick(s): $sv_reasons"
    sv_note "restarted $UNIT"
    "$LOGGER" -t passport-ops "balancer restarted by the supervisor: $sv_balancer_strikes unhealthy tick(s) — $sv_reasons"
    alert "passport supervisor: restarting $UNIT — unhealthy for $sv_balancer_strikes tick(s) ($sv_reasons)"
    "$SYSTEMCTL" restart "$UNIT"
    exit 0
  fi
  sv_note "$UNIT is unwell but held: $sv_hold_reason"
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
