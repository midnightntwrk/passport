#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import App from './App.js';
import {WalletProvider} from './hooks/useWallet.js';

// Print a startup indicator on the normal screen while modules load.
// This line executes as soon as the entry point is parsed, so it appears
// immediately even before React/Ink initialise.
process.stdout.write('Starting Midnight TUI . . .');
const dotInterval = setInterval(() => process.stdout.write('.'), 300);

// Small async trampoline so we can await the first render tick before
// switching to the alternate buffer, giving tsx time to settle.
await Promise.resolve();
clearInterval(dotInterval);
process.stdout.write('\n');

// Enter alternate screen buffer (fullscreen) then render.
process.stdout.write('\x1b[?1049h\x1b[H');
render(<WalletProvider><App /></WalletProvider>, {exitOnCtrlC: true});
process.on('exit', () => process.stdout.write('\x1b[?1049l'));
