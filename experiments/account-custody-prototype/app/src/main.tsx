import './polyfills.js';
import './localOrigin.js';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { DynamicContextProvider } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { DynamicWaasMidnightConnectors } from '@dynamic-labs/midnight';

import App from './App.js';
import './styles.css';

const DEFAULT_DYNAMIC_ENVIRONMENT_ID = '6f77e474-45a5-4310-afd6-d87179602701';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DynamicContextProvider
      settings={{
        environmentId:
          import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID || DEFAULT_DYNAMIC_ENVIRONMENT_ID,
        walletConnectors: [DynamicWaasMidnightConnectors, EthereumWalletConnectors],
        appName: 'MN Passport',
        social: { strategy: 'popup' },
        socialProvidersFilter: (providers) => {
          const discord = providers.find((provider) => provider === 'discord');
          return discord ? [discord] : providers;
        },
      }}
    >
      <App />
    </DynamicContextProvider>
  </React.StrictMode>,
);
