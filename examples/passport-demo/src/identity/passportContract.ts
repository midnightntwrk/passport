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
 * HONESTY: no code path here reports a deployment that did not come back from
 * the chain. The contract address is read from the deploy transaction's own
 * response and from nowhere else, and `ledgerConfirmed` is only true when the
 * indexer was afterwards seen serving state at that address.
 */


import { split } from '../../../../experiments/account-custody-prototype/src/wallet/shamir.js';
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
  transactionId,
  wait,
  type ContractFeePayer,
} from './contractRuntime.js';

/** Re-exported: every caller that stores an address normalises through this. */
export { rawContractAddress };

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Attempts, at two seconds apart, to see the indexer serve the new state. */
const LEDGER_CONFIRM_ATTEMPTS = 30;
const LEDGER_CONFIRM_INTERVAL_MS = 2_000;

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
 * Deploys this Passport's account-custody contract on the network the open
 * wallet actually signs on.
 *
 * `rootSecret` is 32 bytes the caller obtained from the passkey with ONE
 * user-verified WebAuthn assertion — that assertion IS this transaction's
 * approval ceremony, the same convention `claimAlias` follows for a name
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

    /* The recovery secret is split 2-of-3 and the share VALUES go into public
       ledger state. TODO(PVSS): plain Shamir shares in public state mean anyone
       holding two of them can reconstruct the secret — this is a placeholder
       for a publicly verifiable scheme, and it is called out in the prototype's
       own `shamir.ts` for the same reason. */
    const shares = split(recoverySecret, 2, 3);

    onProgress?.({ phase: 'deploying' });
    let deployed: { deployTxData: { public: { contractAddress: string } } };
    try {
      const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
      deployed = (await deployContract(providers as never, {
        compiledContract,
        privateStateId,
        initialPrivateState,
        args: [
          accountModule.pureCircuits.derive_device_commitment(deviceSecret),
          accountModule.pureCircuits.derive_recovery_commitment(recoverySecret),
          shares[0].value,
          shares[1].value,
          shares[2].value,
        ],
      } as never)) as never;
    } catch (cause) {
      throw new PassportContractError(
        'deploy-failed',
        /* Reaches a screen, so it says what the reader was waiting for
           rather than which part of the machinery did not start. */
        'Your Passport account could not be set up.',
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    // The address is the chain's answer, never ours. `rawContractAddress`
    // refuses anything that is not a contract address rather than storing it.
    const address = rawContractAddress(deployed.deployTxData.public.contractAddress);
    let identifier: string;
    try {
      identifier = transactionId(deployed.deployTxData);
    } catch {
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
    const reader = indexerPublicDataProvider({
      queryURL: wallet.network.indexerHttpUrl,
      subscriptionURL: wallet.network.indexerWsUrl,
    });
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
      deviceCommitment: accountModule.pureCircuits
        .derive_device_commitment(deviceSecret)
        .toString(),
      ledgerConfirmed,
      /* Constant because there is one fee payer, and true because `balanceTx`
         refused to produce this transaction any other way. */
      feePaidBy: 'sponsored',
      deployedAt: new Date().toISOString(),
    };
  } finally {
    // The derived secrets are reproducible from the passkey, so nothing is lost
    // by clearing them and something is gained by not leaving them in memory.
    deviceSecret.fill(0);
    recoverySecret.fill(0);
  }
}
