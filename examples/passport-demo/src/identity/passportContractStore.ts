/**
 * Passport account-custody contract records — one per credential and network.
 *
 * The same discipline `./aliasStore.ts` keeps for alias claims applies here,
 * for the same reason: the store holds only what actually happened. A
 * `'deployed'` record must carry both a real contract address and a real
 * deployment transaction id; anything short of that is `'failed'` with the
 * reason it failed, in words the user can act on.
 *
 * `'submitted'` — AND WHY THE RULE ABOVE NOW HAS AN EXCEPTION (2026/09/07)
 * -----------------------------------------------------------------------
 * Until today a deploy in flight lived only in React state, and this store held
 * nothing until the chain had answered. That rule was written against ONE way
 * of getting it wrong — reporting an account that does not exist — and it made
 * the app perfect at that while leaving it defenceless against the opposite
 * mistake, which turned out to be the expensive one.
 *
 * A reviewer's deploy was submitted, landed in block 359977 five seconds later,
 * and was never seen to land because the wait for it could not end (see
 * `../lib/chainWait.ts`). They reopened Passport. React state was gone, this
 * store was empty, and so the app showed them the name step with no account —
 * and had they claimed a name there, it would have deployed a SECOND contract,
 * on a second sponsored fee, for a Passport that already had one. The memory of
 * the first deploy existed nowhere at all.
 *
 * So a `'submitted'` record is now written the moment a transaction is handed
 * to the node, and it is a statement about THIS BROWSER rather than about the
 * chain: "a deploy for this credential and network went out at this time,
 * carrying this address and this transaction identifier". It claims nothing
 * about whether it landed, and every reader in the app already treats anything
 * that is not `'deployed'` as "no account yet", so it cannot be mistaken for
 * one — the Home card reads it as still being set up, and
 * `refusePassportContractRecord` refuses one that tries to claim a confirmed
 * read-back or a recovery.
 *
 * WHAT CLEARS IT. Exactly one thing: an answer. The settle in
 * `./passportContract.ts` overwrites it with `'deployed'` when the deploy lands
 * in the same session; on a later launch, the resume in `../App.tsx` reads the
 * address back through the indexer and overwrites it with `'deployed'` when it
 * is there, or with `'failed'` — carrying the same address and identifier, so
 * nothing is lost — when it is still absent after
 * `RESUME_CONFIRM_WINDOW_MS`, which is what puts the retry on the Home card.
 * A `'submitted'` record therefore never outlives the question it records, and
 * it is left out of backup files (`./backup.ts`) because it is a fact about one
 * browser's in-flight transaction rather than a portable claim.
 *
 * Keyed by credential AND network, because both matter: one passkey may hold a
 * contract on the localnet and another on preview, and a contract deployed on
 * one network is not a contract on the other. The credential id comes first so
 * a second passkey in the same browser never reads the first one's contract.
 *
 * localStorage, under `passport-contract:v1`.
 */

export type PassportContractRecordStatus = 'submitted' | 'deployed' | 'failed';

/**
 * An upgrade in progress — this Passport moving from the account it has to a
 * newly deployed one, because the account it has cannot pay another Passport
 * in a single transaction.
 *
 * WHY IT LIVES ON THE RECORD RATHER THAN BESIDE IT (2026/09/10)
 * ------------------------------------------------------------
 * An upgrade is four or five sponsored transactions long and every one of them
 * can be interrupted — a closed tab, a lost socket, a phone that slept. What
 * makes that survivable is that each step is written down THE MOMENT IT LANDS
 * and every step re-checks the chain before acting, so a resume repeats
 * nothing. That is the same lesson the `'submitted'` note above records, and
 * the expensive half of it is identical: an upgrade that forgot it had already
 * deployed the new account would deploy a SECOND one, on a second sponsored
 * fee, and leave the drained funds sitting in the wallet pointing at neither.
 *
 * It hangs off the record for the account being upgraded AWAY FROM, so while
 * this block exists {@link PassportContractRecord.address} is still the old
 * account and every reader in the app goes on spending from it — which is
 * right, because until the name is re-pointed and the funds are back that IS
 * the Passport. `completePassportUpgrade` is the single moment the swap
 * happens, and it happens after the chain has answered for every step.
 *
 * It is deliberately absent from `../identity/backup.ts`'s field allow-list:
 * an upgrade is a fact about one browser's in-flight migration, and a backup
 * restored onto another device must not resume it there.
 */
