// Browser-side proving (Phase 0 spike, see ../../BROWSER-PROVING-SCOPE.md).
//
// The upstream zkir-v2 wasm prover plugged into the midnight-js ProofProvider
// seam: `Transaction.prove(provingProvider, costModel)` with a provider that
// computes the PLONK proof in this browser instead of POSTing the preimage to
// the proof server. Key material resolves through the SAME FetchZkConfigProvider
// the HTTP path uses (binary .bzkir + prover/verifier keys from /zk); SRS
// slices are served from /zk-params — byte-identical to the files the proof
// server itself downloads and verifies from the public bucket.
//
// Selected with `?prover=browser` (see providers.ts). The wallet's balancing
// proofs still go to the proof server; that is Phase 2.

import * as zkir from '@midnight-ntwrk/zkir-v2';
import { CostModel } from '@midnight-ntwrk/ledger-v8';
import { zkConfigToProvingKeyMaterial } from '@midnight-ntwrk/midnight-js-types';

import { proveStarted, proveEnded } from './txTracker.js';

interface ZkConfigProviderLike {
  get(keyLocation: string): Promise<unknown>;
}

export function wasmProofProvider(zkConfigProvider: ZkConfigProviderLike): any {
  const kmProvider = {
    lookupKey: async (keyLocation: string) => {
      console.debug(`[wasm-prover] lookupKey: ${keyLocation}`);
      const zkConfig = await zkConfigProvider.get(keyLocation);
      return zkConfigToProvingKeyMaterial(zkConfig as any);
    },
    getParams: async (k: number) => {
      console.debug(`[wasm-prover] getParams: k=${k}`);
      const resp = await fetch(`/zk-params/bls_midnight_2p${k}`);
      if (!resp.ok) {
        throw new Error(
          `missing SRS slice for k=${k} — run scripts/fetch-zk-params.mjs to stage app/public/zk-params`,
        );
      }
      return new Uint8Array(await resp.arrayBuffer());
    },
  };

  const provingProvider = zkir.provingProvider(kmProvider);

  return {
    async proveTx(unprovenTx: any) {
      proveStarted();
      try {
        return await unprovenTx.prove(provingProvider, CostModel.initialCostModel());
      } finally {
        proveEnded();
      }
    },
  };
}
