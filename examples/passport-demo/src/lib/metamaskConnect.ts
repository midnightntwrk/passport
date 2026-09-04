/**
 * The EIP-1193 conversation, and nothing else.
 *
 * This is the half of the MetaMask device that talks to a browser extension:
 * finding the provider, asking which account, and asking it to sign. The RULES
 * — the message text, the derivation, the pairing record — are in
 * `./metamaskDevice.ts`, which holds no browser at all and is drilled to 100%.
 * The split is the same one `./sponsor.ts` and `./endpoints.ts` make: the part
 * that can be proven in a test file is separated from the part that can only be
 * proven in a browser.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No chain id, no `wallet_switchEthereumChain`, no ERC-20, no balance. This
 * scheme never sends an Ethereum transaction and never reads Ethereum state:
 * MetaMask is used as a SIGNING DEVICE and nothing more, so which EVM network
 * it happens to be pointed at is irrelevant and asking about it would only
 * suggest otherwise. `personal_sign` is chain-agnostic.
 *
 * A refusal is a refusal, not an error. MetaMask reports a user who declined
 * with EIP-1193 code `4001`, and this module turns that into its own
 * `declined` code so callers can say "nothing was signed" rather than showing
 * an extension's error text to somebody who simply pressed cancel.
 */

import { MetamaskDeviceError, normaliseEthereumAddress } from './metamaskDevice.js';

/** The slice of EIP-1193 this app uses. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
}

export type MetamaskConnectErrorCode =
  /** No injected provider on this page. */
  | 'no-provider'
  /** The person pressed cancel in MetaMask. Nothing was signed. */
  | 'declined'
  /** The provider answered, but not with anything usable. */
  | 'no-account'
  /** The provider failed for a reason of its own. */
  | 'provider-failed';

export class MetamaskConnectError extends Error {
  readonly code: MetamaskConnectErrorCode;

  constructor(code: MetamaskConnectErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MetamaskConnectError';
    this.code = code;
  }
}

interface EthereumWindow {
  ethereum?: Eip1193Provider;
}

/**
 * The injected provider, or `null`.
 *
 * Never throws, because "is MetaMask here?" is a question a render asks — the
 * pairing control is not shown at all where the answer is no, and a control
 * that appears and then explains it cannot work is worse than one that never
 * appeared.
 */
export function injectedProvider(): Eip1193Provider | null {
  const injected = (globalThis as unknown as EthereumWindow).ethereum;
  return injected && typeof injected.request === 'function' ? injected : null;
}

function requireProvider(): Eip1193Provider {
  const provider = injectedProvider();
  if (!provider) {
    throw new MetamaskConnectError(
      'no-provider',
      'Passport cannot find MetaMask in this browser.',
    );
  }
  return provider;
}

/** EIP-1193 says a user rejection is code 4001, and every wallet honours it. */
function isDeclined(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 4001
  );
}

function asConnectError(cause: unknown, fallback: string): MetamaskConnectError {
  if (isDeclined(cause)) {
    return new MetamaskConnectError(
      'declined',
      'You cancelled in MetaMask, so nothing was signed or sent.',
      { cause },
    );
  }
  return new MetamaskConnectError('provider-failed', fallback, { cause });
}

/**
 * The account MetaMask is offering, prompting for a connection where it has
 * not been given one.
 *
 * Only the FIRST account is taken. MetaMask can expose several, but a device is
 * one key, and silently pairing whichever account happened to be listed first
 * on a later call is how a person ends up with a device they cannot re-derive.
 * The address is shown back to them on the paired-device row for exactly this
 * reason.
 */
export async function requestMetamaskAccount(): Promise<string> {
  const provider = requireProvider();
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (cause) {
    throw asConnectError(cause, 'MetaMask would not say which account to use.');
  }
  /* `Array.isArray` narrows to `any[]`, which is exactly the shape this
     module refuses to trust: the value is read back as `unknown` and checked. */
  const first: unknown = Array.isArray(accounts) ? (accounts as unknown[])[0] : undefined;
  if (typeof first !== 'string') {
    throw new MetamaskConnectError(
      'no-account',
      'MetaMask is connected but offered no account to pair.',
    );
  }
  try {
    return normaliseEthereumAddress(first);
  } catch (cause) {
    if (cause instanceof MetamaskDeviceError) {
      throw new MetamaskConnectError('no-account', cause.message, { cause });
    }
    /* c8 ignore next */
    throw cause;
  }
}

/**
 * Asks MetaMask to sign `message` with `address`, EIP-191 style.
 *
 * The message travels as HEX rather than as a bare string. Both are accepted by
 * MetaMask, but a bare string that happens to look like hex is interpreted as
 * bytes by some wallets, and a message whose interpretation depends on its
 * content is a message that can silently derive two different devices.
 *
 * THIS PROMPT IS THE APPROVAL. Every call here raises MetaMask's own
 * confirmation sheet, and a decline throws before anything is derived, built,
 * or submitted — which is what keeps the one-prompt-per-user-action rule the
 * passkey path keeps. It is also the reason the app re-signs for each spend
 * rather than holding the signature: the signature IS the device, and a device
 * that spends without asking is the thing this project does not ship.
 */
export async function signMetamaskMessage(address: string, message: string): Promise<string> {
  const provider = requireProvider();
  const account = normaliseEthereumAddress(address);
  const hex = `0x${Array.from(new TextEncoder().encode(message), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
  let signature: unknown;
  try {
    signature = await provider.request({ method: 'personal_sign', params: [hex, account] });
  } catch (cause) {
    throw asConnectError(cause, 'MetaMask would not sign, so nothing was derived.');
  }
  if (typeof signature !== 'string') {
    throw new MetamaskConnectError(
      'provider-failed',
      'MetaMask answered without a signature.',
    );
  }
  return signature;
}
