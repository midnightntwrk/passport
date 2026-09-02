/**
 * Un-pending a DUST wallet that the ledger has hidden its own coins from.
 *
 * THE MECHANISM, END TO END
 * -------------------------
 * Every balancing this service does — `/balance-only`'s fee leg and the
 * contract `balanceTx` alike — ends in `CoreWallet.spendCoins`, which calls the
 * ledger's `DustLocalState.spend()`. That call does NOT remove the coin it
 * spends. It sets `pending_until = ctime + dust_grace_period` on the entry —
 * three hours on stagenet — and both `utxos()` and `wallet_balance()` skip
 * entries carrying a `pending_until`. So a wallet that has just balanced
 * anything reads `dust 0 / utxoCount 0` while still holding every Speck it had,
 * and that reading is CORRECT for as long as the transaction might still land.
 *
 * The SDK's own bookkeeping is what should end it. `CoreWallet.spendCoins`
 * pushes the spent coins onto an in-memory `pendingDust` array, and
 * `facade.revert(tx)` → `dust.revertTransaction` → `CoreWallet.applyFailed`
 * un-pends exactly those whose nullifier it still finds there, by calling
 * `state.processTtls(spendTime + grace)`.
 *
 * It does not survive. `CoreWallet.applyEventsWithChanges` filters `pendingDust`
 * down to the nonces present in `updatedState.utxos` — and that getter is the
 * pending-EXCLUDING one — so the first replayed dust event batch after a spend
 * (any block with dust activity, so within about six seconds) empties
 * `pendingDust` while the ledger entries stay pending. A revert arriving after
 * that window finds nothing to un-pend and is a silent no-op. The coins then
 * stay invisible until `pending_until` passes, three hours later.
 *
 * And the snapshot makes it worse rather than better: `serializeState()` writes
 * the ledger state, `pending_until` flags included, and does NOT write
 * `pendingDust`. So a restart resumed from the snapshot comes back wedged AND
 * with the last route to a revert gone. That is why the health ladder —
 * refresh, rewarm, restart-from-snapshot — cleared nothing on 2026/09/02, and
 * why moving the snapshot aside and cold-walking the chain did: a state rebuilt
 * from chain events is a state in which those coins were never spent.
 *
 * WHAT THIS MODULE DOES INSTEAD
 * -----------------------------
 * The one call `applyFailed` should have made, made against the snapshot on
 * disk: `DustLocalState.deserialize(state).processTtls(now + 4 h)`. Four hours
 * clears any grace period started at or before `now` — the flags are always
 * `ctime + 3 h` and `ctime` is in the past — and `processTtls` is also what
 * drops coins that have decayed to nothing, so the repaired state is the state
 * the wallet would have had if the revert had worked.
 *
 * It is a snapshot rewrite rather than a live repair because there is no SDK
 * API to un-pend a running wallet, and `./health.ts` has already established
 * that `WalletFacade.stop()`/`start()` cannot be used in process — the
 * submission service's scope closes and does not reopen. So: rewrite, then let
 * systemd hand the service a new wallet.
 *
 * Pure and chain-free: a string in, a string out, so `test/dustRollback.test.ts`
 * can run the whole repair against the real wedged snapshot from the droplet
 * without a wallet, a node, or a clock.
 */

import * as ledger from '@midnightntwrk/ledger-v9';

/**
 * How far past `now` the TTL sweep reaches.
 *
 * The grace period is three hours from the spend's `ctime`, and every spend
 * whose coins are hidden happened in the past — so four hours from now clears
 * every flag a wedge can be made of, with an hour in hand for a clock that
 * disagrees with the chain's. It cannot reach a coin that is legitimately
 * pending against a transaction still in flight, because nothing calls this
 * while a transaction is in flight: see `dustWedged` in `./wallet.ts` and the
 * `dust-wedged` verdict in `./health.ts`, both of which require zero pending
 * transactions and zero outstanding balancings before this is reached.
 */
export const TTL_LOOKAHEAD_MS = 4 * 60 * 60 * 1_000;

