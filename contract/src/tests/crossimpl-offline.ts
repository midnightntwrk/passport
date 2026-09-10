// Offline half of conformance test 7 — cross-implementation signing, once
// per authorisation arm. The Rust signer (signer-rs) computes the
// withdraw_unshielded challenge with its own hash and curve stack; this
// check asserts the challenge is bit-identical to the compiled contract's
// pure circuit of the same arm, and that the signature verifies over that
// challenge on an independent stack. The on-node half (auth-crossimpl.ts)
// then submits a Rust-signed withdrawal.
//
// The `[k256/grant]`, `[jubjub/grant]`, and `[k256/grant/to_contract]`
// sections do the same for the scoped-grants seam: origin_hash and
// grant_id derived by the Rust side alone, then the section 6.3 challenge
// of each grantee arm recomputed through the compiled pure circuit and the
// grantee signature verified in the arm's own form.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { pureCircuits, type JubjubPoint, type Secp256k1Point } from '../wallet/contract.js';
import {
  SECP256K1_N, JUBJUB_R, bytesToBigIntLE, type EcdsaSignature,
  K256_ENVELOPE_CONNECTOR, K256_ENVELOPE_NONE,
} from '../wallet/signer.js';
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

function signRequest(arm: 'jubjub' | 'k256', req: CallParams, envelope = 0): any {
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
        envelope,
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
  /** hex; the envelope digest the signature covers (envelope 0 here). */
  digest: string;
  envelope: number;
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
    digest: out.digest,
    envelope: out.envelope,
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

// ── Arm k256, grantee seam (scoped grants, MIP sections 4.3, 4.4, 6.3) ───────

export interface GrantCallParams extends CallParams {
  /** The normalised client_id (section 4.4); origin_hash is derived from it. */
  clientId: string;
  slot: bigint;
  /** The record's issued_at and nonce, as read from chain state. */
  issuedAt: bigint;
  grantNonce: bigint;
  envelope?: number;
}

export interface K256RustGrantSignature extends K256RustSignature {
  /** hex; SHA-256(pad(32, origin tag) || client_id bytes). */
  originHash: string;
  /** hex; the identity the Rust side recomputed from the presented key. */
  grantId: string;
}

/** The Rust signer signs a `withdraw_unshielded_with_grant_k256` call as a
 *  grantee: it derives origin_hash and grant_id itself, builds the section
 *  6.3 challenge, and signs envelope_digest(envelope, challenge). */
export function rustSignWithdrawUnshieldedGrantK256(req: GrantCallParams): K256RustGrantSignature {
  const out = JSON.parse(
    execFileSync(SIGNER_BIN, [], {
      input: JSON.stringify({
        cmd: 'sign_grant',
        arm: 'k256',
        circuit: 'withdraw_unshielded',
        sk: req.sk,
        envelope: req.envelope ?? 0,
        contract_address: bytesToHex(req.contractAddress),
        client_id: req.clientId,
        slot: Number(req.slot),
        issued_at: req.issuedAt.toString(),
        grant_nonce: req.grantNonce.toString(),
        color: bytesToHex(req.color),
        amount: req.amount.toString(),
        recipient: bytesToHex(req.recipient),
      }),
      encoding: 'utf-8',
    }),
  );
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false },
    sig: { r: BigInt(out.sig.r), s: BigInt(out.sig.s) },
    challenge: out.challenge,
    digest: out.digest,
    envelope: out.envelope,
    originHash: out.origin_hash,
    grantId: out.grant_id,
  };
}

// ── Arm jubjub, grantee seam (scoped grants, MIP sections 4.3, 4.4, 6.3) ─────

/** The shielded-only half of a grant call, which the two shielded twins add
 *  to the request (the qualified coin is bound by AUTH-10). */
