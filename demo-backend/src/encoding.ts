const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
