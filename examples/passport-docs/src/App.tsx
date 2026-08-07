import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { DOCS_TITLE, SECTIONS, docsAsMarkdown } from './content';
import { Markdown, outlineOf } from './markdown';
import { getResolvedTheme, subscribeToTheme, toggleTheme, type ResolvedTheme } from './theme';

/**
 * The docs shell: sticky left navigation (collapsible on small screens), one
 * section rendered at a time, hash-based routing with no router dependency.
 *
 * Hash grammar: `#<sectionId>` selects a section; `#<sectionId>--<slug>`
 * additionally scrolls to that heading (the ids `markdown.tsx` assigns).
 */

const LIVE_APPS = [
  { label: 'Passport', href: 'https://midnight-passport-app.vercel.app' },
  { label: 'App Hub', href: 'https://passport-app-hub.vercel.app' },
  { label: 'App template', href: 'https://midnight-passport-app-template.vercel.app' },
];

function sectionIdFromHash(hash: string): string {
  const clean = hash.replace(/^#\/?/, '');
  const sectionId = clean.split('--')[0];
  return SECTIONS.some((section) => section.id === sectionId) ? sectionId : SECTIONS[0].id;
}

/** `--i` drives the CSS entrance stagger, exactly as the App Hub does it. */
function staggerStyle(index: number): CSSProperties {
  return { '--i': index } as CSSProperties;
}

/* ------------------------------------------------------------------ */
/* Header controls                                                     */
/* ------------------------------------------------------------------ */

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

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ThemeToggle() {
  const resolved = useResolvedTheme();
  const dark = resolved === 'dark';
  return (
    <button
      type="button"
      className="docs-iconbutton"
      onClick={() => toggleTheme()}
      aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/**
 * Copies the ENTIRE documentation — title, sections, and tables — as clean
 * markdown, for pasting into an AI assistant. The same body is served at
 * `/llms.txt` (emitted at build time from the same source — vite.config.ts).
 */
function CopyForAI() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    const body = docsAsMarkdown();
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      /* Clipboard API refused (insecure context, permissions) — fall back to
         the selection-based path so the button still works. */
      const area = document.createElement('textarea');
      area.value = body;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }, []);

  return (
    <button
      type="button"
      className={`docs-copyai${copied ? ' docs-copyai-done' : ''}`}
      onClick={() => void copy()}
      aria-live="polite"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy for AI'}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
  const [activeId, setActiveId] = useState(() => sectionIdFromHash(window.location.hash));
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      const nextId = sectionIdFromHash(window.location.hash);
      setActiveId(nextId);
      setNavOpen(false);
      /* `#section--heading` scrolls to the heading; a bare section goes to
         the top. Deferred a frame so the section has rendered. */
      const target = window.location.hash.replace(/^#\/?/, '');
      window.requestAnimationFrame(() => {
        if (target.includes('--')) {
          document.getElementById(target)?.scrollIntoView({ block: 'start' });
        } else {
          window.scrollTo({ top: 0 });
        }
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const section = SECTIONS.find((candidate) => candidate.id === activeId);
    document.title = section ? `${section.title} — ${DOCS_TITLE}` : DOCS_TITLE;
  }, [activeId]);

  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0];
  const outline = useMemo(() => outlineOf(active.markdown), [active]);

  return (
    <div className="docs-shell">
      <header className="docs-topbar">
        <div className="docs-topbar-inner">
          <a className="docs-brand" href="#welcome">
            <span className="docs-brand-mark" aria-hidden="true" />
            <span className="docs-brand-name">
              Midnight Passport <span>Docs</span>
            </span>
            <span className="beta-badge">Beta</span>
          </a>
          <div className="docs-topbar-actions">
            <CopyForAI />
            <ThemeToggle />
            <button
              type="button"
              className="docs-iconbutton docs-navtoggle"
              onClick={() => setNavOpen((open) => !open)}
              aria-expanded={navOpen}
              aria-controls="docs-nav"
              aria-label={navOpen ? 'Close the contents' : 'Open the contents'}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                {navOpen ? <path d="M5 5l14 14M19 5 5 19" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="docs-frame">
        <nav id="docs-nav" className={`docs-nav${navOpen ? ' docs-nav-open' : ''}`} aria-label="Documentation sections">
          <ul className="docs-nav-list">
            {SECTIONS.map((section, index) => {
              const isActive = section.id === active.id;
              return (
                <li key={section.id} style={staggerStyle(index)} className="docs-nav-item">
                  <a
                    className={`docs-nav-link${isActive ? ' docs-nav-link-active' : ''}`}
                    href={`#${section.id}`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {section.title}
                  </a>
                  {isActive && outline.length > 0 ? (
                    <ul className="docs-nav-sublist">
                      {outline.map((entry) => (
                        <li key={entry.slug}>
                          <a className="docs-nav-sublink" href={`#${section.id}--${entry.slug}`}>
                            {entry.text}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Keyed by section id so the entrance animation replays per page. */}
        <main className="docs-main" key={active.id}>
          <article className="docs-article">
            <header className="docs-article-head">
              <p className="docs-kicker">Midnight Passport</p>
              <h1>{active.title}</h1>
              <p className="docs-lede">{active.lede}</p>
            </header>
            <div className="docs-prose">
              <Markdown markdown={active.markdown} idPrefix={active.id} />
            </div>
            <SectionPager activeId={active.id} />
          </article>

          <footer className="docs-footer">
            <p className="docs-footer-links">
              {LIVE_APPS.map((app, index) => (
                <FooterLink key={app.href} href={app.href} first={index === 0}>
                  {app.label}
                </FooterLink>
              ))}
            </p>
            <p className="docs-footer-fineprint">
              These deployments will move to midnightpassport.com subdomains.
              The full documentation is also available as plain markdown at{' '}
              <a href="/llms.txt">/llms.txt</a>.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}

function FooterLink({ href, first, children }: { href: string; first: boolean; children: ReactNode }) {
  return (
    <>
      {first ? null : <span aria-hidden="true"> · </span>}
      <a href={href} target="_blank" rel="noreferrer">
        {children} ↗
      </a>
    </>
  );
}

/** Previous/next section links at the foot of each page. */
function SectionPager({ activeId }: { activeId: string }) {
  const index = SECTIONS.findIndex((section) => section.id === activeId);
  const previous = index > 0 ? SECTIONS[index - 1] : null;
  const next = index >= 0 && index < SECTIONS.length - 1 ? SECTIONS[index + 1] : null;
  if (!previous && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Adjacent sections">
      {previous ? (
        <a className="docs-pager-link" href={`#${previous.id}`}>
          <span className="docs-pager-label">Previous</span>
          <span className="docs-pager-title">← {previous.title}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a className="docs-pager-link docs-pager-next" href={`#${next.id}`}>
          <span className="docs-pager-label">Next</span>
          <span className="docs-pager-title">{next.title} →</span>
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}
