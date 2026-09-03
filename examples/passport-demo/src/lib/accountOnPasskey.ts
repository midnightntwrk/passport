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
 * AND THE OTHER DIRECTION (2026/09/03)
 * ------------------------------------
 * A blob is only worth writing if reading it back is worth something, and it
 * was not: a device with no records of its own read the account off the passkey,
 * asked the indexer once, and — on anything short of a straight yes — kept
 * NOTHING. Not the account, not the name. The person was then shown "Choose
 * your .night name" over a Passport that already had one, where claiming again
 * would deploy a second account. `accountFromBlob` below is the rule for what
 * that read is worth, and its answer is that a blob is evidence: held, acted
 * on, and re-checked, rather than discarded because one HTTP call went wrong.
 *
 * This module is the RULE and nothing else: no storage, no WebAuthn, no clock.
 * It is in the coverage denominator because every way it can be wrong is a way
 * of prompting somebody who asked for nothing, of never writing at all, or of
 * losing an account that is sitting on the chain waiting to be found.
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

/* -------------------------------------------------------------------------- */
/* The other direction: what a blob READ off a passkey is worth              */
/* -------------------------------------------------------------------------- */

/**
 * What this browser already knows about the account, for the rule below. `null`
 * where it holds nothing — a device signing in for the first time, or one whose
 * site data has been cleared, which is the case this whole path exists for.
 */
export interface AccountOnPasskeyLocal {
  /** The address of the contract record held for this credential and network. */
  address?: string;
}

/** Everything the recovery rule reads besides the blob itself. */
export interface AccountFromBlobContext {
  /**
   * The network the open wallet reads. A blob for any other network cannot be
   * checked at all: the only indexer this session holds is the wallet's.
   */
  walletNetwork: string | null;
  /** The record this browser holds for this credential on the blob's network. */
  localRecord: AccountOnPasskeyLocal | null;
  /**
   * True when this browser already holds an alias record for that network. A
   * name it observed being registered always outranks a name read off a
   * passkey, so the blob's alias is dropped rather than written over it.
   */
  hasLocalAlias: boolean;
}

/** Whether the chain has been asked, and answered, for the blob's address. */
export type AccountBlobConfirmation = 'confirmed' | 'unconfirmed';

/** The account a blob names, in the form the app persists it. */
export interface AccountFromBlobAccount {
  address: string;
  network: string;
  /** The `.night` name to restore, and absent when there is nothing to restore. */
  alias?: string;
}

/**
 * What to do about a blob read off a passkey.
 *
 * `adopt-checking` and `adopt-confirmed` carry the SAME account: the difference
 * is only whether the chain has answered for it yet, and therefore whether the
 * app may write a contract record or must keep looking.
 */
export type AccountFromBlobDecision =
  /** Nothing to act on: no blob, or one for a network this session cannot read. */
  | { kind: 'nothing' }
  /** This device already holds the account the blob names. Nothing to do. */
  | { kind: 'keep-local' }
  /** This device holds a DIFFERENT account. The witnessed record wins. */
  | { kind: 'conflict'; local: string; blob: string }
  /** The chain answered for it: record it as recovered. */
  | { kind: 'adopt-confirmed'; account: AccountFromBlobAccount }
  /** Not answered for yet: hold it as the Passport's account and keep asking. */
  | { kind: 'adopt-checking'; account: AccountFromBlobAccount };

