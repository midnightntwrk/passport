// Re-export of the compiled contract modules. Keeping the generated-module
// imports in one place means every test shares a single import path.

import * as AccountModule from '../../contracts/managed/account/contract/index.js';
import type { Ledger } from '../../contracts/managed/account/contract/index.js';

export const { Contract, ledger, pureCircuits } = AccountModule;
export type { Ledger };
export type { Witnesses, PureCircuits } from '../../contracts/managed/account/contract/index.js';

/** secp256k1 point as the generated code represents it: affine coordinates
 *  plus an identity flag, which is false for every real device key. */
export type { Secp256k1Point } from '@midnight-ntwrk/compact-runtime';

/** The generated shape of a shielded coin (circuit argument / return). */
export interface ShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

/** The generated shape of a qualified coin (witness return). */
export interface QualifiedCoin extends ShieldedCoin {
  mt_index: bigint;
}
