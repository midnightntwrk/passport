/**
 * Dynamic contract settlement for Passport C1 (Dynamic 4.96.0+).
 *
 * `MidnightWallet.getWalletProvider()` returns a midnight-js compatible
 * wallet-and-submission provider backed by the embedded-wallet iframe: it
 * balances an already call-proved `UnboundTransaction`, pays the DUST fee,
 * MPC-signs, and submits — only serialized transactions ever cross the
 * boundary. This module assembles the six `MidnightProviders` around that
 * provider and exposes deploy/call/confirm helpers for the Passport C1
 * contract.
 *
 * Division of proving labour (verified against the Dynamic 4.96.0 surface):
 *  - OUR circuits (add_device, register_permission, revoke_permission) are
 *    proved by this dApp's proof provider against `/zk/passport-c1` artefacts.
 *    A deployment proves nothing, so it never needs the proof server.
 *  - The built-in balancing circuits (midnight/zswap/input, midnight/zswap/
 *    output, midnight/zswap/spend) are proved by the wallet itself inside the
 *    iframe. Serving artefacts for them from our route makes the proof server
 *    reject with a bare 400 — the zk config provider below therefore refuses
 *    every circuit id it does not own.
 *
 * SUBMISSION IDENTIFIER vs TRANSACTION HASH: the provider's `submitTx`
 * resolves to a submission identifier, NOT the canonical chain hash the
 * explorer indexes. Inclusion is confirmed by polling the indexer's
 * `transactions(offset: { identifier })` point lookup — see
 * {@link confirmDynamicSubmission}.
 */

import type { MidnightWallet, MidnightContractWalletProvider } from '@dynamic-labs/midnight';
import type { FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';

import { fingerprintDynamicSignature } from '../../../../experiments/account-custody-prototype/src/wallet/dynamic-transaction.js';
import { inMemoryPrivateStateProvider } from '../../../../experiments/account-custody-prototype/app/src/lib/providers.js';
import {
  PASSPORT_C1_NETWORK,
  compiledPassportC1Contract,
  passportC1ConstructorArgs,
  type PassportC1PrivateState,
} from '../c1.js';
import { toIndexerWebSocketUrl } from './indexerTx.js';

/** Preview indexer. The WebSocket URL is derived from this (`…/graphql/ws`). */
export const MIDNIGHT_INDEXER_URL: string =
  import.meta.env.VITE_INDEXER_URL ?? 'https://indexer.preview.midnight.network/api/v4/graphql';

/**
 * Proof server for OUR circuits only — the wallet proves its own zswap/DUST
 * work inside the embedded-wallet iframe. Deployments never contact it.
 */
export const MIDNIGHT_PROVING_URL: string =
  import.meta.env.VITE_MIDNIGHT_PROVING_URL ?? 'https://proof-server.preview.midnight.network';

/** Every circuit the passport_c1 contract owns (public/zk/passport-c1). */
export const PASSPORT_C1_CIRCUIT_IDS = ['add_device', 'register_permission', 'revoke_permission'] as const;
export type PassportC1CircuitId = (typeof PASSPORT_C1_CIRCUIT_IDS)[number];

/** Matches the local C1 path's 30-minute default in `createProviders`. */
const DEFAULT_BALANCE_TTL_MS = 30 * 60 * 1_000;

const CONFIRM_TIMEOUT_MS = 120_000;
const CONFIRM_POLL_INTERVAL_MS = 3_000;

/* -------------------------------------------------------------------------- */
/* zk artefacts — guarded fetch and owned-circuit allowlist                   */
/* -------------------------------------------------------------------------- */

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * `fetch` that refuses HTML answers. Dev servers (Vite included) answer
 * unknown paths with `200` + `index.html`; passing that through would
 * silently embed HTML bytes in a proof preimage.
 */
const guardedZkArtefactFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await globalThis.fetch(input, init);
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(
      `The zk artefact request for ${requestUrl(input)} answered with HTML rather than a binary artefact — ` +
        'almost certainly a dev-server index.html fallback for a missing file. Refusing to hand it to the prover.',
    );
  }
  return response;
}) as typeof fetch;

/**
 * `FetchZkConfigProvider` limited to the circuits passport_c1 owns.
 *
 * It THROWS for any other circuit id — including the built-in balancing
 * circuits (`midnight/zswap/output`, `midnight/zswap/input`,
 * `midnight/zswap/spend`): those are the wallet's to prove, and serving
 * artefacts for circuits we do not own makes the proof server reject the
 * whole transaction with a bare 400.
 */