/**
 * THE RE-LOGIN RULE, and the dead end it replaces (2026/09/03).
 *
 * A passkey that comes back to a browser holding nothing carries, in its
 * largeBlob, the address of the account it was claimed for and the name
 * registered against it. What the app did with that was: one indexer read, and
 * if that read did not answer `true` — an indexer blip, a node behind, a
 * network hiccup, any of which is a Tuesday — NOTHING was written at all. No
 * record, no name, no note. The user was then dropped on "Choose your .night
 * name" over an account that already existed and already had one, and claiming
 * from there would have deployed a SECOND account and paid for a SECOND name.
 * The only trace was one line in the activity trail saying the Passport was not
 * restored, which is not a thing anybody looking at a name step goes to read.
 *
 * The blob is evidence and it is kept as evidence. `adopt-checking` is the
 * answer to "the chain has not said yes YET": the account and its name are held
 * on the profile and the name is restored, so the person lands on their own
 * Passport rather than on a naming ceremony, and the app goes on asking. Only
 * `adopt-confirmed` writes a contract record, because a record is a claim that
 * this device has seen the account on chain, and until the read-back answers,
 * it has not.
 *
 * WHAT IT REFUSES TO DO. It never overrules this device's own witness: a record
 * here for a different address is a `conflict`, and the record stays. It never
 * touches a name this browser watched being registered. And it never adopts a
 * blob for a network the open wallet cannot read, because "we cannot check" and
 * "it is not there" would be indistinguishable and one of them is a lie.
 */
export function accountFromBlob(
  blob: PassportAccountBlob | null,
  context: AccountFromBlobContext,
  confirmation: AccountBlobConfirmation,
): AccountFromBlobDecision {
  if (!blob) return { kind: 'nothing' };
  if (!context.walletNetwork || context.walletNetwork !== blob.acc.network) {
    return { kind: 'nothing' };
  }
  const local = context.localRecord?.address;
  if (local) {
    return local === blob.acc.address
      ? { kind: 'keep-local' }
      : { kind: 'conflict', local, blob: blob.acc.address };
  }
  const account: AccountFromBlobAccount = {
    address: blob.acc.address,
    network: blob.acc.network,
    /* The name is restored only where this browser has none of its own. A
       record it watched being registered is a better answer than a blob. */
    ...(blob.alias && !context.hasLocalAlias ? { alias: blob.alias } : {}),
  };
  return confirmation === 'confirmed'
    ? { kind: 'adopt-confirmed', account }
    : { kind: 'adopt-checking', account };
}

/**
 * The alias record a recovered account restores, or `null` when the blob named
 * no name to restore.
 *
 * `registryConfirmed: false` is the whole of the honesty here. The name is on
 * chain — that is what a claim means, and the resolver it points at is the
 * account this record was read beside — but THIS browser has not watched the
 * registry answer for it, and a record that said otherwise would be inventing a
 * check nobody ran. `resolverTarget: 'contract'` is not a guess either: a blob
 * is only ever written for an account-custody contract.
 */
export function aliasFromRecoveredAccount(
  account: AccountFromBlobAccount,
  now: string,
): RecoveredAliasRecord | null {
  if (!account.alias) return null;
  return {
    alias: account.alias,
    domain: `${account.alias}.night`,
    network: account.network,
    status: 'registered',
    registryConfirmed: false,
    resolverTarget: 'contract',
    resolverTargetHex: account.address,
    updatedAt: now,
  };
}

/**
 * The shape {@link aliasFromRecoveredAccount} produces — structurally the
 * `AliasRecord` of `src/identity/aliasStore.ts`, written out here so this
 * module keeps its promise of importing nothing but the blob's own types.
 */
export interface RecoveredAliasRecord {
  alias: string;
  domain: string;
  network: string;
  status: 'registered';
  registryConfirmed: false;
  resolverTarget: 'contract';
  resolverTargetHex: string;
  updatedAt: string;
}

/**
 * How long to wait before asking the chain again, and when to stop asking.
 *
 * `null` ends it. Everything about this is a statement about what a person is
 * willing to sit in front of: five attempts over about a minute, doubling, so a
 * node a few blocks behind is caught without a Passport that spends the rest of
 * the session polling an address that does not exist. When it ends, the app owes
 * the user a way out — a retry they choose, or setting up a new account — and
 * never a silent nothing, which is what the single unretried read left behind.
 */
export function accountRecheckDelayMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= ACCOUNT_RECHECK_ATTEMPTS) return null;
  return 2_000 * 2 ** attempt;
}

/** How many times the chain is asked before the user is asked instead. */
export const ACCOUNT_RECHECK_ATTEMPTS = 5;
