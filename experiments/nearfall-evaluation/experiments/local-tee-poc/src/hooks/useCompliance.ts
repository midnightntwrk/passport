import {useState, useEffect, useCallback, useRef}   from 'react';
import * as path                                      from 'node:path';
import * as os                                        from 'node:os';
import {fileURLToPath, pathToFileURL}                 from 'node:url';
import {Buffer}                                       from 'buffer';
import {WebSocket}                                    from 'ws';
import * as bip39                                     from 'bip39';
import * as Rx                                        from 'rxjs';
import * as ledger                                    from '@midnight-ntwrk/ledger-v7';
import {WalletFacade}                                 from '@midnight-ntwrk/wallet-sdk-facade';
import {DustWallet}                                   from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {ShieldedWallet}                               from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
}                                                     from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {HDWallet, Roles}                              from '@midnight-ntwrk/wallet-sdk-hd';
import {setNetworkId, getNetworkId}                   from '@midnight-ntwrk/midnight-js-network-id';
import {deployContract, findDeployedContract, getPublicStates} from '@midnight-ntwrk/midnight-js-contracts';
import {CompiledContract}                             from '@midnight-ntwrk/compact-js';
import {NodeZkConfigProvider}                         from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {httpClientProofProvider}                      from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {indexerPublicDataProvider}                    from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {levelPrivateStateProvider}                    from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type {NetworkConfig, TxStatus, ComplianceTier} from '../types.js';
import {logger}                                       from '../logger.js';
import {loadState, saveState, deleteState}            from '../walletCache.js';
import {TeeSession}                                   from '../tee/stub-tee.js';
import type {KycInput, DeviceKeyCircuits}             from '../tee/stub-tee.js';

// ---------------------------------------------------------------------------
// Required SDK workarounds (see lessons-learned.md)
// ---------------------------------------------------------------------------

// Lesson 7: globalThis.WebSocket must be set for GraphQL subscriptions.
(globalThis as any).WebSocket = WebSocket;

// Lesson 1: ledger-v7 7.0.0/7.0.1 ZswapChainState::tryApply panic workaround.
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

// ---------------------------------------------------------------------------
// Contract asset path
// ---------------------------------------------------------------------------

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const MANAGED_PATH = path.resolve(__dirname, '../../contracts/managed/compliance');

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ComplianceOnChainState {
  tier:             ComplianceTier;
  deviceRegistered: boolean;
  updateCount:      bigint;
}

export interface ComplianceSyncState {
  walletReady:      boolean;
  walletAddress:    string | null;
  contractAddress:  string | null;
  onChain:          ComplianceOnChainState | null;
  teeKeyLoaded:     boolean;
  error:            string | null;

  deployTxStatus:   TxStatus;
  registerTxStatus: TxStatus;
  updateTxStatus:   TxStatus;
  resetTxStatus:    TxStatus;