export interface PassportUpgradeProgress {
  /** The account being upgraded away from, raw 64-hex. */
  fromAddress: string;
  /**
   * The `.night` name whose resolver has to be re-pointed, as the label — no
   * suffix, the same spelling `normalizePassportAlias` produces.
   *
   * Empty for a Passport that has no name: there is nothing to re-point, and
   * the upgrade skips that step rather than inventing a name to fail on.
   */
  name: string;
  /** The new account, from the moment its deploy is SUBMITTED. */
  toAddress?: string;
  /** The new account's deploy transaction, as submitted. */
  toDeployTxId?: string;
  /** The device commitment the new account carries, as a decimal Field. */
  toDeviceCommitment?: string;
  /**
   * What the old account held when it was drained, by colour — the figure the
   * refund step pays back in.
   *
   * Written with the drain and never recomputed, because by the time the
   * refund runs the old account holds nothing and the wallet holds this value
   * mixed in with whatever else it had. Amounts are decimal strings: a `bigint`
   * does not survive `JSON.stringify`.
   */
  drainedNight?: [colour: string, amount: string][];
  drainedShielded?: [colour: string, amount: string][];
  /** Set once the old account has been READ BACK holding nothing. */
  drained?: boolean;
  /** Set once the indexer has been seen serving the new account's state. */
  deployed?: boolean;
  /** Set once the name has been READ BACK resolving to {@link toAddress}. */
  repointed?: boolean;
  /** The colours already paid back in, so a resume pays none of them twice. */
  refundedNight?: string[];
  refundedShielded?: string[];
  /** Set once every drained colour is back inside the new account. */
  refunded?: boolean;
  startedAt: string;
  updatedAt?: string;
  /**
   * Why the last attempt stopped, in words the reader can act on, or absent
   * while it is running. Cleared by the next attempt that gets past the step
   * it failed on.
   */
  failureReason?: string;
}

export interface PassportContractRecord {
  /** The passkey credential this contract's device secret is derived from. */
  credentialId: string;
  /** The network the deployment really landed on. */
  network: string;
  status: PassportContractRecordStatus;
  /** Raw 64-hex contract address. Present on every `'deployed'` record, and on
   * every `'submitted'` one — the address is a pure function of the initial
   * contract state, so it is known before the transaction is sent. */
  address?: string;
  /** The deployment transaction. Present on every `'deployed'` record, and on
   * every `'submitted'` one, where it is the identifier as submitted. */
  deployTxId?: string;
  /**
   * Whether {@link deployTxId} is the 32-byte ledger HASH an explorer can
   * resolve, rather than the 33-byte identifier `submitTransaction` answers
   * with. `false` means the indexer had not yet mapped it when the deployment
   * was written — the id is real either way, but nothing may link it until
   * this is `true`. Absent on records written before this field existed; a
   * reader should treat that as "unknown" and check the value itself.
   */
  txIdResolved?: boolean;
  /** The device commitment the contract carries, as a decimal Field. */
  deviceCommitment?: string;
  /** Whether the indexer was seen serving state at {@link address}. */
  ledgerConfirmed?: boolean;
  /** Which side really paid the deployment fee. */
  feePaidBy?: 'sponsored' | 'own-dust';
  /** Present on every `'failed'` record — never a bare status. */
  failureReason?: string;
  /**
   * True when this record was NOT written by a deployment this device
   * performed, but seeded from the contract address the passkey itself carries
   * in its WebAuthn largeBlob (see `demo-backend/src/passkey.ts`) on a browser
   * that had never seen this Passport.
   *
   * A recovered record therefore has NO deployment transaction — this device
   * never saw one, and inventing a plausible id would be exactly the lie the
   * rest of this store exists to prevent. What it does have is an address the
   * indexer answered for: {@link savePassportContractRecord} refuses a
   * recovered record whose {@link ledgerConfirmed} is not `true`, so "recovered"
   * can never be written on the strength of the blob alone.
   */
  recovered?: boolean;
  /**
   * True when this record was written by a RESTORE from a backup file rather
   * than by a deployment this device performed.
   *
   * `../identity/backup.ts` sets it on every record it writes and no other
   * path sets it at all, so it is the only thing that distinguishes "this
   * browser submitted a deployment and the indexer has not caught up" from
   * "a file said this address exists and nothing here has checked". Both carry
   * `ledgerConfirmed: false`, and the card must not tell the second story with
   * the first one's words.
   */
  restoredFromBackup?: boolean;
  /**
   * When this record last changed, ISO-8601 — and ABSENT where nothing has
   * ever recorded one. See `./aliasStore.ts`'s field of the same name: the
   * bulk restore below stamped an undated file entry with the moment of the
   * restore, and that invented date then outranked the user's own genuine
   * backup for good.
   */
  updatedAt?: string;
  /**
   * When a restore wrote this record into THIS browser, ISO-8601. A fact about
   * the browser, never about the record: no comparison in
   * `../identity/backup.ts` consults it, and it is not in that module's export
   * allow-list, so it never reaches a backup file.
   */
  restoredAt?: string;
  /**
   * An upgrade this browser has started and not finished — see
   * {@link PassportUpgradeProgress}. Absent on every record that is not
   * mid-upgrade, which is nearly all of them.
   */
  upgrade?: PassportUpgradeProgress;
}

