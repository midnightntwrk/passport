// ---------------------------------------------------------------------------
// Shared types — local-tee-poc
// ---------------------------------------------------------------------------

export type Screen = 'dashboard' | 'setup' | 'register' | 'update' | 'keys' | 'network' | 'logs';

export type NetworkName = 'mainnet' | 'preprod' | 'preview' | 'undeployed';

export interface NetworkConfig {
  name:           NetworkName;
  nodeUrl:        string;
  indexerUrl:     string;
  proofServerUrl: string;
}

export const NETWORK_DEFAULTS: Record<NetworkName, Omit<NetworkConfig, 'name'>> = {
  mainnet:    {
    nodeUrl:        'https://rpc.mainnet.midnight.network',
    indexerUrl:     'https://indexer.mainnet.midnight.network/api/v4/graphql',
    proofServerUrl: 'http://localhost:6300',
  },
  preprod:    {
    nodeUrl:        'https://rpc.preprod.midnight.network',
    indexerUrl:     'https://indexer.preprod.midnight.network/api/v4/graphql',
    proofServerUrl: 'https://proof-server.preprod.midnight.network',
  },
  preview:    {
    nodeUrl:        'https://rpc.preview.midnight.network',
    indexerUrl:     'https://indexer.preview.midnight.network/api/v4/graphql',
    proofServerUrl: 'https://proof-server.preview.midnight.network',
  },
  undeployed: {
    nodeUrl:        'http://localhost:9944',
    indexerUrl:     'http://localhost:8088/api/v4/graphql',
    proofServerUrl: 'http://localhost:6300',
  },
};

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  name: 'undeployed',
  ...NETWORK_DEFAULTS['undeployed'],
};

// ── Transaction status ──────────────────────────────────────────────────────

export type TxStatus =
  | {stage: 'idle'}
  | {stage: 'building'}
  | {stage: 'proving'}
  | {stage: 'submitting'}
  | {stage: 'pending';   txHash: string}
  | {stage: 'confirmed'; txHash: string}
  | {stage: 'failed';    error:  string};

// ── Compliance state (mirrors on-chain public ledger) ───────────────────────

export type ComplianceTier = 0 | 1 | 2 | 3;

export const TIER_LABELS: Record<ComplianceTier, string> = {
  0: 'Unverified',
  1: 'Basic KYC',
  2: 'Enhanced KYC',
  3: 'Institutional',
};

export interface ComplianceState {
  /** On-chain public tier: 0–3. */
  tier:              ComplianceTier;
  deviceRegistered:  boolean;
  updateCount:       bigint;
  /** Whether the local stub TEE holds a key for this contract. */
  teeKeyLoaded:      boolean;
}