  deploy:    ()                         => Promise<void>;
  connect:   (address: string)          => Promise<void>;
  register:  ()                         => Promise<void>;
  update:    (input: KycInput)          => Promise<void>;
  reset:     ()                         => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal wallet setup
// ---------------------------------------------------------------------------

function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

async function buildWallet(mnemonic: string, network: NetworkConfig) {
  const seedBuf = await bip39.mnemonicToSeed(mnemonic);
  const seed    = seedBuf.toString('hex');
  const keys    = deriveKeys(seed);
  const netId   = network.name === 'undeployed' ? 'undeployed' : network.name;
  setNetworkId(netId as any);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey      = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const unshieldedAddr     = unshieldedKeystore.getBech32Address().toString();

  const indexerHttp = network.indexerUrl;
  const indexerWs   = network.indexerUrl.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:')
                         .replace('/graphql', '/graphql/ws');

  const walletConfig = {
    networkId,
    indexerClientConnection: {indexerHttpUrl: indexerHttp, indexerWsUrl: indexerWs},
    provingServerUrl: new URL(network.proofServerUrl),
    relayURL:         new URL(network.nodeUrl.replace(/^http/, 'ws')),
  };

  // Try to restore each wallet from cache; fall back to fresh start on failure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shieldedWallet: any;
  const savedShielded = loadState(network.name, unshieldedAddr, 'shielded');
  if (savedShielded) {
    try { shieldedWallet = ShieldedWallet(walletConfig).restore(savedShielded); }
    catch {
      logger.warn('Shielded wallet restore failed — evicting cache, starting fresh');
      deleteState(network.name, unshieldedAddr, 'shielded');
      shieldedWallet = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
    }
  } else {
    shieldedWallet = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
  }

  const unshieldedConfig = {
    networkId,
    indexerClientConnection: walletConfig.indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unshieldedWallet: any;
  const savedUnshielded = loadState(network.name, unshieldedAddr, 'unshielded');
  if (savedUnshielded) {
    try { unshieldedWallet = UnshieldedWallet(unshieldedConfig).restore(savedUnshielded); }
    catch {
      logger.warn('Unshielded wallet restore failed — evicting cache, starting fresh');
      deleteState(network.name, unshieldedAddr, 'unshielded');
      unshieldedWallet = UnshieldedWallet(unshieldedConfig).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
    }
  } else {
    unshieldedWallet = UnshieldedWallet(unshieldedConfig).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
  }

  const dustConfig = {
    ...walletConfig,
    costParameters: {additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dustWallet: any;
  const savedDust = loadState(network.name, unshieldedAddr, 'dust');
  if (savedDust) {
    try { dustWallet = DustWallet(dustConfig).restore(savedDust); }
    catch {
      logger.warn('Dust wallet restore failed — evicting cache, starting fresh');
      deleteState(network.name, unshieldedAddr, 'dust');
      dustWallet = DustWallet(dustConfig).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    }
  } else {
    dustWallet = DustWallet(dustConfig).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
  }

  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, unshieldedAddr, indexerHttp, indexerWs, seedBuf};
}

// Lesson 2: signTransactionIntents must be called explicitly.
function signTransactionIntents(
  tx:          {intents?: Map<number, any>},
  signFn:      (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize<
      ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding
    >('signature', proofMarker, 'pre-binding', intent.serialize());
    const sig = signFn(cloned.signatureData(segment));
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? sig,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? sig,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

async function buildProviders(
  walletCtx: Awaited<ReturnType<typeof buildWallet>>,
  network:   NetworkConfig,
) {
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter(s => s.isSynced)),
  );
  const walletProvider = {
    getCoinPublicKey:        () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey:  () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000)},
      );
      const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction,     signFn, 'proof');
      if (recipe.balancingTransaction)
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_PATH);

  // Wallet-specific LevelDB dir (first 16 chars of encryption public key) prevents
  // AES-GCM failures when switching wallets — same pattern as mn-tui.
  // Stored under ~/.cache/local-tee-poc/level-db/{network}/{keyPrefix}/
  const encPublicKey = state.shielded.encryptionPublicKey.toHexString();
  const levelDbPath  = path.join(
    process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'),
    'local-tee-poc', 'level-db', network.name, encPublicKey.slice(0, 16),
  );

  return {
    // Lesson 9: levelPrivateStateProvider required even for simple contracts.
    // midnightDbName controls where LevelDB files are written.
    // privateStoragePasswordProvider is required by newer SDK versions.
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName:        levelDbPath,
      privateStateStoreName: 'compliance-state',
      walletProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(walletCtx.indexerHttp, walletCtx.indexerWs),
    zkConfigProvider,
    proofProvider:      httpClientProofProvider(network.proofServerUrl, zkConfigProvider),
    walletProvider,
    midnightProvider:   walletProvider,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const IDLE: TxStatus = {stage: 'idle'};

export function useCompliance(
  mnemonic:        string | null,
  network:         NetworkConfig,
  contractAddress: string | null,
): ComplianceSyncState {
  type WalletCtx = Awaited<ReturnType<typeof buildWallet>>;

  const [walletReady,      setWalletReady]      = useState(false);
  const [walletAddress,    setWalletAddress]     = useState<string | null>(null);
  const [onChain,          setOnChain]           = useState<ComplianceOnChainState | null>(null);
  const [connectedAddress, setConnectedAddress]  = useState<string | null>(contractAddress);
  const [error,            setError]             = useState<string | null>(null);

  const [deployTxStatus,   setDeployTxStatus]    = useState<TxStatus>(IDLE);
  const [registerTxStatus, setRegisterTxStatus]  = useState<TxStatus>(IDLE);
  const [updateTxStatus,   setUpdateTxStatus]    = useState<TxStatus>(IDLE);
  const [resetTxStatus,    setResetTxStatus]      = useState<TxStatus>(IDLE);

  const walletRef       = useRef<WalletCtx | null>(null);
  const contractMod     = useRef<any>(null);
  const teeSessionRef   = useRef<TeeSession | null>(null);

  // ── Load compiled contract module ─────────────────────────────────────────

  useEffect(() => {
    const contractIndexPath = path.join(MANAGED_PATH, 'contract', 'index.js');
    import(pathToFileURL(contractIndexPath).href)
      .then(mod => { contractMod.current = mod; })
      .catch(err => {
        logger.error('Failed to load compiled contract module', err);
        setError('Contract not compiled. Run: npm run compile');
      });
  }, []);

  // ── Wallet setup ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mnemonic) return;
    let cancelled = false;

    void (async () => {
      try {
        logger.info(`Connecting wallet on ${network.name}…`);
        const ctx = await buildWallet(mnemonic, network);
        if (cancelled) { await ctx.wallet.stop(); return; }
        walletRef.current     = ctx;
        teeSessionRef.current = new TeeSession(ctx.seedBuf);

        // Wait for sync.
        await Rx.firstValueFrom(
          ctx.wallet.state().pipe(Rx.filter(s => s.isSynced)),
        );
        if (cancelled) { await ctx.wallet.stop(); return; }

        setWalletAddress(ctx.unshieldedAddr);
        setWalletReady(true);

        // Persist sync state to cache so future startups restore quickly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const facade = ctx.wallet as any;
        await Promise.all([
          facade.shielded.serializeState().then((s: string) => saveState(network.name, ctx.unshieldedAddr, 'shielded', s)),
          facade.unshielded.serializeState().then((s: string) => saveState(network.name, ctx.unshieldedAddr, 'unshielded', s)),
          facade.dust.serializeState().then((s: string) => saveState(network.name, ctx.unshieldedAddr, 'dust', s)),
        ]).catch((err: unknown) => logger.warn('Failed to persist wallet state', err));
        logger.info('Wallet synced');
      } catch (err) {
        if (cancelled) return;
        logger.error('Wallet setup failed', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      walletRef.current?.wallet.stop().catch(() => {});
      walletRef.current   = null;
      teeSessionRef.current = null;
      setWalletReady(false);
    };
  }, [mnemonic, network.name, network.proofServerUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Poll on-chain state when connected ────────────────────────────────────

  useEffect(() => {
    if (!connectedAddress || !walletRef.current || !contractMod.current) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || !walletRef.current || !contractMod.current) return;
      try {
        const providers  = await buildProviders(walletRef.current, network);
        const pubStates  = await getPublicStates(providers.publicDataProvider, connectedAddress!);
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pub = (contractMod.current as any).ledger(pubStates.contractState.data);
        setOnChain({
          tier:             Number(pub.compliance_tier) as ComplianceTier,
          deviceRegistered: Boolean(pub.device_registered),
          updateCount:      BigInt(pub.update_count ?? 0n),
        });
      } catch (err) {
        if (cancelled) return;
        logger.warn('Failed to read on-chain state', err);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [connectedAddress, walletReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── deploy ────────────────────────────────────────────────────────────────

  const deploy = useCallback(async () => {
    if (!walletRef.current || !contractMod.current) {
      setError('Wallet not ready or contract not compiled');
      return;
    }
    try {
      setDeployTxStatus({stage: 'building'});
      const providers = await buildProviders(walletRef.current, network);
      setDeployTxStatus({stage: 'proving'});
      const compiled = CompiledContract.make('compliance', contractMod.current.Contract).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(MANAGED_PATH),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed = await (deployContract as any)(providers, {
        compiledContract:    compiled,
        privateStateId:      'compliance-state',
        initialPrivateState: {},
      });
      const addr = deployed.deployTxData.public.contractAddress;
      setDeployTxStatus({stage: 'confirmed', txHash: addr});
      setConnectedAddress(addr);
      logger.info(`Contract deployed: ${addr}`);
    } catch (err) {
      logger.error('Deploy failed', err);
      setDeployTxStatus({stage: 'failed', error: err instanceof Error ? err.message : String(err)});
    }
  }, [network]);

  // ── connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(async (address: string) => {
    setConnectedAddress(address);
    setOnChain(null);
    logger.info(`Connecting to contract: ${address}`);
  }, []);

  // ── register ──────────────────────────────────────────────────────────────

  const register = useCallback(async () => {
    if (!walletRef.current || !connectedAddress || !contractMod.current || !teeSessionRef.current) {
      setError('Not ready');
      return;
    }
    try {
      logger.info('Registering device: building transaction…');
      setRegisterTxStatus({stage: 'building'});
      const compiled  = CompiledContract.make('compliance', contractMod.current.Contract).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(MANAGED_PATH),
      );
      const providers = await buildProviders(walletRef.current, network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed  = await (findDeployedContract as any)(providers, {
        contractAddress:     connectedAddress,
        compiledContract:    compiled,
        privateStateId:      'compliance-state',
        initialPrivateState: {},
      });
      logger.info('Registering device: generating ZK proof…');
      setRegisterTxStatus({stage: 'proving'});
      const skDevice   = teeSessionRef.current.getSkDevice();
      const skDeviceBI = BigInt('0x' + skDevice);
      // Yield to the React render loop so the 'proving' stage is painted before
      // callTx.register_device starts (proving and submitting are otherwise batched).
      await new Promise(resolve => setTimeout(resolve, 0));
      setRegisterTxStatus({stage: 'submitting'});
      const txData = await deployed.callTx.register_device(skDeviceBI);
      const txHash = String((txData as any)?.public?.txHash ?? 'ok');
      setRegisterTxStatus({stage: 'confirmed', txHash});
      logger.info(`Device registered: txHash=${txHash}`);
    } catch (err) {
      logger.error('Register failed', err);
      setRegisterTxStatus({stage: 'failed', error: err instanceof Error ? err.message : String(err)});
    }
  }, [connectedAddress, network]);

  // ── update ────────────────────────────────────────────────────────────────

  const update = useCallback(async (input: KycInput) => {
    if (!walletRef.current || !connectedAddress || !contractMod.current || !teeSessionRef.current) {
      setError('Not ready');
      return;
    }
    try {
      logger.info('Updating compliance: building transaction…');
      setUpdateTxStatus({stage: 'building'});

      // Fetch fresh on-chain state to get device_pk and update_count for signing.
      const providers  = await buildProviders(walletRef.current, network);
      const pubStates  = await getPublicStates(providers.publicDataProvider, connectedAddress!);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pub        = (contractMod.current as any).ledger(pubStates.contractState.data);
      const devicePk   = pub.device_pk as {x: bigint; y: bigint};
      const updateCount = BigInt(pub.update_count ?? 0n);

      // Produce Schnorr signature inside the stub TEE.
      // sk_device is NOT passed to the proof server — only (sigR, sigS) leave the TEE.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pureCircuits = (contractMod.current as any).pureCircuits as DeviceKeyCircuits;
      const {sigR, sigS, tier, identityCommitment, nonce} = teeSessionRef.current.signUpdate(
        input,
        devicePk,
        updateCount,
        pureCircuits,
      );

      const compiled  = CompiledContract.make('compliance', contractMod.current.Contract).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(MANAGED_PATH),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed  = await (findDeployedContract as any)(providers, {
        contractAddress:     connectedAddress,
        compiledContract:    compiled,
        privateStateId:      'compliance-state',
        initialPrivateState: {},
      });
      logger.info(`Updating compliance: generating ZK proof (tier=${tier}, nonce=${nonce})…`);
      setUpdateTxStatus({stage: 'proving'});
      await new Promise(resolve => setTimeout(resolve, 0));
      setUpdateTxStatus({stage: 'submitting'});
      const txData = await deployed.callTx.update_compliance(
        sigR,
        sigS,
        BigInt(tier),
        identityCommitment,
        nonce,
      );
      const txHash = String((txData as any)?.public?.txHash ?? 'ok');
      setUpdateTxStatus({stage: 'confirmed', txHash});
      logger.info(`Compliance updated: tier=${tier}, txHash=${txHash}`);
    } catch (err) {
      logger.error('Update failed', err);
      setUpdateTxStatus({stage: 'failed', error: err instanceof Error ? err.message : String(err)});
    }
  }, [connectedAddress, network]);

  // ── reset ─────────────────────────────────────────────────────────────────

  const reset = useCallback(async () => {
    if (!walletRef.current || !connectedAddress || !contractMod.current) {
      setError('Not ready');
      return;
    }
    try {
      setResetTxStatus({stage: 'building'});
      const compiled  = CompiledContract.make('compliance', contractMod.current.Contract).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(MANAGED_PATH),
      );
      const providers = await buildProviders(walletRef.current, network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed  = await (findDeployedContract as any)(providers, {
        contractAddress:     connectedAddress,
        compiledContract:    compiled,
        privateStateId:      'compliance-state',
        initialPrivateState: {},
      });
      setResetTxStatus({stage: 'proving'});
      await deployed.callTx.reset_device();
      setResetTxStatus({stage: 'confirmed', txHash: 'reset'});
      logger.info('Device reset');
    } catch (err) {
      logger.error('Reset failed', err);
      setResetTxStatus({stage: 'failed', error: err instanceof Error ? err.message : String(err)});
    }
  }, [connectedAddress, network]);

  return {
    walletReady,
    walletAddress,
    contractAddress:  connectedAddress,
    onChain,
    teeKeyLoaded:     teeSessionRef.current !== null,
    error,
    deployTxStatus,
    registerTxStatus,
    updateTxStatus,
    resetTxStatus,
    deploy,
    connect,
    register,
    update,
    reset,
  };
}
