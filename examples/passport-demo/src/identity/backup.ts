/**
 * Private-state backup — ONE encrypted blob, a password, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN THE FILE, AND WHY EACH THING IS OR IS NOT
 * ---------------------------------------------------------------------------
 * The rule this module is built around: a backup carries STATE, never KEYS.
 *
 *   INCLUDED — the per-credential records this browser holds that cannot be
 *   re-derived from anything else, because they record events that happened
 *   once and were never written down anywhere the app can read back:
 *
 *     - alias claims          (`./aliasStore.js`) — which name was claimed on
 *                             which network, and the two transaction ids that
 *                             prove it. The registry knows the name; it does
 *                             not know that THIS browser claimed it.
 *     - passport contracts    (`./passportContractStore.js`) — the account-
 *                             custody contract address and deployment
 *                             transaction, per credential and network.
 *     - redeemed incentives   (`./incentiveStore.js`) — what apps reported back
 *                             to Passport. Nothing else holds this list.
 *
 *   EXCLUDED — the wallet SYNC SNAPSHOT (`../lib/walletSnapshot.js`). It is a
 *   verbatim SDK serialisation of a chain walk, and a chain walk is exactly the
 *   thing a fresh device can redo from the indexer. Backing it up would grow
 *   the file by the size of the ledger state for no recovery value, and a
 *   stale snapshot restored over a live wallet is worse than no snapshot at
 *   all. It is re-derivable; it stays out.
 *
 *   EXCLUDED, AND STRUCTURALLY IMPOSSIBLE TO INCLUDE — the wallet SEED and the
 *   private-state encryption key. Both derive from the passkey's WebAuthn PRF
 *   output (see `demo-backend/src/passkey.ts`), so they are not the app's to
 *   copy: on a device holding the passkey they are one assertion away, and on
 *   a device without it a backup file must not be the thing that hands them
 *   over. This is the hard invariant — no private key in the backup — and it
 *   is enforced by SHAPE, not by discipline: {@link collectPassportBackup}
 *   takes NO arguments and reads a fixed, typed allow-list of three stores, so
 *   there is no parameter through which a caller could pass key material in.
 *   {@link assertNoKeyMaterial} is the belt to that braces, and runs on both
 *   the export and the import path. It is STRUCTURAL: it walks the payload
 *   against the field lists of the three record types and refuses any field
 *   that is not one of them, rather than pattern-matching names that read as
 *   secrets. A blocklist can only refuse the names someone thought of —
 *   `privKey`, `sk`, `xprv`, and `signing_key` all slip past a list built from
 *   `privatekey` and `signingkey` — whereas an allow-list refuses everything
 *   nobody has justified. The name blocklist survives only to make the refusal
 *   message sharper, and unexpected VALUES are inspected too, because a secret
 *   smuggled in under an innocent name is still 32 or 64 bytes of hex.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RESTORE REFUSES TO BELIEVE
 * ---------------------------------------------------------------------------
 * A backup file is a CLAIM, and on a fresh device it is an unverifiable one.
 * Three fields in it are therefore never taken at face value, because each is
 * this app's own word for "the chain agreed" and a file has not seen a chain:
 *
 *   - `ledgerConfirmed` on a contract record is forced to `false` on the way
 *     in. The caller re-reads the indexer afterwards (see
 *     {@link PassportBackupLedgerCheck}) and only that read may set it;
 *   - `registryConfirmed` on an alias record is forced to `false` the same way,
 *     and {@link confirmRestoredAliases} re-resolves the name through the
 *     registry before it may become true. Until it does, the identity is shown
 *     as awaiting the registry — a restored file may not put a confirmed name
 *     on Home;
 *   - `recovered` on a contract record is refused outright. That flag means
 *     "this device read the address out of the passkey's own largeBlob and the
 *     indexer answered for it", which is a statement about a device, not a
 *     record to be copied. A restore leaves it to the passkey to re-seed.
 *
 * Field SHAPES are checked too — a contract address must be 64 hex characters,
 * a transaction id 64 or 66 — so a fabricated address cannot ride in on a
 * fabricated timestamp. And a record this browser holds that the chain HAS
 * confirmed is never overwritten by a file, however new the file claims to be.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMITS OF THIS BACKUP
 * ---------------------------------------------------------------------------
 * Lose the password and the file is gone: it is never stored, never escrowed,
 * never recoverable, and no part of Passport ever sees it. The file also does
 * not contain the passkey and cannot. Restoring it onto a device with no
 * access to the passkey gives a readable history of what this Passport did and
 * no ability to act as it. That is the whole trade, stated plainly.
 *
 * ---------------------------------------------------------------------------
 * CRYPTO, AND WHY THESE PARAMETERS
 * ---------------------------------------------------------------------------
 * KDF: PBKDF2-SHA-256, 600,000 iterations, 16 random bytes of salt.
 *
 *   PBKDF2 is chosen because it is the ONLY password-based KDF WebCrypto
 *   offers — `crypto.subtle` has no scrypt and no Argon2id. Shipping either
 *   would mean bundling a JavaScript or WASM implementation into the demo, and
 *   an unaudited KDF we vendored ourselves is a worse answer for a demo than a
 *   standard one the platform already implements. 600,000 iterations is
 *   OWASP's current recommendation for PBKDF2-SHA-256.
 *
 *   Being honest about what that costs: PBKDF2 is memory-cheap, so a GPU or
 *   ASIC attacker grinds candidate passwords far faster than Argon2id would
 *   permit. The strength of this backup is therefore the strength of the
 *   PASSPHRASE, not of the KDF. This is demo-grade: a production Passport
 *   should move to Argon2id, and the {@link PassportBackupEnvelope.kdf}
 *   descriptor is versioned precisely so a future reader can tell the two
 *   apart and still refuse — loudly — to guess at a file it cannot open.
 *
 *   The descriptor is PARSED, not compared. `PBKDF2-<hash>-<iterations>` is a
 *   family, and a reader that recognised only the one literal string this
 *   build happens to write would orphan every file it had already written the
 *   day OWASP's recommendation moved and `PBKDF2_ITERATIONS` moved with it.
 *   So the reader takes the hash and the iteration count OUT of the file, runs
 *   the KDF the file asks for within a sane floor and ceiling
 *   ({@link PBKDF2_MIN_ITERATIONS}, {@link PBKDF2_MAX_ITERATIONS}), and keeps
 *   `unsupported-kdf` for a family it genuinely cannot run. The count is safe
 *   to take from the file precisely because the descriptor is authenticated —
 *   see the cipher note below — so nobody can weaken it in transit; a rewritten
 *   count derives a different key AND fails the tag.
 *
 * Cipher: AES-256-GCM with a fresh 12-byte nonce per export (the size GCM is
 * specified for; a longer nonce is hashed down and buys nothing). The envelope
 * header — version and KDF descriptor — is fed in as additional authenticated
 * data, so an attacker cannot rewrite the iteration count or the version and
 * still have the ciphertext authenticate.
 *
 * Envelope, base64url-encoded fields in a JSON object:
 *
 *     { "v": 1, "kdf": "PBKDF2-SHA-256-600000",
 *       "salt": "...16 bytes...", "nonce": "...12 bytes...", "ciphertext": "..." }
 *
 * Those lengths are ENFORCED, not merely documented, and before any key is
 * derived. An empty or wrong-length salt or nonce is a structural fact about
 * the file, and reporting it as `wrong-password-or-tampered` would tell a user
 * their password was wrong about a file that was never a backup. It is
 * `not-a-backup`, and it says which field and by how much.
 *
 * Nothing else is in the file. In particular the creation timestamp lives
 * INSIDE the ciphertext, so an envelope on disk leaks only its own parameters.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE FILE GOES — THE BACKEND SEAM
 * ---------------------------------------------------------------------------
 * v1 ships exactly one backend: {@link fileBackupBackend}, the browser's own
 * download and file-picker path. It needs no account, no OAuth client, and no
 * server, so it works today for every user of the demo.
 *
 * A Google Drive backend is the intended second one and drops in behind
 * {@link selectBackupBackend} by implementing the same three members —
 * `isAvailable`, `write`, `read`. It is deliberately NOT built here: the demo
 * has no Google OAuth client id, and a half-wired Drive button that cannot
 * authenticate is the kind of pretend this demo does not ship.
 * `selectBackupBackend('google-drive')` therefore fails with that sentence
 * rather than silently falling back to a file download nobody asked for.
 */

