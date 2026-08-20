// publish_recovery_backup must reject accidental reuse of the previous
// session nonce or recovery commitment. ANARKey (Remark 6.1) requires a
// unique session id per ceremony: with the same roster, a reused nonce
// makes both ceremonies' polynomials agree at every guardian point, so
// their difference is computable from the public φ vectors alone and one
// (t+1) quorum opens both secrets. The on-chain check only catches
// equality with the stored values — genuine freshness stays a client
// obligation — but it turns the documented MUST into a hard failure
// instead of a silent one.

import { describe, it, expect, beforeEach } from 'vitest';

import { AccountSimulator } from './simulator.js';
import { randomBytes32 } from '../src/wallet/hex.js';
import { recoveryCommitment } from '../src/wallet/contract.js';
import { newRecoverySecret, newSessionNonce } from '../src/wallet/buss.js';

const ZERO = new Uint8Array(32);

const publish = (
  sim: AccountSimulator,
  secret: Uint8Array,
  nonce: Uint8Array,
): unknown =>
  sim.call(
    'publish_recovery_backup',
    recoveryCommitment(secret),
    nonce,
    randomBytes32(),
    randomBytes32(),
    ZERO,
    ZERO,
    2n,
  );

describe('backup freshness backstop', () => {
  let sim: AccountSimulator;
  let deviceSecret: Uint8Array;

  beforeEach(() => {
    deviceSecret = randomBytes32();
    sim = new AccountSimulator({
      deviceSecret,
      recoverySecret: newRecoverySecret(),
    });
  });

  it('accepts a backup with a fresh nonce and a rotated commitment', () => {
    expect(() => publish(sim, newRecoverySecret(), newSessionNonce())).not.toThrow();
  });

  it('rejects reuse of the stored session nonce even with a rotated secret', () => {
    const nonce = newSessionNonce();
    publish(sim, newRecoverySecret(), nonce);
    expect(() => publish(sim, newRecoverySecret(), nonce)).toThrow(/session nonce reused/);
  });

  it('rejects re-publishing φ for the current recovery secret', () => {
    const secret = newRecoverySecret();
    publish(sim, secret, newSessionNonce());
    expect(() => publish(sim, secret, newSessionNonce())).toThrow(
      /recovery commitment reused/,
    );
  });

  it('rejects an all-zero nonce on the first backup (constructor sentinel)', () => {
    expect(() => publish(sim, newRecoverySecret(), ZERO)).toThrow(/session nonce reused/);
  });

  it('accepts consecutive backups when both values are rotated', () => {
    publish(sim, newRecoverySecret(), newSessionNonce());
    expect(() => publish(sim, newRecoverySecret(), newSessionNonce())).not.toThrow();
    expect(sim.ledger().recovery_phi_len).toBe(2n);
  });
});
