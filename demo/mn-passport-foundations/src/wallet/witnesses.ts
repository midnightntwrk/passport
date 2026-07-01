// Witness handling (C7) — the pipeline by which key material flows from
// storage into proof generation.
//
// The private state holds at most three secrets, stored as hex strings so
// every private-state provider (level, in-memory, browser) serialises them
// without corruption. A witness throws when its secret is absent: a wallet
// connected without a device secret simply cannot produce device-authorised
// proofs.
//
// C7 notes for the decision record:
//   - The secrets only ever travel from here into the local proof pipeline
//     (in-process witness evaluation; proofs via the local proof server).
//     Nothing in this module can serialise a secret into a transaction.
//   - Zeroisation discipline and mlock are NOT implemented — JS runtimes
//     give no such guarantees. Recorded as a known limitation, not solved.

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from './contract.js';
import { hexToBytes, bytesToHex } from './hex.js';

export interface AccountPrivateState {
  deviceSecretHex: string | null;
  grantSecretHex: string | null;
  recoverySecretHex: string | null;
}

export function privateStateFromSecrets(secrets: {
  deviceSecret?: Uint8Array;
  grantSecret?: Uint8Array;
  recoverySecret?: Uint8Array;
}): AccountPrivateState {
  return {
    deviceSecretHex: secrets.deviceSecret ? bytesToHex(secrets.deviceSecret) : null,
    grantSecretHex: secrets.grantSecret ? bytesToHex(secrets.grantSecret) : null,
    recoverySecretHex: secrets.recoverySecret ? bytesToHex(secrets.recoverySecret) : null,
  };
}

type Ctx = WitnessContext<Ledger, AccountPrivateState>;

function requireSecret(hex: string | null, name: string): Uint8Array {
  if (!hex) {
    throw new Error(`witness ${name} requested but the secret is not in the private state`);
  }
  return hexToBytes(hex);
}

export function makeWitnesses() {
  return {
    device_secret(ctx: Ctx): [AccountPrivateState, Uint8Array] {
      return [ctx.privateState, requireSecret(ctx.privateState.deviceSecretHex, 'device_secret')];
    },
    grant_secret(ctx: Ctx): [AccountPrivateState, Uint8Array] {
      return [ctx.privateState, requireSecret(ctx.privateState.grantSecretHex, 'grant_secret')];
    },
    recovery_secret(ctx: Ctx): [AccountPrivateState, Uint8Array] {
      return [ctx.privateState, requireSecret(ctx.privateState.recoverySecretHex, 'recovery_secret')];
    },
  };
}