class PassportC1ZkConfigProvider extends FetchZkConfigProvider<PassportC1CircuitId> {
  constructor(baseURL: string) {
    super(baseURL, guardedZkArtefactFetch);
  }

  private assertOwned(circuitId: string): void {
    if (!(PASSPORT_C1_CIRCUIT_IDS as readonly string[]).includes(circuitId)) {
      throw new Error(
        `The Passport C1 zk config provider does not own circuit '${circuitId}' ` +
          `(owned: ${PASSPORT_C1_CIRCUIT_IDS.join(', ')}). Built-in balancing circuits ` +
          'are proved by the Dynamic embedded wallet, never from this artefact route.',
      );
    }
  }

  override getProverKey(circuitId: PassportC1CircuitId) {
    this.assertOwned(circuitId);
    return super.getProverKey(circuitId);
  }

  override getVerifierKey(circuitId: PassportC1CircuitId) {
    this.assertOwned(circuitId);
    return super.getVerifierKey(circuitId);
  }

  override getZKIR(circuitId: PassportC1CircuitId) {
    this.assertOwned(circuitId);
    return super.getZKIR(circuitId);
  }
}

/* -------------------------------------------------------------------------- */
/* The wallet-bound provider — cached because the first call cold-syncs      */
/* -------------------------------------------------------------------------- */

type WalletBoundProvider = MidnightContractWalletProvider<UnboundTransaction, FinalizedTransaction>;

const walletProviderCache = new WeakMap<object, Promise<WalletBoundProvider>>();

/** True when the installed Dynamic SDK exposes embedded-wallet contract settlement. */
export function dynamicSupportsContractSettlement(wallet: MidnightWallet): boolean {
  return typeof (wallet as { getWalletProvider?: unknown }).getWalletProvider === 'function';
}

/**
 * Resolves (and caches) the embedded wallet's contract provider.
 *
 * The FIRST call performs the embedded wallet's full cold sync inside the
 * iframe — well over a minute with no intermediate progress. The promise is
 * memoised per connector so React.StrictMode's double-mounted effects and
 * retries never trigger a second sync.
 */
