/**
 * Alias claim records — one per CREDENTIAL and network.
 *
 * The store holds only what actually happened. A `'registered'` record must
 * carry both real transaction ids; anything short of that is `'queued'` (with
 * the reason it is queued, in words the user can act on) or `'failed'`. There
 * is deliberately no "pending" state that looks like success.
 *
 * THE BUG THE CREDENTIAL HALF OF THAT KEY EXISTS TO CLOSE (2026/09/04)
 * -------------------------------------------------------------------
 * Until now this store was keyed by NETWORK ALONE, and it was the last store in
 * the app that was. `./passportContractStore.ts` has been keyed by credential
 * and network since multi-passkey support landed, and the profile note lives on
 * the profile, which is per credential. The alias record was the odd one out,
 * and `../App.tsx` said so in as many words — "pre-existing multi-passkey
 * behaviour rather than anything this path introduces" — on the reasoning that
 * a name is a display record and the name itself is held on chain.
 *
 * That reasoning was wrong about what the record DOES. Two things read it, and
 * neither is display:
 *
 *   - the name step is gated on it. `loadAliasRecords()[selectedNetwork]`
 *     returning anything at all means "this Passport has already been named",
 *     so the step is skipped;
 *   - and Home prints it as the signed-in Passport's name.
 *
 * So a person whose passkey was gone — deleted, or a different Google account
 * signed in on the same Android phone — pressed the one control the screen
 * offered, enrolled a BRAND NEW credential, and landed on a finished Home
 * screen wearing the previous passkey's name, with no account behind it,
 * because the contract record IS per credential and the new credential had
 * none. Reported on Android on 2026/09/04: "I'm stuck with the orphan key that
 * does not contain the contract attached… the same alias is brought over and
 * over. Even deleting and recreating the passkeys under different accounts
 * doesn't do the job." There was no way out, because every record that made the
 * app think the Passport was already set up was keyed by something the user
 * could not change.
 *
 * A record therefore names the credential it was claimed under, and
 * {@link loadAliasRecord} answers for one credential only. A new passkey reads
 * nothing, so it is walked through the name step like the new Passport it is;
 * switching back to the old passkey shows the old name again, because the old
 * record was never overwritten.
 *
 * WHAT HAPPENS TO THE RECORDS ALREADY OUT THERE. A record written before this
 * build carries no credential and sits under a bare network key, where nothing
 * can read it. {@link adoptLegacyAliasRecords} hands it to a credential that
 * can be shown to own it — and to no other. See its own note for the rule and
 * for why guessing was not an option.
 *
 * localStorage, keyed by `credentialId::network`, under `passport-alias:v1`.
 */

export type AliasRecordStatus = 'registered' | 'queued' | 'failed';

