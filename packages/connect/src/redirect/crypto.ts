/* ===========================================================================
 * The three checks a receiver has to actually perform
 * ===========================================================================
 *
 * Passport's own copy of this contract takes verification as an injected
 * function so it can stay portable. An app has to actually do it, and this is
 * where the doing lives: `@noble/curves` for BIP-340, `@noble/hashes` for
 * sha256, `@scure/base` for bech32m. No Midnight dependency and no
 * WebAssembly — three small pure-JavaScript libraries is the whole cost of
 * verifying a Midnight identity in a web page.
 *
 * They are reachable only from the `./redirect` entry point, which is why the
 * package's core stays at zero runtime dependencies.
 * ========================================================================= */

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';

/** Bech32m's default 90-character limit is well below a Midnight address. */
const BECH32M_LIMIT = 512;

/**
 * BIP-340 Schnorr over secp256k1, applied to `sha256(payload)`.
 *
 * The pre-hash is not decoration. Midnight's `unshieldedKeystore.signData`
 * hashes its input with sha256 before signing, so a verifier that hands the
 * raw payload to BIP-340 fails on every valid signature. Established against
 * `@midnight-ntwrk/ledger-v8` 8.0.3 (2026/08/19): `signData(sk, m)` and
 * `schnorr.verify(sig, sha256(m), xOnlyPublicKey)` agree, and `signData` is
 * rejected by `schnorr.verify(sig, m, …)`.
 */
export function verifyPassportSignature(
  publicKeyHex: string,
  payload: Uint8Array,
  signatureHex: string,
): boolean {
  return schnorr.verify(hexToBytes(signatureHex), sha256(payload), hexToBytes(publicKeyHex));
}

/**
 * The Midnight unshielded address a verifying key controls.
 *
 * The derivation, established against
 * `@midnight-ntwrk/wallet-sdk-unshielded-wallet` 3.0.0 and
 * `@midnight-ntwrk/ledger-v8` 8.0.3 (2026/08/19), is:
 *
 *     address = bech32m(hrp = 'mn_addr' | 'mn_addr_<network>',
 *                       data = sha256(xOnlyVerifyingKey))
 *
 * WHAT THIS IS FOR, and what it is emphatically not for. It is an IDENTIFIER:
 * two replies signed by the same key derive to the same address, which is how
 * a receiver recognises the same Passport across visits without anybody
 * sending an account identifier over the wire. It is NOT a payment
 * destination. A Passport's money lives at its account-custody contract —
 * `passportContract.address` — and value sent to the signing key's address is
 * value the account cannot see. That is exactly why the engine addresses were
 * removed from the profile vocabulary, and putting one back through this
 * function would be the same mistake with an extra step.
 */
export function passportUnshieldedAddressFromKey(publicKeyHex: string, network?: string): string {
  const digest = sha256(hexToBytes(publicKeyHex));
  const prefix = network ? `mn_addr_${network}` : 'mn_addr';
  return bech32m.encode(prefix, bech32m.toWords(digest), BECH32M_LIMIT);
}

/**
 * Whether `address` is the Midnight unshielded address of `publicKeyHex`.
 *
 * The network lives in the human-readable part, so it is checked as a prefix
 * rather than parsed: a receiver that cares which network it is talking to
 * should read the prefix, and one that does not should still not accept an
 * address whose type is not `addr`.
 */
export function verifyPassportKeyBinding(publicKeyHex: string, address: string): boolean {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(address as `${string}1${string}`, BECH32M_LIMIT);
  } catch {
    return false;
  }
  if (decoded.prefix !== 'mn_addr' && !decoded.prefix.startsWith('mn_addr_')) return false;
  let payload: Uint8Array;
  try {
    payload = bech32m.fromWords(decoded.words);
  } catch {
    return false;
  }
  let expected: Uint8Array;
  try {
    expected = sha256(hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
  if (payload.length !== expected.length) return false;
  /* Length-independent comparison is pointless here — both sides are public —
     but a loop is still needed because `Uint8Array` has no equality. */
  let equal = true;
  for (let index = 0; index < expected.length; index += 1) {
    if (payload[index] !== expected[index]) equal = false;
  }
  return equal;
}
