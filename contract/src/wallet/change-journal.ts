import type { QualifiedCoin, ShieldedCoin } from './contract.js';
import { bytesToHex, hexToBytes } from './hex.js';

/** Privacy-sensitive coin data. Store this journal with the same protection as private state. */
export interface JournalCoin {
  nonceHex: string;
  colorHex: string;
  value: string;
  mtIndex?: string;
}

export interface ChangeIntent {
  circuitId: string;
  input: QualifiedCoin;
  recipient: Uint8Array;
  amount: bigint;
  recovery: { mode: 'owner' } | { mode: 'grant'; entry: Uint8Array };
}

export type ChangeStage = 'preparing' | 'prepared' | 'submitting' | 'succeeded'
  | 'partial' | 'rejected' | 'cancelled' | 'complete';

export interface ChangeJournalEntry {
  id: string;
  circuitId: string;
  input: JournalCoin;
  recipientHex: string;
  amount: string;
  stage: ChangeStage;
  transactionIds: string[];
  /** Undefined before preparation; null denotes an exact spend. */
  change?: JournalCoin | null;
  qualifiedChange?: JournalCoin;
  adopted: boolean;
  recovery: {
    mode: 'owner' | 'grant';
    status: 'pending' | 'unverified' | 'recorded' | 'complete';
    /** Exact ciphertext has been observed in the contract inbox. */
    recorded?: boolean;
    entryHex?: string;
    backfill?: { stage: 'prepared' | 'submitting' | 'succeeded' | 'partial' | 'rejected'; transactionIds: string[] };
  };
}

export interface ChangeJournal {
  version: 1;
  scope: string;
  entries: ChangeJournalEntry[];
}

/** Each set must durably and atomically replace one snapshot before resolving. Single writer only. */
export interface ChangeJournalStore {
  get(scope: string): Promise<ChangeJournal | null | undefined>;
  set(scope: string, journal: ChangeJournal): Promise<void>;
}

export interface PreparedChangeTransaction {
  /** All identifiers of the final, balanced transaction, before submission. */
  transactionIds: string[];
  change: ShieldedCoin | null;
  /** Circuit result in the account call shape, without a private-state write. */
  result: any;
  /** Submit exactly this prepared transaction once. No retries or private-state writes. */
  submit(): Promise<unknown>;
}

export interface TransactionObservation {
  status: 'succeeded' | 'partial' | 'rejected' | 'unknown';
  /** Identifiers actually returned by the authoritative observation. */
  transactionIds: string[];
}

/** Adapter must validate current-era records and qualify actual commitment membership. */
export interface DurableTransactionAdapter {
  prepare(circuitId: string, args: unknown[]): Promise<PreparedChangeTransaction>;
  observe(transactionIds: string[]): Promise<TransactionObservation>;
  qualify(change: ShieldedCoin, transactionIds: string[]): Promise<QualifiedCoin>;
}

export interface ChangeCoordinatorHooks {
  observe: DurableTransactionAdapter['observe'];
  qualify: DurableTransactionAdapter['qualify'];
  /** Idempotently merge into current private state; never apply a stale full snapshot. */
  adopt(input: QualifiedCoin, change: QualifiedCoin | null): Promise<void>;
  seal(change: ShieldedCoin): Promise<Uint8Array>;
  findInboxEntry(entry: Uint8Array): Promise<boolean>;
  /** False includes an unavailable viewing secret. It never authorises a duplicate append. */
  verifyInboxEntry(entry: Uint8Array, change: ShieldedCoin): Promise<boolean>;
}

export type PrepareBackfill = (entry: Uint8Array) => Promise<PreparedChangeTransaction>;

export class DurableChangePendingError extends Error {
  constructor(readonly entry: ChangeJournalEntry) {
    super(`durable change operation ${entry.id} requires reconciliation (${entry.stage})`);
    this.name = 'DurableChangePendingError';
  }
}

const activeScopes = new Set<string>();
const terminal = (entry: ChangeJournalEntry) => ['complete', 'rejected', 'cancelled'].includes(entry.stage);
const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const decimal = (value: unknown, bits: number): value is string => typeof value === 'string'
  && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < (1n << BigInt(bits));
const hex = (value: unknown, size: number): value is string => typeof value === 'string'
  && new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value);

export function journalCoin(coin: ShieldedCoin | QualifiedCoin): JournalCoin {
  const result: JournalCoin = { nonceHex: bytesToHex(coin.nonce), colorHex: bytesToHex(coin.color), value: coin.value.toString() };
  if ('mt_index' in coin) result.mtIndex = coin.mt_index.toString();
  validateCoin(result, 'mt_index' in coin);
  return result;
}

