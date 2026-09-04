/**
 * Drills for WHOSE name a Passport is shown — the store's half of the Android
 * orphan of 2026/09/04.
 *
 * This file exists because a keying decision in a "thin storage record" turned
 * out to be a decision about identity. The store was keyed by network alone,
 * every reader indexed it by network alone, and two things that are not display
 * read it: the name step, which skips itself when a record exists, and Home,
 * which prints the record as the signed-in Passport's name. So a passkey
 * enrolled thirty seconds earlier — after the old one was deleted, or a
 * different Google account signed in on the same phone — read the previous
 * Passport's name, skipped naming, and landed on a finished Home screen with no
 * account behind it. The reviewer's words were "I'm stuck with the orphan key
 * that does not contain the contract attached… the same alias is brought over
 * and over."
 *
 * What each test below holds to is therefore one of three things, and none of
 * them is that a function returns an object:
 *
 *   - A NEW CREDENTIAL READS NOTHING. That is the whole fix, and every other
 *     property here is in service of it.
 *   - SWITCHING BACK STILL WORKS. A fix that made the second passkey clean by
 *     destroying the first one's record would be a worse bug than the one it
 *     replaced, so nothing here overwrites across credentials.
 *   - AND THE RECORDS ALREADY OUT THERE SURVIVE. Every alias record on every
 *     installed Passport predates this keying and names nobody. Handing one to
 *     whoever signs in next is exactly the defect; refusing to hand it over at
 *     all loses a real user their real name. `adoptLegacyAliasRecords` is the
 *     rule that threads that, and it is drilled hardest.
 *
 * The store is exercised against a minimal in-memory `localStorage`, as
 * `./backup.test.ts` exercises it, because these functions talk to
 * `window.localStorage` directly and mocking the store would leave the
 * invariants unenforced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AliasRecord } from './aliasStore.js';

const ALICE = 'cred-alice';
const BOB = 'cred-bob';

/** The smallest thing that behaves like `window.localStorage`. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
      },
    },
  });
  return map;
}

/** A `localStorage` whose every write throws — private browsing, or a full quota. */
function installFailingStorage(seed?: Record<string, AliasRecord>): void {
  const map = new Map<string, string>();
  if (seed) map.set('passport-alias:v1', JSON.stringify(seed));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: () => {
          throw new Error('the quota is full');
        },
        removeItem: () => {
          throw new Error('the quota is full');
        },
      },
    },
  });
}

/** A `localStorage` that accepts a write, keeps nothing, and says nothing. */
function installDroppingStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: () => undefined,
        removeItem: (key: string) => void map.delete(key),
      },
    },
  });
}

/** A browser with no storage at all, so every read throws rather than answering. */
function installUnreadableStorage(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get localStorage(): never {
        throw new Error('storage is denied to this document');
      },
    },
  });
}

/** A registered record, with every invariant the store insists on satisfied. */
function registered(credentialId: string | undefined, alias: string, network = 'stagenet'): AliasRecord {
  return {
    ...(credentialId ? { credentialId } : {}),
    alias,
    domain: `${alias}.night`,
    network,
    status: 'registered',
    resolverDeployTxId: 'aa'.repeat(32),
    registerTxId: 'bb'.repeat(32),
  };
}

/** Writes the raw storage map, which is how a record from an OLD build arrives. */
function seed(records: Record<string, AliasRecord>): void {
  window.localStorage.setItem('passport-alias:v1', JSON.stringify(records));
}

async function store() {
  return import('./aliasStore.js');
}

beforeEach(() => {
  vi.resetModules();
  installStorage();
});