import type { AliasRecord } from './aliasStore.js';
import type { PassportContractRecord } from './passportContractStore.js';
import type { PassportIncentiveRecord } from './incentiveStore.js';

/** Bump when the shape of {@link PassportBackupContents} itself changes. */
export const PASSPORT_BACKUP_VERSION = 1;

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
/** AES-GCM's tag, appended to the ciphertext. A shorter field cannot be one. */
const GCM_TAG_BYTES = 16;

/**
 * The iteration counts this build will run for a file that asks.
 *
 * The floor is not a guess at what is strong enough today — it is the point
 * below which a file is not worth the pretence of being password-protected,
 * and a build that ran an attacker-chosen count of 1 would be doing exactly
 * that. The ceiling stops a hostile file from wedging the tab for an hour.
 * Both are deliberately wide: the count a genuine Passport wrote must survive
 * every future move of {@link PBKDF2_ITERATIONS} in either direction.
 */
const PBKDF2_MIN_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 10_000_000;

/** The hashes {@link deriveBackupKey} will run. WebCrypto guarantees both. */
const PBKDF2_HASHES = ['SHA-256', 'SHA-512'] as const;

/** The KDF descriptor written into — and authenticated by — every envelope. */
export const PASSPORT_BACKUP_KDF = `PBKDF2-${PBKDF2_HASH}-${PBKDF2_ITERATIONS}`;

export type PassportBackupErrorCode =
  /** The bytes are not a Passport backup envelope at all. */
  | 'not-a-backup'
  /**
   * The file was sealed, but the place it was going did not take it — the user
   * cancelled the save dialog, or the browser refused the write. Distinct from
   * everything else here because nothing is wrong with the backup; it simply
   * does not exist yet, and the screen must not say it does.
   */
  | 'backup-not-written'
  /** A real envelope, written by a newer Passport than this one. */
  | 'unsupported-version'
  /** A real envelope, sealed with a KDF this build does not implement. */
  | 'unsupported-kdf'
  /**
   * GCM refused the tag. Authenticated encryption cannot tell a wrong password
   * from a tampered file — both land here, and the message says so rather than
   * guessing which happened.
   */
  | 'wrong-password-or-tampered'
  /** The plaintext decrypted but is not the shape a backup must have. */
  | 'corrupt-contents'
  /** A guard refused: the payload held something that is not state. */
  | 'key-material-present';

export class PassportBackupError extends Error {
  constructor(
    readonly code: PassportBackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PassportBackupError';
  }
}

/**
 * The sealed file, exactly as it is written to disk.
 *
 * `v` and `kdf` are plaintext because a reader needs them BEFORE it can
 * decrypt anything; they are covered by the GCM tag as additional data, so
 * they can be read but not rewritten.
 */
export interface PassportBackupEnvelope {
  v: number;
  kdf: string;
  /** base64url, {@link SALT_BYTES} bytes. */
  salt: string;
  /** base64url, {@link NONCE_BYTES} bytes. */
  nonce: string;
  /** base64url AES-256-GCM ciphertext with its appended tag. */
  ciphertext: string;
}

/**
 * The plaintext payload — the typed allow-list, and the ONLY shape this module
 * will encrypt. Adding a field here is a deliberate act with this file's header
 * as its review checklist; there is no escape hatch that accepts arbitrary
 * data.
 */
export interface PassportBackupContents {
  version: number;
  /** ISO-8601. Inside the ciphertext on purpose — see the header. */
  createdAt: string;
  /** Alias claims, keyed by network. Verbatim `loadAliasRecords()`. */
  aliases: Record<string, AliasRecord>;
  /** Contract records, keyed by `credentialId::network`. */
  passportContracts: Record<string, PassportContractRecord>;
  /** Redeemed incentives, newest first. */
  incentives: PassportIncentiveRecord[];
}

/** What a restore actually did, per store, in numbers the screen can show. */
export interface PassportBackupStoreSummary {
  /** Records the file carried. */
  found: number;
  /** Records written into this browser. */
  restored: number;
  /**
   * Records deliberately not written, each with its reason — a newer local
   * record, or a record the store itself refused as malformed. Never a silent
   * drop.
   */
  skipped: { key: string; reason: string }[];
  /**
   * The store keys actually written, so a caller can go back and check what a
   * restore put there. `restoredKeys.length === restored` always; the count is
   * kept because the screen shows a count and the keys are the caller's
   * business.
   */
  restoredKeys: string[];
}

/**
 * What became of the promise that a restored contract is checked against the
 * chain.
 *
 * A restored contract record is a claim made by a FILE. The address in it was
 * true when the backup was taken; nothing in the file proves the contract is
 * there now, and a browser that has just imported one has seen no chain at
 * all. So the check is a real indexer read, and this is its result — including
 * the case where it could not run, which is stated rather than glossed.
 *
 * Deliberately optional on {@link PassportBackupSummary}: this module has no
 * wallet and no indexer, so it cannot fill it in. The caller that holds the
 * open wallet does, and a summary that reaches a screen without one must be
 * rendered as "not re-checked" — never as confirmation.
 */
export type PassportBackupLedgerCheck =
  | { ran: false; reason: string }
  | {
      ran: true;
      /** The network the open wallet reads, and the only one checkable here. */
      network: string;
      /** Records the indexer answered for. */
      confirmed: number;
      /** Records it did not — downgraded, not deleted. See the caller. */
      unconfirmed: number;
      /** Records belonging to some other network, left untouched. */
      otherNetworks: number;
    };

/**
 * What became of the same promise for a restored NAME.
 *
 * A restored alias record is the same kind of claim a restored contract record
 * is — the file says this browser once claimed `alice.night`, and nothing in
 * the file proves the registry still points that name here, or ever did. So it
 * gets the same treatment: {@link applyPassportBackup} writes every restored
 * name as `registryConfirmed: false`, and only {@link confirmRestoredAliases}
 * re-resolving the name through the registry may set it true.
 *
 * Unlike the ledger check this one needs no wallet — an alias record carries
 * the network it was claimed on, and `./midnames.ts` knows that network's
 * indexer — so {@link importPassportBackup} runs it itself and the summary
 * always carries the result.
 */
