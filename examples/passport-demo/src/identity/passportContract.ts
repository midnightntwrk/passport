/**
 * The Passport account-custody contract (C1) — browser edition.
 *
 * WHAT THIS IS
 * ------------
 * One deployed instance of `experiments/account-custody-prototype/contracts/
 * account.compact` per Passport. It holds the device commitment derived from
 * this Passport's passkey, the recovery commitment, and the 2-of-3 recovery
 * shares; from there it custodies NIGHT and shielded coins and carries the
 * grant table. Deploying it is a REAL transaction on whichever network the open
 * wallet signs on — nothing here simulates a deployment.
 *
 * WHY THIS MODULE EXISTS ALONGSIDE `../localC1.ts`
 * -----------------------------------------------
 * `src/localC1.ts` reaches the same contract, but only through the classic
 * Dynamic-hosted desktop experience: every entry point there takes a
 * `MidnightWallet` from `@dynamic-labs/midnight`, calls `getMidnight(wallet)`,
 * and throws unless `midnight.mode === 'local'` AND the launch carries
 * `?demoMode=local`. The passkey wallet has none of those things, so the mobile
 * PWA could never deploy the contract at all.
 *
 * This module is the network-general path: it takes the open
 * {@link LocalMidnightWallet} — the passkey-derived wallet — and deploys on
 * `wallet.network.networkId`, whatever that is. `?demoMode=local` stops being a
 * gate and becomes nothing more than the localnet flavour of the same flow: the
 * wallet is pointed at the localnet, so the deployment lands there.
 *
 * IT IS A LINE-FOR-LINE SIBLING OF `./midnames.ts`
 * -----------------------------------------------
 * Midnames already deploys a real Compact contract from this same passkey
 * wallet on preview (the resolver leaf, on every name claim), so its structure
 * is the proven one and this module copies it deliberately:
 *
 *   - the compiled contract module is imported straight from the prototype's
 *     managed output, so there is ONE build of it in this repository rather
 *     than a copy that can drift;
 *   - ZK artefacts load over URL through `FetchZkConfigProvider`, pointed at
 *     `/zk/account` — served in dev by the Vite middleware in `vite.config.ts`
 *     and staged into `public/zk/account` for a production build by
 *     `scripts/prepare-c1.mjs`, which already compiles and stages this
 *     contract's `compiler`, `keys`, and `zkir` directories. NOTHING here
 *     touches `node:fs`; the Node-side asset discovery in the prototype's own
 *     harnesses is not on this path;
 *   - fees are sponsored when the sponsor service has really said it can pay,
 *     and self-paid from the wallet's own DUST otherwise. The
 *     `balanceWithSponsor` / `balanceLocally` pair below is the same pair
 *     `midnames.ts` uses, including its fall-back and recipe-revert rules.
 *
 * ARTEFACT COMPATIBILITY
 * ----------------------
 * `public/zk/account/compiler/contract-info.json` and the Midnames build carry
 * identical toolchains — compiler 0.31.1, language 0.23.0, runtime 0.16.0. The
 * Midnames leaf deploys on preview with that build, so this contract has no
 * version story of its own: whatever preview's ledger accepts from one, it
 * accepts from the other.
 *
 * NETWORK ID: like `midnames.ts`, this module never calls `setNetworkId`. The
 * live wallet owns the process-wide network id, and moving it would corrupt
 * every address the wallet then encodes.
 *
 * HONESTY: no code path here reports a deployment that did not come back from
 * the chain. The contract address is read from the deploy transaction's own
 * response and from nowhere else, and `ledgerConfirmed` is only true when the
 * indexer was afterwards seen serving state at that address.
 */

import {
  Transaction,
  type Binding,
  type Proof,
  type SignatureEnabled,
} from '@midnight-ntwrk/ledger-v8';
import * as Rx from 'rxjs';

import type { LocalMidnightWallet } from '../lib/localWallet.js';
import {
  sponsorBalanceOnly,
  sponsorHexToBytes,
  sponsorReadiness,
  BALANCE_WITHOUT_DUST,
} from '../lib/sponsor.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How long the wallet facade gets to answer with a state snapshot. */
const STATE_TIMEOUT_MS = 15_000;
/** Attempts, at two seconds apart, to see the indexer serve the new state. */
const LEDGER_CONFIRM_ATTEMPTS = 30;
const LEDGER_CONFIRM_INTERVAL_MS = 2_000;

/* -------------------------------------------------------------------------- */
/* Small helpers — deliberately the same shapes as `./midnames.ts`            */
/* -------------------------------------------------------------------------- */

function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