export function restoreJournalCoin(coin: JournalCoin): QualifiedCoin {
  validateCoin(coin, false);
  return { nonce: hexToBytes(coin.nonceHex), color: hexToBytes(coin.colorHex), value: BigInt(coin.value), mt_index: BigInt(coin.mtIndex ?? '0') };
}

function validateCoin(coin: JournalCoin, qualified: boolean): void {
  if (!coin || !hex(coin.nonceHex, 32) || !hex(coin.colorHex, 32) || !decimal(coin.value, 128)
    || (coin.mtIndex !== undefined && !decimal(coin.mtIndex, 64)) || (qualified && coin.mtIndex === undefined)) {
    throw new Error('invalid durable journal coin');
  }
}

function identifiers(ids: string[]): void {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.length || id.length > 256)
    || new Set(ids).size !== ids.length) throw new Error('invalid durable transaction identifiers');
}

function validateJournal(value: ChangeJournal, scope: string): void {
  if (!value || value.version !== 1 || value.scope !== scope || !Array.isArray(value.entries)) throw new Error('invalid durable change journal scope or version');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || typeof entry.circuitId !== 'string' || !entry.circuitId || !hex(entry.recipientHex, 32)
      || !decimal(entry.amount, 128) || !['preparing', 'prepared', 'submitting', 'succeeded', 'partial', 'rejected', 'cancelled', 'complete'].includes(entry.stage)
      || typeof entry.adopted !== 'boolean' || !Array.isArray(entry.transactionIds)
      || !entry.recovery || !['owner', 'grant'].includes(entry.recovery.mode)
      || !['pending', 'unverified', 'recorded', 'complete'].includes(entry.recovery.status)) throw new Error('invalid durable change journal entry');
    seen.add(entry.id);
    validateCoin(entry.input, true);
    if (BigInt(entry.amount) > BigInt(entry.input.value)) throw new Error('durable spend exceeds its exact input');
    if (entry.change !== undefined && entry.change !== null) validateCoin(entry.change, false);
    if (entry.qualifiedChange) validateCoin(entry.qualifiedChange, true);
    if (entry.transactionIds.length) identifiers(entry.transactionIds);
    if (!['preparing', 'cancelled'].includes(entry.stage) && (!entry.transactionIds.length || entry.change === undefined)) throw new Error('incomplete durable prepared transaction');
    if (entry.change !== undefined) {
      const remaining = BigInt(entry.input.value) - BigInt(entry.amount);
      if ((entry.change === null && remaining !== 0n) || (entry.change && (BigInt(entry.change.value) !== remaining
        || remaining === 0n || entry.change.colorHex !== entry.input.colorHex || entry.change.nonceHex === entry.input.nonceHex))) throw new Error('durable change does not match the intended spend');
    }
    if (entry.qualifiedChange && (!entry.change || entry.qualifiedChange.nonceHex !== entry.change.nonceHex
      || entry.qualifiedChange.colorHex !== entry.change.colorHex || entry.qualifiedChange.value !== entry.change.value)) throw new Error('invalid qualified durable change identity');
    if (entry.adopted && (!['succeeded', 'complete'].includes(entry.stage) || (entry.change && !entry.qualifiedChange))) throw new Error('invalid durable adoption checkpoint');
    if (entry.stage === 'complete' && (!entry.adopted || (entry.recovery.status !== 'complete'
      && !(entry.recovery.mode === 'grant' && entry.recovery.status === 'unverified' && entry.recovery.recorded === true)))) throw new Error('invalid durable completion checkpoint');
    if (entry.recovery.entryHex !== undefined && !hex(entry.recovery.entryHex, 192)) throw new Error('invalid durable inbox entry');
    if (entry.recovery.mode === 'grant' && !entry.recovery.entryHex) throw new Error('missing durable grant entry');
    if (entry.recovery.backfill) {
      if (!['prepared', 'submitting', 'succeeded', 'partial', 'rejected'].includes(entry.recovery.backfill.stage)) throw new Error('invalid durable backfill stage');
      identifiers(entry.recovery.backfill.transactionIds);
    }
  }
}

