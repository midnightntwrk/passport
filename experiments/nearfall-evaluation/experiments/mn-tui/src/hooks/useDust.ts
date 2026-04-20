import {useState, useEffect, useCallback} from 'react';
import type {DustState, DesignateParams, TxStatus} from '../types.js';

// ---------------------------------------------------------------------------
// TODO: Replace stub with real Midnight DUST API calls.
//   Suggested approach:
//     - Query the DUST pallet via RPC to get designated NIGHT and accrual state.
//     - Poll each epoch boundary (or listen to events) to update accrued DUST.
//     - Submit designation via the wallet's pallet-call API.
// ---------------------------------------------------------------------------

const STUB_DUST: DustState = {
  accrued:        12_500_000n,
  designated:     500_000_000n,
  generationRate:   2_500_000n,
  nextEpoch:      1024,
};

export function useDust(pollIntervalMs = 12_000) {
  const [dust, setDust] = useState<DustState>(STUB_DUST);
  const [txStatus, setTxStatus] = useState<TxStatus>({stage: 'idle'});

  // Poll for updated DUST accrual
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(() => {
      if (cancelled) return;
      // TODO: replace with real pallet query
      setDust(prev => ({
        ...prev,
        accrued: prev.accrued + prev.generationRate / 10n,
      }));
    }, pollIntervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollIntervalMs]);

  // ---- designate NIGHT -----------------------------------------------
  // TODO: call wallet.palletCall('dust', 'designate', { amount }) and
  //       stream TxStatus updates.
  const designate = useCallback(async (params: DesignateParams) => {
    setTxStatus({stage: 'building'});
    await delay(500);
    setTxStatus({stage: 'proving'});
    await delay(1_500);
    setTxStatus({stage: 'submitting'});
    await delay(500);
    setTxStatus({stage: 'pending', txHash: '0xSTUB_DESIGNATE_TX'});
    await delay(6_000);
    const amount = BigInt(Math.floor(parseFloat(params.nightAmount) * 1_000_000));
    setDust(prev => ({...prev, designated: prev.designated + amount}));
    setTxStatus({stage: 'confirmed', txHash: '0xSTUB_DESIGNATE_TX', blockHeight: 43});
  }, []);

  return {dust, txStatus, designate};
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
