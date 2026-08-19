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
 *   the export and the import path.
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

/** The KDF descriptor written into — and authenticated by — every envelope. */
export const PASSPORT_BACKUP_KDF = `PBKDF2-${PBKDF2_HASH}-${PBKDF2_ITERATIONS}`;

export type PassportBackupErrorCode =
  /** The bytes are not a Passport backup envelope at all. */
  | 'not-a-backup'
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
}

export interface PassportBackupSummary {
  /** When the backup was taken, read from inside the ciphertext. */
  createdAt: string;
  aliases: PassportBackupStoreSummary;
  passportContracts: PassportBackupStoreSummary;
  incentives: PassportBackupStoreSummary;
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

/* --- the allow-list guard ------------------------------------------------- */

/**
 * Property names that must never appear anywhere in a backup payload.
 *
 * This is a guard, not the mechanism: the mechanism is that
 * {@link collectPassportBackup} accepts nothing and reads three named stores.
 * The guard exists so a future field added to one of those record types
 * without reading this file's header fails loudly on the first export, instead
 * of quietly shipping a secret into a user's cloud drive.
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
];

/**
 * Walks a payload and throws if any property name reads as key material.
 *
 * Runs on export (before anything is encrypted) AND on import (before anything
 * is written), because a file handed to us is not a file we wrote.
 */
export function assertNoKeyMaterial(value: unknown, path = 'backup'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoKeyMaterial(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_KEYS.some((forbidden) => lowered.includes(forbidden))) {
      throw new PassportBackupError(
        'key-material-present',
        `A Passport backup carries state, never keys, and "${path}.${key}" reads as key material. Refusing to continue.`,
      );
    }
    assertNoKeyMaterial(nested, `${path}.${key}`);
  }
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

async function deriveBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    asArrayBuffer(encoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt: asArrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
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
  const key = await deriveBackupKey(password, salt);
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
  if (candidate.kdf !== PASSPORT_BACKUP_KDF) {
    throw new PassportBackupError(
      'unsupported-kdf',
      `This backup was sealed with ${candidate.kdf}; this Passport implements ${PASSPORT_BACKUP_KDF}.`,
    );
  }
  return candidate as PassportBackupEnvelope;
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
  const salt = fromBase64Url(parsed.salt, 'salt');
  const nonce = fromBase64Url(parsed.nonce, 'nonce');
  const ciphertext = fromBase64Url(parsed.ciphertext, 'ciphertext');
  const key = await deriveBackupKey(password, salt);
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
  let contents: unknown;
  try {
    contents = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new PassportBackupError(
      'corrupt-contents',
      'The backup decrypted but its contents are not readable.',
    );
  }
  const candidate = contents as Partial<PassportBackupContents> | null;
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
  // A file we did not write is still a file we refuse to trust blindly.
  assertNoKeyMaterial(candidate);
  return {
    version: typeof candidate.version === 'number' ? candidate.version : PASSPORT_BACKUP_VERSION,
    createdAt: candidate.createdAt,
    aliases: candidate.aliases,
    passportContracts: candidate.passportContracts,
    incentives: candidate.incentives,
  };
}

/* --- applying a restore --------------------------------------------------- */

function isNewer(candidate: string | undefined, existing: string | undefined): boolean {
  if (!existing) return true;
  if (!candidate) return false;
  return Date.parse(candidate) > Date.parse(existing);
}

/**
 * Writes a decrypted backup into this browser, through each store's OWN save
 * function — so every invariant those stores enforce (a registered alias must
 * carry both transaction ids; a deployed contract must carry an address) is
 * enforced on restored records too. A record a store refuses is reported as
 * skipped in that store's own words, never dropped in silence.
 *
 * A local record NEWER than the backup's is kept. Restoring a stale contract
 * address over a live one is the one way this feature could cost a user
 * something real.
 */
export async function applyPassportBackup(
  contents: PassportBackupContents,
): Promise<PassportBackupSummary> {
  assertNoKeyMaterial(contents);
  const [
    { loadAliasRecords, saveAliasRecord },
    { loadPassportContractRecords, savePassportContractRecord, passportContractRecordKey },
    { loadIncentives, saveIncentive },
  ] = await Promise.all([
    import('./aliasStore.js'),
    import('./passportContractStore.js'),
    import('./incentiveStore.js'),
  ]);

  const aliases: PassportBackupStoreSummary = { found: 0, restored: 0, skipped: [] };
  const localAliases = loadAliasRecords();
  for (const [network, record] of Object.entries(contents.aliases)) {
    aliases.found += 1;
    const existing = localAliases[network];
    if (existing && !isNewer(record.updatedAt, existing.updatedAt)) {
      aliases.skipped.push({ key: network, reason: 'this browser already holds a newer record' });
      continue;
    }
    try {
      saveAliasRecord({ ...record, network });
      aliases.restored += 1;
    } catch (cause) {
      aliases.skipped.push({
        key: network,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const passportContracts: PassportBackupStoreSummary = { found: 0, restored: 0, skipped: [] };
  const localContracts = loadPassportContractRecords();
  for (const record of Object.values(contents.passportContracts)) {
    passportContracts.found += 1;
    const key = passportContractRecordKey(record.credentialId, record.network);
    const existing = localContracts[key];
    if (existing && !isNewer(record.updatedAt, existing.updatedAt)) {
      passportContracts.skipped.push({
        key,
        reason: 'this browser already holds a newer record',
      });
      continue;
    }
    try {
      savePassportContractRecord(record);
      passportContracts.restored += 1;
    } catch (cause) {
      passportContracts.skipped.push({
        key,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const incentives: PassportBackupStoreSummary = { found: 0, restored: 0, skipped: [] };
  const localIncentiveIds = new Set(loadIncentives().map((record) => record.id));
  for (const record of contents.incentives) {
    incentives.found += 1;
    if (localIncentiveIds.has(record.id)) {
      incentives.skipped.push({ key: record.id, reason: 'already redeemed in this browser' });
      continue;
    }
    try {
      saveIncentive(record);
      incentives.restored += 1;
    } catch (cause) {
      incentives.skipped.push({
        key: record.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { createdAt: contents.createdAt, aliases, passportContracts, incentives };
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

/** `passport-backup-YYYY-MM-DD.json` — hyphens because a filename cannot hold `/`. */
export function backupFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `passport-backup-${year}-${month}-${day}.json`;
}

/**
 * The one backend v1 ships: the browser's download path out, and the file the
 * user picks coming back. No account, no network, no third party.
 */
export const fileBackupBackend: PassportBackupBackend = {
  id: 'file',
  label: 'a file on this device',
  isAvailable: () =>
    typeof document !== 'undefined' && typeof globalThis.URL?.createObjectURL === 'function',
  async write(fileName, envelope) {
    if (!fileBackupBackend.isAvailable()) {
      throw new PassportBackupError('not-a-backup', 'This browser cannot download files.');
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
    return `${fileName}, in this device's downloads`;
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

/** Opens a picked backup and writes it into this browser. */
export async function importPassportBackup(
  picked: File | string,
  password: string,
  backend: PassportBackupBackend = selectBackupBackend(),
): Promise<PassportBackupSummary> {
  const raw = typeof picked === 'string' ? picked : await backend.read(picked);
  const contents = await openPassportBackup(parseBackupEnvelope(raw), password);
  return applyPassportBackup(contents);
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
