import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Loader2, RotateCw, Search, X } from 'lucide-react'
import {
  fetchAppRegistry,
  withLocalApps,
  type RegistryApp,
  type RegistryCategory,
} from '../lib/registry.js'
import AppBrowser, { AppIcon } from './AppBrowser.js'
import './apps.css'

/**
 * Apps — the in-Passport dApp browser.
 *
 * The screen owns its registry fetch and its own open-app state, so the
 * integrator only has to hand it a profile and listen for shares.
 */

export interface AppsScreenProps {
  profile: {
    displayName?: string | null
    passportContract?: { address: string; network: string } | null
    midnightAddresses?: {
      unshielded?: string | null
      shielded?: string | null
      dust?: string | null
    }
  } | null
  /** Notified after the user approves a profile request, for the activity feed. */
  onProfileShared?: (appName: string, fields: string[]) => void
}

type LoadState = 'loading' | 'ready'

const CATEGORY_ORDER: readonly RegistryCategory[] = [
  'defi',
  'gaming',
  'identity',
  'tools',
  'other',
]

const CATEGORY_LABELS: Record<RegistryCategory, string> = {
  defi: 'DeFi',
  gaming: 'Gaming',
  identity: 'Identity',
  tools: 'Tools',
  other: 'Everything else',
}

function matches(app: RegistryApp, query: string): boolean {
  if (!query) return true
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    app.name.toLowerCase().includes(needle) ||
    (app.description ?? '').toLowerCase().includes(needle) ||
    (app.category ?? '').toLowerCase().includes(needle)
  )
}

function AppCard({ app, onOpen }: { app: RegistryApp; onOpen: () => void }) {
  return (
    <button type="button" className="mnapps-card" onClick={onOpen}>
      <AppIcon app={app} />
      <span className="mnapps-card-copy">
        <strong>{app.name}</strong>
        {app.description ? <small>{app.description}</small> : null}
        <span className="mnapps-card-meta">
          {app.new ? <span className="mnapps-tag">New</span> : null}
          {(app.networks ?? []).map((network) => (
            <span className="mnapps-pill" key={network}>
              {network}
            </span>
          ))}
        </span>
      </span>
      <ArrowUpRight
        className="mnapps-card-arrow"
        size={16}
        strokeWidth={2.2}
        aria-hidden="true"
      />
    </button>
  )
}

export default function AppsScreen(props: AppsScreenProps) {
  const { profile, onProfileShared } = props

  const [apps, setApps] = useState<RegistryApp[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [query, setQuery] = useState('')
  const [openApp, setOpenApp] = useState<RegistryApp | null>(null)

  const load = useCallback(async (force: boolean): Promise<void> => {
    setState('loading')
    const list = await fetchAppRegistry(force ? { force: true } : {})
    setApps(withLocalApps(list))
    setState('ready')
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await fetchAppRegistry()
      if (cancelled) return
      setApps(withLocalApps(list))
      setState('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(
    () => apps.filter((app) => matches(app, query)),
    [apps, query],
  )
  const featured = useMemo(
    () => filtered.filter((app) => app.featured),
    [filtered],
  )
  const grouped = useMemo(() => {
    const rest = filtered.filter((app) => !app.featured)
    return CATEGORY_ORDER.map((category) => ({
      category,
      apps: rest.filter((app) => (app.category ?? 'other') === category),
    })).filter((group) => group.apps.length > 0)
  }, [filtered])

  const stale = apps.some((app) => app.stale)
  const empty = state === 'ready' && filtered.length === 0

  return (
    <>
      <section className="mnapps-screen">
        <header className="mnapps-head">
          <p className="mnapps-kicker">Midnight apps</p>
          <h1 className="mnapps-title">Apps</h1>
          <p className="mnapps-lede">
            Open a Midnight dApp inside Passport. Nothing about you leaves this
            device until you approve it.
          </p>
        </header>

        <div className="mnapps-search">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Search apps"
            aria-label="Search apps"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="mnapps-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {state === 'loading' ? (
          <p className="mnapps-status" role="status">
            <Loader2
              className="mnapps-spinner"
              size={15}
              strokeWidth={2}
              aria-hidden="true"
            />
            Loading the 1AM registry…
          </p>
        ) : null}

        {state === 'ready' && stale ? (
          <div className="mnapps-status mnapps-status-stale" role="status">
            <span>
              The 1AM registry could not be reached. Showing a small built-in
              list instead.
            </span>
            <button
              type="button"
              className="mnapps-retry"
              onClick={() => void load(true)}
            >
              <RotateCw size={13} strokeWidth={2.2} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : null}

        {featured.length > 0 ? (
          <section className="mnapps-section" aria-labelledby="mnapps-featured">
            <h2 className="mnapps-section-label" id="mnapps-featured">
              Featured
            </h2>
            <div className="mnapps-list">
              {featured.map((app) => (
                <AppCard key={app.id} app={app} onOpen={() => setOpenApp(app)} />
              ))}
            </div>
          </section>
        ) : null}

        {grouped.map((group) => (
          <section
            className="mnapps-section"
            key={group.category}
            aria-labelledby={`mnapps-${group.category}`}
          >
            <h2 className="mnapps-section-label" id={`mnapps-${group.category}`}>
              {CATEGORY_LABELS[group.category]}
            </h2>
            <div className="mnapps-list">
              {group.apps.map((app) => (
                <AppCard key={app.id} app={app} onOpen={() => setOpenApp(app)} />
              ))}
            </div>
          </section>
        ))}

        {empty ? (
          <p className="mnapps-empty">
            {query
              ? `No app in the registry matches “${query}”.`
              : 'The registry returned no apps.'}
          </p>
        ) : null}

        <p className="mnapps-note">
          Passport cannot inject a wallet into an app served from another origin
          — the browser's same-origin policy forbids it, and no framework works
          around that. Apps that speak the Passport profile protocol ask over
          postMessage instead, and every request surfaces here for your approval.
        </p>
      </section>

      {openApp ? (
        <AppBrowser
          key={openApp.id}
          app={openApp}
          profile={profile}
          onClose={() => setOpenApp(null)}
          onProfileShared={onProfileShared}
        />
      ) : null}
    </>
  )
}
