import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Loader2, RotateCw, Search, X } from 'lucide-react'
import {
  fetchAppRegistry,
  RAFFLE_DEMO_APP,
  withLocalApps,
  type RegistryApp,
  type RegistryCategory,
} from '../lib/registry.js'
import RaffleArt from './RaffleArt.js'
import AppBrowser, { AppIcon, type AppBrowserProps } from './AppBrowser.js'
import { type PassportNetwork } from './NetworkSwitcher.js'
import ThemeToggle from './ThemeToggle.js'
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
  /** Selected network; only apps available on it are listed. */
  network?: PassportNetwork
  /**
   * Accepted and ignored since 2026/09/03, when the network switcher went.
   * Kept so the host does not have to change to stop passing it; nothing on
   * this screen can change the network any more. See `NetworkSwitcher.tsx`.
   */
  onSelectNetwork?: (network: PassportNetwork) => void
  /**
   * The wallet seam an opened app can ask to spend from. All three are handed
   * straight to {@link AppBrowser}; leaving `executeTransfer` undefined is what
   * makes a framed app receive `wallet-unavailable` instead of a sheet it could
   * never satisfy.
   */
  executeTransfer?: AppBrowserProps['executeTransfer']
  transferContext?: AppBrowserProps['transferContext']
  onIncentiveRedeemed?: AppBrowserProps['onIncentiveRedeemed']
}

type LoadState = 'loading' | 'ready'

/** The order the non-featured apps are listed in. The categories no longer
    title their own sections — "All apps" is one flat list — but they still
    decide what comes before what, so an entry does not move around the grid
    between registry fetches. */
const CATEGORY_ORDER: readonly RegistryCategory[] = [
  'defi',
  'gaming',
  'identity',
  'tools',
  'other',
]

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

/** Most networks a card will name outright; the rest collapse into "+N". */
const MAX_NETWORK_PILLS = 2