export interface AliasRecord {
  /**
   * The passkey credential this name was claimed under.
   *
   * OPTIONAL, and absent on every record written before 2026/09/04 — those
   * predate the credential half of this store's key and sit under a bare
   * network key where no reader can reach them. It is NOT back-filled on read:
   * a record whose owner nobody wrote down has no owner, and inventing one is
   * exactly how the previous passkey's name came to be shown over a brand-new
   * Passport. {@link adoptLegacyAliasRecords} is the only thing that may write
   * it, and only where ownership can be shown rather than assumed.
   */
  credentialId?: string;
  alias: string;
  domain: string;
  network: string;
  status: AliasRecordStatus;
  resolverAddress?: string;
  resolverDeployTxId?: string;
  registerTxId?: string;
  /** Present on every `'queued'` and `'failed'` record — never a bare status. */
  queuedReason?: string;
  /** Whether the registry itself was seen carrying the name. */
  registryConfirmed?: boolean;
  /**
   * What the resolver leaf this record's claim deployed actually points at.
   *
   * OPTIONAL, and absent on every record written before 2026/08/19 — those
   * claims all bound the name to the wallet's unshielded address, because that
   * was the only path the code had. The field is not back-filled: a reader
   * that finds it missing knows only that the record predates the choice, and
   * the identity card says exactly that rather than asserting a value nobody
   * recorded. `'contract'` means the name resolves to this Passport's
   * account-custody contract.
   */
  resolverTarget?: 'wallet' | 'contract';
  /** The raw 64-hex bytes {@link resolverTarget} resolves to, when recorded. */
  resolverTargetHex?: string;
  /**
   * True when this record was READ OFF A PASSKEY rather than watched being
   * made — a device that has never seen this Passport before, signing in with
   * the passkey that carries the account and the name it holds.
   *
   * It is the alias half of `PassportContractRecord.recovered`, and it exists
   * for the same reason: such a record has no transaction ids, because no
   * transaction happened HERE, and a surface must never show one that this
   * device did not see. The registration itself is real — it is what put the
   * name on the passkey — so the status is `registered` and
   * {@link registryConfirmed} stays false until this browser has watched the
   * name answer for itself.
   */
  recovered?: boolean;
  /**
   * When this record last changed, ISO-8601 — and ABSENT where nothing has
   * ever recorded one.
   *
   * Optional on purpose, and it is the whole of the fix of 2026/08/26. The
   * bulk restore below wrote `record.updatedAt || now`, so a file entry with
   * no timestamp — a hand-edited file, or one from a build before this field
   * existed — was persisted carrying the moment of the RESTORE. The
   * no-downgrade rule in `../identity/backup.ts` only runs against a record
   * this browser already holds, so that first restore met no opposition; the
   * user's own, correctly dated backup was then permanently older than a date
   * the restore had invented, and could never be restored again. A record
   * whose date nobody recorded now says so, and
   * `compareUpdatedAt` reads an undated local record as older than any dated
   * candidate — which is the truth, rather than a fabrication that outranks
   * everything.
   */
  updatedAt?: string;
  /**
   * When a restore wrote this record into THIS browser, ISO-8601.
   *
   * A fact about this browser, never about the record, and NOTHING may read it
   * as {@link updatedAt}: no comparison in `../identity/backup.ts` consults it,
   * and it is not in that module's export allow-list, so it never reaches a
   * backup file. It exists so a restored record that carries no date of its own
   * is still traceable to the restore that wrote it.
   */
  restoredAt?: string;
}

const STORAGE_KEY = 'passport-alias:v1';

/**
 * The storage key for one credential's name on one network.
 *
 * A record with no credential — one written before 2026/09/04 — keys under the
 * bare network, which is exactly where it already is. That is not a fallback
 * that lets such a record be READ as somebody's: {@link loadAliasRecord} is
 * only ever given a credential, so the bare key is unreachable through it, and
 * the record stays invisible until {@link adoptLegacyAliasRecords} gives it an
 * owner.
 *
 * Exported for the same reason `./passportContractStore.ts` exports its own:
 * callers hold the whole map through {@link subscribeAliasRecords} and have to
 * index into it, and a key spelled out at the call site is how a reader and a
 * writer drift apart.
 */
export function aliasRecordKey(credentialId: string | undefined, network: string): string {
  return credentialId ? `${credentialId}::${network}` : network;
}

/**
 * Every map this store hands out has a NULL prototype, and every read-back
 * asks {@link Object.hasOwn}.
 *
 * `__proto__` is a legal JSON key and an illegal storage key: on an ordinary
 * object `next['__proto__'] = record` sets the prototype and stores nothing,
 * and the read-back that follows finds `Object.prototype` sitting there and
 * reports a write that never happened. A restore counts what it reads back, so
 * a lookup that can answer from the prototype chain is a count that can lie.
 * A null prototype removes the setter, and `Object.hasOwn` removes the
 * inherited answer. `../identity/backup.ts` refuses the key by name as well —
 * this is the half that makes the COUNT honest whatever reaches it.
 */
function emptyRecordMap(): Record<string, AliasRecord> {
  return Object.create(null) as Record<string, AliasRecord>;
}

function readAll(): Record<string, AliasRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRecordMap();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyRecordMap();
    const records: Record<string, AliasRecord> = emptyRecordMap();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as AliasRecord;
      if (
        !record ||
        typeof record.alias !== 'string' ||
        typeof record.domain !== 'string' ||
        (record.status !== 'registered' && record.status !== 'queued' && record.status !== 'failed')
      ) {
        continue;
      }
      /* The network comes from the RECORD now that the key is compound. A
         record from before this build may not carry one — the old reader
         repaired that from the key, which was the network — so a bare key is
         still read as the network it used to be, and a compound key whose
         record says nothing is dropped rather than given `"id::network"` as
         its network. */
      const network =
        typeof record.network === 'string' && record.network
          ? record.network
          : key.includes('::')
            ? null
            : key;
      if (!network) continue;
      const credentialId = typeof record.credentialId === 'string' ? record.credentialId : undefined;
      const stored: AliasRecord = { ...record, network };
      /* Dropped rather than stored as `undefined`: a key that is present with
         no value still answers `'credentialId' in record`, and the adoption
         rule below asks exactly that question of every record it meets. */
      if (credentialId) stored.credentialId = credentialId;
      else delete stored.credentialId;
      records[key] = stored;
    }
    return records;
  } catch {
    // Storage denied or corrupt: the session simply has no remembered alias.
    return emptyRecordMap();
  }
}

