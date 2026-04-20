import { useState, useEffect, useRef, useCallback }     from 'react';
import * as path                                         from 'node:path';
import * as fs                                           from 'node:fs';
import { pathToFileURL, fileURLToPath }                  from 'node:url';
import { Buffer }                                        from 'buffer';
import { WebSocket }                                     from 'ws';
import * as Rx                                           from 'rxjs';
import * as bip39                                        from 'bip39';
import * as ledger                                       from '@midnight-ntwrk/ledger-v7';
import { WalletFacade }                                  from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet }                                    from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { ShieldedWallet }                                from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
}                                                        from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { HDWallet, Roles }                               from '@midnight-ntwrk/wallet-sdk-hd';
import { setNetworkId }                                  from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract }          from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract }                              from '@midnight-ntwrk/compact-js';
import { NodeZkConfigProvider }                          from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider }                       from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider }                     from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider }                     from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { NetworkConfig, TxStatus }                  from '../types.js';
import { loadState, saveState, deleteState, CACHE_DIR }  from '../walletCache.js';
import { logger }                                       from '../logger.js';

// Allow the wallet SDK to use WebSocket for GraphQL subscriptions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = WebSocket;

// Workaround for ledger-v7 7.0.0/7.0.1 bug: MerkleTree::collapse panics on non-empty
// trees when producing shielded outputs. See: https://github.com/geofflittle/tryapply-crash-repro
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

/** Built-in fungible-token managed/ directory, resolved relative to this module. */
const BUILTIN_FT_MANAGED = fileURLToPath(
  new URL('../../contracts/managed/fungible-token', import.meta.url));

