// CustodyAccount — the high-level client over a deployed account custody
// contract (MIP-0012 asset surface + MIP-0013 authorisation seam).
//
// The contract exports every gated operation once per authorisation arm
// (`<operation>_with_jubjub`, `_with_k256`, `_with_p256`); this client is
// arm-generic: a call takes any device, builds the challenge with that
// device's arm's builders, and targets the arm's circuit. Every authorised
// call follows the same shape: read the live auth_nonce, resolve the
// device's current use counter (the rolling-entry position, AUTH-9),
// collect the witness values the call will consume (AUTH-10), build the
// per-circuit challenge, have the device sign it, and pass the arm's
// authorising material as the circuit's trailing arguments. Low-level
// `*WithAuth` variants accept a pre-built Authorisation so conformance
// tests can inject faults (wrong s, stale nonce, wrong counter, replays).
//
// The client tracks a credential- and epoch-scoped roster per MIP-0013 S11:
// counters advance on every successful gated call, and an unknown counter
// is recovered by rescanning ledger membership of candidate entries.

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { deployAccountInWaves } from './wave-deploy.js';

import {
  ledger,
  type JubjubPoint,
  type Ledger,
  type ShieldedCoin,
  type QualifiedCoin,
  type GrantRecord,
} from './contract.js';
import {
  emptyCoinStore,
  withCoin,
  withoutCoin,
  coinId,
  migrateCoinStore,
  selectCoin,
  withSelectedCoin,
  type CoinIdentity,
  type CoinStorePrivateState,
} from './witnesses.js';
import {
  recoveryKey,
  signRecoverSubmit,
  recoverSubmitArgs,
  recoverSubmitChallenge,
} from './recovery-gate.js';
import { bytesToHex, hexToBytes } from './hex.js';
import {
  JubjubDevice,
  jubjubChallenges,
  k256Challenges,
  p256Challenges,
  authArgs,
  jubjubGrantChallenges,
  k256GrantChallenges,
  p256GrantChallenges,
  grantAuthArgs,
  scopeArgs,
  scopeDigest,
  assertIssueRules,
  type AnyDevice,
  type Authorisation,
  type CallContext,
  type AnyGrantee,
  type GrantAuthorisation,
  type GrantContext,
  type GrantOpening,
  type PlainScope,
} from './signer.js';
import { deriveEncPublicKey, openInboxEntry, sealInboxEntry, type EncKeyPair } from './inbox.js';
import {
  DurableChangeCoordinator,
  type ChangeJournalEntry,
  type ChangeJournalStore,
  type DurableTransactionAdapter,
  type PrepareBackfill,
  restoreJournalCoin,
} from './change-journal.js';
import {
  scanHoldings, recoverySubtotal,
  type ChainRecoveryAdapter, type ChainRecoveryCandidate, type HoldingsRecoveryReport, type ScanHoldingsOptions,
} from './chain-recovery.js';
import { checkGrantExpiry, GrantPreflightError, type GrantPreflightOptions } from './grant-preflight.js';
export { GrantPreflightError, type GrantPreflightOptions } from './grant-preflight.js';

/** Selection alone is sufficient for a deliberately non-expiring grant.
 * Finite grants still require the complete preflight timing configuration. */
export type ShieldedGrantOptions = { coinId?: string } & (GrantPreflightOptions | {
  readNodeHeadTimeSeconds?: never;
  admissionMarginSeconds?: never;
  proveAndBalanceSeconds?: never;
  nowSeconds?: never;
});

function grantTiming(options?: ShieldedGrantOptions): GrantPreflightOptions | undefined {
  if (!options || options.readNodeHeadTimeSeconds === undefined) return undefined;
  // The union permits a reader only with the complete timing branch. The
  // runtime preflight also validates every field for untyped callers.
  return options as GrantPreflightOptions;
}

// The SDK persists the whole private snapshot after every successful call.
// Reject overlapping work across account objects sharing this provider,
// whose contract-address context is mutable, including non-shielded calls.
const activeStores = new WeakSet<object>();
type SelectedSubmit = (name: string, args: unknown[], retry?: boolean) => Promise<any>;

async function withProviderLock<T>(provider: any, action: () => Promise<T>): Promise<T> {
  if (activeStores.has(provider)) throw new Error('coin store is busy with another operation');
  activeStores.add(provider);
  try { return await action(); } finally { activeStores.delete(provider); }
}

async function withProviderGuard<T>(provider: any, address: string, action: () => Promise<T>): Promise<T> {
  return withProviderLock(provider, async () => {
    await provider.setContractAddress?.(address);
    return await action();
  });
}

export interface DurableChangesOptions {
  /** Explicit network identity, for example a genesis hash, to prevent cross-network replay. */
  networkId: string;
  /** An explicitly configured atomic, durable, confidential journal store. */
  journalStore: ChangeJournalStore;
  adapter: DurableTransactionAdapter | ((context: {
    providers: any; compiledContract: any; address: string; privateStateId: string;
  }) => DurableTransactionAdapter);
}

export interface ConnectOptions {
  /** Required for durable mode. Reopens existing private state without replacing it. */
  privateStateId?: string;
  durableChanges?: DurableChangesOptions;
}

export interface RecoverHoldingsOptions extends Omit<ScanHoldingsOptions, 'address' | 'viewingKeys'> {
  /** Omit to use the viewing key retained in private state. Historical keys may be supplied explicitly. */
  viewingKeys?: Uint8Array[];
  /** Default false. Apply only individually verified live/spent observations. */
  apply?: boolean;
}

/** The recovery artefacts an account is born with (recovery MIP section 8):
 *  the recovery public key P = s·G, the wrap, and the veto window. */
export interface RecoveryBirth {
  recoveryPk: JubjubPoint;
  wrap: Uint8Array;
  vetoWindowSeconds: bigint;
}

export interface DeployOptions {
  /** See wave-deploy's authority note; the default retires it. */
  retireAuthority?: boolean;
  recovery?: RecoveryBirth;
  durableChanges?: DurableChangesOptions;
}

export interface TxResult {
  txId: string;
}

export interface SpendOutcome extends TxResult {
  /** The surviving change coin returned by the circuit (private channel). */
  change: ShieldedCoin | null;
  /** Durable capture and recovery status, when configured. */
  capture?: ChangeJournalEntry;
}

export interface DirectSpendOutcome extends SpendOutcome {
  /** The coin sent to the recipient contract — the payee's claim argument. */
  sent: ShieldedCoin;
}

/** Maximum membership probes in one discovery page, including hints. */
const COUNTER_PAGE_LIMIT = 4096;
const MAX_USE_COUNTER = (1n << 64n) - 1n;

/** Serialisable, untrusted position hint. Membership is always rechecked. */
export interface DeviceCounterHint {
  version: 1;
  account: string;
  credential: string;
  epoch: string;
  counter: string;
}

/** Resume only against the same account, credential, and device epoch. */
export interface DeviceCounterCursor {
  version: 1;
  account: string;
  credential: string;
  epoch: string;
  nextCounter: string;
}

export interface DeviceCounterSearchOptions {
  /** A saved page cursor. A changed device epoch requires restart. */
  cursor?: DeviceCounterCursor;
  /** A persisted hint, checked before a fresh scan. Cannot accompany a cursor. */
  hint?: DeviceCounterHint;
  /** Membership probes for this call, from 1 through 4096. */
  maxProbes?: number;
}

export interface DeviceCounterFound {
  status: 'found';
  counter: bigint;
  epoch: bigint;
  entry: Uint8Array;
  probes: number;
  hint: DeviceCounterHint;
}

