#!/usr/bin/env bash
# Temporarily set kernel parameters recommended by neard.
# Saves current values and restores them on exit or Ctrl-C.
# Run as root or with sudo.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

get_sysctl() { sysctl -n "$1" 2>/dev/null || echo "MISSING"; }

set_sysctl() {
    local key="$1" val="$2"
    if [[ "$val" == "MISSING" ]]; then
        echo "  skipping $key (not available on this kernel)"
    else
        sysctl -w "$key=$val" > /dev/null
        echo "  $key = $val"
    fi
}

# ---------------------------------------------------------------------------
# Save current values
# ---------------------------------------------------------------------------

ORIG_RMEM_MAX=$(get_sysctl net.core.rmem_max)
ORIG_WMEM_MAX=$(get_sysctl net.core.wmem_max)
ORIG_TCP_RMEM=$(get_sysctl net.ipv4.tcp_rmem)
ORIG_TCP_WMEM=$(get_sysctl net.ipv4.tcp_wmem)
ORIG_SLOW_START=$(get_sysctl net.ipv4.tcp_slow_start_after_idle)
ORIG_CONGESTION=$(get_sysctl net.ipv4.tcp_congestion_control)
ORIG_DEFAULT_QDISC=$(get_sysctl net.core.default_qdisc)
ORIG_MTU_PROBING=$(get_sysctl net.ipv4.tcp_mtu_probing)
ORIG_SYN_BACKLOG=$(get_sysctl net.ipv4.tcp_max_syn_backlog)

# ---------------------------------------------------------------------------
# Restore function
# ---------------------------------------------------------------------------

restore() {
    echo ""
    echo "==> Restoring original kernel parameters..."
    set_sysctl net.core.rmem_max              "$ORIG_RMEM_MAX"
    set_sysctl net.core.wmem_max              "$ORIG_WMEM_MAX"
    set_sysctl net.ipv4.tcp_rmem              "$ORIG_TCP_RMEM"
    set_sysctl net.ipv4.tcp_wmem              "$ORIG_TCP_WMEM"
    set_sysctl net.ipv4.tcp_slow_start_after_idle "$ORIG_SLOW_START"
    set_sysctl net.ipv4.tcp_congestion_control "$ORIG_CONGESTION"
    set_sysctl net.core.default_qdisc         "$ORIG_DEFAULT_QDISC"
    set_sysctl net.ipv4.tcp_mtu_probing       "$ORIG_MTU_PROBING"
    set_sysctl net.ipv4.tcp_max_syn_backlog   "$ORIG_SYN_BACKLOG"
    echo "==> Done."
}

trap restore EXIT INT TERM

# ---------------------------------------------------------------------------
# Apply neard-recommended values
# ---------------------------------------------------------------------------

echo "==> Applying neard-recommended kernel parameters..."
set_sysctl net.core.rmem_max              8388608
set_sysctl net.core.wmem_max              8388608
set_sysctl net.ipv4.tcp_rmem              "4096 87380 8388608"
set_sysctl net.ipv4.tcp_wmem              "4096 16384 8388608"
set_sysctl net.ipv4.tcp_slow_start_after_idle 0
set_sysctl net.ipv4.tcp_congestion_control bbr
set_sysctl net.core.default_qdisc         fq
set_sysctl net.ipv4.tcp_mtu_probing       1
set_sysctl net.ipv4.tcp_max_syn_backlog   8096

# Note: BBR requires the tcp_bbr kernel module. Load it if needed.
if ! lsmod | grep -q tcp_bbr 2>/dev/null; then
    echo "  loading tcp_bbr module..."
    modprobe tcp_bbr 2>/dev/null || echo "  warning: could not load tcp_bbr (may already be built-in or unavailable)"
fi

echo "==> Done. Parameters are active."
echo ""
echo "    Press Ctrl-C or wait for this script to exit to restore originals."
echo "    Or run your neard container now and leave this script running."
echo ""

# ---------------------------------------------------------------------------
# Wait until interrupted
# ---------------------------------------------------------------------------

while true; do sleep 60; done