/* -------------------------------------------------------------------------- */
/* Secret derivation — one passkey ceremony, two domain-separated secrets     */
/* -------------------------------------------------------------------------- */

/**
 * The contract needs TWO independent 32-byte secrets: the device secret (the
 * withdrawal and permission authority) and the recovery secret (which gets
 * split 2-of-3 into public ledger state). Asking the passkey for two seeds
 * would cost two WebAuthn assertions, and therefore two prompts for one user
 * action — which the project's one-prompt-per-action rule forbids.
 *
 * So the caller derives ONE root seed with one assertion, and this function
 * splits it by domain-separated SHA-256, exactly the way
 * `deriveMidnamesOwnerKey` derives the Midnames owner key from the passkey's
 * Midnames scope: `sha256(label padded to 32 bytes || root)`.
 *
 * Being deterministic is the point, not a shortcut: the same passkey re-derives
 * the same device secret, so a Passport restored on another device can still
 * authorise its own contract.
 */
export async function derivePassportContractSecrets(
  rootSecret: Uint8Array,
): Promise<{ deviceSecret: Uint8Array; recoverySecret: Uint8Array }> {
  if (rootSecret.length !== 32) {
    throw new Error(
      `The Passport contract root secret must be 32 bytes, received ${rootSecret.length}.`,
    );
  }
  const derive = async (label: string): Promise<Uint8Array> => {
    const payload = new Uint8Array(64);
    const encoded = new TextEncoder().encode(label);
    if (encoded.length > 32) throw new Error(`Derivation label too long: ${label}`);
    payload.set(encoded);
    payload.set(rootSecret, 32);
    const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
    return new Uint8Array(digest);
  };
  return {
    deviceSecret: await derive('midnight.passport.dev'),
    recoverySecret: await derive('midnight.passport.rec'),
  };
}

/* -------------------------------------------------------------------------- */
/* The generated account contract module                                      */
/* -------------------------------------------------------------------------- */

/**
 * The compiled account contract and its witnesses, imported from the
 * prototype's managed output — the same reach `./midnames.ts` and
 * `../localC1.ts` both make. Dynamically imported so the Midnight ledger
 * runtime behind it stays out of the initial PWA bundle.
 */
let accountModule:
  | Promise<typeof import('../../../../experiments/account-custody-prototype/src/wallet/contract.js')>
  | undefined;

async function loadAccountContract() {
  accountModule ??= import(
    '../../../../experiments/account-custody-prototype/src/wallet/contract.js'
  );
  return accountModule;
}

/** Where the browser fetches this contract's prover keys, verifier keys, and ZKIR. */
function accountAssetBase(): string {
  /* The PWA serves the staged artefacts from its own origin. A Node harness
     has no window — and must NOT fake one: a partial window stub flips the
     wasm runtime's environment sniffing into browser paths and circuit
     execution dies in an `unreachable` trap (measured 2026/08/19, drill runs
     3 and 4). Harnesses name their static server with PASSPORT_ZK_ORIGIN. */
  if (typeof window !== 'undefined') return `${window.location.origin}/zk/account`;
  const harnessOrigin =
    typeof process !== 'undefined' ? process.env.PASSPORT_ZK_ORIGIN : undefined;
  if (!harnessOrigin) {
    throw new Error('No origin to load contract artefacts from: neither window nor PASSPORT_ZK_ORIGIN.');
  }
  return `${harnessOrigin}/zk/account`;
}

/* -------------------------------------------------------------------------- */
/* Errors and results                                                         */
/* -------------------------------------------------------------------------- */

export type PassportContractErrorCode =
  | 'wallet-not-open'
  | 'insufficient-dust'
  | 'deploy-failed'
  | 'network-unreachable';

export class PassportContractError extends Error {
  constructor(
    readonly code: PassportContractErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PassportContractError';
  }
}

export interface PassportContractProgress {
  /**
   * `deriving` covers the local commitment and Shamir work; `deploying` is the
   * real transaction — build, prove, balance, sign, submit; `confirming` is the
   * indexer catching up afterwards.
   */
  phase: 'deriving' | 'deploying' | 'confirming';
}

/** How the deployment fee was really paid. Mirrors `FeeReadiness`'s vocabulary. */
export type PassportContractFeePayer = 'sponsored' | 'own-dust';

