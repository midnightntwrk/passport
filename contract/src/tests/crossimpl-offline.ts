// Offline half of conformance test 7 — cross-implementation signing. The
// Rust signer (signer-rs) computes the withdraw_unshielded challenge with
// its own hash and curve stack; this check asserts the challenge is
// bit-identical to the compiled contract's pure circuit, and that the
// ECDSA signature verifies over that digest on an independent stack. The
// on-node half (auth-crossimpl.ts) then submits a Rust-signed withdrawal.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { runScenario, step } from './runner.js';
import { pureCircuits, type Secp256k1Point } from '../wallet/contract.js';
import { SECP256K1_N, type EcdsaSignature } from '../wallet/signer.js';
import { bytesToHex } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SIGNER_BIN = path.resolve(
  __dirname, '..', '..', 'signer-rs', 'target', 'debug', 'account-custody-signer',
);

export interface RustSignature {
  pk: Secp256k1Point;
  sig: EcdsaSignature;
  challenge: string;
}

export function rustKeygen(): { sk: string; pk: Secp256k1Point } {
  const out = JSON.parse(execFileSync(SIGNER_BIN, [], { input: '{"cmd":"keygen"}', encoding: 'utf-8' }));
  return { sk: out.sk, pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false } };
}

export function rustSignWithdrawUnshielded(req: {
  sk: string;
  contractAddress: Uint8Array;
  color: Uint8Array;
  amount: bigint;
  recipient: Uint8Array;
  authNonce: bigint;
}): RustSignature {
  const out = JSON.parse(
    execFileSync(SIGNER_BIN, [], {
      input: JSON.stringify({
        cmd: 'sign',
        circuit: 'withdraw_unshielded',
        sk: req.sk,
        contract_address: bytesToHex(req.contractAddress),
        color: bytesToHex(req.color),
        amount: req.amount.toString(),
        recipient: bytesToHex(req.recipient),
        auth_nonce: req.authNonce.toString(),
      }),
      encoding: 'utf-8',
    }),
  );
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false },
    sig: { r: BigInt(out.sig.r), s: BigInt(out.sig.s) },
    challenge: out.challenge,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runScenario('crossimpl-offline', async () => {
    step('Rust keygen and signature over fixed call parameters');
    const { sk, pk } = rustKeygen();
    const contractAddress = new Uint8Array(randomBytes(32));
    const color = new Uint8Array(32);
    const recipient = new Uint8Array(randomBytes(32));
    const amount = 500n;
    const authNonce = 3n;
    const sig = rustSignWithdrawUnshielded({ sk, contractAddress, color, amount, recipient, authNonce });

    step('challenge bit-exactness: Rust stack vs the contract’s pure circuit');
    const expected = pureCircuits.challenge_withdraw_unshielded(
      { bytes: contractAddress }, sig.pk, color, amount, { bytes: recipient }, authNonce,
    );
    const expectedHex = bytesToHex(expected);
    if (expectedHex !== sig.challenge) {
      throw new Error(`challenge mismatch:\n  rust:     ${sig.challenge}\n  contract: ${expectedHex}`);
    }
    console.log(`  ✓ identical: ${sig.challenge.slice(0, 32)}…`);

    step('the ECDSA signature verifies over the digest');
    if (!(sig.sig.r > 0n && sig.sig.r < SECP256K1_N)) throw new Error('r outside [1, n)');
    if (!(sig.sig.s > 0n && sig.sig.s < SECP256K1_N)) throw new Error('s outside [1, n)');
    const ok = secp256k1.verify(
      new secp256k1.Signature(sig.sig.r, sig.sig.s).toBytes('compact'),
      expected,
      secp256k1.Point.fromAffine({ x: sig.pk.x, y: sig.pk.y }).toBytes(false),
      { prehash: false, lowS: false }, // the circuit accepts both S forms
    );
    if (!ok) throw new Error('Rust signature does not verify over the challenge digest');
    console.log('  ✓ verify(challenge, (r, s), pk) with the Rust-produced signature');
  });
}
