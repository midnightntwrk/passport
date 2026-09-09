// VENDORED SLICE — account custody client, module re-export.
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/contract.ts, commit 2b0b55d. Trimmed to what P5
// needs: the generated module's Contract class, ledger decoder, and pure
// circuits (challenge/derivation constructions — the signer reproduces the
// contract's own field-aligned encodings through these, MIP-0013 §2).

import * as AccountModule from '../../../contracts/managed/Account/contract/index.js';

export const Contract = (AccountModule as any).Contract;
export const ledger = (AccountModule as any).ledger;
export const pureCircuits = (AccountModule as any).pureCircuits;

/** JubJub point as the generated code represents it: affine coordinates. */
export interface JubjubPoint {
  x: bigint;
  y: bigint;
}
