export const DYNAMIC_MIDNIGHT_PROOF_PROTOCOL =
  'dynamic-midnight-compact-proof-v1' as const;
export const DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD =
  'getMidnightProofCapabilities' as const;
export const DYNAMIC_MIDNIGHT_PROOF_METHOD =
  'proveMidnightTransaction' as const;

export type DynamicMidnightProofOperation = 'balance-and-finalize';

export interface DynamicTransactionAuthorizer {
  readonly address: string;
  signMessage(message: string): Promise<string | undefined>;
}

export interface DynamicTransactionBroadcaster {
  submitTransaction(
    finalizedTransaction: string,
  ): Promise<void | { txHash: string; balanceAfter?: string }>;
  revertTransaction?(
    serializedTransaction: string,
  ): Promise<unknown>;
}

export interface DynamicMidnightProofProviderMetadata {
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface DynamicMidnightProofCapabilityAvailable
  extends DynamicMidnightProofProviderMetadata {
  readonly status: 'available';
  readonly protocol: typeof DYNAMIC_MIDNIGHT_PROOF_PROTOCOL;
  readonly operations: readonly DynamicMidnightProofOperation[];
  readonly inputTransaction: 'unbound';
  readonly outputTransaction: 'finalized';
  readonly callerBroadcasts: true;
}

export type DynamicMidnightProofBlockCode =
  | 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_UNAVAILABLE'
  | 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_INCOMPATIBLE'
  | 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_CAPABILITY_PROBE_FAILED';

export interface DynamicMidnightProofCapabilityBlocked
  extends DynamicMidnightProofProviderMetadata {
  readonly status: 'externally_blocked';
  readonly code: DynamicMidnightProofBlockCode;
  readonly missingMethods: readonly string[];
  readonly reason: string;
}

export type DynamicMidnightProofCapability =
  | DynamicMidnightProofCapabilityAvailable
  | DynamicMidnightProofCapabilityBlocked;

export interface DynamicMidnightProofRequest {
  readonly protocol: typeof DYNAMIC_MIDNIGHT_PROOF_PROTOCOL;
  readonly operation: DynamicMidnightProofOperation;
  readonly network: string;
  readonly walletAddress: string;
  readonly serializedTransaction: string;
  readonly inputTransactionDigest: string;
  readonly intent: DynamicTransactionIntent;
}

export interface DynamicMidnightProofResult {
  readonly protocol: typeof DYNAMIC_MIDNIGHT_PROOF_PROTOCOL;
  readonly operation: DynamicMidnightProofOperation;
  readonly inputTransactionDigest: string;
  readonly finalizedTransaction: string;
}

export interface DynamicMidnightProofProvider {
  probe(): Promise<DynamicMidnightProofCapability>;
  prove(request: DynamicMidnightProofRequest): Promise<DynamicMidnightProofResult>;
}

export interface DynamicMidnightProofApi {
  getMidnightProofCapabilities(): Promise<unknown>;
  proveMidnightTransaction(request: DynamicMidnightProofRequest): Promise<unknown>;
}

export interface DynamicTransactionIntent {
  readonly network: string;
  readonly contractAddress: string;
  readonly circuit: string;
  readonly summary: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface DynamicTransactionReceipt {
  readonly txHash: string;
  readonly unboundTransactionDigest: string;
  readonly finalizedTransactionDigest: string;
  readonly approvalMessage: string;
  readonly approvalSignature: string;
  readonly approvalSignatureFingerprint: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly proofProtocol: typeof DYNAMIC_MIDNIGHT_PROOF_PROTOCOL;
  readonly proofOperation: DynamicMidnightProofOperation;
}

export interface SubmitDynamicTransactionOptions {
  readonly authorizer: DynamicTransactionAuthorizer;
  readonly proofProvider: DynamicMidnightProofProvider;
  readonly broadcaster: DynamicTransactionBroadcaster;
  readonly serializedTransaction: string;
  readonly intent: DynamicTransactionIntent;
  readonly now?: Date;
  readonly nonce?: string;
  readonly approvalTtlMs?: number;
  readonly assertNetwork?: () => void | Promise<void>;
  readonly validateFinalizedTransaction?: (
    serializedTransaction: string,
  ) => void | Promise<void>;
  readonly currentTime?: () => Date;
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function functionAt(
  value: unknown,
  key: string,
): ((...args: any[]) => Promise<unknown>) | undefined {
  if (!isRecord(value) && typeof value !== 'function') return undefined;
  const member = (value as Record<string, unknown>)[key];
  return typeof member === 'function'
    ? (member as (...args: any[]) => Promise<unknown>).bind(value)
    : undefined;
}

function blockedCapability(
  metadata: DynamicMidnightProofProviderMetadata,
  code: DynamicMidnightProofBlockCode,
  missingMethods: readonly string[],
  reason: string,
): DynamicMidnightProofCapabilityBlocked {
  return {
    ...metadata,
    status: 'externally_blocked',
    code,
    missingMethods,
    reason,
  };
}

function parseAvailableCapability(
  value: unknown,
  metadata: DynamicMidnightProofProviderMetadata,
): DynamicMidnightProofCapabilityAvailable | null {
  if (!isRecord(value)) return null;
  const operations = Array.isArray(value.operations)
    ? value.operations.filter(
        (operation): operation is DynamicMidnightProofOperation =>
          operation === 'balance-and-finalize',
      )
    : [];
  if (
    value.protocol !== DYNAMIC_MIDNIGHT_PROOF_PROTOCOL ||
    !operations.includes('balance-and-finalize') ||
    value.inputTransaction !== 'unbound' ||
    value.outputTransaction !== 'finalized' ||
    value.callerBroadcasts !== true
  ) {
    return null;
  }
  return {
    ...metadata,
    status: 'available',
    protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
    operations,
    inputTransaction: 'unbound',
    outputTransaction: 'finalized',
    callerBroadcasts: true,
  };
}

export class DynamicMidnightProofCapabilityError extends Error {
  constructor(readonly result: DynamicMidnightProofCapabilityBlocked) {
    super(
      `Dynamic Compact proof generation is externally blocked (${result.code}). ${result.reason}`,
    );
    this.name = 'DynamicMidnightProofCapabilityError';
  }
}

/**
 * Adapts the versioned Compact proof contract expected from Dynamic.
 *
 * The existing transfer-only signTransaction method is deliberately not used
 * as a fallback. Dynamic 4.93.1 documents that method for an UnprovenTransaction
 * produced by createTransferTransaction, while Midnight.js hands a C1 wallet
 * provider an already call-proved UnboundTransaction.
 */
export function createDynamicMidnightProofProvider(
  candidate: unknown,
  metadata: DynamicMidnightProofProviderMetadata,
): DynamicMidnightProofProvider {
  const getCapabilities = functionAt(
    candidate,
    DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD,
  );
  const proveMidnightTransaction = functionAt(
    candidate,
    DYNAMIC_MIDNIGHT_PROOF_METHOD,
  );
  let capabilityPromise: Promise<DynamicMidnightProofCapability> | null = null;

  const probe = async (): Promise<DynamicMidnightProofCapability> => {
    if (capabilityPromise) return capabilityPromise;
    capabilityPromise = (async () => {
      const missingMethods = [
        !getCapabilities ? DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD : null,
        !proveMidnightTransaction ? DYNAMIC_MIDNIGHT_PROOF_METHOD : null,
      ].filter(
        (
          method,
        ): method is
          | typeof DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD
          | typeof DYNAMIC_MIDNIGHT_PROOF_METHOD => method !== null,
      );
      if (missingMethods.length > 0) {
        return blockedCapability(
          metadata,
          'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_UNAVAILABLE',
          missingMethods,
          `${metadata.packageName}@${metadata.packageVersion} exposes the transfer builder flow, but not the required UnboundTransaction balance-proof contract.`,
        );
      }

      try {
        const advertised = await getCapabilities!();
        const available = parseAvailableCapability(advertised, metadata);
        return (
          available ??
          blockedCapability(
            metadata,
            'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_INCOMPATIBLE',
            [],
            `The advertised API does not support ${DYNAMIC_MIDNIGHT_PROOF_PROTOCOL} balance-and-finalize from an UnboundTransaction to a caller-broadcast FinalizedTransaction.`,
          )
        );
      } catch (error) {
        return blockedCapability(
          metadata,
          'DYNAMIC_MIDNIGHT_COMPACT_PROOF_CAPABILITY_PROBE_FAILED',
          [],
          `The Dynamic capability probe failed: ${String(
            (error as Error)?.message ?? error,
          )}`,
        );
      }
    })();
    return capabilityPromise;
  };

  return {
    probe,
    async prove(request) {
      const capability = await probe();
      if (capability.status !== 'available') {
        throw new DynamicMidnightProofCapabilityError(capability);
      }

      const response = await proveMidnightTransaction!(request);
      if (
        !isRecord(response) ||
        response.protocol !== DYNAMIC_MIDNIGHT_PROOF_PROTOCOL ||
        response.operation !== request.operation ||
        response.inputTransactionDigest !== request.inputTransactionDigest ||
        typeof response.finalizedTransaction !== 'string' ||
        response.finalizedTransaction.length === 0
      ) {
        throw new Error(
          'Dynamic returned an invalid Compact proof response; refusing to approve or broadcast it.',
        );
      }

      return {
        protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
        operation: request.operation,
        inputTransactionDigest: request.inputTransactionDigest,
        finalizedTransaction: response.finalizedTransaction,
      };
    },
  };
}

export async function requireDynamicMidnightProofCapability(
  provider: DynamicMidnightProofProvider,
): Promise<DynamicMidnightProofCapabilityAvailable> {
  const capability = await provider.probe();
  if (capability.status !== 'available') {
    throw new DynamicMidnightProofCapabilityError(capability);
  }
  return capability;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  const binary = globalThis.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function fingerprintDynamicSignature(signature: string): Promise<string> {
  if (!signature) throw new Error('Dynamic signature is empty.');
  return sha256Hex(signature);
}

function randomNonce(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildDynamicApprovalMessage(
  intent: DynamicTransactionIntent,
  walletAddress: string,
  proofProtocol: typeof DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
  proofOperation: DynamicMidnightProofOperation,
  unboundTransactionDigest: string,
  finalizedTransactionDigest: string,
  approvedAt: string,
  expiresAt: string,
  nonce: string,
): string {
  const argumentLines = Object.entries(intent.arguments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`);

  return [
    'MN Passport C1 transaction approval',
    'Version: 1',
    `Network: ${intent.network}`,
    `Wallet: ${walletAddress}`,
    `Contract: ${intent.contractAddress}`,
    `Circuit: ${intent.circuit}`,
    `Summary: ${intent.summary}`,
    ...argumentLines,
    `Proof protocol: ${proofProtocol}`,
    `Proof operation: ${proofOperation}`,
    `Unbound transaction SHA-256: ${unboundTransactionDigest}`,
    `Finalized transaction SHA-256: ${finalizedTransactionDigest}`,
    `Approved at: ${approvedAt}`,
    `Expires at: ${expiresAt}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Runs the complete Dynamic transaction boundary.
 *
 * The versioned proof provider balances and finalizes the already call-proved
 * C1 transaction without returning wallet secrets. signMessage then creates a
 * human-readable approval receipt bound to both the original C1 transaction
 * and those exact finalized bytes. The broadcaster receives exactly those
 * approved bytes, and cannot run unless approval succeeds.
 */
export async function submitDynamicTransaction(
  options: SubmitDynamicTransactionOptions,
): Promise<DynamicTransactionReceipt> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS));
  const unboundTransactionDigest = await sha256Hex(
    base64ToBytes(options.serializedTransaction),
  );

  await options.assertNetwork?.();
  await requireDynamicMidnightProofCapability(options.proofProvider);
  const proofResult = await options.proofProvider.prove({
    protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
    operation: 'balance-and-finalize',
    network: options.intent.network,
    walletAddress: options.authorizer.address,
    serializedTransaction: options.serializedTransaction,
    inputTransactionDigest: unboundTransactionDigest,
    intent: options.intent,
  });
  const finalizedTransaction = proofResult.finalizedTransaction;
  if (!finalizedTransaction) {
    throw new Error('Dynamic did not return a finalized Compact transaction.');
  }

  const abandonFinalizedTransaction = async () => {
    try {
      await options.broadcaster.revertTransaction?.(finalizedTransaction);
    } catch {
      // Preserve the original pre-submission error.
    }
  };

  let finalizedTransactionDigest: string;
  try {
    await options.validateFinalizedTransaction?.(finalizedTransaction);
    finalizedTransactionDigest = await sha256Hex(
      base64ToBytes(finalizedTransaction),
    );
  } catch (error) {
    await abandonFinalizedTransaction();
    throw error;
  }

  let approvalMessage: string;
  let approvalSignature: string;
  let approvalSignatureFingerprint: string;
  let approvedAt: string;
  try {
    const approvalTime = options.currentTime?.() ?? new Date();
    if (approvalTime.getTime() > expiresAt.getTime()) {
      throw new Error('The Dynamic C1 approval window expired before review.');
    }
    await options.assertNetwork?.();
    approvedAt = approvalTime.toISOString();

    approvalMessage = buildDynamicApprovalMessage(
      options.intent,
      options.authorizer.address,
      proofResult.protocol,
      proofResult.operation,
      unboundTransactionDigest,
      finalizedTransactionDigest,
      approvedAt,
      expiresAt.toISOString(),
      options.nonce ?? randomNonce(),
    );
    approvalSignature =
      (await options.authorizer.signMessage(approvalMessage)) ?? '';
    if (!approvalSignature) {
      throw new Error('Dynamic did not return the C1 approval signature.');
    }
    approvalSignatureFingerprint =
      await fingerprintDynamicSignature(approvalSignature);

    if ((options.currentTime?.() ?? new Date()).getTime() > expiresAt.getTime()) {
      throw new Error('The Dynamic C1 approval expired before transaction submission.');
    }
    await options.assertNetwork?.();
  } catch (error) {
    await abandonFinalizedTransaction();
    throw error;
  }

  // A submission exception is intentionally not followed by revertTransaction.
  // A timeout can happen after broadcast; releasing the reservation before
  // reconciling the tx hash can desynchronize the wallet from the chain.
  const submitted =
    await options.broadcaster.submitTransaction(finalizedTransaction);
  if (!submitted || !submitted.txHash) {
    throw new Error('Dynamic submitted the transaction without returning a transaction hash.');
  }

  return {
    txHash: submitted.txHash,
    unboundTransactionDigest,
    finalizedTransactionDigest,
    approvalMessage,
    approvalSignature,
    approvalSignatureFingerprint,
    approvedAt,
    expiresAt: expiresAt.toISOString(),
    proofProtocol: proofResult.protocol,
    proofOperation: proofResult.operation,
  };
}
