/**
 * What the install sheet is allowed to promise.
 *
 * The sheet used to tell everybody the installed app "keeps you signed in". On
 * iOS that is false: an installed web app gets a storage container of its own,
 * so the passkey follows through iCloud Keychain but the profile and the
 * encrypted state stay behind in Safari, and the first thing the new app does
 * is ask for the passkey. A reader who believed the sentence and then met a
 * sign-in screen has been told the app is broken by the app itself, one tap
 * after trusting it.
 */

import { describe, expect, it } from 'vitest';

import { INSTALL_LEDE, INSTALL_LEDE_IOS } from './pwa.js';

describe('the install sheet', () => {
  it('promises a carried-over session only where the app inherits one', () => {
    /* Chrome and Edge install into the browser's own storage, so this is true
       there and stays. */
    expect(INSTALL_LEDE).toBe(
      'It opens full-screen, keeps you signed in, and is one tap away next time.',
    );
  });

  it('tells an iPhone reader what will actually happen', () => {
    expect(INSTALL_LEDE_IOS).toBe(
      'It opens full-screen and is one tap away next time. You will sign in once more with your passkey.',
    );
    // The claim that was false on this platform, gone rather than softened.
    expect(INSTALL_LEDE_IOS).not.toMatch(/keeps you signed in/i);
    // And the thing that IS true, said plainly, so the sign-in screen the
    // reader is about to meet is the one they were told about.
    expect(INSTALL_LEDE_IOS).toMatch(/sign in once more with your passkey/);
  });

  it('names nothing a reader cannot act on', () => {
    for (const copy of [INSTALL_LEDE, INSTALL_LEDE_IOS]) {
      for (const word of ['IndexedDB', 'storage container', 'WebAuthn', 'PWA', 'origin']) {
        expect(copy).not.toContain(word);
      }
    }
  });
});
