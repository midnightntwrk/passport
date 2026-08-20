import { describe, expect, it } from 'vitest';

import {
  PASSPORT_TX_PROTOCOL,
  createPassportTxResponse,
  parsePassportIncentiveReport,
  parsePassportTxRequest,
  parsePassportTxResponse,
  type PassportTxRequest,
} from '../src/txProtocol.js';
import {
  MAX_PROFILE_ADDRESS_LENGTH,
  MAX_TX_RECIPIENT_ADDRESS_LENGTH,
  randomRequestId,
} from '../src/index.js';

const VALID_REQUEST = {
  protocol: PASSPORT_TX_PROTOCOL,
  type: 'passport.tx.request',
  requestId: 'request-1',
  nonce: 'nonce-1',
  intent: {
    kind: 'unshielded-transfer',
    recipientAddress: 'mn_addr_preview1qqqqqqqqqqqqqqq',
    amount: '100000',
    purpose: 'F1 Grand Prix raffle entry',
  },
} as const;

function requestWithIntent(patch: Record<string, unknown>): unknown {
  return { ...VALID_REQUEST, intent: { ...VALID_REQUEST.intent, ...patch } };
}

describe('Passport transaction request', () => {
  it('accepts a well-formed unshielded transfer request', () => {
    expect(parsePassportTxRequest(VALID_REQUEST)).toEqual({
      protocol: PASSPORT_TX_PROTOCOL,
      type: 'passport.tx.request',
      requestId: 'request-1',
      nonce: 'nonce-1',
      intent: {
        kind: 'unshielded-transfer',
        recipientAddress: 'mn_addr_preview1qqqqqqqqqqqqqqq',
        amount: '100000',
        purpose: 'F1 Grand Prix raffle entry',
      },
    });
  });

  it('drops fields the protocol does not define', () => {
    const parsed = parsePassportTxRequest({
      ...VALID_REQUEST,
      extra: 'ignored',
      intent: { ...VALID_REQUEST.intent, feePayer: 'passport' },
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual(['protocol', 'type', 'requestId', 'nonce', 'intent']);
    expect(Object.keys(parsed!.intent)).toEqual([
      'kind',
      'recipientAddress',
      'amount',
      'purpose',
    ]);
  });

  it('rejects a zero amount in every padded form', () => {
    expect(parsePassportTxRequest(requestWithIntent({ amount: '0' }))).toBeNull();
    expect(parsePassportTxRequest(requestWithIntent({ amount: '000' }))).toBeNull();
  });

  it('rejects amounts that are not plain base-10 atomic units', () => {
    for (const amount of ['1e5', '0.1', '-100000', ' 100000', '100_000', '0x10', '']) {
      expect(parsePassportTxRequest(requestWithIntent({ amount }))).toBeNull();
    }
    // 20 digits is the cap; 21 is refused.
    expect(parsePassportTxRequest(requestWithIntent({ amount: '1'.repeat(20) }))).not.toBeNull();
    expect(parsePassportTxRequest(requestWithIntent({ amount: '1'.repeat(21) }))).toBeNull();
  });

  it('rejects a numeric amount — atomic units must survive the wire exactly', () => {
    expect(parsePassportTxRequest(requestWithIntent({ amount: 100000 }))).toBeNull();
  });

  it('rejects a missing or empty purpose', () => {
    expect(parsePassportTxRequest(requestWithIntent({ purpose: undefined }))).toBeNull();
    expect(parsePassportTxRequest(requestWithIntent({ purpose: '' }))).toBeNull();
  });

  it('rejects any intent kind other than an unshielded transfer', () => {
    expect(parsePassportTxRequest(requestWithIntent({ kind: 'shielded-transfer' }))).toBeNull();
    expect(parsePassportTxRequest(requestWithIntent({ kind: 'contract-call' }))).toBeNull();
    expect(parsePassportTxRequest(requestWithIntent({ kind: undefined }))).toBeNull();
  });

  it('rejects oversize strings', () => {
    expect(parsePassportTxRequest({ ...VALID_REQUEST, requestId: 'r'.repeat(257) })).toBeNull();
    expect(parsePassportTxRequest({ ...VALID_REQUEST, nonce: 'n'.repeat(257) })).toBeNull();
    expect(
      parsePassportTxRequest(requestWithIntent({ purpose: 'p'.repeat(141) })),
    ).toBeNull();
    expect(
      parsePassportTxRequest(requestWithIntent({ recipientAddress: 'a'.repeat(201) })),
    ).toBeNull();
    // The caps are inclusive at the boundary.
    expect(parsePassportTxRequest(requestWithIntent({ purpose: 'p'.repeat(140) }))).not.toBeNull();
    expect(
      parsePassportTxRequest(requestWithIntent({ recipientAddress: 'a'.repeat(200) })),
    ).not.toBeNull();
  });

  it('rejects an empty recipient, an empty id, and a missing nonce', () => {
    expect(parsePassportTxRequest(requestWithIntent({ recipientAddress: '' }))).toBeNull();
    expect(parsePassportTxRequest({ ...VALID_REQUEST, requestId: '' })).toBeNull();
    expect(parsePassportTxRequest({ ...VALID_REQUEST, nonce: undefined })).toBeNull();
  });

  it('rejects the wrong protocol, the wrong type, and non-records', () => {
    expect(parsePassportTxRequest({ ...VALID_REQUEST, protocol: 'org.evil/v1' })).toBeNull();
    expect(parsePassportTxRequest({ ...VALID_REQUEST, type: 'passport.tx.response' })).toBeNull();
    expect(parsePassportTxRequest({ ...VALID_REQUEST, intent: 'unshielded-transfer' })).toBeNull();
    expect(parsePassportTxRequest(null)).toBeNull();
    expect(parsePassportTxRequest([VALID_REQUEST])).toBeNull();
    expect(parsePassportTxRequest('passport.tx.request')).toBeNull();
  });
});

describe('Passport transaction response', () => {
  const request = parsePassportTxRequest(VALID_REQUEST) as PassportTxRequest;

  it('binds a reply to the request id and nonce', () => {
    const response = createPassportTxResponse(request, {
      status: 'submitted',
      txId: '0f2c9ab1',
    });
    expect(response).toEqual({
      protocol: PASSPORT_TX_PROTOCOL,
      type: 'passport.tx.response',
      requestId: 'request-1',
      nonce: 'nonce-1',
      status: 'submitted',
      txId: '0f2c9ab1',
    });
    expect(parsePassportTxResponse(response)).toEqual(response);
  });

  it('refuses to construct a submitted reply without a transaction id', () => {
    expect(() => createPassportTxResponse(request, { status: 'submitted' })).toThrow(
      /transaction id/i,
    );
    expect(() =>
      createPassportTxResponse(request, { status: 'submitted', txId: '' }),
    ).toThrow(/transaction id/i);
  });

  it('refuses to construct a refusal without a known error code', () => {
    expect(() => createPassportTxResponse(request, { status: 'failed' })).toThrow(/error code/i);
    expect(() =>
      // @ts-expect-error — an unknown code is exactly what must be refused.
      createPassportTxResponse(request, { status: 'failed', error: 'kaput' }),
    ).toThrow(/error code/i);
  });

  it('rejects a submitted response with no txId when parsing', () => {
    expect(
      parsePassportTxResponse({
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.response',
        requestId: 'request-1',
        nonce: 'nonce-1',
        status: 'submitted',
      }),
    ).toBeNull();
    expect(
      parsePassportTxResponse({
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.response',
        requestId: 'request-1',
        nonce: 'nonce-1',
        status: 'submitted',
        txId: '',
      }),
    ).toBeNull();
  });

  it('rejects a refusal carrying no error code or an unknown one', () => {
    for (const error of [undefined, 'denied', 'insufficient_funds', 42]) {
      expect(
        parsePassportTxResponse({
          protocol: PASSPORT_TX_PROTOCOL,
          type: 'passport.tx.response',
          requestId: 'request-1',
          nonce: 'nonce-1',
          status: 'declined',
          error,
        }),
      ).toBeNull();
    }
  });

  it('accepts every named refusal, with an optional detail', () => {
    const declined = createPassportTxResponse(request, {
      status: 'declined',
      error: 'declined',
    });
    expect(parsePassportTxResponse(declined)).toEqual(declined);

    const failed = createPassportTxResponse(request, {
      status: 'failed',
      error: 'insufficient-funds',
      detail: 'This wallet holds 0 NIGHT; 0.1 is required.',
    });
    expect(parsePassportTxResponse(failed)?.detail).toBe(
      'This wallet holds 0 NIGHT; 0.1 is required.',
    );
  });

  it('rejects an oversize detail rather than letting it reach the UI', () => {
    expect(
      parsePassportTxResponse({
        ...createPassportTxResponse(request, { status: 'failed', error: 'submit-failed' }),
        detail: 'd'.repeat(401),
      }),
    ).toBeNull();
  });

  it('rejects an unknown status', () => {
    expect(
      parsePassportTxResponse({
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.response',
        requestId: 'request-1',
        nonce: 'nonce-1',
        status: 'pending',
      }),
    ).toBeNull();
  });

  it('does not carry a transaction id onto a refusal', () => {
    /* The reply may not say two things at once: a refusal that also names a
       transaction would let a caller read 'declined' and still find an id to
       show, link, or treat as proof that something was submitted. */
    for (const status of ['declined', 'failed'] as const) {
      const parsed = parsePassportTxResponse({
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.response',
        requestId: 'request-1',
        nonce: 'nonce-1',
        status,
        error: 'declined',
        txId: '0f2c9ab1',
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.status).toBe(status);
      expect(parsed!.error).toBe('declined');
      expect(parsed).not.toHaveProperty('txId');
    }
  });

  it('does not carry an error code onto a submitted reply', () => {
    /* The mirror image: a submitted transaction exists, so nothing on the
       reply may name the reason it did not happen. */
    const parsed = parsePassportTxResponse({
      protocol: PASSPORT_TX_PROTOCOL,
      type: 'passport.tx.response',
      requestId: 'request-1',
      nonce: 'nonce-1',
      status: 'submitted',
      txId: '0f2c9ab1',
      error: 'submit-failed',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('submitted');
    expect(parsed!.txId).toBe('0f2c9ab1');
    expect(parsed).not.toHaveProperty('error');
  });
});

describe('Passport incentive report', () => {
  const base = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.incentive.report',
    requestId: 'request-1',
    nonce: 'nonce-1',
  } as const;

  it('accepts a report with and without a transaction id', () => {
    expect(
      parsePassportIncentiveReport({
        ...base,
        incentive: { id: 'raffle-entry:0f2c', label: 'F1 Grand Prix raffle entry', txId: '0f2c' },
      }),
    ).toEqual({
      ...base,
      incentive: { id: 'raffle-entry:0f2c', label: 'F1 Grand Prix raffle entry', txId: '0f2c' },
    });

    const noTx = parsePassportIncentiveReport({
      ...base,
      incentive: { id: 'grab-credit:mn_addr', label: 'Grab ride credit' },
    });
    expect(noTx?.incentive).toEqual({ id: 'grab-credit:mn_addr', label: 'Grab ride credit' });
    expect(noTx?.incentive.txId).toBeUndefined();
  });

  it('rejects a report with no id, no label, or oversize fields', () => {
    expect(parsePassportIncentiveReport({ ...base, incentive: { label: 'x' } })).toBeNull();
    expect(parsePassportIncentiveReport({ ...base, incentive: { id: 'x' } })).toBeNull();
    expect(
      parsePassportIncentiveReport({ ...base, incentive: { id: 'x', label: 'l'.repeat(81) } }),
    ).toBeNull();
    expect(
      parsePassportIncentiveReport({
        ...base,
        incentive: { id: 'x', label: 'y', txId: 't'.repeat(257) },
      }),
    ).toBeNull();
  });

  it('does not mistake a transaction request or response for a report', () => {
    expect(parsePassportIncentiveReport(VALID_REQUEST)).toBeNull();
    expect(parsePassportTxRequest({ ...base, incentive: { id: 'x', label: 'y' } })).toBeNull();
  });
});

describe('randomRequestId', () => {
  it('mints unguessable hex ids of the requested length', () => {
    // 24 bytes by default — the width every connector should mint at.
    expect(randomRequestId()).toMatch(/^[0-9a-f]{48}$/);
    expect(randomRequestId(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomRequestId()).not.toBe(randomRequestId());
    expect(() => randomRequestId(0)).toThrow(/at least one random byte/);
    expect(() => randomRequestId(1.5)).toThrow(/at least one random byte/);
  });
});

describe('shared address caps', () => {
  it('keeps the recipient cap deliberately tighter than the profile cap', () => {
    // Both live in one module so the divergence is visible and explained: a
    // profile address may be shielded and long, a tx recipient is
    // unshielded-only. Values unchanged — this pins them against silent drift.
    expect(MAX_TX_RECIPIENT_ADDRESS_LENGTH).toBe(200);
    expect(MAX_PROFILE_ADDRESS_LENGTH).toBe(512);
    expect(MAX_TX_RECIPIENT_ADDRESS_LENGTH).toBeLessThan(MAX_PROFILE_ADDRESS_LENGTH);
    // And the tx parser really enforces the tighter one.
    expect(
      parsePassportTxRequest({
        ...VALID_REQUEST,
        intent: { ...VALID_REQUEST.intent, recipientAddress: 'a'.repeat(201) },
      }),
    ).toBeNull();
  });
});
