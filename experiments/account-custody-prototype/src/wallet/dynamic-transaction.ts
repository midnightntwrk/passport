export interface DynamicTransactionSigner {
  readonly address: string;
  signMessage(message: string): Promise<string | undefined>;
  signTransaction(serializedTransaction: string): Promise<string>;
  submitTransaction(
    finalizedTransaction: string,
  ): Promise<void | { txHash: string; balanceAfter?: string }>;
  revertTransaction?(
    serializedTransaction: string,
  ): Promise<unknown>;
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
}

export interface SubmitDynamicTransactionOptions {
  readonly wallet: DynamicTransactionSigner;
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
 * signTransaction performs the Midnight wallet finalization. signMessage then
 * creates a human-readable approval receipt bound to both the original C1
 * transaction and those exact finalized bytes. Broadcast cannot happen unless
 * that approval succeeds.
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
  const finalizedTransaction = await options.wallet.signTransaction(
    options.serializedTransaction,
  );
  if (!finalizedTransaction) {
    throw new Error('Dynamic did not return a finalized Midnight transaction.');
  }

  const abandonFinalizedTransaction = async () => {
    try {
      await options.wallet.revertTransaction?.(finalizedTransaction);
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
      options.wallet.address,
      unboundTransactionDigest,
      finalizedTransactionDigest,
      approvedAt,
      expiresAt.toISOString(),
      options.nonce ?? randomNonce(),
    );
    approvalSignature = (await options.wallet.signMessage(approvalMessage)) ?? '';
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
  const submitted = await options.wallet.submitTransaction(finalizedTransaction);
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
  };
}
