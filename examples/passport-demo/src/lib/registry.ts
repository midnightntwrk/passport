/**
 * 1AM app registry client for the in-Passport dApp browser.
 *
 * Fetches the public registry at runtime with an 8-second timeout and a
 * 10-minute sessionStorage cache. When the registry is unreachable a small
 * built-in fallback list is returned instead, with every entry marked
 * `stale: true` so the UI can be honest about what it is showing.
 */

const REGISTRY_URL =
  'https://raw.githubusercontent.com/webisoftSoftware/1AM-app-registery/main/registry.json'
const CACHE_KEY = 'mnapps.registry.v1'
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000

export type RegistryCategory = 'defi' | 'gaming' | 'tools' | 'identity' | 'other'
export type RegistryNetwork = 'preview' | 'preprod' | 'mainnet'

export interface RegistryApp {
  id: string
  name: string
  url: string
  description?: string
  /** Absolute URL to the app icon. */
  icon?: string
  category?: RegistryCategory
  networks?: RegistryNetwork[]
  featured?: boolean
  new?: boolean
  immersive?: boolean
  /** True when this entry came from the built-in offline fallback list, not the live registry. */
  stale?: boolean
}

const CATEGORIES: readonly RegistryCategory[] = ['defi', 'gaming', 'tools', 'identity', 'other']
const NETWORKS: readonly RegistryNetwork[] = ['preview', 'preprod', 'mainnet']

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

/**
 * Local demo entry for the separate-origin Atlas example dApp. This is the
 * entry that demonstrably completes the Passport profile handshake end-to-end.
 */
export const ATLAS_DEMO_APP: RegistryApp = {
  id: 'atlas-demo',
  name: 'Atlas (Passport demo dApp)',
  description:
    'Separate-origin dApp that requests your Passport profile via consented postMessage',
  url: webUrl(import.meta.env.VITE_ATLAS_URL, true) ?? 'http://localhost:5176',
  category: 'tools',
  networks: ['preview'],
  featured: true,
}

/** Prepends the local Atlas demo entry to a fetched registry list. */
export function withLocalApps(apps: RegistryApp[]): RegistryApp[] {
  return [ATLAS_DEMO_APP, ...apps.filter((app) => app.id !== ATLAS_DEMO_APP.id)]
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
 * `allowHttp` exists solely for the local Atlas dev entry below, which is
 * configured by us and served from `localhost` over plain http.
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
