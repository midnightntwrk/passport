// Dynamic wallet approvals — the platform-neutral half.
//
// `signMessage` is an off-chain authorisation primitive: it proves the
// embedded wallet approved an exact intent. It moves nothing on chain, so a
// signature is only worth requesting if it is bound to something specific,
// checked, and kept. Awaiting one and dropping the result authorises nothing.
//
// The message built here names the contract, the circuit, every argument, and
// an expiry, so the signature commits to one transaction and nothing else.
// The browser-side glue (app/src/lib/dynamicTransactions.ts) supplies the
// wallet; this module stays free of Dynamic and DOM types so the node tests
// can exercise it directly.

export const DYNAMIC_APPROVAL_VERSION = '1' as const;
export const DYNAMIC_APPROVAL_TTL_MS = 5 * 60 * 1_000;

export interface DynamicApprovalIntent {
  /** Midnight network the approving wallet is on (`preview`, `undeployed`, …). */
  readonly network: string;
  readonly walletAddress: string;
  readonly contractAddress: string;
  readonly circuit: string;
  readonly summary: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface DynamicApproval {
  readonly message: string;
  readonly signature: string;
  /** SHA-256 of the signature — safe to log, display, and persist. */
  readonly fingerprint: string;
  readonly walletAddress: string;
  readonly network: string;
  readonly circuit: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface CreateDynamicApprovalOptions {
  readonly intent: DynamicApprovalIntent;
  readonly signMessage: (message: string) => Promise<string | undefined>;
  readonly now?: Date;
  readonly nonce?: string;
  readonly ttlMs?: number;
}

export function buildDynamicApprovalMessage(
  intent: DynamicApprovalIntent,
  stamps: { approvedAt: string; expiresAt: string; nonce: string },
): string {
  const argumentLines = Object.entries(intent.arguments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`);

  return [
    'MN Passport transaction approval',
    `Version: ${DYNAMIC_APPROVAL_VERSION}`,
    `Network: ${intent.network}`,
    `Wallet: ${intent.walletAddress}`,
    `Contract: ${intent.contractAddress}`,
    `Circuit: ${intent.circuit}`,
    `Summary: ${intent.summary}`,
    ...argumentLines,
    `Approved at: ${stamps.approvedAt}`,
    `Expires at: ${stamps.expiresAt}`,
    `Nonce: ${stamps.nonce}`,
  ].join('\n');
}

export async function fingerprintDynamicSignature(signature: string): Promise<string> {
  if (!signature) throw new Error('Cannot fingerprint an empty Dynamic signature.');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(signature),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function randomApprovalNonce(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isDynamicApprovalLive(
  approval: Pick<DynamicApproval, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return now.getTime() <= Date.parse(approval.expiresAt);
}

/**
 * Requests one approval signature over one intent and refuses to return
 * without it. The caller keeps the receipt: a broadcast that cannot show a
 * live approval must not happen.
 */
export async function createDynamicApproval(
  options: CreateDynamicApprovalOptions,
): Promise<DynamicApproval> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DYNAMIC_APPROVAL_TTL_MS));
  const message = buildDynamicApprovalMessage(options.intent, {
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: options.nonce ?? randomApprovalNonce(),
  });

  const signature = (await options.signMessage(message)) ?? '';
  if (!signature) {
    throw new Error(
      'Dynamic returned no signature for the approval message, so nothing authorised this transaction.',
    );
  }

  return {
    message,
    signature,
    fingerprint: await fingerprintDynamicSignature(signature),
    walletAddress: options.intent.walletAddress,
    network: options.intent.network,
    circuit: options.intent.circuit,
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
