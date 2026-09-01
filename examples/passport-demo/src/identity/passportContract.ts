/**
 * The Passport account-custody contract (C1) — browser edition.
 *
 * WHAT THIS IS
 * ------------
 * One deployed instance of `account.compact` per Passport. It holds the device
 * commitment derived from this Passport's passkey, the recovery commitment, and
 * the 2-of-3 recovery shares; from there it custodies NIGHT and shielded coins
 * and carries the grant table. Deploying it is a REAL transaction on whichever
 * network the open wallet signs on — nothing here simulates a deployment.
 *
 * THE NETWORK-GENERAL PATH
 * ------------------------
 * This module takes the open {@link LocalMidnightWallet} — the passkey-derived
 * wallet — and deploys on `wallet.network.networkId`, whatever that is. A
 * localnet is not a mode: the wallet is pointed at it, so the deployment lands
 * there, by exactly the same code that reaches stagenet.
 *
 * WHERE THE CONTRACT COMES FROM (2026/08/24)
 * ------------------------------------------
 * `examples/passport-balancer/contracts-stagenet/managed/account`, staged into
 * this workspace by `scripts/prepare-zk-assets.mjs`. That is the build the
 * stagenet deployment harness used — compactc 0.33.0-rc.2, language 0.25.0,
 * runtime 0.18.0-rc.1 — and the ONLY source change from the preview contracts
 * was the pragma. It replaces the reach into
 * `experiments/account-custody-prototype`, whose managed output is a 0.31.1 /
 * runtime-0.16 build that the ledger-9 runtime refuses on sight:
 * `checkRuntimeVersion` is the generated module's second line.
 *
 * That reach also took the prototype's `PassportAccount` client and its
 * witness helpers with it, and those bound `@midnight-ntwrk/midnight-js-
 * contracts` 4.x from inside the prototype's own tree. The deploy is expressed
 * here instead, against midnight-js 5, in the eleven lines it actually takes.
 * Only the Shamir split is still imported from the prototype — it is byte-wise
 * GF(256) arithmetic with no dependency on any SDK, and duplicating a secret
 * sharing implementation to avoid one import would be the worse trade.
 *
 * All the ledger-9 plumbing — providers, the sponsored/local balancing pair,
 * the ZK config provider, transaction-id resolution — lives in
 * `./contractRuntime.ts`, shared with `./midnames.ts` and `./accountCustody.ts`.
 * The six API differences that mattered are documented there.
 *
 * NETWORK ID: like `./midnames.ts`, this module never calls `setNetworkId`. The
 * live wallet owns the process-wide network id, and moving it would corrupt
 * every address the wallet then encodes.
 *
 * HONESTY: no code path here reports a DEPLOYMENT that did not come back from
 * the chain, and `ledgerConfirmed` is only true when the indexer was seen
 * serving state at that address.
 *
 * Since 2026/08/31 there is a second, weaker thing this module can report, and
 * it is deliberately a different type with a different name. A SUBMISSION —
 * {@link PassportContractSubmission} — carries the contract address before the
 * chain has been asked, because the address is a pure function of the initial
 * contract state the constructor just produced and is therefore known the
 * moment the transaction is built rather than the moment it lands. It has no
 * `ledgerConfirmed` field at all, so it cannot be mistaken for a deployment; it
 * carries a `settled` promise, and only that promise's answer may be reported
 * as an account that exists.
 */


import type { LocalMidnightWallet } from '../lib/localWallet.js';
import { sponsorFeeRefusal, sponsorReadiness } from '../lib/sponsor.js';
import {
  bytesToHex,
  createContractProviders,
  compiledContractFor,
  hexToBytes,
  indexerWsFrom,
  loadContractModule,
  rawContractAddress,
  resolveTransactionHash,
  resolveTxHashOnce,
  wait,
  type ContractFeePayer,
} from './contractRuntime.js';

