/**
 * Registry client for the Passport App Hub.
 *
 * The list of apps is data, not code. It comes from the Midnight Passport app
 * registry's `registry.json`, in two layers:
 *
 * 1. **Bundled snapshot** — `registry.snapshot.json` in this folder is a
 *    build-time copy of the registry repository's `registry.json` (snapshot
 *    refreshed 2026/08/07, registry format version 2 with `section`). It
 *    ships inside the bundle, so the page always has
 *    something honest to show, offline included. Refresh it by copying the
 *    registry's `registry.json` over it and rebuilding.
 * 2. **Runtime fetch** — when `VITE_REGISTRY_JSON_URL` is set at build time
 *    (the registry's raw `registry.json` URL, once the repository is public),
 *    the page fetches it on load with an 8-second timeout. Success replaces
 *    the snapshot without a rebuild; failure falls back to the snapshot with
 *    every entry marked `stale: true`, so the UI can say what it is showing.
 *
 * The parsing below mirrors the Passport demo's registry client
 * (`examples/passport-demo/src/lib/registry.ts`): the fetched file is
 * third-party input, so entries are validated field by field and anything
 * unusable is dropped rather than trusted.
 */

import snapshot from './registry.snapshot.json';

const FETCH_TIMEOUT_MS = 8_000;

export type RegistryCategory = 'defi' | 'gaming' | 'tools' | 'identity' | 'other';
export type RegistryNetwork = 'preview' | 'preprod' | 'mainnet';
export type RegistrySection = 'standard' | 'hackathon';

export interface RegistryApp {
  id: string;
  name: string;
  url: string;
  description?: string;
  /** Absolute https URL to the app icon. */
  icon?: string;
  category?: RegistryCategory;
  /**
   * Which hub section lists the entry. Registry format v2 requires it;
   * entries from the older format (no `section`) default to 'standard'.
   */
  section?: RegistrySection;
  networks?: RegistryNetwork[];
  featured?: boolean;
  new?: boolean;
  immersive?: boolean;
  /** True when this entry came from the bundled snapshot after a live fetch failed. */
  stale?: boolean;
}

export interface RegistryResult {
  apps: RegistryApp[];
  /** Where the list actually came from — the page states this honestly. */
  source: 'live' | 'snapshot' | 'snapshot-after-failed-fetch';
}

const CATEGORIES: readonly RegistryCategory[] = ['defi', 'gaming', 'tools', 'identity', 'other'];
const NETWORKS: readonly RegistryNetwork[] = ['preview', 'preprod', 'mainnet'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Registry entries are third-party data, so every URL is untrusted input.
 * Only absolute `https:` URLs are accepted — same rule as the Passport demo,
 * which drops `javascript:`, `data:`, and plain-`http:` entries outright.
 */
function webUrl(value: unknown): string | undefined {
  const candidate = optionalString(value);
  if (!candidate) return undefined;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function parseApp(value: unknown): RegistryApp | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const url = webUrl(value.url);
  if (!id || !name || !url) return null;
  const category = CATEGORIES.includes(value.category as RegistryCategory)
    ? (value.category as RegistryCategory)
    : 'other';
  const networks = Array.isArray(value.networks)
    ? value.networks.filter((network): network is RegistryNetwork =>
        NETWORKS.includes(network as RegistryNetwork),
      )
    : [];
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
    stale: value.stale === true,
  };
}

function parseAppList(value: unknown): RegistryApp[] | null {
  if (!Array.isArray(value)) return null;
  const apps: RegistryApp[] = [];
  for (const entry of value) {
    const app = parseApp(entry);
    if (app) apps.push(app);
  }
  return apps.length > 0 ? apps : null;
}

/** The bundled snapshot, parsed through the same validator as live data. */
export function snapshotApps(): RegistryApp[] {
  return parseAppList((snapshot as { apps?: unknown }).apps) ?? [];
}

/**
 * Resolves to the live registry when `VITE_REGISTRY_JSON_URL` is configured
 * and reachable, otherwise to the bundled snapshot. Never rejects.
 */
export async function loadRegistry(): Promise<RegistryResult> {
  const liveUrl = optionalString(import.meta.env.VITE_REGISTRY_JSON_URL);
  if (!liveUrl) {
    return { apps: snapshotApps(), source: 'snapshot' };
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(liveUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Registry responded ${response.status}`);
    const body: unknown = await response.json();
    const apps = parseAppList(isRecord(body) ? body.apps : null);
    if (!apps) throw new Error('Registry payload contained no valid apps');
    return { apps, source: 'live' };
  } catch {
    return {
      apps: snapshotApps().map((app) => ({ ...app, stale: true })),
      source: 'snapshot-after-failed-fetch',
    };
  } finally {
    window.clearTimeout(timer);
  }
}
