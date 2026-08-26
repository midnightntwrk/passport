/**
 * 1AM app registry client for the in-Passport dApp browser.
 *
 * Fetches the public registry at runtime with an 8-second timeout and a
 * 10-minute sessionStorage cache. When the registry is unreachable a small
 * built-in fallback list is returned instead, with every entry marked
 * `stale: true` so the UI can be honest about what it is showing.
 */

import { walletNetwork } from './networks.js'

const REGISTRY_URL =
  'https://raw.githubusercontent.com/webisoftSoftware/1AM-app-registery/main/registry.json'
const CACHE_KEY = 'mnapps.registry.v1'
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000

export type RegistryCategory = 'defi' | 'gaming' | 'tools' | 'identity' | 'other'
export type RegistryNetwork = 'stagenet' | 'preview' | 'preprod' | 'mainnet'
export type RegistrySection = 'standard' | 'hackathon'

export interface RegistryApp {
  id: string
  name: string
  url: string
  description?: string
  /** Absolute URL to the app icon. */
  icon?: string
  category?: RegistryCategory
  /**
   * Which hub section the entry belongs to. The Passport app registry's v2
   * format carries this; the original 1AM format does not, so the parser
   * defaults absent or unrecognised values to 'standard'. Carried for
   * consumers — nothing in this demo filters on it yet.
   */
  section?: RegistrySection
  networks?: RegistryNetwork[]
  featured?: boolean
  new?: boolean
  immersive?: boolean
  /** True when this entry came from the built-in offline fallback list, not the live registry. */
  stale?: boolean
}

const CATEGORIES: readonly RegistryCategory[] = ['defi', 'gaming', 'tools', 'identity', 'other']
const NETWORKS: readonly RegistryNetwork[] = ['stagenet', 'preview', 'preprod', 'mainnet']

/**
 * Minimal offline list — ids, names, and urls only. Returned when the live
 * registry cannot be reached; each entry carries `stale: true`.
 */
export const FALLBACK_APPS: readonly RegistryApp[] = [
  { id: '1am-explorer', name: '1AM Explorer', url: 'https://explorer.1am.xyz', stale: true },
  { id: 'ascend-dex', name: 'Ascend DEX', url: 'https://dex.ascend.market', stale: true },
  { id: 'dominion', name: 'Dominion', url: 'https://dominion.fun', stale: true },
  { id: 'zkmint', name: 'ZKMint', url: 'https://zkmint.1am.xyz', stale: true },
]

/** The port `examples/raffle-demo` pins in its own `vite.config.ts`. */
const RAFFLE_FALLBACK_URL = 'http://localhost:5177'

/**
 * Local demo entry for the separate-origin Midnight Raffle example dApp —
 * decided 2026/08/05, replacing the earlier Atlas entry. This is the entry
 * that demonstrably completes the Passport profile handshake end-to-end.
 *
 * Unlike {@link LOCAL_DEV_APP} this entry always exists: with `VITE_RAFFLE_URL`
 * unset it falls back to the pinned local port, so a plain `npm run demo` still
 * shows the handshake. Both halves of the entry read from the environment on
 * the same terms the local-app slot uses — `VITE_RAFFLE_URL`/`VITE_RAFFLE_NAME`
 * against `VITE_LOCAL_APP_URL`/`VITE_LOCAL_APP_NAME` — because a build that
 * moves the raffle to a deployed origin (the release deployment, or the
 * break-glass `npm run deploy:passport:manual`) must be able to rename it there
 * too, rather than shipping a label naming a demo the configured origin may no
 * longer serve.
 */
export const RAFFLE_DEMO_APP: RegistryApp = {
  id: 'raffle-demo',
  name: optionalString(import.meta.env.VITE_RAFFLE_NAME) ?? 'Midnight Raffle',
  description:
    'Connect your Passport to claim a race-weekend perk and a demo raffle ticket',
  url: webUrl(import.meta.env.VITE_RAFFLE_URL, true) ?? RAFFLE_FALLBACK_URL,
  category: 'other',
  // The raffle runs against whichever network Passport's wallet is on, because
  // the only thing it asks Passport for is a profile and (when an operator
  // address is configured) a transfer that Passport itself signs. Declaring it
  // on one fixed network hid it from the grid the moment the build moved —
  // found on 2026/08/06 while trialling a pre-production build, where the grid
  // filters to preprod and a preview-only entry simply vanishes.
  networks: walletNetwork() ? [walletNetwork() as RegistryNetwork] : ['stagenet'],
  featured: true,
}

/**
 * Generic local-development entry — added 2026/08/06.
 *
 * `VITE_RAFFLE_URL` above is the slot third-party developers were being told to
 * use to see their own app in the grid, and the name asks them to pretend their
 * app is a raffle. This is the same mechanism under a name that says what it is:
 * set `VITE_LOCAL_APP_URL` to whatever your dev server is serving, optionally
 * `VITE_LOCAL_APP_NAME` for the label. `null` when the variable is unset, so a
 * build that does not set it behaves exactly as it did before this entry
 * existed. `VITE_RAFFLE_URL` keeps working, unchanged, and both entries can be
 * present at once.
 */