describe('one credential cannot read another\'s name', () => {
  it('answers for the credential that claimed the name, and nobody else', async () => {
    const { saveAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));

    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('alice');
    /* THE DEFECT, ASSERTED AS ABSENT. Before 2026/09/04 this read answered
       `alice` — for a credential that has claimed nothing at all. */
    expect(loadAliasRecord(BOB, 'stagenet')).toBeNull();
  });

  it('keeps two Passports\' names apart on the same network in the same browser', async () => {
    const { saveAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    saveAliasRecord(registered(BOB, 'bob'));

    /* Switching passkeys switches Passports. The second claim used to REPLACE
       the first — one key, one network — so a phone holding two Passports
       could only ever remember the more recent one's name. */
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('alice');
    expect(loadAliasRecord(BOB, 'stagenet')?.alias).toBe('bob');
  });

  it('keeps one credential\'s networks apart', async () => {
    const { saveAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice', 'stagenet'));
    saveAliasRecord(registered(ALICE, 'alicetoo', 'preview'));

    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('alice');
    expect(loadAliasRecord(ALICE, 'preview')?.alias).toBe('alicetoo');
  });

  it('gives a surface one credential\'s names, keyed by network', async () => {
    const { saveAliasRecord, aliasRecordsForCredential } = await store();
    saveAliasRecord(registered(ALICE, 'alice', 'stagenet'));
    saveAliasRecord(registered(ALICE, 'alicetoo', 'preview'));
    saveAliasRecord(registered(BOB, 'bob', 'stagenet'));

    const mine = aliasRecordsForCredential(ALICE);
    expect(Object.keys(mine).sort()).toEqual(['preview', 'stagenet']);
    expect(mine.stagenet?.alias).toBe('alice');
    /* Re-keyed by network on the way out, because a screen asks "what is my
       name here" and never "what is my name under this credential here". */
    expect(aliasRecordsForCredential(BOB).stagenet?.alias).toBe('bob');
    expect(aliasRecordsForCredential('cred-nobody')).toEqual({});
  });

  it('reads a legacy record for nobody at all', async () => {
    const { loadAliasRecord, aliasRecordsForCredential, loadAliasRecords } = await store();
    seed({ stagenet: registered(undefined, 'oldname') });

    /* It is still THERE — it is somebody's real name and this build will not
       destroy it — and it is readable by no credential until it is adopted. */
    expect(loadAliasRecords().stagenet?.alias).toBe('oldname');
    expect(loadAliasRecord(ALICE, 'stagenet')).toBeNull();
    expect(aliasRecordsForCredential(ALICE)).toEqual({});
  });
});

describe('saveAliasRecord', () => {
  it('refuses a record that does not say whose it is', async () => {
    const { saveAliasRecord } = await store();
    /* A visible bug rather than a silent one. A record with no owner is a
       record that will be shown to the wrong Passport. */
    expect(() => saveAliasRecord(registered(undefined, 'alice'))).toThrow(
      /must name the passkey credential/i,
    );
  });

  it('refuses a credential id that is not text', async () => {
    const { saveAliasRecord } = await store();
    /* It would key the record under `"[object Object]::stagenet"` and lose it. */
    expect(() =>
      saveAliasRecord({
        ...registered(ALICE, 'alice'),
        credentialId: { id: 1 } as unknown as string,
      }),
    ).toThrow(/credential id must be text/i);
  });

  it('still refuses a registered record with no transaction ids', async () => {
    const { saveAliasRecord } = await store();
    const record = registered(ALICE, 'alice');
    delete record.registerTxId;
    expect(() => saveAliasRecord(record)).toThrow(/both the resolver deployment/i);
  });

  it('still refuses a queued record that does not explain itself', async () => {
    const { saveAliasRecord } = await store();
    expect(() =>
      saveAliasRecord({ ...registered(ALICE, 'alice'), status: 'queued' }),
    ).toThrow(/queuedReason/);
  });

  it('refuses a record with no name, domain, or network', async () => {
    const { saveAliasRecord } = await store();
    expect(() =>
      saveAliasRecord({ ...registered(ALICE, 'alice'), network: 7 as unknown as string }),
    ).toThrow(/must carry the name/i);
  });

  it('refuses a status that is not one of the three', async () => {
    const { saveAliasRecord } = await store();
    expect(() =>
      saveAliasRecord({
        ...registered(ALICE, 'alice'),
        status: 'pending' as unknown as AliasRecord['status'],
      }),
    ).toThrow(/registered, queued, or failed/i);
  });

  it('lets a recovered record through without transaction ids', async () => {
    const { saveAliasRecord, loadAliasRecord } = await store();
    /* Read off a passkey or out of the registry by a browser that holds
       nothing: there are no ids to carry, and refusing it would leave the one
       device that needs the name most as the one not allowed to keep it. */
    saveAliasRecord({
      credentialId: ALICE,
      alias: 'alice',
      domain: 'alice.night',
      network: 'stagenet',
      status: 'registered',
      recovered: true,
    });
    expect(loadAliasRecord(ALICE, 'stagenet')?.recovered).toBe(true);
  });

  it('stamps a date when the record carries none, and keeps one it does', async () => {
    const { saveAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    expect(loadAliasRecord(ALICE, 'stagenet')?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    saveAliasRecord({ ...registered(ALICE, 'alice'), updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(loadAliasRecord(ALICE, 'stagenet')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('survives a browser that will not store anything', async () => {
    installFailingStorage();
    const { saveAliasRecord } = await store();
    /* The claim still happened; only the memory of it is lost on reload. A
       throw here would turn a storage quota into a failed registration. */
    expect(() => saveAliasRecord(registered(ALICE, 'alice'))).not.toThrow();
  });
});

describe('reading a storage this browser will not hand over', () => {
  it('reads as empty rather than throwing', async () => {
    installUnreadableStorage();
    const { loadAliasRecords, loadAliasRecord } = await store();
    expect(loadAliasRecords()).toEqual({});
    expect(loadAliasRecord(ALICE, 'stagenet')).toBeNull();
  });

  it('reads corrupt or non-object storage as empty', async () => {
    const { loadAliasRecords } = await store();
    window.localStorage.setItem('passport-alias:v1', 'not json at all');
    expect(loadAliasRecords()).toEqual({});
    window.localStorage.setItem('passport-alias:v1', '"a string"');
    expect(loadAliasRecords()).toEqual({});
    window.localStorage.setItem('passport-alias:v1', 'null');
    expect(loadAliasRecords()).toEqual({});
  });

  it('drops a stored entry that is not a record', async () => {
    const { loadAliasRecords } = await store();
    window.localStorage.setItem(
      'passport-alias:v1',
      JSON.stringify({
        stagenet: null,
        preview: { alias: 5, domain: 'x.night', network: 'preview', status: 'registered' },
        preprod: { alias: 'a', domain: 'a.night', network: 'preprod', status: 'invented' },
      }),
    );
    expect(loadAliasRecords()).toEqual({});
  });

  it('reads a bare key as the network it used to be, and refuses to guess one from a compound key', async () => {
    const { loadAliasRecords } = await store();
    /* The old reader repaired a missing network from the key, which WAS the
       network. A compound key is not one, and calling `"cred-alice::stagenet"`
       a network would put that string on a screen. */
    window.localStorage.setItem(
      'passport-alias:v1',
      JSON.stringify({
        stagenet: { alias: 'old', domain: 'old.night', status: 'registered' },
        [`${ALICE}::stagenet`]: { alias: 'new', domain: 'new.night', status: 'registered' },
      }),
    );
    const records = loadAliasRecords();
    expect(records.stagenet?.network).toBe('stagenet');
    expect(Object.hasOwn(records, `${ALICE}::stagenet`)).toBe(false);
  });

  it('drops a credential id that is not text rather than keying on it', async () => {
    const { loadAliasRecords } = await store();
    window.localStorage.setItem(
      'passport-alias:v1',
      JSON.stringify({
        stagenet: { ...registered(undefined, 'alice'), credentialId: 42 },
      }),
    );
    expect(loadAliasRecords().stagenet?.credentialId).toBeUndefined();
  });
});

describe('adoptLegacyAliasRecords', () => {
  it('gives a legacy name to the credential that holds the account it names', async () => {
    const { adoptLegacyAliasRecords, loadAliasRecord } = await store();
    seed({ stagenet: registered(undefined, 'oldname') });

    /* A claim registers the name and deploys the account in one ceremony, so a
       contract record here — which HAS always been per credential — is this
       browser's own witness that this credential was the claimant. */
    expect(
      adoptLegacyAliasRecords(ALICE, { networks: ['stagenet'], soleProfile: false }),
    ).toEqual(['stagenet']);
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('oldname');
  });

  it('gives a legacy name to the only Passport in the browser', async () => {
    const { adoptLegacyAliasRecords, loadAliasRecord } = await store();
    seed({ stagenet: registered(undefined, 'oldname') });

    /* The overwhelmingly common upgrade: one passkey, one name, claimed before
       this keying existed. There is no other credential it could have belonged
       to, so nothing is being guessed. */
    expect(adoptLegacyAliasRecords(ALICE, { networks: [], soleProfile: true })).toEqual([
      'stagenet',
    ]);
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('oldname');
  });

  it('gives a legacy name to a credential that can show no claim to it', async () => {
    const { adoptLegacyAliasRecords, loadAliasRecord, loadAliasRecords } = await store();
    seed({ stagenet: registered(undefined, 'oldname') });

    /* THE ORPHAN, REFUSED. This is the passkey enrolled seconds ago on a
       browser that already held another Passport: no contract of its own, and
       not the only profile here. Handing it the name is the reported defect,
       and it is exactly what "give it to whoever signs in" would do. */
    expect(adoptLegacyAliasRecords(BOB, { networks: [], soleProfile: false })).toEqual([]);
    expect(loadAliasRecord(BOB, 'stagenet')).toBeNull();
    /* And the record is INTACT, not deleted. A second passkey signing in must
       not be able to destroy the first one's name. */
    expect(loadAliasRecords().stagenet?.alias).toBe('oldname');
  });

  it('adopts only the networks the credential holds an account on', async () => {
    const { adoptLegacyAliasRecords, loadAliasRecord, loadAliasRecords } = await store();
    seed({
      stagenet: registered(undefined, 'mine', 'stagenet'),
      preview: registered(undefined, 'theirs', 'preview'),
    });

    expect(
      adoptLegacyAliasRecords(ALICE, { networks: ['stagenet'], soleProfile: false }),
    ).toEqual(['stagenet']);
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('mine');
    expect(loadAliasRecord(ALICE, 'preview')).toBeNull();
    expect(loadAliasRecords().preview?.alias).toBe('theirs');
  });

  it('never overwrites a name this credential claimed under this build', async () => {
    const { adoptLegacyAliasRecords, saveAliasRecord, loadAliasRecord, loadAliasRecords } =
      await store();
    saveAliasRecord(registered(ALICE, 'current'));
    seed({
      ...loadAliasRecords(),
      stagenet: registered(undefined, 'oldname'),
    });

    /* A name this credential claimed and watched being registered is better
       evidence than one nobody labelled. */
    expect(adoptLegacyAliasRecords(ALICE, { networks: ['stagenet'], soleProfile: true })).toEqual(
      [],
    );
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('current');
  });

  it('leaves an already-owned record alone', async () => {
    const { adoptLegacyAliasRecords, saveAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(BOB, 'bob'));
    expect(adoptLegacyAliasRecords(ALICE, { networks: ['stagenet'], soleProfile: true })).toEqual(
      [],
    );
    expect(loadAliasRecord(BOB, 'stagenet')?.alias).toBe('bob');
  });

  it('is a no-op on a browser holding nothing legacy', async () => {
    const { adoptLegacyAliasRecords } = await store();
    expect(adoptLegacyAliasRecords(ALICE, { networks: ['stagenet'], soleProfile: true })).toEqual(
      [],
    );
  });

  it('offers the record again next time when storage refuses the write', async () => {
    installFailingStorage({ stagenet: registered(undefined, 'oldname') });
    const { adoptLegacyAliasRecords } = await store();
    /* Reported as adopted only if it was WRITTEN would be the better contract,
       but the read-back costs a second parse on every sign-in for a case that
       resolves itself: the record stays legacy and is offered again. What must
       not happen is a throw, which would cost the user their sign-in. */
    expect(() =>
      adoptLegacyAliasRecords(ALICE, { networks: [], soleProfile: true }),
    ).not.toThrow();
  });
});

describe('forgetting what this device holds', () => {
  it('forgets one credential\'s names and leaves every other credential alone', async () => {
    const { saveAliasRecord, forgetAliasRecordsForCredential, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice', 'stagenet'));
    saveAliasRecord(registered(ALICE, 'alicetoo', 'preview'));
    saveAliasRecord(registered(BOB, 'bob', 'stagenet'));

    /* The alias half of "set up a new Passport on this device" — the way out a
       reviewer had none of. The names are on chain; this is only what the
       browser remembers about them. */
    expect(forgetAliasRecordsForCredential(ALICE).sort()).toEqual(['preview', 'stagenet']);
    expect(loadAliasRecord(ALICE, 'stagenet')).toBeNull();
    expect(loadAliasRecord(ALICE, 'preview')).toBeNull();
    /* Starting again on a phone that holds two Passports costs the other one
       nothing. */
    expect(loadAliasRecord(BOB, 'stagenet')?.alias).toBe('bob');
  });

  it('forgets the records that name nobody, so starting clean stays clean', async () => {
    const { forgetLegacyAliasRecords, adoptLegacyAliasRecords, loadAliasRecords, loadAliasRecord } =
      await store();
    seed({ stagenet: registered(undefined, 'oldname') });

    /* THE HOLE THIS CLOSES. Forgetting one credential's records leaves an
       unlabelled one untouched, and the new passkey that follows is then the
       only Passport in the browser — one of the two claims adoption accepts.
       The person who asked to start clean would have been handed the old name
       straight back on their very next sign-in. */
    expect(forgetLegacyAliasRecords()).toEqual(['stagenet']);
    expect(loadAliasRecords()).toEqual({});
    expect(adoptLegacyAliasRecords(BOB, { networks: [], soleProfile: true })).toEqual([]);
    expect(loadAliasRecord(BOB, 'stagenet')).toBeNull();
  });

  it('leaves a labelled record alone when it forgets the unlabelled ones', async () => {
    const { saveAliasRecord, forgetLegacyAliasRecords, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice', 'preview'));
    seed({
      [`${ALICE}::preview`]: registered(ALICE, 'alice', 'preview'),
      stagenet: registered(undefined, 'oldname'),
    });

    expect(forgetLegacyAliasRecords()).toEqual(['stagenet']);
    expect(loadAliasRecord(ALICE, 'preview')?.alias).toBe('alice');
  });

  it('forgets nothing when every record names its owner', async () => {
    const { saveAliasRecord, forgetLegacyAliasRecords } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    expect(forgetLegacyAliasRecords()).toEqual([]);
  });

  it('does not throw when a legacy removal cannot be recorded', async () => {
    installFailingStorage({ stagenet: registered(undefined, 'oldname') });
    const { forgetLegacyAliasRecords } = await store();
    expect(() => forgetLegacyAliasRecords()).not.toThrow();
  });

  it('forgets nothing for a credential that holds nothing', async () => {
    const { forgetAliasRecordsForCredential } = await store();
    expect(forgetAliasRecordsForCredential(ALICE)).toEqual([]);
  });

  it('does not throw when storage refuses to record the removal', async () => {
    installFailingStorage({ [`${ALICE}::stagenet`]: registered(ALICE, 'alice') });
    const { forgetAliasRecordsForCredential } = await store();
    /* The records outlive this, which is the safe direction: a way out that
       throws leaves the user exactly where they were, with an error. */
    expect(() => forgetAliasRecordsForCredential(ALICE)).not.toThrow();
  });

  it('removes one credential\'s record on one network', async () => {
    const { saveAliasRecord, removeAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    saveAliasRecord(registered(BOB, 'bob'));

    removeAliasRecord(ALICE, 'stagenet');
    expect(loadAliasRecord(ALICE, 'stagenet')).toBeNull();
    expect(loadAliasRecord(BOB, 'stagenet')?.alias).toBe('bob');
  });

  it('removes nothing when there is nothing under that key', async () => {
    const { saveAliasRecord, removeAliasRecord, loadAliasRecord } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    removeAliasRecord(BOB, 'stagenet');
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('alice');
  });

  it('does not throw when a removal cannot be recorded', async () => {
    installFailingStorage({ [`${ALICE}::stagenet`]: registered(ALICE, 'alice') });
    const { removeAliasRecord } = await store();
    expect(() => removeAliasRecord(ALICE, 'stagenet')).not.toThrow();
  });

  it('clears every record in the browser', async () => {
    const { saveAliasRecord, clearAliasRecords, loadAliasRecords } = await store();
    saveAliasRecord(registered(ALICE, 'alice'));
    clearAliasRecords();
    expect(loadAliasRecords()).toEqual({});
  });

  it('does not throw when there is no storage to clear', async () => {
    installUnreadableStorage();
    const { clearAliasRecords } = await store();
    expect(() => clearAliasRecords()).not.toThrow();
  });
});

describe('restoreAliasRecords', () => {
  it('files a record under the credential the RECORD names, never a caller\'s key', async () => {
    const { restoreAliasRecords, loadAliasRecord } = await store();
    const [outcome] = restoreAliasRecords([registered(ALICE, 'alice')]);

    /* The rule `./passportContractStore.ts` has always kept, and the reason a
       backup file cannot file somebody else's name under this credential. */
    expect(outcome).toEqual({ key: `${ALICE}::stagenet`, network: 'stagenet', written: true });
    expect(loadAliasRecord(ALICE, 'stagenet')?.alias).toBe('alice');
    expect(loadAliasRecord(BOB, 'stagenet')).toBeNull();
  });

  it('writes a credential-less record as legacy rather than refusing it', async () => {
    const { restoreAliasRecords, loadAliasRecords, loadAliasRecord } = await store();
    const [outcome] = restoreAliasRecords([registered(undefined, 'oldname')]);

    /* A file written before 2026/09/04 carries no credential. It restores, under
       the bare key, where it waits for an owner — rather than being dropped,
       which would make the restore path itself lose names. */
    expect(outcome?.key).toBe('stagenet');
    expect(loadAliasRecords().stagenet?.alias).toBe('oldname');
    expect(loadAliasRecord(ALICE, 'stagenet')).toBeNull();
  });

  it('reports the refusal per record and writes the rest', async () => {
    const { restoreAliasRecords, loadAliasRecord } = await store();
    const bad = registered(ALICE, 'bad');
    delete bad.registerTxId;
    const outcomes = restoreAliasRecords([bad, registered(BOB, 'bob')]);

    expect(outcomes[0]?.written).toBe(false);
    expect(outcomes[0]?.reason).toMatch(/transaction ids/);
    expect(outcomes[1]?.written).toBe(true);
    expect(loadAliasRecord(BOB, 'stagenet')?.alias).toBe('bob');
  });

  it('keeps the record\'s own date, or none, and stamps when the restore ran', async () => {
    const { restoreAliasRecords, loadAliasRecord } = await store();
    restoreAliasRecords([registered(ALICE, 'alice')]);
    const stored = loadAliasRecord(ALICE, 'stagenet');
    /* Never the moment of the restore: an invented date outranked the user's
       own genuine backup for good. `restoredAt` is a fact about the browser. */
    expect(stored?.updatedAt).toBeUndefined();
    expect(stored?.restoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does nothing at all when nothing could be staged', async () => {
    const { restoreAliasRecords } = await store();
    expect(restoreAliasRecords([])).toEqual([]);
  });

  it('reports a write this browser refused as not written', async () => {
    installFailingStorage();
    const { restoreAliasRecords } = await store();
    const [outcome] = restoreAliasRecords([registered(ALICE, 'alice')]);
    /* A caller that counts writes must count what SURVIVED, not what was
       attempted. */
    expect(outcome?.written).toBe(false);
    expect(outcome?.reason).toMatch(/refused to store/);
  });

  it('carries the reason even when the browser throws something that is not an Error', async () => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => map.get(key) ?? null,
          /* Some embedded browsers throw a bare string. The reason must
             still reach the caller as words, rather than as "[object Object]",
             which is the whole point of this test — so the throw is genuinely
             not an Error and cannot be written as one. */
          setItem: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'SecurityError';
          },
          removeItem: () => undefined,
        },
      },
    });
    const { restoreAliasRecords } = await store();
    const [outcome] = restoreAliasRecords([registered(ALICE, 'alice')]);
    expect(outcome?.written).toBe(false);
    expect(outcome?.reason).toContain('SecurityError');
  });

  it('reports a record that was stored and did not read back', async () => {
    installDroppingStorage();
    const { restoreAliasRecords } = await store();
    const [outcome] = restoreAliasRecords([registered(ALICE, 'alice')]);
    /* A `setItem` that neither throws nor keeps anything is a real browser
       behaviour, and it is the one a count would otherwise report as a
       success. The store reads back before it says a record was written. */
    expect(outcome?.written).toBe(false);
    expect(outcome?.reason).toMatch(/did not read back/);
  });
});

describe('subscribeAliasRecords', () => {
  it('publishes the whole map on every write, and stops on unsubscribe', async () => {
    const { subscribeAliasRecords, saveAliasRecord } = await store();
    const seen: Record<string, AliasRecord>[] = [];
    const stop = subscribeAliasRecords((records) => seen.push(records));

    saveAliasRecord(registered(ALICE, 'alice'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[`${ALICE}::stagenet`]?.alias).toBe('alice');

    stop();
    saveAliasRecord(registered(BOB, 'bob'));
    expect(seen).toHaveLength(1);
  });
});