/** Re-exported: every caller that stores an address normalises through this. */
export { rawContractAddress };

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The window in which the indexer must be seen serving the new contract's
 * state, expressed as attempts times an interval.
 *
 * The WINDOW is sixty seconds and has not changed. The INTERVAL dropped from
 * two seconds to five hundred milliseconds on 2026/08/31, and the attempt count
 * rose by the same factor to hold the window exactly where it was: an indexer
 * query costs 102–123 ms warm (16 samples, stagenet, 2026/08/31), so a two
 * second gap was twenty times the cost of the question it asked, and the
 * overshoot — half an interval on average — was paid on a loop that is entered
 * immediately after something else already waited out the indexer's ~14 s lag.
 *
 * THE RISK, SAID PLAINLY. This loop exists so that a deployment is reported as
 * confirmed only when the chain has been seen carrying it. Shortening the
 * interval without scaling the count would have quietly narrowed the tolerance
 * for a lagging indexer from sixty seconds to fifteen, which is the one thing
 * this loop is for. When the window IS exceeded — an indexer more than a minute
 * behind — nothing is lost and nothing is invented: the deployment is recorded
 * with `ledgerConfirmed: false`, the screen says "submitted" rather than
 * "live", and the transaction id is real either way.
 */
const LEDGER_CONFIRM_ATTEMPTS = 120;
const LEDGER_CONFIRM_INTERVAL_MS = 500;

/* -------------------------------------------------------------------------- */
/* Secret derivation — one passkey ceremony, two domain-separated secrets     */
/* -------------------------------------------------------------------------- */

/**
 * Three independent 32-byte values for the contract's public recovery slots.
 *
 * They are random, unrelated to each other, and unrelated to the recovery
 * secret, so combining any two of them yields noise rather than a secret. See
 * the note at the deploy for why the slots are filled this way.
 */
export function recoverySlotFillers(): [Uint8Array, Uint8Array, Uint8Array] {
  const slot = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
  return [slot(), slot(), slot()];
}

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
/* Private state and witnesses                                                */
/* -------------------------------------------------------------------------- */

/**
 * The account contract's private state: at most three secrets, held as hex
 * strings so every private-state provider serialises them without corruption.
 *
 * This is the prototype's `AccountPrivateState`, restated here rather than
 * imported, because importing it would pull `experiments/account-custody-
 * prototype/src/wallet/witnesses.ts` — and with it that tree's ledger-8
 * `@midnight-ntwrk/compact-runtime` — back into this module graph.
 */
export interface AccountPrivateState {
  deviceSecretHex: string | null;
  grantSecretHex: string | null;
  recoverySecretHex: string | null;
}

export function accountPrivateStateFrom(secrets: {
  deviceSecret?: Uint8Array;
  grantSecret?: Uint8Array;
  recoverySecret?: Uint8Array;
}): AccountPrivateState {
  return {
    deviceSecretHex: secrets.deviceSecret ? bytesToHex(secrets.deviceSecret) : null,
    grantSecretHex: secrets.grantSecret ? bytesToHex(secrets.grantSecret) : null,
    recoverySecretHex: secrets.recoverySecret ? bytesToHex(secrets.recoverySecret) : null,
  };
}

function requireSecret(hex: string | null, name: string): Uint8Array {
  if (!hex) {
    throw new Error(`witness ${name} requested but the secret is not in the private state`);
  }
  return hexToBytes(hex);
}

/**
 * The three witnesses the account circuits take. Each reads the secret out of
 * the private state rather than closing over one, so a client connected without
 * a device secret simply cannot produce device-authorised proofs — the failure
 * is a named throw rather than a proof over the wrong bytes.
 */
export function accountWitnesses() {
  return {
    device_secret(context: { privateState: AccountPrivateState }) {
      return [
        context.privateState,
        requireSecret(context.privateState.deviceSecretHex, 'device_secret'),
      ];
    },
    grant_secret(context: { privateState: AccountPrivateState }) {
      return [
        context.privateState,
        requireSecret(context.privateState.grantSecretHex, 'grant_secret'),
      ];
    },
    recovery_secret(context: { privateState: AccountPrivateState }) {
      return [
        context.privateState,
        requireSecret(context.privateState.recoverySecretHex, 'recovery_secret'),
      ];
    },
  };
}

/** The account module's exported pure circuits, for commitment derivation. */
interface AccountModule {
  pureCircuits: {
    derive_device_commitment(secret: Uint8Array): bigint;
    derive_grant_commitment(secret: Uint8Array): bigint;
    derive_recovery_commitment(secret: Uint8Array): bigint;
  };
  ledger(state: unknown): unknown;
}