export const LOCAL_DEV_APP: RegistryApp | null = buildLocalDevApp()

function buildLocalDevApp(): RegistryApp | null {
  // `allowHttp` for the same reason the raffle entry has it: this URL is
  // configured by whoever runs the build, and a dev server is plain http on
  // localhost. Nothing from the fetched registry reaches this path.
  const url = webUrl(import.meta.env.VITE_LOCAL_APP_URL, true)
  if (!url) return null
  return {
    id: 'local-dev-app',
    name: optionalString(import.meta.env.VITE_LOCAL_APP_NAME) ?? 'Local app',
    description: 'A local development server, added by this build’s VITE_LOCAL_APP_URL',
    url,
    category: 'other',
    // Same reasoning as the raffle entry: follow the wallet's network rather
    // than declaring one, or the entry vanishes from a grid filtered to a
    // network the developer happens to be on.
    networks: walletNetwork() ? [walletNetwork() as RegistryNetwork] : ['stagenet'],
    // Featured so a developer who has just pointed the build at their own dev
    // server finds it at the top of the grid rather than hunting for it.
    featured: true,
  }
}

/**
 * Prepends the locally configured entries — the generic `VITE_LOCAL_APP_URL`
 * one when it is configured, and the Midnight Raffle demo — to a fetched
 * registry list. Both, when both are present; neither replaces the other.
 */
export function withLocalApps(apps: RegistryApp[]): RegistryApp[] {
  const local = LOCAL_DEV_APP ? [LOCAL_DEV_APP, RAFFLE_DEMO_APP] : [RAFFLE_DEMO_APP]
  const localIds = new Set(local.map((app) => app.id))
  return [...local, ...apps.filter((app) => !localIds.has(app.id))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Registry entries are third-party data fetched from a repository we do not
 * control, so every URL they carry is untrusted input. Only absolute `https:`
 * URLs are accepted from the registry: a `javascript:` entry would otherwise
 * reach the in-app browser's `window.open` "new tab" button and execute as
 * script, a `data:`/`blob:` entry would be framed with an origin the consent
 * sheet cannot meaningfully name, and an `http:` entry would put a framed app
 * — and the profile handshake with it — on the network in the clear.
 *
 * `allowHttp` exists solely for the two local development entries above — the
 * Midnight Raffle demo and the generic `VITE_LOCAL_APP_URL` slot — whose URLs
 * come from the build's own environment, not from the registry, and which are
 * served from `localhost` over plain http.
 */
function webUrl(value: unknown, allowHttp = false): string | undefined {
  const candidate = optionalString(value)
  if (!candidate) return undefined
  try {
    const protocol = new URL(candidate).protocol
    if (protocol === 'https:') return candidate
    return allowHttp && protocol === 'http:' ? candidate : undefined
  } catch {
    return undefined
  }
}

function parseApp(value: unknown): RegistryApp | null {
  if (!isRecord(value)) return null
  const id = optionalString(value.id)
  const name = optionalString(value.name)
  const url = webUrl(value.url)
  if (!id || !name || !url) return null
  const category = CATEGORIES.includes(value.category as RegistryCategory)
    ? (value.category as RegistryCategory)
    : 'other'
  const networks = Array.isArray(value.networks)
    ? value.networks.filter((network): network is RegistryNetwork =>
        NETWORKS.includes(network as RegistryNetwork),
      )
    : []
  return {
    id,
    name,
    url,
    description: optionalString(value.description),
    icon: webUrl(value.icon),
    category,
    section: value.section === 'hackathon' ? 'hackathon' : 'standard',
    networks,
    featured: value.featured === true,
    new: value.new === true,
    immersive: value.immersive === true,
  }
}

function parseAppList(value: unknown): RegistryApp[] | null {
  if (!Array.isArray(value)) return null
  const apps: RegistryApp[] = []
  for (const entry of value) {
    const app = parseApp(entry)
    if (app) apps.push(app)
  }
  return apps.length > 0 ? apps : null
}

function readCache(): RegistryApp[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (typeof parsed.fetchedAt !== 'number') return null
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    return parseAppList(parsed.apps)
  } catch {
    return null
  }
}

function writeCache(apps: RegistryApp[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), apps }))
  } catch {
    // Storage may be unavailable (private browsing, quota) — the cache is best effort.
  }
}

export interface FetchAppRegistryOptions {
  /** Skip the sessionStorage cache and hit the network. */
  force?: boolean
}

/**
 * Resolves to the live registry (cached for 10 minutes), or to the built-in
 * fallback list — every fallback entry marked `stale: true` — if the network
 * fails or times out after 8 seconds. Never rejects.
 */
export async function fetchAppRegistry(
  options: FetchAppRegistryOptions = {},
): Promise<RegistryApp[]> {
  if (!options.force) {
    const cached = readCache()
    if (cached) return cached
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Registry responded ${response.status}`)
    const body: unknown = await response.json()
    const apps = parseAppList(isRecord(body) ? body.apps : null)
    if (!apps) throw new Error('Registry payload contained no valid apps')
    writeCache(apps)
    return apps
  } catch {
    return FALLBACK_APPS.map((app) => ({ ...app }))
  } finally {
    window.clearTimeout(timer)
  }
}
