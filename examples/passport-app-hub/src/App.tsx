import { useEffect, useState } from 'react';
import { loadRegistry, snapshotApps } from './registry';
import type { RegistryApp, RegistryResult } from './registry';

/**
 * Public URL of the app registry repository. The registry exists but has not
 * been pushed to a public remote yet, so this stays `null` for now — the copy
 * below says "the registry repository" generically until it is filled in.
 *
 * TODO(orchestrator): once the registry is public, set this to its GitHub URL
 * (for example 'https://github.com/<owner>/midnight-passport-app-registry')
 * and set VITE_REGISTRY_JSON_URL to its raw registry.json URL at build time.
 */
const REGISTRY_REPO_URL: string | null = null;

const TEMPLATE_URL = 'https://midnight-passport-app-template.vercel.app';
const PASSPORT_URL = 'https://midnight-passport-app.vercel.app';

const CATEGORY_LABELS: Record<string, string> = {
  defi: 'DeFi',
  gaming: 'Gaming',
  tools: 'Tools',
  identity: 'Identity',
  other: 'Other',
};

function RegistryLink({ children }: { children: string }) {
  if (!REGISTRY_REPO_URL) return <strong>{children}</strong>;
  return (
    <a href={REGISTRY_REPO_URL} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

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

function AppCard({ app }: { app: RegistryApp }) {
  const category = CATEGORY_LABELS[app.category ?? 'other'] ?? 'Other';
  return (
    <article className={`card${app.stale ? ' card-stale' : ''}`}>
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

  const featured = result.apps.filter((app) => app.featured);
  const rest = result.apps.filter((app) => !app.featured);

  return (
    <div className="page">
      <header className="hero">
        <p className="hero-kicker">Midnight Passport</p>
        <h1>Passport App Hub</h1>
        <p className="hero-lede">
          Passport is a passkey wallet for the Midnight network — sign in with a passkey, hold a
          wallet, approve what apps may see and spend. This hub lists the applications that
          integrate the Passport bridge: they open in Passport's in-app browser, ask for a profile,
          and ask Passport to sign transactions, with every approval made on Passport's own
          surface.
        </p>
        <div className="hero-register">
          <h2>Register your app</h2>
          <p>
            Listing is a pull request against <RegistryLink>the registry repository</RegistryLink>:
            fork it, add one JSON entry for your app to <code>registry.json</code> (name,
            description, icon, URL, category, networks), and open the pull request. A
            dependency-free validator schema-checks your entry in CI, a maintainer reviews it by
            hand, and once merged your app appears here and in Passport's app grid — no build step,
            no server, just JSON.
          </p>
          {!REGISTRY_REPO_URL && (
            <p className="hero-note">
              The registry repository's public URL will be published here shortly.
            </p>
          )}
        </div>
      </header>

      <main>
        {result.source === 'snapshot-after-failed-fetch' && (
          <p className="list-notice">
            The live registry could not be reached — showing the bundled snapshot instead. Entries
            below are marked stale.
          </p>
        )}
        {featured.length > 0 && (
          <section>
            <h2 className="section-title">Featured</h2>
            <div className="grid">
              {featured.map((app) => (
                <AppCard key={app.id} app={app} />
              ))}
            </div>
          </section>
        )}
        <section>
          <h2 className="section-title">{featured.length > 0 ? 'All apps' : 'Apps'}</h2>
          <div className="grid">
            {(featured.length > 0 ? rest : result.apps).map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        <h2>Start building</h2>
        <p>
          The fastest way onto this list is the open-source app template — it already speaks the
          Passport bridge.
        </p>
        <div className="footer-links">
          <a className="button button-primary" href={TEMPLATE_URL} target="_blank" rel="noreferrer">
            App template
          </a>
          <a className="button" href={PASSPORT_URL} target="_blank" rel="noreferrer">
            Open Passport
          </a>
        </div>
        <p className="footer-fineprint">
          A listing records that an application exists and asked to be listed. It is not an audit,
          and listed applications remain their authors' property.
        </p>
      </footer>
    </div>
  );
}
