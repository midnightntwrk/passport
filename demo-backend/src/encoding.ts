import type { PassportStateScope } from './types.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * SCOPE LABELS MUST STAY INJECTIVE.
 * ---------------------------------
 * A `PassportStateScope` is turned into a flat label at three sites — the
 * HKDF info string for the private-state key, the HKDF info string for the
 * wallet seed, and the AAD (and, through it, the storage key) of an encrypted
 * envelope. Every one of them glues `appId` and `accountId` together with a
 * single separator character and escapes nothing:
 *
 *   `midnight-passport:scope:v1:${appId}:${accountId}`
 *   `midnight-passport:wallet-seed:v1:${appId}:${accountId}`
 *   `midnight-passport:private-state:v1|${appId}|${accountId}`
 *
 * If both halves may carry the separator the map is not injective:
 * `{ appId: 'demo:eu', accountId: 'alice' }` and
 * `{ appId: 'demo', accountId: 'eu:alice' }` flatten to the SAME label, which
 * means the same wallet seed and the same storage slot — one scope's `save()`
 * silently overwriting the other's envelope.
 *
 * The rule that fixes it, and the ONE convention all three sites share:
 * `appId` may not contain `:` or `|`, and neither half may contain a control
 * character. With the prefix a fixed literal and `appId` separator-free, the
 * first separator after the prefix terminates `appId` unambiguously and the
 * remainder is `accountId` — so the flattening is injective again.
 *
 * WHY `accountId` IS DELIBERATELY LEFT FREE. It does not need the restriction
 * for injectivity (the split point is already pinned by `appId`), and it must
 * not have it: shipped Passports derive under `passport-local:<credential>`
 * account ids, whose colon is part of a live label. Rejecting it would make
 * every existing wallet seed and encrypted envelope underivable. Nothing here
 * changes the label of a well-formed scope; it only rejects the shapes that
 * were capable of colliding.
 */
const SCOPE_SEPARATORS = /[:|]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function assertScopeField(field: 'appId' | 'accountId', value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) {
    const article = field === 'appId' ? 'an appId' : 'an accountId';
    throw new Error(`Passport state scope requires ${article}.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`A Passport state scope ${field} may not contain control characters.`);
  }
  if (field === 'appId' && SCOPE_SEPARATORS.test(value)) {
    throw new Error(
      "A Passport state scope appId may not contain ':' or '|'. Those separate " +
        'appId from accountId in every derivation label, so an appId carrying one lets ' +
        'two different scopes derive the same wallet seed and share one storage slot.',
    );
  }
}

/**
 * The single scope check every derivation and storage path runs. Call it
 * before a scope reaches an HKDF info string, an AAD, or a storage key.
 */
export function validatePassportStateScope(scope: PassportStateScope): void {
  assertScopeField('appId', scope.appId);
  assertScopeField('accountId', scope.accountId);
}

interface TaggedValue {
  __passportType: 'bigint' | 'bytes';
  value: string;
}

function isTaggedValue(value: unknown): value is TaggedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__passportType' in value &&
    'value' in value &&
    ((value as TaggedValue).__passportType === 'bigint' ||
      (value as TaggedValue).__passportType === 'bytes')
  );
}

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Web Crypto's DOM typings require an ArrayBuffer-backed view. */
export function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function toBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeState(value: unknown): Uint8Array {
  return utf8(
    JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === 'bigint') {
        return { __passportType: 'bigint', value: nestedValue.toString() } satisfies TaggedValue;
      }
      if (nestedValue instanceof Uint8Array) {
        return { __passportType: 'bytes', value: toBase64(nestedValue) } satisfies TaggedValue;
      }
      return nestedValue;
    }),
  );
}

export function decodeState<T>(value: Uint8Array): T {
  return JSON.parse(textDecoder.decode(value), (_key, nestedValue) => {
    if (!isTaggedValue(nestedValue)) return nestedValue;
    if (nestedValue.__passportType === 'bigint') return BigInt(nestedValue.value);
    return fromBase64(nestedValue.value);
  }) as T;
}