export type PassportBackupRegistryCheck =
  | { ran: false; reason: string }
  | {
      ran: true;
      /** Names the registry answered for, with the resolver pointing at a contract. */
      confirmed: number;
      /** Names it did not — left as records awaiting the registry, never deleted. */
      unconfirmed: number;
      /** Names claimed on a network `./midnames.ts` does not read. */
      otherNetworks: number;
    };

export interface PassportBackupSummary {
  /** When the backup was taken, read from inside the ciphertext. */
  createdAt: string;
  aliases: PassportBackupStoreSummary;
  passportContracts: PassportBackupStoreSummary;
  incentives: PassportBackupStoreSummary;
  /** See {@link PassportBackupLedgerCheck}. Absent means "not re-checked". */
  ledgerCheck?: PassportBackupLedgerCheck;
  /** See {@link PassportBackupRegistryCheck}. Absent means "not re-checked". */
  registryCheck?: PassportBackupRegistryCheck;
}

/* --- base64url ------------------------------------------------------------ */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string, field: string): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    throw new PassportBackupError(
      'not-a-backup',
      `This file's ${field} is not base64url, so it is not a Passport backup.`,
    );
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new PassportBackupError(
      'not-a-backup',
      `This file's ${field} could not be decoded, so it is not a Passport backup.`,
    );
  }
}

/** Web Crypto's typings want an ArrayBuffer-backed view, not a subarray. */
function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Decodes one envelope field and checks its LENGTH, before any key is derived.
 *
 * The lengths in this module's header are part of the format, so a field that
 * does not have one is a structural fact about the file — `not-a-backup` —
 * and never the `wrong-password-or-tampered` that an empty nonce would
 * otherwise become when `subtle.decrypt` threw its `OperationError`. Telling a
 * user their password is wrong for a file that was never a backup sends them
 * to look for a password that would not have helped.
 *
 * `expected` is null for the ciphertext, whose length is not fixed; it must
 * still be longer than the GCM tag it ends with.
 */
function decodeEnvelopeField(value: string, field: string, expected: number | null): Uint8Array {
  if (value.length === 0) {
    throw new PassportBackupError(
      'not-a-backup',
      `This file's ${field} is empty, so it is not a Passport backup.`,
    );
  }
  const bytes = fromBase64Url(value, field);
  if (expected === null) {
    if (bytes.length <= GCM_TAG_BYTES) {
      throw new PassportBackupError(
        'not-a-backup',
        `This file's ${field} is ${bytes.length} bytes — too few to hold even the authentication tag — so it is not a Passport backup.`,
      );
    }
  } else if (bytes.length !== expected) {
    throw new PassportBackupError(
      'not-a-backup',
      `This file's ${field} is ${bytes.length} bytes; a Passport backup's ${field} is ${expected}. That is a structural mismatch, not a wrong password.`,
    );
  }
  return bytes;
}

/** The three decoded fields, each already length-checked. */
function decodeEnvelopeBytes(envelope: PassportBackupEnvelope): {
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  return {
    salt: decodeEnvelopeField(envelope.salt, 'salt', SALT_BYTES),
    nonce: decodeEnvelopeField(envelope.nonce, 'nonce', NONCE_BYTES),
    ciphertext: decodeEnvelopeField(envelope.ciphertext, 'ciphertext', null),
  };
}

/* --- the KDF descriptor --------------------------------------------------- */

/** A descriptor read back out of a file, ready to run. */
interface BackupKdfParameters {
  hash: (typeof PBKDF2_HASHES)[number];
  iterations: number;
}

const KDF_DESCRIPTOR = /^PBKDF2-(SHA-\d{3})-(\d{1,9})$/;

/**
 * Reads `PBKDF2-<hash>-<iterations>` as parameters, or explains what stopped it.
 *
 * See the header: a reader that recognised one literal string would refuse
 * every file it wrote itself the day the iteration count changed. What is
 * refused here is a family this build cannot run, or a count outside the range
 * it is willing to run — never a count that merely differs from today's.
 */
function parseKdfDescriptor(descriptor: string): BackupKdfParameters {
  const match = KDF_DESCRIPTOR.exec(descriptor);
  if (!match) {
    throw new PassportBackupError(
      'unsupported-kdf',
      `This backup was sealed with "${descriptor}"; this Passport implements the PBKDF2-<hash>-<iterations> family and could not read that as one of them.`,
    );
  }
  const [, hash, count] = match as unknown as [string, string, string];
  if (!(PBKDF2_HASHES as readonly string[]).includes(hash)) {
    throw new PassportBackupError(
      'unsupported-kdf',
      `This backup was sealed with PBKDF2 over ${hash}; this Passport runs ${PBKDF2_HASHES.join(' and ')}.`,
    );
  }
  const iterations = Number.parseInt(count, 10);
  if (iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new PassportBackupError(
      'unsupported-kdf',
      `This backup asks for ${iterations} PBKDF2 iterations; this Passport runs between ${PBKDF2_MIN_ITERATIONS} and ${PBKDF2_MAX_ITERATIONS}.`,
    );
  }
  return { hash: hash as BackupKdfParameters['hash'], iterations };
}

/* --- the allow-list guard ------------------------------------------------- */

/**
 * Property names that read as key material.
 *
 * NOT the mechanism, and no longer the check either — the check is the field
 * allow-lists below, which refuse everything they do not recognise. This list
 * survives for one job: when an unexpected field IS a secret, saying so is
 * more useful to whoever added it than "that is not a field a backup carries".
 */
const FORBIDDEN_KEYS = [
  'seed',
  'secret',
  'privatekey',
  'private_key',
  'mnemonic',
  'passphrase',
  'prf',
  'password',
  'signingkey',
  'privkey',
  'signing_key',
  'entropy',
  'xprv',
  'viewingkey',
  'viewing_key',
];

/**
 * Every field each of the three record types may carry, and the payload's own.
 *
 * These ARE the shapes in `./aliasStore.ts`, `./passportContractStore.ts`, and
 * `./incentiveStore.ts`. Adding a field to one of those types without adding it
 * here makes the first export fail loudly — which is the intended cost, and
 * the whole reason this is an allow-list: the record types are fixed and known,
 * so anything else in a payload arrived by accident or by design, and neither
 * belongs in a file the user will keep.
 */
const BACKUP_FIELDS = ['version', 'createdAt', 'aliases', 'passportContracts', 'incentives'];
const ALIAS_FIELDS = [
  'alias',
  'domain',
  'network',
  'status',
  'resolverAddress',
  'resolverDeployTxId',
  'registerTxId',
  'queuedReason',
  'registryConfirmed',
  'resolverTarget',
  'resolverTargetHex',
  'updatedAt',
];
const CONTRACT_FIELDS = [
  'credentialId',
  'network',
  'status',
  'address',
  'deployTxId',
  'txIdResolved',
  'deviceCommitment',
  'ledgerConfirmed',
  'feePaidBy',
  'failureReason',
  'recovered',
  'updatedAt',
];
const INCENTIVE_FIELDS = ['id', 'app', 'label', 'txId', 'network', 'redeemedAt'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is the SIZE of a key — 32 or 64 bytes of hex or base64.
 *
 * Names can be innocent; sizes are harder to disguise. This only ever runs on
 * a field that is already being refused, and only decides how the refusal is
 * worded, so a false positive costs nothing and a true one names the problem.
 */
function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^[0-9a-f]{64}$/i.test(value) || /^[0-9a-f]{128}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const bytes = Math.floor((value.replace(/=+$/, '').length * 3) / 4);
  return bytes === 32 || bytes === 64;
}

