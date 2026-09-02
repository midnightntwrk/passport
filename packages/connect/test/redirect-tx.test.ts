/**
 * The redirect channel's second exchange — the one that lets the phone path a
 * QR code lands on actually complete a payment.
 *
 * It is held to the same rules as the profile exchange, plus one the profile
 * exchange does not need: the reply has to ECHO THE INTENT it is answering.
 * A signed "submitted" with no subject would prove that a Passport said
 * something, not that it paid what this app asked it to pay.
 */

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  PASSPORT_CALLBACK_PROTOCOL,
  PASSPORT_CALLBACK_SIGNATURE_SCHEME,
  buildPassportTxLaunchUrl,
  parsePassportCallbackTxPayload,
  parsePassportTxCallbackReturn,
  readPassportTxCallback,
  toBase64Url,
  verifyPassportTxCallbackReply,
  type PassportCallbackEnvelope,
  type PassportCallbackTxIntent,
} from '../src/redirect/index.js';
import { PassportProtocolError } from '../src/protocol/errors.js';

const AUDIENCE = 'https://doorman.example';
const SECRET_KEY = new Uint8Array(32).fill(3);
const PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(SECRET_KEY));
const NOW = 1_800_000_000_000;

const INTENT: PassportCallbackTxIntent = {
  kind: 'unshielded-transfer',
  recipientAddress: 'mn_addr_stagenet1qqdoorman',
  amount: '100000',
  purpose: 'Doorman cover charge',
};

function seal(payload: object): PassportCallbackEnvelope {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.response',
    payload: toBase64Url(bytes),
    scheme: PASSPORT_CALLBACK_SIGNATURE_SCHEME,
    publicKey: PUBLIC_KEY,
    signature: bytesToHex(schnorr.sign(sha256(bytes), SECRET_KEY)),
  };
}

function txPayload(patch: Record<string, unknown> = {}) {
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.tx',
    version: 1,
    audience: AUDIENCE,
    state: 'state-1',
    issuedAt: NOW - 3_000,
    nonce: 'tx-nonce-1',
    intent: INTENT,
    status: 'submitted',
    txId: '0f2c9ab1',
    sponsored: true,
    feeNote: 'Covered by the 1AM gateway.',
    ...patch,
  };
}

const OPTIONS = {
  expectedAudience: AUDIENCE,
  expectedState: 'state-1',
  expectedIntent: INTENT,
  now: NOW,
};

describe('the payment launch', () => {
  it('uses its own parameter names, so one navigation serves one exchange', () => {
    const url = new URL(
      buildPassportTxLaunchUrl({
        passportOrigin: 'https://midnightpassport.example',
        callbackUrl: 'https://doorman.example/return',
        recipientAddress: INTENT.recipientAddress,
        amount: 100_000n,
        purpose: INTENT.purpose,
        state: 'state-1',
      }),
    );
    expect(url.searchParams.get('passportTxCallback')).toBe('https://doorman.example/return');
    expect(url.searchParams.get('passportTxRecipient')).toBe(INTENT.recipientAddress);
    expect(url.searchParams.get('passportTxAmount')).toBe('100000');
    expect(url.searchParams.get('passportTxPurpose')).toBe(INTENT.purpose);
    expect(url.searchParams.get('passportTxState')).toBe('state-1');
    /* Deliberately not the profile launch's names: a payment launch must not
       be able to arm the profile consent surface. */
    expect(url.searchParams.get('passportCallback')).toBeNull();
    expect(url.searchParams.get('passportFields')).toBeNull();
  });

  it('refuses an intent the protocol cannot carry, at the call site', () => {
    const base = {
      passportOrigin: 'https://p.example',
      callbackUrl: 'https://doorman.example/return',
      recipientAddress: INTENT.recipientAddress,
      amount: '100000',
      purpose: 'Cover charge',
      state: 's',
    };
    expect(() => buildPassportTxLaunchUrl({ ...base, amount: '0' })).toThrow(/greater than zero/);
    expect(() => buildPassportTxLaunchUrl({ ...base, amount: '1.5' })).toThrow(/atomic NIGHT/);
    expect(() => buildPassportTxLaunchUrl({ ...base, recipientAddress: '' })).toThrow(
      /recipientAddress/,
    );
    expect(() => buildPassportTxLaunchUrl({ ...base, recipientAddress: 'a'.repeat(201) })).toThrow(
      /recipientAddress/,
    );
    expect(() => buildPassportTxLaunchUrl({ ...base, purpose: '' })).toThrow(/purpose/);
    expect(() => buildPassportTxLaunchUrl({ ...base, purpose: 'p'.repeat(141) })).toThrow(/purpose/);
    expect(() => buildPassportTxLaunchUrl({ ...base, state: 's'.repeat(257) })).toThrow(
      PassportProtocolError,
    );
  });
});

