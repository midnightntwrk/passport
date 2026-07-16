// Re-export of the compiled contract module. Keeping the generated-module
// import in one place means every test shares a single import path.

import * as C2CModule from '../../contracts/managed/c2c/contract/index.js';
import type { Ledger } from '../../contracts/managed/c2c/contract/index.js';

export const { Contract, ledger } = C2CModule;
export type { Ledger };
export type { Witnesses } from '../../contracts/managed/c2c/contract/index.js';

/** The generated shape of a shielded coin (circuit argument). */
export interface ShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

/** The generated shape of a qualified coin (witness return). */
export interface QualifiedCoin extends ShieldedCoin {
  mt_index: bigint;
}