/** Thrown when the snapshot is not wedged, so rewriting it would repair nothing. */
export class NothingToRepair extends Error {
  readonly utxos: number;

  constructor(utxos: number) {
    super(
      `nothing to repair: the stored DUST state already reports ${utxos} spendable UTxO(s), so no coin is being held pending`,
    );
    this.name = 'NothingToRepair';
    this.utxos = utxos;
  }
}

/** What the repair found and what it produced. */
export interface DustRollbackResult {
  /** Spendable DUST UTxOs the stored state reported BEFORE the sweep. Zero, in a wedge. */
  utxosBefore: number;
  /** Spendable DUST UTxOs after it. Greater than `utxosBefore`, or this throws. */
  utxosAfter: number;
  /** Spendable Specks after the sweep, valued at `now`. */
  balanceAfter: bigint;
  /** `savedAt` from the snapshot, so a caller can say how old what it repaired was. */
  savedAt: string | null;
  /** The rewritten snapshot, ready to be written back in place of the original. */
  snapshot: string;
}

/** The half of the stored snapshot this module reads; the rest is carried through untouched. */
interface DustSnapshotEnvelope {
  savedAt?: unknown;
  dust?: unknown;
  [key: string]: unknown;
}

interface DustWalletState {
  state?: unknown;
  [key: string]: unknown;
}

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('the stored DUST state is not an even-length hex string');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
};

/**
 * Sweeps the expired DUST grace periods out of a stored sync snapshot.
 *
 * Everything outside `dust.state` is carried through byte for byte — the
 * shielded and unshielded states, the address, the version — so the rewritten
 * snapshot resumes exactly where the original would have, minus the wedge.
 *
 * @param snapshotJson the contents of `sync-snapshot-<network>.json`
 * @param now epoch milliseconds; the sweep reaches {@link TTL_LOOKAHEAD_MS} past it
 * @throws NothingToRepair when the sweep frees no coin
 */
export function rollbackDustSnapshot(snapshotJson: string, now: number): DustRollbackResult {
  let envelope: DustSnapshotEnvelope;
  try {
    envelope = JSON.parse(snapshotJson) as DustSnapshotEnvelope;
  } catch (cause) {
    throw new Error(
      `the snapshot is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof envelope.dust !== 'string') {
    throw new Error('the snapshot carries no serialised `dust` wallet state');
  }

  let dustWallet: DustWalletState;
  try {
    dustWallet = JSON.parse(envelope.dust) as DustWalletState;
  } catch (cause) {
    throw new Error(
      `the snapshot's \`dust\` field is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof dustWallet.state !== 'string') {
    throw new Error('the snapshot\'s DUST wallet carries no serialised ledger `state`');
  }

  const before = ledger.DustLocalState.deserialize(hexToBytes(dustWallet.state));
  const utxosBefore = before.utxos.length;

  /* The whole repair. `processTtls` returns a NEW state — the ledger's WASM
     types are immutable — so the original is untouched and the comparison
     below is between two independent readings rather than one mutated one. */
  const after = before.processTtls(new Date(now + TTL_LOOKAHEAD_MS));
  const utxosAfter = after.utxos.length;

  /* Refused rather than written. A snapshot whose UTxO count does not rise is a
     snapshot with nothing pending — a healthy wallet, or one that is genuinely
     empty — and rewriting it would swap a good state for an identical one while
     telling an operator a repair had happened. The watchdog and the health
     remedy both read this refusal as "not the failure I thought", which is the
     answer that keeps them from restarting a service that is merely poor. */
  if (utxosAfter <= utxosBefore) throw new NothingToRepair(utxosAfter);

  const repaired = Buffer.from(after.serialize()).toString('hex');
  const snapshot = JSON.stringify({
    ...envelope,
    dust: JSON.stringify({ ...dustWallet, state: repaired }),
  });

  return {
    utxosBefore,
    utxosAfter,
    balanceAfter: after.walletBalance(new Date(now)),
    savedAt: typeof envelope.savedAt === 'string' ? envelope.savedAt : null,
    snapshot,
  };
}