export interface ShieldedGrantParams {
  changeEntry: Uint8Array;
  encPk: Uint8Array;
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

/** One `sign_grant` request, either arm and any of the three operations. */
function grantSignRequest(
  arm: 'jubjub' | 'k256',
  circuit: string,
  req: GrantCallParams,
  shielded?: ShieldedGrantParams,
): any {
  const body: Record<string, unknown> = {
    cmd: 'sign_grant',
    arm,
    circuit,
    sk: req.sk,
    contract_address: bytesToHex(req.contractAddress),
    client_id: req.clientId,
    slot: Number(req.slot),
    issued_at: req.issuedAt.toString(),
    grant_nonce: req.grantNonce.toString(),
    color: bytesToHex(req.color),
    amount: req.amount.toString(),
    recipient: bytesToHex(req.recipient),
  };
  // The v1 arm refuses the field outright, so it is sent only on k256.
  if (arm === 'k256') body.envelope = req.envelope ?? 0;
  if (shielded !== undefined) {
    body.change_entry = bytesToHex(shielded.changeEntry);
    body.enc_pk = bytesToHex(shielded.encPk);
    body.coin = {
      nonce: bytesToHex(shielded.coin.nonce),
      color: bytesToHex(shielded.coin.color),
      value: shielded.coin.value.toString(),
      mt_index: shielded.coin.mt_index.toString(),
    };
  }
  return JSON.parse(execFileSync(SIGNER_BIN, [], { input: JSON.stringify(body), encoding: 'utf-8' }));
}

export interface JubjubRustGrantSignature extends JubjubRustSignature {
  /** hex; SHA-256(pad(32, origin tag) || client_id bytes). */
  originHash: string;
  /** hex; the identity the Rust side recomputed from the presented key. */
  grantId: string;
}

/** The Rust signer signs a `withdraw_unshielded_with_grant_jubjub` call as a
 *  v1 grantee: it derives origin_hash and grant_id itself, samples the
 *  signature nonce, grinds the section 6.3 challenge that commits to that
 *  nonce, and signs the ground challenge. */
export function rustSignWithdrawUnshieldedGrantJubjub(req: GrantCallParams): JubjubRustGrantSignature {
  const out = grantSignRequest('jubjub', 'withdraw_unshielded', req);
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y) },
    sig_r: { x: BigInt(out.sig_r.x), y: BigInt(out.sig_r.y) },
    sig_s: BigInt(out.sig_s),
    grind_nonce: BigInt(out.grind_nonce),
    challenge: out.challenge,
    originHash: out.origin_hash,
    grantId: out.grant_id,
  };
}

/** The Rust signer signs a `withdraw_shielded_to_contract_with_grant_k256`
 *  call, the third k1 twin: the same thirteen declared members as the
 *  shielded twin under its own DST. */
export function rustSignShieldedToContractGrantK256(
  req: GrantCallParams,
  shielded: ShieldedGrantParams,
): K256RustGrantSignature {
  const out = grantSignRequest('k256', 'withdraw_shielded_to_contract', req, shielded);
  return {
    pk: { x: BigInt(out.pk.x), y: BigInt(out.pk.y), identity: false },
    sig: { r: BigInt(out.sig.r), s: BigInt(out.sig.s) },
    challenge: out.challenge,
    digest: out.digest,
    envelope: out.envelope,
    originHash: out.origin_hash,
    grantId: out.grant_id,
  };
}

/** origin_hash by hand (section 4.4): the 32-byte tag pad followed by the
 *  raw, unpadded client_id bytes. */
