// Offline half of MIP-0013 conformance test 7 — cross-implementation
// signing. The Rust signer (signer-rs) computes the withdraw_unshielded
// challenge with its own hash and curve stack; this check asserts the
// challenge is bit-identical to the compiled contract's pure circuit, and
// that the signature verifies against the §4 equation off-circuit. The
// on-node half (auth-crossimpl.ts) then submits a Rust-signed withdrawal.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { pureCircuits } from '../wallet/contract.js';
import { JUBJUB_R, bytesToBigIntLE } from '../wallet/signer.js';
import { bytesToHex } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SIGNER_BIN = path.resolve(
  __dirname, '..', '..', 'signer-rs', 'target', 'debug', 'account-custody-signer',
);

export interface RustSignature {
  pk: { x: bigint; y: bigint };
  sig_r: { x: bigint; y: bigint };
  sig_s: bigint;
  grind_nonce: bigint;
  challenge: string;
  attempts: number;
}

export function rustKeygen(): { sk: string; pk: { x: bigint; y: bigint } } {
  const out = JSON.parse(execFileSync(SIGNER_BIN, [], { input: '{"cmd":"keygen"}', encoding: 'utf-8' }));
  return { sk: out.sk, pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y) } };
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
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y) },
    sig_r: { x: BigInt(out.sig_r.x), y: BigInt(out.sig_r.y) },
    sig_s: BigInt(out.sig_s),
    grind_nonce: BigInt(out.grind_nonce),
    challenge: out.challenge,
    attempts: out.attempts,
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
    console.log(`  grinding attempts: ${sig.attempts}`);

    step('challenge bit-exactness: Rust stack vs the contract’s pure circuit');
    const expected = pureCircuits.challenge_withdraw_unshielded(
      { bytes: contractAddress }, sig.sig_r, sig.pk, color, amount, { bytes: recipient },
      authNonce, sig.grind_nonce,
    );
    const expectedHex = bytesToHex(expected);
    if (expectedHex !== sig.challenge) {
      throw new Error(`challenge mismatch:\n  rust:     ${sig.challenge}\n  contract: ${expectedHex}`);
    }
    console.log(`  ✓ identical: ${sig.challenge.slice(0, 32)}…`);

    step('the §4 equation holds for the Rust signature');
    const c = bytesToBigIntLE(expected);
    if (!(c < JUBJUB_R)) throw new Error('ground challenge not below r_J');
    const lhs = ecMulGenerator(sig.sig_s);
    const rhs = ecAdd(sig.sig_r, ecMul(sig.pk, c));
    if (!(lhs.x === rhs.x && lhs.y === rhs.y)) throw new Error('s·G != R + c·pk');
    console.log('  ✓ s·G == R + c·pk with the Rust-produced (R, s, grind_nonce)');
  });
}
