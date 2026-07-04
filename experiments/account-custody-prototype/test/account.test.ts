// Contract-logic unit tests over the in-process simulator. These cover the
// authorisation, device, grant, and recovery semantics; the token-flow
// circuits are exercised end-to-end by the localnet integration tests.

import { describe, it, expect, beforeEach } from 'vitest';

import { AccountSimulator } from './simulator.js';
import { deviceCommitment, grantCommitment, recoveryCommitment } from '../src/wallet/contract.js';
import {
  newRecoverySecret,
  newSessionNonce,
  newPaperKey,
  guardianSkFromDeviceSecret,
  computeSigma,
  paperSigma,
  buildPhi,
  reconstructRecoverySecret,
  paramsFromPhi,
  type GuardianReply,
} from '../src/wallet/buss.js';
import { randomBytes32, hexToBytes32, bytesToHex } from '../src/wallet/hex.js';

const NIGHT = hexToBytes32('01');
const OTHER_COLOR = hexToBytes32('02');
const RECIPIENT = { bytes: hexToBytes32('aabbcc') };

let deviceSecret: Uint8Array;
let recoverySecret: Uint8Array;
let sim: AccountSimulator;

beforeEach(() => {
  deviceSecret = randomBytes32();
  recoverySecret = randomBytes32();
  sim = new AccountSimulator({ deviceSecret, recoverySecret });
});

describe('constructor', () => {
  it('registers the initial device in epoch 0', () => {
    const l = sim.ledger();
    expect(l.devices.member(deviceCommitment(deviceSecret))).toBe(true);
    expect(l.devices.lookup(deviceCommitment(deviceSecret))).toBe(0n);
    expect(l.device_epoch).toBe(0n);
    expect(l.device_count).toBe(1n);
    expect(l.round).toBe(0n);
  });

  it('stores the recovery commitment and no backup', () => {
    const l = sim.ledger();
    expect(l.recovery).toBe(recoveryCommitment(recoverySecret));
    expect(l.recovery_phi_len).toBe(0n);
  });
});

describe('night custody', () => {
  it('mirrors deposits and withdrawals in night_balances', () => {
    sim.call('deposit_night', NIGHT, 1000n);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(1000n);

    sim.call('withdraw_night', NIGHT, 400n, RECIPIENT);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(600n);
    expect(sim.ledger().round).toBe(1n);
  });

  it('rejects over-withdrawal', () => {
    sim.call('deposit_night', NIGHT, 100n);
    expect(() => sim.call('withdraw_night', NIGHT, 200n, RECIPIENT)).toThrow(
      /insufficient balance/,
    );
  });

  it('rejects withdrawal from an unknown device', () => {
    sim.call('deposit_night', NIGHT, 100n);
    sim.as({ deviceSecret: randomBytes32() });
    expect(() => sim.call('withdraw_night', NIGHT, 50n, RECIPIENT)).toThrow(/unknown device/);
  });

  it('rejects withdrawal when no device secret is present', () => {
    sim.call('deposit_night', NIGHT, 100n);
    sim.as({});
    expect(() => sim.call('withdraw_night', NIGHT, 50n, RECIPIENT)).toThrow(
      /device_secret requested/,
    );
  });
});

describe('device management', () => {
  it('adds a second device that can then withdraw', () => {
    const second = randomBytes32();
    sim.call('add_device', deviceCommitment(second));
    expect(sim.ledger().device_count).toBe(2n);

    sim.call('deposit_night', NIGHT, 100n);
    sim.as({ deviceSecret: second });
    sim.call('withdraw_night', NIGHT, 50n, RECIPIENT);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(50n);
  });

  it('rejects adding an already-active device', () => {
    expect(() => sim.call('add_device', deviceCommitment(deviceSecret))).toThrow(
      /device already active/,
    );
  });

  it('removes a device, which then cannot act', () => {
    const second = randomBytes32();
    sim.call('add_device', deviceCommitment(second));
    sim.call('remove_device', deviceCommitment(second));
    expect(sim.ledger().device_count).toBe(1n);

    sim.call('deposit_night', NIGHT, 100n);
    sim.as({ deviceSecret: second });
    expect(() => sim.call('withdraw_night', NIGHT, 50n, RECIPIENT)).toThrow(/unknown device/);
  });

  it('refuses to remove the last device', () => {
    expect(() => sim.call('remove_device', deviceCommitment(deviceSecret))).toThrow(
      /cannot remove last device/,
    );
  });
});

