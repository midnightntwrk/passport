// Offline half of conformance test 7 — cross-implementation signing, once
// per authorisation arm. The Rust signer (signer-rs) computes the
// withdraw_unshielded challenge with its own hash and curve stack; this
// check asserts the challenge is bit-identical to the compiled contract's
// pure circuit of the same arm, and that the signature verifies over that
// challenge on an independent stack. The on-node half (auth-crossimpl.ts)
// then submits a Rust-signed withdrawal.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { pureCircuits, type JubjubPoint, type Secp256k1Point } from '../wallet/contract.js';
import { SECP256K1_N, JUBJUB_R, bytesToBigIntLE, type EcdsaSignature } from '../wallet/signer.js';
import { bytesToHex } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SIGNER_BIN = path.resolve(
  __dirname, '..', '..', 'signer-rs', 'target', 'debug', 'account-custody-signer',
);

export interface CallParams {
  sk: string;
  contractAddress: Uint8Array;
  color: Uint8Array;
  amount: bigint;
  recipient: Uint8Array;
  authNonce: bigint;
}

function signRequest(arm: 'jubjub' | 'k256', req: CallParams, connector = false): any {
  return JSON.parse(
    execFileSync(SIGNER_BIN, [], {
      input: JSON.stringify({
        cmd: 'sign',
        arm,
        circuit: 'withdraw_unshielded',
        sk: req.sk,
        contract_address: bytesToHex(req.contractAddress),
        color: bytesToHex(req.color),
        amount: req.amount.toString(),
        recipient: bytesToHex(req.recipient),
        auth_nonce: req.authNonce.toString(),
        connector,
      }),
      encoding: 'utf-8',
    }),
  );
}

// ── Arm k256 ─────────────────────────────────────────────────────────────────

export interface K256RustSignature {
  pk: Secp256k1Point;
  sig: EcdsaSignature;
  challenge: string;
}

export function rustKeygenK256(): { sk: string; pk: Secp256k1Point } {
  const out = JSON.parse(
    execFileSync(SIGNER_BIN, [], { input: '{"cmd":"keygen","arm":"k256"}', encoding: 'utf-8' }),
  );
  return { sk: out.sk, pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false } };
}

export function rustSignWithdrawUnshieldedK256(req: CallParams): K256RustSignature {
  const out = signRequest('k256', req);
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false },
    sig: { r: BigInt(out.sig.r), s: BigInt(out.sig.s) },
    challenge: out.challenge,
  };
}

// ── Arm jubjub ───────────────────────────────────────────────────────────────

export interface JubjubRustSignature {
  pk: JubjubPoint;
  sig_r: JubjubPoint;
  sig_s: bigint;
  grind_nonce: bigint;
  challenge: string;
}

export function rustKeygenJubjub(): { sk: string; pk: JubjubPoint } {
  const out = JSON.parse(
    execFileSync(SIGNER_BIN, [], { input: '{"cmd":"keygen","arm":"jubjub"}', encoding: 'utf-8' }),
  );
  return { sk: out.sk, pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y) } };
}

export function rustSignWithdrawUnshieldedJubjub(req: CallParams): JubjubRustSignature {
  const out = signRequest('jubjub', req);
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y) },
    sig_r: { x: BigInt(out.sig_r.x), y: BigInt(out.sig_r.y) },
    sig_s: BigInt(out.sig_s),
    grind_nonce: BigInt(out.grind_nonce),
    challenge: out.challenge,
  };
}

