/**
 * The one QR vocabulary Passport speaks, in both directions.
 *
 * Until 2026/08/31 this file was half of `qrScan.ts` and read QR codes only:
 * Passport could scan an address someone else's wallet had drawn but could not
 * draw one of its own. Receive now shows a code, so the same rules have to be
 * written down once and used at both ends — an encoder and a decoder that
 * disagree produce a QR that only a different app can read.
 *
 * THE FORMAT
 * ----------
 *   midnight:alice.night?account=<64 hex>
 *
 * The NAME leads, because the name is what Passport is for and what the
 * recipient field takes. The account travels behind it as a query parameter,
 * lower-case and byte-mode throughout so a scanner has one string to compare
 * rather than a case fold to guess at.
 *
 * WHAT THE EMBEDDED ACCOUNT IS, AND IS NOT
 * ----------------------------------------
 * It is a CROSS-CHECK. The `.night` registry stays the sole authority on what
 * a name pays: a scanned code fills the recipient field with the DOMAIN, the
 * Send sheet resolves it as it would a typed one, and the account it embedded
 * is never spent to. Where the two disagree the sheet refuses rather than
 * picking a winner — a code that names Alice and carries someone else's
 * account is either stale or hostile, and neither is worth guessing about.
 *
 * WHAT ELSE STILL SCANS
 * ---------------------
 * Two shapes predate this format and keep working, because other wallets draw
 * them: a bare `mn_addr…` address, wrapped in `midnight:` or not, and a bare
 * `alice.night`. Both parse to the same union the Send sheet consumes.
 *
 * Two QR realities this handles that a naïve `startsWith('mn_')` would not:
 *
 * - QR alphanumeric mode is upper-case only, so wallets commonly encode
 *   bech32m addresses upper-cased (the checksum survives either case, but the
 *   parser wants lower). An all-upper payload is lower-cased before matching;
 *   a MIXED-case payload is left alone, because bech32m forbids mixed case
 *   and the validator should say so.
 * - Addresses travel wrapped as URIs, possibly with query parameters. The
 *   wrapper is stripped; every parameter EXCEPT `account` is ignored rather
 *   than interpreted — an `amount=` hint silently prefilled would be a payment
 *   request feature this demo has not built, and half-honouring it is worse
 *   than ignoring it.
 *
 * Plausibility, not validity, is the bar here: this module decides whether a
 * decoded code is worth acting on at all, so the camera knows whether to keep
 * scanning. The Send sheet's recipient validator — the wallet SDK's own codec
 * for an address, the registry for a name — remains the sole judge of whether
 * the thing is usable, and owns the refusal a user reads.
 */

import { classifyRecipientInput } from './recipientName.js';

/** The URI scheme Passport draws and reads. Lower-case, always. */
const SCHEME = 'midnight:';

/** `true` when the whole string has no lower-case letters at all. */
function isAllUpperCase(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

/**
 * A 64-hex account address, or `null`.
 *
 * Deliberately the same shape as `normalisedColourHex` in `colour.ts` and
 * deliberately not a call to it: that function answers a question about a
 * token colour, and borrowing it here would make an account address look like
 * one in every call site that greps for it. An `0x` prefix is forgiven because
 * some tools write one; anything that is not exactly 32 bytes of hex after
 * that is dropped in silence, since a malformed cross-check is no worse than
 * an absent one and the registry answers either way.
 *
 * Exported because the Send sheet has to put the registry's answer through the
 * SAME rule before comparing the two. A cross-check where each side is
 * normalised differently is a cross-check that fails on a leading `0x`.
 */
export function normalisedAccountHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalised = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(normalised) ? normalised : null;
}

/**
 * What a scanned code turned out to be.
 *
 * `accountHex` on a name is the cross-check described above, and is `null` for
 * every code that did not carry one — a bare `alice.night`, or a Passport code
 * drawn before its account existed.
 */
export type QrPayload =
  | { kind: 'address'; address: string }
  | { kind: 'name'; domain: string; accountHex: string | null };

/**
 * The exact string a Receive QR encodes, or `null` when there is nothing worth
 * drawing.
 *
 * `null` when there is no name: a code carrying only a raw account is one no
 * Passport scanner can act on — the recipient field takes a name or an `mn_`
 * address and a bare 64-hex string is neither — and drawing an unscannable
 * square would be the sheet promising something it cannot keep. The address
 * row beneath it carries that case on its own, as it did before there was a
 * QR at all.
 *
 * A name that is not registered yet still gets a code. It resolves to nobody,
 * and a sender scanning it is told exactly that by the registry — which is the
 * true answer, and better than a Receive sheet that quietly shows nothing.
 */
export function encodeReceivePayload(parts: {
  domain: string | null | undefined;
  accountAddress: string | null | undefined;
}): string | null {
  const typed = classifyRecipientInput(parts.domain ?? '');
  if (typed.kind !== 'name') return null;
  const account = normalisedAccountHex(parts.accountAddress);
  return `${SCHEME}${typed.domain}${account ? `?account=${account}` : ''}`;
}

/**
 * Reads a decoded QR payload, or returns `null` when it is something else
 * entirely (a URL, a Wi-Fi config, arbitrary text, an empty read) — the signal
 * to keep scanning.
 */
export function parseQrPayload(payload: string): QrPayload | null {
  const text = payload.trim();
  if (!text) return null;

  /* QR alphanumeric mode upper-cases everything, scheme and query key
     included. Lower-casing the whole payload is why `?ACCOUNT=` parses. */
  const normalised = isAllUpperCase(text) ? text.toLowerCase() : text;

  /* The URI wrapper. Only `midnight:` is unwrapped — a QR carrying some other
     scheme (https:, mailto:) is not ours and scanning should continue. */
  let body = normalised;
  if (body.startsWith(SCHEME)) {
    body = body.slice(SCHEME.length);
    // Tolerate the `//` some URI builders insert after the scheme.
    if (body.startsWith('//')) body = body.slice(2);
  } else if (/^[a-z][a-z0-9+.-]*:/.test(body)) {
    return null;
  }

  /* Fragment first, then query: `?a=b#c` and `#c?a=b` both leave the query
     where it belongs rather than smuggling a fragment into a parameter. */
  const hash = body.indexOf('#');
  if (hash !== -1) body = body.slice(0, hash);
  const mark = body.indexOf('?');
  const query = mark === -1 ? '' : body.slice(mark + 1);
  const candidate = (mark === -1 ? body : body.slice(0, mark)).trim();

  /* Address first: every Midnight bech32m string starts `mn_` (mn_addr,
     mn_shield-addr, mn_dust…) and no `.night` label may contain an
     underscore, so the two vocabularies cannot collide. Which kind it is, and
     whether it is on the right network, is the recipient validator's verdict
     to give. */
  if (/^mn_[a-z0-9_-]+1[a-z0-9]{6,}$/.test(candidate)) {
    return { kind: 'address', address: candidate };
  }

  /* Then a name, by the same rule the recipient field uses — one definition of
     what a Passport name may be, rather than a second one drifting here. A
     bare `alice` counts, because that is the form people say out loud. */
  const typed = classifyRecipientInput(candidate);
  if (typed.kind !== 'name') return null;
  return {
    kind: 'name',
    domain: typed.domain,
    accountHex: normalisedAccountHex(new URLSearchParams(query).get('account')),
  };
}
