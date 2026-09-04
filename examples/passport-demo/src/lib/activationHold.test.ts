/**
 * The hold that keeps a grant coin out of a nameless Passport.
 *
 * The defect it was written for is in the module header: a registration
 * refused at the sponsor's hourly ceiling at 17:38:02 on 2026/09/04, and a
 * `/fund-account` posted for the same account a second later, which succeeded.
 * The account ended with NIGHT and a stablecoin balance and no name, and the
 * grant is once per account for ever.
 *
 * Exercised against a minimal in-memory `localStorage`, as `aliasStore.test.ts`
 * exercises the alias records, because these functions talk to
 * `window.localStorage` directly and a mocked store would leave the rule
 * unenforced.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  activationGrantHeld,
  holdActivationGrant,
  refusalHoldsActivation,
  releaseActivationGrant,
} from './activationHold.js';

const ACCOUNT = '0200abcdef';
const OTHER = '0200fedcba';

/** The smallest thing that behaves like `window.localStorage`. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
      },
    },
  });
  return map;
}

/** A browser with no storage at all, so every access throws rather than answering. */
function installUnreadableStorage(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get localStorage(): never {
        throw new Error('storage is denied to this document');
      },
    },
  });
}

describe('refusalHoldsActivation', () => {
  it('holds the grant for the ceiling refusal the soak recorded', () => {
    /* THE ONE THIS EXISTS FOR. `rate-limited` is what the sponsor answers at
       its hourly ceiling, and it is the refusal that left an account funded
       and nameless. */
    expect(refusalHoldsActivation('rate-limited')).toBe(true);
  });

  it('holds it for every other refusal that leaves the name queued', () => {
    for (const code of ['funder-empty', 'funder-no-dust', 'name-taken', 'target-missing', 'unreachable']) {
      expect(refusalHoldsActivation(code)).toBe(true);
    }
  });

  it('does NOT hold it where the name may already be registered', () => {
    /* The same pair `selfPayWorthTrying` refuses a retry for: the service
       cannot say whether the registration landed. Holding a grant on a name
       that may be on chain would strand a Passport that is complete. */
    expect(refusalHoldsActivation('registration-in-flight')).toBe(false);
    expect(refusalHoldsActivation('confirmation-failed')).toBe(false);
  });
});

describe('the hold itself', () => {
  beforeEach(() => {
    installStorage();
  });

  it('is not held for an account nobody has refused', () => {
    expect(activationGrantHeld(ACCOUNT)).toBe(false);
  });

  it('holds the account it was given, and only that one', () => {
    holdActivationGrant(ACCOUNT, 'rate-limited');
    expect(activationGrantHeld(ACCOUNT)).toBe(true);
    /* A second Passport on the same device is a second account, and a ceiling
       refusal for one of them must not stop the other being funded. */
    expect(activationGrantHeld(OTHER)).toBe(false);
  });

  it('keeps the refusal code, for whoever reads the storage', () => {
    const map = installStorage();
    holdActivationGrant(ACCOUNT, 'rate-limited');
    expect(map.get(`mn-passport:activation-held:${ACCOUNT}`)).toBe('rate-limited');
  });

  it('lifts on release, which is what a registered name does', () => {
    holdActivationGrant(ACCOUNT, 'rate-limited');
    releaseActivationGrant(ACCOUNT);
    expect(activationGrantHeld(ACCOUNT)).toBe(false);
  });

  it('releases an account that was never held without complaining', () => {
    /* The claim releases on EVERY registered name rather than only on the
       ones it held, because the claim does not know which it is. */
    expect(() => releaseActivationGrant(ACCOUNT)).not.toThrow();
    expect(activationGrantHeld(ACCOUNT)).toBe(false);
  });

  it('survives a reload, which is the whole reason it is persisted', () => {
    const map = installStorage();
    map.set(`mn-passport:activation-held:${ACCOUNT}`, 'rate-limited');
    /* The wallet-ready effect asks for a pending grant on every launch. A hold
       kept only in memory would be gone by the first reload and the coin spent
       on the second visit instead of the first. */
    expect(activationGrantHeld(ACCOUNT)).toBe(true);
  });
});

describe('a browser that will not answer about its storage', () => {
  beforeEach(() => {
    installUnreadableStorage();
  });

  it('reads as not held rather than throwing at the schedule', () => {
    expect(activationGrantHeld(ACCOUNT)).toBe(false);
  });

  it('places a hold it cannot write without failing the claim', () => {
    /* The claim has already told the user what happened. Replacing that with a
       storage error costs more than the coin the hold was protecting. */
    expect(() => holdActivationGrant(ACCOUNT, 'rate-limited')).not.toThrow();
  });

  it('releases without throwing, leaving the account held', () => {
    expect(() => releaseActivationGrant(ACCOUNT)).not.toThrow();
  });
});
