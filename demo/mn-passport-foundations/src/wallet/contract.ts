// Re-export of the compiled contract module plus commitment derivation
// helpers. Keeping the generated-module import in one place means the
// Node tests and the browser app share a single import path.

import * as AccountModule from '../../contracts/managed/account/contract/index.js';
import type { Ledger } from '../../contracts/managed/account/contract/index.js';

export const { Contract, ledger, pureCircuits } = AccountModule;
export type { Ledger };
export type { Witnesses } from '../../contracts/managed/account/contract/index.js';

// Commitments are Field elements (bigint on the TS side), derived through
// the contract's own exported pure circuits so client and circuit can never
// disagree on the Poseidon parameters or the domain-separation tags.

export function deviceCommitment(secret: Uint8Array): bigint {
  return AccountModule.pureCircuits.derive_device_commitment(secret);
}

export function grantCommitment(secret: Uint8Array): bigint {
  return AccountModule.pureCircuits.derive_grant_commitment(secret);
}

export function recoveryCommitment(secret: Uint8Array): bigint {
  return AccountModule.pureCircuits.derive_recovery_commitment(secret);
}
