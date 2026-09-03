import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/*
 * Passport Poll is served on its OWN origin. It is never mounted inside the
 * Passport shell, and it shares nothing with it but the wire protocol.
 *
 * `@midnight-passport/connect` resolves through the workspace link in the root
 * `node_modules`, which points at `packages/connect`. That package publishes
 * `dist/`, which nothing builds in this tree, so both Vite and TypeScript are
 * pointed at the sources instead — exactly as Doorman does it.
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
  server: {
    host: 'localhost',
    port: 5182,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5182,
    strictPort: true,
  },
});
