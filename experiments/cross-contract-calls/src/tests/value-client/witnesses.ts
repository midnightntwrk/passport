// VENDORED SLICE — the wallet-local coin store behind the Payer's
// payer_coin witness.
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/witnesses.ts, commit 2b0b55d (the MIP-0012 §6.5
// held_coin store), trimmed for P7: the witness is renamed payer_coin to
// match payer.compact, the account-encryption secret is dropped (the Payer
// has no inbox), and the ledger type is untyped (the harness convention —
// generated-module types stay out of the plumbing).
//
// The qualified coin description lives HERE, in private state, and enters
// proof generation as a private input — it never exists in public ledger
// state (INV-2). Values are stored as hex/decimal strings so the level
// private-state provider serialises them without corruption.

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { hexToBytes, bytesToHex } from '../../wallet/hex.js';

export interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string;   // decimal bigint
  mtIndex: string; // decimal bigint
}

export interface CoinStorePrivateState {
  /** color hex → held coin. One coin per color. */
  coins: Record<string, StoredCoin>;
}

export interface QualifiedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
  mt_index: bigint;
}

export function emptyCoinStore(): CoinStorePrivateState {
  return { coins: {} };
}

export function withCoin(
  state: CoinStorePrivateState,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint },
): CoinStorePrivateState {
  return {
    ...state,
    coins: {
      ...state.coins,
      [bytesToHex(coin.color)]: {
        nonceHex: bytesToHex(coin.nonce),
        colorHex: bytesToHex(coin.color),
        value: coin.value.toString(),
        mtIndex: coin.mtIndex.toString(),
      },
    },
  };
}

export function withoutCoin(state: CoinStorePrivateState, color: Uint8Array): CoinStorePrivateState {
  const coins = { ...state.coins };
  delete coins[bytesToHex(color)];
  return { ...state, coins };
}

type Ctx = WitnessContext<unknown, CoinStorePrivateState>;

export function makeCoinStoreWitnesses() {
  return {
    payer_coin(ctx: Ctx, color: Uint8Array): [CoinStorePrivateState, QualifiedCoin] {
      const key = bytesToHex(color);
      const stored = ctx.privateState.coins[key];
      if (!stored) {
        throw new Error(
          `payer_coin witness: no coin for color ${key} in the local store — ` +
          'a conforming client cannot spend a coin it has not captured (§6.5)',
        );
      }
      return [
        ctx.privateState,
        {
          nonce: hexToBytes(stored.nonceHex),
          color: hexToBytes(stored.colorHex),
          value: BigInt(stored.value),
          mt_index: BigInt(stored.mtIndex),
        },
      ];
    },
  };
}
