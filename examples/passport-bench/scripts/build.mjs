/**
 * Bundles the orchestrator and the worker.
 *
 * Two things here are not incidental.
 *
 * `import.meta.env` is DEFINED to `globalThis.__BENCH_ENV__`. Every one of the
 * app modules the bench drives — `localWallet.ts`, `sponsor.ts`, `networks.ts`
 * — reads its configuration from `import.meta.env`, which Vite supplies in a
 * browser and nothing supplies under Node. Rewriting it to a global is what
 * lets a worker be handed a sponsor list and a proving list on the command
 * line while the app's own readers stay untouched. It is the same device the
 * `.live-drill` harnesses use, for the same reason.
 *
 * The bundle is NOT `--packages=external`. The ledger and onchain-runtime wasm
 * has to be inlined for the wallet to open under Node, which is what the drill
 * harnesses do too; making the packages external produces a bundle whose wasm
 * never loads.
 */

import { build } from 'esbuild';
import { mkdir, symlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..', '..');
const OUT = resolve(ROOT, 'dist');

/**
 * The wasm the bundle loads at run time, beside the bundle.
 *
 * esbuild inlines the JS glue but leaves the `.wasm` files to be read from
 * disk relative to the output, so they are linked rather than copied: they are
 * tens of megabytes and they belong to the installed packages, not to us.
 */
const WASM = [
  ['midnight_ledger_wasm_v9_bg.wasm', 'node_modules/@midnightntwrk/ledger-v9/midnight_ledger_wasm_v9_bg.wasm'],
  [
    'midnight_onchain_runtime_wasm_bg.wasm',
    'node_modules/@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.wasm',
  ],
];

async function linkWasm() {
  for (const [name, from] of WASM) {
    const target = resolve(REPO, from);
    try {
      await stat(target);
    } catch {
      console.warn(`[build] ${from} is not installed; skipping the ${name} link`);
      continue;
    }
    try {
      await symlink(target, resolve(OUT, name));
    } catch (cause) {
      if ((cause && cause.code) !== 'EEXIST') throw cause;
    }
  }
}

await mkdir(OUT, { recursive: true });

await build({
  entryPoints: [resolve(ROOT, 'src/bench.ts'), resolve(ROOT, 'src/worker.ts')],
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  define: { 'import.meta.env': 'globalThis.__BENCH_ENV__' },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});

await linkWasm();

console.log(`[build] dist/bench.mjs and dist/worker.mjs`);