/** Journalled state machine. It never resubmits a spend after a submission checkpoint. */
export class DurableChangeCoordinator {
  constructor(readonly scope: string, readonly store: ChangeJournalStore, readonly hooks: ChangeCoordinatorHooks) {
    if (!scope || !store || !hooks) throw new Error('durable change scope, store, and hooks are required');
  }

  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    if (activeScopes.has(this.scope)) throw new Error('durable change journal is busy with another operation');
    activeScopes.add(this.scope);
    try { return await action(); } finally { activeScopes.delete(this.scope); }
  }

  private async read(): Promise<ChangeJournal> {
    const journal = detached(await this.store.get(this.scope) ?? { version: 1 as const, scope: this.scope, entries: [] });
    validateJournal(journal, this.scope);
    return journal;
  }

  private async save(journal: ChangeJournal): Promise<void> {
    validateJournal(journal, this.scope);
    await this.store.set(this.scope, detached(journal));
  }

  async list(): Promise<ChangeJournalEntry[]> { return (await this.read()).entries; }

  async assertAvailable(): Promise<void> {
    return this.guarded(async () => {
      const entries = await this.list();
      const pending = entries.find(entry => !terminal(entry));
      if (pending) throw new DurableChangePendingError(pending);
      for (const entry of entries) if (entry.stage === 'complete') await this.replayAdoption(entry);
    });
  }

  async execute(intent: ChangeIntent, prepare: () => Promise<PreparedChangeTransaction>, backfill?: PrepareBackfill): Promise<{ result: any; entry: ChangeJournalEntry }> {
    return this.guarded(async () => {
      const journal = await this.read();
      const pending = journal.entries.find(entry => !terminal(entry));
      if (pending) throw new DurableChangePendingError(detached(pending));
      for (const complete of journal.entries) if (complete.stage === 'complete') await this.replayAdoption(complete);
      const entry: ChangeJournalEntry = {
        id: globalThis.crypto.randomUUID(), circuitId: intent.circuitId,
        input: journalCoin(intent.input), recipientHex: bytesToHex(intent.recipient), amount: intent.amount.toString(),
        stage: 'preparing', transactionIds: [], adopted: false,
        recovery: { mode: intent.recovery.mode, status: 'pending',
          ...(intent.recovery.mode === 'grant' ? { entryHex: bytesToHex(intent.recovery.entry) } : {}) },
      };
      journal.entries.push(entry);
      await this.save(journal);
      let prepared: PreparedChangeTransaction;
      try {
        prepared = await prepare();
        identifiers(prepared.transactionIds);
        entry.transactionIds = [...prepared.transactionIds];
        entry.change = prepared.change ? journalCoin(prepared.change) : null;
        if (entry.change && entry.recovery.mode === 'grant') {
          // An available viewing key can reject an incorrectly encrypted grant
          // before sending. An unavailable key leaves recovery unverified.
          const verified = await this.hooks.verifyInboxEntry(hexToBytes(entry.recovery.entryHex!), restoreJournalCoin(entry.change));
          if (!verified) entry.recovery.status = 'unverified';
        }
      } catch (error) {
        entry.stage = 'cancelled';
        entry.transactionIds = [];
        delete entry.change;
        await this.save(journal);
        throw error;
      }
      entry.stage = 'prepared';
      await this.save(journal);
      entry.stage = 'submitting';
      await this.save(journal);
      // Any error here is ambiguous. Preserve the identity and reservation.
      await prepared.submit();
      await this.advance(journal, entry, backfill);
      if (!['succeeded', 'complete'].includes(entry.stage)) throw new DurableChangePendingError(detached(entry));
      return { result: prepared.result, entry: detached(entry) };
    });
  }

  async reconcile(backfill?: PrepareBackfill): Promise<ChangeJournalEntry[]> {
    return this.guarded(async () => {
      const journal = await this.read();
      for (const entry of journal.entries) {
        if (entry.stage === 'complete') {
          await this.replayAdoption(entry);
          if (entry.recovery.mode === 'grant' && entry.recovery.status === 'unverified' && entry.change
            && await this.hooks.verifyInboxEntry(hexToBytes(entry.recovery.entryHex!), restoreJournalCoin(entry.change))) {
            entry.recovery.status = 'complete';
            await this.save(journal);
          }
        } else if (entry.stage === 'preparing' || entry.stage === 'prepared') {
          // No submit call can occur before the submitting checkpoint resolves.
          entry.stage = 'cancelled';
          await this.save(journal);
        } else if (!terminal(entry)) await this.advance(journal, entry, backfill);
      }
      return detached(journal.entries);
    });
  }

  private async replayAdoption(entry: ChangeJournalEntry): Promise<void> {
    // The journal can outlive a private-state write after power loss. Replaying
    // confirmed transitions restores its cache without reviving later inputs.
    await this.hooks.adopt(restoreJournalCoin(entry.input), entry.qualifiedChange ? restoreJournalCoin(entry.qualifiedChange) : null);
  }

  private async observation(ids: string[]): Promise<TransactionObservation['status']> {
    const result = await this.hooks.observe([...ids]);
    if (!result || !['succeeded', 'partial', 'rejected', 'unknown'].includes(result.status)) throw new Error('invalid durable transaction observation');
    if (result.status !== 'unknown') {
      identifiers(result.transactionIds);
      if (!result.transactionIds.some(id => ids.includes(id))) throw new Error('durable transaction observation identity mismatch');
    }
    return result.status;
  }

  private async advance(journal: ChangeJournal, entry: ChangeJournalEntry, backfill?: PrepareBackfill): Promise<void> {
    if (entry.stage === 'submitting') {
      const status = await this.observation(entry.transactionIds);
      if (status === 'unknown') return;
      entry.stage = status;
      await this.save(journal);
    }
    // Partial execution cannot establish whether this exact input remains live.
    // It stays reserved until authoritative live/spent reconstruction exists.
    if (entry.stage !== 'succeeded') return;
    if (entry.change && !entry.qualifiedChange) {
      const qualified = journalCoin(await this.hooks.qualify(restoreJournalCoin(entry.change), [...entry.transactionIds]));
      validateCoin(qualified, true);
      if (qualified.nonceHex !== entry.change.nonceHex || qualified.colorHex !== entry.change.colorHex || qualified.value !== entry.change.value) throw new Error('qualified change does not match the durable circuit result');
      entry.qualifiedChange = qualified;
      await this.save(journal);
    }
    await this.replayAdoption(entry);
    if (!entry.adopted) {
      entry.adopted = true;
      await this.save(journal);
    }
    if (!entry.change) {
      entry.recovery.status = 'complete';
      entry.stage = 'complete';
      await this.save(journal);
      return;
    }
    if (!entry.recovery.entryHex) {
      entry.recovery.entryHex = bytesToHex(await this.hooks.seal(restoreJournalCoin(entry.change)));
      await this.save(journal);
    }
    const ciphertext = hexToBytes(entry.recovery.entryHex);
    const verified = await this.hooks.verifyInboxEntry(ciphertext.slice(), restoreJournalCoin(entry.change));
    if (await this.hooks.findInboxEntry(ciphertext.slice())) {
      const current = await this.hooks.verifyInboxEntry(ciphertext.slice(), restoreJournalCoin(entry.change));
      entry.recovery.recorded = true;
      entry.recovery.status = current ? 'complete' : 'unverified';
      if (current || entry.recovery.mode === 'grant') entry.stage = 'complete';
      await this.save(journal);
      return;
    }
    if (entry.recovery.mode === 'grant') {
      entry.recovery.status = verified ? 'pending' : 'unverified';
      await this.save(journal);
      return;
    }
    if (!verified) {
      entry.recovery.status = 'unverified';
      await this.save(journal);
      return;
    }
    const prior = entry.recovery.backfill;
    if (prior?.stage === 'submitting') {
      const status = await this.observation(prior.transactionIds);
      if (status === 'unknown') return;
      prior.stage = status;
      await this.save(journal);
      if (status !== 'rejected') return;
    } else if (prior?.stage === 'succeeded' || prior?.stage === 'partial') return;
    if (!backfill) return;
    const prepared = await backfill(ciphertext.slice());
    identifiers(prepared.transactionIds);
    entry.recovery.backfill = { stage: 'prepared', transactionIds: [...prepared.transactionIds] };
    await this.save(journal);
    entry.recovery.backfill.stage = 'submitting';
    await this.save(journal);
    await prepared.submit();
    const status = await this.observation(entry.recovery.backfill.transactionIds);
    if (status !== 'unknown') {
      entry.recovery.backfill.stage = status;
      await this.save(journal);
    }
    if (await this.hooks.findInboxEntry(ciphertext.slice())) {
      const current = await this.hooks.verifyInboxEntry(ciphertext.slice(), restoreJournalCoin(entry.change));
      entry.recovery.recorded = true;
      entry.recovery.status = current ? 'complete' : 'unverified';
      if (current) entry.stage = 'complete';
      await this.save(journal);
    }
  }
}
