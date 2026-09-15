/**
 * The Dynamic sign-in seam, with none of Dynamic in it.
 *
 * WHY THIS MODULE HOLDS NO SDK IMPORT
 * -----------------------------------
 * `e1593bb` removed Dynamic from this demo and its message names the two
 * failures that removal was paying off: the app could not boot without a
 * `VITE_DYNAMIC_ENVIRONMENT_ID`, and the SDK sat in the entry chunk — 6,378 kB
 * of it, against 717 kB once it was gone. Both are properties of WHERE the
 * import sits, not of how careful the calling code is, so the rule this slice
 * ships under is structural rather than a matter of discipline:
 *
 *   nothing that `src/main.tsx` can reach through a STATIC import may name
 *   `@dynamic-labs`.
 *
 * This module is the whole of what the app's screens see, and it imports
 * nothing but the standard library. The SDK lives behind one `import()` in
 * `src/lib/dynamic.tsx`, reached only when {@link isDynamicEnabled} is true.
 * `src/lib/dynamicBundle.test.ts` walks the static graph from `main.tsx` and
 * fails if the specifier ever appears inside it.
 *
 * WHAT THIS SLICE DOES NOT DO
 * ---------------------------
 * Nothing here signs anything the account is authorised by. The passkey
 * remains the device key for every call this Passport makes; a Dynamic session
 * is an extra identity sitting beside it, and `signMessage` exists so the next
 * slice has evidence to read. See `docs/demo/dynamic-integration.md`.
 *
 * THE STORE, AND WHY IT IS NOT A REACT CONTEXT
 * --------------------------------------------
 * The SDK's provider is mounted in a SEPARATE React root (see
 * `src/lib/dynamic.tsx`), so the app's own tree is byte-for-byte the tree it
 * renders today whether the flag is set or not. A provider wrapped around
 * `<PassportDemo />` would change the app's structure the moment the lazily
 * loaded chunk arrived, and React reconciles by position: the swap would
 * remount the whole Passport mid-onboarding. A module-level store read through
 * `useSyncExternalStore` crosses between the two roots without either one
 * being an ancestor of the other.
 */

/** Every state the sign-in seam can be in, in the order a session moves through them. */
export type DynamicStatus =
  /** No environment id, so there is no seam at all. Every build today. */
  | 'disabled'
  /** The flag is set and the SDK chunk has not finished arriving. */
  | 'loading'
  /** The SDK is live and nobody is signed in. */
  | 'signed-out'
  /** Somebody is signed in. `evmAddress` may still be null for a beat. */
  | 'signed-in'

/** What a screen is given. Everything is null until it is genuinely known. */
export interface DynamicSession {
  status: DynamicStatus
  /** Display name of the provider that vouched for this person, e.g. `X`. */
  provider: string | null
  /** The handle that provider knows them by, or their email address. */
  handle: string | null
  /** The embedded Ethereum address created on sign-in. */
  evmAddress: string | null
}

/** The actions the bridge registers once the SDK is live. */
export interface DynamicActions {
  /** Opens Dynamic's own sign-in overlay. */
  openAuthFlow: () => void
  /** Signs `text` with the embedded Ethereum key. Rejects when nothing can sign. */
  signMessage: (text: string) => Promise<string>
  /** Ends the Dynamic session. The Passport passkey is untouched. */
  signOut: () => Promise<void>
}

/**
 * The four providers this slice asks for.
 *
 * `twitter` is X: Dynamic's `ProviderEnum` still carries the pre-rename value
 * and the dashboard still stores it, so the wire name and the name a person
 * reads differ. {@link socialProviderLabel} is the only place that gap lives.
 *
 * This list NARROWS what the dashboard offers; it cannot widen it. A provider
 * that is off in the Dynamic dashboard does not appear because it is named
 * here, and one that is on but missing from this list is filtered out of the
 * overlay. Both halves have to agree, which is why the dashboard settings are
 * written down in `docs/demo/dynamic-integration.md` rather than left to be
 * rediscovered.
 */
export const DYNAMIC_SOCIAL_PROVIDERS = ['google', 'discord', 'microsoft', 'twitter'] as const

export type DynamicSocialProvider = (typeof DYNAMIC_SOCIAL_PROVIDERS)[number]

/**
 * What the "Sign a test message" action signs.
 *
 * Fixed, and fixed on purpose. This slice's only job on the signing question
 * is to produce EVIDENCE for the next one, and the two things the next slice
 * has to establish about this signer — whether the same text signed twice
 * yields the same bytes, and what shape those bytes are — can only be read off
 * repeated signatures of an unchanging pre-image. A message carrying a
 * timestamp or a nonce would make every signature different for a reason that
 * tells us nothing.
 *
 * It is deliberately NOT the envelope the account contract's k256 arm
 * verifies (`midnight_signed_message:32:` || challenge). Dynamic's
 * `signMessage` is EIP-191 `personal_sign`, which hashes with keccak-256, and
 * Compact has no keccak — so a signature over that envelope would not verify
 * and printing one next to the real prefix would be the most misleading thing
 * this screen could do. See `docs/demo/dynamic-evm-capability-audit.md`.
 */
export const DYNAMIC_TEST_MESSAGE = 'Midnight Passport test message'

/** The session every build has today, and the one a screen renders against before anything loads. */
export const DISABLED_SESSION: DynamicSession = {
  status: 'disabled',
  provider: null,
  handle: null,
  evmAddress: null,
}

/**
 * The environment id, or null.
 *
 * Trimmed, because a variable set to whitespace in a deployment dashboard is
 * somebody meaning to unset it, and booting the SDK against `" "` fails later
 * and further away than declining to boot it at all.
 */
