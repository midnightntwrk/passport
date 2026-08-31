/**
 * WHEN THE ACCOUNT GETS WRITTEN ONTO THE PASSKEY — and, more to the point,
 * when it does NOT cost a ceremony.
 *
 * THE BUG THIS MODULE EXISTS TO CLOSE (2026/08/31)
 * -----------------------------------------------
 * A `.night` claim ends by attaching the account-custody contract's address to
 * the passkey itself, under the WebAuthn largeBlob extension, so a device that
 * has never seen this Passport can still find the account. That write used to
 * be fired at the end of the claim, fire-and-forget, on the reasoning that it
 * would ride the gesture that earned the claim's own passkey prompt.
 *
 * It did not ride anything. A claim is minutes of chain work, so by the time
 * the write ran the gesture was long gone — and a largeBlob write may not be
 * paired with the read every other assertion makes, so it was a second, whole,
 * user-verified assertion. What the product owner saw, repeatedly, was a
 * finished Home screen — name registered, account deployed, balances on
 * screen — with a macOS passkey prompt on top of it that they had pressed
 * nothing to summon. Reaching Home must cost ZERO ceremonies.
 *
 * WHAT REPLACES IT
 * ----------------
 * The claim only REMEMBERS what it would have written. The bytes go onto the
 * passkey during the next assertion the user asks for anyway — the sign-in —
 * where the largeBlob slice is free and the read it displaces was worthless:
 * a browser holding a deployed record has nothing to recover. So the write
 * costs no prompt, ever, on any path.
 *
 * NOTHING HERE HOLDS A SECRET. The note is an address, a network, and a name,
 * all of them public and all of them already on a ledger. No key material goes
 * onto a passkey and none is retained by this module — see
 * `demo-backend/src/passkey.ts#PassportAccountBlob`.
 *
 * This module is the RULE and nothing else: no storage, no WebAuthn, no clock.
 * It is in the coverage denominator because every way it can be wrong is a way
 * of prompting somebody who asked for nothing, or of never writing at all.
 */

import type {
  PassportAccountBlob,
  PassportAccountBlobWriteOutcome,
} from '../backend.js';

/**
 * What a profile remembers about its account and the passkey: the account a
 * claim bound to this Passport, and whether it has reached the credential yet.
 */
export interface PassportAccountOnPasskey {
  /** Raw 64-hex account-custody contract address. */
  address: string;
  /** The network it was deployed on. */
  network: string;
  /** The `.night` name registered against it, when there is one. */
  alias?: string;
  /** True once an authenticator has reported the blob stored. */
  written: boolean;
}

/** The slice of a profile this rule reads. */
export interface AccountOnPasskeyProfile {
  /**
   * What the platform said about largeBlob for this credential. `false` is the
   * one answer that stops the offer for good: a credential that cannot hold a
   * blob will not start to.
   */
  largeBlobSupported?: boolean;
  accountOnPasskey?: PassportAccountOnPasskey;
}

/** The fields a settled write asks a caller to persist. */
export interface AccountOnPasskeyPatch {
  accountOnPasskey?: PassportAccountOnPasskey;
  largeBlobSupported?: boolean;
}

/**
 * What to remember when a claim binds an account to this Passport — or `null`
 * when the profile already says exactly this and there is nothing to write.
 *
 * The alias is part of the identity of the note, not decoration: a second name
 * over the same account makes the blob already on the credential stale, so the
 * note goes back to unwritten and the next assertion carries the new one.
 */
export function accountToRemember(
  profile: AccountOnPasskeyProfile,
  account: { address: string; network: string },
  alias?: string,
): PassportAccountOnPasskey | null {
  const current = profile.accountOnPasskey;
  if (
    current &&
    current.address === account.address &&
    current.network === account.network &&
    current.alias === alias
  ) {
    return null;
  }
  return {
    address: account.address,
    network: account.network,
    ...(alias ? { alias } : {}),
    written: false,
  };
}

/**
 * The blob the next targeted assertion should CARRY, or `null` when it should
 * read as it always has.
 *
 * Three ways to owe nothing: this Passport has no account note yet, the note
 * has already reached the credential, or the platform has told us this
 * credential cannot hold a blob at all. In every one of them the assertion
 * keeps its read — which is what a device with no record of its own account
 * needs to recover one.
 */
export function pendingAccountBlob(
  profile: AccountOnPasskeyProfile | null | undefined,
): PassportAccountBlob | null {
  const note = profile?.accountOnPasskey;
  if (!note || note.written) return null;
  if (profile?.largeBlobSupported === false) return null;
  return {
    v: 1,
    acc: { address: note.address, network: note.network },
    ...(note.alias ? { alias: note.alias } : {}),
  };
}

/**
 * What to persist after an assertion that carried a write — or `null` when
 * there is nothing to learn from it.
 *
 * `'refused'` deliberately records NOTHING. The extension is there and the
 * write did not land, which the next assertion may well fix; writing that down
 * as a permanent answer would retire a capability over one bad attempt.
 */
export function settledAccountOnPasskey(
  profile: AccountOnPasskeyProfile,
  outcome: PassportAccountBlobWriteOutcome | null,
): AccountOnPasskeyPatch | null {
  const note = profile.accountOnPasskey;
  if (!outcome || !note) return null;
  if (outcome === 'written') {
    return {
      accountOnPasskey: { ...note, written: true },
      // Proved by the write itself, whatever enrolment reported.
      largeBlobSupported: true,
    };
  }
  if (outcome === 'unsupported') return { largeBlobSupported: false };
  return null;
}
