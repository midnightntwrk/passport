import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { loadRegistry, snapshotApps } from './registry';
import type { RegistryApp, RegistryResult } from './registry';
import {
  getResolvedTheme,
  subscribeToTheme,
  toggleTheme,
  type ResolvedTheme,
} from './theme';

function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeToTheme, getResolvedTheme, () => 'light');
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function ThemeToggle() {
  const dark = useResolvedTheme() === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => toggleTheme()}
      aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/**
 * Public URL of the app registry repository. The registry exists but has not
 * been pushed to a public remote yet, so this stays `null` for now — while it
 * is null the hackathon panel renders its button disabled with a short note.
 *
 * TODO(orchestrator): once the registry is public, set this to its GitHub URL
 * (for example 'https://github.com/<owner>/midnight-passport-app-registry')
 * and set VITE_REGISTRY_JSON_URL to its raw registry.json URL at build time.
 */
const REGISTRY_REPO_URL: string | null = null;

const TEMPLATE_URL = 'https://template.midnightpassport.com';
const PASSPORT_URL = 'https://midnightpassport.com';

const CATEGORY_LABELS: Record<string, string> = {
  defi: 'DeFi',
  gaming: 'Gaming',
  tools: 'Tools',
  identity: 'Identity',
  other: 'Other',
};

function AppIcon({ app }: { app: RegistryApp }) {
  const [failed, setFailed] = useState(false);
  if (!app.icon || failed) {
    return <div className="card-icon card-icon-fallback">{app.name.slice(0, 1)}</div>;
  }
  return (
    <img
      className="card-icon"
      src={app.icon}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** `--i` drives the CSS entrance stagger; the stylesheet caps the total delay. */
function staggerStyle(index: number): CSSProperties {
  return { '--i': index } as CSSProperties;
}

function AppCard({ app, index }: { app: RegistryApp; index: number }) {
  const category = CATEGORY_LABELS[app.category ?? 'other'] ?? 'Other';
  return (
    <article className={`card${app.stale ? ' card-stale' : ''}`} style={staggerStyle(index)}>
      <div className="card-head">
        <AppIcon app={app} />
        <div className="card-title">
          <h3>{app.name}</h3>
          <span className="card-category">{category}</span>
        </div>
        {app.stale && <span className="badge badge-stale">stale</span>}
        {!app.stale && app.new && <span className="badge badge-new">new</span>}
      </div>
      {app.description && <p className="card-description">{app.description}</p>}
      <div className="card-meta">
        {(app.networks ?? []).map((network) => (
          <span key={network} className="badge badge-network">
            {network}
          </span>
        ))}
        <a className="card-link" href={app.url} target="_blank" rel="noreferrer">
          Open app ↗
        </a>
      </div>
      <p className="card-footnote">Listed via pull request — schema-checked.</p>
    </article>
  );
}

/**
 * Shown while the hackathon section has no entries: an invitation, the whole
 * register flow in one sentence, and the pull-request button — disabled with a
 * note until the registry repository has a public URL.
 */
function HackathonInvite() {
  return (
    <div className="hackathon-panel">
      <h3>This space is yours.</h3>
      <p className="hackathon-lede">
        Ship an app during the hackathon and raise a PR to appear here.
      </p>
      <p className="hackathon-how">
        One JSON entry in the registry's <code>registry.json</code> with{' '}
        <code>"section": "hackathon"</code> — that is the whole submission.
      </p>
      {REGISTRY_REPO_URL ? (
        <a className="button button-primary" href={REGISTRY_REPO_URL} target="_blank" rel="noreferrer">
          Raise a PR
        </a>
      ) : (
        <>
          <button className="button" type="button" disabled>
            Raise a PR
          </button>
          <p className="hackathon-note">
            The registry repository's public URL will be published here shortly.
          </p>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [result, setResult] = useState<RegistryResult>(() => ({
    apps: snapshotApps(),
    source: 'snapshot',
  }));

  useEffect(() => {
    let cancelled = false;
    void loadRegistry().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The seeded catalogue is Passport's alone — it renders inside the wallet's
  // Apps tab, never here. The hub shows only what the hackathon submits.
  const hackathon = result.apps.filter((app) => app.section === 'hackathon');

  return (
    <div className="page">
      <div className="page-topbar">
        <ThemeToggle />
      </div>
      <header className="hero">
        <p className="hero-kicker">
          Midnight Passport <span className="beta-badge">Beta</span>
        </p>
        <h1>Passport App Hub</h1>
        <p className="hero-lede">
          Apps built for Passport arrive here from the hackathon — one pull request each. The
          full catalogue lives inside Passport's own Apps tab.
        </p>
        <div className="hero-links">
          <a className="button button-primary" href={TEMPLATE_URL} target="_blank" rel="noreferrer">
            App template
          </a>
          <a className="button" href={PASSPORT_URL} target="_blank" rel="noreferrer">
            Open Passport
          </a>
        </div>
      </header>

      <main>
        {result.source === 'snapshot-after-failed-fetch' && hackathon.length > 0 && (
          <p className="list-notice">
            The live registry could not be reached — showing the bundled snapshot instead. Entries
            below are marked stale.
          </p>
        )}

        <section>
          <h2 className="section-title">Hackathon apps</h2>
          {hackathon.length > 0 ? (
            <div className="grid">
              {hackathon.map((app, index) => (
                <AppCard key={app.id} app={app} index={index} />
              ))}
            </div>
          ) : (
            <HackathonInvite />
          )}
        </section>
      </main>

      <footer className="footer">
        <p className="footer-fineprint">
          A listing records that an application exists and asked to be listed. It is not an audit,
          and listed applications remain their authors' property.
        </p>
      </footer>
    </div>
  );
}
