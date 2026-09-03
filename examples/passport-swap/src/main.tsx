import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PassportProvider } from '@midnight-passport/connect/react';

import { App } from './App.js';
import { PASSPORT_ORIGIN } from './config.js';
import './app.css';
import { restoreTheme } from './theme.js';

restoreTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Passport Swap could not find its mount point.');

/*
 * One provider, one client, for the life of the tree. Passport Swap runs on
 * its own origin and names the Passport origin explicitly: every message it
 * sends is targeted at that origin, and every message it accepts must come
 * from it.
 *
 * The transport is `auto` rather than `popup` because this app is meant to be
 * opened both ways — as an ordinary tab, where Passport is a window it opens,
 * and from inside Passport's own app browser, where it is framed and Passport
 * is `window.parent`. The same three calls work either way.
 */
createRoot(root).render(
  <StrictMode>
    <PassportProvider origin={PASSPORT_ORIGIN}>
      <App />
    </PassportProvider>
  </StrictMode>,
);