describe('the payment return', () => {
  it('reads its own fragment parameters and nobody else’s', () => {
    const envelope = seal(txPayload());
    const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
    expect(parsePassportTxCallbackReturn(`#passportTxResponse=${encoded}`)).toEqual({
      kind: 'response',
      envelope,
    });
    /* A profile reply in the fragment is not a payment reply. */
    expect(parsePassportTxCallbackReturn(`#passportResponse=${encoded}`)).toEqual({
      kind: 'absent',
    });
    expect(parsePassportTxCallbackReturn('#passportTxError=declined&passportTxState=s')).toEqual({
      kind: 'error',
      code: 'declined',
      state: 's',
    });
    /* And the reader with no window is still total. */
    expect(readPassportTxCallback({ hash: `#passportTxResponse=${encoded}` })).toMatchObject({
      kind: 'response',
    });
  });
});

describe('verifying a payment reply', () => {
  it('accepts a good one and shows the intent echo in the trail', () => {
    const verdict = verifyPassportTxCallbackReply(seal(txPayload()), OPTIONS);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.payload.txId).toBe('0f2c9ab1');
    expect(verdict.ok && verdict.payload.sponsored).toBe(true);
    expect(verdict.checks.at(-1)).toMatchObject({
      label: 'Reply echoes the payment this app asked for',
      ok: true,
    });
    expect(verdict.checks.every((check) => check.ok)).toBe(true);
  });

  it('refuses a reply lifted from a different payment', () => {
    /* Same Passport, same signature, same freshness — a different payment.
       Without the echo this would verify, and an app would credit somebody for
       a cover charge they paid to a different door. */
    for (const patch of [
      { recipientAddress: 'mn_addr_stagenet1qqsomebodyelse' },
      { amount: '1' },
      { purpose: 'Something else entirely' },
    ]) {
      const verdict = verifyPassportTxCallbackReply(
        seal(txPayload({ intent: { ...INTENT, ...patch } })),
        OPTIONS,
      );
      expect(verdict.ok, JSON.stringify(patch)).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/different payment/);
      expect(verdict.checks.at(-1)!.ok).toBe(false);
    }
  });

  it('applies the same audience, state, freshness, and replay rules', () => {
    expect(
      verifyPassportTxCallbackReply(seal(txPayload({ audience: 'https://evil.example' })), OPTIONS)
        .ok,
    ).toBe(false);
    expect(
      verifyPassportTxCallbackReply(seal(txPayload({ state: 'other' })), OPTIONS).ok,
    ).toBe(false);
    expect(
      verifyPassportTxCallbackReply(seal(txPayload({ issuedAt: NOW - 6 * 60_000 })), OPTIONS).ok,
    ).toBe(false);
    expect(
      verifyPassportTxCallbackReply(seal(txPayload()), {
        ...OPTIONS,
        seenNonce: () => true,
      }).ok,
    ).toBe(false);
  });

  it('carries the honesty invariants onto the signed channel', () => {
    /* A signature over a dishonest claim is a signed lie, so the same rules
       the postMessage protocol enforces are enforced here too. */
    for (const patch of [
      /* submitted with no transaction id */
      { txId: undefined },
      { txId: '' },
      { txId: 't'.repeat(257) },
      /* a covered fee on something that was never submitted */
      { status: 'failed', error: 'submit-failed', txId: undefined, sponsored: true },
      /* a refusal with no named reason */
      { status: 'declined', txId: undefined, sponsored: undefined },
      { status: 'declined', error: 'nope', txId: undefined, sponsored: undefined },
      /* a truthy string buying a fee-covered badge */
      { sponsored: 'true' },
      /* shapes that are not this exchange at all */
      { status: 'pending' },
      { intent: { ...INTENT, kind: 'shielded-transfer' } },
      { intent: { ...INTENT, amount: '0' } },
      { intent: { ...INTENT, amount: 100000 } },
      { intent: { ...INTENT, recipientAddress: '' } },
      { intent: { ...INTENT, recipientAddress: 'a'.repeat(201) } },
      { intent: { ...INTENT, purpose: '' } },
      { intent: { ...INTENT, purpose: 'p'.repeat(141) } },
      { intent: 'unshielded-transfer' },
      { detail: 'd'.repeat(401) },
      { feeNote: 'f'.repeat(141) },
      { type: 'passport.callback.profile' },
      { protocol: 'org.evil/v1' },
      { version: 2 },
      { version: 1.5 },
      { audience: 42 },
      { issuedAt: 'now' },
      { nonce: '' },
      { state: 42 },
    ]) {
      const verdict = verifyPassportTxCallbackReply(seal(txPayload(patch)), OPTIONS);
      expect(verdict.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(parsePassportCallbackTxPayload('nope')).toBeNull();
  });

  it('carries a named refusal through, and drops the contradictions', () => {
    const verdict = verifyPassportTxCallbackReply(
      seal(
        txPayload({
          status: 'declined',
          error: 'declined',
          detail: 'The cover charge was declined on the approval sheet.',
          txId: undefined,
          sponsored: undefined,
          feeNote: undefined,
        }),
      ),
      OPTIONS,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.payload.status).toBe('declined');
    expect(verdict.ok && verdict.payload.error).toBe('declined');
    expect(verdict.ok && verdict.payload).not.toHaveProperty('txId');

    /* And a reply that names a transaction on a refusal does not get to keep
       it: the status is what decides which fields may be carried. */
    const contradictory = verifyPassportTxCallbackReply(
      seal(
        txPayload({
          status: 'failed',
          error: 'submit-failed',
          txId: 'looks-real',
          sponsored: undefined,
          feeNote: undefined,
        }),
      ),
      OPTIONS,
    );
    expect(contradictory.ok).toBe(true);
    expect(contradictory.ok && contradictory.payload).not.toHaveProperty('txId');
  });

  it('accepts a submission with no sponsorship claim as user-paid', () => {
    const verdict = verifyPassportTxCallbackReply(
      seal(txPayload({ sponsored: undefined, feeNote: undefined })),
      OPTIONS,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.payload).not.toHaveProperty('sponsored');
    const explicit = verifyPassportTxCallbackReply(
      seal(txPayload({ sponsored: false, feeNote: undefined })),
      OPTIONS,
    );
    expect(explicit.ok && explicit.payload.sponsored).toBe(false);
  });

  it('reads a reply that predates the version field as revision one', () => {
    /* Absence means 1. A Passport that has not been updated yet still
       interoperates, which is the entire reason the field is optional. */
    const { version: _dropped, ...withoutVersion } = txPayload();
    expect(verifyPassportTxCallbackReply(seal(withoutVersion), OPTIONS).ok).toBe(true);
  });

  it('accepts a reply with no state where none was sent', () => {
    const verdict = verifyPassportTxCallbackReply(seal(txPayload({ state: undefined })), {
      ...OPTIONS,
      expectedState: null,
    });
    expect(verdict.ok).toBe(true);
  });
});