export async function loadAccountContract(): Promise<AccountModule> {
  return (await loadContractModule('account')) as unknown as AccountModule;
}

/**
 * Commitments are Field elements (bigint on the TS side), derived through the
 * contract's OWN exported pure circuits, so client and circuit can never
 * disagree on the Poseidon parameters or the domain-separation tags.
 */
export async function deviceCommitment(secret: Uint8Array): Promise<bigint> {
  return (await loadAccountContract()).pureCircuits.derive_device_commitment(secret);
}

/* -------------------------------------------------------------------------- */
/* Errors and results                                                         */
/* -------------------------------------------------------------------------- */

export type PassportContractErrorCode =
  | 'wallet-not-open'
  | 'fee-unavailable'
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

/**
 * Who paid the deployment fee. One value — see {@link ContractFeePayer}: the
 * fee sponsor is a Passport's only fee payer, and a deployment that exists is
 * a deployment the sponsor balanced.
 */
export type PassportContractFeePayer = ContractFeePayer;

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
   * Who paid the fee. `sponsored` is the only answer there is, and it is not a
   * promise being repeated back: `balanceTx` refuses to balance at all unless
   * the sponsor is ready, and the transaction it returns is the one the
   * sponsor's `/balance-only` response carried, so a deployment reaching this
   * line IS the evidence.
   */
  feePaidBy: PassportContractFeePayer;
  deployedAt: string;
}

/**
 * A deployment that has been PROVED, BALANCED, SIGNED, and SUBMITTED, handed
 * back before the indexer has been asked about it.
 *
 * WHY THIS EXISTS (2026/08/31)
 * ---------------------------
 * `deployContract` blocks on `publicDataProvider.watchForTxData(txId)` — see
 * `@midnight-ntwrk/midnight-js-contracts/dist/index.mjs:71-74` — and on
 * stagenet that is a wait on the INDEXER, which runs 13.2–14.1 s behind the
 * node's own tip (16 consecutive observations, 2026/08/31, mean 13.7 s). A
 * claim then spent that wait before it could even ASK for the name, because the
 * name's registration is addressed to a contract address the claim did not yet
 * think it had.
 *
 * It did have it. `createUnprovenDeployTx` returns `public.contractAddress`
 * BEFORE proving, balancing, or submission — the address is
 * `new ContractDeploy(initialState).address` (midnight-js-contracts
 * `dist/index.mjs:937-944`), a pure function of the initial contract state —
 * and the whole of the local work that produces it measured 54 ms in a real
 * tab. So the address is known a full indexer-lag earlier than the claim was
 * using it, and the registration can be asked for on the strength of it.
 *
 * WHAT IS NOT CLAIMED HERE. A submission is not a deployment. This carries no
 * `ledgerConfirmed` field at all, rather than a `false` one that a caller could
 * forget to read: the only thing that says the chain has it is {@link settled},
 * and nothing may report the account as live before that resolves.
 */
export interface PassportContractSubmission {
  /**
   * Raw 64-hex contract address, computed from the constructor's own initial
   * state. It is the address the deployment WILL have if it lands, and the
   * address it already has if it has landed — the chain cannot give it another
   * one.
   */
  address: string;
  /** The network the wallet actually signed on. */
  network: string;
  /** The device commitment the submitted contract carries, as a decimal Field. */
  deviceCommitment: string;
  /** Who paid. See {@link PassportContractDeployment.feePaidBy}. */
  feePaidBy: PassportContractFeePayer;
  /** The 33-byte midnight-js transaction identifier, as submitted. */
  identifier: string;
  submittedAt: string;
  /**
   * The same deployment once the chain has answered.
   *
   * REJECTS when the transaction landed in a state other than
   * `SucceedEntirely`, which is the failure `deployContract` used to raise —
   * the account genuinely does not exist, and a caller that has already asked
   * for a name against its address must hear about it. RESOLVES with
   * `ledgerConfirmed: false` for the far milder case where the indexer simply
   * had not caught up inside {@link LEDGER_CONFIRM_ATTEMPTS}.
   */
  settled: Promise<PassportContractDeployment>;
}

