#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import App from './App.js';
import {logger} from './logger.js';

// Ensure crashes always leave a log entry — unhandled rejections and uncaught
// exceptions bypass React/Ink's error handling and would otherwise exit silently
// when the alternate screen buffer is active.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (process exiting)', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (process exiting)', err);
  process.exit(1);
});

process.stdout.write('Starting local-tee-poc . . .');
const dotInterval = setInterval(() => process.stdout.write('.'), 300);

await Promise.resolve();
clearInterval(dotInterval);
process.stdout.write('\n');

process.stdout.write('\x1b[?1049h\x1b[H');
render(<App />, {exitOnCtrlC: true});
process.on('exit', () => process.stdout.write('\x1b[?1049l'));
