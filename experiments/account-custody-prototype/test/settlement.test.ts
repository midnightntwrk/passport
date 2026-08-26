// The deposit-accounting invariant (the night_balances mirror never
// overstating actual custodied value) used to be checkable only on a real
// node: the simulator executed circuits without settling token effects, so
// a change that credited the mirror without receiving the coin passed the
// whole unit suite. The simulator now reconciles the mirror delta against
// the claimed token effects after every call; these tests pin the checker
// itself, and every other simulator test exercises the wiring.

import { describe, it, expect, beforeEach } from 'vitest';

import { AccountSimulator, reconcileNightSettlement } from './simulator.js';
import { randomBytes32, hexToBytes32 } from '../src/wallet/hex.js';
import { deviceCommitment } from '../src/wallet/contract.js';

const NIGHT = hexToBytes32('01');
const OTHER = hexToBytes32('02');
const RECIPIENT = { bytes: hexToBytes32('aabbcc') };

const totals = (entries: Array<[string, bigint]>) => new Map(entries);

describe('reconcileNightSettlement', () => {
  it('accepts a mirror credit matched by a claimed input', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'deposit_night',
        claimedIn: totals([['01', 1000n]]),
        claimedOut: totals([]),
        mirrorDelta: totals([['01', 1000n]]),
      }),
    ).not.toThrow();
  });

  it('rejects a mirror credit with no claimed coin behind it (overstatement)', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'deposit_night',
        claimedIn: totals([]),
        claimedOut: totals([]),
        mirrorDelta: totals([['01', 1000n]]),
      }),
    ).toThrow(/night settlement mismatch in deposit_night for color 01/);
  });

  it('rejects a claimed coin the mirror never credited (understatement)', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'deposit_night',
        claimedIn: totals([['01', 1000n]]),
        claimedOut: totals([]),
        mirrorDelta: totals([]),
      }),
    ).toThrow(/night settlement mismatch/);
  });

  it('rejects a partial credit (deposited amount != credited amount)', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'deposit_night',
        claimedIn: totals([['01', 1000n]]),
        claimedOut: totals([]),
        mirrorDelta: totals([['01', 999n]]),
      }),
    ).toThrow(/mirror moved by 999, claimed token effects total 1000/);
  });

  it('rejects a withdrawal that debits the mirror without sending', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'withdraw_night',
        claimedIn: totals([]),
        claimedOut: totals([]),
        mirrorDelta: totals([['01', -400n]]),
      }),
    ).toThrow(/night settlement mismatch in withdraw_night/);
  });

  it('reconciles colors independently', () => {
    expect(() =>
      reconcileNightSettlement({
        circuit: 'deposit_night',
        claimedIn: totals([
          ['01', 100n],
          ['02', 200n],
        ]),
        claimedOut: totals([]),
        mirrorDelta: totals([
          ['01', 100n],
          ['02', 150n],
        ]),
      }),
    ).toThrow(/for color 02/);
  });
});

describe('settlement reconciliation through the simulator', () => {
  let sim: AccountSimulator;

  beforeEach(() => {
    sim = new AccountSimulator({
      deviceSecret: randomBytes32(),
      recoverySecret: randomBytes32(),
    });
  });

  it('passes conforming deposit and withdrawal flows', () => {
    sim.call('deposit_night', NIGHT, 1000n);
    sim.call('deposit_night', OTHER, 50n);
    sim.call('withdraw_night', NIGHT, 400n, RECIPIENT);
    expect(sim.ledger().night_balances.lookup(NIGHT)).toBe(600n);
    expect(sim.ledger().night_balances.lookup(OTHER)).toBe(50n);
  });

  it('passes circuits that move no tokens at all', () => {
    expect(() => sim.call('add_device', deviceCommitment(randomBytes32()))).not.toThrow();
  });
});
