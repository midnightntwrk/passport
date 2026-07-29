/**
 * Sig.Network's Midnight release currently targets the ledger-9,
 * Midnight.js-5 beta stack. Passport keeps the protocol orchestration here
 * while the concrete vault/client implementation is injected by the host.
 * This avoids bundling two incompatible Midnight runtimes or simulating a
 * successful foreign-chain settlement.
 */
export type SigNetworkReadiness = 'ready' | 'blocked';

export type SigNetworkStage =
  | 'request'
  | 'signature'
  | 'broadcast'
  | 'attestation'
  | 'claim';

export interface SigNetworkRequirements {
  vaultAddress: string | null;
  signetContractAddress: string | null;
  mpcRootPublicKey: string | null;
  midnightIndexerUrl: string | null;
  evmRpcUrl: string | null;
  erc20Address: string | null;
  integrationVersion: string;
  runtime: 'ledger-9';
}

export interface SigNetworkSettlementIntent {
  sourceChain: 'sepolia' | 'anvil';
  tokenAddress: string;
  amount: bigint;
  recipient: string;
}

export interface SigNetworkStageEvidence {
  stage: SigNetworkStage;
  completedAt: string;
  midnightTransactionHash?: string;
  externalTransactionHash?: string;
}

export interface SigNetworkSettlementResult {
  status: 'submitted' | 'confirmed';
  requestId: string;
  externalTransactionHash: string;
  midnightTransactionHash: string;
  evidence: SigNetworkStageEvidence[];
}

export interface SigNetworkDepositRequest {
  requestId: string;
  midnightTransactionHash: string;
}

export interface SigNetworkSignedTransaction {
  serialized: string;
}

export interface SigNetworkBroadcastResult {
  externalTransactionHash: string;
}

export interface SigNetworkClaimResult {
  midnightTransactionHash: string;
}

/**
 * Concrete hosts implement these methods with the official
 * `@sig-net/midnight` reader and their deployed ERC20 vault binding.
 */
export interface SigNetworkDepositDriver<Attestation = unknown> {
  requestDeposit(intent: SigNetworkSettlementIntent): Promise<SigNetworkDepositRequest>;
  waitForVerifiedSignature(requestId: string): Promise<SigNetworkSignedTransaction>;
  broadcastForeignTransaction(
    transaction: SigNetworkSignedTransaction,
  ): Promise<SigNetworkBroadcastResult>;
  waitForExecutionAttestation(requestId: string): Promise<Attestation>;
  claimShieldedAsset(
    requestId: string,
    attestation: Attestation,
    recipient: string,
  ): Promise<SigNetworkClaimResult>;
}

export interface SigNetworkAdapter {
  readonly readiness: SigNetworkReadiness;
  readonly requirements: SigNetworkRequirements;
  explainBlocker(): string | null;
  settle(intent: SigNetworkSettlementIntent): Promise<SigNetworkSettlementResult>;
}

const DEFAULT_REQUIREMENTS: SigNetworkRequirements = {
  vaultAddress: null,
  signetContractAddress: null,
  mpcRootPublicKey: null,
  midnightIndexerUrl: null,
  evmRpcUrl: null,
  erc20Address: null,
  integrationVersion: '@sig-net/midnight@0.10.0',
  runtime: 'ledger-9',
};

function now(): string {
  return new Date().toISOString();
}

function assertIntent(intent: SigNetworkSettlementIntent): void {
  if (intent.amount <= 0n) throw new Error('Sig.Network deposit amount must be positive.');
  if (!/^0x[0-9a-f]{40}$/i.test(intent.tokenAddress)) {
    throw new Error('Sig.Network requires a valid ERC20 contract address.');
  }
  if (!intent.recipient) throw new Error('Sig.Network requires a shielded Midnight recipient.');
}

export class SigNetworkProtocolAdapter<Attestation = unknown>
  implements SigNetworkAdapter
{
  readonly readiness = 'ready' as const;

  constructor(
    readonly requirements: SigNetworkRequirements,
    private readonly driver: SigNetworkDepositDriver<Attestation>,
  ) {}

  explainBlocker(): null {
    return null;
  }

  async settle(intent: SigNetworkSettlementIntent): Promise<SigNetworkSettlementResult> {
    assertIntent(intent);
    const evidence: SigNetworkStageEvidence[] = [];

    const request = await this.driver.requestDeposit(intent);
    if (!request.requestId || !request.midnightTransactionHash) {
      throw new Error('Sig.Network deposit did not return a request id and Midnight transaction.');
    }
    evidence.push({
      stage: 'request',
      completedAt: now(),
      midnightTransactionHash: request.midnightTransactionHash,
    });

    const signedTransaction = await this.driver.waitForVerifiedSignature(request.requestId);
    if (!signedTransaction.serialized) {
      throw new Error('Sig.Network returned an empty foreign-chain transaction.');
    }
    evidence.push({ stage: 'signature', completedAt: now() });

    const broadcast = await this.driver.broadcastForeignTransaction(signedTransaction);
    if (!broadcast.externalTransactionHash) {
      throw new Error('Foreign-chain broadcast did not return a transaction hash.');
    }
    evidence.push({
      stage: 'broadcast',
      completedAt: now(),
      externalTransactionHash: broadcast.externalTransactionHash,
    });

    const attestation = await this.driver.waitForExecutionAttestation(request.requestId);
    evidence.push({ stage: 'attestation', completedAt: now() });

    const claim = await this.driver.claimShieldedAsset(
      request.requestId,
      attestation,
      intent.recipient,
    );
    if (!claim.midnightTransactionHash) {
      throw new Error('Sig.Network claim did not return a Midnight transaction hash.');
    }
    evidence.push({
      stage: 'claim',
      completedAt: now(),
      midnightTransactionHash: claim.midnightTransactionHash,
    });

    return {
      status: 'confirmed',
      requestId: request.requestId,
      externalTransactionHash: broadcast.externalTransactionHash,
      midnightTransactionHash: claim.midnightTransactionHash,
      evidence,
    };
  }
}

export class BlockedSigNetworkAdapter implements SigNetworkAdapter {
  readonly readiness = 'blocked' as const;

  constructor(
    readonly requirements: SigNetworkRequirements = DEFAULT_REQUIREMENTS,
    private readonly reason =
      'Sig.Network is not configured: start the ledger-9 ERC20 vault stack and provide the deployed vault, Signet singleton, MPC root public key, Midnight indexer, EVM RPC, and ERC20 address.',
  ) {}

  explainBlocker(): string {
    return this.reason;
  }

  async settle(_intent: SigNetworkSettlementIntent): Promise<SigNetworkSettlementResult> {
    throw new Error(this.explainBlocker());
  }
}
