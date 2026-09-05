/**
 * The virtual authenticator — Chromium's, and what stands in for it elsewhere.
 *
 * A Passport with no passkey has no wallet, no account-custody contract, and
 * nothing to test — the passkey IS the identity, and its WebAuthn PRF output is
 * where the wallet seed and the private-state key come from. So there is no
 * "skip the ceremony" path to test around, and a browser that cannot be given a
 * passkey unattended cannot run these specs at all. Which, until 2026/09/05,
 * meant Chromium and nothing else — see `webauthnStub.ts` for what the other
 * engines are given instead, and `installVirtualAuthenticator` below for how
 * a spec gets one without having to know which it received.
 *
 * Chrome DevTools Protocol's `WebAuthn` domain is what makes it unattended: it
 * installs an authenticator inside the browser that answers `navigator.
 * credentials.create()` and `.get()` without a human touching a sensor. The
 * options below are not defaults — each one is required by something this app
 * does:
 *
 *   `protocol: 'ctap2'`, `ctap2Version: 'ctap2_1'`
 *                              PRF is a CTAP 2.1 extension. A ctap2_0
 *                              authenticator enrols happily and then has no
 *                              PRF, so the wallet seed cannot be derived.
 *   `transport: 'internal'`    A platform authenticator, which is what
 *                              `authenticatorAttachment: 'platform'` asks for.
 *   `hasResidentKey`           Passport enrols a DISCOVERABLE credential so a
 *                              browser with cleared site data can still sign in
 *                              rather than enrolling a second passkey over the
 *                              first — see `screens/Onboarding.tsx`.
 *   `hasUserVerification`,     Every assertion Passport makes is
 *   `isUserVerified`           user-verified; without both, `.get()` fails.
 *   `hasPrf`                   The seed. Without it onboarding stops.
 *   `hasLargeBlob`             Requested alongside PRF by the enrolment path.
 *   `automaticPresenceSimulation`
 *                              Answers the presence check with no human.
 */

import type { BrowserContext, Page } from '@playwright/test';

import { installWebAuthnStub, type WebAuthnStubOptions } from './webauthnStub.js';

export interface VirtualAuthenticator {
  /** Removes the authenticator — the browser equivalent of losing the device. */
  remove(): Promise<void>;
}

/**
 * The engine this context is running on. `browserName` from the test fixtures
 * says the same thing, but a helper that reads it off the context does not
 * oblige every one of the nine spec files to thread a fixture through to get
 * a passkey.
 */
function engine(context: BrowserContext): string {
  return context.browser()?.browserType().name() ?? 'chromium';
}

/**
 * Installs a PRF-capable platform authenticator on `page`'s browser context —
 * through CDP on Chromium, and through the JavaScript stand-in in
 * `webauthnStub.ts` everywhere else.
 *
 * THE STAND-IN IS NOT A LESSER TEST OF THE APP; it is a lesser test of the
 * BROWSER. Chromium keeps the real authenticator, so the ceremony itself stays
 * covered by a real implementation. What WebKit and Firefox are being asked
 * here is everything downstream of the ceremony — the derivation, the wallet,
 * the layout, the storage, the worker — and none of that changes for having
 * been handed its PRF bytes by a stand-in rather than by CDP.
 *
 * Specs that drive the AUTHENTICATOR itself rather than the app — planting a
 * resident credential with `WebAuthn.addCredential`, reading a largeBlob back
 * off it, removing a credential mid-run — cannot be served by this and say so
 * with `test.skip(browserName !== 'chromium', …)` of their own.
 */
export async function installVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
  options: WebAuthnStubOptions = {},
): Promise<VirtualAuthenticator> {
  if (engine(context) !== 'chromium') return installWebAuthnStub(context, options);
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      hasLargeBlob: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    async remove() {
      await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    },
  };
}

/** A label no other run will have claimed. Used for the live tier's name. */
export function uniqueAlias(prefix = 'e2e'): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 6);
  return `${prefix}${stamp}${noise}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}
