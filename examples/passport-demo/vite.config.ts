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
  plugins: [react(), wasm(), topLevelAwait(), serveLocalCustodyAssets()],
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
