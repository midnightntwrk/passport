// The recovery gate, client half (recovery MIP §2, §6, REC-11).
//
// The gate commitment is a public key P = s·G on JubJub, and the recover
// circuit verifies a Schnorr signature under it plus a co-signature by the
// successor device key over the same challenge. Nothing here ever hands
// `s` or the successor scalar to a proof: the two signatures are the only
// private inputs recover_submit takes, so the proof may be delegated.
//
// The recovery key reuses the JubJub device signer: same curve, same
// grinding rule (the challenge hash must read below the subgroup order for
// the circuit's cast chain to be canonical), same equation. The one
// difference is that two signers share one challenge, which binds both
// nonce points, so the nonce points are fixed before the challenge is
// ground and the grind serves both signatures.

import { pureCircuits, type JubjubPoint, type Ledger } from './contract.js';
import { JubjubDevice, JUBJUB_R, randomJubjubScalar, bytesToBigIntLE, type CallContext } from './signer.js';
import { fieldFromBytes } from './recovery.js';

/** `s` reduced into the JubJub scalar field (§2: "reduced into that
 *  curve's scalar field"). `s` is shared over the BLS12-381 scalar field,
 *  which is a few bits wider than r_J; the reduction is what the key is
 *  computed over. Zero is refused — its key is the identity. */
export function recoveryScalar(s: bigint | Uint8Array): bigint {
  const field = typeof s === 'bigint' ? s : fieldFromBytes(s);
  const reduced = ((field % JUBJUB_R) + JUBJUB_R) % JUBJUB_R;
  if (reduced === 0n) throw new Error('recovery secret reduces to zero mod r_J; resample the session');
  return reduced;
}

/** The recovery key as a signer: P = s·G and the seam's Schnorr. */
export function recoveryKey(s: bigint | Uint8Array): JubjubDevice {
  return new JubjubDevice(recoveryScalar(s));
}

