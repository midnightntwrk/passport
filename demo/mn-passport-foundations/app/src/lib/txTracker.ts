// Honest transaction-progress tracking. A contract call in this stack runs
// for minutes, in three observable stages:
//
//   build  — circuit execution in the browser (compact-runtime, WASM)
//   prove  — the proof server generates the ZK proof (signalled by the
//            proofProvider.proveTx wrapper in providers.ts)
//   submit — wallet balancing (incl. dust proving), signing, submission,
//            and waiting for the indexer to confirm
//
// One task is active at a time (demo actions are serialised); finished
// tasks are kept so the UI can show the landed tx id.

import { useSyncExternalStore } from 'react';

export type TxPhase = 'build' | 'prove' | 'submit' | 'done' | 'error';

export interface TxTask {
  id: number;
  /** Presenter-facing label, e.g. "Depositing Night". */
  label: string;
  /** Circuit being exercised, e.g. "deposit_night". */
  circuit: string;
  phase: TxPhase;
  startedAt: number;
  phaseAt: number;
  endedAt?: number;
  txId?: string;
  error?: string;
}

let nextId = 1;
let current: TxTask | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function update(patch: Partial<TxTask>) {
  if (!current) return;
  current = { ...current, ...patch, phaseAt: Date.now() };
  emit();
}

export function beginTask(label: string, circuit: string): void {
  current = {
    id: nextId++,
    label,
    circuit,
    phase: 'build',
    startedAt: Date.now(),
    phaseAt: Date.now(),
  };
  emit();
}

export function completeTask(txId?: string): void {
  update({ phase: 'done', txId, endedAt: Date.now() });
}

export function failTask(error: string): void {
  update({ phase: 'error', error, endedAt: Date.now() });
}

export function dismissTask(id: number): void {
  if (current?.id === id) {
    current = null;
    emit();
  }
}

// Called by the proofProvider wrapper — only meaningful mid-task.
export function proveStarted(): void {
  if (current && current.phase === 'build') update({ phase: 'prove' });
}

export function proveEnded(): void {
  if (current && current.phase === 'prove') update({ phase: 'submit' });
}

export function useTxTask(): TxTask | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
