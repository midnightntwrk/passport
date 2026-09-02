/**
 * The client and the two transports, driven against a fake window.
 *
 * What is being drilled here is everything each integrating app used to write
 * by hand and get subtly different: the origin gate, the source gate, matching
 * a reply to its own pair, the budget, the closed-window poll, the blocked
 * pop-up, and the sentence a user is shown for each outcome.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createPassport,
  type PassportPaymentResult,
  type PassportProfileResult,
} from '../src/core/client.js';
import { PASSPORT_LAUNCH_PARAMS, PASSPORT_WINDOW_NAME } from '../src/core/transport/popup.js';
import {
  PassportTransportError,
  type PassportChannel,
  type PassportTransport,
} from '../src/core/transport/types.js';
import {
  createPassportProfileReady,
  createPassportProfileResponse,
  type PassportProfileRequest,
} from '../src/protocol/profile.js';
import { createPassportTxResponse, type PassportTxRequest } from '../src/protocol/tx.js';
import {
  asWindow,
  createFakeWindow,
  createPeer,
  installGlobalWindow,
  tick,
} from './fakeWindow.js';

const ORIGIN = 'https://midnightpassport.example';

/* ---------------------------------------------------------------------------
 * Framed
 * ------------------------------------------------------------------------ */

function framed(overrides: Partial<Parameters<typeof createPassport>[0]> = {}) {
  const host = createFakeWindow();
  const parent = createPeer();
  host.parent = parent;
  const passport = createPassport({
    origin: `${ORIGIN}/`,
    presenceTimeoutMs: 40,
    timeoutMs: 200,
    closedPollMs: 5,
    window: asWindow(host),
    ...overrides,
  });
  return { host, parent, passport };
}

/** Answers the cold hello with a `ready`, as Passport does. */
function announce(host: ReturnType<typeof createFakeWindow>, parent: ReturnType<typeof createPeer>) {
  const ready = createPassportProfileReady('req-from-passport', 'nonce-from-passport');
  host.deliver(ready, ORIGIN, parent);
  return ready;
}