const listeners = new Set<(records: Record<string, AliasRecord>) => void>();

function publish(): void {
  const snapshot = readAll();
  for (const listener of listeners) listener(snapshot);
}

export function loadAliasRecords(): Record<string, AliasRecord> {
  return readAll();
}

/**
 * The name THIS credential claimed on this network, or null.
 *
 * It never falls back to a bare-network record, and that refusal is the whole
 * fix of 2026/09/04: a credential enrolled thirty seconds ago has claimed
 * nothing, and answering it with whatever the last passkey claimed is how a
 * new Passport came to wear an old name over an account it did not have.
 */
export function loadAliasRecord(credentialId: string, network: string): AliasRecord | null {
  const records = readAll();
  const key = aliasRecordKey(credentialId, network);
  return Object.hasOwn(records, key) ? records[key] : null;
}

/**
 * Everything one credential has claimed, re-keyed by network — the shape every
 * surface in the app wants, because a screen asks "what is my name on this
 * network" and never "what is my name under this credential on this network".
 *
 * Takes the map rather than reading storage so a React render can derive it
 * from the subscription's own snapshot instead of going back to localStorage on
 * every paint.
 */
export function aliasRecordsForCredential(
  credentialId: string,
  records: Record<string, AliasRecord> = readAll(),
): Record<string, AliasRecord> {
  const mine = emptyRecordMap();
  for (const record of Object.values(records)) {
    if (record.credentialId === credentialId) mine[record.network] = record;
  }
  return mine;
}

/**
 * Why this record may not be stored, in the store's own words, or null when it
 * may.
 *
 * Split out of {@link saveAliasRecord} so the bulk path below enforces the SAME
 * invariants instead of a second copy of them that could drift.
 *
 * IT ENFORCES WHAT {@link readAll} FILTERS ON, AND THAT IS NOT PEDANTRY. The
 * two used to disagree: this asked only about the transaction-id and
 * `queuedReason` invariants, so a record with a non-string `alias` passed here,
 * was staged over the valid record this store already held for that network,
 * was persisted, and was then dropped by the reader on the way back out. The
 * caller was told only that its record "did not read back" — while the record
 * it had overwritten was gone from storage for good. A predicate that admits
 * what the reader discards is a predicate that destroys data, so the type shape
 * is checked here, before anything is staged.
 */
function refuseAliasRecord(record: AliasRecord): string | null {
  if (
    typeof record.alias !== 'string' ||
    typeof record.domain !== 'string' ||
    typeof record.network !== 'string'
  ) {
    return 'An alias record must carry the name, the domain it was claimed under, and the network, all as text.';
  }
  /* Absent is legal — that is a record from before this store had a credential
     half to its key, and it lands under the bare network key where nothing can
     read it until it is adopted. Present and not text is not: it would key the
     record under `"[object Object]::stagenet"` and lose it. */
  if (record.credentialId !== undefined && typeof record.credentialId !== 'string') {
    return 'An alias record\'s credential id must be text.';
  }
  if (
    record.status !== 'registered' &&
    record.status !== 'queued' &&
    record.status !== 'failed'
  ) {
    return 'An alias record\'s status must be registered, queued, or failed.';
  }
  /* The transaction-id invariant asks a question about THIS device's own
     evidence, so it is asked only of records this device made. A recovered
     record was read off a passkey by a browser that holds nothing: there are no
     ids to carry, and refusing it would leave the one device that needs the
     name most as the one device not allowed to keep it. What it may never do is
     claim ids it does not have — see {@link AliasRecord.recovered}. */
  if (
    record.status === 'registered' &&
    record.recovered !== true &&
    (!record.resolverDeployTxId || !record.registerTxId)
  ) {
    return 'A registered alias record must carry both the resolver deployment and registration transaction ids.';
  }
  if (record.status !== 'registered' && !record.queuedReason) {
    return 'A queued or failed alias record must explain itself with a queuedReason.';
  }
  return null;
}

