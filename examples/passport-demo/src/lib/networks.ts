/**
 * Per-network public endpoints, and the one network THIS BUILD's wallet runs
 * on.
 *
 * Before 2026/08/06 the demo was pinned to Preview in a dozen places: a
 * hard-coded faucet URL, a hard-coded explorer origin, and `=== 'preview'`
 * gates in the claim path. Pointing the deployment at Pre-production meant the
 * wallet moved but the UI kept saying "preview only" and linking at the
 * Preview faucet — which would have been a lie in exactly the places this demo
 * is meant to be honest.
 *
 * So there is now one module that answers three questions:
 *
 *   1. Which network did this build's `VITE_MIDNIGHT_NETWORK_ID` select?
 *      That is where the wallet signs, and therefore the only network a name
 *      can be registered on from here.
 *   2. Does a given network have a public faucet, and at what URL?
 *   3. Does it have a public explorer, and what does a transaction link look
 *      like there?
 *
 * Nothing here invents an endpoint. A network with no entry gets `null`, and
 * every caller renders that as "no link" rather than a link that goes nowhere.
 *
 * This module imports nothing from the app, so anything may import it.
 */

/** The three public Midnight networks Passport knows about. */
export type PassportNetworkId = 'preview' | 'preprod' | 'mainnet';

const KNOWN_NETWORKS: readonly PassportNetworkId[] = ['preview', 'preprod', 'mainnet'];

/**
 * The network this build's local wallet is configured for. Mirrors the default
 * in `localWalletNetworkConfig()` — keep the two in step.
 */
export const DEFAULT_NETWORK_ID = 'preview';

/** Safe outside Vite, where there is no `import.meta.env`. See `localWallet.ts`. */
function environment(): Record<string, string | undefined> {
  return (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  );
}

/**
 * The raw configured network id, which may be something with no public
 * endpoints at all (`undeployed` for a local devnet).
 */
export function configuredNetworkId(
  env: Record<string, string | undefined> = environment(),
): string {
  return env.VITE_MIDNIGHT_NETWORK_ID?.trim() || DEFAULT_NETWORK_ID;
}

/** Narrows an arbitrary network id to one of the three public networks. */
export function asPassportNetwork(networkId: string | null | undefined): PassportNetworkId | null {
  return KNOWN_NETWORKS.includes(networkId as PassportNetworkId)
    ? (networkId as PassportNetworkId)
    : null;
}

/**
 * The public network this build's wallet signs on, or `null` when it is
 * pointed at a devnet. Everything that used to be gated on `'preview'` is
 * gated on this.
 */
export function walletNetwork(): PassportNetworkId | null {
  const network = asPassportNetwork(configuredNetworkId());
  if (network) return network;
  /* DEMO MASQUERADE, env-gated: a devnet build that also carries a local
     Midnames TLD override presents itself as Preview so the identity card
     and claim path light up. The wallet still signs on its real configured
     network; the chain, the transactions, and the registry are the local
     ones. Public builds never set VITE_MIDNAMES_TLD_ADDRESS, so this branch
     is dead there and behaviour is byte-identical. */
  if (environment().VITE_MIDNAMES_TLD_ADDRESS?.trim()) return 'preview';
  return null;
}

/**
 * The public network the UI opens on. A devnet build still has to show
 * *something* in the switcher, so it falls back to the documented default.
 */
export function defaultSelectedNetwork(): PassportNetworkId {
  return walletNetwork() ?? 'preview';
}

/**
 * The networks Passport will genuinely REGISTER a `.night` name on — that is,
 * the ones where its wallet signs, submits, and can be held to the result.
 *
 * Mainnet is deliberately absent even though the Midnames TLD exists there: a
 * registration is a paid transaction, and a demo wallet whose seed comes from
 * a browser passkey has no business spending real NIGHT. A name chosen for
 * mainnet is queued, with that reason shown.
 *
 * This lives here rather than in `identity/midnames.ts` so the UI can ask the
 * question without pulling the whole Midnight ledger runtime into the initial
 * bundle.
 */
export const CLAIMABLE_NETWORKS: readonly PassportNetworkId[] = ['preview', 'preprod'];

/** Whether a real `.night` registration is possible on `network` at all. */
export function aliasRegistrationSupported(network: string | null | undefined): boolean {
  return CLAIMABLE_NETWORKS.includes(network as PassportNetworkId);
}

/**
 * Public faucets, by network. Probed live 2026/08/06: both answer
 * `/api/health` with `{"status":"SERVING"}`. Mainnet has no faucet and never
 * will — its absence here is the point.
 *
 * NOTE — deliberately no automated drip anywhere. `POST /drips` requires an
 * `X-Captcha-Token` from a Cloudflare Turnstile challenge, so no in-app code
 * can honestly obtain one. The only truthful funding flow is: copy the
 * address, open the faucet, complete the captcha there, and let the wallet's
 * own sync report the arrival.
 */
export const FAUCET_URLS: Partial<Record<PassportNetworkId, string>> = {
  preview: 'https://faucet.preview.midnight.network',
  preprod: 'https://faucet.preprod.midnight.network',
};

/**
 * Public block explorers, by network. Only `/transactions/{hash}` resolves
 * (`/tx/{hash}` 404s). Mainnet is omitted rather than guessed.
 */
export const EXPLORER_URLS: Partial<Record<PassportNetworkId, string>> = {
  preview: 'https://explorer.preview.midnight.network',
  preprod: 'https://explorer.preprod.midnight.network',
};

/** The faucet for a network, or `null` where there is none. */
export function faucetUrlFor(networkId: string | null | undefined): string | null {
  const network = asPassportNetwork(networkId);
  return (network && FAUCET_URLS[network]) || null;
}

/** Whether a public faucet exists for this network. */
export function faucetAvailable(networkId: string | null | undefined): boolean {
  return faucetUrlFor(networkId) !== null;
}

/** The explorer origin for a network, or `null` where there is none. */
export function explorerUrlFor(networkId: string | null | undefined): string | null {
  const network = asPassportNetwork(networkId);
  return (network && EXPLORER_URLS[network]) || null;
}

/**
 * A link to one transaction on a network's explorer, or `null` when either the
 * hash or the explorer is missing. Never a link that resolves to nothing.
 */
export function explorerTxUrl(
  networkId: string | null | undefined,
  txHash: string | null | undefined,
): string | null {
  const origin = explorerUrlFor(networkId);
  if (!origin || !txHash) return null;
  return `${origin}/transactions/${encodeURIComponent(txHash)}`;
}
