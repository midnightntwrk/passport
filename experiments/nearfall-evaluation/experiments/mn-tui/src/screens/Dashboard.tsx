import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import DustMonitor  from '../components/DustMonitor.js';
import {useMidnightNode}  from '../hooks/useMidnightNode.js';
import {useWallet}        from '../hooks/useWallet.js';
import type {NetworkConfig} from '../types.js';
import type {WalletSyncState} from '../hooks/useWalletSync.js';

interface Props {
  network:    NetworkConfig;
  paused:     boolean;
  walletSync: WalletSyncState;
}

/** Format a millisecond duration as "1h 23m", "47m 09s", or "38s". */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

function utcTime(): string {
  return new Date().toISOString().slice(11, 19) + ' UTC';
}

/** Format a raw bigint with 6 implied decimal places (NIGHT / tNIGHT, scale 10^6). */
function fmtNight(raw: bigint): string {
  const abs   = raw < 0n ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac  = abs % 1_000_000n;
  return `${raw < 0n ? '-' : ''}${whole}.${String(frac).padStart(6, '0')}`;
}

/**
 * Format a raw DUST bigint.  1 DUST = 10^15 raw units.
 * Displayed with 6 decimal places (drops sub-nano precision).
 * e.g. 10_000_000_000_000 raw → 0.010000 DUST
 */
function fmtDust(raw: bigint): string {
  const SCALE = 1_000_000_000_000_000n; // 10^15
  const DISP  =         1_000_000_000n; // 10^9  — keeps 6 decimal places
  const abs   = raw < 0n ? -raw : raw;
  const whole = abs / SCALE;
  const frac  = (abs % SCALE) / DISP;
  return `${raw < 0n ? '-' : ''}${whole}.${String(frac).padStart(6, '0')}`;
}

// The native NIGHT token is represented on-chain as 32 zero bytes.
const NIGHT_ID = '0'.repeat(64);

/**
 * Token IDs for custom contract tokens are 64-char hex strings (32 bytes).
 * The native NIGHT token is all zeros — display it as "NIGHT" and scale by 1e6.
 * Other well-known short names (tNIGHT, DUST …) also get 6-decimal scaling.
 */
function tokenLabel(id: string): string {
  return id === NIGHT_ID ? 'NIGHT' : id;
}

function fmtAmount(id: string, raw: bigint): string {
  // Scale by 1e6 for NIGHT and any other short/human-readable token name.
  const isHexToken = id.length >= 32 && /^[0-9a-fA-F]+$/.test(id);
  return (isHexToken && id !== NIGHT_ID) ? String(raw) : fmtNight(raw);
}

// Width of the "type" label column in the balance table.
const TYPE_W  = 12;
// Width reserved for the token-ID column (64 hex chars + 2 padding).
const TOKEN_W = 66;