/* -------------------------------------------------------------------------- */
/* Transaction-id resolution and ledger read-back                             */
/* -------------------------------------------------------------------------- */

/**
 * ONE indexer lookup of the ledger hash for a transaction identifier. Exported
 * from here because that is where callers already import it from; the
 * implementation is shared in `./contractRuntime.ts`.
 */
export async function resolveDeployTxHashOnce(
  indexerHttpUrl: string,
  identifier: string,
): Promise<string | null> {
  return resolveTxHashOnce(indexerHttpUrl, identifier);
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
    const reader = indexerPublicDataProvider({
      queryURL: indexerHttpUrl,
      subscriptionURL: indexerWsFrom(indexerHttpUrl),
    });
    return Boolean(await reader.queryContractState(address));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Funds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Re-checks, WITHOUT any passkey prompt, whether the deployment's fee can be
 * covered right now.
 *
 * The deployment moves no NIGHT of its own — it is a fee question only — and a
 * Passport has exactly one fee payer, so this is a question about the SPONSOR
 * and nothing else. No balance is read, because there is no balance a refusal
 * here could be about: the holder is never asked to fund a fee, so telling
 * them what they hold would only invite a step that does not exist.
 *
 * Exposed separately from {@link deployPassportContract} so a re-run can fail
 * closed with the honest reason before asking the user to touch their
 * authenticator.
 */
export async function checkPassportContractFunds(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const readiness = await sponsorReadiness();
  if (readiness.state === 'ready') return { ok: true };
  return { ok: false, reason: sponsorFeeRefusal(readiness) };
}

/* -------------------------------------------------------------------------- */
/* Deployment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds, proves, balances, signs, and SUBMITS this Passport's account-custody
 * contract on the network the open wallet actually signs on — and hands the
 * address back without waiting for the indexer.
 *
 * `rootSecret` is 32 bytes the caller obtained from the passkey with ONE
 * user-verified WebAuthn assertion — that assertion IS this transaction's
 * approval ceremony, the same convention `claimAlias` follows for a name
 * claim. The caller owns those bytes and should zero them afterwards; this
 * function does not retain them.
 *
 * WHY THIS IS SPELLED OUT RATHER THAN LEFT TO `deployContract`
 * -----------------------------------------------------------
 * These are the same five steps `deployContract` runs, in the same order, from
 * the same package: `createUnprovenDeployTx` (which is where the constructor
 * runs and the address falls out), then `submitTxAsync` — which is
 * midnight-js's own name for "prove, balance, submit, and DO NOT wait" — and
 * then the watch, moved into {@link PassportContractSubmission.settled}. The
 * proving, the balancing, and the sponsorship gate are untouched: `proveTx`,
 * `walletProvider.balanceTx`, and `midnightProvider.submitTx` are called by
 * `submitTxCore` exactly as they were, so the fee is still the sponsor's and a
 * sponsor that is not ready still refuses before anything is built.
 *
 * The signing key is sampled here because `deployContract` samples it for you
 * (`createDeployTxOptions`, same module) and the address depends on it: the
 * contract's maintenance authority is part of the initial contract state that
 * the address is the hash of, so it has to be chosen before the address is
 * read, not after.
 *
 * `onProgress` is called for `deriving` and `deploying` only. `confirming`
 * belongs to whoever chooses to wait, because after this returns the waiting is
 * no longer the caller's only business — see {@link deployPassportContract},
 * which does wait and does report it.
 *
 * Every failure mode is a real one. Nothing here reports an address that did
 * not come out of the contract's own constructor, and nothing reports a
 * deployment at all — see {@link PassportContractSubmission}.
 */
export async function submitPassportContract(
  wallet: LocalMidnightWallet,
  rootSecret: Uint8Array,
  onProgress?: (progress: PassportContractProgress) => void,
): Promise<PassportContractSubmission> {
  onProgress?.({ phase: 'deriving' });

  // Fees before secrets: refuse early, with the honest reason, rather than
  // after the user has watched a prover run.
  const funds = await checkPassportContractFunds();
  if (!funds.ok) throw new PassportContractError('fee-unavailable', funds.reason);

  const { deviceSecret, recoverySecret } = await derivePassportContractSecrets(rootSecret);
  const privateStateId = `passport-account-${wallet.network.networkId}`;

  try {
    const accountModule = await loadAccountContract();
    const initialPrivateState = accountPrivateStateFrom({ deviceSecret, recoverySecret });

    const [providers, compiledContract] = await Promise.all([
      createContractProviders(wallet, {
        contract: 'account',
        privateStateId,
        initialPrivateState,
      }),
      compiledContractFor('account', 'passport-account', accountWitnesses()),
    ]);

    /* THE THREE RECOVERY SLOTS ARE DELIBERATELY NOT SHARES OF ANYTHING.

       The contract's constructor takes three Bytes<32> and discloses them into
       public ledger state as `recovery_shares`. Until 2026/09/01 this code put
       real 2-of-3 Shamir shares of the recovery secret there — and since the
       `recover` circuit is live in the deployed contract and its prover key is
       served by this app, anyone who read two shares off the indexer could
       reconstruct the secret, revoke the owner's device, and take the account.
       Every account deployed with real shares is to be treated as
       compromised; on stagenet that is test value only, but it is exactly the
       class of mistake this project has been told not to make.

       Nothing in this application calls `recover` (verified: zero call sites).
       So the slots now hold three independent random values that reconstruct
       nothing, whichever two are combined. The recovery COMMITMENT is still
       derived from the real secret, which only the passkey can re-derive
       (`derivePassportContractSecrets`), so a future recovery scheme keyed on
       that secret stays possible — it will need a contract change to carry
       publicly verifiable shares rather than plain ones, and a redeploy.
       {@link recoverySlotFillers} is the single place this is decided. */
    const [slot1, slot2, slot3] = recoverySlotFillers();
    const deviceCommitment = accountModule.pureCircuits.derive_device_commitment(deviceSecret);

    onProgress?.({ phase: 'deploying' });
    let address: string;
    let identifier: string;
    let unprovenDeploy: UnprovenDeployTxData;
    try {
      const [{ createUnprovenDeployTx, submitTxAsync }, { sampleSigningKey }] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-runtime'),
      ]);
      unprovenDeploy = (await createUnprovenDeployTx(providers as never, {
        compiledContract,
        privateStateId,
        initialPrivateState,
        signingKey: sampleSigningKey(),
        args: [
          deviceCommitment,
          accountModule.pureCircuits.derive_recovery_commitment(recoverySecret),
          slot1,
          slot2,
          slot3,
        ],
      } as never)) as unknown as UnprovenDeployTxData;
      /* The chain cannot hand back a different one — the address IS the hash of
         the state the constructor just produced — but it is still normalised
         through the same refusal every stored address passes. */
      address = rawContractAddress(unprovenDeploy.public.contractAddress);
      identifier = String(
        await submitTxAsync(providers as never, {
          unprovenTx: unprovenDeploy.private.unprovenTx,
        } as never),
      );
      if (!identifier) {
        throw new Error('The deployment was submitted without a transaction id.');
      }
    } catch (cause) {
      throw new PassportContractError(
        'deploy-failed',
        /* Reaches a screen, so it says what the reader was waiting for
           rather than which part of the machinery did not start. */
        'Your Passport account could not be set up.',
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    return {
      address,
      network: wallet.network.networkId,
      deviceCommitment: deviceCommitment.toString(),
      /* Constant because there is one fee payer, and true because `balanceTx`
         refused to produce this transaction any other way. */
      feePaidBy: 'sponsored',
      identifier,
      submittedAt: new Date().toISOString(),
      settled: settlePassportContract(
        wallet,
        providers as ContractProvidersView,
        privateStateId,
        unprovenDeploy,
        {
          address,
          identifier,
          network: wallet.network.networkId,
          deviceCommitment: deviceCommitment.toString(),
        },
      ),
    };
  } finally {
    // The derived secrets are reproducible from the passkey, so nothing is lost
    // by clearing them and something is gained by not leaving them in memory.
    deviceSecret.fill(0);
    recoverySecret.fill(0);
  }
}

/** Only the two provider fields the settle half needs, named rather than `any`. */
interface ContractProvidersView {
  publicDataProvider: {
    watchForTxData(txId: string): Promise<{ status: string }>;
    queryContractState(address: string): Promise<unknown>;
  };
  privateStateProvider: {
    setContractAddress(address: string): void;
    set(id: string, state: unknown): Promise<void>;
    setSigningKey(address: string, key: unknown): Promise<void>;
  };
}

/** What `createUnprovenDeployTx` hands back, narrowed to what is used here. */
interface UnprovenDeployTxData {
  public: { contractAddress: string };
  private: { unprovenTx: unknown; signingKey: unknown; initialPrivateState: unknown };
}

/**
 * The half of a deployment that happens after the wallet has let go of it: wait
 * for the chain, refuse a transaction that did not succeed entirely, resolve
 * the identifier to a ledger hash, and read the new contract's state back.
 *
 * This is `submitDeployTx`'s tail, unchanged in what it checks. The
 * `SucceedEntirely` test is the one `deployContract` raises
 * `DeployTxFailedError` from, and it is kept because it is the whole difference
 * between "the transaction landed" and "the account exists": a fallible-phase
 * failure is recorded on chain and deploys nothing usable.
 */
async function settlePassportContract(
  wallet: LocalMidnightWallet,
  providers: ContractProvidersView,
  privateStateId: string,
  unprovenDeploy: UnprovenDeployTxData,
  submitted: {
    address: string;
    identifier: string;
    network: string;
    deviceCommitment: string;
  },
): Promise<PassportContractDeployment> {
  const { SucceedEntirely } = await import('@midnight-ntwrk/midnight-js-types');
  let finalized: { status: string };
  try {
    finalized = await providers.publicDataProvider.watchForTxData(submitted.identifier);
  } catch (cause) {
    throw new PassportContractError(
      'deploy-failed',
      'Your Passport account could not be set up.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (finalized.status !== SucceedEntirely) {
    throw new PassportContractError(
      'deploy-failed',
      'Your Passport account could not be set up.',
      `the deployment transaction landed with status ${finalized.status}`,
    );
  }

  /* What `submitDeployTx` does once the chain has agreed. The store is
     session-lifetime and in memory (see `contractRuntime.ts`), so these are
     cheap; they are done anyway, because a caller that later builds a client
     against this address through the same provider set should find what
     midnight-js would have left there. */
  providers.privateStateProvider.setContractAddress(submitted.address);
  await providers.privateStateProvider.set(privateStateId, unprovenDeploy.private.initialPrivateState);
  await providers.privateStateProvider.setSigningKey(
    submitted.address,
    unprovenDeploy.private.signingKey,
  );

  const deployTxId = await resolveTransactionHash(
    wallet.network.indexerHttpUrl,
    submitted.identifier,
  );

  // Confirmation is a real read of the new contract's state through the
  // indexer — the check that proves the deployment landed.
  let ledgerConfirmed = false;
  for (let attempt = 0; attempt < LEDGER_CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      if (await providers.publicDataProvider.queryContractState(submitted.address)) {
        ledgerConfirmed = true;
        break;
      }
    } catch {
      // Indexer lag or a transient failure; retried until the window closes.
    }
    await wait(LEDGER_CONFIRM_INTERVAL_MS);
  }

  return {
    address: submitted.address,
    deployTxId,
    network: submitted.network,
    deviceCommitment: submitted.deviceCommitment,
    ledgerConfirmed,
    feePaidBy: 'sponsored',
    deployedAt: new Date().toISOString(),
  };
}

/**
 * Deploys this Passport's account-custody contract and waits for the chain.
 *
 * {@link submitPassportContract} plus its own settlement, which is what every
 * caller wanted before a claim learned to carry on without it — and still what
 * the Home card's retry wants, because a retry has nothing to do next except
 * find out whether it worked.
 */
export async function deployPassportContract(
  wallet: LocalMidnightWallet,
  rootSecret: Uint8Array,
  onProgress?: (progress: PassportContractProgress) => void,
): Promise<PassportContractDeployment> {
  const submission = await submitPassportContract(wallet, rootSecret, onProgress);
  onProgress?.({ phase: 'confirming' });
  return submission.settled;
}