function refuseField(path: string, key: string, value: unknown): never {
  const lowered = key.toLowerCase();
  if (FORBIDDEN_KEYS.some((forbidden) => lowered.includes(forbidden))) {
    throw new PassportBackupError(
      'key-material-present',
      `A Passport backup carries state, never keys, and "${path}.${key}" reads as key material. Refusing to continue.`,
    );
  }
  if (looksLikeSecret(value)) {
    throw new PassportBackupError(
      'key-material-present',
      `A Passport backup carries state, never keys, and "${path}.${key}" is not a field a backup carries — and its value is the size of one. Refusing to continue.`,
    );
  }
  throw new PassportBackupError(
    'key-material-present',
    `A Passport backup carries state, never keys, and "${path}.${key}" is not a field a Passport backup carries. Refusing to continue.`,
  );
}

/** One record, checked field by field against the shape it claims to be. */
function assertRecordFields(value: unknown, allowed: string[], path: string): void {
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (!allowed.includes(key)) refuseField(path, key, nested);
    if (nested !== null && typeof nested === 'object') {
      throw new PassportBackupError(
        'key-material-present',
        `A Passport backup carries state, never keys, and "${path}.${key}" holds a nested object where a plain value belongs. Refusing to continue.`,
      );
    }
  }
}

function assertRecordMap(value: unknown, allowed: string[], path: string): void {
  if (!isPlainObject(value)) return;
  for (const [key, record] of Object.entries(value)) {
    assertRecordFields(record, allowed, `${path}.${key}`);
  }
}

/**
 * Checks a payload against the fixed shapes a backup is made of, and throws on
 * anything else.
 *
 * Runs on export (before anything is encrypted) AND on import (before anything
 * is written), because a file handed to us is not a file we wrote. Structural
 * validity of the CONTAINERS is a different question with a different answer —
 * see {@link assertBackupRecordContainers} — so a value this cannot walk is
 * left for that check rather than reported as key material.
 */
export function assertNoKeyMaterial(value: unknown, path = 'backup'): void {
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (!BACKUP_FIELDS.includes(key)) refuseField(path, key, nested);
  }
  assertRecordMap(value.aliases, ALIAS_FIELDS, `${path}.aliases`);
  assertRecordMap(value.passportContracts, CONTRACT_FIELDS, `${path}.passportContracts`);
  if (Array.isArray(value.incentives)) {
    value.incentives.forEach((entry, index) =>
      assertRecordFields(entry, INCENTIVE_FIELDS, `${path}.incentives[${index}]`),
    );
  }
}

/**
 * Refuses a payload whose record CONTAINERS are not what they claim to be —
 * an `aliases` that is an array, a `passportContracts` entry that is null.
 *
 * Separate from {@link assertNoKeyMaterial} because it answers a different
 * question and carries a different code: this is a corrupt file, not a
 * dangerous one. It runs BEFORE the restore loops dereference anything, so a
 * hand-edited file fails with the sentence this module promises instead of a
 * TypeError thrown halfway through a partial restore.
 */
export function assertBackupRecordContainers(contents: PassportBackupContents): void {
  const containers: [string, unknown][] = [
    ['aliases', contents.aliases],
    ['passportContracts', contents.passportContracts],
  ];
  for (const [name, container] of containers) {
    if (!isPlainObject(container)) {
      throw new PassportBackupError(
        'corrupt-contents',
        `This backup's ${name} is not a set of records, so it is not a backup this Passport can read.`,
      );
    }
    for (const [key, record] of Object.entries(container)) {
      if (!isPlainObject(record)) {
        throw new PassportBackupError(
          'corrupt-contents',
          `This backup's ${name} entry "${key}" is not a record, so the file is corrupt. Nothing was written.`,
        );
      }
    }
  }
  if (!Array.isArray(contents.incentives)) {
    throw new PassportBackupError(
      'corrupt-contents',
      'This backup\'s incentives are not a list, so it is not a backup this Passport can read.',
    );
  }
  contents.incentives.forEach((record, index) => {
    if (!isPlainObject(record)) {
      throw new PassportBackupError(
        'corrupt-contents',
        `This backup's incentive at position ${index} is not a record, so the file is corrupt. Nothing was written.`,
      );
    }
  });
}

/**
 * Reads the three allow-listed stores. Takes no arguments — that is the point.
 *
 * The wallet sync snapshot and every passkey-derived secret are absent by
 * construction: this function does not know how to reach them.
 */
export async function collectPassportBackup(): Promise<PassportBackupContents> {
  const [{ loadAliasRecords }, { loadPassportContractRecords }, { loadIncentives }] =
    await Promise.all([
      import('./aliasStore.js'),
      import('./passportContractStore.js'),
      import('./incentiveStore.js'),
    ]);
  const contents: PassportBackupContents = {
    version: PASSPORT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    aliases: loadAliasRecords(),
    passportContracts: loadPassportContractRecords(),
    incentives: loadIncentives(),
  };
  assertNoKeyMaterial(contents);
  return contents;
}

/* --- seal and open -------------------------------------------------------- */

async function deriveBackupKey(
  password: string,
  salt: Uint8Array,
  kdf: BackupKdfParameters,
): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    asArrayBuffer(encoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: kdf.hash,
      salt: asArrayBuffer(salt),
      iterations: kdf.iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The plaintext header bytes GCM authenticates alongside the ciphertext. */
function additionalData(version: number, kdf: string): ArrayBuffer {
  return asArrayBuffer(encoder.encode(`midnight-passport:backup:v1 ${version} ${kdf}`));
}

/**
 * Encrypts one payload under one password. The password is used here and
 * nowhere else: not stored, not cached, and not derivable from the file.
 */
export async function sealPassportBackup(
  contents: PassportBackupContents,
  password: string,
): Promise<PassportBackupEnvelope> {
  if (!password) throw new PassportBackupError('not-a-backup', 'A backup needs a password.');
  assertNoKeyMaterial(contents);
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  const key = await deriveBackupKey(password, salt, {
    hash: PBKDF2_HASH,
    iterations: PBKDF2_ITERATIONS,
  });
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(nonce),
      additionalData: additionalData(PASSPORT_BACKUP_VERSION, PASSPORT_BACKUP_KDF),
    },
    key,
    asArrayBuffer(encoder.encode(JSON.stringify(contents))),
  );
  return {
    v: PASSPORT_BACKUP_VERSION,
    kdf: PASSPORT_BACKUP_KDF,
    salt: toBase64Url(salt),
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
}

/** Parses whatever the file picker produced into a real envelope, or throws. */
export function parseBackupEnvelope(raw: string): PassportBackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PassportBackupError(
      'not-a-backup',
      'This file is not JSON, so it is not a Passport backup.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PassportBackupError('not-a-backup', 'This file is not a Passport backup.');
  }
  const candidate = parsed as Partial<PassportBackupEnvelope>;
  if (
    typeof candidate.v !== 'number' ||
    typeof candidate.kdf !== 'string' ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    throw new PassportBackupError(
      'not-a-backup',
      'This file does not carry the five fields a Passport backup has.',
    );
  }
  if (candidate.v !== PASSPORT_BACKUP_VERSION) {
    throw new PassportBackupError(
      'unsupported-version',
      `This backup was written by a newer Passport (format ${candidate.v}); this one reads format ${PASSPORT_BACKUP_VERSION}.`,
    );
  }
  const envelope = candidate as PassportBackupEnvelope;
  // Both throw with the reason. Neither derives a key or touches the payload:
  // an unreadable descriptor and a wrong-length nonce are facts about the file.
  parseKdfDescriptor(envelope.kdf);
  decodeEnvelopeBytes(envelope);
  return envelope;
}

