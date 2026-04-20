import React from 'react';
import {Box, Text} from 'ink';
import type {DustGeneration} from '../hooks/useWalletSync.js';

interface Props {
  balance:              bigint | null;
  generation:           DustGeneration | null;
  registeredNightUtxos: number;
  dustAccruing:         boolean | null;
}

/** Format raw NIGHT (÷ 10^6) with 6 decimal places. */
function fmtNight(raw: bigint): string {
  const abs   = raw < 0n ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac  = abs % 1_000_000n;
  return `${raw < 0n ? '-' : ''}${whole}.${String(frac).padStart(6, '0')}`;
}

/** Format raw DUST (÷ 10^15) with 6 decimal places. */
function fmtDust(raw: bigint): string {
  const SCALE = 1_000_000_000_000_000n;
  const DISP  =         1_000_000_000n;
  const abs   = raw < 0n ? -raw : raw;
  const whole = abs / SCALE;
  const frac  = (abs % SCALE) / DISP;
  return `${raw < 0n ? '-' : ''}${whole}.${String(frac).padStart(6, '0')}`;
}

/** Format the remaining time until fillTime as "fills in 72h 01m" or "cap reached". */
function fmtFillTime(d: Date): string {
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'cap reached';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `fills in ${h}h ${String(m).padStart(2, '0')}m`;
  return `fills in ${m}m`;
}

const LBL_W = 14;

export default function DustMonitor({balance, generation, registeredNightUtxos, dustAccruing}: Props) {
  // dustAccruing===false AND generation is present means the SDK still reports
  // active coin parameters but no balance increase has been observed in the
  // last ~60 s.  This is the fingerprint of a cross-wallet registration whose
  // cancellation event hasn't propagated yet, or a filled-but-still-registered
  // UTXO set.  Hide the misleading rate/fill-time and show a warning instead.
  //
  // Exception: if the current balance is at or above the generation limit the
  // wallet is legitimately over-cap (e.g. NIGHT was sent away, lowering the
  // limit below the existing balance).  In that case DUST is correctly decaying
  // to the new equilibrium and no warning should be shown.
  const overCap         = balance !== null && generation !== null && balance >= generation.limit;
  const staleGeneration = generation !== null && dustAccruing === false && !overCap;

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold color="cyan">DUST Generation</Text>
      {balance !== null && (
        <Box gap={2}>
          <Box width={LBL_W}><Text dimColor>balance</Text></Box>
          <Text color="white">{fmtDust(balance)} DUST</Text>
        </Box>
      )}
      {generation === null && registeredNightUtxos === 0 ? (
        <Text dimColor>No NIGHT registered for DUST generation.</Text>
      ) : generation === null ? (
        <Text dimColor>DUST directed to another wallet ({registeredNightUtxos} UTXO{registeredNightUtxos !== 1 ? 's' : ''} registered).</Text>
      ) : staleGeneration ? (
        <>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>designated</Text></Box>
            <Text color="white">{fmtNight(generation.designated)} NIGHT</Text>
          </Box>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>UTXOs</Text></Box>
            <Text color="white">{generation.numUtxos}</Text>
          </Box>
          <Text color="red">⚠ DUST not accruing — rate/fill data may be unreliable</Text>
        </>
      ) : (
        <>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>limit</Text></Box>
            <Text color="white">{fmtDust(generation.limit)} DUST</Text>
          </Box>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>rate</Text></Box>
            <Text color="white">{fmtDust(generation.ratePerDay)} DUST/day</Text>
          </Box>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>fill time</Text></Box>
            <Text color="white">{fmtFillTime(generation.fillTime)}</Text>
          </Box>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>designated</Text></Box>
            <Text color="white">{fmtNight(generation.designated)} NIGHT</Text>
          </Box>
          <Box gap={2}>
            <Box width={LBL_W}><Text dimColor>UTXOs</Text></Box>
            <Text color="white">{generation.numUtxos}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