// ── Scenario ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runScenario('crossimpl-offline', async () => {
    const contractAddress = new Uint8Array(randomBytes(32));
    const color = new Uint8Array(32);
    const recipient = new Uint8Array(randomBytes(32));
    const amount = 500n;
    const authNonce = 3n;

    step('[jubjub] Rust keygen and signature over fixed call parameters');
    const j = rustKeygenJubjub();
    const jSig = rustSignWithdrawUnshieldedJubjub({
      sk: j.sk, contractAddress, color, amount, recipient, authNonce,
    });

    step('[jubjub] challenge bit-exactness: Rust stack vs the contract’s pure circuit');
    const jExpected = pureCircuits.challenge_withdraw_unshielded_with_jubjub(
      { bytes: contractAddress }, jSig.sig_r, jSig.pk, color, amount, { bytes: recipient },
      authNonce, jSig.grind_nonce,
    );
    const jExpectedHex = bytesToHex(jExpected);
    if (jExpectedHex !== jSig.challenge) {
      throw new Error(`challenge mismatch:\n  rust:     ${jSig.challenge}\n  contract: ${jExpectedHex}`);
    }
    console.log(`  ✓ identical: ${jSig.challenge.slice(0, 32)}… (grind_nonce ${jSig.grind_nonce})`);

    step('[jubjub] the Schnorr signature verifies over the ground challenge');
    const c = bytesToBigIntLE(jExpected);
    if (!(c < JUBJUB_R)) throw new Error('ground challenge not below r_J');
    if (!(jSig.sig_s < JUBJUB_R)) throw new Error('s outside the scalar domain');
    const lhs = ecMulGenerator(jSig.sig_s);
    const rhs = ecAdd(jSig.sig_r, ecMul(jSig.pk, c));
    if (lhs.x !== rhs.x || lhs.y !== rhs.y) {
      throw new Error('Rust signature does not satisfy s·G == R + c·pk over the challenge');
    }
    console.log('  ✓ s·G == R + c·pk with the Rust-produced signature');

    step('[k256] Rust keygen and signature over fixed call parameters');
    const k = rustKeygenK256();
    const kSig = rustSignWithdrawUnshieldedK256({
      sk: k.sk, contractAddress, color, amount, recipient, authNonce,
    });

    step('[k256] challenge bit-exactness: Rust stack vs the contract’s pure circuit');
    const kExpected = pureCircuits.challenge_withdraw_unshielded_with_k256(
      { bytes: contractAddress }, kSig.pk, color, amount, { bytes: recipient }, authNonce,
    );
    const kExpectedHex = bytesToHex(kExpected);
    if (kExpectedHex !== kSig.challenge) {
      throw new Error(`challenge mismatch:\n  rust:     ${kSig.challenge}\n  contract: ${kExpectedHex}`);
    }
    console.log(`  ✓ identical: ${kSig.challenge.slice(0, 32)}…`);

    step('[k256] the ECDSA signature verifies over the digest');
    if (!(kSig.sig.r > 0n && kSig.sig.r < SECP256K1_N)) throw new Error('r outside [1, n)');
    if (!(kSig.sig.s > 0n && kSig.sig.s < SECP256K1_N)) throw new Error('s outside [1, n)');
    const ok = secp256k1.verify(
      new secp256k1.Signature(kSig.sig.r, kSig.sig.s).toBytes('compact'),
      kExpected,
      secp256k1.Point.fromAffine({ x: kSig.pk.x, y: kSig.pk.y }).toBytes(false),
      { prehash: false, lowS: false }, // the circuit accepts both S forms
    );
    if (!ok) throw new Error('Rust signature does not verify over the challenge digest');
    console.log('  ✓ verify(challenge, (r, s), pk) with the Rust-produced signature');

    step('[k256/connector] Rust envelope digest vs the contract pure circuit, and the signature');
    const cOut = signRequest(
      'k256', { sk: k.sk, contractAddress, color, amount, recipient, authNonce }, true,
    );
    const cExpectedDigest = pureCircuits.connector_envelope_digest(kExpected);
    if (cOut.digest !== Buffer.from(cExpectedDigest).toString('hex')) {
      throw new Error('Rust envelope digest differs from connector_envelope_digest');
    }
    console.log(`  ✓ identical: ${cOut.digest.slice(0, 32)}…`);
    const cOk = secp256k1.verify(
      new secp256k1.Signature(BigInt(cOut.sig.r), BigInt(cOut.sig.s)).toBytes('compact'),
      cExpectedDigest,
      secp256k1.Point.fromAffine({ x: BigInt(cOut.pk.x), y: BigInt(cOut.pk.y) }).toBytes(false),
      { prehash: false, lowS: false },
    );
    if (!cOk) throw new Error('Rust connector signature does not verify over the envelope digest');
    console.log('  ✓ verify(envelope digest, (r, s), pk) with the Rust-produced connector signature');
  });
}
