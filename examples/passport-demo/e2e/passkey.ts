/**
 * The virtual authenticator, and why the specs are Chromium-only.
 *
 * A Passport with no passkey has no wallet, no account-custody contract, and
 * nothing to test — the passkey IS the identity, and its WebAuthn PRF output is
 * where the wallet seed and the private-state key come from. So there is no
 * "skip the ceremony" path to test around, and a browser that cannot be given a
 * passkey unattended cannot run these specs at all.
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

export interface VirtualAuthenticator {
  /** Removes the authenticator — the browser equivalent of losing the device. */
  remove(): Promise<void>;
}

/** Installs a PRF-capable platform authenticator on `page`'s browser context. */
export async function installVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<VirtualAuthenticator> {
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
