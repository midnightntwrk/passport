import React from 'react';
import { createRoot } from 'react-dom/client';
import { DynamicContextProvider } from '@dynamic-labs/sdk-react-core';
import { DynamicWaasMidnightConnectors } from '@dynamic-labs/midnight';
import '@fontsource/space-grotesk/700.css';

// Theme first, and before anything renders. The blocking snippet in index.html
// has already written `data-theme` ahead of first paint, so this call is
// idempotent — it exists so the module (and its system-preference listener) is
// live before React mounts, whatever index.html happens to carry.
import { initTheme } from './lib/theme.js';
import PassportDemo from './App.js';
import { PassportPwaShell } from './pwa.js';
// The mobile screens' token contract. Each screen sheet imports it too; the
// bundler emits it once. Importing it here keeps the tokens present even when
// no screen sheet has been reached yet.
import './screens/tokens.css';
import './styles.css';

initTheme();

const environmentId = import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID;
const requiredDevelopmentOrigin = 'http://localhost:5175';

if (import.meta.env.DEV && window.location.origin !== requiredDevelopmentOrigin) {
  window.location.replace(`${requiredDevelopmentOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

function MissingEnvironment() {
  return (
    <div className="missing-environment">
      <img src="/midnight-wordmark.svg" alt="Midnight" />
      <p className="eyebrow">PASSPORT DEMO</p>
      <h1>Configure Dynamic to begin.</h1>
      <p>Add <code>VITE_DYNAMIC_ENVIRONMENT_ID</code> to <code>.env.local</code>, then enable Midnight embedded wallets and Private Key Exports in the Dynamic dashboard.</p>
    </div>
  );
}

if (!import.meta.env.DEV || window.location.origin === requiredDevelopmentOrigin) {
  const root = createRoot(document.getElementById('root')!);

  root.render(
    <React.StrictMode>
      <PassportPwaShell>
        {environmentId ? (
          <DynamicContextProvider
            settings={{
              environmentId,
              walletConnectors: [DynamicWaasMidnightConnectors],
              appName: 'Midnight Passport',
              social: { strategy: 'popup' },
              socialProvidersFilter: (providers) => providers.filter((provider) => provider === 'discord'),
            }}
          >
            <PassportDemo />
          </DynamicContextProvider>
        ) : (
          <MissingEnvironment />
        )}
      </PassportPwaShell>
    </React.StrictMode>,
  );
}
