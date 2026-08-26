/**
 * The ledger-9 contract plumbing every Passport contract client shares.
 *
 * `passportContract.ts`, `midnames.ts`, and `accountCustody.ts` each used to
 * carry their own copy of the provider set, the in-memory private-state store,
 * the sponsored/local balancing pair, and the transaction-id resolver. Three
 * copies of the same thing drifted, and the ledger-9 port would have been three
 * separate ports of the same six differences, so they now share this module.
 * The behaviour is unchanged: same sponsorship rules, same fall-back, same
 * refusal to report a covered fee that was not covered.
 *
 * THE SIX DIFFERENCES THAT MATTER HERE
 * ------------------------------------
 * All verified live against stagenet on 2026/08/24, against the contracts
 * deployed the same day.
 *
 *  1. **`facade.validateTransaction` is unusable on contract CALLS.** The beta
 *     SDK's validation service builds a BLANK ledger state
 *     (`LedgerState.blank(networkId)` with only the real parameters) and runs
 *     `wellFormed` against it, so any transaction that calls a deployed
 *     contract fails with `call to non-existant contract ContractAddress(…)`.
 *     Measured against a TLD that demonstrably existed, at block 157797. It is
 *     never called from here.
 *  2. **One WASM instance.** midnight-js 5.0.0-beta.6 and wallet-sdk
 *     2.0.0-beta.2 both bind `@midnightntwrk/ledger-v9` 1.0.0-rc.3, so the
 *     transaction objects cross between them unconverted. That is what makes
 *     {@link walletProviderFor} a thin adapter rather than a re-serialisation.
 *  3. **`deployContract` takes a `compiledContract`** built through compact-js:
 *     `CompiledContract.make(name, Contract).pipe(withWitnesses |
 *     withVacantWitnesses, withCompiledFileAssets(base))`.
 *  4. **`WalletProvider` is `getCoinPublicKey()` / `getEncryptionPublicKey()` /
 *     `balanceTx(tx: UnboundTransaction, ttl?) → FinalizedTransaction`**, which
 *     maps onto `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe`.
 *     `coinPublicKey` is a 64-hex string on ledger-9, not an object with a
 *     `toHexString()`.
 *  5. **Providers take option objects**, not positional arguments:
 *     `indexerPublicDataProvider({ queryURL, subscriptionURL })`,
 *     `httpClientProofProvider({ url, zkConfigProvider, timeout })`.
 *  6. **The ZK manifest is fail-closed.** `FetchZkConfigProvider` verifies every
 *     artefact against `<base>/compiler/contract-manifest.json` and its
 *     integrity mode defaults to `require`, so the whole `compiler/` directory
 *     has to be staged beside `keys/` and `zkir/`. That is what
 *     `scripts/prepare-zk-assets.mjs` does.
 *
 * NETWORK ID: nothing here calls `setNetworkId`. The live wallet owns the
 * process-wide network id, and moving it would corrupt every address the wallet
 * then encodes.
 */

import * as ledger from '@midnightntwrk/ledger-v9';

import type { LocalMidnightWallet } from '../lib/localWallet.js';
import {
  sponsorBalanceOnly,
  sponsorHexToBytes,
  sponsorFeeRefusal,
  sponsorReadiness,
  BALANCE_WITHOUT_DUST,
  SPONSOR_CONTRACT_RETRY_WINDOW_MS,
} from '../lib/sponsor.js';

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

/** How long a proof server gets for one contract circuit. PLONK is not quick. */
const PROOF_TIMEOUT_MS = 600_000;
/** Default life of a balanced transaction, matching the deployment harness. */
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

export function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, '');
  if (normalized.length % 2 !== 0) throw new Error(`Odd-length hex string: ${value}`);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Normalises a Midnight contract address to its raw 64-hex form, the form the
 * indexer and the explorers both take. Throws rather than guessing, so an
 * address that is not an address can never be persisted as one.
 */
