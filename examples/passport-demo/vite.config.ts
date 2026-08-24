import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceBuffer = path.resolve(__dirname, '..', '..', 'node_modules', 'buffer', 'index.js');
const custodyRoot = path.resolve(__dirname, '..', '..', 'experiments', 'account-custody-prototype');
/**
 * Where `/zk/**` is served from in DEV.
 *
 * `public/zk` is already staged by `scripts/prepare-zk-assets.mjs` and Vite
 * serves it for free, so this middleware exists only to let a developer point
 * the dev server straight at a freshly built contract tree without re-staging:
 * set PASSPORT_STAGENET_CONTRACTS and every `/zk/<contract>/…` request is read
 * from there instead. Unset, it resolves to the same stagenet build the
 * staging script copies from, so dev and a production build serve identical
 * bytes.
 */
const stagenetManagedDir =
  process.env.PASSPORT_STAGENET_CONTRACTS?.trim() ||
  path.resolve(__dirname, '..', 'passport-balancer', 'contracts-stagenet', 'managed');

function serveLocalCustodyAssets(): Plugin {
  return {
    name: 'serve-local-passport-custody-assets',
    configureServer(server) {
      server.middlewares.use('/zk', (request, response, next) => {
        const relativePath = decodeURIComponent((request.url ?? '').split('?')[0])
          .replace(/^\/+/, '');
        const filePath = path.resolve(stagenetManagedDir, relativePath);
        if (
          filePath !== stagenetManagedDir &&
          !filePath.startsWith(`${stagenetManagedDir}${path.sep}`)
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
    /* One module record per package, whatever the import path.
       This is not tidiness. Two copies of `compact-runtime` are two
       `ChargedState` classes and a decode that fails `instanceof` on correct
       objects; two copies of the ledger are two WASM instances and every
       transaction that crosses between them is rejected. The repository root
       still carries the LEDGER-8 stack for `examples/passport-funder`, so the
       ledger-9 names below are the ones that must collapse onto this
       workspace's copies. */
    dedupe: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-network-id',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/wallet-sdk',
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
    // WASM-carrying packages: pre-bundling them rewrites the `new URL(…,
    // import.meta.url)` their loaders use to find their `.wasm`, and the
    // module then fails to instantiate.
    exclude: [
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/zkir-v2',
    ],
    // Compact's browser runtime imports this CommonJS dependency through an
    // ESM default import, so it must be explicitly pre-bundled in dev mode.
    include: ['object-inspect'],
  },
  // `topLevelAwait()` is now absent from the WORKER graph too, and for a
  // second, unrelated reason to the one recorded above for the main graph.
  //
  // Its build transform runs the chunk through SWC, and on the ledger-9 proof
  // worker that throws `missing field \`type\`` inside `Compiler.printSync` —
  // the plugin's pinned SWC cannot re-print the syntax the worker's module
  // graph now contains. The plugin was never needed here: it only exists to
  // serve browsers without native top-level await, `build.target` below is
  // `esnext`, and any browser that can instantiate a 9 MB ledger WASM module
  // in a module worker has had top-level await for years.
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    target: 'esnext',
  },
});