/**
 * Decrypts one envelope. A wrong password and a tampered file both surface as
 * `wrong-password-or-tampered` — GCM authenticates, it does not diagnose, and
 * claiming to know which of the two happened would be a guess.
 */
export async function openPassportBackup(
  envelope: PassportBackupEnvelope | string,
  password: string,
): Promise<PassportBackupContents> {
  const parsed = typeof envelope === 'string' ? parseBackupEnvelope(envelope) : envelope;
  /* Re-checked here rather than trusted from the parse, because an envelope
     handed in as an object never went through it. Both throw `not-a-backup`
     with the field and the length, so a structurally impossible file is never
     reported as a wrong password. */
  const kdf = parseKdfDescriptor(parsed.kdf);
  const { salt, nonce, ciphertext } = decodeEnvelopeBytes(parsed);
  const key = await deriveBackupKey(password, salt, kdf);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(nonce),
        additionalData: additionalData(parsed.v, parsed.kdf),
      },
      key,
      asArrayBuffer(ciphertext),
    );
  } catch {
    throw new PassportBackupError(
      'wrong-password-or-tampered',
      'This backup did not open. Either the password is wrong or the file has been altered — from here the two are indistinguishable.',
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new PassportBackupError(
      'corrupt-contents',
      'The backup decrypted but its contents are not readable.',
    );
  }
  const candidate = decoded as Partial<PassportBackupContents> | null;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.aliases !== 'object' ||
    candidate.aliases === null ||
    typeof candidate.passportContracts !== 'object' ||
    candidate.passportContracts === null ||
    !Array.isArray(candidate.incentives)
  ) {
    throw new PassportBackupError(
      'corrupt-contents',
      'The backup decrypted but does not hold the three record sets a Passport backup carries.',
    );
  }
  const contents: PassportBackupContents = {
    version: typeof candidate.version === 'number' ? candidate.version : PASSPORT_BACKUP_VERSION,
    createdAt: candidate.createdAt,
    aliases: candidate.aliases,
    passportContracts: candidate.passportContracts,
    incentives: candidate.incentives,
  };
  /* A file we did not write is still a file we refuse to trust blindly, and
     the containers are checked HERE so a corrupt one is refused at the point
     the module promises — before a caller has written a single record. */
  assertBackupRecordContainers(contents);
  assertNoKeyMaterial(contents);
  return contents;
}

/* --- applying a restore --------------------------------------------------- */

/**
 * How two `updatedAt` values order — including the case where they do not.
 *
 * `isNewer` used to fold three different answers into `false`: the local record
 * is newer, the two records are the same, and neither date can be read. Only
 * the first of those is "this browser already holds a newer record", and a
 * corrupted local timestamp folded into it blocked that key from ever being
 * restored while the summary asserted a newer local record that did not exist.
 * So the comparison names all four outcomes and the caller words each one.
 *
 * `same` is a real case and the common one — re-restoring the same file makes
 * every timestamp equal. It is reported as already held rather than as newer,
 * because rewriting a record with itself changes nothing and saying "newer" of
 * an identical record is untrue.
 *
 * An ABSENT timestamp and an UNREADABLE one are also different answers. A
 * record from a build older than the field has none, and the rule protects a
 * demonstrably newer local record rather than any local record — so an undated
 * local record loses to a dated one from the file, and an undated record IN the
 * file cannot be shown to be newer and does not overwrite. A timestamp that is
 * present and unreadable is neither: it is a comparison that cannot be made,
 * and it is said out loud rather than dressed up as a newer local record.
 */
type UpdatedAtOrder = 'newer' | 'older' | 'same' | 'candidate-undated' | 'incomparable';

function compareUpdatedAt(
  candidate: string | undefined,
  existing: string | undefined,
): UpdatedAtOrder {
  if (!existing) return 'newer';
  if (!candidate) return 'candidate-undated';
  const left = Date.parse(candidate);
  const right = Date.parse(existing);
  if (Number.isNaN(left) || Number.isNaN(right)) return 'incomparable';
  if (left === right) return 'same';
  return left > right ? 'newer' : 'older';
}

/**
 * Why the record already in this browser was kept, in words that are true of
 * the case that actually happened.
 */
function keptLocalBecause(
  order: Exclude<UpdatedAtOrder, 'newer'>,
  candidate: string | undefined,
  existing: string | undefined,
): string {
  if (order === 'older') return 'this browser already holds a newer record';
  if (order === 'same') return 'this browser already holds this record, unchanged';
  if (order === 'candidate-undated') {
    return 'the record in the file carries no timestamp, so it could not be shown to be newer than the one already here';
  }
  /* Both are present here — `compareUpdatedAt` has already answered for the
     absent cases — and both are unreadable, so both are quoted. */
  return `the file's record is dated "${candidate}" and this browser's "${existing}", which cannot be ordered — so nothing was overwritten on a comparison that could not be made`;
}

/** A record ready to write, or the reason it will not be. */
type Prepared<T> = { ok: true; record: T } | { ok: false; reason: string };

/** Raw 64-hex, the shape every contract address and target in this app has. */
const HEX_64 = /^[0-9a-f]{64}$/i;
/** A transaction id: the 32-byte ledger hash, or the 33-byte identifier. */
const TX_ID = /^([0-9a-f]{64}|[0-9a-f]{66})$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** An optional string field, dropped when it is not a string. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Checks and re-shapes one alias record from a file.
 *
 * `registryConfirmed` is FORCED to false — see this module's header. Everything
 * else is type-checked and the transaction ids are shape-checked, so a claim
 * cannot arrive carrying a plausible-looking name and an id that is not one.
 */
function prepareAliasRecord(value: AliasRecord, network: string): Prepared<AliasRecord> {
  if (!isNonEmptyString(value.alias) || !isNonEmptyString(value.domain)) {
    return { ok: false, reason: 'the file\'s record carries no name to restore' };
  }
  if (value.status !== 'registered' && value.status !== 'queued' && value.status !== 'failed') {
    return { ok: false, reason: `"${String(value.status)}" is not a status an alias record has` };
  }
  for (const [field, id] of [
    ['resolverDeployTxId', value.resolverDeployTxId],
    ['registerTxId', value.registerTxId],
  ] as const) {
    if (id !== undefined && !TX_ID.test(String(id))) {
      return { ok: false, reason: `the file's ${field} is not a transaction id` };
    }
  }
  if (value.resolverTargetHex !== undefined && !HEX_64.test(String(value.resolverTargetHex))) {
    return { ok: false, reason: 'the file\'s resolverTargetHex is not a 32-byte address' };
  }
  const record: AliasRecord = {
    alias: value.alias,
    domain: value.domain,
    network,
    status: value.status,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    /* The one claim a file may not make about itself. `confirmRestoredAliases`
       re-resolves the name and is the only thing that may set this true. */
    registryConfirmed: false,
  };
  const resolverAddress = optionalString(value.resolverAddress);
  if (resolverAddress) record.resolverAddress = resolverAddress;
  const resolverDeployTxId = optionalString(value.resolverDeployTxId);
  if (resolverDeployTxId) record.resolverDeployTxId = resolverDeployTxId;
  const registerTxId = optionalString(value.registerTxId);
  if (registerTxId) record.registerTxId = registerTxId;
  const queuedReason = optionalString(value.queuedReason);
  if (queuedReason) record.queuedReason = queuedReason;
  if (value.resolverTarget === 'contract' || value.resolverTarget === 'wallet') {
    record.resolverTarget = value.resolverTarget;
  }
  const resolverTargetHex = optionalString(value.resolverTargetHex);
  if (resolverTargetHex) record.resolverTargetHex = resolverTargetHex;
  return { ok: true, record };
}

