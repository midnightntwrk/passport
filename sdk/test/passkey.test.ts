import { afterEach, describe, expect, it } from 'vitest';

import { WebAuthnPrfKeyProvider } from '../src/index.js';

const scope = { appId: 'org.midnight.passport.demo', accountId: 'passport-account' };
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function replaceNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('WebAuthnPrfKeyProvider', () => {
  it('rejects a missing WebAuthn credential API', async () => {
    replaceNavigator({});
    await expect(
      WebAuthnPrfKeyProvider.enroll({ label: 'Midnight Passport', userId: 'dynamic-user-1' }),
    ).rejects.toThrow('WebAuthn is unavailable');
  });

  it('reports cancelled passkey enrollment and unlock operations', async () => {
    replaceNavigator({
      credentials: {
        create: async () => null,
        get: async () => null,
      },
    });

    await expect(
      WebAuthnPrfKeyProvider.enroll({ label: 'Midnight Passport', userId: 'dynamic-user-1' }),
    ).rejects.toThrow('Passport passkey creation was cancelled');

    const provider = new WebAuthnPrfKeyProvider({
      credentialId: 'AQID',
      label: 'Midnight Passport',
    });
    await expect(provider.getKey(scope)).rejects.toThrow('Passport passkey unlock was cancelled');
  });
});
