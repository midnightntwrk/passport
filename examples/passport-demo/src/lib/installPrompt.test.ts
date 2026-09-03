/**
 * Whether to offer to install Passport, and which offer to make.
 *
 * The defect these drills stand against is the one reported on 2026/09/02: a
 * reviewer in an ordinary browser tab with no way to install the app. The two
 * ways of getting the fix wrong are equal and opposite — offering nothing to
 * somebody who could install, and offering a button to somebody it cannot work
 * for — so both are held to here, on real user-agent strings.
 */

import { describe, expect, it } from 'vitest';

import {
  alreadyInstalled,
  INSTALL_HINT_STEPS,
  INSTALL_LABEL,
  installAffordance,
  isIosDevice,
  isSafariBrowser,
  type InstallEnvironment,
} from './installPrompt.js';

/* Real strings, taken as they are sent. A synthesised user agent proves
   nothing about the ones this app actually meets. */
const AGENTS = {
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  firefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
};

const environment = (over: Partial<InstallEnvironment>): InstallEnvironment => ({
  standaloneDisplay: false,
  promptHeld: false,
  userAgent: AGENTS.desktopChrome,
  maxTouchPoints: 0,
  ...over,
});

describe('isIosDevice', () => {
  it('knows an iPhone', () => {
    expect(isIosDevice(AGENTS.iphoneSafari, 5)).toBe(true);
    expect(isIosDevice(AGENTS.iphoneChrome, 5)).toBe(true);
  });

  it('knows an iPad pretending to be a Mac, by its touchscreen', () => {
    /* Apple made the two user agents identical on purpose. The touch points
       are the only thing left to tell them apart. */
    expect(isIosDevice(AGENTS.ipadSafari, 5)).toBe(true);
    expect(isIosDevice(AGENTS.desktopSafari, 0)).toBe(false);
  });

  it('is not confused by Android or a desktop', () => {
    expect(isIosDevice(AGENTS.androidChrome, 5)).toBe(false);
    expect(isIosDevice(AGENTS.desktopChrome, 0)).toBe(false);
  });
});

describe('isSafariBrowser', () => {
  it('accepts Safari on either platform', () => {
    expect(isSafariBrowser(AGENTS.desktopSafari)).toBe(true);
    expect(isSafariBrowser(AGENTS.iphoneSafari)).toBe(true);
  });

  it('rejects every browser wearing WebKit', () => {
    /* Chrome on iOS is WebKit too, but its toolbar is its own: "tap Share in
       Safari's toolbar" would be directions to a button that is not there. */
    expect(isSafariBrowser(AGENTS.iphoneChrome)).toBe(false);
    expect(isSafariBrowser(AGENTS.desktopChrome)).toBe(false);
    expect(isSafariBrowser(AGENTS.androidChrome)).toBe(false);
    expect(isSafariBrowser(AGENTS.firefox)).toBe(false);
  });
});

describe('alreadyInstalled', () => {
  it('accepts either browser’s way of saying so', () => {
    expect(alreadyInstalled(environment({ standaloneDisplay: true }))).toBe(true);
    expect(alreadyInstalled(environment({ iosStandalone: true }))).toBe(true);
  });

  it('is false in a tab, and where the browser has no opinion', () => {
    expect(alreadyInstalled(environment({}))).toBe(false);
    expect(alreadyInstalled(environment({ iosStandalone: false }))).toBe(false);
    expect(alreadyInstalled(environment({ iosStandalone: undefined }))).toBe(false);
  });
});

describe('installAffordance', () => {
  it('offers the browser’s own dialogue once it has offered us one', () => {
    expect(installAffordance(environment({ promptHeld: true }))).toBe('prompt');
    expect(
      installAffordance(environment({ promptHeld: true, userAgent: AGENTS.androidChrome })),
    ).toBe('prompt');
  });

  it('gives iOS Safari the two taps it has to make itself', () => {
    /* iOS fires no install event and never will, so a button would be a
       control that cannot work. */
    expect(
      installAffordance(environment({ userAgent: AGENTS.iphoneSafari, maxTouchPoints: 5 })),
    ).toBe('hint');
    expect(
      installAffordance(environment({ userAgent: AGENTS.ipadSafari, maxTouchPoints: 5 })),
    ).toBe('hint');
  });

  it('shows nothing inside the installed app', () => {
    /* Both ways of being installed, and on iOS especially — where the only
       answer on older versions is `navigator.standalone`. An install button
       inside the installed app is a screen not reading its own state. */
    expect(installAffordance(environment({ standaloneDisplay: true, promptHeld: true }))).toBe(
      'hidden',
    );
    expect(
      installAffordance(
        environment({
          iosStandalone: true,
          userAgent: AGENTS.iphoneSafari,
          maxTouchPoints: 5,
        }),
      ),
    ).toBe('hidden');
  });

  it('shows nothing where installing is not on offer at all', () => {
    /* Firefox on a desktop, and Chrome on iOS: neither can install this, and
       a dead control is worse than none. */
    expect(installAffordance(environment({ userAgent: AGENTS.firefox }))).toBe('hidden');
    expect(
      installAffordance(environment({ userAgent: AGENTS.iphoneChrome, maxTouchPoints: 5 })),
    ).toBe('hidden');
    /* Chromium that has not offered a prompt: it may yet, and until it does
       there is nothing to press. */
    expect(installAffordance(environment({ userAgent: AGENTS.desktopChrome }))).toBe('hidden');
  });
});

describe('the copy', () => {
  it('says what it does, and names no machinery', () => {
    expect(INSTALL_LABEL).toBe('Install Passport');
    expect(INSTALL_HINT_STEPS).toHaveLength(2);
    const copy = [INSTALL_LABEL, ...INSTALL_HINT_STEPS].join(' ').toLowerCase();
    for (const word of ['wallet', 'dust', 'contract', 'registry', 'indexer', 'resolver']) {
      expect(copy).not.toContain(word);
    }
  });
});
