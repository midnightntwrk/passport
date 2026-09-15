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

  /* Social sign-in, when this build has been given an environment id — which
     no build shipped today has.

     THE CONDITION IS WRITTEN OUT RATHER THAN CALLED, and that is the whole
     point of it. `isDynamicEnabled()` is the same question and reads better,
     but it is a function call, and a function call is opaque to the bundler.
     Vite substitutes `import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID` with a
     literal at build time, so with the variable unset this reads `if
     (undefined)` and Rollup deletes the branch, the `import()`, and every
     chunk reachable from it. MEASURED, 2026/09/14: written as a call, a
     flag-off build emitted the SDK anyway — 118 chunks and 10,169,722 bytes of
     JavaScript, against 44 and 3,219,674 written this way. Nothing would ever
     have fetched those 7 MB; they would just have been deployed. A dynamic
     import is not dead code to a bundler merely because the branch above it
     is false at run time.

     Two more properties, both deliberate: it runs AFTER `root.render`, and its
     rejection is swallowed. The Passport is already on screen before any of
     this is attempted, so a vendor that will not load costs a secondary
     button and never a boot. */
  if (import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID) {
    void import('./lib/dynamic.js').then((module) => module.mountDynamic()).catch(() => {});
  }

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