describe('scoped grants', () => {
  let grantSecret: Uint8Array;

  beforeEach(() => {
    grantSecret = randomBytes32();
    sim.call('deposit_night', NIGHT, 1000n);
    sim.call('add_grant', grantCommitment(grantSecret), NIGHT, 300n);
  });

  it('allows withdrawals within the cap and tracks cumulative spend', () => {
    sim.as({ grantSecret });
    sim.call('grant_withdraw_night', NIGHT, 100n, RECIPIENT);
    sim.call('grant_withdraw_night', NIGHT, 200n, RECIPIENT);

    const info = sim.ledger().grants.lookup(grantCommitment(grantSecret));
    expect(info.spent).toBe(300n);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(700n);
  });

  it('rejects a withdrawal that exceeds the cap cumulatively', () => {
    sim.as({ grantSecret });
    sim.call('grant_withdraw_night', NIGHT, 250n, RECIPIENT);
    expect(() => sim.call('grant_withdraw_night', NIGHT, 100n, RECIPIENT)).toThrow(
      /grant cap exceeded/,
    );
  });

  it('rejects a withdrawal outside the granted colour', () => {
    sim.as({ grantSecret });
    expect(() => sim.call('grant_withdraw_night', OTHER_COLOR, 10n, RECIPIENT)).toThrow(
      /colour outside grant scope/,
    );
  });

  it('rejects an unknown grant secret', () => {
    sim.as({ grantSecret: randomBytes32() });
    expect(() => sim.call('grant_withdraw_night', NIGHT, 10n, RECIPIENT)).toThrow(
      /unknown grant/,
    );
  });

  it('rejects a revoked grant', () => {
    sim.call('revoke_grant', grantCommitment(grantSecret));
    sim.as({ grantSecret });
    expect(() => sim.call('grant_withdraw_night', NIGHT, 10n, RECIPIENT)).toThrow(
      /grant revoked/,
    );
  });

  it('only devices may issue or revoke grants', () => {
    sim.as({ grantSecret });
    expect(() => sim.call('add_grant', grantCommitment(randomBytes32()), NIGHT, 10n)).toThrow(
      /device_secret requested/,
    );
  });
});

describe('recovery backup publication (BUSS)', () => {
  const ZERO = new Uint8Array(32);

  it('publishes φ, session nonce, and rotated commitment', () => {
    const rotated = newRecoverySecret();
    const nonce = newSessionNonce();
    sim.call(
      'publish_recovery_backup',
      recoveryCommitment(rotated),
      nonce,
      randomBytes32(),
      randomBytes32(),
      ZERO,
      ZERO,
      2n,
    );
    const l = sim.ledger();
    expect(l.recovery).toBe(recoveryCommitment(rotated));
    expect(l.recovery_phi_len).toBe(2n);
    expect(bytesToHex(l.recovery_session)).toBe(bytesToHex(nonce));
    expect(l.recovery_phi.member(1n)).toBe(true);
    expect(l.recovery_phi.member(2n)).toBe(true);
  });

  it('rejects an empty φ', () => {
    expect(() =>
      sim.call(
        'publish_recovery_backup',
        recoveryCommitment(newRecoverySecret()),
        newSessionNonce(),
        ZERO,
        ZERO,
        ZERO,
        ZERO,
        0n,
      ),
    ).toThrow(/phi must not be empty/);
  });

  it('only devices may publish a backup', () => {
    sim.as({ recoverySecret });
    expect(() =>
      sim.call(
        'publish_recovery_backup',
        recoveryCommitment(newRecoverySecret()),
        newSessionNonce(),
        randomBytes32(),
        ZERO,
        ZERO,
        ZERO,
        1n,
      ),
    ).toThrow(/device_secret requested/);
  });
});

