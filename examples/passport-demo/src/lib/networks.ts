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
 * WHAT THE LEDGER-9 MOVE DID TO THIS TABLE (2026/08/24)
 * ----------------------------------------------------
 * Stagenet is the default, and it is the only network this build can transact
 * on. That is not a preference — it is what the stack allows.
 *
 * The app now runs on `@midnightntwrk/ledger-v9` 1.0.0-rc.3 and midnight-js
 * 5.0.0-beta.6, because the ledger-8 stack cannot sync stagenet at all: its
 * indexer client fails parsing the stagenet schema before the first block is
 * applied. The move is not reversible per network. Preview and Pre-production
 * run the ledger-8 protocol, and a ledger-9 wallet cannot decode their
 * transactions or produce ones they will accept — a single build cannot serve
 * both, because the ledger is a WASM module compiled against one protocol.
 *
 * Preview and Pre-production therefore remain KNOWN networks — records already
 * stored against them still render, and their explorer links still resolve —
 * but they are not selectable, not claimable, and not something this build's
 * wallet can open. {@link TRANSACTABLE_NETWORKS} is the honest list, and
 * {@link networkUnavailableReason} is the sentence to show instead of a
 * pretence that switching would work.
 *
 * This module imports nothing from the app, so anything may import it.
 */

/** The public Midnight networks Passport knows about. */
export type PassportNetworkId = 'stagenet' | 'preview' | 'preprod' | 'mainnet';

const KNOWN_NETWORKS: readonly PassportNetworkId[] = [
  'stagenet',
  'preview',
  'preprod',
  'mainnet',
];

/**
 * The network this build's local wallet is configured for. Mirrors the default
 * in `localWalletNetworkConfig()` — keep the two in step.
 */
export const DEFAULT_NETWORK_ID = 'stagenet';

/**
 * The networks whose protocol THIS BUILD's ledger can actually speak.
 *
 * One entry, and it is a statement about the WASM module linked into this
 * bundle rather than about which hosts are up. See the module header.
 */
export const TRANSACTABLE_NETWORKS: readonly PassportNetworkId[] = ['stagenet'];

/** Whether this build's wallet can open, sync, and sign on `network` at all. */
export function networkIsTransactable(networkId: string | null | undefined): boolean {
  return TRANSACTABLE_NETWORKS.includes(networkId as PassportNetworkId);
}

/**
 * Why a known network cannot be used by this build, or `null` when it can.
 * A sentence, not a code, because every surface that asks this question is
 * about to show it to somebody.
 */
export function networkUnavailableReason(networkId: string | null | undefined): string | null {
  if (networkIsTransactable(networkId)) return null;
  const network = asPassportNetwork(networkId);
  if (network === 'preview' || network === 'preprod') {
    return `This build runs on the ledger-9 protocol, which ${network} does not speak. Names already registered there still resolve, and their transactions still link to the explorer, but Passport cannot open an account on it.`;
  }
  if (network === 'mainnet') {
    return 'Passport does not transact on mainnet: a signing key whose seed comes from a browser passkey has no business spending real NIGHT.';
  }
  return null;
}