/**
 * Persists one record — and REFUSES one that does not name its credential.
 *
 * The throw is deliberate, and it is the same discipline the rest of this store
 * keeps: a record with no owner is a record that will be shown to the wrong
 * Passport, so it is a visible bug rather than a silent one.
 */
export function saveAliasRecord(record: AliasRecord): void {
  const refusal = refuseAliasRecord(record);
  if (refusal) throw new Error(refusal);
  if (!record.credentialId) {
    throw new Error('An alias record must name the passkey credential it was claimed under.');
  }
  try {
    const records = readAll();
    records[aliasRecordKey(record.credentialId, record.network)] = {
      ...record,
      updatedAt: record.updatedAt || new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The claim still happened; only the memory of it is lost on reload.
  }
  publish();
}

/** What became of one record a bulk write was asked to store. */
export interface AliasRecordWriteOutcome {
  /** The {@link aliasRecordKey} the record was written under. */
  key: string;
  /** The network the record names, kept alongside the key for readability. */
  network: string;
  /**
   * True ONLY when the record was read back out of storage afterwards. A
   * `setItem` that throws (private browsing, quota) and a record this store's
   * own reader filters out on load both land here as `false` with the reason,
   * because a caller that counts writes must count what survived, not what was
   * attempted.
   */
  written: boolean;
  /** Why it was not written. Never absent when {@link written} is false. */
  reason?: string;
}

/**
 * Writes many records in ONE read and ONE `setItem`, notifying subscribers ONCE.
 *
 * {@link saveAliasRecord} re-reads and re-serialises the whole map and publishes
 * on every call, which is right for the one-record path every claim takes and
 * quadratic for a restore carrying dozens. This is the bulk path for
 * `../identity/backup.ts`, and it reports per record whether the write actually
 * survived rather than assuming it did.
 */
export function restoreAliasRecords(records: AliasRecord[]): AliasRecordWriteOutcome[] {
  const next = readAll();
  const now = new Date().toISOString();
  const staged: string[] = [];
  const outcomes = records.map<AliasRecordWriteOutcome>((record) => {
    /* Derived from the RECORD, never from the file's own map key — the same
       rule `./passportContractStore.ts` has always kept, and the reason a file
       cannot file somebody else's name under this credential. A record from an
       older file names no credential and lands under the bare network key,
       unreadable until it is adopted. */
    const key = aliasRecordKey(record.credentialId, record.network);
    const refusal = refuseAliasRecord(record);
    if (refusal) return { key, network: record.network, written: false, reason: refusal };
    /* The record's OWN date, or none — never the moment of the restore. See
       {@link AliasRecord.updatedAt} for the restore this fabrication used to
       block for good. `restoredAt` records when the restore ran, and nothing
       reads it as the record's date. */
    const stored: AliasRecord = { ...record, restoredAt: now };
    if (!record.updatedAt) delete stored.updatedAt;
    next[key] = stored;
    staged.push(key);
    return { key, network: record.network, written: true };
  });
  if (staged.length === 0) return outcomes;

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
 * Forgets ONE network's record — and it exists for exactly one caller.
 *
 * A name restored from a passkey (`recovered: true`) is a claim this device
 * cannot check on its own. When the account it names never answers and the
 * person chooses to set up a new one instead, the restored name must go with
 * it: leaving it would put somebody else's name — or their own, over an account
 * that is not there — on a Passport they have just decided to start again.
 *
 * It removes the record and nothing else. It is never a way to "release" a
 * name: the name lives on chain, and this store is only what this browser
 * remembers about it.
 */
export function removeAliasRecord(credentialId: string, network: string): void {
  try {
    const records = readAll();
    const key = aliasRecordKey(credentialId, network);
    if (!Object.hasOwn(records, key)) return;
    delete records[key];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage denied: the record outlives this, which is the safe direction.
  }
  publish();
}

/**
 * Forgets everything ONE credential claimed, on every network — the alias half
 * of "set up a new Passport on this device".
 *
 * IT TOUCHES NOTHING BUT THIS BROWSER'S MEMORY. The names are on chain, held by
 * the accounts that registered them; this store is only what this device
 * remembers about them, and a person who has decided to start again on this
 * device is not releasing a name by doing so. Records belonging to any other
 * credential are left exactly where they are, which is what makes starting
 * again safe on a phone that holds two Passports.
 *
 * Returns the networks it forgot, so the caller can say what it did rather than
 * report a number nobody can check.
 */
export function forgetAliasRecordsForCredential(credentialId: string): string[] {
  const forgotten: string[] = [];
  try {
    const records = readAll();
    for (const [key, record] of Object.entries(records)) {
      if (record.credentialId !== credentialId) continue;
      delete records[key];
      forgotten.push(record.network);
    }
    if (forgotten.length === 0) return forgotten;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage denied: the records outlive this, which is the safe direction.
  }
  publish();
  return forgotten;
}

/**
 * Forgets every record that names NO credential — the legacy half of "set up a
 * new Passport on this device".
 *
 * IT IS NOT PART OF THE ORDINARY WAY OUT, and the caller must satisfy itself
 * first that no other Passport in this browser could own these records. See
 * {@link adoptLegacyAliasRecords}: an unlabelled record's owner is unknown, so
 * deleting one on a browser holding two Passports could take the OTHER one's
 * name away.
 *
 * Where it does apply it closes a real hole. `forgetAliasRecordsForCredential`
 * only removes records that name the credential being forgotten, so a legacy
 * record survives it untouched — and the new passkey that follows is then the
 * only Passport in the browser, which is one of the two claims
 * {@link adoptLegacyAliasRecords} accepts. The person who asked to start clean
 * would have been handed the old name straight back.
 *
 * Returns the networks it forgot.
 */
export function forgetLegacyAliasRecords(): string[] {
  const forgotten: string[] = [];
  try {
    const records = readAll();
    for (const [key, record] of Object.entries(records)) {
      if (record.credentialId) continue;
      delete records[key];
      forgotten.push(record.network);
    }
    if (forgotten.length === 0) return forgotten;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage denied: the records outlive this, which is the safe direction.
  }
  publish();
  return forgotten;
}

/** What a credential can show for its claim on a record nobody labelled. */
export interface LegacyAliasClaim {
  /**
   * The networks this credential holds an account-custody contract on. A name
   * and the account it resolves to were claimed together, so a contract here is
   * this browser's own witness that this credential was the one claiming.
   */
  networks: readonly string[];
  /**
   * True when this is the ONLY Passport profile in this browser. There was then
   * no other credential the record could have belonged to.
   */
  soleProfile: boolean;
}

/**
 * Hands a record written before 2026/09/04 to the credential that owns it —
 * and to no other.
 *
 * WHY THIS IS NOT JUST "GIVE IT TO WHOEVER SIGNS IN". That is precisely the
 * behaviour being fixed. A bare-network record is the previous key scheme's
 * whole problem in one value: it says a name was claimed and does not say by
 * whom, and the app used to answer that question with "you, whoever you are",
 * which is how a passkey enrolled seconds earlier ended up wearing somebody
 * else's name over an account it did not have.
 *
 * So a claim has to be SHOWN, and there are exactly two ways to show one:
 *
 *   - this credential holds an account-custody contract on that network. A
 *     claim registers the name and deploys the account in one ceremony, so a
 *     contract record here is this browser's own witness that this credential
 *     was the claimant. It is per credential and always has been, which is why
 *     it is trustworthy for this and the alias record was not.
 *   - or this is the only Passport in the browser, in which case there is no
 *     other credential the record could have belonged to.
 *
 * Anything else keeps the record where it is: unowned, unreadable, and intact.
 * That is deliberately not the same as deleting it — a second passkey signing
 * in must not be able to destroy the first one's name — and it costs the user
 * nothing they can see, because a record no reader can reach was already not
 * being shown to anybody.
 *
 * It never overwrites a record this credential already has: a name it claimed
 * under this build is better evidence than one nobody labelled.
 *
 * Returns the networks it adopted, for the caller's activity trail.
 */
export function adoptLegacyAliasRecords(
  credentialId: string,
  claim: LegacyAliasClaim,
): string[] {
  const adopted: string[] = [];
  try {
    const records = readAll();
    for (const [key, record] of Object.entries(records)) {
      if (record.credentialId) continue;
      if (!claim.soleProfile && !claim.networks.includes(record.network)) continue;
      const owned = aliasRecordKey(credentialId, record.network);
      if (Object.hasOwn(records, owned)) continue;
      records[owned] = { ...record, credentialId };
      delete records[key];
      adopted.push(record.network);
    }
    if (adopted.length === 0) return adopted;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage denied: the record stays legacy and is offered again next time.
  }
  publish();
  return adopted;
}

export function clearAliasRecords(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
  publish();
}

/** Subscribes to record changes. Returns an unsubscribe function. */
export function subscribeAliasRecords(
  listener: (records: Record<string, AliasRecord>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
