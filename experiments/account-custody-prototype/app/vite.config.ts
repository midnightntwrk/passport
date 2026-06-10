import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managedDir = path.resolve(__dirname, '..', 'contracts', 'managed');

// Serve the compiled contract artefacts (prover/verifier keys, zkir) at /zk
// so FetchZkConfigProvider can pull them: /zk/account/keys/<circuit>.prover …
function serveZkAssets(): Plugin {
  return {
    name: 'serve-zk-assets',
    configureServer(server) {
      server.middlewares.use('/zk', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const filePath = path.join(managedDir, rel);
        if (!filePath.startsWith(managedDir)) return next();
        fs.stat(filePath, (err, st) => {
          if (err || !st.isFile()) return next();
          res.setHeader('Content-Type', 'application/octet-stream');
          fs.createReadStream(filePath).pipe(res);
        });
      });
    },
  };
}

// Inline the faucet address if src/tests/deploy.ts has been run.
function faucetAddress(): string {
  const p = path.resolve(__dirname, '..', 'faucet-deployment.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')).faucetAddress ?? '';
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), serveZkAssets()],
  define: {
    __FAUCET_ADDRESS__: JSON.stringify(faucetAddress()),
  },
  resolve: {
    alias: {
      'isomorphic-ws': path.resolve(__dirname, 'src/lib/ws-shim.ts'),
      // Userland Buffer for wallet-SDK imports of node's `buffer` module —
      // applies to deps served from the parent tree too.
      buffer: path.resolve(__dirname, 'node_modules/buffer/index.js'),
      'node:buffer': path.resolve(__dirname, 'node_modules/buffer/index.js'),
    },
    // The shared ../src/wallet code would otherwise resolve @midnight-ntwrk
    // packages from the PARENT node_modules — a second physical module
    // instance, so setNetworkId() lands in a different module state than
    // the one midnight-js-contracts reads. Dedupe forces one copy.
    dedupe: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-network-id',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
      '@midnight-ntwrk/midnight-js-http-client-proof-provider',
      '@midnight-ntwrk/midnight-js-fetch-zk-config-provider',
      'rxjs',
    ],
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: {
      '/indexer': {
        target: 'http://localhost:8088',
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/indexer/, ''),
      },
      // Note: not `/node` — that prefix would swallow /node_modules requests.
      '/rpc': {
        target: 'http://localhost:9944',
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/rpc/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/zswap',
      '@midnight-ntwrk/zkir-v2',
    ],
    // CJS dependencies of the excluded (WASM) packages still need the
    // ESM-interop pre-bundle.
    include: ['object-inspect'],
  },
  build: {
    target: 'esnext',
  },
});