/** Safe outside Vite, where there is no `import.meta.env`. See `localWallet.ts`. */
function environment(): Record<string, string | undefined> {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  /* The `?? {}` half is the outside-Vite case named above. Under vitest and in
     the browser `import.meta.env` always exists, and a test cannot delete it
     from ANOTHER module's `import.meta`, so the branch is unreachable from a
     unit test. Every exported function here takes an explicit env object
     instead, and those are drilled. */
  /* v8 ignore next */
  return env ?? {};
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

/** Narrows an arbitrary network id to one of the public networks. */
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
export function walletNetwork(
  env: Record<string, string | undefined> = environment(),
): PassportNetworkId | null {
  const network = asPassportNetwork(configuredNetworkId(env));
  if (network) return network;
  /* DEMO MASQUERADE, env-gated: a devnet build that also carries a local
     Midnames TLD override presents itself as the default network so the
     identity card and claim path light up. The wallet still signs on its real
     configured network; the chain, the transactions, and the registry are the
     local ones. Public builds never set VITE_MIDNAMES_TLD_ADDRESS, so this
     branch is dead there and behaviour is byte-identical. */
  if (env.VITE_MIDNAMES_TLD_ADDRESS?.trim()) return DEFAULT_NETWORK_ID;
  return null;
}

/**
 * The public network the UI opens on. A devnet build still has to show
 * *something* in the switcher, so it falls back to the documented default.
 */
export function defaultSelectedNetwork(
  env: Record<string, string | undefined> = environment(),
): PassportNetworkId {
  return walletNetwork(env) ?? DEFAULT_NETWORK_ID;
}

/**
 * The networks Passport will genuinely REGISTER a `.night` name on — that is,
 * the ones where its wallet signs, submits, and can be held to the result.
 *
 * Stagenet only, and for two independent reasons. Mainnet was always absent:
 * a registration is a paid transaction, and a demo wallet whose seed comes
 * from a browser passkey has no business spending real NIGHT. Preview and
 * Pre-production left on 2026/08/24 for the reason in the module header —
 * this build's ledger cannot speak their protocol. A name chosen for either is
 * queued, with that reason shown.
 *
 * This lives here rather than in `identity/midnames.ts` so the UI can ask the
 * question without pulling the whole Midnight ledger runtime into the initial
 * bundle.
 */
export const CLAIMABLE_NETWORKS: readonly PassportNetworkId[] = ['stagenet'];

/** Whether a real `.night` registration is possible on `network` at all. */
export function aliasRegistrationSupported(network: string | null | undefined): boolean {
  return CLAIMABLE_NETWORKS.includes(network as PassportNetworkId);
}

/**
 * Public faucets, by network. Mainnet has no faucet and never will — its
 * absence here is the point.
 *
 * NOTE — deliberately no automated drip anywhere, on any of them. `POST
 * {base}/drips` requires an `X-Captcha-Token` from a Cloudflare Turnstile
 * challenge, so no in-app code can honestly obtain one. Confirmed for the
 * stagenet faucet on 2026/08/24 by reading its own bundle: it posts
 * `{ recipientAddress, amount }` with that header and then polls
 * `{base}/drips/{dripId}`. The only truthful funding flow is: copy the
 * address, open the faucet, complete the captcha there, and let the wallet's
 * own sync report the arrival.
 */
export const FAUCET_URLS: Partial<Record<PassportNetworkId, string>> = {
  stagenet: 'https://faucet.stagenet.shielded.tools',
  preview: 'https://faucet.preview.midnight.network',
  preprod: 'https://faucet.preprod.midnight.network',
};

/**
 * Public block explorer, by network. The 1AM explorer serves every network
 * from one origin, selected by a `network` query parameter — verified live
 * 2026/08/07 with a real preview transaction
 * (`/tx/ea39f2…?network=preview`). Its `/tx/{hash}` route takes the 32-byte
 * ledger transaction HASH, never the 33-byte identifier `submitTransaction`
 * answers with.
 *
 * Stagenet went in on 2026/08/25, on the same rule it was kept out by: the
 * explorer gained stagenet as a first-class network that day, and a real
 * stagenet transaction was seen to render —
 * `/tx/5941d2a7…86b2?network=stagenet`, a `withdraw_night` call in block
 * 172961 — along with `/contract/{address}` and `/block/{height}` on the
 * same query parameter. Mainnet is still omitted: no mainnet transaction of
 * ours has been seen to render, and a `200` from the shell is not evidence.
 */
export const EXPLORER_URLS: Partial<Record<PassportNetworkId, string>> = {
  preview: 'https://explorer.1am.xyz',
  preprod: 'https://explorer.1am.xyz',
  stagenet: 'https://explorer.1am.xyz',
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
 * Whether a value is a 32-byte ledger transaction HASH — the only thing an
 * explorer's `/tx/{hash}` route resolves.
 *
 * midnight-js answers a submit with a 33-byte transaction IDENTIFIER, and the
 * indexer is what maps one to the other. When that mapping has not happened
 * yet (indexer lag), the identifier is what we hold, and it is 66 hex
 * characters rather than 64. Linking it produced an explorer page that says
 * the transaction does not exist — a dead link presented as proof. So every
 * link goes through this gate, and an unresolved id is rendered as text.
 */
export function isLedgerTxHash(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * A link to one transaction on a network's explorer, or `null` when the
 * explorer is missing or the value is not a ledger transaction hash. Never a
 * link that resolves to nothing.
 */
export function explorerTxUrl(
  networkId: string | null | undefined,
  txHash: string | null | undefined,
): string | null {
  const network = asPassportNetwork(networkId);
  const origin = explorerUrlFor(networkId);
  if (!network || !origin || !isLedgerTxHash(txHash)) return null;
  return `${origin}/tx/${encodeURIComponent(txHash as string)}?network=${network}`;
}

/**
 * The step verifier — this demo's own read-only page, which reads a Passport's
 * whole history back off the indexer and renders it step by step.
 *
 * It is the SECOND place a transaction can be shown, and the only one that
 * works before the indexer has mapped a submitted identifier to a ledger hash:
 * it is asked for a NAME, not a hash, and it goes and finds every action on the
 * account that name resolves to.
 */
export const VERIFIER_URL = 'https://midnightpassport.com/verify/';

/**
 * A verifier link for one Passport, keyed by its `.night` name.
 *
 * `q` is the parameter `src/verify/main.ts` reads on load, and it takes exactly
 * what the search box takes. `null` for an absent or empty name, because a
 * verifier opened on nothing is a page that says "Ready." and nothing else.
 */
export function verifierNameUrl(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return `${VERIFIER_URL}?q=${encodeURIComponent(trimmed)}`;
}

/** Where a submitted transaction can be looked at, and what to call the link. */
export interface TxReceiptLink {
  label: string;
  href: string;
}

/**
 * The link a "submitted" toast carries — the explorer where there is one, and
 * the verifier where there is not.
 *
 * Two things stop the explorer from being an option, and neither is a failure:
 * a network with no public explorer in {@link EXPLORER_URLS}, and a transaction
 * whose 33-byte IDENTIFIER the indexer has not yet mapped to a ledger hash
 * ({@link isLedgerTxHash}). The account-contract deploy hits the second one
 * routinely — it is the first thing a Passport ever submits, and the toast
 * fires the moment it lands rather than minutes later — so a deploy passes its
 * `.night` name as a fallback and the toast points at the verifier, which finds
 * the deploy by resolving the name once the indexer has it.
 *
 * `null` means there is genuinely nowhere to send the user, and the caller
 * shows a toast with no link rather than one that resolves to nothing.
 */
export function txReceiptLink(
  networkId: string | null | undefined,
  txHash: string | null | undefined,
  fallbackName?: string | null,
): TxReceiptLink | null {
  const explorer = explorerTxUrl(networkId, txHash);
  if (explorer) return { label: 'View on explorer', href: explorer };
  const verifier = verifierNameUrl(fallbackName);
  return verifier ? { label: 'View on the verifier', href: verifier } : null;
}