describe('framed mode', () => {
  it('detects itself, strips the trailing slash off the origin, and answers the handshake', async () => {
    const { host, parent, passport } = framed();
    expect(passport.mode).toBe('iframe');
    expect(passport.origin).toBe(ORIGIN);

    const readyEvents: unknown[] = [];
    passport.on('ready', (event) => readyEvents.push(event));

    const detecting = passport.detect();
    await tick();
    /* The cold hello — a frame asking whether anybody is there. It is a real
       protocol message now, not a string three apps happened to agree on. */
    expect(parent.posts[0]!.message).toMatchObject({ type: 'passport.profile.hello' });
    expect(parent.posts[0]!.targetOrigin).toBe(ORIGIN);

    announce(host, parent);
    expect(await detecting).toMatchObject({ present: true, via: 'handshake' });
    expect(readyEvents).toEqual([{ requestId: 'req-from-passport', nonce: 'nonce-from-passport' }]);
    /* And the ack echoes the pair, which is what stops the re-broadcast. */
    expect(parent.posts[1]!.message).toMatchObject({
      type: 'passport.profile.hello',
      requestId: 'req-from-passport',
    });
    passport.destroy();
  });

  it('answers a bounded wait with not-present rather than hanging', async () => {
    const { passport } = framed();
    expect(await passport.detect()).toMatchObject({ present: false, reason: 'no-reply' });
    await expect(passport.ready()).rejects.toBeInstanceOf(PassportTransportError);
    passport.destroy();
  });

  it('resolves ready() once the handshake lands', async () => {
    const { host, parent, passport } = framed();
    const waiting = passport.ready();
    await tick();
    announce(host, parent);
    await expect(waiting).resolves.toBeUndefined();
    passport.destroy();
  });

  it('drops messages from the wrong origin and the wrong source before parsing', async () => {
    const { host, parent, passport } = framed();
    const seen: unknown[] = [];
    passport.on('message', (event) => seen.push(event));
    /* Attach the transport first — a listener that was never added cannot
       drop anything, and a test that skipped this would pass vacuously. */
    void passport.detect();
    await tick();
    seen.length = 0;

    const ready = createPassportProfileReady('r', 'n');
    host.deliver(ready, 'https://evil.example', parent);
    host.deliver(ready, ORIGIN, createPeer());
    await tick();
    /* Nothing reached the transcript, which is itself the point: if the origin
       is wrong the log stays empty rather than filling with someone else's
       traffic. */
    expect(seen).toEqual([]);
    passport.destroy();
  });

  it('echoes the handshake pair in a profile request and settles on the reply', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestProfile(['displayName', 'passportContract']);
    await tick();
    announce(host, parent);
    await tick();

    const sent = parent.posts.find(
      (post) => (post.message as { type: string }).type === 'passport.profile.request',
    );
    const request = sent!.message as PassportProfileRequest;
    expect(request.requestId).toBe('req-from-passport');
    expect(request.fields).toEqual(['displayName', 'passportContract']);

    /* A reply bound to somebody else's pair is not our answer. */
    host.deliver(
      createPassportProfileResponse(
        { requestId: 'somebody-else', nonce: 'nonce-from-passport' },
        { approved: true, profile: { displayName: 'Mallory' } },
      ),
      ORIGIN,
      parent,
    );
    await tick();

    host.deliver(
      createPassportProfileResponse(request, {
        approved: true,
        profile: { displayName: 'Alice' },
      }),
      ORIGIN,
      parent,
    );
    const settled = (await result) as Extract<PassportProfileResult, { approved: true }>;
    expect(settled.approved).toBe(true);
    expect(settled.profile.displayName).toBe('Alice');
    /* Consent is partial: what was asked for and not returned is reported. */
    expect(settled.withheld).toEqual(['passportContract']);
    expect(settled.message).toMatch(/Not shared: passportContract/);
    passport.destroy();
  });

  it('ignores traffic that is not an answer to the exchange in flight', async () => {
    const { host, parent, passport } = framed({ timeoutMs: 60 });
    const profile = passport.requestProfile(['displayName']);
    await tick();
    announce(host, parent);
    await tick();
    /* Neither of these parses as a profile response, so neither may settle
       it — a page receives messages from extensions and frameworks too. */
    host.deliver({ type: 'analytics.pageview' }, ORIGIN, parent);
    host.deliver({ protocol: 'org.midnight.passport.profile/v1' }, ORIGIN, parent);
    expect(await profile).toMatchObject({ error: 'timed-out' });

    const payment = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    host.deliver({ type: 'analytics.pageview' }, ORIGIN, parent);
    expect(await payment).toMatchObject({ error: 'timed-out' });
    passport.destroy();
  });

  it('has a sentence for a covered fee even when Passport names no sponsor', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    const request = parent.posts.at(-1)!.message as PassportTxRequest;
    host.deliver(
      createPassportTxResponse(request, { status: 'submitted', txId: '0f2c', sponsored: true }),
      ORIGIN,
      parent,
    );
    const settled = await result;
    expect(settled.message).toMatch(/covered by a sponsor/);
    passport.destroy();
  });

  it('reports every field arriving as exactly that', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestProfile(['displayName']);
    await tick();
    announce(host, parent);
    await tick();
    host.deliver(
      createPassportProfileResponse(
        { requestId: 'req-from-passport', nonce: 'nonce-from-passport' },
        { approved: true, profile: { displayName: 'Alice' } },
      ),
      ORIGIN,
      parent,
    );
    const settled = (await result) as Extract<PassportProfileResult, { approved: true }>;
    expect(settled.withheld).toEqual([]);
    expect(settled.message).toMatch(/every field you asked for/);
    passport.destroy();
  });

  it('turns a refusal into a sentence, and says Passport said it', async () => {
    const { host, parent, passport } = framed();
    const errors: unknown[] = [];
    passport.on('error', (event) => errors.push(event));
    const result = passport.requestProfile(['displayName']);
    await tick();
    announce(host, parent);
    await tick();
    host.deliver(
      createPassportProfileResponse(
        { requestId: 'req-from-passport', nonce: 'nonce-from-passport' },
        { approved: false, error: 'version_mismatch' },
      ),
      ORIGIN,
      parent,
    );
    const settled = await result;
    expect(settled).toMatchObject({ approved: false, source: 'passport', error: 'version_mismatch' });
    expect(settled.message).toMatch(/different revisions/);
    expect(errors).toContainEqual({ code: 'version_mismatch', message: settled.message });
    passport.destroy();
  });

  it('mints a FRESH pair for a payment, never the handshake pair', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: 100_000n,
      purpose: 'Cover charge',
    });
    await tick();
    const sent = parent.posts.find(
      (post) => (post.message as { type: string }).type === 'passport.tx.request',
    );
    const request = sent!.message as PassportTxRequest;
    expect(request.requestId).not.toBe('req-from-passport');
    expect(request.intent.amount).toBe('100000');

    host.deliver(
      createPassportTxResponse(request, {
        status: 'submitted',
        txId: '0f2c9ab1',
        sponsored: true,
        feeNote: 'Covered by the 1AM gateway.',
      }),
      ORIGIN,
      parent,
    );
    const settled = (await result) as Extract<PassportPaymentResult, { status: 'submitted' }>;
    expect(settled).toMatchObject({ status: 'submitted', txId: '0f2c9ab1', sponsored: true });
    expect(settled.message).toMatch(/Covered by the 1AM gateway/);
    passport.destroy();
  });

  it('reads an unsponsored submission as user-paid, not as free', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    const request = parent.posts.find(
      (post) => (post.message as { type: string }).type === 'passport.tx.request',
    )!.message as PassportTxRequest;
    /* A reply for a different pair must be ignored even though it is valid. */
    host.deliver(
      createPassportTxResponse(
        { requestId: 'other', nonce: request.nonce },
        { status: 'submitted', txId: 'nope' },
      ),
      ORIGIN,
      parent,
    );
    host.deliver(
      createPassportTxResponse(request, { status: 'submitted', txId: '0f2c' }),
      ORIGIN,
      parent,
    );
    const settled = (await result) as Extract<PassportPaymentResult, { status: 'submitted' }>;
    expect(settled.sponsored).toBe(false);
    expect(settled).not.toHaveProperty('feeNote');
    expect(settled.message).toMatch(/paid for out of the Passport account/);
    passport.destroy();
  });

  it('carries the wallet’s own sentence through a refusal', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    const request = parent.posts.at(-1)!.message as PassportTxRequest;
    host.deliver(
      createPassportTxResponse(request, {
        status: 'failed',
        error: 'insufficient-funds',
        detail: 'This account holds 0 NIGHT.',
      }),
      ORIGIN,
      parent,
    );
    const settled = await result;
    expect(settled).toMatchObject({ status: 'failed', source: 'passport', error: 'insufficient-funds' });
    expect(settled.message).toMatch(/This account holds 0 NIGHT\./);
    passport.destroy();
  });

  it('reports a decline as declined rather than as a failure', async () => {
    const { host, parent, passport } = framed();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    const request = parent.posts.at(-1)!.message as PassportTxRequest;
    host.deliver(
      createPassportTxResponse(request, { status: 'declined', error: 'declined' }),
      ORIGIN,
      parent,
    );
    expect(await result).toMatchObject({ status: 'declined', error: 'declined' });
    passport.destroy();
  });

  it('gives up on the budget and says nothing is known', async () => {
    const { passport } = framed({ timeoutMs: 30 });
    const result = await passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    expect(result).toMatchObject({ status: 'failed', source: 'local', error: 'timed-out' });
    expect(result.message).toMatch(/did not answer in time/);
    passport.destroy();
  });

  it('refuses to send an invalid request, at the call site', async () => {
    const { passport } = framed();
    const errors: { code: string; message: string }[] = [];
    passport.on('error', (event) => errors.push(event));
    const result = await passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '0',
      purpose: 'Cover charge',
    });
    expect(result).toMatchObject({ status: 'failed', source: 'local', error: 'invalid-request' });
    expect(errors[0]!.message).toMatch(/greater than zero/);
    passport.destroy();
  });

  it('survives a caller that hands it something that is not a field list at all', async () => {
    const { host, parent, passport } = framed();
    const errors: { code: string; message: string }[] = [];
    passport.on('error', (event) => errors.push(event));
    const pending = passport.requestProfile(undefined as never);
    await tick();
    announce(host, parent);
    const result = await pending;
    expect(result).toMatchObject({ approved: false, source: 'local', error: 'invalid-request' });
    expect(errors[0]!.message).toMatch(/iterable|undefined/i);
    passport.destroy();
  });

  it('sends an incentive report, and labels it as the assertion it is', async () => {
    const { passport, parent } = framed();
    const outcome = await passport.reportIncentive({
      id: 'doorman:entry',
      label: 'Door entry',
      txId: '0f2c',
    });
    expect(outcome).toMatchObject({ sent: true });
    expect(outcome.message).toMatch(/unauthenticated assertion/);
    const report = parent.posts.at(-1)!.message as { type: string; incentive: unknown };
    expect(report.type).toBe('passport.incentive.report');
    expect(report.incentive).toEqual({ id: 'doorman:entry', label: 'Door entry', txId: '0f2c' });

    const bare = await passport.reportIncentive({ id: 'doorman:seat', label: 'Seat' });
    expect(bare.sent).toBe(true);
    passport.destroy();
  });

  it('refuses an invalid incentive report rather than posting it', async () => {
    const { passport } = framed();
    expect(await passport.reportIncentive({ id: '', label: 'Door entry' })).toMatchObject({
      sent: false,
      error: 'invalid-request',
    });
    passport.destroy();
  });

  it('stops answering once destroyed', async () => {
    const { passport } = framed();
    const unsubscribe = passport.on('message', () => {});
    unsubscribe();
    passport.destroy();
    expect(await passport.requestProfile(['displayName'])).toMatchObject({
      approved: false,
      source: 'local',
      error: 'unsupported-transport',
    });
  });

  it('removes its listener on destroy', () => {
    const { host, passport } = framed();
    passport.on('message', () => {});
    void passport.detect();
    expect(host.listenerCount()).toBe(1);
    passport.destroy();
    expect(host.listenerCount()).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * Pop-up
 * ------------------------------------------------------------------------ */

function standalone(overrides: Partial<Parameters<typeof createPassport>[0]> = {}) {
  const host = createFakeWindow();
  const popup = createPeer();
  host.nextPopup = popup;
  const passport = createPassport({
    origin: ORIGIN,
    timeoutMs: 200,
    closedPollMs: 5,
    window: asWindow(host),
    ...overrides,
  });
  return { host, popup, passport };
}

/** Echoes back the pair the launch URL carried, as Passport does. */
function echoLaunchPair(
  host: ReturnType<typeof createFakeWindow>,
  popup: ReturnType<typeof createPeer>,
  which: 'profile' | 'tx',
) {
  const url = new URL(host.opens.at(-1)!.url);
  const names = PASSPORT_LAUNCH_PARAMS[which];
  const requestId = url.searchParams.get(names.requestId)!;
  const nonce = url.searchParams.get(names.nonce)!;
  host.deliver(createPassportProfileReady(requestId, nonce), ORIGIN, popup);
  return { requestId, nonce };
}

describe('pop-up mode', () => {
  it('is honest that presence is unknowable, and says why', async () => {
    const { passport } = standalone();
    expect(passport.mode).toBe('popup');
    const presence = await passport.detect();
    expect(presence).toMatchObject({ present: 'unknown', reason: 'popup-mode' });
    expect(presence.message).toMatch(/no injected provider/i);
    /* And `ready()` does not pretend to wait for something that cannot arrive. */
    await expect(passport.ready()).resolves.toBeUndefined();
    passport.destroy();
  });

  it('opens one named window on the profile launch contract', async () => {
    const { host, popup, passport } = standalone();
    const result = passport.requestProfile(['displayName']);
    await tick();
    const opened = host.opens.at(-1)!;
    expect(opened.name).toBe(PASSPORT_WINDOW_NAME);
    const url = new URL(opened.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.searchParams.get('passportRequestId')).toBeTruthy();
    expect(url.searchParams.get('passportTxRequestId')).toBeNull();

    const pair = echoLaunchPair(host, popup, 'profile');
    await tick();
    /* Nothing is posted into the window until it has announced itself. */
    const request = popup.posts.at(-1)!.message as PassportProfileRequest;
    expect(request.requestId).toBe(pair.requestId);
    expect(popup.posts.at(-1)!.targetOrigin).toBe(ORIGIN);

    host.deliver(
      createPassportProfileResponse(pair, {
        approved: true,
        profile: { displayName: 'Alice' },
      }),
      ORIGIN,
      popup,
    );
    expect(await result).toMatchObject({ approved: true });
    passport.destroy();
  });

  it('uses the payment launch contract for a payment, with different names', async () => {
    const { host, popup, passport } = standalone();
    const result = passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    await tick();
    const url = new URL(host.opens.at(-1)!.url);
    expect(url.searchParams.get('passportTxRequestId')).toBeTruthy();
    expect(url.searchParams.get('passportRequestId')).toBeNull();

    const pair = echoLaunchPair(host, popup, 'tx');
    await tick();
    host.deliver(
      createPassportTxResponse(pair, { status: 'submitted', txId: '0f2c' }),
      ORIGIN,
      popup,
    );
    expect(await result).toMatchObject({ status: 'submitted', txId: '0f2c' });
    passport.destroy();
  });

  it('says the window was blocked rather than pretending anything was asked', async () => {
    const { host, passport } = standalone();
    host.nextPopup = null;
    const result = await passport.requestPayment({
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    });
    expect(result).toMatchObject({ status: 'failed', source: 'local', error: 'popup-blocked' });
    expect(result.message).toMatch(/Allow pop-ups/);
    passport.destroy();
  });

  it('notices a window closed before it announced itself', async () => {
    const { host, popup, passport } = standalone();
    const pending = passport.requestProfile(['displayName']);
    await tick();
    popup.closed = true;
    const result = await pending;
    expect(result).toMatchObject({ approved: false, source: 'local', error: 'passport-closed' });
    void host;
    passport.destroy();
  });

  it('notices a window closed after it announced itself but before it answered', async () => {
    const { host, popup, passport } = standalone();
    const pending = passport.requestProfile(['displayName']);
    await tick();
    echoLaunchPair(host, popup, 'profile');
    await tick();
    popup.closed = true;
    const result = await pending;
    expect(result).toMatchObject({ approved: false, source: 'local', error: 'passport-closed' });
    passport.destroy();
  });

  it('gives up when the window never announces itself', async () => {
    const { passport } = standalone({ timeoutMs: 30 });
    const result = await passport.requestProfile(['displayName']);
    expect(result).toMatchObject({ approved: false, source: 'local', error: 'timed-out' });
    passport.destroy();
  });

  it('drops a reply from another window even on the right origin', async () => {
    const { host, popup, passport } = standalone({ timeoutMs: 60 });
    const pending = passport.requestProfile(['displayName']);
    await tick();
    const pair = echoLaunchPair(host, popup, 'profile');
    await tick();
    host.deliver(
      createPassportProfileResponse(pair, { approved: true, profile: { displayName: 'Mallory' } }),
      ORIGIN,
      createPeer(),
    );
    expect(await pending).toMatchObject({ error: 'timed-out' });
    passport.destroy();
  });

  it('has nothing to post an incentive report to, and says so', async () => {
    const { passport } = standalone();
    const outcome = await passport.reportIncentive({ id: 'x', label: 'y' });
    expect(outcome).toMatchObject({ sent: false, error: 'unsupported-transport' });
    expect(outcome.message).toMatch(/only exists inside Passport/);
    passport.destroy();
  });

  it('passes pop-up features through', async () => {
    const { host, passport } = standalone({ popupFeatures: 'popup,width=100,height=100' });
    void passport.requestProfile(['displayName']);
    await tick();
    expect(host.opens.at(-1)!.features).toBe('popup,width=100,height=100');
    passport.destroy();
  });
});

/* ---------------------------------------------------------------------------
 * The seam
 * ------------------------------------------------------------------------ */

describe('an injected transport', () => {
  function stub(overrides: Partial<PassportTransport>): PassportTransport {
    return {
      mode: 'iframe',
      listen: () => () => {},
      open: async () =>
        ({
          pair: { requestId: 'r', nonce: 'n' },
          post: () => {},
          closed: () => false,
          release: () => {},
        }) satisfies PassportChannel,
      presence: async () => ({
        present: true,
        via: 'handshake',
        message: 'stub',
      }),
      destroy: () => {},
      ...overrides,
    };
  }

  it('is used instead of building one, and decides the mode', async () => {
    const passport = createPassport({
      origin: ORIGIN,
      transport: stub({ mode: 'popup' }),
      window: asWindow(createFakeWindow()),
    });
    expect(passport.mode).toBe('popup');
    expect(await passport.detect()).toMatchObject({ present: true });
  });

  it('turns an unexpected transport failure into a timeout rather than a rejection', async () => {
    /* An exchange must always settle with a result. A transport that throws
       something this SDK did not define is still not allowed to leave a caller
       with a promise that never resolves. */
    const passport = createPassport({
      origin: ORIGIN,
      timeoutMs: 50,
      transport: stub({
        open: async () => {
          throw new Error('the host embedded us in something strange');
        },
      }),
      window: asWindow(createFakeWindow()),
    });
    expect(await passport.requestProfile(['displayName'])).toMatchObject({
      approved: false,
      source: 'local',
      error: 'timed-out',
    });
  });

  it('reports an incentive failure that is not a protocol error as an unsupported transport', async () => {
    const passport = createPassport({
      origin: ORIGIN,
      transport: stub({
        open: async (kind) => {
          if (kind === 'incentive') throw new PassportTransportError('not-present', 'no host');
          throw new Error('unused');
        },
      }),
      window: asWindow(createFakeWindow()),
    });
    expect(await passport.reportIncentive({ id: 'x', label: 'y' })).toMatchObject({
      sent: false,
      error: 'unsupported-transport',
    });
  });

  it('destroys the transport it was handed', () => {
    const destroy = vi.fn();
    const passport = createPassport({
      origin: ORIGIN,
      transport: stub({ destroy }),
      window: asWindow(createFakeWindow()),
    });
    passport.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('createPassport', () => {
  it('refuses to be built without an origin, because a default is a footgun', () => {
    expect(() => createPassport({ origin: '', window: asWindow(createFakeWindow()) })).toThrow(
      /exact origin/,
    );
    expect(() => createPassport({ origin: '///', window: asWindow(createFakeWindow()) })).toThrow(
      /exact origin/,
    );
  });

  it('falls back to the global window when none is injected', async () => {
    const host = createFakeWindow();
    host.parent = createPeer();
    const restore = installGlobalWindow(host);
    try {
      const passport = createPassport({ origin: ORIGIN, presenceTimeoutMs: 20 });
      expect(passport.mode).toBe('iframe');
      expect(await passport.detect()).toMatchObject({ present: false });
      passport.destroy();
    } finally {
      restore();
    }
  });

  it('honours an explicit transport choice over what auto would decide', () => {
    const host = createFakeWindow();
    host.parent = createPeer();
    expect(
      createPassport({ origin: ORIGIN, transport: 'popup', window: asWindow(host) }).mode,
    ).toBe('popup');
    const flat = createFakeWindow();
    expect(
      createPassport({ origin: ORIGIN, transport: 'iframe', window: asWindow(flat) }).mode,
    ).toBe('iframe');
  });
});