/**
 * Checks and re-shapes one contract record from a file.
 *
 * `ledgerConfirmed` is forced false and `recovered` is refused outright — see
 * this module's header for why neither is a file's to assert. The address is
 * checked as 64 hex characters here rather than left to the store, because the
 * store's job is "a deployed record carries AN address" and this one's is "and
 * it is the shape an address has".
 */
function prepareContractRecord(value: PassportContractRecord): Prepared<PassportContractRecord> {
  if (!isNonEmptyString(value.credentialId) || !isNonEmptyString(value.network)) {
    return { ok: false, reason: 'the file\'s record names no credential and network' };
  }
  if (value.status !== 'deployed' && value.status !== 'failed') {
    return { ok: false, reason: `"${String(value.status)}" is not a status a contract record has` };
  }
  if (value.recovered) {
    return {
      ok: false,
      reason:
        'a recovered contract record cannot come from a file — it exists only where this device read the address out of the passkey itself, so it is left for your passkey to re-seed',
    };
  }
  if (value.address !== undefined && !HEX_64.test(String(value.address))) {
    return { ok: false, reason: 'the file\'s contract address is not 64 hex characters' };
  }
  if (value.deployTxId !== undefined && !TX_ID.test(String(value.deployTxId))) {
    return { ok: false, reason: 'the file\'s deployTxId is not a transaction id' };
  }
  if (value.deviceCommitment !== undefined && !/^\d+$/.test(String(value.deviceCommitment))) {
    return { ok: false, reason: 'the file\'s deviceCommitment is not a Field' };
  }
  const record: PassportContractRecord = {
    credentialId: value.credentialId,
    network: value.network,
    status: value.status,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    /* The chain's word, not the file's. The caller's indexer re-check is the
       only thing that may set this true — see PassportBackupLedgerCheck. */
    ledgerConfirmed: false,
  };
  const address = optionalString(value.address);
  if (address) record.address = address;
  const deployTxId = optionalString(value.deployTxId);
  if (deployTxId) record.deployTxId = deployTxId;
  if (typeof value.txIdResolved === 'boolean') record.txIdResolved = value.txIdResolved;
  const deviceCommitment = optionalString(value.deviceCommitment);
  if (deviceCommitment) record.deviceCommitment = deviceCommitment;
  if (value.feePaidBy === 'sponsored' || value.feePaidBy === 'own-dust') {
    record.feePaidBy = value.feePaidBy;
  }
  const failureReason = optionalString(value.failureReason);
  if (failureReason) record.failureReason = failureReason;
  return { ok: true, record };
}

/** Checks and re-shapes one redemption from a file. */
function prepareIncentiveRecord(
  value: PassportIncentiveRecord,
): Prepared<PassportIncentiveRecord> {
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.app) ||
    !isNonEmptyString(value.label) ||
    !isNonEmptyString(value.redeemedAt)
  ) {
    return { ok: false, reason: 'the file\'s reward is missing the fields a reward has' };
  }
  if (value.txId !== undefined && !TX_ID.test(String(value.txId))) {
    return { ok: false, reason: 'the file\'s txId is not a transaction id' };
  }
  const record: PassportIncentiveRecord = {
    id: value.id,
    app: value.app,
    label: value.label,
    network: typeof value.network === 'string' ? value.network : '',
    redeemedAt: value.redeemedAt,
  };
  const txId = optionalString(value.txId);
  if (txId) record.txId = txId;
  return { ok: true, record };
}

function emptyStoreSummary(): PassportBackupStoreSummary {
  return { found: 0, restored: 0, skipped: [], restoredKeys: [] };
}

/**
 * Writes a decrypted backup into this browser, through each store's OWN
 * invariants — so every rule those stores enforce (a registered alias must
 * carry both transaction ids; a deployed contract must carry an address) is
 * enforced on restored records too. A record a store refuses is reported as
 * skipped in that store's own words, never dropped in silence, and a record
 * counted as restored is one that was READ BACK out of storage afterwards:
 * the stores swallow a `setItem` that throws, so a count of attempted writes
 * would report a restore that a private-browsing tab never performed.
 *
 * Each store is written ONCE. A save per record re-serialised that store's
 * whole map and notified every React subscriber per record, which is quadratic
 * in the size of the file and a re-render storm on a large one.
 *
 * A local record NEWER than the backup's is kept. Restoring a stale contract
 * address over a live one is the one way this feature could cost a user
 * something real — so the file's entries are deduplicated by STORE KEY before
 * anything is written (two entries in one file can collapse onto one key, and
 * the second must not overwrite the first behind the comparison's back), and a
 * local record the chain has already confirmed is never overwritten at all.
 *
 * What the file may NOT assert about a record — `ledgerConfirmed`,
 * `registryConfirmed`, `recovered` — is in this module's header.
 */
