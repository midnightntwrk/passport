/**
 * A real MetaMask, minus the extension.
 *
 * WHY A STUB AND NOT THE EXTENSION
 * --------------------------------
 * The thing under test is a DERIVATION, not a browser extension. What Passport
 * needs from MetaMask is one EIP-191 `personal_sign` over a fixed message, and
 * what makes the scheme work is that the signature is deterministic (RFC 6979).
 * Driving the real extension's confirmation popup through CDP would prove that
 * Playwright can click a MetaMask button; it would prove nothing about the
 * derivation that this does not.
 *
 * So the signatures here are REAL. A fixed secp256k1 private key, keccak-256
 * over `\x19Ethereum Signed Message:\n<len>` ‖ message, RFC 6979 deterministic
 * ECDSA from `@noble/curves`, and the `r ‖ s ‖ v` encoding MetaMask returns.
 * The bytes that reach `personalSignatureBytes` are byte-for-byte what a real
 * MetaMask holding this key would return — which is checkable, because the
 * vector in `src/lib/metamaskDevice.test.ts` was produced by this same code and
 * is asserted there as a literal.
 *
 * WHAT IS FAKED IS THE CONSENT, AND ONLY THE CONSENT. There is no confirmation
 * sheet in a headless browser, so this signs on request. Every other property
 * the app depends on — determinism, the 65-byte shape, the recovery byte, the
 * address the key belongs to — is the genuine article.
 *
 * `@noble/curves` resolves to the workspace's hoisted 2.3.0. It is a test-only
 * import: nothing in `src/` depends on it, so it never reaches a bundle.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Page } from '@playwright/test';

/**
 * The test key. `0x00…2a`, chosen for being obviously a test key and nothing
 * else. It holds no value on any chain and is checked in deliberately: a walk
 * that generated a fresh key each run could not assert that a device paired in
 * one test is the device that signs in the next.
 */
const PRIVATE_KEY = (() => {
  const key = new Uint8Array(32);
  key[31] = 0x2a;
  return key;
})();

/** The Ethereum account address that key belongs to, lower-cased. */
export const METAMASK_TEST_ADDRESS = `0x${Buffer.from(
  keccak_256(secp256k1.getPublicKey(PRIVATE_KEY, false).slice(1)),
)
  .toString('hex')
  .slice(-40)}`;

/** `0xae3d…3bce` — what the Devices card puts in front of a reader. */
export const METAMASK_TEST_SHORT = `${METAMASK_TEST_ADDRESS.slice(
  0,
  6,
)}…${METAMASK_TEST_ADDRESS.slice(-4)}`;

/**
 * EIP-191 `personal_sign` over `message`, returned the way MetaMask returns it.
 *
 * `@noble/curves` 2.x hands back a recovered signature as `[recovery, r, s]`;
 * Ethereum wants `r ‖ s ‖ v` with `v = 27 + recovery`. Getting that order wrong
 * would still produce 65 plausible bytes and a stable derivation, which is
 * exactly why it is written out here rather than assumed.
 */
export function personalSign(message: string): string {
  const payload = new TextEncoder().encode(message);
  /* The 0x19 byte is part of EIP-191, and is the difference between a valid
     `personal_sign` signature and 65 bytes that merely look like one. */
  const prefix = new TextEncoder().encode(
    `\u0019Ethereum Signed Message:\n${payload.length}`,
  );
  const digest = keccak_256(new Uint8Array([...prefix, ...payload]));
  const recovered = secp256k1.sign(digest, PRIVATE_KEY, { prehash: false, format: 'recovered' });
  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0);
  signature[64] = 27 + recovered[0];
  return `0x${Buffer.from(signature).toString('hex')}`;
}

/**
 * Installs `window.ethereum` before any application script runs.
 *
 * `addInitScript` rather than an `evaluate`, so the provider survives every
 * reload and navigation in the walk — the app asks for it on the sign-in screen
 * and again on Home, either side of a sign-out.
 *
 * The signing itself is done in NODE, over an exposed binding, so no key
 * material and no curve implementation is ever shipped into the page. What the
 * page holds is a postbox.
 */
export async function installMetamaskStub(page: Page): Promise<void> {
  await page.exposeFunction('__passportMetamaskSign', (hexMessage: string) => {
    const hex = hexMessage.startsWith('0x') ? hexMessage.slice(2) : hexMessage;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return personalSign(new TextDecoder().decode(bytes));
  });

  await page.addInitScript((address: string) => {
    /* Looked up at CALL time, not at install time: Playwright installs the
       exposed binding with an init script of its own, and nothing here should
       depend on which of the two ran first. */
    const sign = (hexMessage: string): Promise<string> =>
      (
        globalThis as unknown as {
          __passportMetamaskSign(value: string): Promise<string>;
        }
      ).__passportMetamaskSign(hexMessage);
    Object.defineProperty(globalThis, 'ethereum', {
      configurable: true,
      value: {
        isMetaMask: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              /* Answered because a provider that throws on it looks broken to
                 anything sniffing the page. Passport never asks: the scheme
                 sends no Ethereum transaction and reads no Ethereum state. */
              return '0x1';
            case 'personal_sign':
              return sign(params?.[0] as string);
            default:
              throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
          }
        },
        on() {
          /* No account or chain changes happen in a walk. */
        },
        removeListener() {
          /* Symmetry with `on`, for anything that tidies up after itself. */
        },
      },
    });
  }, METAMASK_TEST_ADDRESS);
}