function AppCard({ app, onOpen }: { app: RegistryApp; onOpen: () => void }) {
  const networks = app.networks ?? []
  const shown = networks.slice(0, MAX_NETWORK_PILLS)
  const overflow = networks.length - shown.length
  /* The raffle is the one entry we author ourselves, so it is the one entry we
     can illustrate honestly — registry apps get their own icon or a letter
     tile, never art we invented for them. */
  const illustrated = app.id === RAFFLE_DEMO_APP.id
  return (
    <button
      type="button"
      className={illustrated ? 'mnapps-card mnapps-card-illustrated' : 'mnapps-card'}
      onClick={onOpen}
    >
      {illustrated ? (
        /* The banner IS the identity here, so the letter tile beside it would
           only be a second, worse one. */
        <span className="mnapps-card-art" aria-hidden="true">
          <RaffleArt />
        </span>
      ) : (
        <AppIcon app={app} />
      )}
      <span className="mnapps-card-copy">
        <strong>{app.name}</strong>
        {app.description ? <small>{app.description}</small> : null}
        <span className="mnapps-card-meta">
          {app.new ? <span className="mnapps-tag">New</span> : null}
          {shown.map((network) => (
            <span className="mnapps-pill" key={network}>
              {network}
            </span>
          ))}
          {overflow > 0 ? (
            <span
              className="mnapps-pill"
              title={networks.slice(MAX_NETWORK_PILLS).join(', ')}
            >
              +{overflow}
            </span>
          ) : null}
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


/** An app with no declared networks is shown everywhere rather than nowhere. */
function onNetwork(app: RegistryApp, network: PassportNetwork | undefined): boolean {
  if (!network) return true
  if (!app.networks || app.networks.length === 0) return true
  return app.networks.includes(network)
}

export interface FeaturedAppsProps {
  profile: AppsScreenProps['profile']
  /** Notified after the user approves a profile request, for the activity feed. */
  onProfileShared?: (appName: string, fields: string[]) => void
  /** Selected network; only apps available on it are shown. */
  network?: PassportNetwork
  /** Same wallet seam as the Apps tab — an app behaves identically from Home. */
  executeTransfer?: AppBrowserProps['executeTransfer']
  transferContext?: AppBrowserProps['transferContext']
  onIncentiveRedeemed?: AppBrowserProps['onIncentiveRedeemed']
}

/**
 * FeaturedApps — the compact application grid the Home screen embeds below
 * the wallet summary. Same registry, same cards and icons, and the same
 * in-Passport AppBrowser as the full Apps tab; only the search, category
 * grouping, and status chrome are left to the Apps screen.
 */
export function FeaturedApps(props: FeaturedAppsProps) {
  const {
    profile,
    onProfileShared,
    network,
    executeTransfer,
    transferContext,
    onIncentiveRedeemed,
  } = props

  const [apps, setApps] = useState<RegistryApp[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [openApp, setOpenApp] = useState<RegistryApp | null>(null)

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

  // Featured entries lead; the rest follow in registry order — on this network.
  const ordered = useMemo(() => {
    const here = apps.filter((app) => onNetwork(app, network))
    return [...here.filter((app) => app.featured), ...here.filter((app) => !app.featured)]
  }, [apps, network])

  return (
    <>
      <section className="mnapps-section mnapps-embedded" aria-labelledby="mnapps-home-label">
        <h2 className="mnapps-section-label" id="mnapps-home-label">
          Apps
        </h2>
        {state === 'loading' ? (
          <p className="mnapps-status" role="status">
            <Loader2
              className="mnapps-spinner"
              size={15}
              strokeWidth={2}
              aria-hidden="true"
            />
            Loading apps…
          </p>
        ) : (
          <div className="mnapps-list">
            {ordered.map((app) => (
              <AppCard key={app.id} app={app} onOpen={() => setOpenApp(app)} />
            ))}
          </div>
        )}
      </section>

      {openApp ? (
        <AppBrowser
          key={openApp.id}
          app={openApp}
          profile={profile}
          onClose={() => setOpenApp(null)}
          onProfileShared={onProfileShared}
          executeTransfer={executeTransfer}
          transferContext={transferContext}
          onIncentiveRedeemed={onIncentiveRedeemed}
        />
      ) : null}
    </>
  )
}

export default function AppsScreen(props: AppsScreenProps) {
  const {
    profile,
    onProfileShared,
    network,
    executeTransfer,
    transferContext,
    onIncentiveRedeemed,
  } = props

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
    () => apps.filter((app) => onNetwork(app, network) && matches(app, query)),
    [apps, network, query],
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
        <header className="mnapps-bar">
          <img
            className="mnapps-wordmark"
            src="/midnight-wordmark.svg"
            alt="Midnight"
          />
          <div className="mnapps-bar-actions">
            {/* No network switcher since 2026/09/03 — see `NetworkSwitcher.tsx`. */}
            <ThemeToggle size="sm" />
          </div>
        </header>

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
            Loading the 1AM app directory…
          </p>
        ) : null}

        {state === 'ready' && stale ? (
          <div className="mnapps-status mnapps-status-stale" role="status">
            <span>
              The 1AM app directory could not be reached. Showing a small built-in
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

        {grouped.length > 0 ? (
          <section className="mnapps-section" aria-labelledby="mnapps-all">
            <h2 className="mnapps-section-label" id="mnapps-all">
              All apps
            </h2>
            <div className="mnapps-list">
              {grouped.flatMap((group) => group.apps).map((app) => (
                <AppCard key={app.id} app={app} onOpen={() => setOpenApp(app)} />
              ))}
            </div>
          </section>
        ) : null}

        {empty ? (
          <p className="mnapps-empty">
            {query
              ? `No app matches “${query}”.`
              : 'No apps are listed right now.'}
          </p>
        ) : null}

        <p className="mnapps-note">
          Passport cannot reach inside an app that is served from another site — every
          browser forbids it, and no framework works around that. Apps built for Passport
          ask you directly instead, and every request appears here for your approval.
        </p>
      </section>

      {openApp ? (
        <AppBrowser
          key={openApp.id}
          app={openApp}
          profile={profile}
          onClose={() => setOpenApp(null)}
          onProfileShared={onProfileShared}
          executeTransfer={executeTransfer}
          transferContext={transferContext}
          onIncentiveRedeemed={onIncentiveRedeemed}
        />
      ) : null}
    </>
  )
}
