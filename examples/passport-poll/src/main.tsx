import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PassportProvider } from '@midnight-passport/connect/react';

import { App } from './App.js';
import { PASSPORT_ORIGIN } from './config.js';
import './app.css';
import { restoreTheme } from './theme.js';

restoreTheme();

/*
 * One provider, one client, for the life of the tree. Passport Poll is served
 * on its own origin and shares nothing with Passport but the wire protocol.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PassportProvider origin={PASSPORT_ORIGIN}>
      <App />
    </PassportProvider>
  </StrictMode>,
);
