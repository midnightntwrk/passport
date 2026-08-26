import { createHash } from 'node:crypto';
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

/** The literal `public/sw.js` ships with, and the build replaces. */
const BUILD_ID_PLACEHOLDER = '__BUILD_ID__';

/**
 * Gives the service worker an identity that changes with the client build.
 *
 * A browser decides a service worker has been updated by comparing the script
 * BYTE FOR BYTE against the copy it holds. `public/sw.js` used to carry a
 * hand-bumped `CACHE_VERSION` literal, so every deploy between two bumps
 * shipped an identical worker and no update was detected at all — the incident
 * this plugin exists to prevent is written up in `public/sw.js`'s own header.
 *
 * The id is a digest of the emitted asset FILENAMES (which are themselves
 * content hashes) plus both built HTML shells. That makes it change when, and
 * only when, the client the worker has to serve changes — so a rebuild with no
 * source change stamps the same id and installs no needless worker.
 *
 * It runs in `closeBundle`: Vite copies `public/` into `dist/` while preparing
 * the output directory, well before the bundle is written, so `dist/sw.js` is
 * already there and this is a rewrite of it rather than a race with the copy.
 */
function stampServiceWorkerBuildId(): Plugin {
  return {
    name: 'stamp-service-worker-build-id',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        const outDir = path.resolve(__dirname, 'dist');
        const workerPath = path.join(outDir, 'sw.js');
        const source = fs.readFileSync(workerPath, 'utf8');
        if (!source.includes(BUILD_ID_PLACEHOLDER)) {
          throw new Error(
            `stamp-service-worker-build-id: ${BUILD_ID_PLACEHOLDER} is not in public/sw.js. ` +
              'Without it the worker is byte-identical across deploys and installed ' +
              'clients never see an update. See the header of public/sw.js.',
          );
        }
        const digest = createHash('sha256');
        for (const name of fs.readdirSync(path.join(outDir, 'assets')).sort()) {
          digest.update(`${name}\n`);
        }
        digest.update(fs.readFileSync(path.join(outDir, 'index.html')));
        digest.update(fs.readFileSync(path.join(outDir, 'verify', 'index.html')));
        const buildId = digest.digest('hex').slice(0, 16);
        fs.writeFileSync(workerPath, source.replaceAll(BUILD_ID_PLACEHOLDER, buildId));
        this.info(`service worker stamped with build id ${buildId}`);
      },
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
  plugins: [react(), wasm(), serveLocalCustodyAssets(), stampServiceWorkerBuildId()],
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
    rollupOptions: {
      /* TWO entry points, and the second one is not part of the product.
         `verify/index.html` is the step verifier — a read-only operator page
         that walks one Passport account's onboarding against the stagenet
         indexer, for review calls. Stagenet publishes no block explorer, so it
         is the only way to check a step against the chain.

         It is a Vite input rather than a file under `public/` for one reason:
         reading a `.night` name back to an account contract means decoding the
         registry's ledger, which needs the compiled Midnames contract and
         `@midnight-ntwrk/compact-runtime`, and nothing served straight out of
         `public/` can import from `node_modules`. Naming it `verify/index.html`
         rather than `verify.html` keeps the built path at
         `dist/verify/index.html`, so the URL stays `/verify/`.

         Nothing in the app links to it, and `public/sw.js` deliberately does
         not cache it. */
      input: {
        main: path.resolve(__dirname, 'index.html'),
        verify: path.resolve(__dirname, 'verify', 'index.html'),
      },
    },
  },
});