describe('total-loss recovery (BUSS)', () => {
  it('rejects an invalid recovery secret', () => {
    sim.as({ recoverySecret: randomBytes32() });
    expect(() =>
      sim.call('recover', deviceCommitment(randomBytes32()), recoveryCommitment(randomBytes32())),
    ).toThrow(/invalid recovery secret/);
  });

  it('full BUSS ceremony: guardian passport + two paper keys, recover with a t+1 quorum', () => {
    const grantSecret = randomBytes32();
    sim.call('deposit_night', NIGHT, 500n);
    sim.call('add_grant', grantCommitment(grantSecret), NIGHT, 100n);

    // ── Backup ceremony (owner side, while healthy) ──────────────────────
    // Guardians: another passport (index 1) + two paper keys (2, 3).
    // Threshold 2: any two of the three recover. t=1, n=4, φ length 2.
    const rotated = newRecoverySecret();
    const nonce = newSessionNonce();
    const nonceHex = bytesToHex(nonce);

    const guardianDeviceSecret = randomBytes32(); // the OTHER passport's device
    const guardianSk = guardianSkFromDeviceSecret(guardianDeviceSecret);
    const guardianReply = computeSigma(
      { address: sim.address, sessionNonce: nonceHex, index: 1 },
      guardianSk,
    );
    const paper2 = newPaperKey(2);
    const paper3 = newPaperKey(3);
    const replies: GuardianReply[] = [
      guardianReply,
      paperSigma(paper2, sim.address, nonceHex),
      paperSigma(paper3, sim.address, nonceHex),
    ];

    const params = { t: 1, n: 4 };
    const phi = buildPhi(rotated, replies, params);
    expect(phi.length).toBe(2);

    const ZERO = new Uint8Array(32);
    sim.call(
      'publish_recovery_backup',
      recoveryCommitment(rotated),
      nonce,
      phi[0],
      phi[1],
      ZERO,
      ZERO,
      2n,
    );

    // ── Total loss: reconstruct from guardian σ + ONE paper key + chain ──
    const l = sim.ledger();
    const phiFromChain = [l.recovery_phi.lookup(1n), l.recovery_phi.lookup(2n)];
    const sessionFromChain = bytesToHex(l.recovery_session);
    const quorum: GuardianReply[] = [
      computeSigma({ address: sim.address, sessionNonce: sessionFromChain, index: 1 }, guardianSk),
      paperSigma(paper3, sim.address, sessionFromChain),
    ];
    const reconstructed = reconstructRecoverySecret(
      phiFromChain,
      quorum,
      paramsFromPhi(phiFromChain.length, 3),
    );
    expect(recoveryCommitment(reconstructed)).toBe(l.recovery);

    // ── Recover with a fresh device ───────────────────────────────────────
    const newDevice = randomBytes32();
    const newRecovery = newRecoverySecret();
    sim.as({ recoverySecret: reconstructed });
    sim.call('recover', deviceCommitment(newDevice), recoveryCommitment(newRecovery));

    const after = sim.ledger();
    expect(after.device_epoch).toBe(1n);
    expect(after.device_count).toBe(1n);
    expect(after.recovery).toBe(recoveryCommitment(newRecovery));
    expect(after.recovery_phi_len).toBe(0n); // φ cleared with the old secret

    // The recovered device controls the account — and the assets followed it.
    sim.as({ deviceSecret: newDevice });
    sim.call('withdraw_night', NIGHT, 100n, RECIPIENT);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(400n);

    // The lost device is locked out by the epoch bump.
    sim.as({ deviceSecret });
    expect(() => sim.call('withdraw_night', NIGHT, 10n, RECIPIENT)).toThrow(
      /device of revoked epoch/,
    );

    // Grants issued before recovery are dead too.
    sim.as({ grantSecret });
    expect(() => sim.call('grant_withdraw_night', NIGHT, 10n, RECIPIENT)).toThrow(
      /grant of revoked epoch/,
    );
  });

  it('a below-threshold quorum cannot reconstruct the secret', () => {
    const rotated = newRecoverySecret();
    const nonce = newSessionNonce();
    const nonceHex = bytesToHex(nonce);
    const papers = [1, 2, 3].map(newPaperKey);
    const replies = papers.map((p) => paperSigma(p, sim.address, nonceHex));
    const phi = buildPhi(rotated, replies, { t: 1, n: 4 });
    const ZERO = new Uint8Array(32);
    sim.call(
      'publish_recovery_backup',
      recoveryCommitment(rotated),
      nonce,
      phi[0],
      phi[1],
      ZERO,
      ZERO,
      2n,
    );

    // One share is below the threshold of two: the library refuses outright.
    expect(() =>
      reconstructRecoverySecret(phi, [replies[0]], { t: 1, n: 4 }),
    ).toThrow(/[Ii]nsufficient/);

    // A wrong second share interpolates to garbage that fails the commitment.
    const forged = paperSigma(newPaperKey(2), sim.address, nonceHex);
    const wrong = reconstructRecoverySecret(phi, [replies[0], forged], { t: 1, n: 4 });
    expect(recoveryCommitment(wrong)).not.toBe(sim.ledger().recovery);
  });

  it('old recovery secret stops working after rotation', () => {
    sim.call('recover', deviceCommitment(randomBytes32()), recoveryCommitment(newRecoverySecret()));
    // Same (old) recovery secret again — the commitment has rotated.
    expect(() =>
      sim.call('recover', deviceCommitment(randomBytes32()), recoveryCommitment(randomBytes32())),
    ).toThrow(/invalid recovery secret/);
  });
});