export async function applyPassportBackup(
  contents: PassportBackupContents,
): Promise<PassportBackupSummary> {
  assertBackupRecordContainers(contents);
  assertNoKeyMaterial(contents);
  const [
    { loadAliasRecords, restoreAliasRecords },
    { loadPassportContractRecords, restorePassportContractRecords, passportContractRecordKey },
    { loadIncentives, restoreIncentives },
  ] = await Promise.all([
    import('./aliasStore.js'),
    import('./passportContractStore.js'),
    import('./incentiveStore.js'),
  ]);

  /* --- names ------------------------------------------------------------- */
  const aliases = emptyStoreSummary();
  const localAliases = loadAliasRecords();
  const aliasWrites: AliasRecord[] = [];
  for (const [network, value] of Object.entries(contents.aliases)) {
    aliases.found += 1;
    const prepared = prepareAliasRecord(value, network);
    if (!prepared.ok) {
      aliases.skipped.push({ key: network, reason: prepared.reason });
      continue;
    }
    const existing = localAliases[network];
    if (existing) {
      if (existing.registryConfirmed === true) {
        aliases.skipped.push({
          key: network,
          reason:
            'this browser holds a name for this network that the registry itself confirmed, and a file does not overwrite that',
        });
        continue;
      }
      const order = compareUpdatedAt(prepared.record.updatedAt, existing.updatedAt);
      if (order !== 'newer') {
        aliases.skipped.push({
          key: network,
          reason: keptLocalBecause(order, prepared.record.updatedAt, existing.updatedAt),
        });
        continue;
      }
    }
    aliasWrites.push(prepared.record);
  }
  for (const outcome of restoreAliasRecords(aliasWrites)) {
    if (outcome.written) {
      aliases.restored += 1;
      aliases.restoredKeys.push(outcome.network);
    } else {
      aliases.skipped.push({ key: outcome.network, reason: outcome.reason ?? 'the store refused it' });
    }
  }

  /* --- contracts --------------------------------------------------------- */
  const passportContracts = emptyStoreSummary();
  const localContracts = loadPassportContractRecords();
  /* Keyed, not listed: the file's own map keys are ignored (the store's key is
     derived from the record), so two entries can collapse onto one key. */
  const contractWrites = new Map<string, PassportContractRecord>();
  for (const value of Object.values(contents.passportContracts)) {
    passportContracts.found += 1;
    const prepared = prepareContractRecord(value);
    if (!prepared.ok) {
      const key =
        typeof value.credentialId === 'string' && typeof value.network === 'string'
          ? passportContractRecordKey(value.credentialId, value.network)
          : 'an unnamed contract record';
      passportContracts.skipped.push({ key, reason: prepared.reason });
      continue;
    }
    const record = prepared.record;
    const key = passportContractRecordKey(record.credentialId, record.network);
    const staged = contractWrites.get(key);
    if (staged) {
      const order = compareUpdatedAt(record.updatedAt, staged.updatedAt);
      if (order !== 'newer') {
        passportContracts.skipped.push({
          key,
          reason: `the file carries another record for this credential and network, dated "${staged.updatedAt}", which was restored instead`,
        });
        continue;
      }
      passportContracts.skipped.push({
        key,
        reason: `the file carries an older record for this credential and network, dated "${staged.updatedAt}", which was not restored`,
      });
      contractWrites.set(key, record);
      continue;
    }
    const existing = localContracts[key];
    if (existing) {
      if (existing.ledgerConfirmed === true) {
        passportContracts.skipped.push({
          key,
          reason:
            'this browser holds a contract record for this credential that the indexer confirmed, and a file does not overwrite that',
        });
        continue;
      }
      const order = compareUpdatedAt(record.updatedAt, existing.updatedAt);
      if (order !== 'newer') {
        passportContracts.skipped.push({
          key,
          reason: keptLocalBecause(order, record.updatedAt, existing.updatedAt),
        });
        continue;
      }
    }
    contractWrites.set(key, record);
  }
  for (const outcome of restorePassportContractRecords([...contractWrites.values()])) {
    if (outcome.written) {
      passportContracts.restored += 1;
      passportContracts.restoredKeys.push(outcome.key);
    } else {
      passportContracts.skipped.push({
        key: outcome.key,
        reason: outcome.reason ?? 'the store refused it',
      });
    }
  }

  /* --- rewards ----------------------------------------------------------- */
  const incentives = emptyStoreSummary();
  const localIncentiveIds = new Set(loadIncentives().map((record) => record.id));
  const seenIncentiveIds = new Set<string>();
  /* The file's order IS newest-first, and `restoreIncentives` keeps it that
     way through the merge and the cap. Replaying these one at a time through
     `saveIncentive` reversed them and let the cap fall on the newest. */
  const incentiveWrites: PassportIncentiveRecord[] = [];
  for (const value of contents.incentives) {
    incentives.found += 1;
    const prepared = prepareIncentiveRecord(value);
    if (!prepared.ok) {
      incentives.skipped.push({ key: String(value.id ?? 'an unnamed reward'), reason: prepared.reason });
      continue;
    }
    const record = prepared.record;
    if (localIncentiveIds.has(record.id)) {
      incentives.skipped.push({ key: record.id, reason: 'already redeemed in this browser' });
      continue;
    }
    if (seenIncentiveIds.has(record.id)) {
      incentives.skipped.push({
        key: record.id,
        reason: 'the file carries this reward twice, and the first copy was restored',
      });
      continue;
    }
    seenIncentiveIds.add(record.id);
    incentiveWrites.push(record);
  }
  for (const outcome of restoreIncentives(incentiveWrites)) {
    if (outcome.written) {
      incentives.restored += 1;
      incentives.restoredKeys.push(outcome.id);
    } else {
      incentives.skipped.push({ key: outcome.id, reason: outcome.reason ?? 'the store refused it' });
    }
  }

  return { createdAt: contents.createdAt, aliases, passportContracts, incentives };
}

/**
 * Re-resolves restored names through the registry, and confirms only what it
 * answers for.
 *
 * The alias half of the promise contracts already keep: a restored record is a
 * claim made by a FILE, and `registryConfirmed` on it was forced to false on
 * the way in. This is the read that may set it true — `resolveAliasTarget`
 * looks the name up in the registry and reports what the resolver leaf points
 * at, and only a leaf pointing at a CONTRACT is the binding this Passport
 * claims. A name that resolves to something else, or that the registry has no
 * answer for, stays a record awaiting the registry.
 *
 * Every failure is a non-confirmation, never a confirmation: an unreachable
 * indexer leaves the record exactly as the restore wrote it.
 */
export async function confirmRestoredAliases(
  restoredNetworks: string[],
): Promise<PassportBackupRegistryCheck> {
  if (restoredNetworks.length === 0) {
    return { ran: false, reason: 'the backup wrote no name claims, so there was nothing to check.' };
  }
  const [{ MIDNAMES_INDEXER_URLS, resolveAliasTarget }, { loadAliasRecords, restoreAliasRecords }] =
    await Promise.all([import('./midnames.js'), import('./aliasStore.js')]);
  const records = loadAliasRecords();
  let confirmed = 0;
  let unconfirmed = 0;
  let otherNetworks = 0;
  for (const network of restoredNetworks) {
    const record = records[network];
    if (!record || record.status !== 'registered') continue;
    if (!Object.hasOwn(MIDNAMES_INDEXER_URLS, network)) {
      otherNetworks += 1;
      continue;
    }
    let resolved: Awaited<ReturnType<typeof resolveAliasTarget>> = null;
    try {
      resolved = await resolveAliasTarget(
        network as keyof typeof MIDNAMES_INDEXER_URLS,
        record.alias,
      );
    } catch {
      // An indexer that cannot be reached has not disagreed with the record.
      resolved = null;
    }
    if (!resolved || resolved.target.kind !== 'contract') {
      unconfirmed += 1;
      continue;
    }
    /* Written through the bulk path for its read-back check: "confirmed" may
       only be counted where the confirmation is actually in storage. */
    const stored = restoreAliasRecords([
      {
        ...record,
        registryConfirmed: true,
        resolverAddress: resolved.resolverAddress,
        resolverTarget: 'contract',
        resolverTargetHex: resolved.target.hex,
        updatedAt: new Date().toISOString(),
      },
    ]);
    if (stored.some((outcome) => outcome.written)) confirmed += 1;
    else unconfirmed += 1;
  }
  return { ran: true, confirmed, unconfirmed, otherNetworks };
}

/* --- storage backends ----------------------------------------------------- */

/**
 * Where a sealed backup goes, and where it comes back from.
 *
 * Two methods and an availability probe — small on purpose, so a second
 * backend is a small thing to add. A Google Drive backend implements exactly
 * this: `write` uploads the envelope to the user's `appDataFolder`, `read`
 * downloads the most recent one, and `isAvailable` reports whether an OAuth
 * token is in hand. Nothing else in this module or in the Backup screen would
 * change.
 */
