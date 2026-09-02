import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PassportProvider } from '@midnight-passport/connect/react';

import { App } from './App.js';
import { PASSPORT_ORIGIN } from './config.js';
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Doorman could not find its mount point.');

createRoot(root).render(
  <StrictMode>
    {/*
      One provider, one client, for the life of the tree. Doorman runs on its
      own origin and names the Passport origin explicitly: every message it
      sends is targeted at that origin, and every message it accepts must come
      from it.
    */}
    <PassportProvider origin={PASSPORT_ORIGIN} transport="popup">
      <App />
    </PassportProvider>
  </StrictMode>,
);