export function rawContractAddress(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

export function contractAddressBytes(value: string): Uint8Array {
  return hexToBytes(rawContractAddress(value));
}

/** The native NIGHT colour, as a Compact `Bytes<32>` argument takes it. */
export function nativeColourBytes(): Uint8Array {
  return hexToBytes(String(ledger.nativeToken().raw));
}

export function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

export const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The transaction id out of a midnight-js result, whatever shape it arrived in.
 * Throws rather than returning an empty string: a call that reports no id is a
 * call nothing may claim landed.
 */
export function transactionId(result: unknown): string {
  const view = result as { public?: { txId?: unknown; transactionHash?: unknown } };
  const value = view?.public?.txId ?? view?.public?.transactionHash;
  if (!value) throw new Error('The contract call returned without a transaction id.');
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* The compiled contract modules                                              */
/* -------------------------------------------------------------------------- */

/** The Passport contracts this app proves circuits for. */
export type PassportContractName = 'account' | 'midnames';

/**
 * The generated contract modules, staged into this workspace by
 * `scripts/prepare-zk-assets.mjs` from the stagenet build.
 *
 * They are staged INSIDE `examples/passport-demo` rather than imported from
 * where they were built, and that is load-bearing. A generated module opens
 * with `import * as __compactRuntime from '@midnight-ntwrk/compact-runtime'`
 * and then `checkRuntimeVersion('0.18.0-rc.1')`, resolved from the module's own
 * directory. Left under `examples/passport-balancer/` it would walk up to the
 * repository root, where the runtime is deliberately the ledger-8 one the
 * funder needs, and refuse to load.
 *
 * Dynamically imported so the Midnight ledger runtime behind them stays out of
 * the initial PWA bundle.
 */
const contractModules = new Map<PassportContractName, Promise<Record<string, unknown>>>();

export function loadContractModule(name: PassportContractName): Promise<Record<string, unknown>> {
  let loaded = contractModules.get(name);
  if (!loaded) {
    /* Literal specifiers, one per contract: a computed path would leave the
       bundler nothing to follow, and `@vite-ignore` on a path inside the
       workspace would ship a runtime `import()` of a file that is not in the
       build output. */
    loaded = (name === 'account'
      ? import('../../contracts/stagenet/account/index.js')
      : import('../../contracts/stagenet/midnames/index.js')) as unknown as Promise<
      Record<string, unknown>
    >;
    contractModules.set(name, loaded);
  }
  return loaded;
}

/**
 * Where the browser fetches a contract's prover keys, verifier keys, ZKIR, and
 * integrity manifest.
 *
 * The PWA serves the staged artefacts from its own origin. A Node harness has
 * no window — and must NOT fake one: a partial window stub flips the wasm
 * runtime's environment sniffing into browser paths and circuit execution dies
 * in an `unreachable` trap (measured 2026/08/19). Harnesses name their static
 * server with PASSPORT_ZK_ORIGIN instead.
 */
export function contractAssetBase(name: PassportContractName): string {
  if (typeof window !== 'undefined') return `${window.location.origin}/zk/${name}`;
  const harnessOrigin =
    typeof process !== 'undefined' ? process.env.PASSPORT_ZK_ORIGIN : undefined;
  if (!harnessOrigin) {
    throw new Error(
      `No origin to load ${name} contract artefacts from: neither window nor PASSPORT_ZK_ORIGIN.`,
    );
  }
  return `${harnessOrigin}/zk/${name}`;
}

/**
 * Builds a compiled contract for `name` with the given witnesses.
 *
 * `withCompiledFileAssets` takes the URL form here, not a filesystem path: the
 * PWA fetches these over HTTP and the ZK config provider is pointed at the same
 * base.
 */
export async function compiledContractFor(
  name: PassportContractName,
  label: string,
  witnesses: unknown,
): Promise<unknown> {
  const [{ CompiledContract }, module] = await Promise.all([
    import('@midnight-ntwrk/compact-js'),
    loadContractModule(name),
  ]);
  /* ONE `pipe` call with both operators, not two chained ones: what `pipe`
     returns is a plain compiled-contract object and carries no `pipe` of its
     own, so a second `.pipe(…)` is a TypeError. */
  return CompiledContract.make(label, module.Contract as never).pipe(
    witnesses === undefined
      ? CompiledContract.withVacantWitnesses
      : CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(contractAssetBase(name)),
  );
}

/* -------------------------------------------------------------------------- */
/* Private state                                                              */
/* -------------------------------------------------------------------------- */

/** Session-lifetime private-state store. Nothing here is persisted. */
export function inMemoryPrivateStateProvider(initial: Record<string, unknown> = {}) {
  const states = new Map<string, unknown>(Object.entries(initial));
  const signingKeys = new Map<string, unknown>();
  return {
    setContractAddress() {},
    async set(id: string, state: unknown) {
      states.set(id, state);
    },
    async get(id: string) {
      return states.has(id) ? states.get(id) : null;
    },
    async remove(id: string) {
      states.delete(id);
    },
    async clear() {
      states.clear();
    },
    async setSigningKey(address: string, key: unknown) {
      signingKeys.set(address, key);
    },
    async getSigningKey(address: string) {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address: string) {
      signingKeys.delete(address);
    },
    async clearSigningKeys() {
      signingKeys.clear();
    },
    async exportPrivateStates(): Promise<never> {
      throw new Error('Private-state export is not supported by the Passport demo.');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The wallet provider                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How a contract transaction's fee was paid. One value, and deliberately.
 *
 * The fee sponsor is the only fee payer a Passport has. `balanceTx` below
 * cannot produce a transaction any other way — it refuses before it builds
 * anything when the sponsor is not ready — so a submitted transaction IS the
 * proof that the sponsor paid for it. There is nothing left to witness after
 * the fact, which is why the out-parameter that used to carry the answer back
 * out of `balanceTx` is gone.
 */
export type ContractFeePayer = 'sponsored';

/**
 * The midnight-js 5 `WalletProvider` + `MidnightProvider`, backed by the beta
 * wallet SDK.
 *
 * This is the join the whole port turns on: midnight-js hands out an
 * `UnboundTransaction` and expects a `FinalizedTransaction` back, which is
 * exactly `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` on the
 * facade. Both sides speak `@midnightntwrk/ledger-v9`, so nothing is
 * re-serialised across the boundary.
 *
 * ONE balancing path, and it is the sponsored one: balance every token kind
 * EXCEPT dust, sign and prove locally, then ask the service to add the fee
 * input. The user still signs; sponsorship removes the cost, not the approval.
 *
 * There is no second path. A Passport holder's fees are covered, full stop, so
 * a sponsor outage is a refusal rather than a bill: `balanceTx` throws with the
 * sponsor's own reason and the reserved coins are released. Nothing here reads
 * or spends the wallet's own dust, and `BALANCE_WITHOUT_DUST` is what keeps
 * that true at the SDK boundary — the facade still knows what dust is, because
 * it must to build a transaction at all, but no code path in this app can make
 * it pay one.
 */
export function walletProviderFor(wallet: LocalMidnightWallet) {
  const facade = wallet.facade as unknown as {
    balanceUnboundTransaction(
      tx: unknown,
      keys: unknown,
      options: { ttl: Date; tokenKindsToBalance?: readonly string[] },
    ): Promise<unknown>;
    signRecipe(recipe: unknown, sign: (data: Uint8Array) => Promise<unknown>): Promise<unknown>;
    finalizeRecipe(signed: unknown): Promise<ledger.FinalizedTransaction>;
    submitTransaction(tx: unknown): Promise<unknown>;
    revert(recipe: unknown): Promise<unknown>;
  };

  const revertQuietly = async (recipe: unknown): Promise<void> => {
    if (recipe === undefined) return;
    try {
      await facade.revert(recipe);
    } catch (cause) {
      // Reserved coins are released when the wallet next syncs anyway.
      console.debug('[contract] could not revert an abandoned balancing recipe', cause);
    }
  };

  const balanceWithSponsor = async (
    tx: unknown,
    ttl: Date,
  ): Promise<ledger.FinalizedTransaction> => {
    let recipe: unknown;
    try {
      recipe = await facade.balanceUnboundTransaction(tx, wallet.keys, {
        ttl,
        tokenKindsToBalance: BALANCE_WITHOUT_DUST,
      });
      const signed = await facade.signRecipe(
        recipe,
        wallet.keys.unshieldedKeystore.signDataAsync,
      );
      /* The SIGNED recipe supersedes the one it was made from, and it is the
         one `finalizeRecipe` books as pending. Reverting the earlier one would
         leave that booking standing, so the local fall-back below would then
         try to balance against coins this wallet has already reserved against
         a transaction nobody will submit — and fail for a reason that looks
         nothing like "the sponsor was unavailable". */
      recipe = signed;
      const finalized = await facade.finalizeRecipe(signed);
      /* A longer 429 window than a transfer gets, because the stakes differ:
         there is nothing to fall back TO here — a busy sponsor is worth
         waiting out rather than turning into a refusal. See
         SPONSOR_CONTRACT_RETRY_WINDOW_MS. */
      const balanced = await sponsorBalanceOnly(finalized.serialize(), {
        pendingRetryWindowMs: SPONSOR_CONTRACT_RETRY_WINDOW_MS,
      });
      /* The sponsor stamps an expiry. An already expired balanced transaction
         is refused here rather than submitted; an empty or unparseable stamp
         reads as "no expiry given". */
      const expiresAtMs = Date.parse(balanced.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        throw new Error(
          `the sponsor's balanced transaction expired at ${balanced.expiresAt} before it could be submitted`,
        );
      }
      return ledger.Transaction.deserialize<
        ledger.SignatureEnabled,
        ledger.Proof,
        ledger.Binding
      >('signature', 'proof', 'binding', sponsorHexToBytes(balanced.txBytes));
    } catch (cause) {
      /* The reserved coins are released first, and only then does the failure
         travel: there is nowhere for it to fall back to, so leaving a booking
         standing would strand shielded or unshielded inputs against a
         transaction nobody will ever submit. */
      await revertQuietly(recipe);
      throw new Error(
        sponsorFeeRefusal({
          state: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
        { cause },
      );
    }
  };

  const walletProvider = {
    /* ledger-9 hands these out as 64-hex strings already — there is no
       `toHexString()` to call, and calling one is a TypeError. */
    getCoinPublicKey: () => wallet.keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.keys.shieldedSecretKeys.encryptionPublicKey,

    async balanceTx(tx: unknown, ttl?: Date): Promise<ledger.FinalizedTransaction> {
      const deadline = ttl ?? new Date(Date.now() + DEFAULT_TTL_MS);
      /* The gate, and the last one: nothing is balanced, signed, or proved
         until the sponsor has said it can pay. A refusal here costs the user a
         sentence; the alternative would cost them a fee they were promised
         they would never be asked for. */
      const readiness = await sponsorReadiness();
      if (readiness.state !== 'ready') throw new Error(sponsorFeeRefusal(readiness));
      return balanceWithSponsor(tx, deadline);
    },

    submitTx: (tx: unknown) => facade.submitTransaction(tx),
  };

  return walletProvider;
}

/* -------------------------------------------------------------------------- */
/* The provider set                                                           */
/* -------------------------------------------------------------------------- */

export interface ContractProvidersOptions {
  /** Which contract's ZK artefacts this set serves. */
  contract: PassportContractName;
  /** The private-state key, when the contract has witnesses that need one. */
  privateStateId?: string;
  initialPrivateState?: unknown;
}

/**
 * The provider set midnight-js 5 wants: the wallet balances, signs, finalises,
 * and submits; the ZK artefacts arrive over HTTP from `/zk/<contract>`; and the
 * circuits are proved wherever this host can prove them.
 *
 * PROVING. A configured proof server wins, because a server is faster than a
 * worker. Where there is none — the stagenet default, since stagenet publishes
 * no proof server — the circuits are proved in-tab by the same zkir-v2 worker
 * that proves the wallet's own legs, wrapped through midnight-js's own
 * `createProofProvider`. There is no third possibility that quietly does
 * nothing: a build with neither a server nor a `Worker` fails here, by name,
 * rather than at the first prove.
 */
export async function createContractProviders(
  wallet: LocalMidnightWallet,
  options: ContractProvidersOptions,
) {
  const [
    { indexerPublicDataProvider },
    { FetchZkConfigProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider'),
  ]);

  const zkConfigProvider = new FetchZkConfigProvider(contractAssetBase(options.contract), {
    /* `globalThis`, not `window`: the identical call has to work under the Node
       drill harness, which deliberately has no window. */
    fetchFunc: globalThis.fetch.bind(globalThis) as never,
  });

  const proofProvider = await createContractProofProvider(wallet, zkConfigProvider);

  const walletProvider = walletProviderFor(wallet);

  return {
    privateStateProvider: inMemoryPrivateStateProvider(
      options.privateStateId ? { [options.privateStateId]: options.initialPrivateState } : {},
    ),
    publicDataProvider: indexerPublicDataProvider({
      queryURL: wallet.network.indexerHttpUrl,
      subscriptionURL: wallet.network.indexerWsUrl,
    }),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/**
 * Where a CONTRACT circuit gets proved. Separate from the wallet's own proving
 * mode because they are separate questions: the wallet's balancing circuits are
 * four fixed system circuits whose keys come from a public bucket, while a
 * contract's keys come from the staged artefacts this app ships.
 */
async function createContractProofProvider(
  wallet: LocalMidnightWallet,
  zkConfigProvider: unknown,
): Promise<unknown> {
  if (wallet.network.provingServerUrl) {
    const { httpClientProofProvider } = await import(
      '@midnight-ntwrk/midnight-js-http-client-proof-provider'
    );
    return httpClientProofProvider({
      url: wallet.network.provingServerUrl,
      zkConfigProvider: zkConfigProvider as never,
      timeout: PROOF_TIMEOUT_MS,
    });
  }

  if (typeof Worker === 'undefined') {
    throw new Error(
      `No way to prove a contract circuit on ${wallet.network.networkId}: no proof server is configured (VITE_MIDNIGHT_PROVING_URL) and this environment has no Worker to prove in. Stagenet publishes no public proof server; run the midnightntwrk/proof-server:9.0.0-rc.6 image locally and point VITE_MIDNIGHT_PROVING_URL at it.`,
    );
  }

  const [{ createProofProvider }, { wasmProvingProvider }] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-types'),
    import('../lib/wasmProver.js'),
  ]);
  return createProofProvider(wasmProvingProvider(zkConfigProvider as never) as never);
}

/* -------------------------------------------------------------------------- */
/* Transaction-id resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE indexer lookup of the ledger hash for a transaction identifier, or `null`
 * when the indexer has no answer yet (or could not be asked).
 *
 * Exported so a surface holding an UNRESOLVED id — one stored while the indexer
 * was still lagging — can ask again later without re-running the whole retry
 * window on a render.
 */
export async function resolveTxHashOnce(
  indexerHttpUrl: string,
  identifier: string,
): Promise<string | null> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash } }`;
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = (await response.json()) as {
      data?: { transactions?: Array<{ hash?: string }> };
    };
    return body.data?.transactions?.[0]?.hash ?? null;
  } catch {
    // Transient network or parse failure — indistinguishable from "not yet".
    return null;
  }
}

/**
 * The ids midnight-js reports are transaction IDENTIFIERS (33 bytes, 66 hex
 * characters), not the 32-byte block-level hashes explorers resolve — a link
 * built from an identifier dies with "not found". The indexer maps one to the
 * other. The transaction is already finalized when this runs, so the retries
 * only cover indexer lag; if every attempt fails the identifier is returned
 * unchanged, which every caller records as UNRESOLVED rather than linking.
 */
export async function resolveTransactionHash(
  indexerHttpUrl: string,
  identifier: string,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const hash = await resolveTxHashOnce(indexerHttpUrl, identifier);
    if (hash) return hash;
    await wait(2_000);
  }
  return identifier;
}
