import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceBuffer = path.resolve(__dirname, '..', '..', 'node_modules', 'buffer', 'index.js');
const custodyRoot = path.resolve(__dirname, '..', '..', 'experiments', 'account-custody-prototype');
const custodyManagedDir = path.resolve(custodyRoot, 'contracts', 'managed');

function serveLocalCustodyAssets(): Plugin {
  return {
    name: 'serve-local-passport-custody-assets',
    configureServer(server) {
      server.middlewares.use('/zk', (request, response, next) => {
        const relativePath = decodeURIComponent((request.url ?? '').split('?')[0])
          .replace(/^\/+/, '');
        const filePath = path.resolve(custodyManagedDir, relativePath);
        if (
          filePath !== custodyManagedDir &&
          !filePath.startsWith(`${custodyManagedDir}${path.sep}`)
        ) {
          return next();
        }
        fs.stat(filePath, (error, stats) => {
          if (error || !stats.isFile()) return next();
          response.setHeader('Content-Type', 'application/octet-stream');
          fs.createReadStream(filePath).pipe(response);
        });
      });
    },
  };
}

function deploymentAddress(fileName: string, field: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(path.resolve(custodyRoot, fileName), 'utf8'));
    return typeof value[field] === 'string' ? value[field] : '';
  } catch {
    return '';
  }
}

export default defineConfig({
  // `topLevelAwait()` is deliberately absent from the MAIN graph — see
  // 2026/08/05, found while deploying to Vercel. Its build transform hoists
  // every exported top-level binding of a chunk into a bare `let a, b, c;`
  // list and rewrites the definitions as assignments, so
  //
  //     export class UnshieldedAddress {
  //       static codec = new Bech32mCodec('addr', …);
  //       static [Bech32mSymbol] = UnshieldedAddress.codec;   // inner binding
  //     }
  //
  // in @midnight-ntwrk/wallet-sdk-address-format becomes
  //
  //     UnshieldedAddress = class { static [Bech32mSymbol] = UnshieldedAddress.codec; … }
  //
  // — an ANONYMOUS class expression. The self-reference no longer resolves to
  // the class's own inner name (which is live during static initialisation)
  // but to the outer `let`, which is still undefined at that point. Every
  // production build therefore died on load with
  // `TypeError: Cannot read properties of undefined (reading 'codec')`
  // before React could mount. It never showed in `npm run dev`, which does
  // not run the transform.
  //
  // The plugin is only needed for browsers without native top-level await.
  // `build.target` below is `esnext`, and every browser that can run this
  // demo's WASM has had TLA for years, so dropping it costs nothing. It is
  // kept for `worker.plugins`, a separate and much smaller module graph that
  // does not contain the affected package.
  plugins: [react(), wasm(), serveLocalCustodyAssets()],
  define: {
    __FAUCET_ADDRESS__: JSON.stringify(deploymentAddress('faucet-deployment.json', 'faucetAddress')),
    __IDENTITY_REGISTRY_ADDRESS__: JSON.stringify(
      deploymentAddress('identity-registry-deployment.json', 'identityRegistryAddress'),
    ),
  },
  resolve: {
    alias: [
      { find: /^node:buffer$/, replacement: workspaceBuffer },
      { find: /^buffer$/, replacement: workspaceBuffer },
      // @subsquid/scale-codec (wallet SDK chain client) calls assert() at
      // runtime; Vite's builtin-externalisation stub is not callable.
      {
        find: /^(node:)?assert$/,
        replacement: path.resolve(__dirname, 'src', 'lib', 'assert-shim.ts'),
      },
      {
        find: 'isomorphic-ws',
        replacement: path.resolve(custodyRoot, 'app', 'src', 'lib', 'ws-shim.ts'),
      },
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
    fs: {
      allow: [path.resolve(__dirname, '..', '..')],
    },
    proxy: {
      '/indexer': {
        target: 'http://localhost:8088',
        changeOrigin: true,
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/indexer/, ''),
      },
      '/rpc': {
        target: 'http://localhost:9944',
        changeOrigin: true,
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/rpc/, ''),
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
    // Compact's browser runtime imports this CommonJS dependency through an
    // ESM default import, so it must be explicitly pre-bundled in dev mode.
    include: ['object-inspect'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: 'esnext',
  },
});
