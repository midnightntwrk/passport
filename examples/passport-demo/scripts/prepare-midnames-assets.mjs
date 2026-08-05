/**
 * Stages the Midnames leaf contract's ZK assets for the Passport demo.
 *
 * WHERE THE ARTEFACTS COME FROM
 * -----------------------------
 * They are built by the account-custody prototype, from the pinned Midnames
 * revision 83f8422b0b39113d5c14aa8adc3d42804edaf492 with compact 0.31.1:
 *
 *   cd experiments/account-custody-prototype && npm run midnames:prepare
 *
 * That writes `contracts/managed/midnames/{compiler,contract,keys,zkir}`. This
 * script never compiles anything itself — one build of the Midnames contract in
 * this repository, not two that can drift.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * 1. Verifies those artefacts exist, and fails with the command to run if not.
 * 2. Copies `compiler`, `keys`, and `zkir` into `public/zk/midnames`, which is
 *    what a production `vite build` ships. In DEV this copy is not needed —
 *    `vite.config.ts` already serves `/zk/**` straight from the prototype's
 *    managed directory — so the copy is skipped when it is already current.
 *
 * The generated contract MODULE (`contract/index.js`) is deliberately NOT
 * copied: `src/identity/midnames.ts` imports it from the prototype directly,
 * exactly as `src/localC1.ts` imports the account contract.
 *
 * `public/zk/` is gitignored; nothing here is ever committed.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptsDirectory, '..');
const workspaceRoot = resolve(appDirectory, '..', '..');
const managedMidnames = resolve(
  workspaceRoot,
  'experiments',
  'account-custody-prototype',
  'contracts',
  'managed',
  'midnames',
);
const publicAssets = resolve(appDirectory, 'public', 'zk', 'midnames');
const stagedSubdirectories = ['compiler', 'keys', 'zkir'];

function fail(message) {
  console.error(`prepare-midnames-assets: ${message}`);
  process.exit(1);
}

if (!existsSync(resolve(managedMidnames, 'contract', 'index.js'))) {
  fail(
    'the Midnames leaf contract has not been built.\n' +
      '  Run this first, from the repository root:\n' +
      '    cd experiments/account-custody-prototype && npm run midnames:prepare\n' +
      `  Expected artefacts under ${managedMidnames}`,
  );
}

for (const name of stagedSubdirectories) {
  if (!existsSync(resolve(managedMidnames, name))) {
    fail(`the built Midnames artefacts are incomplete — ${name}/ is missing.`);
  }
}

function newestMtime(directory) {
  return statSync(directory).mtimeMs;
}

function stagedIsCurrent() {
  if (process.env.FORCE_MIDNAMES_STAGE === '1') return false;
  const verifier = resolve(publicAssets, 'keys', 'register_domain_for.verifier');
  const contractInfo = resolve(publicAssets, 'compiler', 'contract-info.json');
  if (!existsSync(verifier) || !existsSync(contractInfo)) return false;
  const staged = Math.min(newestMtime(verifier), newestMtime(contractInfo));
  const source = Math.max(
    ...stagedSubdirectories.map((name) => newestMtime(resolve(managedMidnames, name))),
  );
  return staged >= source;
}

if (stagedIsCurrent()) {
  console.log('Midnames ZK assets are current.');
  process.exit(0);
}

const next = `${publicAssets}.next-${process.pid}`;
rmSync(next, { recursive: true, force: true });
mkdirSync(next, { recursive: true });
for (const name of stagedSubdirectories) {
  cpSync(resolve(managedMidnames, name), resolve(next, name), { recursive: true });
}

const previous = `${publicAssets}.previous-${process.pid}`;
rmSync(previous, { recursive: true, force: true });
mkdirSync(dirname(publicAssets), { recursive: true });
if (existsSync(publicAssets)) renameSync(publicAssets, previous);
renameSync(next, publicAssets);
rmSync(previous, { recursive: true, force: true });

console.log(`Staged Midnames ZK assets into ${publicAssets}`);
