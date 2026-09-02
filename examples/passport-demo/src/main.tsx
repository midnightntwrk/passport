// First import, deliberately: defines the Buffer global before any SDK chunk
// that references it evaluates. See the module's own header for the incident.
import './lib/bufferPolyfill.js';

import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/700.css';

// Theme first, and before anything renders. The blocking snippet in index.html
// has already written `data-theme` ahead of first paint, so this call is
// idempotent — it exists so the module (and its system-preference listener) is
// live before React mounts, whatever index.html happens to carry.
import { initTheme } from './lib/theme.js';
import PassportDemo from './App.js';
import { PassportPwaShell } from './pwa.js';
// Outside the shell, so a throw inside the shell itself still lands somewhere.
import { ErrorBoundary } from './lib/errorBoundary.js';
// The mobile screens' token contract. Each screen sheet imports it too; the
// bundler emits it once. Importing it here keeps the tokens present even when
// no screen sheet has been reached yet.
import './screens/tokens.css';
import './styles.css';

initTheme();

const requiredDevelopmentOrigin = 'http://localhost:5175';

if (import.meta.env.DEV && window.location.origin !== requiredDevelopmentOrigin) {
  window.location.replace(`${requiredDevelopmentOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

if (!import.meta.env.DEV || window.location.origin === requiredDevelopmentOrigin) {
  const root = createRoot(document.getElementById('root')!);

  root.render(
    <React.StrictMode>
      {/* Nothing wraps the app but the PWA shell: onboarding is a passkey
          ceremony in this tab, so there is no vendor context to provision and
          no environment id the boot can be held hostage to. */}
      <ErrorBoundary>
        <PassportPwaShell>
          <PassportDemo />
        </PassportPwaShell>
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // Retire the inline splash from index.html once React has painted, keeping
  // it on screen for at least 500ms so a fast load reads as a deliberate beat
  // rather than a flash. The element is removed after its opacity transition.
  const splash = document.getElementById('mn-splash');
  if (splash) {
    const shownAt = (window as { __mnSplashShownAt?: number }).__mnSplashShownAt ?? Date.now();
    const remaining = Math.max(0, 500 - (Date.now() - shownAt));
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        splash.classList.add('mn-splash-done');
        window.setTimeout(() => splash.remove(), 400);
      });
    }, remaining);
  }
}