export interface PassportContractDeployment {
  /** Raw 64-hex contract address, taken from the deploy transaction's response. */
  address: string;
  /**
   * The deployment transaction, resolved to the 32-byte ledger HASH that
   * explorers take where the indexer could answer, and left as the 33-byte
   * identifier where it could not. Never fabricated.
   */
  deployTxId: string;
  /** The network the wallet actually signed on. */
  network: string;
  /** The device commitment now carried by the contract, as a decimal Field. */
  deviceCommitment: string;
  /**
   * Whether the indexer was afterwards seen serving contract state at
   * {@link address}. `false` means the transaction was still submitted and its
   * id is real — the indexer simply had not caught up inside the window, and
   * the UI says "awaiting the indexer" rather than claiming a confirmed
   * deployment.
   */
  ledgerConfirmed: boolean;
  /**
   * Which side really paid the fee, decided by what the sponsor did — not by
   * what it promised. `sponsored` only when a `/balance-only` response came
   * back and the transaction it returned is the one that was submitted.
   */
  feePaidBy: PassportContractFeePayer;
  deployedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

interface WalletFacadeState {
  shielded: {
    coinPublicKey: { toHexString(): string };
    encryptionPublicKey: { toHexString(): string };
  };
  unshielded: { balances: Record<string, bigint> };
  dust: { balance(now: Date): bigint };
}

async function currentWalletState(wallet: LocalMidnightWallet): Promise<WalletFacadeState> {
  const state = await Rx.firstValueFrom(
    (wallet.facade.state() as Rx.Observable<unknown>).pipe(
      Rx.timeout({ first: STATE_TIMEOUT_MS }),
    ),
  );
  return state as WalletFacadeState;
}

/** Session-lifetime private-state store, mirroring `./midnames.ts`. */
function inMemoryPrivateStateProvider(initial: Record<string, unknown>) {
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

/**
 * Providers for the account-custody circuits: the wallet balances, signs,
 * finalises, and submits; the proof server proves; the ZK artefacts arrive over
 * HTTP from `/zk/account`.
 *
 * `feeWitness` is an out-parameter, not a return value, because whether the
 * sponsor really paid is only known *inside* `balanceTx` — after the service
 * has answered. Reporting a covered fee from anywhere else would be a guess.
 */
async function createAccountProviders(
  wallet: LocalMidnightWallet,
  privateStateId: string,
  initialPrivateState: unknown,
  feeWitness: { paidBy: PassportContractFeePayer },
) {
  const [
    { indexerPublicDataProvider },
    { FetchZkConfigProvider },
    { httpClientProofProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
  ]);

  const state = await currentWalletState(wallet);
  const facade = wallet.facade as unknown as {
    balanceUnboundTransaction(
      tx: unknown,
      keys: unknown,
      options: { ttl: Date; tokenKindsToBalance?: readonly string[] },
    ): Promise<unknown>;
    signRecipe(recipe: unknown, sign: (data: Uint8Array) => unknown): Promise<unknown>;
    finalizeRecipe(signed: unknown): Promise<{ serialize(): Uint8Array }>;
    submitTransaction(tx: unknown): Promise<unknown>;
    revert(recipe: unknown): Promise<unknown>;
  };

  /**
   * The unsponsored path: exactly the code that would run if sponsorship had
   * never existed. The wallet balances every token kind from its own funds,
   * signs, and finalises.
   */
  const balanceLocally = async (tx: unknown, ttl: Date) => {
    const recipe = await facade.balanceUnboundTransaction(tx, wallet.keys, { ttl });
    const signed = await facade.signRecipe(recipe, (data: Uint8Array) =>
      wallet.keys.unshieldedKeystore.signData(data),
    );
    return facade.finalizeRecipe(signed);
  };

  /**
   * The sponsored path: balance every token kind EXCEPT dust, prove and sign
   * locally, then ask the service to add the fee input. The user still signs —
   * sponsorship removes the cost, not the approval. A failure anywhere here
   * returns `null` and the caller falls back to the wallet's own DUST, so a
   * sponsor outage degrades to real fees rather than to a dead deployment.
   */
  const balanceWithSponsor = async (tx: unknown, ttl: Date): Promise<unknown | null> => {
    let recipe: unknown;
    try {
      recipe = await facade.balanceUnboundTransaction(tx, wallet.keys, {
        ttl,
        tokenKindsToBalance: BALANCE_WITHOUT_DUST,
      });
      const signed = await facade.signRecipe(recipe, (data: Uint8Array) =>
        wallet.keys.unshieldedKeystore.signData(data),
      );
      const finalized = await facade.finalizeRecipe(signed);
      const balanced = await sponsorBalanceOnly(finalized.serialize());
      return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
        'signature',
        'proof',
        'binding',
        sponsorHexToBytes(balanced.txBytes),
      );
    } catch (cause) {
      console.warn(
        '[passport-contract] the sponsored balancing failed; falling back to this wallet’s own DUST',
        cause,
      );
      if (recipe !== undefined) {
        try {
          await facade.revert(recipe);
        } catch (revertCause) {
          console.debug(
            '[passport-contract] could not revert an abandoned balancing recipe',
            revertCause,
          );
        }
      }
      return null;
    }
  };

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: unknown, ttl?: Date) {
      const deadline = ttl ?? new Date(Date.now() + 30 * 60 * 1_000);
      if ((await sponsorReadiness()).state === 'ready') {
        const sponsored = await balanceWithSponsor(tx, deadline);
        if (sponsored !== null) {
          // Recorded only now, with the service's own answer in hand.
          feeWitness.paidBy = 'sponsored';
          return sponsored;
        }
      }
      feeWitness.paidBy = 'own-dust';
      return balanceLocally(tx, deadline);
    },
    submitTx: (tx: unknown) => facade.submitTransaction(tx),
  };

  const zkConfigProvider = new FetchZkConfigProvider(
    accountAssetBase(),
    globalThis.fetch.bind(globalThis),
  );

  return {
    privateStateProvider: inMemoryPrivateStateProvider({
      [privateStateId]: initialPrivateState,
    }),
    publicDataProvider: indexerPublicDataProvider(
      wallet.network.indexerHttpUrl,
      wallet.network.indexerWsUrl,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(
      wallet.network.provingServerUrl,
      zkConfigProvider as never,
    ),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function compiledAccountContract(witnesses: unknown) {
  const [{ CompiledContract }, { Contract }] = await Promise.all([
    import('@midnight-ntwrk/compact-js'),
    loadAccountContract(),
  ]);
  return CompiledContract.make('passport-account', Contract as never).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    // URL form, NOT a filesystem path: the PWA fetches these over HTTP, and
    // `FetchZkConfigProvider` is pointed at the same base.
    CompiledContract.withCompiledFileAssets(accountAssetBase()),
  );
}

/* -------------------------------------------------------------------------- */
/* Transaction-id resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE indexer lookup of the ledger hash for a transaction identifier, or
 * `null` when the indexer has no answer yet (or could not be asked).
 *
 * Exported so a surface holding an UNRESOLVED id — one stored while the
 * indexer was still lagging — can ask again later without re-running the whole
 * retry window on a render.
 */
export async function resolveDeployTxHashOnce(
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
 * One read of a contract's public state through the indexer: `true` when the
 * indexer answers for `address`, `false` when it does not or cannot be reached.
 *
 * This is the read-back behind largeBlob account recovery. A passkey blob says
 * an address was written there once; it is not evidence the contract exists,
 * and nothing may be recorded as recovered until this returns `true`. One
 * attempt, no retry loop: a sign-in must not stall on an indexer that is down,
 * and "we could not tell" and "it is not there" are the same answer here — do
 * not claim recovery.
 */
export async function confirmPassportContractOnLedger(
  indexerHttpUrl: string,
  address: string,
): Promise<boolean> {
  try {
    const { indexerPublicDataProvider } = await import(
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
    );
    const reader = indexerPublicDataProvider(indexerHttpUrl, indexerWsFrom(indexerHttpUrl));
    return Boolean(await reader.queryContractState(address));
  } catch {
    return false;
  }
}

/**
 * The ids midnight-js reports are transaction *identifiers* (33 bytes), not the
 * 32-byte block-level hashes explorers resolve — the same trap documented in
 * `./midnames.ts`. The indexer maps one to the other. The transaction is
 * already finalised when this runs, so the retries only cover indexer lag; if
 * every attempt fails the identifier is returned unchanged, and the caller
 * records that it is UNRESOLVED rather than linking it.
 */
async function resolveTransactionHash(
  indexerHttpUrl: string,
  identifier: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const hash = await resolveDeployTxHashOnce(indexerHttpUrl, identifier);
    if (hash) return hash;
    await wait(2_000);
  }
  return identifier;
}

/* -------------------------------------------------------------------------- */
/* Funds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Re-checks, WITHOUT any passkey prompt, whether this wallet can pay for the
 * deployment right now. The deployment moves no NIGHT of its own — it is a fee
 * question only — so a funded sponsor is sufficient and a dustless wallet is
 * refused only when there is no sponsor to cover it.
 *
 * Exposed separately from {@link deployPassportContract} so a re-run can fail
 * closed with the honest reason before asking the user to touch their
 * authenticator.
 */
export async function checkPassportContractFunds(
  wallet: LocalMidnightWallet,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if ((await sponsorReadiness()).state === 'ready') return { ok: true };
  try {
    const state = await currentWalletState(wallet);
    if (state.dust.balance(new Date()) <= 0n) {
      return {
        ok: false,
        reason:
          'This wallet has no DUST, so it cannot pay the deployment fee yet. DUST accrues while NIGHT is held.',
      };
    }
  } catch (cause) {
    // "We could not tell" is not "no funds" — say which it was.
    return {
      ok: false,
      reason: `The wallet could not report its DUST balance: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Deployment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deploys this Passport's account-custody contract on the network the open
 * wallet actually signs on.
 *
 * `rootSecret` is 32 bytes the caller obtained from the passkey with ONE
 * user-verified WebAuthn assertion — that assertion IS this transaction's
 * approval ceremony, the same convention `claimAliasOnChain` follows for a name
 * claim. The caller owns those bytes and should zero them afterwards; this
 * function does not retain them.
 *
 * Every failure mode is a real one. Nothing here reports a deployment without
 * an address that came back from the chain.
 */
export async function deployPassportContract(
  wallet: LocalMidnightWallet,
  rootSecret: Uint8Array,
  onProgress?: (progress: PassportContractProgress) => void,
): Promise<PassportContractDeployment> {
  onProgress?.({ phase: 'deriving' });

  // Fees before secrets: refuse early, with the honest reason, rather than
  // after the user has watched a prover run.
  const funds = await checkPassportContractFunds(wallet);
  if (!funds.ok) throw new PassportContractError('insufficient-dust', funds.reason);

  const { deviceSecret, recoverySecret } = await derivePassportContractSecrets(rootSecret);
  const privateStateId = `passport-account-${wallet.network.networkId}`;
  const feeWitness: { paidBy: PassportContractFeePayer } = { paidBy: 'own-dust' };

  try {
    const [{ PassportAccount }, { privateStateFromSecrets, makeWitnesses }, { deviceCommitment }] =
      await Promise.all([
        import(
          '../../../../experiments/account-custody-prototype/src/wallet/account.js'
        ),
        import(
          '../../../../experiments/account-custody-prototype/src/wallet/witnesses.js'
        ),
        import(
          '../../../../experiments/account-custody-prototype/src/wallet/contract.js'
        ),
      ]);

    const initialPrivateState = privateStateFromSecrets({ deviceSecret, recoverySecret });
    const [providers, compiledContract] = await Promise.all([
      createAccountProviders(wallet, privateStateId, initialPrivateState, feeWitness),
      compiledAccountContract(makeWitnesses()),
    ]);

    onProgress?.({ phase: 'deploying' });
    let account: Awaited<ReturnType<typeof PassportAccount.deploy>>;
    try {
      account = await PassportAccount.deploy(providers, compiledContract, {
        deviceSecret,
        recoverySecret,
        privateStateId,
      });
    } catch (cause) {
      throw new PassportContractError(
        'deploy-failed',
        'The Passport contract could not be deployed.',
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    // The address is the chain's answer, never ours. `PassportAccount.deploy`
    // reads it from `deployTxData.public.contractAddress`; `rawContractAddress`
    // refuses anything that is not a contract address rather than storing it.
    const address = rawContractAddress(account.address);
    const identifier = account.deploymentTxId ?? '';
    if (!identifier || identifier === account.address) {
      throw new PassportContractError(
        'deploy-failed',
        'The deployment returned no transaction id, so it cannot be reported as landed.',
      );
    }

    onProgress?.({ phase: 'confirming' });
    const deployTxId = await resolveTransactionHash(wallet.network.indexerHttpUrl, identifier);

    // Confirmation is a real read of the new contract's state through the
    // indexer — the check that proves the deployment landed.
    const { indexerPublicDataProvider } = await import(
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
    );
    const reader = indexerPublicDataProvider(
      wallet.network.indexerHttpUrl,
      indexerWsFrom(wallet.network.indexerHttpUrl),
    );
    let ledgerConfirmed = false;
    for (let attempt = 0; attempt < LEDGER_CONFIRM_ATTEMPTS; attempt += 1) {
      try {
        if (await reader.queryContractState(address)) {
          ledgerConfirmed = true;
          break;
        }
      } catch {
        // Indexer lag or a transient failure; retried until the window closes.
      }
      await wait(LEDGER_CONFIRM_INTERVAL_MS);
    }

    return {
      address,
      deployTxId,
      network: wallet.network.networkId,
      deviceCommitment: deviceCommitment(deviceSecret).toString(),
      ledgerConfirmed,
      feePaidBy: feeWitness.paidBy,
      deployedAt: new Date().toISOString(),
    };
  } finally {
    // The derived secrets are reproducible from the passkey, so nothing is lost
    // by clearing them and something is gained by not leaving them in memory.
    deviceSecret.fill(0);
    recoverySecret.fill(0);
  }
}
