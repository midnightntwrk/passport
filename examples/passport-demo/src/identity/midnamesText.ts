/**
 * The Midnames naming rules, as pure text — no ledger, no registry, no chain.
 *
 * WHY THIS FILE EXISTS (2026/09/01)
 * ---------------------------------
 * `./midnames.ts` statically imports `./contractRuntime.ts`, which statically
 * imports `@midnightntwrk/ledger-v9`, whose module initialisation TOP-LEVEL
 * AWAITS a 9.84 MB WASM binary. Anything that imports `midnames.ts` for a value
 * therefore drags that binary into the entry chunk and holds `createRoot` until
 * it has been fetched AND instantiated.
 *
 * Two screens did exactly that, and both are on the FIRST render path:
 * `screens/AliasClaim.tsx` and `screens/AliasReclaimModal.tsx`, each for the
 * same handful of string functions. Measured on 2026/09/01 against a production
 * build over loopback: 10.07 MB transferred before the onboarding screen's
 * "Continue with Passport" button existed, 9.84 MB of it the ledger. Nobody
 * claiming a name needs the ledger at the moment the welcome screen paints;
 * they need it minutes later, at the claim itself, which is where
 * `App.tsx` has always dynamically imported it from.
 *
 * So the rules a screen needs to VALIDATE and FORMAT a name live here, in a
 * leaf with no imports at all, and `./midnames.ts` re-exports every one of them
 * so no other caller had to change. This module must never grow an import of
 * anything but another leaf — that is the whole of its job.
 *
 * `src/lib/recipientName.ts` already keeps its distance from `midnames.ts` for
 * this reason and says so in its own header; this is the same rule, applied to
 * the screens that could not keep their distance because they genuinely needed
 * the registry's own label rule rather than a second copy of it.
 */

/** The `.night` top-level domain. Every Passport alias is a label under it. */
export const MIDNAMES_TLD = 'night';

/**
 * Names Passport will not let a user claim, whatever the registry says. These
 * are infrastructure and impersonation risks — `midnight.night` reading as an
 * official account is exactly the confusion this list prevents.
 */
export const RESERVED_ALIASES: readonly string[] = [
  'admin',
  'faucet',
  'foundation',
  'midnight',
  'night',
  'passport',
  'root',
  'wallet',
  'www',
];

/** `alice` → `alice.night`. */
export function aliasDomain(alias: string): string {
  return `${alias}.${MIDNAMES_TLD}`;
}

/**
 * Normalises a typed alias to its registry label, throwing a sentence the UI
 * can show verbatim.
 *
 * The accepted shape is exactly the Node integration's:
 * `/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/` — 1–32 characters, lowercase
 * letters and digits, hyphens only in the interior. Passport adds one rule on
 * top: {@link RESERVED_ALIASES} are refused before any network call.
 */
export function normalizePassportAlias(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  const alias = normalized.endsWith(`.${MIDNAMES_TLD}`)
    ? normalized.slice(0, -(MIDNAMES_TLD.length + 1))
    : normalized;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(alias)) {
    /* The wording is the name step's own footnote, verbatim. This sentence is
       shown to the user, so it says "name" — the word the whole screen uses —
       rather than "alias", which is only what this module happens to call the
       label internally. */
    throw new Error(
      'Names are 1–32 characters: lowercase letters, numbers, and hyphens inside.',
    );
  }
  if (RESERVED_ALIASES.includes(alias)) {
    throw new Error(`"${alias}" is reserved by the Midnight network and cannot be claimed.`);
  }
  return alias;
}

/**
 * Alternative labels to offer when a name is taken on the target network.
 * Suggestions are candidates only — the modal probes each one for real before
 * presenting it as free.
 */
export function suggestAliasAlternatives(alias: string): string[] {
  const base = alias.replace(/-+$/, '');
  const candidates = [`${base}2`, `${base}-mn`, `${base}-night`, `my${base}`, `${base}01`];
  return candidates.filter((candidate) => {
    try {
      return normalizePassportAlias(candidate) === candidate;
    } catch {
      return false;
    }
  });
}

/**
 * What the registry says about one label. The ANSWER lives here with the rules
 * because the screens that render it must be able to name it without importing
 * the module that goes and asks — see this file's header.
 */
export type AliasAvailability =
  | { status: 'available' }
  | { status: 'taken'; resolverAddress: string }
  | { status: 'unreachable'; detail: string };

export interface AliasClaimProgress {
  /**
   * The phases a claim really has, in the order they happen.
   *
   * `attaching-account` belongs to the CALLER rather than to `./midnames.ts`:
   * it covers deploying this Passport's account-custody contract so the name
   * has a contract to bind to. It is named here because the button that
   * narrates a claim narrates all of it — a user watching one action should not
   * be shown a vocabulary that skips its longest step.
   *
   * There is no `activating` phase. It described a NIGHT grant sent to the
   * wallet address before a claim, and the wallet neither receives nor spends
   * anything for a name; the service registers it and, once the account exists,
   * funds the ACCOUNT (ruled 2026/08/25).
   *
   * `checking`, `preparing`, and `confirm-passkey` were added on 2026/08/26,
   * and they are the three that happen BEFORE the passkey prompt: re-reading
   * the registry, waiting on the sponsor's answer, and the ceremony itself.
   * They exist because a reviewer watched a claim sit on one unchanging label
   * for the whole of that stretch and could not tell a slow network from a
   * hung app. A phase vocabulary that starts at the account deploy describes
   * the part of a claim the user was never confused by.
   */
  phase:
    | 'checking'
    | 'preparing'
    | 'confirm-passkey'
    | 'attaching-account'
    | 'deploying-resolver'
    | 'registering'
    | 'confirming';
}