export default function Dashboard({network, paused, walletSync}: Props) {
  const {node, error: nodeError}             = useMidnightNode(network.nodeUrl, 6_000, paused);
  const {activeWallet, activeIndex, getMnemonic} = useWallet();
  const [clock, setClock]                    = useState(utcTime);

  const mnemonic = getMnemonic(activeIndex);
  const {synced: walletSynced, balances, error: walletError, refreshDustBalance} = walletSync;

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setClock(utcTime()), 6_000);
    return () => clearInterval(id);
  }, [paused]);

  // Refresh the live dust balance whenever the chain section updates so the
  // two sections stay in sync without an independent timer in the wallet hook.
  useEffect(() => {
    refreshDustBalance();
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box flexDirection="column" gap={1}>

      {/* Chain status */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Box gap={2}>
          <Text bold color="cyan">Chain</Text>
          <Text color="yellow">{network.name}</Text>
        </Box>

        {nodeError ? (
          <Text color="red">⚠ {nodeError}</Text>
        ) : (
          <Box flexDirection="row">
            {/* Left column: label + primary value */}
            <Box flexDirection="column" width={24}>
              <Text dimColor>peers <Text color="white">{node.peers}</Text></Text>
              <Text dimColor>epoch <Text color="white">{node.epochIndex}</Text></Text>
              <Text dimColor>slot  <Text color="white">{node.currentSlot}</Text></Text>
              <Text dimColor>block <Text color="white">{node.blockHeight}</Text></Text>
            </Box>
            {/* Right column: secondary values */}
            <Box flexDirection="column" flexGrow={1}>
              <Text color={node.synced ? 'green' : 'red'}>
                {node.synced ? '● synced' : '○ syncing'}
              </Text>
              <Text dimColor>next <Text color="white">{node.msUntilEpoch > 0 ? fmtDuration(node.msUntilEpoch) : '—'}</Text></Text>
              <Text dimColor>{clock}</Text>
              <Text dimColor wrap="truncate">hash <Text color="white">{node.blockHash}</Text></Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Wallet addresses */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold color="cyan">Wallet</Text>
        {!activeWallet ? (
          <Text color="yellow">No wallet loaded — open Keys screen (M-m 7)</Text>
        ) : (
          <>
            <Text dimColor>name        <Text color="white">{activeWallet.name}</Text></Text>
            <Text dimColor>unshielded  <Text color="white" wrap="truncate">{activeWallet.unshielded}</Text></Text>
            <Text dimColor>shielded    <Text color="white" wrap="truncate">{activeWallet.shielded}</Text></Text>
            <Text dimColor>dust        <Text color="white" wrap="truncate">{activeWallet.dust}</Text></Text>
          </>
        )}
      </Box>

      {/* Balances */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Box gap={2}>
          <Text bold color="cyan">Balances</Text>
          {activeWallet && mnemonic && (
            <Text color={walletSynced ? 'green' : 'red'}>
              {walletSynced ? '● synced' : '○ syncing'}
            </Text>
          )}
        </Box>

        {walletError ? (
          <Text color="red">⚠ {walletError}</Text>
        ) : !activeWallet ? (
          <Text dimColor>—</Text>
        ) : !mnemonic ? (
          <Text dimColor color="yellow">locked — unlock in Keys (M-m 7)</Text>
        ) : !balances ? (
          <Text dimColor>awaiting sync…</Text>
        ) : (
          <>
            {Object.entries(balances.unshielded)
              .sort(([a], [b]) => a === NIGHT_ID ? -1 : b === NIGHT_ID ? 1 : a.localeCompare(b))
              .map(([tok, amt]) => (
                <Box key={'u-' + tok} flexDirection="row">
                  <Box width={TYPE_W}><Text dimColor>unshielded</Text></Box>
                  <Box width={TOKEN_W}><Text color="white">{tokenLabel(tok)}</Text></Box>
                  <Box flexGrow={1} justifyContent="flex-end">
                    <Text color="white">{fmtAmount(tok, amt)}</Text>
                  </Box>
                </Box>
              ))}
            {Object.entries(balances.shielded)
              .sort(([a], [b]) => a === NIGHT_ID ? -1 : b === NIGHT_ID ? 1 : a.localeCompare(b))
              .map(([tok, amt]) => (
                <Box key={'s-' + tok} flexDirection="row">
                  <Box width={TYPE_W}><Text dimColor>shielded</Text></Box>
                  <Box width={TOKEN_W}><Text color="white">{tokenLabel(tok)}</Text></Box>
                  <Box flexGrow={1} justifyContent="flex-end">
                    <Text color="white">{fmtAmount(tok, amt)}</Text>
                  </Box>
                </Box>
              ))}
          </>
        )}
      </Box>

      {/* DUST Generation */}
      <DustMonitor
        balance={walletSync.balances?.dust ?? null}
        generation={walletSync.balances?.dustGeneration ?? null}
        registeredNightUtxos={walletSync.balances?.registeredNightUtxos ?? 0}
        dustAccruing={walletSync.balances?.dustAccruing ?? null}
      />

    </Box>
  );
}
