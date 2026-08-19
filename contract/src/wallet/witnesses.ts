// The wallet-local coin store (MIP-0012 §6.5) exposed to the circuit as the
// `held_coin` witness. The qualified coin description lives HERE, in private
// state, and enters proof generation as a private input — it never exists
// in public ledger state (INV-2).
//
// Values are stored as hex/decimal strings so every private-state provider
// (level, in-memory) serialises them without corruption.

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, QualifiedCoin } from './contract.js';
import { hexToBytes, bytesToHex } from './hex.js';

export interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string;   // decimal bigint
  mtIndex: string; // decimal bigint
}

export interface CoinStorePrivateState {
  /** X25519 account encryption secret (hex) — the viewing capability. */
  encSecretKeyHex: string | null;
  /** color hex → held coin. One coin per color. */
  coins: Record<string, StoredCoin>;
}

export function emptyCoinStore(encSecretKey?: Uint8Array): CoinStorePrivateState {
  return {
    encSecretKeyHex: encSecretKey ? bytesToHex(encSecretKey) : null,
    coins: {},
  };
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

type Ctx = WitnessContext<Ledger, CoinStorePrivateState>;

export function makeWitnesses() {
  return {
    held_coin(ctx: Ctx, color: Uint8Array): [CoinStorePrivateState, QualifiedCoin] {
      const key = bytesToHex(color);
      const stored = ctx.privateState.coins[key];
      if (!stored) {
        throw new Error(
          `held_coin witness: no coin for color ${key} in the local store — ` +
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
