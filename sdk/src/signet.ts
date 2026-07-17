/**
 * Capability boundary for Sig.Network settlement.
 *
 * Passport does not own the vault, MPC, DA transport, or Sepolia provider.
 * Keeping those dependencies behind this interface prevents a demo adapter
 * from being mistaken for a completed production integration.
 */
export type SigNetworkReadiness = 'ready' | 'blocked';

export interface SigNetworkRequirements {
  vaultAddress: string | null;
  mpcEndpoint: string | null;
  sepoliaRpcUrl: string | null;
  integrationContractVersion: string | null;
}

export interface SigNetworkSettlementIntent {
  sourceChain: 'sepolia';
  tokenAddress: string;
  amount: bigint;
  recipient: string;
}

export interface SigNetworkSettlementResult {
  status: 'submitted' | 'confirmed';
  externalTransactionHash: string;
  midnightTransactionHash?: string;
}

export interface SigNetworkAdapter {
  readiness: SigNetworkReadiness;
  requirements: SigNetworkRequirements;
  explainBlocker(): string | null;
  settle(intent: SigNetworkSettlementIntent): Promise<SigNetworkSettlementResult>;
}

export class BlockedSigNetworkAdapter implements SigNetworkAdapter {
  readonly readiness = 'blocked' as const;

  constructor(
    readonly requirements: SigNetworkRequirements = {
      vaultAddress: null,
      mpcEndpoint: null,
      sepoliaRpcUrl: null,
      integrationContractVersion: null,
    },
  ) {}

  explainBlocker(): string {
    return 'Sig.Network is not configured: provide the deployed Midnight vault, MPC endpoint, Sepolia RPC, and a compatible Passport handoff contract before enabling settlement.';
  }

  async settle(_intent: SigNetworkSettlementIntent): Promise<SigNetworkSettlementResult> {
    throw new Error(this.explainBlocker());
  }
}