export interface DeviceCounterExhausted {
  status: 'exhausted';
  epoch: bigint;
  /** Contiguous scan range, with an exclusive end; hint/forward probes are separate. */
  fromCounter: bigint;
  toCounter: bigint;
  probes: number;
  /** Null means the scan reached Uint64's end, not proof of non-registration. */
  cursor: DeviceCounterCursor | null;
}

export type DeviceCounterSearchResult = DeviceCounterFound | DeviceCounterExhausted;

export class DeviceCounterSearchExhaustedError extends Error {
  constructor(readonly result: DeviceCounterExhausted) {
    super('device counter search exhausted its bounded page; registration is undetermined');
    this.name = 'DeviceCounterSearchExhaustedError';
  }
}

export class DeviceCounterCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCounterCursorError';
  }
}

/**
 * Submit with a dust-race retry. The wallet builds fees from its own dust
 * state, which lags the chain by a sync cycle; two transactions built in
 * quick succession can reuse a dust nullifier (DustDoubleSpend) or emit an
 * empty dust action set (NotNormalized), and the node rejects at
 * submission. A rejected submission changes no state — the signed
 * authorisation is still valid — so waiting for the wallet to catch up and
 * rebuilding is sound.
 */
async function submitWithDustRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const dustRace = /SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/.test(msg);
      if (!dustRace || attempt >= RETRIES) throw e;
      console.log(`  (${label}: submission rejected — dust-state race; retrying in 10s)`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

function txId(r: any): string {
  const id = r?.public?.txId ?? r?.public?.transactionHash;
  if (!id) throw new Error('contract call returned without a transaction id');
  return id;
}

/** The circuit's declared return value travels in the call result's private
 *  section; probe the surfaces the midnight-js versions disagree on. */
function circuitResult(r: any): any {
  for (const v of [r?.private?.result, r?.private?.circuitResult, r?.private?.returnValue, r?.result]) {
    if (v !== undefined) return v;
  }
  return undefined;
}

function changeOf(r: any): ShieldedCoin | null {
  const value = circuitResult(r);
  return value && value.is_some ? (value.value as ShieldedCoin) : null;
}

/** The `[sent, change]` pair a direct (contract-recipient) spend returns. */
function directOutcomeOf(r: any, name: string): { sent: ShieldedCoin; change: ShieldedCoin | null } {
  const result = circuitResult(r);
  if (!Array.isArray(result) || !result[0]?.nonce) {
    throw new Error(`${name}: [sent, change] result not found on the call surface`);
  }
  const maybeChange = result[1];
  return {
    sent: result[0] as ShieldedCoin,
    change: maybeChange?.is_some ? (maybeChange.value as ShieldedCoin) : null,
  };
}

export class CustodyAccount {
  /** Full credential, account, and epoch identify each checked roster hint. */
  private readonly counters = new Map<string, DeviceCounterHint>();
  private counterEpoch: bigint | undefined;
  private readonly changeCoordinator?: DurableChangeCoordinator;
  private readonly durableAdapter?: DurableTransactionAdapter;

  private constructor(
    readonly address: string,
    readonly addressBytes: Uint8Array,
    readonly providers: any,
    readonly privateStateId: string,
    private readonly handle: any,
    compiledContract?: any,
    durableChanges?: DurableChangesOptions,
  ) {
    if (durableChanges) {
      if (!durableChanges.networkId?.trim() || !durableChanges.journalStore || !durableChanges.adapter) {
        throw new Error('durable changes require a network identity, journal store, and transaction adapter');
      }
      this.durableAdapter = typeof durableChanges.adapter === 'function'
        ? durableChanges.adapter({ providers, compiledContract, address, privateStateId }) : durableChanges.adapter;
      const scope = JSON.stringify([durableChanges.networkId, address, privateStateId]);
      this.changeCoordinator = new DurableChangeCoordinator(scope, durableChanges.journalStore, {
        observe: ids => this.durableAdapter!.observe(ids),
        qualify: (change, ids) => this.durableAdapter!.qualify(change, ids),
        adopt: async (input, change) => {
          const raw = await providers.privateStateProvider.get(privateStateId);
          const current = migrateCoinStore(raw ?? emptyCoinStore());
          let next = migrateCoinStore({ ...current, spentCoins: { ...current.spentCoins, [coinId(input)]: true } });
          if (change) next = withCoin(next, { ...change, mtIndex: change.mt_index });
          // History replay may run after a later spend has pinned its input.
          // Preserve that exact live selection; retiring it still clears it.
          if (raw?.selectedCoin) {
            const selectedId = `${raw.selectedCoin.nonceHex}:${raw.selectedCoin.colorHex}:${raw.selectedCoin.value}`;
            if (next.coins[selectedId] && Object.entries(raw.selectedCoin).every(([key, value]) => next.coins[selectedId][key] === value)) {
              next = withSelectedCoin(next, selectCoin(next, hexToBytes(raw.selectedCoin.colorHex), selectedId));
            }
          }
          await providers.privateStateProvider.set(privateStateId, next);
        },
        seal: async change => sealInboxEntry(await this.encKey(), change),
        findInboxEntry: async entry => {
          const state = await this.ledgerState();
          const expected = bytesToHex(entry);
          for (let i = 0n; i < state.inbox_count; i++) {
            if (state.inbox.member(i) && bytesToHex(state.inbox.lookup(i)) === expected) return true;
          }
          return false;
        },
        verifyInboxEntry: async (entry, change) => {
          const secret = (await this.readCoinStore()).encSecretKeyHex;
          if (!secret) return false;
          if (bytesToHex(deriveEncPublicKey(hexToBytes(secret))) !== bytesToHex(await this.encKey())) return false;
          const opened = openInboxEntry(hexToBytes(secret), entry);
          if (!opened || coinId(opened) !== coinId(change)) throw new Error('recovery entry does not decrypt to the captured change');
          return true;
        },
      });
    }
  }

  static async deploy(
    providers: any,
    compiledContract: any,
    initialDevice: AnyDevice,
    encKeys: EncKeyPair,
    /** See wave-deploy's authority note; the default retires it. */
    opts?: DeployOptions,
  ): Promise<CustodyAccount> {
    const dormant = await CustodyAccount.deployDormant(
      providers, compiledContract, initialDevice, encKeys, opts,
    );
    await dormant.activate(initialDevice, dormant.salt);
    return dormant.finish();
  }

  /**
   * Deploy without activating (MIP-0013 §3 bootstrap). The account is
   * dormant — empty device set, boot commitment stored — until
   * `activate` installs the initial entry; `finish` then wraps the
   * handle. Split out so the bootstrap conformance probes (test 10) can
   * exercise the pre-activation faults. The initial device's arm selects
   * the boot commitment's DST, and thereby which arm's activation circuit
   * can match it.
   */
  static async deployDormant(
    providers: any,
    compiledContract: any,
    initialDevice: AnyDevice,
    encKeys: EncKeyPair,
    opts?: DeployOptions,
  ): Promise<{
    address: string;
    salt: Uint8Array;
    activate: (device: AnyDevice, salt: Uint8Array) => Promise<unknown>;
    finish: () => CustodyAccount;
  }> {
    return withProviderLock(providers.privateStateProvider, async () => {
      const privateStateId = freshPrivateStateId();
      const initialPrivateState = emptyCoinStore(encKeys.secretKey);
      // kernel.self() is not available in the constructor, so the initial
      // entry cannot be inserted at deploy time; the constructor stores a
      // salted boot commitment and the arm's activate_initial_device inserts
      // the real address-bound entry immediately after (see the contract's
      // `boot` cell for the full rationale).
      const salt = new Uint8Array(32);
      globalThis.crypto.getRandomValues(salt);
      const boot = initialDevice.bootCommitment(salt);
      // Recovery at birth (recovery MIP, Backwards Compatibility): with no
      // artefacts supplied, a fresh birth secret is sampled, its public key
      // published, and the secret discarded here, so the account is
      // recoverable only by a party that was handed the secret, which nobody
      // was. Deployers that want a recoverable account pass their own key
      // and wrap.
      const birth = opts?.recovery ?? {
        recoveryPk: JubjubDevice.generate().pk,
        wrap: new Uint8Array(64),
        vetoWindowSeconds: 3n * 24n * 3600n,
      };
      // The full deploy exceeds per-block limits, so the account deploys in
      // waves: the initial device's arm first, the other arm's verifier keys
      // by maintenance update (see wave-deploy.ts).
      const address = await deployAccountInWaves(providers, compiledContract, {
        firstArm: initialDevice.arm,
        args: [boot, encKeys.publicKey, birth.recoveryPk, birth.wrap, birth.vetoWindowSeconds],
        privateStateId,
        initialPrivateState,
        retireAuthority: opts?.retireAuthority,
      });
      const found = await (findDeployedContract as any)(providers, {
        contractAddress: address,
        compiledContract,
        privateStateId,
        initialPrivateState,
      });
      const account = new CustodyAccount(address, addressToBytes(address), providers, privateStateId, found, compiledContract, opts?.durableChanges);
      account.registerDevice(initialDevice, 0n);
      return { address, salt,
        activate: (device, s) => account.activateInitialDevice(device, s),
        finish: () => account,
      };
    });
  }

  /** Low-level activation call against a live account (bootstrap probes). */
  activateInitialDevice(device: AnyDevice, salt: Uint8Array): Promise<unknown> {
    const name = `activate_initial_device_with_${device.arm}`;
    return submitWithDustRetry(name, () => this.dispatch(name, ...activationArgs(device, salt)));
  }

  static async connect(
    providers: any,
    compiledContract: any,
    address: string,
    initialState: CoinStorePrivateState = emptyCoinStore(),
    options: ConnectOptions = {},
  ): Promise<CustodyAccount> {
    if (options.durableChanges && !options.privateStateId) throw new Error('durable reconnect requires a stable privateStateId');
    const privateStateId = options.privateStateId ?? freshPrivateStateId();
    return withProviderGuard(providers.privateStateProvider, address, async () => {
      const stored = options.privateStateId ? await providers.privateStateProvider.get(privateStateId) : null;
      const found = await (findDeployedContract as any)(providers, {
        contractAddress: address,
        compiledContract,
        privateStateId,
        initialPrivateState: migrateCoinStore(stored ?? initialState),
      });
      return new CustodyAccount(address, addressToBytes(address), providers, privateStateId, found, compiledContract, options.durableChanges);
    });
  }

  // ── Ledger reads ──────────────────────────────────────────────────────────

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no contract state found at ${this.address}`);
    return ledger(state.data);
  }

  /** The signing context for the next authorised call (MIP-0013 §5.1). */
  async callContext(): Promise<CallContext> {
    const l = await this.ledgerState();
    return { contractAddress: this.addressBytes, authNonce: l.auth_nonce };
  }

  // ── Device roster (MIP-0013 S11) ──────────────────────────────────────────

  /**
   * The device's current use counter: a checked roster hint, or one bounded
   * S11 discovery page. Catch DeviceCounterSearchExhaustedError and resume
   * with its result.cursor to continue beyond that page.
   */
  async resolveUseCounter(device: AnyDevice, options: DeviceCounterSearchOptions = {}): Promise<bigint> {
    return (await this.requireUseCounter(device, options)).counter;
  }

  /**
   * Search one bounded page against one ledger snapshot. Save an exhausted
   * result's cursor to continue in this or another process. A page never
   * establishes that a credential is unregistered.
   */
  async discoverUseCounter(
    device: AnyDevice,
    options: DeviceCounterSearchOptions = {},
  ): Promise<DeviceCounterSearchResult> {
    const maxProbes = options.maxProbes ?? COUNTER_PAGE_LIMIT;
    if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > COUNTER_PAGE_LIMIT) {
      throw new RangeError('maxProbes must be an integer from 1 through 4096');
    }
    if (options.cursor && options.hint) {
      throw new DeviceCounterCursorError('supply a cursor or a hint, not both');
    }
    const l = await this.ledgerState();
    const epoch = l.device_epoch;
    const account = bytesToHex(this.addressBytes);
    const credential = credentialKey(device);
    if (this.counterEpoch !== epoch) {
      this.counters.clear();
      this.counterEpoch = epoch;
    }
    const key = counterKey(this.addressBytes, device, epoch);
    let fromCounter = 0n;
    let hint: DeviceCounterHint | undefined;
    if (options.cursor) {
      const cursor = options.cursor;
      checkCounterScope(cursor, account, credential);
      if (parseCounterUint(cursor.epoch, 0xffffffffn, 'cursor epoch') !== epoch) {
        throw new DeviceCounterCursorError('device epoch changed; restart device counter discovery');
      }
      fromCounter = parseCounterUint(cursor.nextCounter, MAX_USE_COUNTER, 'next counter');
    } else if (options.hint) {
      checkCounterScope(options.hint, account, credential);
      const hintEpoch = parseCounterUint(options.hint.epoch, 0xffffffffn, 'hint epoch');
      parseCounterUint(options.hint.counter, MAX_USE_COUNTER, 'hint counter');
      if (hintEpoch === epoch) hint = options.hint;
    } else {
      hint = this.counters.get(key);
    }
    let probes = 0;
    const tried = new Set<bigint>();
    const probe = (counter: bigint): DeviceCounterFound | undefined => {
      if (tried.has(counter)) return undefined;
      tried.add(counter);
      probes++;
      const entry = device.entryAt(this.addressBytes, epoch, counter);
      if (!l.devices.member(entry)) return undefined;
      const foundHint = counterHint(this.addressBytes, device, epoch, counter);
      this.counters.set(key, foundHint);
      return { status: 'found', counter, epoch, entry, probes, hint: { ...foundHint } };
    };
    if (hint) {
      const triedHint = BigInt(hint.counter);
      const found = probe(triedHint);
      if (found) return found;
      this.counters.delete(key);
      if (triedHint > 0n && probes < maxProbes) {
        // Recovery or re-enrolment can reset a previously advanced key.
        const reset = probe(0n);
        if (reset) return reset;
        // Other sessions commonly advance the same chain. Preserve bounded
        // forward resynchronisation while reserving work for lower counters.
        const forwardBudget = Math.floor((maxProbes - probes) / 2);
        for (let offset = 1n; offset <= BigInt(forwardBudget) && triedHint + offset <= MAX_USE_COUNTER; offset++) {
          const advanced = probe(triedHint + offset);
          if (advanced) return advanced;
        }
      }
    }
    let nextCounter = fromCounter;
    while (nextCounter <= MAX_USE_COUNTER) {
      if (tried.has(nextCounter)) { nextCounter++; continue; }
      if (probes >= maxProbes) break;
      const candidate = nextCounter++;
      const found = probe(candidate);
      if (found) return found;
    }
    return {
      status: 'exhausted', epoch, fromCounter, toCounter: nextCounter, probes,
      cursor: nextCounter > MAX_USE_COUNTER ? null : {
        version: 1, account, credential, epoch: epoch.toString(),
        nextCounter: nextCounter.toString(),
      },
    };
  }

  /** Export a JSON-safe hint for caller-owned storage; this contains no secret. */
  deviceCounterHint(device: AnyDevice): DeviceCounterHint | undefined {
    if (this.counterEpoch === undefined) return undefined;
    const hint = this.counters.get(counterKey(this.addressBytes, device, this.counterEpoch));
    return hint ? { ...hint } : undefined;
  }

  private async requireUseCounter(
    device: AnyDevice,
    options: DeviceCounterSearchOptions = {},
  ): Promise<DeviceCounterFound> {
    const result = await this.discoverUseCounter(device, options);
    if (result.status === 'exhausted') throw new DeviceCounterSearchExhaustedError(result);
    return result;
  }

  private advanceCounter(device: AnyDevice, used: bigint, epoch: bigint): void {
    if (this.counterEpoch !== epoch) return;
    const key = counterKey(this.addressBytes, device, epoch);
    if (used === MAX_USE_COUNTER) this.counters.delete(key);
    else this.counters.set(key, counterHint(this.addressBytes, device, epoch, used + 1n));
  }

  /** Record fresh enrolment at counter zero. Public-key-only legacy calls
   *  invalidate hints because a public key alone does not identify a profile. */
  registerDevice(device: AnyDevice | { x: bigint; y: bigint }, epoch = this.counterEpoch): void {
    if (!('arm' in device)) {
      // Legacy callers provide no profile. Dropping hints preserves their
      // reset-to-zero behaviour without assigning the key to the wrong arm.
      const x = device.x.toString(16), y = device.y.toString(16);
      for (const [key, hint] of this.counters) {
        const [, cachedX, cachedY] = hint.credential.split(':');
        if (cachedX === x && cachedY === y) this.counters.delete(key);
      }
      return;
    }
    if (epoch !== undefined) {
      this.counters.set(counterKey(this.addressBytes, device, epoch), counterHint(this.addressBytes, device, epoch, 0n));
    }
  }

  // ── Wallet-local coin store (MIP-0012 §6.5) ───────────────────────────────

  async coinStore(): Promise<CoinStorePrivateState> {
    return this.withStoreGuard(() => this.readCoinStore());
  }

  private async readCoinStore(): Promise<CoinStorePrivateState> {
    const s = await this.providers.privateStateProvider.get(this.privateStateId);
    return migrateCoinStore(s ?? emptyCoinStore());
  }

  private async withStoreGuard<T>(action: () => Promise<T>): Promise<T> {
    return withProviderGuard(this.providers.privateStateProvider, this.address, action);
  }

  private async clearStoredSelection(): Promise<void> {
    const state = await this.providers.privateStateProvider.get(this.privateStateId);
    if (state?.selectedCoin) {
      await this.providers.privateStateProvider.set(this.privateStateId, migrateCoinStore(state));
    }
  }

  /** Every SDK call shares the same private-state guard, even when its circuit
   * does not use held_coin. A stale selection from an interrupted call is not
   * inherited by a later operation. */
  private dispatch(name: string, ...args: unknown[]): Promise<any> {
    return this.withStoreGuard(async () => {
      if (this.changeCoordinator && name.startsWith('withdraw_shielded')) throw new Error('durable shielded spends require a typed account method');
      await this.clearStoredSelection();
      return this.handle.callTx[name](...args);
    });
  }

  async putCoin(coin: CoinIdentity & { mtIndex: bigint }): Promise<void> {
    await this.withStoreGuard(async () => {
      await this.providers.privateStateProvider.set(this.privateStateId, withCoin(await this.readCoinStore(), coin));
    });
  }

  /** Retire exactly one locally known coin. Repeated retirement is harmless. */
  async dropCoin(coin: CoinIdentity | string): Promise<void> {
    await this.withStoreGuard(async () => {
      await this.providers.privateStateProvider.set(this.privateStateId, withoutCoin(await this.readCoinStore(), coin));
    });
  }

  /** A colour with several live inputs requires an explicit stable coin ID. */
  async heldCoin(color: Uint8Array, id?: string): Promise<QualifiedCoin> {
    return selectCoin(await this.coinStore(), color, id);
  }

  /** Detached journal diagnostics, including uncertain input reservations. */
  async changeJournal(): Promise<ChangeJournalEntry[]> {
    return this.changeCoordinator?.list() ?? [];
  }

  /** Reconstruct a bounded, pinned page using viewing capability and chain data.
   * Reports are private and describe one snapshot, not a promise of future spendability.
   * Unknown retained inventory stays local, but never contributes to verifiedSubtotal. */
  async recoverHoldings(adapter: ChainRecoveryAdapter, options: RecoverHoldingsOptions): Promise<HoldingsRecoveryReport> {
    return this.withStoreGuard(async () => {
      const stored = await this.readCoinStore();
      const viewingKeys = options.viewingKeys ?? (stored.encSecretKeyHex ? [hexToBytes(stored.encSecretKeyHex)] : []);
      // Explicit candidate continuations come first so callers can prioritise a
      // previously unfinished search over the account's retained descriptions.
      const candidates: ChainRecoveryCandidate[] = [...(options.candidates ?? [])];
      for (const coin of Object.values(stored.coins)) {
        const qualified = restoreJournalCoin(coin);
        candidates.push({ coin: qualified, hints: [qualified.mt_index], source: 'local' });
      }
      for (const entry of await this.changeJournal()) {
        candidates.push({ coin: restoreJournalCoin(entry.input), hints: [BigInt(entry.input.mtIndex!)], source: 'journal' });
        if (entry.change) {
          const change = entry.qualifiedChange ?? entry.change;
          candidates.push({ coin: restoreJournalCoin(change), hints: change.mtIndex === undefined ? [] : [BigInt(change.mtIndex)], source: 'journal' });
        }
      }
      const report = await scanHoldings(adapter, { ...options, address: this.address, viewingKeys, candidates });
      if (!options.apply) return report;
      // Re-read the latest snapshot and merge exact identities. Neither a page
      // boundary nor an unknown classification authorises deleting a sibling.
      let next = await this.readCoinStore();
      const localSpentConflicts: string[] = [];
      let importedLive = 0, recordedSpent = 0;
      for (const holding of report.holdings) {
        if (holding.status === 'spent') {
          next = migrateCoinStore({ ...next, spentCoins: { ...next.spentCoins, [holding.id]: true } });
          recordedSpent++;
        } else if (holding.status === 'live') {
          if (next.spentCoins?.[holding.id]) { localSpentConflicts.push(holding.id); continue; }
          next = withCoin(next, { ...holding.qualifiedCoin!, mtIndex: holding.qualifiedCoin!.mt_index });
          importedLive++;
        }
      }
      if (importedLive || recordedSpent) await this.providers.privateStateProvider.set(this.privateStateId, next);
      report.application = { importedLive, recordedSpent, localSpentConflicts };
      if (localSpentConflicts.length) {
        report.coverage.complete = false;
        report.verifiedSubtotal = recoverySubtotal(report.holdings, new Set(localSpentConflicts));
      }
      return report;
    });
  }

  /** Resume capture and owner recovery publication without resending a spend. */
  async reconcileChanges(device?: AnyDevice): Promise<ChangeJournalEntry[]> {
    if (!this.changeCoordinator) throw new Error('durable changes are not configured');
    return this.withStoreGuard(async () => {
      await this.clearStoredSelection();
      return this.changeCoordinator!.reconcile(device ? this.prepareChangeBackfill(device) : undefined);
    });
  }

  private prepareChangeBackfill(device: AnyDevice): PrepareBackfill {
    return async entry => {
      const ctx = await this.callContext();
      const { counter } = await this.requireUseCounter(device);
      const auth = device.arm === 'jubjub'
        ? device.sign(jubjubChallenges.appendInbox(ctx, device.pk, entry), counter)
        : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).appendInbox(ctx, device.pk, entry), counter);
      return this.durableAdapter!.prepare(`append_inbox_with_${auth.arm}`, [entry, ...authArgs(auth)]);
    };
  }

  private withSelectedSpend<T>(
    color: Uint8Array,
    selected: string | QualifiedCoin | undefined,
    action: (coin: QualifiedCoin, submit: SelectedSubmit) => Promise<T>,
    recoveryDevice?: AnyDevice,
  ): Promise<T> {
    return this.withStoreGuard(async () => {
      await this.changeCoordinator?.assertAvailable();
      const state = await this.readCoinStore();
      const coin = typeof selected === 'object'
        ? selected : selectCoin(state, color, selected);
      if (bytesToHex(coin.color) !== bytesToHex(color)) throw new Error('selected coin colour mismatch');
      const pinned = withSelectedCoin(state, coin);
      // Copy the input before any asynchronous signing code can run.
      const input = selectCoin(pinned, color, coinId(coin));
      const pin = { ...pinned.selectedCoin! };
      await this.providers.privateStateProvider.set(this.privateStateId, pinned);
      const matches = (value: any) => value && Object.entries(pin).every(([key, v]) => value[key] === v);
      let failed = false;
      let capture: ChangeJournalEntry | undefined;
      try {
        const submit: SelectedSubmit = async (name, args, retry = false) => {
          const invoke = async () => {
            const current = await this.providers.privateStateProvider.get(this.privateStateId);
            if (!matches(current?.selectedCoin)) throw new Error('selected coin changed before submission');
            withSelectedCoin(current, input);
            if (this.changeCoordinator) {
              const grant = name.includes('_with_grant_');
              const outcome = await this.changeCoordinator.execute({
                circuitId: name, input,
                recipient: (args[0] as { bytes: Uint8Array }).bytes,
                amount: args[2] as bigint,
                recovery: grant ? { mode: 'grant', entry: args[3] as Uint8Array } : { mode: 'owner' },
              }, () => this.durableAdapter!.prepare(name, args));
              capture = outcome.entry;
              return outcome.result;
            }
            return this.handle.callTx[name](...args);
          };
          return retry && !this.changeCoordinator ? submitWithDustRetry(name, invoke) : invoke();
        };
        const result = await action(input, submit);
        if (capture && recoveryDevice) {
          const entries = await this.changeCoordinator!.reconcile(this.prepareChangeBackfill(recoveryDevice));
          capture = entries.find(entry => entry.id === capture!.id)!;
        }
        return capture ? { ...result, capture } : result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          // Read the latest state: never restore the old snapshot over spent
          // tombstones or other updates committed by the SDK.
          const current = await this.providers.privateStateProvider.get(this.privateStateId);
          if (matches(current?.selectedCoin)) {
            await this.providers.privateStateProvider.set(this.privateStateId, migrateCoinStore(current));
          }
        } catch (cleanupError) {
          if (!failed) throw cleanupError;
        }
      }
    });
  }

  // ── Permissionless surface ────────────────────────────────────────────────

  async depositUnshielded(color: Uint8Array, amount: bigint): Promise<TxResult> {
    const r = await submitWithDustRetry('deposit_unshielded', () => this.dispatch('deposit_unshielded', color, amount));
    return { txId: txId(r) };
  }

  async depositShielded(coin: ShieldedCoin, entry: Uint8Array): Promise<TxResult> {
    const r = await submitWithDustRetry('deposit_shielded', () => this.dispatch('deposit_shielded', coin, entry));
    return { txId: txId(r) };
  }

  // ── Authorised surface (high level: sign with a device, then call) ───────

  async withdrawUnshielded(
    device: AnyDevice,
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
  ): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.withdrawUnshielded(ctx, device.pk, color, amount, recipient), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).withdrawUnshielded(ctx, device.pk, color, amount, recipient), counter);
    const r = await this.withdrawUnshieldedWithAuth(color, amount, recipient, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  async withdrawShielded(
    device: AnyDevice,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    selectedCoinId?: string,
  ): Promise<SpendOutcome> {
    return this.withSelectedSpend(color, selectedCoinId, async (coin, submit) => {
      if (amount > coin.value) throw new Error('selected coin has insufficient value for this spend');
      const ctx = await this.callContext();
      const { counter, epoch } = await this.requireUseCounter(device);
      const auth = device.arm === 'jubjub'
        ? device.sign(jubjubChallenges.withdrawShielded(ctx, device.pk, recipient, color, amount, coin), counter)
        : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).withdrawShielded(ctx, device.pk, recipient, color, amount, coin), counter);
      const name = `withdraw_shielded_with_${auth.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, ...authArgs(auth)], true);
      this.advanceCounter(device, counter, epoch);
      return { txId: txId(r), change: changeOf(r) };
    }, device);
  }

  async withdrawShieldedToContract(
    device: AnyDevice,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    selectedCoinId?: string,
  ): Promise<DirectSpendOutcome> {
    return this.withSelectedSpend(color, selectedCoinId, async (coin, submit) => {
      if (amount > coin.value) throw new Error('selected coin has insufficient value for this spend');
      const ctx = await this.callContext();
      const { counter, epoch } = await this.requireUseCounter(device);
      const auth = device.arm === 'jubjub'
        ? device.sign(jubjubChallenges.withdrawShieldedToContract(ctx, device.pk, recipient, color, amount, coin), counter)
        : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).withdrawShieldedToContract(ctx, device.pk, recipient, color, amount, coin), counter);
      const name = `withdraw_shielded_to_contract_with_${auth.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, ...authArgs(auth)], true);
      this.advanceCounter(device, counter, epoch);
      return { txId: txId(r), ...directOutcomeOf(r, name) };
    }, device);
  }

  async appendInbox(device: AnyDevice, entry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.appendInbox(ctx, device.pk, entry), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).appendInbox(ctx, device.pk, entry), counter);
    const r = await this.appendInboxWithAuth(entry, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  async rotateEncKey(device: AnyDevice, newKey: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.rotateEncKey(ctx, device.pk, newKey), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).rotateEncKey(ctx, device.pk, newKey), counter);
    const r = await this.rotateEncKeyWithAuth(newKey, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  /**
   * Enrol a new device — of ANY arm; the authorising device's arm and the
   * new device's arm are independent (this is the migration path between
   * arms). The new device travels as its derived entry at the CURRENT
   * epoch and use counter 0, computed with its own arm's derivation
   * circuit; the challenge binds that entry.
   */
  async addDevice(device: AnyDevice, newDevice: AnyDevice): Promise<TxResult> {
    const l = await this.ledgerState();
    const newEntry = newDevice.entryAt(this.addressBytes, l.device_epoch, 0n);
    const r = await this.addDeviceEntry(device, newEntry);
    this.registerDevice(newDevice, l.device_epoch);
    return r;
  }

  /** Enrol a new device by its literal derived entry (the caller derived
   *  it — for cross-client enrolment where only the entry travels). */
  async addDeviceEntry(device: AnyDevice, newEntry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.addDevice(ctx, device.pk, newEntry), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).addDevice(ctx, device.pk, newEntry), counter);
    const r = await this.addDeviceWithAuth(newEntry, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  /** Remove another device by its public key: its current entry is
   *  resolved from the roster or the S11 rescan (MIP-0013 §6). */
  async removeDevice(
    device: AnyDevice,
    target: AnyDevice,
    search: DeviceCounterSearchOptions = {},
  ): Promise<TxResult> {
    const found = await this.requireUseCounter(target, search);
    return this.removeDeviceEntry(device, found.entry);
  }

  /** Remove a device by its literal current set element. */
  async removeDeviceEntry(device: AnyDevice, entry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.removeDevice(ctx, device.pk, entry), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).removeDevice(ctx, device.pk, entry), counter);
    const r = await this.removeDeviceEntryWithAuth(entry, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  // ── Authorised surface (low level: caller supplies the Authorisation) ────
  //
  // The Authorisation's arm selects the `_with_<arm>` circuit; its fields
  // expand to the arm's trailing arguments (authArgs).

  async withdrawUnshieldedWithAuth(
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
    a: Authorisation,
  ): Promise<TxResult> {
    const name = `withdraw_unshielded_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name,
      color, amount, { bytes: recipient }, ...authArgs(a),
    ));
    return { txId: txId(r) };
  }

  async withdrawShieldedWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
    expectedCoin?: QualifiedCoin,
  ): Promise<SpendOutcome> {
    return this.withSelectedSpend(color, expectedCoin, async (_coin, submit) => {
      const name = `withdraw_shielded_with_${a.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, ...authArgs(a)], true);
      return { txId: txId(r), change: changeOf(r) };
    });
  }

  async withdrawShieldedToContractWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
    expectedCoin?: QualifiedCoin,
  ): Promise<DirectSpendOutcome> {
    return this.withSelectedSpend(color, expectedCoin, async (_coin, submit) => {
      const name = `withdraw_shielded_to_contract_with_${a.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, ...authArgs(a)], true);
      return { txId: txId(r), ...directOutcomeOf(r, name) };
    });
  }

  async appendInboxWithAuth(entry: Uint8Array, a: Authorisation): Promise<TxResult> {
    const name = `append_inbox_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, entry, ...authArgs(a)));
    return { txId: txId(r) };
  }

  async rotateEncKeyWithAuth(newKey: Uint8Array, a: Authorisation): Promise<TxResult> {
    const name = `rotate_enc_key_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, newKey, ...authArgs(a)));
    return { txId: txId(r) };
  }

  async addDeviceWithAuth(newEntry: Uint8Array, a: Authorisation): Promise<TxResult> {
    const name = `add_device_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, newEntry, ...authArgs(a)));
    return { txId: txId(r) };
  }

  async removeDeviceEntryWithAuth(entry: Uint8Array, a: Authorisation): Promise<TxResult> {
    const name = `remove_device_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, entry, ...authArgs(a)));
    return { txId: txId(r) };
  }

  // ── Recovery (recovery MIP): the session, the gate, the veto ─────────────

  /** Publish one artefact set (recovery MIP section 5), device-gated on
   *  either arm. `phi` carries 1..4 public shares; unused slots are zero.
   *  `recoveryPk` is P = s·G for the session's fresh secret. */
  async publishRecoverySession(
    device: AnyDevice,
    artefacts: {
      recoveryPk: JubjubPoint;
      sessionNonce: Uint8Array;
      phi: bigint[];
      wrap: Uint8Array;
    },
  ): Promise<TxResult> {
    if (artefacts.phi.length < 1 || artefacts.phi.length > 4) {
      throw new Error(`phi carries ${artefacts.phi.length} entries; the slot bound admits 1..4`);
    }
    if (artefacts.sessionNonce.length !== 32 || artefacts.sessionNonce.every((b) => b === 0)) {
      throw new Error('session identifier must be 32 non-zero bytes; an all-zero identifier is a broken generator (REC-4)');
    }
    const slots: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
    artefacts.phi.forEach((p, i) => {
      slots[i] = p;
    });
    const phiLen = BigInt(artefacts.phi.length);
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.publishRecoverySession(
          ctx, device.pk, artefacts.recoveryPk, artefacts.sessionNonce, slots, phiLen, artefacts.wrap,
        ), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).publishRecoverySession(
          ctx, device.pk, artefacts.recoveryPk, artefacts.sessionNonce, slots, phiLen, artefacts.wrap,
        ), counter);
    const name = `publish_recovery_session_with_${auth.arm}`;
    const r = await submitWithDustRetry(name, () =>
      this.dispatch(name,
        artefacts.recoveryPk, artefacts.sessionNonce,
        slots[0], slots[1], slots[2], slots[3], phiLen, artefacts.wrap,
        ...authArgs(auth),
      ));
    this.advanceCounter(device, counter, epoch);
    return { txId: txId(r) };
  }

  /** Submit a recovery (recovery MIP section 6 steps 1 to 4) through the
   *  signature gate. The recovery secret signs the submission challenge
   *  here and is not retained (REC-6); the successor device co-signs it.
   *  Neither scalar reaches the proof (REC-11), so the call may be proved
   *  by a delegated prover. The successor is a JubJub device; the contract
   *  precomputes its entry at the post-bump epoch. */
  async recoverSubmit(
    recoverySecret: bigint | Uint8Array,
    successor: JubjubDevice,
    successorRecoveryPk: JubjubPoint,
    nowUpperSeconds: bigint,
  ): Promise<TxResult> {
    const l = await this.ledgerState();
    if (successorRecoveryPk.x === l.recovery_pk.x && successorRecoveryPk.y === l.recovery_pk.y) {
      throw new Error('successor recovery key equals the key being consumed; sample a fresh recovery secret (recovery MIP section 5)');
    }
    const ctx = await this.callContext();
    const auth = signRecoverSubmit(
      recoveryKey(recoverySecret),
      successor,
      recoverSubmitChallenge(
        ctx, l.recovery_pk, successor.pk, successorRecoveryPk, l.device_epoch + 1n, nowUpperSeconds,
      ),
      {
        successorRecoveryPk,
        expectedEpoch: l.device_epoch,
        expectedNonce: l.auth_nonce,
        nowUpper: nowUpperSeconds,
      },
    );
    const r = await submitWithDustRetry('recover_submit', () =>
      this.dispatch('recover_submit', ...recoverSubmitArgs(auth)));
    return { txId: txId(r) };
  }

  /** Veto a pending recovery (recovery MIP section 6 step 5), device-gated
   *  on either arm. */
  async recoverCancel(device: AnyDevice): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.recoverCancel(ctx, device.pk), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).recoverCancel(ctx, device.pk), counter);
    const name = `recover_cancel_with_${auth.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, ...authArgs(auth)));
    this.advanceCounter(device, counter, epoch);
    return { txId: txId(r) };
  }

  /** Finalise a recovery whose veto window has closed (permissionless). */
  async recoverFinalise(): Promise<TxResult> {
    const r = await submitWithDustRetry('recover_finalise', () => this.dispatch('recover_finalise'));
    this.counters.clear();
    this.counterEpoch = undefined;
    return { txId: txId(r) };
  }

  // ── Scoped grants (scoped-grants MIP): ledger reads ──────────────────────

  /** Refuse an older schema before asking a device to approve a v3 grant.
   *  GrantScope gained caller_commit in v3, including for unrestricted
   *  grants, so a v2 account cannot consume this client's scope digest. */
  private async requireGrantCapability(): Promise<void> {
    const version = (await this.ledgerState()).spec_version;
    if (typeof version !== 'bigint' || version < 3n) {
      throw new Error('account_not_capable: scoped grants require spec_version >= 3');
    }
  }

  /** The record under a grant id, or null when the map has no entry (a
   *  revoked grant is a record with `active == false`, not null). */
  async grantRecord(grantId: Uint8Array): Promise<GrantRecord | null> {
    const l = await this.ledgerState();
    return l.grants.member(grantId) ? l.grants.lookup(grantId) : null;
  }

  /** The signing context of the next call under a grant (section 6.3):
   *  the record's `issued_at` and `nonce` as the ledger holds them now. */
  async grantContext(grantId: Uint8Array): Promise<GrantContext> {
    const g = await this.grantRecord(grantId);
    if (!g) throw new Error(`no grant record under ${bytesToHex(grantId)}`);
    return { contractAddress: this.addressBytes, grantId, issuedAt: g.issued_at, grantNonce: g.nonce };
  }

  /** Keep liveness and signing inputs on one ledger snapshot. The raw
   * grantContext remains available for deliberate conformance faults. */
  private async checkedGrant(grantId: Uint8Array, options?: GrantPreflightOptions): Promise<{
    context: GrantContext; encKey: Uint8Array; epoch: bigint; generation: bigint;
  }> {
    const l = await this.ledgerState();
    if (!l.grants.member(grantId)) throw new GrantPreflightError('missing', 'unknown grant');
    const g = l.grants.lookup(grantId);
    if (!g.active) throw new GrantPreflightError('inactive', 'grant revoked');
    if (g.epoch !== l.device_epoch) throw new GrantPreflightError('stale_epoch', 'grant epoch stale');
    if (g.gen !== l.grant_generation) throw new GrantPreflightError('stale_generation', 'grant generation stale');
    await checkGrantExpiry(g.scope.expires_at, options);
    return {
      context: { contractAddress: this.addressBytes, grantId, issuedAt: g.issued_at, grantNonce: g.nonce },
      encKey: l.enc_key, epoch: l.device_epoch, generation: l.grant_generation,
    };
  }

  /** A slow authenticator can outlive the checked horizon. Refuse changed
   * state before dispatch; never silently request a replacement signature. */
  private async recheckGrant(
    before: Awaited<ReturnType<CustodyAccount['checkedGrant']>>,
    options?: GrantPreflightOptions,
    encKey?: Uint8Array,
  ): Promise<void> {
    const after = await this.checkedGrant(before.context.grantId, options);
    if (after.context.issuedAt !== before.context.issuedAt || after.context.grantNonce !== before.context.grantNonce
      || after.epoch !== before.epoch || after.generation !== before.generation) {
      throw new GrantPreflightError('state_changed', 'grant signing state changed; read current state before a new authorisation');
    }
    if (encKey && bytesToHex(after.encKey) !== bytesToHex(encKey)) {
      throw new GrantPreflightError('encryption_key_changed', 'account encryption key changed before grant submission');
    }
  }

  /** The `grant_generation` cell, bumped only by `revoke_all_grants`. */
  async grantGeneration(): Promise<bigint> {
    const l = await this.ledgerState();
    return l.grant_generation;
  }

  /** The id of a grantee at this account for an origin and slot, on the
   *  grantee's own arm. */
  grantIdOf(grantee: AnyGrantee, originHash: Uint8Array, slot: bigint): Uint8Array {
    return grantee.grantId(this.addressBytes, originHash, slot);
  }

  // ── Scoped grants: lifecycle (device-gated, high level) ──────────────────
  //
  // Device-signed on the device's arm over auth_nonce, advancing the roster
  // counter like every other gated call. The issue challenge binds the
  // salted scope digest, not the plaintext fields (section 6.1).

  /**
   * Issue a grant: `grantId` is the grantee's identity (`grantIdOf`), the
   * scope the plaintext of section 4.2, `scopeSalt` 32 fresh random bytes
   * the caller keeps for the grantee's opening and never reuses. The issue
   * rules are checked client-side first so a refused scope never reaches a
   * device signature.
   */
  async issueGrant(device: AnyDevice, grantId: Uint8Array, scope: PlainScope, scopeSalt: Uint8Array, options?: GrantPreflightOptions): Promise<TxResult> {
    await this.requireGrantCapability();
    assertIssueRules(scope);
    const digest = scopeDigest(scopeSalt, scope);
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    await checkGrantExpiry(scope.expiresAt, options);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.issueGrant(ctx, device.pk, grantId, digest), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).issueGrant(ctx, device.pk, grantId, digest), counter);
    await checkGrantExpiry(scope.expiresAt, options);
    const name = `issue_grant_with_${auth.arm}`;
    const submitted = await this.dispatch(name, grantId, ...scopeArgs(scope), scopeSalt, ...authArgs(auth));
    this.advanceCounter(device, counter, epoch);
    return { txId: txId(submitted) };
  }

  /** Revoke one grant: the record becomes a tombstone (`active == false`)
   *  and the id may be re-issued later under a fresh salt. */
  async revokeGrant(device: AnyDevice, grantId: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.revokeGrant(ctx, device.pk, grantId), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).revokeGrant(ctx, device.pk, grantId), counter);
    const r = await this.revokeGrantWithAuth(grantId, auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  /** Revoke every grant: bumps `grant_generation` and clears the map. */
  async revokeAllGrants(device: AnyDevice): Promise<TxResult> {
    const ctx = await this.callContext();
    const { counter, epoch } = await this.requireUseCounter(device);
    const auth = device.arm === 'jubjub'
      ? device.sign(jubjubChallenges.revokeAllGrants(ctx, device.pk), counter)
      : await device.sign((device.arm === 'p256' ? p256Challenges : k256Challenges).revokeAllGrants(ctx, device.pk), counter);
    const r = await this.revokeAllGrantsWithAuth(auth);
    this.advanceCounter(device, counter, epoch);
    return r;
  }

  // ── Scoped grants: lifecycle (low level: caller supplies the Authorisation)

  async issueGrantWithAuth(grantId: Uint8Array, scope: PlainScope, scopeSalt: Uint8Array, a: Authorisation): Promise<TxResult> {
    await this.requireGrantCapability();
    const name = `issue_grant_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name,
      grantId, ...scopeArgs(scope), scopeSalt, ...authArgs(a),
    ));
    return { txId: txId(r) };
  }

  async revokeGrantWithAuth(grantId: Uint8Array, a: Authorisation): Promise<TxResult> {
    const name = `revoke_grant_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, grantId, ...authArgs(a)));
    return { txId: txId(r) };
  }

  async revokeAllGrantsWithAuth(a: Authorisation): Promise<TxResult> {
    const name = `revoke_all_grants_with_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name, ...authArgs(a)));
    return { txId: txId(r) };
  }

  // ── Scoped grants: the grant twins (grantee-signed, high level) ──────────
  //
  // Each call reads the record's context (issued_at, nonce) under the id
  // the grantee and opening determine, collects the witness value the
  // shielded twins will consume (the held coin, AUTH-10), builds the arm's
  // challenge, has the grantee sign it, and targets
  // `<operation>_with_grant_<arm>`. The opening's `spentPrev` must equal
  // the cumulative value released so far; the caller advances it by
  // `amount` after a successful call. `auth_nonce` and the device roster
  // are untouched by a grant call (GR-5).
  //
  // The shielded twins take the change entry the grantee pre-encrypted to
  // the account's `enc_key` (appended in the same circuit when the send
  // produces change): the caller supplies `changeEntry`; no helper
  // precomputes it here, since whether the change coin's nonce is
  // predictable before the call is a question the E2 suite tests. `encPk`
  // defaults to the live `enc_key` cell; a stale value aborts the call
  // in-circuit rather than orphaning the change.

  async withdrawUnshieldedWithGrant(
    grantee: AnyGrantee,
    opening: GrantOpening,
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
    options?: GrantPreflightOptions,
  ): Promise<TxResult> {
    const checked = await this.checkedGrant(this.grantIdOf(grantee, opening.originHash, opening.slot), options);
    const g = checked.context;
    const auth = grantee.arm === 'jubjub'
      ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(g, grantee.pk, color, amount, recipient))
      : await grantee.sign((grantee.arm === 'p256' ? p256GrantChallenges : k256GrantChallenges).withdrawUnshielded(g, grantee.pk, color, amount, recipient));
    await this.recheckGrant(checked, options);
    // One dispatch only. A refused attempt must re-enter this method, reread
    // state and head time, and request a fresh authorisation if still usable.
    const name = `withdraw_unshielded_with_grant_${auth.arm}`;
    const r = await this.dispatch(name, color, amount, { bytes: recipient }, ...grantAuthArgs(opening, auth));
    return { txId: txId(r) };
  }

  async withdrawShieldedWithGrant(
    grantee: AnyGrantee,
    opening: GrantOpening,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    changeEntry: Uint8Array,
    encPk?: Uint8Array,
    options?: ShieldedGrantOptions,
  ): Promise<SpendOutcome> {
    return this.withSelectedSpend(color, options?.coinId, async (coin, submit) => {
      if (amount > coin.value) throw new Error('selected coin has insufficient value for this spend');
      const checked = await this.checkedGrant(this.grantIdOf(grantee, opening.originHash, opening.slot), grantTiming(options));
      const g = checked.context;
      const enc = encPk ?? checked.encKey;
      if (bytesToHex(enc) !== bytesToHex(checked.encKey)) {
        throw new GrantPreflightError('encryption_key_changed', 'supplied change encryption key is not current');
      }
      const auth = grantee.arm === 'jubjub'
        ? grantee.sign(jubjubGrantChallenges.withdrawShielded(g, grantee.pk, recipient, color, amount, changeEntry, enc, coin))
        : await grantee.sign((grantee.arm === 'p256' ? p256GrantChallenges : k256GrantChallenges).withdrawShielded(g, grantee.pk, recipient, color, amount, changeEntry, enc, coin));
      await this.recheckGrant(checked, grantTiming(options), enc);
      const name = `withdraw_shielded_with_grant_${auth.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, changeEntry, enc, ...grantAuthArgs(opening, auth)]);
      return { txId: txId(r), change: changeOf(r) };
    });
  }

  async withdrawShieldedToContractWithGrant(
    grantee: AnyGrantee,
    opening: GrantOpening,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    changeEntry: Uint8Array,
    encPk?: Uint8Array,
    options?: ShieldedGrantOptions,
  ): Promise<DirectSpendOutcome> {
    return this.withSelectedSpend(color, options?.coinId, async (coin, submit) => {
      if (amount > coin.value) throw new Error('selected coin has insufficient value for this spend');
      const checked = await this.checkedGrant(this.grantIdOf(grantee, opening.originHash, opening.slot), grantTiming(options));
      const g = checked.context;
      const enc = encPk ?? checked.encKey;
      if (bytesToHex(enc) !== bytesToHex(checked.encKey)) {
        throw new GrantPreflightError('encryption_key_changed', 'supplied change encryption key is not current');
      }
      const auth = grantee.arm === 'jubjub'
        ? grantee.sign(jubjubGrantChallenges.withdrawShieldedToContract(g, grantee.pk, recipient, color, amount, changeEntry, enc, coin))
        : await grantee.sign((grantee.arm === 'p256' ? p256GrantChallenges : k256GrantChallenges).withdrawShieldedToContract(g, grantee.pk, recipient, color, amount, changeEntry, enc, coin));
      await this.recheckGrant(checked, grantTiming(options), enc);
      const name = `withdraw_shielded_to_contract_with_grant_${auth.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, changeEntry, enc, ...grantAuthArgs(opening, auth)]);
      return { txId: txId(r), ...directOutcomeOf(r, name) };
    });
  }

  /** The live encryption key used to seal change entries. */
  async encKey(): Promise<Uint8Array> {
    const l = await this.ledgerState();
    return l.enc_key;
  }

  // ── Scoped grants: the grant twins (low level, for fault injection) ──────
  //
  // The authorisation's arm selects the `_with_grant_<arm>` circuit; the
  // opening and the authorisation expand to the section 6.1 trailer
  // (grantAuthArgs). Conformance tests inject faults here: a stale grant
  // nonce, a wrong spent_prev, a foreign key, a mismatched salt.

  async withdrawUnshieldedWithGrantAuth(
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
    opening: GrantOpening,
    a: GrantAuthorisation,
  ): Promise<TxResult> {
    const name = `withdraw_unshielded_with_grant_${a.arm}`;
    const r = await submitWithDustRetry(name, () => this.dispatch(name,
      color, amount, { bytes: recipient }, ...grantAuthArgs(opening, a),
    ));
    return { txId: txId(r) };
  }

  async withdrawShieldedWithGrantAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    changeEntry: Uint8Array,
    encPk: Uint8Array,
    opening: GrantOpening,
    a: GrantAuthorisation,
    expectedCoin?: QualifiedCoin,
  ): Promise<SpendOutcome> {
    return this.withSelectedSpend(color, expectedCoin, async (_coin, submit) => {
      const name = `withdraw_shielded_with_grant_${a.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, changeEntry, encPk, ...grantAuthArgs(opening, a)], true);
      return { txId: txId(r), change: changeOf(r) };
    });
  }

  async withdrawShieldedToContractWithGrantAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    changeEntry: Uint8Array,
    encPk: Uint8Array,
    opening: GrantOpening,
    a: GrantAuthorisation,
    expectedCoin?: QualifiedCoin,
  ): Promise<DirectSpendOutcome> {
    return this.withSelectedSpend(color, expectedCoin, async (_coin, submit) => {
      const name = `withdraw_shielded_to_contract_with_grant_${a.arm}`;
      const r = await submit(name, [{ bytes: recipient }, color, amount, changeEntry, encPk, ...grantAuthArgs(opening, a)], true);
      return { txId: txId(r), ...directOutcomeOf(r, name) };
    });
  }

  /** Raw call-tx surface, for tests that need shapes not modelled above. */
  get callTx(): any {
    return new Proxy(this.handle.callTx, {
      get: (target, name) => typeof name === 'string' && typeof target[name] === 'function'
        ? (...args: unknown[]) => this.dispatch(name, ...args) : target[name],
    });
  }
}

/**
 * The arm's activation arguments. The k256 activation takes the device's
 * envelope as a third argument, because the boot commitment and the entry it
 * derives both bind it (`derive_boot_commitment_with_k256(salt, pk,
 * envelope)`); the jubjub arm has no envelope. Passing only `(pk, salt)` on
 * the k256 arm fails before a transaction exists with
 * `activate_initial_device_with_k256: expected 4 arguments (as invoked from
 * Typescript), received 3`.
 */
function activationArgs(device: AnyDevice, salt: Uint8Array): unknown[] {
  if (device.arm === 'p256') return [device.pk, salt, device.policy];
  return device.arm === 'k256' ? [device.pk, salt, device.envelope] : [device.pk, salt];
}

function credentialKey(device: AnyDevice): string {
  const point = `${device.pk.x.toString(16)}:${device.pk.y.toString(16)}`;
  const profile = device.arm === 'k256' ? device.envelope.toString()
    : device.arm === 'p256' ? `${bytesToHex(device.policy.rp_id_hash)}:${bytesToHex(device.policy.origin)}`
      : '';
  return `${device.arm}:${point}:${profile}`;
}

function counterKey(address: Uint8Array, device: AnyDevice, epoch: bigint): string {
  return `${bytesToHex(address)}:${epoch}:${credentialKey(device)}`;
}

function counterHint(address: Uint8Array, device: AnyDevice, epoch: bigint, counter: bigint): DeviceCounterHint {
  return { version: 1, account: bytesToHex(address), credential: credentialKey(device), epoch: epoch.toString(), counter: counter.toString() };
}

function checkCounterScope(
  value: DeviceCounterHint | DeviceCounterCursor,
  account: string,
  credential: string,
): void {
  if (value.version !== 1 || value.account !== account || value.credential !== credential) {
    throw new DeviceCounterCursorError('counter cursor or hint belongs to a different account or credential');
  }
}

function parseCounterUint(value: unknown, maximum: bigint, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
    throw new DeviceCounterCursorError(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new DeviceCounterCursorError(`${label} is out of range`);
  return parsed;
}

// ContractAddress circuit arguments are { bytes: Bytes<32> }; the hex form
// of a deployed address maps to those bytes directly (validated by the
// contract-to-contract transfer experiment).
function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address.replace(/^0x/, ''));
}

function freshPrivateStateId(): string {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `account-${bytesToHex(rand)}`;
}
