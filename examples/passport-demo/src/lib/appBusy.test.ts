/**
 * The busy counter that decides whether `src/pwa.tsx` may reload this document
 * for a new deployment.
 *
 * The module is a singleton by design — there is one Passport per tab — so
 * every case here releases every hold it takes before it ends. A test that
 * leaked a hold would make the next one read a busy app and pass for the wrong
 * reason, which is precisely the failure the counter exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import { criticalWorkInFlight, holdCriticalWork, subscribeCriticalWork } from './appBusy.js';

describe('criticalWorkInFlight', () => {
  it('is idle with nothing held', () => {
    expect(criticalWorkInFlight()).toBe(false);
  });

  it('is busy for the life of a hold', () => {
    const release = holdCriticalWork();
    expect(criticalWorkInFlight()).toBe(true);
    release();
    expect(criticalWorkInFlight()).toBe(false);
  });

  it('stays busy until the LAST of several overlapping holds is released', () => {
    // The onboarding case: an account deploy and a name registration overlap,
    // and neither finishing is the app becoming idle.
    const deploy = holdCriticalWork();
    const registration = holdCriticalWork();
    deploy();
    expect(criticalWorkInFlight()).toBe(true);
    registration();
    expect(criticalWorkInFlight()).toBe(false);
  });

  it('ignores a release that has already been made', () => {
    const release = holdCriticalWork();
    release();
    release();
    // Had the second release decremented, the count would be -1 and the next
    // hold would leave it at 0 — an app busy on screen and idle here.
    const second = holdCriticalWork();
    expect(criticalWorkInFlight()).toBe(true);
    second();
    expect(criticalWorkInFlight()).toBe(false);
  });
});

describe('subscribeCriticalWork', () => {
  it('publishes only the transitions, not every hold', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeCriticalWork((inFlight) => seen.push(inFlight));

    const first = holdCriticalWork();
    const second = holdCriticalWork();
    first();
    second();

    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  it('stops publishing once unsubscribed', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeCriticalWork((inFlight) => seen.push(inFlight));
    unsubscribe();

    const release = holdCriticalWork();
    release();

    expect(seen).toEqual([]);
  });

  it('lets a listener unsubscribe itself from inside its own callback', () => {
    const seen: boolean[] = [];
    const other: boolean[] = [];
    const unsubscribeOther = subscribeCriticalWork((inFlight) => other.push(inFlight));
    const unsubscribe = subscribeCriticalWork((inFlight) => {
      seen.push(inFlight);
      unsubscribe();
    });

    const release = holdCriticalWork();
    release();

    // The self-removing listener saw the first transition and no more; its
    // neighbour saw both, which it would not have had the set been mutated
    // mid-iteration.
    expect(seen).toEqual([true]);
    expect(other).toEqual([true, false]);
    unsubscribeOther();
  });
});
