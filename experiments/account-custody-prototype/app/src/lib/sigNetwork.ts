// Runtime configuration for the real Sig.Network ERC20 vault flow.
//
// The flow is Midnight -> MPC -> Sepolia -> Midnight shielded claim. The
// browser must never claim that route is live until all three values below are
// supplied by the deployed Sig environment.

export interface SigNetworkConfig {
  midnightVaultAddress: string;
  mpcWebSocketUrl: string;
  sepoliaRpcUrl: string;
}

export interface SigNetworkReadiness {
  configured: boolean;
  missing: string[];
  config: SigNetworkConfig;
}

function read(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function getSigNetworkReadiness(): SigNetworkReadiness {
  const config = {
    midnightVaultAddress: read(import.meta.env.VITE_SIG_MIDNIGHT_VAULT_ADDRESS),
    mpcWebSocketUrl: read(import.meta.env.VITE_SIG_MPC_WS_URL),
    sepoliaRpcUrl: read(import.meta.env.VITE_SIG_SEPOLIA_RPC_URL),
  };

  const missing = [
    !config.midnightVaultAddress && 'Midnight ERC20 vault address',
    !config.mpcWebSocketUrl && 'MPC WebSocket URL',
    !config.sepoliaRpcUrl && 'Sepolia RPC URL',
  ].filter(Boolean) as string[];

  return { configured: missing.length === 0, missing, config };
}
