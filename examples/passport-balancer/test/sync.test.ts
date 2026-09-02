/**
 * "Synced" and "synced enough", and the four and a half minutes between them.
 *
 * On 2026/09/02 every spend this service made was followed by 2–4.5 minutes in
 * which the wallet reported `syncState: "syncing"` with
 * `unshielded applied 9549 > highest 9521`, `/wallet-status` answered
 * `available: 0`, `/status` answered `ready: false`, and a second Passport
 * arriving twenty seconds after the first was refused in two seconds by the
 * client's non-waiting preflight — 3/3 attempts. Nothing was wrong with the
 * wallet. It had applied its OWN submission before the indexer's next progress
 * announcement counted it, and the SDK's completeness test is an ABSOLUTE lag:
 *
 *     applyLag = |highestTransactionId - appliedId|;  complete = connected && applyLag <= 0
 *
 * so being one ahead scores exactly as incomplete as being one behind. These
 * cases pin the distinction: ahead is synced, behind is not, and a dropped
 * subscription is not synced however the indices read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessHealth, type HealthFacts } from '../src/health.js';
import {
  isEffectivelySynced,
  syncAheadDetail,
  type SyncSnapshotProgress,
  type WalletProgress,
} from '../src/wallet.js';

const leg = (overrides: Partial<WalletProgress> = {}): WalletProgress => ({
  applied: '9521',
  highestRelevant: '9521',
  highest: '9521',
  connected: true,
  complete: true,
  ...overrides,
});

const progress = (overrides: Partial<SyncSnapshotProgress> = {}): SyncSnapshotProgress => ({
  isSynced: true,
  shielded: leg(),
  unshielded: leg(),
  dust: leg(),
  ...overrides,
});

/** The live reading, verbatim: the unshielded leg one submission ahead. */
const afterOurOwnSpend = (): SyncSnapshotProgress =>
  progress({
    isSynced: false,
    unshielded: leg({ applied: '9549', highestRelevant: '9521', highest: '9521', complete: false }),
  });

describe('synced enough to select coins', () => {
  it('takes the SDK’s own verdict when it says synced', () => {
    assert.equal(isEffectivelySynced(progress()), true);
  });

  it('calls a wallet that applied its own spend ahead of the indexer synced', () => {
    assert.equal(isEffectivelySynced(afterOurOwnSpend()), true);
  });

  it('does NOT call a wallet that is genuinely behind synced', () => {
    const behind = progress({
      isSynced: false,
      dust: leg({ applied: '9400', highestRelevant: '9521', complete: false }),
    });
    assert.equal(isEffectivelySynced(behind), false);
  });

  it('refuses a leg whose indexer subscription has dropped, however it reads', () => {
    const dropped = progress({
      isSynced: false,
      shielded: leg({ applied: '9549', highestRelevant: '9521', complete: false, connected: false }),
    });
    assert.equal(isEffectivelySynced(dropped), false);
  });

  it('needs every leg, not one: ahead on one and behind on another is behind', () => {
    const mixed = progress({
      isSynced: false,
      unshielded: leg({ applied: '9549', highestRelevant: '9521', complete: false }),
      dust: leg({ applied: '9400', highestRelevant: '9521', complete: false }),
    });
    assert.equal(isEffectivelySynced(mixed), false);
  });

  it('treats an unreadable index as not-ahead rather than as synced', () => {
    const nonsense = progress({
      isSynced: false,
      dust: leg({ applied: 'not a number', highestRelevant: '9521', complete: false }),
    });
    assert.equal(isEffectivelySynced(nonsense), false);
  });
});

describe('naming what is ahead', () => {
  it('says which leg and by how much, in the indexer’s own figures', () => {
    assert.equal(syncAheadDetail(afterOurOwnSpend()), 'unshielded applied 9549 > highest 9521');
  });

  it('says nothing about a wallet that is level', () => {
    assert.equal(syncAheadDetail(progress()), null);
  });

  it('says nothing about a wallet that is merely behind', () => {
    const behind = progress({
      isSynced: false,
      dust: leg({ applied: '9400', highestRelevant: '9521', complete: false }),
    });
    assert.equal(syncAheadDetail(behind), null);
  });
});

/**
 * The verdict half. Before this, the watchdog's answer for the whole post-spend
 * window was `busy: a spend job holds the queue — proving, most likely`, which
 * named the wrong thing: nothing was proving.
 */
const facts = (overrides: Partial<HealthFacts> = {}): HealthFacts => ({
  now: 1_800_000_000_000,
  uptimeMs: 3_600_000,
  stateReadable: true,
  synced: true,
  connected: true,
  dustSpecks: 23_464_217_639_022_489_435n,
  utxoCount: 3,
  nightAtomic: 4_998_916_000n,
  dustGenerating: true,
  pendingTransactions: 0,
  proving: 'server',
  reserved: false,
  busy: false,
  syncAhead: null,
  lastSponsorshipAt: 1_800_000_000_000 - 300_000,
  orphans: 0,
  lastStateChangeAt: 1_800_000_000_000 - 60_000,
  consecutiveUnhealthy: 0,
  ...overrides,
});

describe('the verdict on a wallet catching up with its own spend', () => {
  it('says settling, and names the leg rather than guessing at a prover', () => {
    const verdict = assessHealth(
      facts({ syncAhead: 'unshielded applied 9549 > highest 9521', busy: true }),
    );
    assert.equal(verdict.verdict, 'settling');
    assert.match(verdict.reason, /unshielded applied 9549 > highest 9521/);
    assert.match(verdict.reason, /not proving/);
    assert.equal(verdict.act, false);
  });

  it('still mentions the queue when a job really is on it', () => {
    const verdict = assessHealth(facts({ syncAhead: 'dust applied 12 > highest 11', busy: true }));
    assert.match(verdict.reason, /spend job still on the queue/);
  });

  it('does not mention a queue that is empty', () => {
    const verdict = assessHealth(facts({ syncAhead: 'dust applied 12 > highest 11' }));
    assert.equal(verdict.verdict, 'settling');
    assert.doesNotMatch(verdict.reason, /queue/);
  });

  it('leaves a CLAIM on the coin state ahead of it — that wallet is genuinely in use', () => {
    const verdict = assessHealth(
      facts({ syncAhead: 'dust applied 12 > highest 11', reserved: true }),
    );
    assert.equal(verdict.verdict, 'busy');
  });

  it('still says busy for a job with nothing ahead — a real proof', () => {
    const verdict = assessHealth(facts({ busy: true }));
    assert.equal(verdict.verdict, 'busy');
    assert.match(verdict.reason, /proving, most likely/);
  });
});
