/**
 * The two transports on their own, for the paths the client cannot reach
 * through its own public surface: an exchange that is abandoned mid-flight,
 * and the pop-up's refusal to carry a message that only exists inside a frame.
 *
 * They are exported, so this is a drill of the public surface, not of
 * internals — a host that embeds Passport some other way builds one of these
 * directly.
 */

import { describe, expect, it } from 'vitest';

import { createIframeTransport } from '../src/core/transport/iframe.js';
import { createPopupTransport } from '../src/core/transport/popup.js';
import { PassportTransportError } from '../src/core/transport/types.js';
import { createPassportProfileReady } from '../src/protocol/profile.js';
import {
  asWindow,
  createFakeWindow,
  createPeer,
  installGlobalWindow,
  tick,
} from './fakeWindow.js';

const ORIGIN = 'https://midnightpassport.example';

describe('the framed transport, directly', () => {
  it('abandons a handshake wait when the exchange is called off', async () => {
    const host = createFakeWindow();
    host.parent = createPeer();
    const transport = createIframeTransport({
      origin: ORIGIN,
      presenceTimeoutMs: 5_000,
      window: asWindow(host),
    });
    const controller = new AbortController();
    const pending = transport.open('profile', controller.signal);
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timed-out' });
    transport.destroy();
  });

  it('hands inbound messages that are not a ready to its listeners', async () => {
    const host = createFakeWindow();
    const parent = createPeer();
    host.parent = parent;
    const transport = createIframeTransport({
      origin: ORIGIN,
      presenceTimeoutMs: 50,
      window: asWindow(host),
    });
    const seen: unknown[] = [];
    const stop = transport.listen((data) => seen.push(data));
    host.deliver({ type: 'something.else' }, ORIGIN, parent);
    expect(seen).toEqual([{ type: 'something.else' }]);
    stop();
    host.deliver({ type: 'again' }, ORIGIN, parent);
    expect(seen).toHaveLength(1);
    transport.destroy();
    /* Destroying twice is not an error — a client may do it on unmount after
       an exchange has already torn itself down. */
    transport.destroy();
  });

  it('reuses a handshake it already has rather than asking again', async () => {
    const host = createFakeWindow();
    const parent = createPeer();
    host.parent = parent;
    const transport = createIframeTransport({
      origin: ORIGIN,
      presenceTimeoutMs: 50,
      window: asWindow(host),
    });
    const controller = new AbortController();
    const first = transport.open('profile', controller.signal);
    await tick();
    host.deliver(createPassportProfileReady('r', 'n'), ORIGIN, parent);
    expect((await first).pair).toEqual({ requestId: 'r', nonce: 'n' });
    const posts = parent.posts.length;
    const second = await transport.open('profile', controller.signal);
    expect(second.pair).toEqual({ requestId: 'r', nonce: 'n' });
    /* No second cold hello: the pair is already known. */
    expect(parent.posts).toHaveLength(posts);
    expect(second.closed()).toBe(false);
    second.release();
    transport.destroy();
  });
});

describe('the window every transport falls back to', () => {
  it('is the global one when none is injected', async () => {
    const host = createFakeWindow();
    const parent = createPeer();
    host.parent = parent;
    const restore = installGlobalWindow(host);
    try {
      const framed = createIframeTransport({ origin: ORIGIN, presenceTimeoutMs: 20 });
      expect(await framed.presence(new AbortController().signal)).toMatchObject({
        present: false,
      });
      framed.destroy();

      host.nextPopup = null;
      const standalone = createPopupTransport({
        origin: ORIGIN,
        readyTimeoutMs: 20,
        closedPollMs: 5,
      });
      await expect(
        standalone.open('profile', new AbortController().signal),
      ).rejects.toMatchObject({ code: 'popup-blocked' });
      standalone.destroy();
    } finally {
      restore();
    }
  });
});

describe('a message with no type at all', () => {
  it('is still logged, under a name that says so', async () => {
    const host = createFakeWindow();
    const parent = createPeer();
    host.parent = parent;
    const traffic: string[] = [];
    const transport = createIframeTransport({
      origin: ORIGIN,
      presenceTimeoutMs: 50,
      window: asWindow(host),
      onTraffic: (_direction, type) => traffic.push(type),
    });
    const controller = new AbortController();
    const channel = await transport.open('tx', controller.signal);
    channel.post({ nothing: true });
    expect(traffic).toContain('unknown');
    transport.destroy();

    const standaloneHost = createFakeWindow();
    const popup = createPeer();
    standaloneHost.nextPopup = popup;
    const popupTraffic: string[] = [];
    const standalone = createPopupTransport({
      origin: ORIGIN,
      readyTimeoutMs: 5_000,
      closedPollMs: 5,
      window: asWindow(standaloneHost),
      onTraffic: (_direction, type) => popupTraffic.push(type),
    });
    const pending = standalone.open('tx', new AbortController().signal);
    await tick();
    const url = new URL(standaloneHost.opens.at(-1)!.url);
    standaloneHost.deliver(
      createPassportProfileReady(
        url.searchParams.get('passportTxRequestId')!,
        url.searchParams.get('passportTxNonce')!,
      ),
      ORIGIN,
      popup,
    );
    (await pending).post({ nothing: true });
    expect(popupTraffic).toContain('unknown');
    standalone.destroy();
  });
});

describe('the pop-up transport, directly', () => {
  it('refuses an incentive report, because there is nothing to post it to', async () => {
    const host = createFakeWindow();
    const transport = createPopupTransport({
      origin: ORIGIN,
      readyTimeoutMs: 50,
      closedPollMs: 5,
      window: asWindow(host),
    });
    await expect(transport.open('incentive', new AbortController().signal)).rejects.toBeInstanceOf(
      PassportTransportError,
    );
    transport.destroy();
  });

  it('abandons a window that has not announced itself when the exchange is called off', async () => {
    const host = createFakeWindow();
    host.nextPopup = createPeer();
    const transport = createPopupTransport({
      origin: ORIGIN,
      readyTimeoutMs: 5_000,
      closedPollMs: 5,
      window: asWindow(host),
    });
    const controller = new AbortController();
    const pending = transport.open('profile', controller.signal);
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timed-out' });
    transport.destroy();
  });

  it('hands inbound messages that are not a ready to its listeners', async () => {
    const host = createFakeWindow();
    const popup = createPeer();
    host.nextPopup = popup;
    const transport = createPopupTransport({
      origin: ORIGIN,
      readyTimeoutMs: 5_000,
      closedPollMs: 5,
      window: asWindow(host),
    });
    const seen: unknown[] = [];
    const stop = transport.listen((data) => seen.push(data));
    const controller = new AbortController();
    const pending = transport.open('profile', controller.signal);
    await tick();
    /* A ready for a pair nobody is waiting on is still a ready: it is reported
       and then dropped, rather than waking the wrong exchange. */
    host.deliver(createPassportProfileReady('somebody', 'else'), ORIGIN, popup);
    host.deliver({ type: 'something.else' }, ORIGIN, popup);
    expect(seen).toEqual([{ type: 'something.else' }]);
    stop();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(PassportTransportError);
    transport.destroy();
    transport.destroy();
  });
});