export interface PassportBackupBackend {
  readonly id: string;
  /** Shown to the user, e.g. "a file on this device". */
  readonly label: string;
  /** Whether this backend can run here, right now. */
  isAvailable(): boolean;
  /** Writes one envelope; resolves with where it went, in words. */
  write(fileName: string, envelope: string): Promise<string>;
  /**
   * Reads one envelope back. The file backend needs the `File` the user
   * already picked in the UI; a remote backend ignores the argument and
   * fetches its own latest.
   */
  read(picked?: File): Promise<string>;
}

/**
 * The `<a download>` path, and the honest sentence that goes with it.
 *
 * Nothing here can observe whether the file was written: `click()` returns
 * immediately whether the browser saved it, queued a save dialog the user will
 * cancel, or refused the download by policy. The returned words say what
 * actually happened — the browser was asked — and send the user to check.
 */
async function writeThroughDownload(fileName: string, envelope: string): Promise<string> {
  if (typeof document === 'undefined' || typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new PassportBackupError('backup-not-written', 'This browser cannot save files.');
  }
  const blob = new Blob([envelope], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The blob must outlive the click for the download to start; ten seconds
  // is far longer than any browser needs and costs one object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `${fileName} — your browser was asked to save it. A download cannot report back to this page, so check where your downloads go before relying on it`;
}

/** `passport-backup-YYYY-MM-DD.json` — hyphens because a filename cannot hold `/`. */
export function backupFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `passport-backup-${year}-${month}-${day}.json`;
}

/** The slice of the File System Access API this backend uses, where it exists. */
interface FileSaveHandle {
  readonly name?: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type ShowSaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSaveHandle>;

function saveFilePicker(): ShowSaveFilePicker | null {
  const picker = (globalThis as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker : null;
}

/**
 * The one backend v1 ships: the browser's own save path out, and the file the
 * user picks coming back. No account, no network, no third party.
 *
 * TWO PATHS, AND WHY THE WORDS DIFFER
 * -----------------------------------
 * `showSaveFilePicker` resolves only after the bytes are written and rejects
 * when the user cancels, so on that path the backend KNOWS a file exists and
 * says where it went. An `<a download>` click gives no completion signal at
 * all: a blocked download, a cancelled save dialog, and a successful write are
 * the same non-event to the page. So the fallback path says the browser was
 * ASKED to save the file — which is the entire truth available to it — rather
 * than asserting a file in a downloads folder that may never have been written.
 */
export const fileBackupBackend: PassportBackupBackend = {
  id: 'file',
  label: 'a file on this device',
  isAvailable: () =>
    saveFilePicker() !== null ||
    (typeof document !== 'undefined' && typeof globalThis.URL?.createObjectURL === 'function'),
  async write(fileName, envelope) {
    const picker = saveFilePicker();
    if (picker) {
      let handle: FileSaveHandle;
      try {
        handle = await picker({
          suggestedName: fileName,
          types: [{ description: 'Passport backup', accept: { 'application/json': ['.json'] } }],
        });
      } catch (cause) {
        /* A cancelled picker is an AbortError and means no file was written —
           reported as such, never as a saved backup. Anything else is the
           picker itself failing, and the download path below is still real. */
        if ((cause as { name?: string })?.name === 'AbortError') {
          throw new PassportBackupError(
            'backup-not-written',
            'The save was cancelled, so no backup file was written.',
          );
        }
        return writeThroughDownload(fileName, envelope);
      }
      const writable = await handle.createWritable();
      await writable.write(envelope);
      await writable.close();
      return `${handle.name ?? fileName}, where you chose to save it`;
    }
    return writeThroughDownload(fileName, envelope);
  },
  async read(picked) {
    if (!picked) {
      throw new PassportBackupError('not-a-backup', 'Choose a backup file to restore from.');
    }
    return picked.text();
  },
};

const BACKENDS: Record<string, PassportBackupBackend> = { file: fileBackupBackend };

/**
 * Resolves the configured backend. The id exists so a Drive backend can be
 * switched on by configuration once it is real; today only `file` resolves,
 * and anything else fails loudly rather than pretending.
 */
export function selectBackupBackend(id?: string): PassportBackupBackend {
  const requested = id ?? 'file';
  const backend = BACKENDS[requested];
  if (!backend) {
    throw new PassportBackupError(
      'not-a-backup',
      requested === 'google-drive'
        ? 'The Google Drive backend is not built: the demo has no Google OAuth client, so there is nothing to sign in to yet.'
        : `No Passport backup backend is registered under "${requested}".`,
    );
  }
  return backend;
}

/* --- the two operations the screen calls ---------------------------------- */

export interface PassportBackupExport {
  fileName: string;
  /** Where the backend put it, in words for the user. */
  location: string;
  /** What went in, so the screen can say so without re-reading the stores. */
  counts: { aliases: number; passportContracts: number; incentives: number };
}

/** Collects, seals, and hands the envelope to the configured backend. */
export async function exportPassportBackup(
  password: string,
  backend: PassportBackupBackend = selectBackupBackend(),
): Promise<PassportBackupExport> {
  const contents = await collectPassportBackup();
  const envelope = await sealPassportBackup(contents, password);
  const fileName = backupFileName();
  const location = await backend.write(fileName, `${JSON.stringify(envelope, null, 2)}\n`);
  return {
    fileName,
    location,
    counts: {
      aliases: Object.keys(contents.aliases).length,
      passportContracts: Object.keys(contents.passportContracts).length,
      incentives: contents.incentives.length,
    },
  };
}

/**
 * Opens a picked backup, writes it into this browser, and re-checks the names
 * it wrote against the registry before the summary claims any of them.
 *
 * The registry check lives HERE rather than in the caller (as the ledger check
 * does) because it needs nothing the caller holds: an alias record names the
 * network it was claimed on, and `./midnames.ts` knows that network's own
 * indexer. It never blocks the restore — the records are already written, and
 * a check that cannot run leaves them exactly as unconfirmed as they were.
 */
export async function importPassportBackup(
  picked: File | string,
  password: string,
  backend: PassportBackupBackend = selectBackupBackend(),
): Promise<PassportBackupSummary> {
  const raw = typeof picked === 'string' ? picked : await backend.read(picked);
  const contents = await openPassportBackup(parseBackupEnvelope(raw), password);
  const summary = await applyPassportBackup(contents);
  return { ...summary, registryCheck: await confirmRestoredAliases(summary.aliases.restoredKeys) };
}

/* --- password guidance ---------------------------------------------------- */

export interface PassportBackupPasswordHint {
  level: 'too-short' | 'weak' | 'fair' | 'strong';
  /** One sentence, true, and never a promise about what an attacker can do. */
  message: string;
}

/**
 * An HONEST strength hint. It counts length and character variety and says so;
 * it does not score entropy it cannot measure, and it never tells the user a
 * password is "secure" — no client-side check can know that.
 */
export function describeBackupPassword(password: string): PassportBackupPasswordHint {
  const length = password.length;
  if (length < 8) {
    return {
      level: 'too-short',
      message: 'Use at least 8 characters. Length matters more than anything else here.',
    };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (length >= 20 || (length >= 16 && classes >= 3)) {
    return {
      level: 'strong',
      message: 'Long enough that guessing it is impractical. Keep it somewhere you will not lose it.',
    };
  }
  if (length >= 12) {
    return {
      level: 'fair',
      message: 'Reasonable. Several unrelated words would be markedly harder to guess.',
    };
  }
  return {
    level: 'weak',
    message: 'Short passwords are the weak point here, not the encryption. Prefer several words.',
  };
}