export interface MintResult {
  txHash:    string;
  tokenType: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DustGeneration {
  /** Raw NIGHT units backing DUST generation (÷ 10^6 = displayed NIGHT). */
  designated: bigint;
  /** Raw DUST generated per day (÷ 10^15 = displayed DUST/day). */
  ratePerDay: bigint;
  /** Raw DUST maximum cap across all registered UTXOs (÷ 10^15 = displayed DUST). */
  limit:      bigint;
  /** Latest maxCapReachedAt across all registered UTXOs (when last coin fills). */
  fillTime:   Date;
  /** Number of registered NIGHT UTXOs. */
  numUtxos:   number;
}

export interface WalletBalances {
  shielded:               Record<string, bigint>;
  unshielded:             Record<string, bigint>;
  dust:                   bigint;
  dustGeneration:         DustGeneration | null;
  unregisteredNightUtxos: number;
  registeredNightUtxos:   number;
  /**
   * True if the DUST balance increased at least once in the last ~60 s.
   * False if it stayed flat or dropped over that window.
   * Null if fewer than two samples have been collected yet.
   */
  dustAccruing:           boolean | null;
}

/** A single output within a transfer transaction. */
export interface SendRequest {
  type:    'shielded' | 'unshielded';
  /** Hex token ID; NIGHT = '0'.repeat(64). */
  tokenId: string;
  /** Raw amount (no decimal scaling). */
  amount:  bigint;
  /** Recipient Bech32 address. */
  to:      string;
}

export interface WalletSyncState {
  synced:               boolean;
  balances:             WalletBalances | null;
  walletAddress:        string | null;
  /** Bech32 dust address for this wallet — use as the default DUST receiver. */
  dustAddress:          string | null;
  error:                string | null;
  txStatus:             TxStatus;
  send:                 (requests: SendRequest[]) => Promise<void>;
  resetTx:              () => void;
  deployTxStatus:       TxStatus;
  deploy:               (managedPath: string, witnessesPath: string | null) => Promise<void>;
  resetDeploy:          () => void;
  /** Deploy the built-in fungible-token contract. Returns the contract address. */
  deployFT:             () => Promise<string>;
  mintTxStatus:         TxStatus;
  mintResult:           MintResult | null;
  mint:                 (contractAddress: string, amount: bigint) => Promise<void>;
  resetMint:            () => void;
  designateTxStatus:    TxStatus;
  /** Register unregistered NIGHT UTXOs for DUST generation. */
  designate:            (receiverAddress?: string) => Promise<void>;
  resetDesignate:       () => void;
  deregisterTxStatus:   TxStatus;
  /** Deregister registered NIGHT UTXOs from DUST generation. */
  deregister:           () => Promise<void>;
  resetDeregister:      () => void;
  /**
   * Re-read the live dust balance (walletBalance is time-dependent) and update
   * the dustAccruing sample history.  Call this whenever an external clock
   * ticks (e.g. the chain-status poll) so the DUST display stays current
   * without an independent timer.
   */
  refreshDustBalance:   () => void;
}

// Internal sync-only slice; txStatus/send/resetTx are composed at return time.
type SyncCore = { synced: boolean; balances: WalletBalances | null; error: string | null };
const SYNC_IDLE: SyncCore = { synced: false, balances: null, error: null };

// ---------------------------------------------------------------------------
// Dust accrual helper
// ---------------------------------------------------------------------------

/**
 * Examine a rolling window of (timestamp, balance) samples and determine
 * whether the dust balance increased at any point in the last 60 seconds.
 * Returns null when fewer than two samples fall inside that window.
 */
function computeDustAccruing(
  samples: {ts: number; balance: bigint}[],
  nowMs:   number,
): boolean | null {
  const w60 = samples.filter(x => x.ts >= nowMs - 60_000);
  if (w60.length < 2) return null;
  const first = w60[0].balance;
  const last  = w60[w60.length - 1].balance;
  // Balance is actively decreasing (natural over-cap decay or net-negative
  // generation).  Return null rather than false so the cross-wallet warning
  // is not shown — we cannot distinguish cross-wallet from decay in this state.
  if (last < first) return null;
  return w60.slice(1).some(x => x.balance > first);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Convert an http(s) URL to the corresponding ws(s) URL. */
function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
}

/**
 * Sign any unshielded transaction intents embedded in a balanced recipe.
 * Required by the deployContract walletProvider.balanceTx adapter.
 * Ported from shielding-contracts/src/utils.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signTransactionIntents(tx: any, signFn: (p: Uint8Array) => any, proofMarker: 'proof' | 'pre-proof'): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cloned = (ledger as any).Intent.deserialize(
      'signature', proofMarker, 'pre-binding', intent.serialize());
    const signature = signFn(cloned.signatureData(segment));
    if (cloned.fallibleUnshieldedOffer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map((_: any, i: number) =>
        cloned.fallibleUnshieldedOffer.signatures.at(i) ?? signature);
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map((_: any, i: number) =>
        cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? signature);
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to a WalletFacade state observable.
 * When `mnemonic` is undefined (wallet locked) the hook stays idle.
 * Cleans up (stops the wallet) on unmount or when dependencies change.
 */
export function useWalletSync(
  mnemonic: string | undefined,
  network:  NetworkConfig,
  paused  = false,
): WalletSyncState {
  const [syncState,           setSyncState]           = useState<SyncCore>(SYNC_IDLE);
  const [walletAddress,       setWalletAddress]       = useState<string | null>(null);
  const [dustAddress,         setDustAddress]         = useState<string | null>(null);
  const [txStatus,            setTxStatus]            = useState<TxStatus>({stage: 'idle'});
  const [deployTxStatus,      setDeployTxStatus]      = useState<TxStatus>({stage: 'idle'});
  const [mintTxStatus,        setMintTxStatus]        = useState<TxStatus>({stage: 'idle'});
  const [mintResult,          setMintResult]          = useState<MintResult | null>(null);
  const [designateTxStatus,   setDesignateTxStatus]   = useState<TxStatus>({stage: 'idle'});
  const [deregisterTxStatus,  setDeregisterTxStatus]  = useState<TxStatus>({stage: 'idle'});

  // Refs for wallet internals — accessible from stable send callback without
  // restarting the wallet subscription.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const facadeRef       = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shieldedKeysRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dustKeyRef      = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keystoreRef     = useRef<any>(null);
  const walletAddrRef        = useRef<string | null>(null);
  // Stored so a periodic timer can recompute walletBalance(now) between state emissions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dustStateRef         = useRef<any>(null);
  const dustBalanceSamplesRef = useRef<{ts: number; balance: bigint}[]>([]);

  // Track paused and network via refs so callbacks see the latest values
  // without needing to restart the wallet.
  const pausedRef  = useRef(paused);
  const networkRef = useRef(network);
  useEffect(() => { pausedRef.current  = paused;   }, [paused]);
  useEffect(() => { networkRef.current = network;  }, [network]);

  useEffect(() => {
    if (!mnemonic) {
      setSyncState(SYNC_IDLE);
      setWalletAddress(null);
      setDustAddress(null);
      return;
    }

    let cancelled     = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let facade: any   = null;
    let sub: Rx.Subscription | null = null;
    let persistState: (() => Promise<unknown[]>) | null = null;

    async function start() {
      // Reset dust balance history so stale samples from a previous wallet
      // session don't contaminate the accruing heuristic for this one.
      dustBalanceSamplesRef.current = [];
      dustStateRef.current          = null;
      try {
        setNetworkId(network.name);

        // Derive HD keys from mnemonic
        const seed     = await bip39.mnemonicToSeed(mnemonic!.trim()).then(b => b.toString('hex'));
        const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
        if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
        const result = hdWallet.hdWallet
          .selectAccount(0)
          .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
          .deriveKeysAt(0);
        if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
        hdWallet.hdWallet.clear();
        const keys = result.keys;

        const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
        const dustSecretKey      = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
        const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], network.name);

        // Unshielded address — used as the cache key (deterministic, human-readable).
        const unshieldedAddr = (unshieldedKeystore.getBech32Address() as any).toString() as string;

        // Build WebSocket URLs: indexer HTTP → WS + /ws suffix; relay HTTP → WS
        const indexerHttpUrl = network.indexerUrl;
        const indexerWsUrl   = toWsUrl(indexerHttpUrl) + '/ws';
        const relayURL       = new URL(toWsUrl(network.nodeUrl));
        const provingServerUrl = new URL(network.proofServerUrl);

        const walletCfg = {
          networkId:                network.name,
          indexerClientConnection:  { indexerHttpUrl, indexerWsUrl },
          provingServerUrl,
          relayURL,
        };

        // Attempt to restore each wallet from cache; fall back to fresh start on failure.
        const shieldedWallet = (() => {
          const saved = loadState(network.name, unshieldedAddr, 'shielded');
          if (saved) {
            try { return ShieldedWallet(walletCfg).restore(saved); }
            catch {
              logger.warn('Shielded wallet state restore failed — evicting cache and starting fresh');
              deleteState(network.name, unshieldedAddr, 'shielded');
            }
          }
          return ShieldedWallet(walletCfg).startWithSecretKeys(shieldedSecretKeys);
        })();

        const unshieldedWallet = (() => {
          const saved = loadState(network.name, unshieldedAddr, 'unshielded');
          if (saved) {
            try {
              return UnshieldedWallet({
                networkId:               network.name,
                indexerClientConnection: walletCfg.indexerClientConnection,
                txHistoryStorage:        new InMemoryTransactionHistoryStorage(),
              }).restore(saved);
            } catch {
              logger.warn('Unshielded wallet state restore failed — evicting cache and starting fresh');
              deleteState(network.name, unshieldedAddr, 'unshielded');
            }
          }
          return UnshieldedWallet({
            networkId:               network.name,
            indexerClientConnection: walletCfg.indexerClientConnection,
            txHistoryStorage:        new InMemoryTransactionHistoryStorage(),
          }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
        })();

        const dustWallet = (() => {
          const saved = loadState(network.name, unshieldedAddr, 'dust');
          if (saved) {
            try { return DustWallet({
              ...walletCfg,
              costParameters: {
                additionalFeeOverhead: 300_000_000_000_000n,
                feeBlocksMargin:       5,
              },
            }).restore(saved); }
            catch {
              logger.warn('Dust wallet state restore failed — evicting cache and starting fresh');
              deleteState(network.name, unshieldedAddr, 'dust');
            }
          }
          return DustWallet({
            ...walletCfg,
            costParameters: {
              additionalFeeOverhead: 300_000_000_000_000n,
              feeBlocksMargin:       5,
            },
          }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
        })();

        facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
        await facade.start(shieldedSecretKeys, dustSecretKey);

        // Expose for the stable send() callback.
        facadeRef.current       = facade;
        shieldedKeysRef.current = shieldedSecretKeys;
        dustKeyRef.current      = dustSecretKey;
        keystoreRef.current     = unshieldedKeystore;
        walletAddrRef.current   = unshieldedAddr;
        setWalletAddress(unshieldedAddr);

        if (cancelled) { await facade.stop(); return; }

        // Dust protocol parameters — used to compute backing NIGHT from maxCap.
        const dustParams = ledger.LedgerParameters.initialParameters().dust;

        // Throttle to at most one UI update per second, and skip re-renders when
        // nothing visible changed.  Excludes dust.walletBalance() (time-based) and
        // generatedNow (also time-based); uses coin count + pending count instead.
        // unshieldedKey tracks ALL available + pending unshielded coins so that
        // spending a registered NIGHT UTXO (whose removal from unregKey was 0→0)
        // still triggers a re-render and a fresh read of s.unshielded.balances.
        const stateKey = (s: any): string => {
          const ser = (rec: Record<string, bigint>) =>
            Object.entries(rec as Record<string, bigint>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${k}:${v}`)
              .join(',');
          const dustKey        = `${(s.dust.availableCoins as any[]).length}:${(s.dust.pendingCoins as any[]).length}`;
          // Track ALL unshielded available + pending coins (registered + unregistered) so
          // that spending any NIGHT UTXO — including registered ones — is detected even
          // when s.unshielded.balances hasn't yet updated in the same emission.
          const unshieldedKey  = `${(s.unshielded.availableCoins as any[]).length}:${((s.unshielded as any).pendingCoins as any[] | undefined)?.length ?? 0}`;
          return `${String(s.isSynced)}|${ser(s.shielded.balances)}|${ser(s.unshielded.balances)}|${dustKey}|${unshieldedKey}`;
        };
        // Helper: serialize all three wallets and write to cache.
        persistState = () =>
          Promise.all([
            facade.shielded.serializeState().then(
              (v: string) => saveState(network.name, unshieldedAddr, 'shielded', v)),
            facade.unshielded.serializeState().then(
              (v: string) => saveState(network.name, unshieldedAddr, 'unshielded', v)),
            facade.dust.serializeState().then(
              (v: string) => saveState(network.name, unshieldedAddr, 'dust', v)),
          ]);

        let stateSaved = false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sub = (facade.state() as Rx.Observable<any>).pipe(
          Rx.auditTime(1_000),
          Rx.distinctUntilChanged((prev, curr) => stateKey(prev) === stateKey(curr)),
        ).subscribe({
          next: (s) => {
            if (cancelled || pausedRef.current) return;
            // Capture the dust address on first state emission (deterministic from key).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const addr: string | undefined = (s.dust as any).dustAddress;
            if (addr) setDustAddress(addr);
            // Save state once when the wallet first reaches fully-synced.
            if (s.isSynced === true && !stateSaved) {
              stateSaved = true;
              void persistState?.().catch(
                (e: unknown) => logger.warn(`Wallet state save failed: ${String(e)}`));
            }
            const now   = new Date();
            // Store the dust wallet state so the periodic balance-refresh timer can
            // call walletBalance(new Date()) between state emissions.
            dustStateRef.current = s.dust;
            // Compute dust balance and update rolling sample history.
            const dustBalance = s.dust.walletBalance(now) as bigint;
            {
              const ts = now.getTime();
              dustBalanceSamplesRef.current.push({ts, balance: dustBalance});
              dustBalanceSamplesRef.current = dustBalanceSamplesRef.current.filter(x => x.ts >= ts - 90_000);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const unshieldedCoins = s.unshielded.availableCoins as any[];
            const unregisteredNightUtxos = unshieldedCoins
              .filter((c: any) => !c.meta?.registeredForDustGeneration).length;
            const registeredNightUtxos = unshieldedCoins
              .filter((c: any) => c.meta?.registeredForDustGeneration).length;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const coins = s.dust.availableCoinsWithFullInfo(now) as any[];
            let limitRaw   = 0n;
            let ratePerDay = 0n;
            let fillTime   = new Date(0);
            for (const coin of coins) {
              limitRaw   += coin.maxCap as bigint;
              ratePerDay += (coin.rate  as bigint) * 86_400n;
              const cap: Date = coin.maxCapReachedAt as Date;
              if (cap > fillTime) fillTime = cap;
            }
            const dustGeneration: DustGeneration | null = coins.length > 0 ? {
              designated: dustParams.nightDustRatio > 0n
                ? limitRaw / dustParams.nightDustRatio
                : 0n,
              ratePerDay,
              limit:    limitRaw,
              fillTime,
              numUtxos: coins.length,
            } : null;
            const dustAccruing = computeDustAccruing(dustBalanceSamplesRef.current, now.getTime());
            setSyncState({
              synced:   s.isSynced === true,
              balances: {
                shielded:               s.shielded.balances  as Record<string, bigint>,
                unshielded:             s.unshielded.balances as Record<string, bigint>,
                dust:                   dustBalance,
                // Guard: if the unshielded wallet shows zero registered UTXOs the dust
                // wallet state may be stale.  Trust the unshielded wallet as the authority.
                dustGeneration: registeredNightUtxos > 0 ? dustGeneration : null,
                unregisteredNightUtxos,
                registeredNightUtxos,
                dustAccruing,
              },
              error: null,
            });
          },
          error: (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Wallet sync error', e);
            if (!cancelled) setSyncState({ synced: false, balances: null, error: msg });
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('Wallet sync start failed', e);
        if (!cancelled) setSyncState({ synced: false, balances: null, error: msg });
      }
    }

    void start();

    return () => {
      cancelled = true;
      sub?.unsubscribe();
      facadeRef.current       = null;
      shieldedKeysRef.current = null;
      dustKeyRef.current      = null;
      keystoreRef.current     = null;
      walletAddrRef.current   = null;
      setWalletAddress(null);
      setDustAddress(null);
      if (facade) {
        // Best-effort: persist current state before stopping so the next launch
        // can resume from this point.  facade.stop() runs regardless.
        void (persistState ? persistState() : Promise.resolve()).catch(() => {}).finally(() => facade.stop());
      }
    };
  }, [mnemonic, network.name, network.indexerUrl, network.nodeUrl, network.proofServerUrl]);

  // ---------------------------------------------------------------------------
  // On-demand dust balance refresh
  //
  // walletBalance(now) is time-dependent but the wallet observable only emits
  // on blockchain events.  Callers (e.g. Dashboard when the chain section
  // ticks) can invoke refreshDustBalance() to re-read the live value and
  // update the dustAccruing sample history without an independent timer.
  // The functional setSyncState update returns the previous object unchanged
  // when nothing has changed, so React skips the re-render in that case.
  // ---------------------------------------------------------------------------

  const refreshDustBalance = useCallback(() => {
    const dustState = dustStateRef.current;
    if (!dustState) return;
    const now         = new Date();
    const dustBalance = dustState.walletBalance(now) as bigint;
    const ts          = now.getTime();
    const samples     = dustBalanceSamplesRef.current;
    samples.push({ts, balance: dustBalance});
    dustBalanceSamplesRef.current = samples.filter(x => x.ts >= ts - 90_000);
    const dustAccruing = computeDustAccruing(dustBalanceSamplesRef.current, ts);
    setSyncState(prev => {
      if (!prev.balances) return prev;
      if (prev.balances.dust === dustBalance && prev.balances.dustAccruing === dustAccruing) return prev;
      return {
        ...prev,
        balances: {...prev.balances, dust: dustBalance, dustAccruing},
      };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  const resetTx = useCallback(() => setTxStatus({stage: 'idle'}), []);

  const send = useCallback(async (requests: SendRequest[]): Promise<void> => {
    const f  = facadeRef.current;
    const sk = shieldedKeysRef.current;
    const dk = dustKeyRef.current;
    const ks = keystoreRef.current;
    if (!f || !sk || !dk || !ks) {
      logger.warn('Send: wallet not connected');
      setTxStatus({stage: 'failed', error: 'Wallet not connected'});
      return;
    }
    try {
      setTxStatus({stage: 'building'});

      // Group outputs by transfer type for the SDK.
      const grouped = new Map<string, {type: string; amount: bigint; receiverAddress: string}[]>();
      for (const r of requests) {
        const out = grouped.get(r.type) ?? [];
        out.push({type: r.tokenId, amount: r.amount, receiverAddress: r.to});
        grouped.set(r.type, out);
      }
      const transfers = [...grouped.entries()].map(([type, outputs]) => ({type, outputs}));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recipe = await (f as any).transferTransaction(
        transfers,
        {shieldedSecretKeys: sk, dustSecretKey: dk},
        {ttl: new Date(Date.now() + 30 * 60 * 1000)},
      );

      setTxStatus({stage: 'proving'});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signed = await (f as any).signRecipe(recipe, (payload: Uint8Array) => ks.signData(payload));

      setTxStatus({stage: 'submitting'});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalized = await (f as any).finalizeRecipe(signed);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txHash = await (f as any).submitTransaction(finalized) as string;

      setTxStatus({stage: 'pending', txHash});

      // Log the completed transfer for audit purposes.
      const from = walletAddrRef.current ?? 'unknown';
      if (requests.length === 0) {
        logger.info(`Transfer: empty bundle (DUST fee only) from ${from} | txHash: ${txHash}`);
      }
      for (const r of requests) {
        const night_id = '0'.repeat(64);
        const amtDisplay = r.tokenId === night_id
          ? `${r.amount / 1_000_000n}.${String(r.amount % 1_000_000n).padStart(6, '0')} NIGHT`
          : `${r.amount} ${r.tokenId.slice(0, 8)}…`;
        logger.info(
          `Transfer: ${amtDisplay} (${r.type}) from ${from} to ${r.to} | txHash: ${txHash}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Send failed: ${msg}`, e);
      setTxStatus({stage: 'failed', error: msg});
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Deploy
  // ---------------------------------------------------------------------------

  const resetDeploy = useCallback(() => setDeployTxStatus({stage: 'idle'}), []);

  const deploy = useCallback(async (managedPath: string, witnessesPath: string | null): Promise<void> => {
    const f   = facadeRef.current;
    const sk  = shieldedKeysRef.current;
    const dk  = dustKeyRef.current;
    const ks  = keystoreRef.current;
    const net = networkRef.current;
    if (!f || !sk || !dk || !ks) {
      logger.warn('Deploy: wallet not connected');
      setDeployTxStatus({stage: 'failed', error: 'Wallet not connected'});
      return;
    }
    try {
      setDeployTxStatus({stage: 'building'});

      const absManaged  = path.resolve(managedPath);
      const contractJs  = path.join(absManaged, 'contract', 'index.js');
      if (!fs.existsSync(contractJs)) {
        logger.warn(`Deploy: no compiled contract at ${contractJs}`);
        setDeployTxStatus({stage: 'failed', error: `No compiled contract at ${contractJs}`});
        return;
      }

      // Coin/encryption public keys — wait for a synced state to ensure keys are valid.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state            = await Rx.firstValueFrom(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f as any).state().pipe(Rx.filter((s: any) => s.isSynced)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coinPublicKey    = (state as any).shielded.coinPublicKey.toHexString() as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const encPublicKey     = (state as any).shielded.encryptionPublicKey.toHexString() as string;

      const contractName = path.basename(absManaged);

      // Build the walletProvider adapter that deployContract expects.
      const walletProvider = {
        getCoinPublicKey:       () => coinPublicKey,
        getEncryptionPublicKey: () => encPublicKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async balanceTx(tx: any, ttl?: Date) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const recipe = await (f as any).balanceUnboundTransaction(
            tx,
            {shieldedSecretKeys: sk, dustSecretKey: dk},
            {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)},
          );
          const signFn = (payload: Uint8Array) => ks.signData(payload);
          signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
          if (recipe.balancingTransaction) {
            signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (f as any).finalizeRecipe(recipe);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        submitTx: (tx: any) => (f as any).submitTransaction(tx) as any,
      };

      const indexerHttpUrl = net.indexerUrl;
      const indexerWsUrl   = toWsUrl(indexerHttpUrl) + '/ws';
      const zkCfgProvider  = new NodeZkConfigProvider(absManaged);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providers: any = {
        privateStateProvider: levelPrivateStateProvider({
          // Wallet-specific LevelDB dir prevents AES-GCM failures when switching wallets.
          midnightDbName:       path.join(CACHE_DIR, 'level-db', net.name, encPublicKey.slice(0, 16)),
          privateStateStoreName: contractName + '-state',
          walletProvider,
        }),
        publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
        zkConfigProvider:   zkCfgProvider,
        proofProvider:      httpClientProofProvider(net.proofServerUrl, zkCfgProvider),
        walletProvider,
        midnightProvider:   walletProvider,
      };

      // Load compiled contract module.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contractModule: any = await import(pathToFileURL(contractJs).href);

      // Build CompiledContract, optionally with user-supplied witnesses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let compiledContract: any;
      if (witnessesPath) {
        const absWitnesses  = path.resolve(witnessesPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const witMod: any   = await import(pathToFileURL(absWitnesses).href);
        const witnesses     = witMod.default(walletProvider);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const makeWit: any     = CompiledContract.withWitnesses;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const withAssets: any  = CompiledContract.withCompiledFileAssets;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compiledContract = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
          makeWit(witnesses),
          withAssets(absManaged),
        );
      } else {
        compiledContract = CompiledContract.make(contractName, contractModule.Contract).pipe(
          CompiledContract.withVacantWitnesses,
          CompiledContract.withCompiledFileAssets(absManaged),
        );
      }

      // ZK proof generation + submission — the slow part (~30–60 s).
      setDeployTxStatus({stage: 'proving'});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed: any = await (deployContract as any)(providers, {
        compiledContract,
        privateStateId:      contractName + 'State',
        initialPrivateState: {},
      });

      const contractAddress: string = deployed.deployTxData.public.contractAddress;
      // Reuse the txHash field to carry the contract address to the UI.
      setDeployTxStatus({stage: 'pending', txHash: contractAddress});
      logger.info(`Deployed contract "${contractName}" at ${contractAddress} on ${net.name}`);

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Deploy failed', e);
      setDeployTxStatus({stage: 'failed', error: msg});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Deploy FT — deploys the built-in fungible-token contract; returns address.
  // Used by the Mint screen's "deploy new" flow.
  // ---------------------------------------------------------------------------

  const deployFT = useCallback(async (): Promise<string> => {
    const f   = facadeRef.current;
    const sk  = shieldedKeysRef.current;
    const dk  = dustKeyRef.current;
    const ks  = keystoreRef.current;
    const net = networkRef.current;
    if (!f || !sk || !dk || !ks) throw new Error('Wallet not connected');

    const absManaged = BUILTIN_FT_MANAGED;
    const contractJs = path.join(absManaged, 'contract', 'index.js');
    if (!fs.existsSync(contractJs))
      throw new Error(`No compiled contract at ${contractJs}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await Rx.firstValueFrom(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f as any).state().pipe(Rx.filter((s: any) => s.isSynced)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encPublicKey  = (state as any).shielded.encryptionPublicKey.toHexString() as string;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walletProvider = {
      getCoinPublicKey:       () => coinPublicKey,
      getEncryptionPublicKey: () => encPublicKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async balanceTx(tx: any, ttl?: Date) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recipe = await (f as any).balanceUnboundTransaction(
          tx,
          {shieldedSecretKeys: sk, dustSecretKey: dk},
          {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)},
        );
        const signFn = (payload: Uint8Array) => ks.signData(payload);
        signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
        if (recipe.balancingTransaction) {
          signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (f as any).finalizeRecipe(recipe);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      submitTx: (tx: any) => (f as any).submitTransaction(tx) as any,
    };

    const indexerHttpUrl = net.indexerUrl;
    const indexerWsUrl   = toWsUrl(indexerHttpUrl) + '/ws';
    const zkCfgProvider  = new NodeZkConfigProvider(absManaged);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers: any = {
      privateStateProvider: levelPrivateStateProvider({
        midnightDbName:        path.join(CACHE_DIR, 'level-db', net.name, encPublicKey.slice(0, 16)),
        privateStateStoreName: 'fungible-token-state',
        walletProvider,
      }),
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider:   zkCfgProvider,
      proofProvider:      httpClientProofProvider(net.proofServerUrl, zkCfgProvider),
      walletProvider,
      midnightProvider:   walletProvider,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractModule: any = await import(pathToFileURL(contractJs).href);

    const coinBytes = new Uint8Array(32);
    coinBytes.set(Buffer.from(coinPublicKey.replace(/^0x/, ''), 'hex').subarray(0, 32));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeWit: any    = CompiledContract.withWitnesses;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withAssets: any = CompiledContract.withCompiledFileAssets;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compiledContract = (CompiledContract.make('fungible-token', contractModule.Contract) as any).pipe(
      makeWit({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get_user_shielded_address: (context: any) => [context.privateState, {bytes: coinBytes}],
      }),
      withAssets(absManaged),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployed: any = await (deployContract as any)(providers, {
      compiledContract,
      privateStateId:      'fungibleTokenState',
      initialPrivateState: {},
    });

    const contractAddress: string = deployed.deployTxData.public.contractAddress;
    logger.info(`Deployed fungible-token contract at ${contractAddress} on ${net.name}`);
    return contractAddress;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Mint (fungible-token contract, built-in managed path)
  // ---------------------------------------------------------------------------

  const resetMint = useCallback(() => {
    setMintTxStatus({stage: 'idle'});
    setMintResult(null);
  }, []);

  const mint = useCallback(async (rawContractAddress: string, amount: bigint): Promise<void> => {
    // Normalise: strip any leading 0x so the address is plain hex throughout.
    const contractAddress = rawContractAddress.replace(/^0x/i, '');
    const f   = facadeRef.current;
    const sk  = shieldedKeysRef.current;
    const dk  = dustKeyRef.current;
    const ks  = keystoreRef.current;
    const net = networkRef.current;
    if (!f || !sk || !dk || !ks) {
      logger.warn('Mint: wallet not connected');
      setMintTxStatus({stage: 'failed', error: 'Wallet not connected'});
      return;
    }
    try {
      setMintTxStatus({stage: 'building'});
      setMintResult(null);

      // Wait for a synced state so that coin/encryption keys are fully initialised.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state         = await Rx.firstValueFrom(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f as any).state().pipe(Rx.filter((s: any) => s.isSynced)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const encPublicKey  = (state as any).shielded.encryptionPublicKey.toHexString() as string;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletProvider = {
        getCoinPublicKey:       () => coinPublicKey,
        getEncryptionPublicKey: () => encPublicKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async balanceTx(tx: any, ttl?: Date) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const recipe = await (f as any).balanceUnboundTransaction(
            tx,
            {shieldedSecretKeys: sk, dustSecretKey: dk},
            {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)},
          );
          const signFn = (payload: Uint8Array) => ks.signData(payload);
          signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
          if (recipe.balancingTransaction) {
            signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (f as any).finalizeRecipe(recipe);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        submitTx: (tx: any) => (f as any).submitTransaction(tx) as any,
      };

      const indexerHttpUrl = net.indexerUrl;
      const indexerWsUrl   = toWsUrl(indexerHttpUrl) + '/ws';
      const absManaged     = BUILTIN_FT_MANAGED;
      const contractJs     = path.join(absManaged, 'contract', 'index.js');
      const zkCfgProvider  = new NodeZkConfigProvider(absManaged);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providers: any = {
        privateStateProvider: levelPrivateStateProvider({
          // Wallet-specific LevelDB dir prevents AES-GCM failures when switching wallets.
          midnightDbName:       path.join(CACHE_DIR, 'level-db', net.name, encPublicKey.slice(0, 16)),
          privateStateStoreName: 'fungible-token-state',
          walletProvider,
        }),
        publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
        zkConfigProvider:   zkCfgProvider,
        proofProvider:      httpClientProofProvider(net.proofServerUrl, zkCfgProvider),
        walletProvider,
        midnightProvider:   walletProvider,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contractModule: any = await import(pathToFileURL(contractJs).href);

      // token_id_bytes = contract address as Bytes<32>
      const cleanHex     = contractAddress.replace(/^0x/, '');
      const tokenIdBytes = new Uint8Array(32);
      tokenIdBytes.set(Buffer.from(cleanHex, 'hex').subarray(0, 32));

      // coin public key bytes for the witness
      const coinBytes = new Uint8Array(32);
      coinBytes.set(Buffer.from(coinPublicKey.replace(/^0x/, ''), 'hex').subarray(0, 32));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const makeWit: any    = CompiledContract.withWitnesses;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const withAssets: any = CompiledContract.withCompiledFileAssets;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiledContract = (CompiledContract.make('fungible-token', contractModule.Contract) as any).pipe(
        makeWit({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          get_user_shielded_address: (context: any) => [context.privateState, {bytes: coinBytes}],
        }),
        withAssets(absManaged),
      );

      setMintTxStatus({stage: 'proving'});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract: any = await (findDeployedContract as any)(providers, {
        contractAddress,
        compiledContract,
        privateStateId:      'fungibleTokenState',
        initialPrivateState: {},
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any  = await contract.callTx.mint(amount, tokenIdBytes);
      const txHash       = result.public.txHash   as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenType    = (result.private.newCoins[0] as any)?.type as string ?? '';

      setMintResult({txHash, tokenType});
      setMintTxStatus({stage: 'pending', txHash});
      logger.info(
        `Minted ${amount} token units from contract ${contractAddress} | ` +
        `token type: ${tokenType} | txHash: ${txHash} | network: ${net.name}`);

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Mint failed', e);
      setMintTxStatus({stage: 'failed', error: msg});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Designate NIGHT for DUST generation
  // ---------------------------------------------------------------------------

  const resetDesignate = useCallback(() => setDesignateTxStatus({stage: 'idle'}), []);

  const designate = useCallback(async (receiverAddress?: string): Promise<void> => {
    const f  = facadeRef.current;
    const ks = keystoreRef.current;
    const sk = shieldedKeysRef.current;
    const dk = dustKeyRef.current;
    if (!f || !ks || !sk || !dk) {
      logger.warn('Designate: wallet not connected');
      setDesignateTxStatus({stage: 'failed', error: 'Wallet not connected'});
      return;
    }
    try {
      setDesignateTxStatus({stage: 'building'});

      // Get the latest synced wallet state to read current UTXOs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = await Rx.firstValueFrom(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f as any).state().pipe(Rx.filter((s: any) => s.isSynced)));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const utxos = (state as any).unshielded.availableCoins.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => !c.meta?.registeredForDustGeneration) as any[];

      if (utxos.length === 0) {
        logger.warn('Designate: no unregistered NIGHT UTXOs found');
        setDesignateTxStatus({stage: 'failed', error: 'No unregistered NIGHT UTXOs found'});
        return;
      }

      // registerNightUtxosForDustGeneration takes the UTXOs, unshielded public key,
      // an inline signing function, and an optional receiver address for DUST.
      // When no address is supplied the SDK defaults to the dust wallet's own address,
      // which is the correct behaviour — so just pass through what the caller provided.
      const dustReceiver = receiverAddress ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recipe = await (f as any).registerNightUtxosForDustGeneration(
        utxos,
        ks.getPublicKey(),
        (payload: Uint8Array) => ks.signData(payload),
        dustReceiver,
      );

      setDesignateTxStatus({stage: 'submitting'});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalized = await (f as any).finalizeRecipe(recipe);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txHash = await (f as any).submitTransaction(finalized) as string;

      setDesignateTxStatus({stage: 'pending', txHash});
      logger.info(`Registered ${utxos.length} NIGHT UTXO(s) for DUST generation | txHash: ${txHash}`);

    } catch (e) {
      logger.error('Designate failed', e);
      setDesignateTxStatus({stage: 'failed', error: e instanceof Error ? e.message : String(e)});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Deregister NIGHT from DUST generation
  // ---------------------------------------------------------------------------

  const resetDeregister = useCallback(() => setDeregisterTxStatus({stage: 'idle'}), []);

  const deregister = useCallback(async (): Promise<void> => {
    const f  = facadeRef.current;
    const ks = keystoreRef.current;
    const sk = shieldedKeysRef.current;
    const dk = dustKeyRef.current;
    if (!f || !ks || !sk || !dk) {
      logger.warn('Deregister: wallet not connected');
      setDeregisterTxStatus({stage: 'failed', error: 'Wallet not connected'});
      return;
    }
    try {
      setDeregisterTxStatus({stage: 'building'});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = await Rx.firstValueFrom(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f as any).state().pipe(Rx.filter((s: any) => s.isSynced)));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const utxos = (state as any).unshielded.availableCoins.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => c.meta?.registeredForDustGeneration === true) as any[];

      if (utxos.length === 0) {
        logger.warn('Deregister: no registered NIGHT UTXOs found');
        setDeregisterTxStatus({stage: 'failed', error: 'No registered NIGHT UTXOs found'});
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recipe = await (f as any).deregisterFromDustGeneration(
        utxos,
        ks.getPublicKey(),
        (payload: Uint8Array) => ks.signData(payload),
      );

      // Deregistration sets allowFeePayment=0n (unlike registration which covers its own
      // fee via future DUST).  Explicitly balance the transaction so the DUST wallet adds
      // a fee-payment balancing transaction before we finalize and submit.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const balancedRecipe = await (f as any).balanceUnprovenTransaction(
        recipe.transaction,
        {shieldedSecretKeys: sk, dustSecretKey: dk},
        {ttl: new Date(Date.now() + 30 * 60_000)},
      );

      setDeregisterTxStatus({stage: 'submitting'});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalized = await (f as any).finalizeRecipe(balancedRecipe);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txHash = await (f as any).submitTransaction(finalized) as string;

      setDeregisterTxStatus({stage: 'pending', txHash});
      logger.info(`Deregistered ${utxos.length} NIGHT UTXO(s) from DUST generation | txHash: ${txHash}`);

    } catch (e) {
      logger.error('Deregister failed', e);
      setDeregisterTxStatus({stage: 'failed', error: e instanceof Error ? e.message : String(e)});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ...syncState, walletAddress, dustAddress, txStatus, send, resetTx,
    deployTxStatus, deploy, resetDeploy, deployFT,
    mintTxStatus, mintResult, mint, resetMint,
    designateTxStatus, designate, resetDesignate,
    deregisterTxStatus, deregister, resetDeregister,
    refreshDustBalance,
  };
}
