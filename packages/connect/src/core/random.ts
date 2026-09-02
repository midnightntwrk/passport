/**
 * A fresh request identifier: `bytes` random bytes, lower-case hex.
 *
 * Every Passport wire protocol binds a reply to the `requestId`/`nonce` pair
 * the caller minted, which only holds if a caller cannot guess or collide with
 * another's. The default 24 bytes is 192 bits — far out of birthday reach, and
 * short enough to ride in a URL query string.
 *
 * It is exported so every connector mints ids the same way rather than
 * reaching for `Math.random()`. Four hand-rolled copies of this function used
 * to exist across the example apps while the real one sat exported and unused;
 * they are gone, and this is the only one.
 */
export function randomRequestId(bytes = 24): string {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error('A Passport request id needs at least one random byte.');
  }
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A request id and the nonce that goes with it, minted together. */
export function randomExchangePair(): { requestId: string; nonce: string } {
  return { requestId: randomRequestId(), nonce: randomRequestId() };
}
