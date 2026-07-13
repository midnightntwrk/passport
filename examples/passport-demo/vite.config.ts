import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceBuffer = path.resolve(__dirname, '..', '..', 'node_modules', 'buffer', 'index.js');

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: [
      { find: /^node:buffer$/, replacement: workspaceBuffer },
      { find: /^buffer$/, replacement: workspaceBuffer },
    ],
    dedupe: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-network-id',
      'rxjs',
    ],
  },
  server: {
    port: 5175,
    strictPort: true,
    host: 'localhost',
  },
  optimizeDeps: {
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/compact-runtime',
    ],
    // Compact's browser runtime imports this CommonJS dependency through an
    // ESM default import, so it must be explicitly pre-bundled in dev mode.
    include: ['object-inspect'],
  },
  build: {
    target: 'esnext',
  },
});
