// The Dynamic Midnight transaction boundary for the demo app.
//
// Three Dynamic APIs matter here and they are not interchangeable:
//
//   signMessage(message)
//     Off-chain authorisation. Proves the embedded wallet approved an exact
//     intent; broadcasts nothing. Its result is the receipt — see
//     src/wallet/dynamic-approval.ts.
//
//   createTransferTransaction -> signTransaction -> submitTransaction
//     The real value-transfer path. Step 2 is MPC signing plus Midnight proof
//     generation inside Dynamic; step 3 broadcasts and returns a chain hash.
//     `wallet.sendBalance` collapses the three into one call when the
//     intermediate bytes are not needed.
//
//   (missing) balance-and-prove for an arbitrary Compact call
//     Executing a Compact circuit is neither of the above: the call-proved
//     transaction still has to be balanced and finalised against DUST before
//     it can be broadcast. Dynamic exposes no endpoint for that yet, so
//     `probeDynamicCompactSupport` reports the gap rather than dressing a
//     transfer API up as one.

import type { MidnightWallet, MidnightWalletConnector } from '@dynamic-labs/midnight';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  createDynamicApproval,
  type DynamicApproval,
  type DynamicApprovalIntent,
} from '../../../src/wallet/dynamic-approval.js';

export type { DynamicApproval } from '../../../src/wallet/dynamic-approval.js';
export {
  isDynamicApprovalLive,
  DYNAMIC_APPROVAL_TTL_MS,
} from '../../../src/wallet/dynamic-approval.js';

const APPROVAL_TIMEOUT_MS = 180_000;
const SIGN_TIMEOUT_MS = 180_000;
const SUBMIT_TIMEOUT_MS = 90_000;

/** The methods a Dynamic release would have to expose to balance and finalise
    a call-proved Compact transaction (the BCW integration). */
export const COMPACT_PROOF_METHODS = [
  'getMidnightProofCapabilities',
  'proveMidnightTransaction',
] as const;

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
    operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Midnight network the embedded wallet is actually on, read from its own
    address rather than from app configuration. */
export function dynamicNetwork(wallet: MidnightWallet): string {
  try {
    return String(MidnightBech32m.parse(wallet.address).network);
  } catch {
    return 'unknown';
  }
}

export function isDynamicEmbeddedWallet(wallet: MidnightWallet): boolean {
  return (wallet.connector as MidnightWalletConnector).overrideKey === 'dynamicwaas';
}

export interface DynamicCompactSupport {
  readonly available: boolean;
  readonly missingMethods: readonly string[];
  readonly reason: string;
}

/**
 * Reports whether this Dynamic build can balance and finalise an arbitrary
 * call-proved Compact transaction. The transfer-only `signTransaction` is
 * deliberately not treated as a fallback: it takes the draft produced by
 * `createTransferTransaction`, not a contract call.
 */
export function probeDynamicCompactSupport(wallet: MidnightWallet): DynamicCompactSupport {
  const connector = wallet.connector as unknown as Record<string, unknown>;
  const missingMethods = COMPACT_PROOF_METHODS.filter(
    (method) => typeof connector[method] !== 'function',
  );
  if (missingMethods.length === 0) {
    return {
      available: true,
      missingMethods,
      reason:
        'Dynamic advertises Compact balance-and-prove; route the custody call through it before relying on this path.',
    };
  }
  return {
    available: false,
    missingMethods,
    reason: `Dynamic exposes the transfer builder flow but not ${missingMethods.join(
      ' or ',
    )}, so it cannot balance or finalise a Compact contract call yet.`,
  };
}

/** Signs one intent with the embedded wallet and returns the receipt. Throws
    if Dynamic hands back nothing — an unsigned intent authorises nothing. */
export async function approveWithDynamicWallet(
  wallet: MidnightWallet,
  intent: Omit<DynamicApprovalIntent, 'network' | 'walletAddress'>,
): Promise<DynamicApproval> {
  return createDynamicApproval({
    intent: {
      ...intent,
      network: dynamicNetwork(wallet),
      walletAddress: wallet.address,
    },
    signMessage: (message) =>
      withTimeout(wallet.signMessage(message), 'Dynamic wallet approval', APPROVAL_TIMEOUT_MS),
  });
}

export interface DynamicTransfer {
  readonly type: 'unshielded' | 'shielded';
  readonly recipientAddress: string;
  /** Atomic units, as a decimal string. */
  readonly amount: string;
  readonly tokenType?: string;
}

export interface DynamicTransferReceipt {
  readonly txHash: string;
  readonly balanceAfter?: string;
  readonly serializedTransaction: string;
  readonly finalizedTransaction: string;
}

/**
 * Runs Dynamic's supported three-step value transfer and requires a chain
 * hash back. A failure before broadcast releases the UTXOs the draft
 * reserved; a failure during broadcast deliberately does not, because a
 * timeout can land after the transaction is already on chain and releasing
 * the reservation would desynchronise the wallet.
 */
export async function transferWithDynamicWallet(
  wallet: MidnightWallet,
  transfers: readonly DynamicTransfer[],
  options: { ttlMinutes?: number } = {},
): Promise<DynamicTransferReceipt> {
  if (!isDynamicEmbeddedWallet(wallet)) {
    throw new Error('A Dynamic embedded Midnight wallet is required for MPC signing.');
  }
  if (transfers.length === 0) throw new Error('A Dynamic transfer needs at least one recipient.');

  const { serializedTransaction } = await wallet.createTransferTransaction({
    transfers: transfers.map((transfer) => ({ ...transfer })),
    ttlMinutes: options.ttlMinutes,
  });

  let finalizedTransaction: string;
  try {
    finalizedTransaction = await withTimeout(
      wallet.signTransaction(serializedTransaction),
      'Dynamic MPC signing and Midnight proof generation',
      SIGN_TIMEOUT_MS,
    );
  } catch (error) {
    await wallet.revertTransaction(serializedTransaction).catch(() => undefined);
    throw error;
  }

  // The connector types the broadcast result as `void | { txHash }`; an
  // injected wallet can return nothing at all, which is not a submission.
  const broadcast = await withTimeout(
    wallet.submitTransaction(finalizedTransaction),
    'Dynamic Midnight broadcast',
    SUBMIT_TIMEOUT_MS,
  );
  const submitted = broadcast as unknown as
    | { txHash?: string; balanceAfter?: string }
    | undefined;
  if (!submitted?.txHash) {
    throw new Error(
      'Dynamic completed the broadcast call without returning a Midnight transaction hash.',
    );
  }

  return {
    txHash: submitted.txHash,
    balanceAfter: submitted.balanceAfter,
    serializedTransaction,
    finalizedTransaction,
  };
}