function originHashByHand(clientId: string): Uint8Array {
  const tag = Buffer.alloc(32);
  tag.write('midnight:account:grant:origin:v1', 'ascii');
  return new Uint8Array(createHash('sha256').update(tag).update(clientId, 'ascii').digest());
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

    step('[k256] envelope 0: Rust digest vs the contract pure circuit, and the signature');
    if (!(kSig.sig.r > 0n && kSig.sig.r < SECP256K1_N)) throw new Error('r outside [1, n)');
    if (!(kSig.sig.s > 0n && kSig.sig.s < SECP256K1_N)) throw new Error('s outside [1, n)');
    const kDigest = pureCircuits.envelope_digest(K256_ENVELOPE_NONE, kExpected);
    if (kSig.digest !== Buffer.from(kDigest).toString('hex')) {
      throw new Error('Rust envelope-0 digest differs from envelope_digest(0, challenge)');
    }
    console.log(`  ✓ identical: ${kSig.digest.slice(0, 32)}…`);
    const ok = secp256k1.verify(
      new secp256k1.Signature(kSig.sig.r, kSig.sig.s).toBytes('compact'),
      kDigest,
      secp256k1.Point.fromAffine({ x: kSig.pk.x, y: kSig.pk.y }).toBytes(false),
      { prehash: false, lowS: false }, // the circuit accepts both S forms
    );
    if (!ok) throw new Error('Rust signature does not verify over the envelope-0 digest');
    console.log('  ✓ verify(envelope_digest(0, challenge), (r, s), pk) with the Rust-produced signature');

    step('[k256/connector] envelope 1: Rust digest vs the contract pure circuit, and the signature');
    const cOut = signRequest(
      'k256', { sk: k.sk, contractAddress, color, amount, recipient, authNonce }, 1,
    );
    const cExpectedDigest = pureCircuits.envelope_digest(K256_ENVELOPE_CONNECTOR, kExpected);
    if (cOut.digest !== Buffer.from(cExpectedDigest).toString('hex')) {
      throw new Error('Rust envelope-1 digest differs from envelope_digest(1, challenge)');
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

    step('[k256/grant] Rust grantee keygen and signature over a withdraw_unshielded grant call');
    // A grantee key is per connection (section 3.2), so a fresh one here.
    // The Rust side derives origin_hash and grant_id from the presented key
    // and reads nothing from the contract; every value it emits is then
    // recomputed through the compiled pure circuits.
    const grantee = rustKeygenK256();
    const clientId = 'https://bank.example';
    const slot = 0n;
    const issuedAt = 5n;
    const grantNonce = 2n;
    const gSig = rustSignWithdrawUnshieldedGrantK256({
      sk: grantee.sk, contractAddress, color, amount, recipient, authNonce: 0n,
      clientId, slot, issuedAt, grantNonce,
    });

    step('[k256/grant] origin_hash (§4.4): Rust vs the by-hand recipe');
    const originHash = originHashByHand(clientId);
    if (gSig.originHash !== bytesToHex(originHash)) {
      throw new Error(`origin_hash mismatch:\n  rust:    ${gSig.originHash}\n  by hand: ${bytesToHex(originHash)}`);
    }
    console.log(`  ✓ identical: ${gSig.originHash.slice(0, 32)}…`);

    step('[k256/grant] grant_id (§4.3): Rust stack vs the contract’s pure circuit');
    const gId = pureCircuits.derive_grant_id_with_k256(
      { bytes: contractAddress }, gSig.pk, K256_ENVELOPE_NONE, originHash, slot,
    );
    if (bytesToHex(gId) !== gSig.grantId) {
      throw new Error(`grant_id mismatch:\n  rust:     ${gSig.grantId}\n  contract: ${bytesToHex(gId)}`);
    }
    console.log(`  ✓ identical: ${gSig.grantId.slice(0, 32)}…`);

    step('[k256/grant] challenge (§6.3): Rust stack vs the contract’s pure circuit');
    const gExpected = pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
      { bytes: contractAddress }, gSig.pk, gId, issuedAt, color, amount, { bytes: recipient }, grantNonce,
    );
    if (bytesToHex(gExpected) !== gSig.challenge) {
      throw new Error(`grant challenge mismatch:\n  rust:     ${gSig.challenge}\n  contract: ${bytesToHex(gExpected)}`);
    }
    console.log(`  ✓ identical: ${gSig.challenge.slice(0, 32)}…`);

    step('[k256/grant] envelope 0: Rust digest vs envelope_digest, and the grantee signature');
    if (!(gSig.sig.r > 0n && gSig.sig.r < SECP256K1_N)) throw new Error('r outside [1, n)');
    if (!(gSig.sig.s > 0n && gSig.sig.s < SECP256K1_N)) throw new Error('s outside [1, n)');
    const gDigest = pureCircuits.envelope_digest(K256_ENVELOPE_NONE, gExpected);
    if (gSig.digest !== bytesToHex(gDigest)) {
      throw new Error('Rust grant digest differs from envelope_digest(0, challenge)');
    }
    const gPkBytes = secp256k1.Point.fromAffine({ x: gSig.pk.x, y: gSig.pk.y }).toBytes(false);
    const gOk = secp256k1.verify(
      new secp256k1.Signature(gSig.sig.r, gSig.sig.s).toBytes('compact'),
      gDigest, gPkBytes, { prehash: false, lowS: false },
    );
    if (!gOk) throw new Error('Rust grantee signature does not verify over the envelope-0 digest');
    console.log('  ✓ verify(envelope_digest(0, challenge), (r, s), pk) with the Rust-produced grantee signature');
    // The signature fits this grant only: the same key at the next slot has
    // another grant_id, hence another challenge (GR-3).
    const gOtherId = pureCircuits.derive_grant_id_with_k256(
      { bytes: contractAddress }, gSig.pk, K256_ENVELOPE_NONE, originHash, slot + 1n,
    );
    const gOtherDigest = pureCircuits.envelope_digest(
      K256_ENVELOPE_NONE,
      pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        { bytes: contractAddress }, gSig.pk, gOtherId, issuedAt, color, amount, { bytes: recipient }, grantNonce,
      ),
    );
    if (secp256k1.verify(
      new secp256k1.Signature(gSig.sig.r, gSig.sig.s).toBytes('compact'),
      gOtherDigest, gPkBytes, { prehash: false, lowS: false },
    )) throw new Error('grantee signature verified under another grant_id');
    console.log('  ✓ the same signature does not verify under the next slot’s grant_id (GR-3)');

    step('[jubjub/grant] Rust grantee keygen and signature over a withdraw_unshielded grant call');
    // The v1 grantee seam. The Rust side samples its own signature nonce,
    // derives origin_hash and grant_id, and grinds the section 6.3
    // challenge that commits to that nonce; every value it emits is then
    // recomputed through the compiled pure circuits.
    const jGrantee = rustKeygenJubjub();
    const jGrantNonce = 4n;
    const jIssuedAt = 9n;
    const jg = rustSignWithdrawUnshieldedGrantJubjub({
      sk: jGrantee.sk, contractAddress, color, amount, recipient, authNonce: 0n,
      clientId, slot, issuedAt: jIssuedAt, grantNonce: jGrantNonce,
    });

    step('[jubjub/grant] origin_hash (§4.4): Rust vs the by-hand recipe');
    if (jg.originHash !== bytesToHex(originHash)) {
      throw new Error(`origin_hash mismatch:\n  rust:    ${jg.originHash}\n  by hand: ${bytesToHex(originHash)}`);
    }
    console.log(`  ✓ identical: ${jg.originHash.slice(0, 32)}…`);

    step('[jubjub/grant] grant_id (§4.3): Rust stack vs the contract’s pure circuit');
    const jgId = pureCircuits.derive_grant_id_with_jubjub(
      { bytes: contractAddress }, jg.pk, originHash, slot,
    );
    if (bytesToHex(jgId) !== jg.grantId) {
      throw new Error(`grant_id mismatch:\n  rust:     ${jg.grantId}\n  contract: ${bytesToHex(jgId)}`);
    }
    console.log(`  ✓ identical: ${jg.grantId.slice(0, 32)}…`);

    step('[jubjub/grant] challenge (§6.3): Rust stack vs the contract’s pure circuit');
    // The challenge commits to the nonce point and the grinding nonce, so
    // both travel in the response and the preimage is rebuilt from it.
    const jgExpected = pureCircuits.challenge_withdraw_unshielded_with_grant_jubjub(
      { bytes: contractAddress }, jg.sig_r, jg.pk, jgId, jIssuedAt, color, amount,
      { bytes: recipient }, jGrantNonce, jg.grind_nonce,
    );
    if (bytesToHex(jgExpected) !== jg.challenge) {
      throw new Error(`grant challenge mismatch:\n  rust:     ${jg.challenge}\n  contract: ${bytesToHex(jgExpected)}`);
    }
    console.log(`  ✓ identical: ${jg.challenge.slice(0, 32)}… (grind_nonce ${jg.grind_nonce})`);

    step('[jubjub/grant] the Schnorr signature verifies over the ground challenge');
    const jgC = bytesToBigIntLE(jgExpected);
    if (!(jgC < JUBJUB_R)) throw new Error('ground grant challenge not below r_J');
    if (!(jg.sig_s < JUBJUB_R)) throw new Error('s outside the scalar domain');
    const jgLhs = ecMulGenerator(jg.sig_s);
    const jgRhs = ecAdd(jg.sig_r, ecMul(jg.pk, jgC));
    if (jgLhs.x !== jgRhs.x || jgLhs.y !== jgRhs.y) {
      throw new Error('Rust grantee signature does not satisfy s·G == R + c·pk over the grant challenge');
    }
    console.log('  ✓ s·G == R + c·pk with the Rust-produced grantee signature');
    // GR-3: the same key at the next slot is another grantee, so its
    // challenge is another message and the signature does not carry over.
    const jgOtherId = pureCircuits.derive_grant_id_with_jubjub(
      { bytes: contractAddress }, jg.pk, originHash, slot + 1n,
    );
    const jgOtherC = bytesToBigIntLE(
      pureCircuits.challenge_withdraw_unshielded_with_grant_jubjub(
        { bytes: contractAddress }, jg.sig_r, jg.pk, jgOtherId, jIssuedAt, color, amount,
        { bytes: recipient }, jGrantNonce, jg.grind_nonce,
      ),
    ) % JUBJUB_R;
    const jgOtherRhs = ecAdd(jg.sig_r, ecMul(jg.pk, jgOtherC));
    if (jgLhs.x === jgOtherRhs.x && jgLhs.y === jgOtherRhs.y) {
      throw new Error('grantee signature verified under another grant_id');
    }
    console.log('  ✓ the same signature does not satisfy the equation under the next slot’s grant_id (GR-3)');

    step('[k256/grant/to_contract] the third k1 twin: Rust challenge vs the pure circuit');
    // Recipient kind 3. The declared members are the shielded twin's, so
    // this exercises the DST and nothing else in the recipe, over a
    // qualified coin and a change entry the Rust side hashes element by
    // element (AUTH-10).
    const tcGrantee = rustKeygenK256();
    const shielded = {
      changeEntry: new Uint8Array(randomBytes(192)),
      encPk: new Uint8Array(randomBytes(32)),
      coin: {
        nonce: new Uint8Array(randomBytes(32)),
        color,
        value: 4_000n,
        mt_index: 17n,
      },
    };
    const tcRecipient = new Uint8Array(randomBytes(32));
    const tc = rustSignShieldedToContractGrantK256(
      {
        sk: tcGrantee.sk, contractAddress, color, amount, recipient: tcRecipient,
        authNonce: 0n, clientId, slot, issuedAt, grantNonce,
      },
      shielded,
    );
    const tcId = pureCircuits.derive_grant_id_with_k256(
      { bytes: contractAddress }, tc.pk, K256_ENVELOPE_NONE, originHash, slot,
    );
    if (bytesToHex(tcId) !== tc.grantId) {
      throw new Error(`grant_id mismatch:\n  rust:     ${tc.grantId}\n  contract: ${bytesToHex(tcId)}`);
    }
    const tcExpected = pureCircuits.challenge_withdraw_shielded_to_contract_with_grant_k256(
      { bytes: contractAddress }, tc.pk, tcId, issuedAt, { bytes: tcRecipient }, color, amount,
      shielded.changeEntry, shielded.encPk, shielded.coin, grantNonce,
    );
    if (bytesToHex(tcExpected) !== tc.challenge) {
      throw new Error(`to_contract grant challenge mismatch:\n  rust:     ${tc.challenge}\n  contract: ${bytesToHex(tcExpected)}`);
    }
    console.log(`  ✓ identical: ${tc.challenge.slice(0, 32)}…`);
    // The twin's DST is the whole difference from the shielded twin, so the
    // shielded recipe over the same arguments must give another challenge.
    const tcShielded = pureCircuits.challenge_withdraw_shielded_with_grant_k256(
      { bytes: contractAddress }, tc.pk, tcId, issuedAt, { bytes: tcRecipient }, color, amount,
      shielded.changeEntry, shielded.encPk, shielded.coin, grantNonce,
    );
    if (bytesToHex(tcShielded) === tc.challenge) {
      throw new Error('the two shielded k1 grant twins share a challenge');
    }
    console.log('  ✓ the shielded twin over the same arguments gives another challenge (AUTH-3)');
    const tcDigest = pureCircuits.envelope_digest(K256_ENVELOPE_NONE, tcExpected);
    if (tc.digest !== bytesToHex(tcDigest)) {
      throw new Error('Rust to_contract digest differs from envelope_digest(0, challenge)');
    }
    const tcOk = secp256k1.verify(
      new secp256k1.Signature(tc.sig.r, tc.sig.s).toBytes('compact'),
      tcDigest,
      secp256k1.Point.fromAffine({ x: tc.pk.x, y: tc.pk.y }).toBytes(false),
      { prehash: false, lowS: false },
    );
    if (!tcOk) throw new Error('Rust to_contract signature does not verify over the envelope-0 digest');
    console.log('  ✓ verify(envelope_digest(0, challenge), (r, s), pk) with the Rust-produced signature');
  });
}