const STORAGE_KEY = 'passport-contract:v1';

/**
 * The storage key for one credential's contract on one network — `credentialId`
 * and `network` both, so neither can shadow the other.
 *
 * Exported because callers hold the whole record map (through
 * {@link subscribePassportContractRecords}) and have to index into it. Spelling
 * the key out at the call site is how a reader and a writer drift apart.
 */
export function passportContractRecordKey(credentialId: string, network: string): string {
  return `${credentialId}::${network}`;
}

/**
 * A null-prototype map, for the reason spelled out on `./aliasStore.ts`:
 * `__proto__` is a legal JSON key, an ordinary object turns a write to it into
 * a prototype assignment that stores nothing, and the read-back this store
 * reports its counts from would then answer from `Object.prototype` and call
 * that a written record.
 */
function emptyRecordMap(): Record<string, PassportContractRecord> {
  return Object.create(null) as Record<string, PassportContractRecord>;
}

function readAll(): Record<string, PassportContractRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRecordMap();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyRecordMap();
    const records: Record<string, PassportContractRecord> = emptyRecordMap();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as PassportContractRecord;
      if (
        record &&
        typeof record.credentialId === 'string' &&
        typeof record.network === 'string' &&
        (record.status === 'submitted' ||
          record.status === 'deployed' ||
          record.status === 'failed')
      ) {
        records[key] = record;
      }
    }
    return records;
  } catch {
    // Storage denied or corrupt: the session simply has no remembered contract.
    return emptyRecordMap();
  }
}

const listeners = new Set<(records: Record<string, PassportContractRecord>) => void>();

function publish(): void {
  const snapshot = readAll();
  for (const listener of listeners) listener(snapshot);
}

export function loadPassportContractRecords(): Record<string, PassportContractRecord> {
  return readAll();
}

/** The contract this credential holds on this network, or null. */
export function loadPassportContractRecord(
  credentialId: string,
  network: string,
): PassportContractRecord | null {
  const records = readAll();
  const key = passportContractRecordKey(credentialId, network);
  return Object.hasOwn(records, key) ? records[key]! : null;
}

/**
 * Persists a record, refusing the two shapes that would let the UI lie: a
 * `'deployed'` record with no address or no transaction id, and a `'failed'`
 * record that does not say why. The throw is deliberate — it turns a
 * would-be silent falsehood into a visible bug.
 */
/**
 * Why this record may not be stored, in the store's own words, or null when it
 * may.
 *
 * Split out of {@link savePassportContractRecord} so the bulk path below
 * enforces the SAME invariants instead of a second copy of them that could
 * drift.
 *
 * It enforces what {@link readAll} filters on, for the reason spelled out on
 * `./aliasStore.ts`'s `refuseAliasRecord`: a predicate that admits a record the
 * reader discards lets that record be staged over a valid one, persisted, and
 * then vanish on the way back out — and the valid record it replaced vanishes
 * with it, while the caller is told only that the write "did not read back".
 *
 * EXPORTED since 2026/08/26, for `../identity/backup.ts`. A restore that
 * deduplicates two file entries onto one store key has to choose between them,
 * and choosing by date alone discarded a fully restorable older entry in favour
 * of a newer one this predicate then refused outright — the file's two-entry
 * claim restored neither. The restore asks this question BEFORE it dedupes, so
 * the choice is made among the entries that can actually be written. The
 * predicate stays the store's, so there is still exactly one copy of it.
 */