export function dynamicEnvironmentId(env: Record<string, unknown> = readViteEnv()): string | null {
  const raw = env.VITE_DYNAMIC_ENVIRONMENT_ID
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Whether this build has a Dynamic seam at all. False in every build shipped today. */
export function isDynamicEnabled(env: Record<string, unknown> = readViteEnv()): boolean {
  return dynamicEnvironmentId(env) !== null
}

/**
 * `import.meta.env` as a plain record.
 *
 * Vite REPLACES `import.meta.env.VITE_…` at build time with a literal, so the
 * property access has to be written out for the substitution to happen. Under
 * vitest the same object exists and carries whatever the test set.
 */
function readViteEnv(): Record<string, unknown> {
  return { VITE_DYNAMIC_ENVIRONMENT_ID: import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID }
}

/** What a person reads. The one place `twitter` becomes `X`. */
export function socialProviderLabel(provider: string): string {
  const key = provider.trim().toLowerCase()
  if (key.length === 0) return 'Unknown'
  if (key === 'twitter' || key === 'x') return 'X'
  if (key === 'emailonly' || key === 'email') return 'Email'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** Shortened for a footer row. Long enough on both ends to compare by eye. */
export function shortEvmAddress(address: string): string {
  if (address.length <= 13) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** The subset of Dynamic's verified credential this app reads. */
export interface DynamicCredentialFields {
  format?: string | null
  /** Present on the embedded wallet's own credential, which is not a social one. */
  address?: string | null
  oauthProvider?: string | null
  oauthUsername?: string | null
  oauthDisplayName?: string | null
  email?: string | null
}

/** The subset of Dynamic's user profile this app reads. */
export interface DynamicUserFields {
  email?: string | null
  username?: string | null
  verifiedCredentials?: DynamicCredentialFields[] | null
}

/**
 * Who is signed in, as two strings.
 *
 * A Dynamic user carries one verified credential per thing they proved, and
 * the embedded wallet is one of them — so the social credential has to be
 * picked out rather than assumed to be first. A signed-in user with no OAuth
 * credential at all (email sign-in, were it ever enabled) still gets a handle,
 * because "signed in as nobody" is a worse thing to render than an address.
 */
export function describeDynamicIdentity(user: DynamicUserFields | null | undefined): {
  provider: string | null
  handle: string | null
} {
  if (!user) return { provider: null, handle: null }

  const credentials = user.verifiedCredentials ?? []
  const social = credentials.find((credential) => nonEmpty(credential.oauthProvider))

  if (social) {
    return {
      provider: socialProviderLabel(social.oauthProvider as string),
      handle:
        nonEmpty(social.oauthUsername) ??
        nonEmpty(social.oauthDisplayName) ??
        nonEmpty(social.email) ??
        nonEmpty(user.email) ??
        nonEmpty(user.username),
    }
  }

  const handle = nonEmpty(user.email) ?? nonEmpty(user.username)
  return { provider: handle ? 'Email' : null, handle }
}

/** A trimmed non-empty string, or null. Blank strings from an API are absences. */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** What the bridge knows at the moment it publishes. */
export interface DynamicBridgeState {
  /** False until the SDK reports itself loaded. */
  sdkHasLoaded: boolean
  user: DynamicUserFields | null | undefined
  /** `primaryWallet.address`, when there is a primary wallet. */
  walletAddress: string | null | undefined
}

/**
 * The bridge's raw view, mapped to the session a screen renders.
 *
 * `signed-in` is decided by the USER, not by the wallet: Dynamic creates the
 * embedded wallet after the auth flow resolves, so a person is signed in for a
 * beat with no address. Reading the wallet as the signal would flip the row
 * back to "signed out" in the middle of a successful sign-in.
 */
export function describeDynamicSession(state: DynamicBridgeState): DynamicSession {
  if (!state.sdkHasLoaded) return { ...DISABLED_SESSION, status: 'loading' }

  const identity = describeDynamicIdentity(state.user)
  if (!state.user) return { ...DISABLED_SESSION, status: 'signed-out' }

  return {
    status: 'signed-in',
    provider: identity.provider,
    handle: identity.handle,
    evmAddress: nonEmpty(state.walletAddress),
  }
}

/* ------------------------------------------------------------------ *
 * The store. Written by the bridge root, read by the app root.
 * ------------------------------------------------------------------ */

let currentSession: DynamicSession = DISABLED_SESSION
let currentActions: DynamicActions | null = null
const listeners = new Set<() => void>()

/** `useSyncExternalStore`'s subscribe half. Returns its own unsubscribe. */
export function subscribeToDynamicSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `useSyncExternalStore`'s snapshot half.
 *
 * Returns the SAME object until something actually changes — see
 * {@link publishDynamicSession}. A fresh object every call is an infinite
 * render loop, not a performance note.
 */
export function readDynamicSession(): DynamicSession {
  return currentSession
}

/** The actions, or null before the bridge has registered them. */
export function readDynamicActions(): DynamicActions | null {
  return currentActions
}

/** Publishes a new session, and notifies only when it differs field by field. */
export function publishDynamicSession(next: DynamicSession): void {
  if (
    currentSession.status === next.status &&
    currentSession.provider === next.provider &&
    currentSession.handle === next.handle &&
    currentSession.evmAddress === next.evmAddress
  ) {
    return
  }
  currentSession = next
  for (const listener of listeners) listener()
}

/** Registers the actions the bridge can perform. Idempotent by design. */
export function publishDynamicActions(actions: DynamicActions | null): void {
  currentActions = actions
}

/**
 * Returns the store to the state a fresh page load has.
 *
 * Exists for the tests, and named so that reading a call site makes that
 * obvious. Nothing in the app calls it.
 */
export function resetDynamicSessionStoreForTests(): void {
  currentSession = DISABLED_SESSION
  currentActions = null
  listeners.clear()
}
