/**
 * MetaMask as a Passport device — the rules, with nothing that touches a
 * browser, a network, or a wallet.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A Passport's account is a deployed `account.compact` instance. The contract
 * decides who may spend from it by holding a set of DEVICE COMMITMENTS, and it
 * admits a new one through `add_device(new_device: Field)` — a call the
 * account's existing device authorises. So "connect MetaMask to Passport" needs
 * no contract change at all: MetaMask becomes a SECOND DEVICE on the account
 * that is already there, exactly the way a second passkey would.
 *
 * What a device is, in the contract's terms, is a 32-byte secret nobody else
 * has. A passkey produces one from a WebAuthn PRF output. MetaMask has no PRF,
 * but it has something that behaves like one for this purpose: ECDSA over
 * secp256k1 as `personal_sign` performs it is DETERMINISTIC — RFC 6979 fixes
 * the nonce as a function of the key and the message, so the same account
 * signing the same message returns the same 65 bytes every time, on every
 * machine, forever. Sign a FIXED message, and those bytes are a stable secret
 * that only the holder of that MetaMask account can produce.
 *
 * THE PHISHING CAVEAT, SAID PLAINLY AND SAID FIRST
 * -----------------------------------------------
 * That property cuts both ways, and it is the single thing a reader of this
 * module must understand: **whoever can get MetaMask to sign this message
 * holds the device.** There is no origin binding inside an EIP-191 signature —
 * `personal_sign` signs the text and nothing about who asked. Any page that
 * persuades the same MetaMask account to sign the same string derives the same
 * device secret and can spend from the account. A hardware wallet behind
 * MetaMask does not help: it signs the same text just as deterministically.
 *
 * This is why the message is long, specific, and readable in the MetaMask
 * confirmation sheet rather than an opaque hash — a person asked to sign it on
 * a site they did not expect has a chance of noticing. It is not a defence, it
 * is a warning label. This is an EXPERIMENT, and this caveat is why it is one:
 * a shipping version would bind the derivation to something an attacker's page
 * cannot reproduce (a passkey assertion alongside it, or a SIWE-style message
 * carrying the verified origin and a server nonce).
 *
 * WHAT THE SIGNATURE BECOMES
 * --------------------------
 * The signature is NOT the device secret. It is the input-keying material of
 * the same HKDF ladder the passkey's PRF output goes through in
 * `demo-backend/src/passkey.ts`, and it yields the same thing that PRF output
 * yields: a 32-byte ROOT SECRET, per scope. From that one root the app derives
 * BOTH halves a device needs:
 *
 *   - under `PASSPORT_CONTRACT_SCOPE`, the root that
 *     `derivePassportContractSecrets` splits into the device secret whose
 *     `derive_device_commitment` the contract stores;
 *   - under the local wallet scope, the seed `createLocalMidnightWallet` turns
 *     into a Midnight HD wallet — Zswap viewing and spending keys, a Dust key,
 *     an unshielded address.
 *
 * The wallet half is not optional and not decoration. A send to a NAME is two
 * legs, and between them the value lands on the SIGNING DEVICE's own wallet
 * address; a shielded leg's note can only be seen by the viewing key of the
 * wallet it was addressed to. A MetaMask device with a device secret but no
 * wallet of its own could authorise a withdrawal it could then not see. So the
 * MetaMask device gets its own wallet, holding — like the passkey's — only
 * in-flight change between the legs of a payment.
 *
 * DOMAIN SEPARATION
 * -----------------
 * {@link METAMASK_SEED_SALT} and the `metamask` segment in every info string
 * below are what keep the two devices from ever colliding. The passkey's ladder
 * uses `midnight-passport:wallet-seed:v1` as its salt; this one does not, and
 * must not. Two devices on one account whose secrets coincided would be one
 * device wearing two labels, and removing either would remove both.
 *
 * WHY NONE OF THIS IS IN `App.tsx`
 * --------------------------------
 * Every function here is a rule: bytes in, bytes out, or a string in, a
 * decision out. There is no `window.ethereum`, no `localStorage`, no `fetch`,
 * and no React — the EIP-1193 conversation and the storage live in
 * `./metamaskConnect.ts` and `App.tsx` respectively. That is what lets this
 * module be drilled to 100% in `./metamaskDevice.test.ts` against a FIXED
 * signature vector, which is the only honest way to state that a derivation is
 * deterministic.
 */

import type { PassportStateScope, PassportWalletSeedProvider } from '../backend.js';

