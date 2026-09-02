/**
 * Reading a recipient field that now takes a `.night` name as well as an
 * address, and remembering what each name resolved to.
 *
 * SENDING TO A NAME IS THE POINT OF PASSPORT
 * ------------------------------------------
 * "A name, not an address" is the second promise on the welcome screen, and
 * until 2026/08/30 the Send sheet could not keep it: `classifyRecipient` in
 * `SendSheet.tsx` ran the wallet SDK's bech32m codec over whatever was typed
 * and refused anything that was not an address. `resolveAliasTarget` existed
 * and was called from exactly two places, both of them checking one's OWN
 * claim.
 *
 * This module is the half of the fix that can be reasoned about: which of the
 * two kinds of thing a person has typed, and whether we have already asked the
 * registry about it. The asking itself is a network read and lives in
 * `identity/midnames.ts`, behind a seam the sheet is handed.
 *
 * THE HEURISTIC, AND WHY IT IS THIS ONE
 * -------------------------------------
 * Every Midnight address begins `mn_` — `mn_addr…` unshielded, `mn_shield-addr…`
 * shielded — and no `.night` label may contain an underscore. So the two
 * vocabularies do not overlap and the split needs no cleverness:
 *
 *   `mn_…`            an address, however partial. Refusals stay the SDK's.
 *   64 hex characters an ACCOUNT, with or without `0x` (added 2026/09/02). It
 *                     is what a name resolves to, so it goes by the same route
 *                     and needs no registry read at all. No label the registry
 *                     could hold is 64 characters long, so this can never take
 *                     a name from the rule below.
 *   `alice.night`     a name.
 *   `alice`           a name. A bare label is the form people say out loud,
 *                     and requiring the suffix would be Passport insisting on
 *                     its own plumbing.
 *   anything else     an address, and the codec gets the next word — so a
 *                     typo'd address earns the codec's own sentence rather
 *                     than "no Passport has this name", which would be a lie
 *                     about what went wrong.
 *
 * A bare `m` or `mn`, typed on the way to an address, is read as a name. That
 * is deliberate rather than overlooked: the resolution is debounced, so it only
 * fires if somebody stops there, and one wasted registry read is a better
 * failure than a rule that guesses at what half-typed text is going to become.
 */

/** The one top-level domain Passport names live under. */
export const NIGHT_SUFFIX = '.night';

/**
 * The registry's own label rule, from `identity/midnames.ts`: 1–32 characters,
 * lowercase letters and digits, hyphens only in the interior. Duplicated here
 * on purpose — that module statically imports the Midnight ledger, and the
 * Send sheet must not drag the wallet SDK into its chunk to validate a string.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * A Passport account, named directly by the 32 bytes it lives at.
 *
 * `0x` is forgiven because every tool that copies these bytes out disagrees
 * about whether to write it, and the prefix carries no meaning either way. The
 * kept value is always the bare 64 lowercase characters, which is the form
 * every contract call takes.
 */
const ACCOUNT_HEX = /^(?:0x)?[0-9a-f]{64}$/i;

export type RecipientInput =
  /** Nothing typed yet. */
  | { kind: 'empty' }
  /** A `.night` name to resolve. `domain` is normalised and suffixed. */
  | { kind: 'name'; label: string; domain: string }
  /** Meant as a name, but not a name the registry could hold. */
  | { kind: 'name-invalid'; typed: string; reason: string }
  /**
   * A Passport account address, which needs no registry read: it IS the answer
   * a name would have resolved to. Added 2026/09/02 so somebody whose
   * counterparty has no name yet — or who has been handed the account off a
   * Receive screen — is not turned away by a sheet that can only take names.
   */
  | { kind: 'account'; address: string }
  /** Anything else. The address codec decides, and owns the refusal. */
  | { kind: 'address'; value: string };

/**
 * Which of the two a person has typed.
 *
 * Case and a trailing dot are forgiven, because both are things people type and
 * neither changes what was meant. Nothing else is: a label the registry could
 * not hold is reported as a bad NAME rather than handed to the address codec,
 * so the sentence the user reads is about the thing they were doing.
 */
export function classifyRecipientInput(raw: string): RecipientInput {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };
  if (/^mn_/i.test(value)) return { kind: 'address', value };
  /* Before the name rule, and it can never take anything from it: a label is at
     most 32 characters, so no name the registry could hold is 64 hex ones. A
     string that is ALMOST an account — 63 characters, or 65 — is not an account
     and falls through to the name rule, which refuses it in words about length
     rather than accepting a truncated address. */
  if (ACCOUNT_HEX.test(value)) {
    return { kind: 'account', address: value.replace(/^0x/i, '').toLowerCase() };
  }

  const lowered = value.toLowerCase().replace(/\.+$/, '');
  const looksLikeName = lowered.endsWith(NIGHT_SUFFIX) || !lowered.includes('.');
  if (!looksLikeName) return { kind: 'address', value };

  const label = lowered.endsWith(NIGHT_SUFFIX)
    ? lowered.slice(0, -NIGHT_SUFFIX.length)
    : lowered;
  if (!label) {
    return { kind: 'name-invalid', typed: value, reason: 'Type the name before .night.' };
  }
  if (!LABEL.test(label)) {
    return {
      kind: 'name-invalid',
      typed: value,
      reason:
        'A Midnight name is 1–32 letters, numbers, or hyphens in the middle — nothing else.',
    };
  }
  return { kind: 'name', label, domain: `${label}${NIGHT_SUFFIX}` };
}

/**
 * What the registry said about one name.
 *
 * `found: false` is a real ANSWER — the registry was read and nobody holds the
 * name — and is cached like any other. A failure to read it at all is not
 * represented here: it is thrown by the seam, and never cached, because
 * remembering "the network was down" would keep saying so after it came back.
 */
export type NameLookup =
  | { found: true; domain: string; accountAddress: string }
  | { found: false; reason: string };

/**
 * The sheet's memory of what it has already asked.
 *
 * Its lifetime is the sheet's: a Send sheet closed and reopened asks again,
 * which is what somebody who has just been told "no Passport has this name"
 * would expect after going away to fix it. Keyed by the NORMALISED domain, so
 * `Alice`, `alice`, and `alice.night` are one question rather than three.
 */
export interface NameResolutionCache {
  get(domain: string): NameLookup | undefined;
  set(domain: string, lookup: NameLookup): void;
  /** How many distinct names have been asked about. For drilling the reuse. */
  size(): number;
}

export function createNameResolutionCache(): NameResolutionCache {
  const answers = new Map<string, NameLookup>();
  return {
    get: (domain) => answers.get(domain.trim().toLowerCase()),
    set: (domain, lookup) => {
      answers.set(domain.trim().toLowerCase(), lookup);
    },
    size: () => answers.size,
  };
}

/**
 * The tail of an account address, for the confirmation chip.
 *
 * The chip's whole job is to let somebody confirm that the name they typed
 * found SOMETHING, and its whole constraint is that the address itself is not a
 * thing a Passport user is shown. Four characters do the first without doing
 * the second: they are enough to tell two resolutions apart on screen and far
 * too few to copy, retype, or mistake for an address.
 */
export function accountTail(accountAddress: string, keep = 4): string {
  const value = accountAddress.trim();
  if (!value) return '';
  return `…${value.slice(-keep)}`;
}