export function dynamicWalletBoundProvider(wallet: MidnightWallet): Promise<WalletBoundProvider> {
  if (!dynamicSupportsContractSettlement(wallet)) {
    return Promise.reject(
      new Error(
        'This Dynamic SDK does not expose getWalletProvider, so it cannot settle Passport C1 contract transactions. ' +
          'Dynamic 4.96.0 or later is required; this path stays disabled rather than simulating a deployment.',
      ),
    );
  }
  const key: object = (wallet.connector as object | undefined) ?? wallet;
  const cached = walletProviderCache.get(key);
  if (cached) return cached;
  const pending = wallet.getWalletProvider<UnboundTransaction, FinalizedTransaction>();
  walletProviderCache.set(key, pending);
  pending.catch(() => walletProviderCache.delete(key));
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Approval receipts — signMessage bound to the exact transaction bytes      */
/* -------------------------------------------------------------------------- */

export interface DynamicSettlementIntent {
  /** '(assigned at deployment)' until the contract address exists. */
  readonly contractAddress: string;
  readonly circuit: string;
  readonly summary: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface DynamicSettlementReceipt {
  /**
   * The identifier `submitTx` resolved with. This is a SUBMISSION IDENTIFIER,
   * NOT the canonical transaction hash: the explorer will not resolve it.
   * Confirm inclusion — and obtain the real hash — with
   * {@link confirmDynamicSubmission}.
   */
  readonly submissionId: string;
  readonly unboundTransactionDigest: string;
  readonly finalizedTransactionDigest: string;
  readonly approvalMessage: string;
  readonly approvalSignature: string;
  readonly approvalSignatureFingerprint: string;
  readonly approvedAt: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

/**
 * Human-readable approval message, version 2: settlement moved from the
 * bespoke proof capability protocol to Dynamic's documented embedded-wallet
 * provider, but the receipt stays bound to both transaction digests.
 */
function buildSettlementApprovalMessage(
  intent: DynamicSettlementIntent,
  walletAddress: string,
  unboundTransactionDigest: string,
  finalizedTransactionDigest: string,
  approvedAt: string,
): string {
  const argumentLines = Object.entries(intent.arguments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`);
  return [
    'MN Passport C1 transaction approval',
    'Version: 2',
    `Network: ${PASSPORT_C1_NETWORK}`,
    `Wallet: ${walletAddress}`,
    `Contract: ${intent.contractAddress}`,
    `Circuit: ${intent.circuit}`,
    `Summary: ${intent.summary}`,
    ...argumentLines,
    'Settlement: dynamic-embedded-wallet-provider (getWalletProvider)',
    `Unbound transaction SHA-256: ${unboundTransactionDigest}`,
    `Finalized transaction SHA-256: ${finalizedTransactionDigest}`,
    `Approved at: ${approvedAt}`,
  ].join('\n');
}

/**
 * Wraps the wallet-bound provider so that every submission carries an
 * explicit signMessage approval receipt bound to the exact unbound and
 * finalized transaction bytes — preserving the approval-binding behaviour of
 * the previous fail-closed path. A rejected approval releases the balanced
 * transaction's reserved inputs and never broadcasts.
 */
function settlementProvider(
  wallet: MidnightWallet,
  inner: WalletBoundProvider,
  intent: DynamicSettlementIntent,
  onReceipt: (receipt: DynamicSettlementReceipt) => void,
): WalletBoundProvider {
  let pending: { unboundTransactionDigest: string; finalizedTransactionDigest: string } | null = null;

  return {
    getCoinPublicKey: () => inner.getCoinPublicKey(),
    getEncryptionPublicKey: () => inner.getEncryptionPublicKey(),
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
      const unboundTransactionDigest = await sha256Hex(tx.serialize());
      const finalized = await inner.balanceTx(tx, ttl ?? new Date(Date.now() + DEFAULT_BALANCE_TTL_MS));
      pending = {
        unboundTransactionDigest,
        finalizedTransactionDigest: await sha256Hex(finalized.serialize()),
      };
      return finalized;
    },
    async submitTx(tx: FinalizedTransaction): Promise<string> {
      if (!pending) {
        throw new Error('Dynamic settlement received a transaction it did not balance; refusing to submit it.');
      }
      const bytes = tx.serialize();
      const finalizedTransactionDigest = await sha256Hex(bytes);
      if (finalizedTransactionDigest !== pending.finalizedTransactionDigest) {
        throw new Error('The transaction being submitted is not the one the wallet balanced; refusing to submit it.');
      }
      const { unboundTransactionDigest } = pending;
      pending = null;

      let approvalMessage: string;
      let approvalSignature: string;
      let approvedAt: string;
      try {
        approvedAt = new Date().toISOString();
        approvalMessage = buildSettlementApprovalMessage(
          intent,
          wallet.address,
          unboundTransactionDigest,
          finalizedTransactionDigest,
          approvedAt,
        );
        approvalSignature = (await wallet.signMessage(approvalMessage)) ?? '';
        if (!approvalSignature) throw new Error('Dynamic did not return the C1 approval signature.');
      } catch (error) {
        try {
          // Release the balanced transaction's reserved inputs — nothing was broadcast.
          await wallet.revertTransaction(bytesToBase64(bytes));
        } catch {
          // Preserve the original approval error.
        }
        throw error;
      }
      const approvalSignatureFingerprint = await fingerprintDynamicSignature(approvalSignature);

      const submissionId = await inner.submitTx(tx);
      if (!submissionId) {
        throw new Error('Dynamic completed submitTx without returning a submission identifier.');
      }
      onReceipt({
        submissionId,
        unboundTransactionDigest,
        finalizedTransactionDigest,
        approvalMessage,
        approvalSignature,
        approvalSignatureFingerprint,
        approvedAt,
      });
      return submissionId;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The six MidnightProviders                                                  */
/* -------------------------------------------------------------------------- */

export interface DynamicPassportC1Providers {
  privateStateProvider: unknown;
  publicDataProvider: unknown;
  zkConfigProvider: PassportC1ZkConfigProvider;
  proofProvider: unknown;
  walletProvider: WalletBoundProvider;
  midnightProvider: WalletBoundProvider;
}

/**
 * Assembles the six `MidnightProviders` for the Dynamic settlement path.
 *
 * `walletProvider` and `midnightProvider` are the SAME object: the embedded
 * wallet's provider (wrapped with the approval receipt). The other four stay
 * ours, mirroring the local C1 assembly in the account-custody prototype's
 * `createProviders`: an in-memory private state provider (secrets live for
 * the page session; the device secret is re-derived from the passkey), the
 * public indexer, the guarded `/zk/passport-c1` artefact route, and the HTTP
 * proof provider for our circuits only.
 */
export async function createDynamicPassportC1Providers(
  wallet: MidnightWallet,
  intent: DynamicSettlementIntent,
  onReceipt: (receipt: DynamicSettlementReceipt) => void,
): Promise<DynamicPassportC1Providers> {
  const bound = await dynamicWalletBoundProvider(wallet);
  const provider = settlementProvider(wallet, bound, intent, onReceipt);
  const zkConfigProvider = new PassportC1ZkConfigProvider(`${window.location.origin}/zk/passport-c1`);
  return {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(MIDNIGHT_INDEXER_URL, toIndexerWebSocketUrl(MIDNIGHT_INDEXER_URL)),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(MIDNIGHT_PROVING_URL, zkConfigProvider),
    walletProvider: provider,
    midnightProvider: provider,
  };
}

/* -------------------------------------------------------------------------- */
/* Deploy and call                                                            */
/* -------------------------------------------------------------------------- */

function assertPreviewWallet(wallet: MidnightWallet): void {
  if (MidnightBech32m.parse(wallet.address).network !== PASSPORT_C1_NETWORK) {
    throw new Error('Passport C1 pilot deployments are preview-only. Switch the Dynamic Midnight wallet to preview.');
  }
}

export type DynamicSettlementPhase = 'connecting-wallet-provider' | 'proving-and-balancing' | 'submitting';

export interface DynamicC1DeploymentResult {
  contractAddress: string;
  privateStateId: string;
  /** See {@link DynamicSettlementReceipt.submissionId}: NOT the explorer hash. */
  submissionId: string;
  receipt: DynamicSettlementReceipt;
}

/**
 * Deploys the Passport C1 contract through Dynamic's embedded-wallet
 * settlement. The deployment transaction is built and (trivially) proved
 * locally — a deploy contains no circuit call, so the proof server is never
 * contacted — then balanced, fee-funded, MPC-signed, and submitted by the
 * wallet. The returned {@link DynamicC1DeploymentResult.submissionId} must be
 * confirmed via {@link confirmDynamicSubmission}.
 */
export async function deployPassportC1ViaDynamic(
  wallet: MidnightWallet,
  initialPrivateState: PassportC1PrivateState,
  maintenanceSigningKey: string,
  options?: { onPhase?: (phase: DynamicSettlementPhase) => void },
): Promise<DynamicC1DeploymentResult> {
  assertPreviewWallet(wallet);
  setNetworkId(PASSPORT_C1_NETWORK);
  const privateStateId = `passport-c1:${globalThis.crypto.randomUUID()}`;

  let receipt: DynamicSettlementReceipt | null = null;
  options?.onPhase?.('connecting-wallet-provider');
  const providers = await createDynamicPassportC1Providers(
    wallet,
    {
      contractAddress: '(assigned at deployment)',
      circuit: 'deploy passport_c1',
      summary: 'Deploy the Passport account-management contract',
      arguments: { privateStateId },
    },
    (value) => {
      receipt = value;
    },
  );

  options?.onPhase?.('proving-and-balancing');
  const deployed = await deployContract(providers as never, {
    compiledContract: compiledPassportC1Contract(),
    signingKey: maintenanceSigningKey,
    privateStateId,
    initialPrivateState,
    args: passportC1ConstructorArgs(initialPrivateState),
  } as never);

  const contractAddress = String((deployed as { deployTxData: { public: { contractAddress: unknown } } }).deployTxData.public.contractAddress);
  if (!receipt) {
    throw new Error('The deployment completed without producing a Dynamic settlement receipt.');
  }
  return { contractAddress, privateStateId, submissionId: (receipt as DynamicSettlementReceipt).submissionId, receipt };
}

export interface DynamicC1CallResult {
  /** See {@link DynamicSettlementReceipt.submissionId}: NOT the explorer hash. */
  submissionId: string;
  receipt: DynamicSettlementReceipt;
}

/**
 * Calls a passport_c1 circuit on a deployed contract through Dynamic's
 * embedded-wallet settlement. Unlike a deploy, a circuit call IS proved by
 * our proof provider (`VITE_MIDNIGHT_PROVING_URL`) before the wallet
 * balances and submits it.
 */
export async function callPassportC1ViaDynamic(
  wallet: MidnightWallet,
  options: {
    contractAddress: string;
    initialPrivateState: PassportC1PrivateState;
    circuitId: PassportC1CircuitId;
    args: readonly unknown[];
    summary: string;
    privateStateId?: string;
    onPhase?: (phase: DynamicSettlementPhase) => void;
  },
): Promise<DynamicC1CallResult> {
  assertPreviewWallet(wallet);
  setNetworkId(PASSPORT_C1_NETWORK);
  const privateStateId = options.privateStateId ?? `passport-c1:${options.contractAddress}`;

  let receipt: DynamicSettlementReceipt | null = null;
  options.onPhase?.('connecting-wallet-provider');
  const providers = await createDynamicPassportC1Providers(
    wallet,
    {
      contractAddress: options.contractAddress,
      circuit: options.circuitId,
      summary: options.summary,
      arguments: { privateStateId },
    },
    (value) => {
      receipt = value;
    },
  );

  const found = await findDeployedContract(providers as never, {
    contractAddress: options.contractAddress,
    compiledContract: compiledPassportC1Contract(),
    privateStateId,
    initialPrivateState: options.initialPrivateState,
  } as never);

  options.onPhase?.('proving-and-balancing');
  const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }).callTx;
  await callTx[options.circuitId](...options.args);
  if (!receipt) {
    throw new Error('The circuit call completed without producing a Dynamic settlement receipt.');
  }
  return { submissionId: (receipt as DynamicSettlementReceipt).submissionId, receipt };
}

/* -------------------------------------------------------------------------- */
/* Confirmation — submission identifier -> canonical hash                     */
/* -------------------------------------------------------------------------- */

export interface DynamicSubmissionConfirmation {
  /** The canonical transaction hash — THIS is what the explorer resolves. */
  txHash: string;
  blockHeight: number | null;
  /** Ledger apply result: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'. */
  applyStatus: string | null;
  /** Addresses from the transaction's contractActions (deploys and calls). */
  contractAddresses: string[];
  /** The first ContractDeploy address, when the transaction deployed one. */
  deployAddress: string | null;
}

export class DynamicSubmissionPendingError extends Error {
  constructor(readonly submissionId: string, timeoutMs: number) {
    super(
      `The indexer has not returned transaction data for submission identifier ${submissionId} ` +
        `after ${Math.round(timeoutMs / 1000)}s. An empty lookup is NOT proof of failure: the indexer answers ` +
        'an unknown (or wrong) identifier with an empty result rather than an error, so the transaction may ' +
        'still be indexing. Retry the confirmation before treating the submission as lost.',
    );
    this.name = 'DynamicSubmissionPendingError';
  }
}

const CONFIRM_QUERY = `query PassportDynamicSubmission($offset: TransactionOffset!) {
  transactions(offset: $offset) {
    hash
    block { height }
    contractActions { __typename address }
    ... on RegularTransaction { transactionResult { status } }
  }
}`;

interface WireConfirmationTransaction {
  hash: string;
  block?: { height: number } | null;
  contractActions?: { __typename: string; address: string }[] | null;
  transactionResult?: { status: string } | null;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Polls the indexer's `transactions(offset: { identifier })` point lookup
 * until the submission identifier returned by `submitTx` resolves to an
 * indexed transaction, and extracts the canonical hash and contract-action
 * addresses.
 *
 * The `identifier` argument is the SUBMISSION IDENTIFIER from
 * {@link DynamicSettlementReceipt.submissionId} — not a hash. An empty lookup
 * result is indistinguishable from a wrong identifier (the indexer returns
 * `[]`, not an error), so emptiness is treated as "not indexed yet" and only
 * the timeout ends the poll, with {@link DynamicSubmissionPendingError}.
 */
export async function confirmDynamicSubmission(
  identifier: string,
  options?: { indexerUrl?: string; timeoutMs?: number; pollIntervalMs?: number },
): Promise<DynamicSubmissionConfirmation> {
  const indexerUrl = options?.indexerUrl ?? MIDNIGHT_INDEXER_URL;
  const timeoutMs = options?.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await fetch(indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: CONFIRM_QUERY, variables: { offset: { identifier } } }),
    });
    if (!response.ok) {
      throw new Error(`The indexer replied with HTTP ${response.status} while confirming the submission.`);
    }
    const body = (await response.json()) as {
      data?: { transactions?: WireConfirmationTransaction[] | null } | null;
      errors?: { message?: string }[] | null;
    };
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors[0]?.message ?? 'The indexer returned a GraphQL error while confirming the submission.');
    }

    const transaction = body.data?.transactions?.[0];
    if (transaction) {
      const contractActions = transaction.contractActions ?? [];
      return {
        txHash: transaction.hash,
        blockHeight: transaction.block?.height ?? null,
        applyStatus: transaction.transactionResult?.status ?? null,
        contractAddresses: contractActions.map((action) => action.address),
        deployAddress: contractActions.find((action) => action.__typename === 'ContractDeploy')?.address ?? null,
      };
    }

    if (Date.now() + pollIntervalMs > deadline) {
      throw new DynamicSubmissionPendingError(identifier, timeoutMs);
    }
    await wait(pollIntervalMs);
  }
}