/* -------------------------------------------------------------------------- */
/* The message                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The first line of the signed message, and the version of this whole scheme.
 *
 * Changing ANY byte of the message this module builds changes every device
 * secret it derives, which un-pairs every MetaMask device already on an
 * account. So the version is in the text itself: a v2 is a different first
 * line, deriving different secrets, and an account can hold both at once
 * because the contract only ever sees commitments.
 */
export const METAMASK_DEVICE_MESSAGE_VERSION = 'Midnight Passport device key v1';

/** HKDF salt for the MetaMask ladder. Never the passkey's — see the header. */
const METAMASK_SEED_SALT = 'midnight-passport:metamask-device:v1';

/** The info prefix. The `metamask` label is the other half of the separation. */
const METAMASK_SEED_INFO_PREFIX = 'midnight-passport:metamask:wallet-seed:v1';

/** A `personal_sign` result over secp256k1: r ‖ s ‖ v. */
const SIGNATURE_BYTES = 65;

/** What HKDF must produce, because that is what the wallet SDK takes. */
const SEED_BYTES = 32;

export interface MetamaskDeviceMessageInput {
  /** The Midnight network id this account lives on, e.g. `stagenet`. */
  network: string;
  /**
   * The ACCOUNT the device is being paired to — the deployed account contract's
   * address. It is in the message so that one MetaMask account paired to two
   * Passports derives two unrelated devices: without it, a person's second
   * Passport would silently inherit the first one's device secret.
   */
  accountAddress: string;
}

/**
 * The exact text MetaMask is asked to sign, and the only text this module will
 * derive from.
 *
 * Three lines, each one readable in the confirmation sheet. It is deliberately
 * not a hash and deliberately not JSON: the person signing it is the last
 * defence this scheme has (see the phishing caveat in the header), and they
 * cannot be a defence against a string they cannot read.
 *
 * Trailing and leading whitespace on the inputs is rejected rather than
 * trimmed. A message that differs by one space is a different message and a
 * different device, so "close enough" here is a silently unpairable account.
 */
export function metamaskDeviceMessage(input: MetamaskDeviceMessageInput): string {
  const network = requireMessageField('network', input.network);
  const account = requireMessageField('account', input.accountAddress);
  return `${METAMASK_DEVICE_MESSAGE_VERSION}\nnetwork: ${network}\naccount: ${account}`;
}