export function refusePassportContractRecord(record: PassportContractRecord): string | null {
  if (typeof record.credentialId !== 'string' || typeof record.network !== 'string') {
    return 'A Passport contract record must name the credential and the network it was deployed on, both as text.';
  }
  if (
    record.status !== 'submitted' &&
    record.status !== 'deployed' &&
    record.status !== 'failed'
  ) {
    return 'A Passport contract record\'s status must be submitted, deployed or failed.';
  }
  if (record.status === 'submitted') {
    /* Both, and for the same reason a deployed record needs both: a submitted
       record exists to stop a second deploy and to be resumed later, and it can
       do neither without the address to read back and the identifier to name. */
    if (!record.address || !record.deployTxId) {
      return 'A submitted Passport contract record must carry both the contract address and the transaction identifier it was submitted under.';
    }
    /* The one thing it may not do is borrow a stronger record's evidence. A
       submission has not been read back and was not recovered from anywhere;
       either flag on it would make a screen that reads them tell the chain's
       story about a transaction nobody has asked the chain about. */
    if (record.ledgerConfirmed === true || record.recovered) {
      return 'A submitted Passport contract record cannot claim a confirmed on-chain read-back or a recovery — nothing has answered for it yet.';
    }
  }
  if (record.status === 'deployed' && record.recovered) {
    /* The recovered case, and the only one exempt from the transaction-id
       rule: this device did not witness the deployment, so it has no id to
       carry. In exchange the bar is higher — the address must have been
       confirmed against the chain before the record may exist at all. */
    if (!record.address || record.ledgerConfirmed !== true) {
      return 'A recovered Passport contract record must carry the contract address and a confirmed on-chain read-back.';
    }
  } else if (record.status === 'deployed' && (!record.address || !record.deployTxId)) {
    return 'A deployed Passport contract record must carry both the contract address and the deployment transaction id.';
  }
  if (record.status === 'failed' && !record.failureReason) {
    return 'A failed Passport contract record must explain itself with a failureReason.';
  }
  const upgrade = record.upgrade;
  if (upgrade !== undefined) {
    /* The same rule the rest of this predicate keeps, applied to the block that
       decides whether a resume repeats a sponsored transaction: a step may only
       be marked done once the thing it produced is written down beside it. A
       `deployed: true` with no address is exactly the record that would send a
       resume looking for a contract it cannot name — and then deploy another. */
    if (typeof upgrade.fromAddress !== 'string' || !upgrade.fromAddress) {
      return 'An upgrade record must name the account it is upgrading away from.';
    }
    if (typeof upgrade.name !== 'string') {
      return 'An upgrade record must carry the name it re-points, as text — empty where there is none.';
    }
    if (typeof upgrade.startedAt !== 'string' || !upgrade.startedAt) {
      return 'An upgrade record must say when it started.';
    }
    if (upgrade.toAddress !== undefined && !upgrade.toAddress) {
      return 'An upgrade record\'s new account address, when present, must be a real address.';
    }
    if (upgrade.deployed === true && !upgrade.toAddress) {
      return 'An upgrade cannot report a deployed new account without naming its address.';
    }
    if (upgrade.repointed === true && !upgrade.toAddress) {
      return 'An upgrade cannot report a re-pointed name without naming the account it now points at.';
    }
    if (upgrade.repointed === true && !upgrade.name) {
      return 'An upgrade with no name cannot report one as re-pointed.';
    }
    if (upgrade.refunded === true && upgrade.drained !== true) {
      return 'An upgrade cannot report a refund before it reports the drain it is refunding.';
    }
  }
  return null;
}

