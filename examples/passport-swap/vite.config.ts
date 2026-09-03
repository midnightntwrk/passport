import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/*
 * Passport Swap is served on its OWN origin. It can also be opened inside the Passport
 * shell, and it shares nothing with it but the wire protocols.
 *
 * The package is resolved through the workspace link in the root
 * `node_modules/@midnight-passport/connect`, which points at
 * `packages/connect`. That package publishes `dist/`, which nothing builds in
 * this tree, so both Vite and TypeScript are pointed at the sources instead.
 */
const connect = (path: string) =>
  fileURLToPath(new URL(`../../node_modules/@midnight-passport/connect/src/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@midnight-passport\/connect\/react$/, replacement: connect('react/index.tsx') },
      { find: /^@midnight-passport\/connect\/redirect$/, replacement: connect('redirect/index.ts') },
      { find: /^@midnight-passport\/connect$/, replacement: connect('index.ts') },
    ],
  },
  /*
   * 5175 is not arbitrary: the desk answers a browser only from an origin its
   * own allow-list names, and `http://localhost:5175` is the one it already
   * carries for a locally served partner app. A different port is a quote the
   * browser blocks before the desk ever sees the request.
   */
  server: {
    host: 'localhost',
    port: 5175,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5175,
    strictPort: true,
  },
});