function requireMessageField(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MetamaskDeviceError(
      'invalid-message',
      `A MetaMask device message needs a ${name}, and none was given.`,
    );
  }
  if (value !== value.trim()) {
    throw new MetamaskDeviceError(
      'invalid-message',
      `The ${name} in a MetaMask device message carries leading or trailing whitespace, which would derive a different device.`,
    );
  }
  if (/[\r\n]/.test(value)) {
    throw new MetamaskDeviceError(
      'invalid-message',
      `The ${name} in a MetaMask device message contains a line break, which would let it forge the lines below it.`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type MetamaskDeviceErrorCode =
  /** The message could not be built from the inputs given. */
  | 'invalid-message'
  /** Not a 20-byte `0x…` account address. */
  | 'invalid-address'
  /** Not a 65-byte `0x…` signature. */
  | 'invalid-signature'
  /** A stored pairing record could not be read back as one. */
  | 'invalid-record';

export class MetamaskDeviceError extends Error {
  readonly code: MetamaskDeviceErrorCode;

  constructor(code: MetamaskDeviceErrorCode, message: string) {
    super(message);
    this.name = 'MetamaskDeviceError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An Ethereum account address, lower-cased.
 *
 * Lower-casing is not cosmetic: EIP-55 checksum casing is a display convention,
 * and the same account arrives from `eth_requestAccounts` and from a stored
 * record in different casings on different MetaMask versions. Two casings of
 * one address must never look like two devices, so exactly one form is stored,
 * compared, and put in front of the user's eyes.
 */
export function normaliseEthereumAddress(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new MetamaskDeviceError(
      'invalid-address',
      'That is not a MetaMask account address. Passport expects a 0x address of 40 hex characters.',
    );
  }
  return value.toLowerCase();
}

/**
 * The address as a person should see it: `0x1234…cdef`.
 *
 * Enough of both ends to recognise the account they picked in MetaMask, and
 * short enough to sit in a list row on a phone.
 */
export function shortEthereumAddress(value: string): string {
  const address = normaliseEthereumAddress(value);
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Signatures                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The 65 raw bytes of a `personal_sign` result.
 *
 * The length check is the whole of the validation, and it is worth stating what
 * it does NOT do: nothing here verifies that the signature is over the message,
 * or that it recovers to the address the caller believes. It does not need to.
 * A wrong signature derives a wrong secret, which derives a commitment the
 * contract does not hold, which the circuit refuses by name. There is no path
 * where a bad signature spends anything; there is only a path where it fails to.
 */
export function personalSignatureBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new MetamaskDeviceError(
      'invalid-signature',
      'MetaMask did not return a signature Passport can read.',
    );
  }
  const hex = value.slice(2);
  if (hex.length !== SIGNATURE_BYTES * 2) {
    throw new MetamaskDeviceError(
      'invalid-signature',
      `MetaMask returned ${hex.length / 2} bytes of signature; ${SIGNATURE_BYTES} are required.`,
    );
  }
  const bytes = new Uint8Array(SIGNATURE_BYTES);
  for (let index = 0; index < SIGNATURE_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * The scope rule, restated rather than imported, for the same reason
 * `validatePassportStateScope` states it in the backend: the info string below
 * glues `appId` and `accountId` with `:` and escapes nothing, so a `:` inside
 * either field would let two different scopes derive the same 32 bytes.
 */
function requireScope(scope: PassportStateScope): PassportStateScope {
  for (const field of ['appId', 'accountId'] as const) {
    const value = scope?.[field];
    if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
      throw new MetamaskDeviceError(
        'invalid-message',
        `A MetaMask derivation scope needs a ${field} with no ':' in it.`,
      );
    }
  }
  return scope;
}

/**
 * Signature bytes → 32 bytes of root secret, for one scope.
 *
 * This is `deriveWalletSeedBytes` in `demo-backend/src/passkey.ts` with a
 * different input and a different salt, and that is the whole point: the OUTPUT
 * is the same kind of thing, so everything downstream of a passkey — the
 * contract-secret split, the HD wallet, the private-state key — works on a
 * MetaMask device without knowing there is one.
 *
 * HKDF, not a bare SHA-256, because the input is not uniform: a secp256k1
 * signature is two field elements and a recovery byte, with structure an
 * attacker knows. Extract-then-expand is what turns that into key material, and
 * it is what the passkey ladder already does.
 */
export async function deriveMetamaskSeed(
  signature: Uint8Array,
  scope: PassportStateScope,
): Promise<Uint8Array> {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new MetamaskDeviceError(
      'invalid-signature',
      `A MetaMask device seed needs ${SIGNATURE_BYTES} signature bytes, received ${signature.length}.`,
    );
  }
  requireScope(scope);
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(signature),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const info = utf8(`${METAMASK_SEED_INFO_PREFIX}:${scope.appId}:${scope.accountId}`);
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(utf8(METAMASK_SEED_SALT)),
      info: toArrayBuffer(info),
    },
    material,
    SEED_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** A copy, because a `Uint8Array` view over a larger buffer is not its bytes. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * A MetaMask signature, wearing the same interface a discovered passkey wears.
 *
 * `PassportWalletSeedProvider` is what `deriveWalletSeed` in
 * `../lib/localWallet.ts` takes, and what every scope-derived secret in
 * `App.tsx` is obtained through. Handing MetaMask over as one of these is what
 * makes the sign-in path a substitution rather than a second code path: the
 * caller asks the same question and gets 32 bytes, and does not learn which
 * kind of device answered.
 *
 * {@link MetamaskSeedProvider.dispose} zeroes the retained signature, and every
 * derivation after it throws. The signature is the device — it is not a
 * credential that can be revoked, so it must not outlive the session that
 * obtained it.
 */
export interface MetamaskSeedProvider extends PassportWalletSeedProvider {
  dispose(): void;
}

export function metamaskSeedProvider(signature: Uint8Array): MetamaskSeedProvider {
  let retained: Uint8Array | null = Uint8Array.from(signature);
  return {
    deriveWalletSeed: async (scope) => {
      if (!retained) {
        throw new MetamaskDeviceError(
          'invalid-signature',
          'This MetaMask signature has already been disposed.',
        );
      }
      return deriveMetamaskSeed(retained, scope);
    },
    dispose: () => {
      retained?.fill(0);
      retained = null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The pairing record                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What this browser remembers about a MetaMask device it paired.
 *
 * NONE OF IT IS A SECRET, and none of it is authority. The record exists for
 * exactly one reason: signing in with MetaMask needs the account address BEFORE
 * it can build the message to sign, and the only thing the browser has at that
 * moment is the 0x address MetaMask offered. So the record is a lookup from one
 * public identifier to another. Losing it costs nothing that cannot be typed
 * back in — the sign-in screen also accepts the person's name, which resolves
 * to the same account — and stealing it grants nothing, because deriving the
 * device still needs the MetaMask account to sign.
 *
 * `commitmentHex` is stored so the paired-device list can be shown against the
 * account's own device set without asking MetaMask to sign again just to render
 * a row.
 */
export interface PairedMetamaskDevice {
  /** Lower-cased `0x…` MetaMask account address. */
  address: string;
  /** The account contract this device was paired to. */
  accountAddress: string;
  /** The network id in the signed message. */
  network: string;
  /** The device commitment `add_device` was called with, as 64 hex characters. */
  commitmentHex: string;
  /** The name this Passport answers to, for the sign-in screen's benefit. */
  name: string | null;
  /** ISO 8601, for the row's subtitle. */
  pairedAt: string;
}

function isPairedDevice(value: unknown): value is PairedMetamaskDevice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.address === 'string' &&
    /^0x[0-9a-f]{40}$/.test(record.address) &&
    typeof record.accountAddress === 'string' &&
    record.accountAddress.length > 0 &&
    typeof record.network === 'string' &&
    record.network.length > 0 &&
    typeof record.commitmentHex === 'string' &&
    /^[0-9a-f]{64}$/.test(record.commitmentHex) &&
    (record.name === null || typeof record.name === 'string') &&
    typeof record.pairedAt === 'string'
  );
}

/**
 * Reads a stored list back, keeping only the rows that are still records.
 *
 * A row that no longer parses is DROPPED rather than thrown over, because this
 * list is a convenience and a corrupt one must not be able to stop somebody
 * signing in. Anything unreadable at the top level — not JSON, not an array —
 * is an empty list for the same reason.
 */
export function parsePairedDevices(raw: string | null): PairedMetamaskDevice[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isPairedDevice);
}

export function serialisePairedDevices(devices: readonly PairedMetamaskDevice[]): string {
  return JSON.stringify(devices);
}

/**
 * The record for one address, or `null`.
 *
 * The lookup normalises, so a checksummed address from `eth_requestAccounts`
 * finds a row stored in lower case.
 */
export function pairedDeviceFor(
  devices: readonly PairedMetamaskDevice[],
  address: string,
): PairedMetamaskDevice | null {
  const wanted = normaliseEthereumAddress(address);
  return devices.find((device) => device.address === wanted) ?? null;
}

/**
 * The list with `device` in it, replacing any row for the same address on the
 * same account.
 *
 * One MetaMask account MAY be a device on two different Passports — the account
 * address is in the signed message precisely so that it derives two unrelated
 * devices — so the identity of a row is the PAIR, not the address alone.
 */
export function withPairedDevice(
  devices: readonly PairedMetamaskDevice[],
  device: PairedMetamaskDevice,
): PairedMetamaskDevice[] {
  const normalised = { ...device, address: normaliseEthereumAddress(device.address) };
  if (!isPairedDevice(normalised)) {
    throw new MetamaskDeviceError(
      'invalid-record',
      'That is not a MetaMask pairing Passport can store.',
    );
  }
  return [
    ...devices.filter(
      (existing) =>
        existing.address !== normalised.address ||
        existing.accountAddress !== normalised.accountAddress,
    ),
    normalised,
  ];
}

/** The list without the row for `address` on `accountAddress`. */
export function withoutPairedDevice(
  devices: readonly PairedMetamaskDevice[],
  address: string,
  accountAddress: string,
): PairedMetamaskDevice[] {
  const wanted = normaliseEthereumAddress(address);
  return devices.filter(
    (device) => device.address !== wanted || device.accountAddress !== accountAddress,
  );
}

/** Every device paired to one account, oldest first. */
export function pairedDevicesForAccount(
  devices: readonly PairedMetamaskDevice[],
  accountAddress: string,
): PairedMetamaskDevice[] {
  return devices.filter((device) => device.accountAddress === accountAddress);
}

/* -------------------------------------------------------------------------- */
/* The feature flag                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether this build offers MetaMask at all.
 *
 * Default OFF, and off for anything but the literal `1`. This is an experiment
 * carrying a phishing caveat the header states in full; a production build must
 * be unaffected by its presence in the tree, and "unaffected" means the controls
 * are not rendered rather than rendered and refusing.
 */
export function metamaskDeviceEnabled(env: Record<string, string | undefined>): boolean {
  return env.VITE_METAMASK_DEVICE === '1';
}
