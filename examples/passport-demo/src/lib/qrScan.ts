/**
 * QR payload extraction for the camera scanner.
 *
 * The scanner's job splits in two, deliberately: THIS module decides whether a
 * decoded QR plausibly carries a Midnight address at all — so the camera knows
 * whether to keep scanning — and the Send sheet's existing recipient validator
 * (the wallet SDK's own codec) remains the sole judge of whether the address
 * is actually usable. Nothing here re-implements the address taxonomy; a
 * plausible-but-wrong address lands in the recipient field and earns the
 * validator's honest sentence there, exactly as a pasted one would.
 *
 * Two QR realities this handles that a naïve `startsWith('mn_')` would not:
 *
 * - QR alphanumeric mode is upper-case only, so wallets commonly encode
 *   bech32m addresses upper-cased (the checksum survives either case, but the
 *   parser wants lower). An all-upper payload is lower-cased before matching;
 *   a MIXED-case payload is left alone, because bech32m forbids mixed case
 *   and the validator should say so.
 * - Addresses travel wrapped as URIs (`midnight:mn_addr…`, possibly with
 *   query parameters). The wrapper is stripped; the parameters are ignored
 *   rather than interpreted — an `amount=` hint silently prefilled would be a
 *   payment request feature this demo has not built, and half-honouring it is
 *   worse than ignoring it.
 */

/** `true` when the whole string has no lower-case letters at all. */
function isAllUpperCase(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

/**
 * Pulls a plausible Midnight address out of a decoded QR payload, or returns
 * `null` when the payload is something else entirely (a URL, arbitrary text,
 * an empty read) — the signal to keep scanning.
 */
export function extractMidnightAddress(payload: string): string | null {
  let text = payload.trim();
  if (!text) return null;

  /* QR alphanumeric mode upper-cases everything, scheme included. */
  const normalised = isAllUpperCase(text) ? text.toLowerCase() : text;

  /* The URI wrapper. Only the `midnight:` scheme is unwrapped — a QR carrying
     some other scheme (https:, mailto:) is not an address and scanning should
     continue. Query parameters and fragments are dropped, not interpreted. */
  let candidate = normalised;
  if (candidate.startsWith('midnight:')) {
    candidate = candidate.slice('midnight:'.length);
    // Tolerate the `//` some URI builders insert after the scheme.
    if (candidate.startsWith('//')) candidate = candidate.slice(2);
    const cut = candidate.search(/[?#]/);
    if (cut !== -1) candidate = candidate.slice(0, cut);
  } else if (/^[a-z][a-z0-9+.-]*:/.test(candidate)) {
    return null;
  }

  candidate = candidate.trim();

  /* Plausibility, not validity: every Midnight bech32m string starts `mn_`
     (mn_addr, mn_shield-addr, mn_dust…). Which kind it is, and whether it is
     on the right network, is the recipient validator's verdict to give. */
  if (!/^mn_[a-z0-9_-]+1[a-z0-9]{6,}$/.test(candidate)) return null;
  return candidate;
}
