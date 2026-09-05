/**
 * The rule both consent sheets decide by, and the three-minute silence it
 * exists to end.
 *
 * `window.open` from a Passport installed to an iPhone home screen opens a
 * SAFARI tab, and that tab gets `window.opener === null`. Both sheets used to
 * fold that into the same test as "no launch parameters", so a real request
 * arrived at a window that rendered the ordinary sign-in page over it and
 * posted nothing. The app on the other side polls `opened.closed`, which reads
 * `false` on a handle it cannot reach, so it did not notice either: the only
 * exit was its own three-minute timeout, spent in silence on both ends.
 *
 * What is drilled here is that the two facts are now separate, and that a
 * launch which has lost its window still lands somewhere — on the signed
 * redirect channel where the app sent one, and otherwise on a sentence.
 */

import { describe, expect, it } from 'vitest';

import { CONSENT_NO_CHANNEL_MESSAGE, consentReplyChannel } from './profileConsent.js';

describe('consentReplyChannel', () => {
  it('says nothing at all about an ordinary visit to Passport', () => {
    /* No launch parameters: this is somebody opening Passport. Neither sheet
       may render, whatever else is or is not true of the window. */
    expect(
      consentReplyChannel({ launched: false, hasOpener: true, redirectArmed: true }),
    ).toBeNull();
    expect(
      consentReplyChannel({ launched: false, hasOpener: false, redirectArmed: false }),
    ).toBeNull();
  });

  it('serves an ordinary pop-up through its opener, exactly as before', () => {
    expect(
      consentReplyChannel({ launched: true, hasOpener: true, redirectArmed: false }),
    ).toBe('opener');
  });

  it('prefers the opener even where a redirect launch also arrived', () => {
    /* An app that sends both is insuring itself, not asking for two sheets.
       The window it can still talk to is the one that answers. */
    expect(
      consentReplyChannel({ launched: true, hasOpener: true, redirectArmed: true }),
    ).toBe('opener');
  });

  it('falls back to the signed redirect channel when the window handle is gone', () => {
    /* The installed-iOS case with an app that sent a callback URL as well: the
       reply travels by redirect, which survives a navigation and needs no
       window handle, and this sheet stands down so only one asks. */
    expect(
      consentReplyChannel({ launched: true, hasOpener: false, redirectArmed: true }),
    ).toBe('redirect');
  });

  it('reports a launch with no way home rather than showing a sign-in page', () => {
    expect(
      consentReplyChannel({ launched: true, hasOpener: false, redirectArmed: false }),
    ).toBe('none');
  });

  it('says what the reader can do, and names nothing they cannot', () => {
    expect(CONSENT_NO_CHANNEL_MESSAGE).toBe(
      'Passport has no way to send an answer back to the app that opened this. Return to the app and try again, or open its link in Safari.',
    );
    for (const word of ['opener', 'postMessage', 'window handle', 'transport', 'channel']) {
      expect(CONSENT_NO_CHANNEL_MESSAGE).not.toContain(word);
    }
  });
});