export function eqPoint(a: JubjubPoint, b: JubjubPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Candidate verification for reconstruction and trial assignment (§6
 *  steps 1 and 2): does this candidate secret open the stored key? */
export function matchesRecoveryPk(candidate: bigint, stored: JubjubPoint): boolean {
  try {
    return eqPoint(recoveryKey(candidate).pk, stored);
  } catch {
    return false;
  }
}

/** The recover-gate challenge builder: closed over everything but the two
 *  nonce points and the grind nonce, which the signing ceremony supplies. */
export type RecoverSubmitChallengeBuilder = (
  sigRRecovery: JubjubPoint,
  sigRSuccessor: JubjubPoint,
  grindNonce: bigint,
) => Uint8Array;

/** What `recover_submit` consumes, in its declared order. */
export interface RecoverSubmitAuthorisation {
  successor_pk: JubjubPoint;
  successor_recovery_pk: JubjubPoint;
  expected_epoch: bigint;
  expected_nonce: bigint;
  now_upper: bigint;
  sig_r_recovery: JubjubPoint;
  sig_s_recovery: bigint;
  sig_r_successor: JubjubPoint;
  sig_s_successor: bigint;
  grind_nonce: bigint;
}

export function recoverSubmitArgs(a: RecoverSubmitAuthorisation): unknown[] {
  return [
    a.successor_pk, a.successor_recovery_pk, a.expected_epoch, a.expected_nonce, a.now_upper,
    a.sig_r_recovery, a.sig_s_recovery, a.sig_r_successor, a.sig_s_successor, a.grind_nonce,
  ];
}

/**
 * Sign a recovery submission: the recovery key over the challenge, the
 * successor over the same challenge. Both nonce points are sampled first
 * because the challenge binds them; the grind then runs once for both.
 *
 * `s` is consumed here and nowhere else — the caller discards it the
 * moment this returns (REC-6). A committee holding the successor key
 * would run its own co-signing ceremony to produce `sig_r_successor` and
 * `sig_s_successor` against the same challenge; this function is the
 * single-holder case.
 */
export function signRecoverSubmit(
  recovery: JubjubDevice,
  successor: JubjubDevice,
  build: RecoverSubmitChallengeBuilder,
  fields: {
    successorRecoveryPk: JubjubPoint;
    expectedEpoch: bigint;
    expectedNonce: bigint;
    nowUpper: bigint;
  },
): RecoverSubmitAuthorisation {
  const rRecovery = randomJubjubScalar();
  const rSuccessor = randomJubjubScalar();
  const sigRRecovery = pureCircuits.compute_public_point_with_jubjub(rRecovery);
  const sigRSuccessor = pureCircuits.compute_public_point_with_jubjub(rSuccessor);

  let grindNonce = 0n;
  let c: bigint;
  for (;;) {
    const h = bytesToBigIntLE(build(sigRRecovery, sigRSuccessor, grindNonce));
    if (h < JUBJUB_R) {
      c = h;
      break;
    }
    grindNonce++;
  }

  const sRecovery = (rRecovery + (c * (recovery.sk % JUBJUB_R)) % JUBJUB_R) % JUBJUB_R;
  const sSuccessor = (rSuccessor + (c * (successor.sk % JUBJUB_R)) % JUBJUB_R) % JUBJUB_R;
  return {
    successor_pk: successor.pk,
    successor_recovery_pk: fields.successorRecoveryPk,
    expected_epoch: fields.expectedEpoch,
    expected_nonce: fields.expectedNonce,
    now_upper: fields.nowUpper,
    sig_r_recovery: sigRRecovery,
    sig_s_recovery: sRecovery,
    sig_r_successor: sigRSuccessor,
    sig_s_successor: sSuccessor,
    grind_nonce: grindNonce,
  };
}

/** The recover-gate challenge for one submission against one ledger read. */
export function recoverSubmitChallenge(
  ctx: CallContext,
  recoveryPk: JubjubPoint,
  successorPk: JubjubPoint,
  successorRecoveryPk: JubjubPoint,
  postEpoch: bigint,
  nowUpper: bigint,
): RecoverSubmitChallengeBuilder {
  return (sigRRecovery, sigRSuccessor, grind) =>
    pureCircuits.challenge_recover_submit(
      { bytes: ctx.contractAddress }, recoveryPk, sigRRecovery, successorPk, sigRSuccessor,
      successorRecoveryPk, postEpoch, ctx.authNonce, nowUpper, grind,
    );
}

// ── The artefact set, read with its version checked (§10) ──────────────────

export const ARTEFACT_SET_VERSION = 1n;

export interface ArtefactSet {
  version: bigint;
  recoveryPk: JubjubPoint;
  sessionId: Uint8Array;
  /** The published public shares, in slot order 1..phi_len. */
  phi: bigint[];
  wrap: Uint8Array;
}

/** The fields of the ledger the artefact-set reader needs; structural so a
 *  drill can hand it a ledger it made up. */
export type ArtefactLedger = Pick<
  Ledger,
  'recovery_version' | 'recovery_pk' | 'recovery_session' | 'recovery_phi_len' | 'recovery_wrap'
> & { recovery_phi: { lookup(key: bigint): bigint } };

/**
 * Read the artefact set off a ledger view. A reader MUST reject a version
 * it does not implement rather than best-effort parse it (§10): a misparsed
 * `phi` yields a reconstruction failure that looks exactly like an
 * under-strength roster. Every reconstruction path goes through here.
 */
export function readArtefactSet(l: ArtefactLedger): ArtefactSet {
  if (l.recovery_version !== ARTEFACT_SET_VERSION) {
    throw new Error(
      `artefact set version ${l.recovery_version} is not implemented by this reader ` +
      `(implements v${ARTEFACT_SET_VERSION}); refusing a best-effort parse (recovery MIP section 10)`,
    );
  }
  const phi: bigint[] = [];
  for (let k = 1n; k <= l.recovery_phi_len; k++) phi.push(l.recovery_phi.lookup(k));
  return {
    version: l.recovery_version,
    recoveryPk: l.recovery_pk,
    sessionId: l.recovery_session,
    phi,
    wrap: l.recovery_wrap,
  };
}

/** JubJub points of small order, for the guard drills: the identity (0, 1)
 *  and the unique point of order two (0, -1) of the twisted Edwards form.
 *  The identity is a subgroup point and reaches the circuit; the order-two
 *  point does not: the proof system constrains every point it assigns to
 *  the prime-order subgroup, and the JS runtime refuses to construct it. */
export const JUBJUB_IDENTITY: JubjubPoint = pureCircuits.compute_public_point_with_jubjub(0n);
export const JUBJUB_ORDER_TWO: JubjubPoint = {
  x: 0n,
  y: BigInt('52435875175126190479447740508185965837690552500527637822603658699938581184513') - 1n,
};