export function savePassportContractRecord(record: PassportContractRecord): void {
  const refusal = refusePassportContractRecord(record);
  if (refusal) throw new Error(refusal);
  try {
    const records = readAll();
    records[passportContractRecordKey(record.credentialId, record.network)] = {
      ...record,
      updatedAt: record.updatedAt || new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The deployment still happened; only the memory of it is lost on reload.
  }
  publish();
}

/* -------------------------------------------------------------------------- */
/* The upgrade block                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The upgrade this credential has in flight on this network, or null.
 *
 * Null for a Passport that is not upgrading and for one whose record this
 * browser does not hold — a resume has nothing to resume in either case, and
 * they are the same answer to the only question a caller asks here.
 */
export function loadPassportUpgradeProgress(
  credentialId: string,
  network: string,
): PassportUpgradeProgress | null {
  return loadPassportContractRecord(credentialId, network)?.upgrade ?? null;
}

/**
 * Merges what one step just achieved onto the upgrade block, and writes it.
 *
 * MERGES rather than replaces, deliberately: each step of `./accountUpgrade.ts`
 * knows one fact — the new account's address, that the drain is done, which
 * colour has been paid back — and none of them holds the whole block. A step
 * that wrote the whole thing would be a step that could erase the one before it
 * on a stale read, which is precisely the failure the block exists to prevent.
 *
 * Refuses outright when this credential has no contract record on this network.
 * An upgrade is a migration of an account that exists; there is nothing here to
 * attach one to, and inventing a record would put an address in the store that
 * no deployment produced.
 *
 * Returns the block as it now stands, so the caller carries on with the same
 * value that was persisted rather than its own copy of it.
 */
export function savePassportUpgradeProgress(
  credentialId: string,
  network: string,
  patch: Partial<PassportUpgradeProgress> &
    Pick<PassportUpgradeProgress, 'fromAddress' | 'name' | 'startedAt'>,
): PassportUpgradeProgress {
  const record = loadPassportContractRecord(credentialId, network);
  if (!record) {
    throw new Error(
      'This browser holds no Passport account for that credential on that network, so there is nothing to upgrade.',
    );
  }
  const merged: PassportUpgradeProgress = {
    ...(record.upgrade ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  /* An explicit `undefined` in the patch CLEARS — that is how a step that got
     past a failure drops the reason for it, and `JSON.stringify` would drop the
     key anyway, so leaving it as `undefined` in the object would be a lie about
     what came back. */
  for (const key of Object.keys(merged) as (keyof PassportUpgradeProgress)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  savePassportContractRecord({ ...record, upgrade: merged });
  return merged;
}

/**
 * Switches this Passport onto the new account, and forgets the upgrade.
 *
 * The last step, and the only one that changes what the rest of the app spends
 * from. Everything before it left the old account in place on purpose: until
 * the name resolves to the new account and the value is back inside it, the old
 * one IS the Passport, and a store that had already switched would have every
 * surface reading balances out of a contract nobody can reach by name.
 *
 * `ledgerConfirmed` is carried as `true` and is not a courtesy: the caller
 * reaches this line only after the indexer has been seen serving state at
 * {@link PassportUpgradeProgress.toAddress}, which is the same evidence a
 * deployment's own settle demands.
 */
export function completePassportUpgrade(credentialId: string, network: string): void {
  const record = loadPassportContractRecord(credentialId, network);
  if (!record) {
    throw new Error(
      'This browser holds no Passport account for that credential on that network, so there is no upgrade to finish.',
    );
  }
  const upgrade = record.upgrade;
  if (!upgrade || !upgrade.toAddress || upgrade.deployed !== true) {
    throw new Error(
      'An upgrade can only be finished once its new account has been seen on chain.',
    );
  }
  const next: PassportContractRecord = {
    ...record,
    status: 'deployed',
    address: upgrade.toAddress,
    ledgerConfirmed: true,
  };
  if (upgrade.toDeployTxId) next.deployTxId = upgrade.toDeployTxId;
  if (upgrade.toDeviceCommitment) next.deviceCommitment = upgrade.toDeviceCommitment;
  /* The new account was deployed by THIS browser, so it is neither recovered
     from a passkey blob nor restored from a file, whatever the record it
     replaces claimed. A stale `recovered` here would exempt the new record from
     the transaction-id rule for ever. */
  delete next.recovered;
  delete next.restoredFromBackup;
  delete next.upgrade;
  next.updatedAt = new Date().toISOString();
  savePassportContractRecord(next);
}

/**
 * Drops an upgrade block, leaving the record it hangs off untouched.
 *
 * For the two states in which there is nothing to resume: the old account turns
 * out to have the one-transaction transfer already, and the person abandons the
 * upgrade. It deploys nothing and destroys nothing — an account this browser
 * forgets it was moving to is still on Midnight, and the funds it holds are
 * still the holder's.
 */
export function clearPassportUpgradeProgress(credentialId: string, network: string): void {
  const record = loadPassportContractRecord(credentialId, network);
  if (!record || !record.upgrade) return;
  const next = { ...record };
  delete next.upgrade;
  savePassportContractRecord(next);
}

/** What became of one record a bulk write was asked to store. */
export interface PassportContractWriteOutcome {
  /** The {@link passportContractRecordKey} the record was written under. */
  key: string;
  /**
   * True ONLY when the record was read back out of storage afterwards — see
   * `./aliasStore.ts`'s outcome type for why an attempted write is not a write.
   */
  written: boolean;
  /** Why it was not written. Never absent when {@link written} is false. */
  reason?: string;
}

/**
 * Writes many records in ONE read and ONE `setItem`, notifying subscribers ONCE.
 *
 * The bulk path for `../identity/backup.ts`, for the reason given on
 * `restoreAliasRecords`: a restore that saved record by record re-serialised
 * this whole map and re-rendered every subscriber once per record.
 */
export function restorePassportContractRecords(
  records: PassportContractRecord[],
): PassportContractWriteOutcome[] {
  const next = readAll();
  const now = new Date().toISOString();
  let stagedCount = 0;
  const outcomes = records.map<PassportContractWriteOutcome>((record) => {
    const key = passportContractRecordKey(record.credentialId, record.network);
    const refusal = refusePassportContractRecord(record);
    if (refusal) return { key, written: false, reason: refusal };
    /* The record's OWN date, or none — never the moment of the restore. See
       {@link PassportContractRecord.updatedAt}. */
    const stored: PassportContractRecord = { ...record, restoredAt: now };
    if (!record.updatedAt) delete stored.updatedAt;
    next[key] = stored;
    stagedCount += 1;
    return { key, written: true };
  });
  if (stagedCount === 0) return outcomes;

  let failure: string | null = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  const readBack = failure ? emptyRecordMap() : readAll();
  for (const outcome of outcomes) {
    if (!outcome.written) continue;
    if (failure) {
      outcome.written = false;
      outcome.reason = `this browser refused to store the record: ${failure}`;
    } else if (!Object.hasOwn(readBack, outcome.key)) {
      outcome.written = false;
      outcome.reason =
        'the record was stored but did not read back, so this browser does not hold it';
    }
  }
  publish();
  return outcomes;
}

/**
 * Forgets every contract ONE credential holds — the contract half of "set up a
 * new Passport on this device".
 *
 * IT DEPLOYS NOTHING AND DESTROYS NOTHING. A contract record is this browser's
 * memory of a deployment; the account itself is on Midnight, where it stays,
 * and a later sign-in with the same passkey that can see it will find it again
 * through the blob or through the name. What this removes is the local record
 * that makes the app believe this credential already has an account — which is
 * precisely what a person stuck on an orphaned Passport is trying to be rid of.
 *
 * Records belonging to any other credential are untouched, so starting again on
 * a phone that holds two Passports costs the other one nothing.
 *
 * Returns the keys it forgot, so a caller can say what it did.
 */
export function forgetPassportContractRecordsForCredential(credentialId: string): string[] {
  const forgotten: string[] = [];
  try {
    const records = readAll();
    for (const [key, record] of Object.entries(records)) {
      if (record.credentialId !== credentialId) continue;
      delete records[key];
      forgotten.push(key);
    }
    if (forgotten.length === 0) return forgotten;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage denied: the records outlive this, which is the safe direction.
  }
  publish();
  return forgotten;
}

/** Subscribes to record changes. Returns an unsubscribe function. */
export function subscribePassportContractRecords(
  listener: (records: Record<string, PassportContractRecord>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
