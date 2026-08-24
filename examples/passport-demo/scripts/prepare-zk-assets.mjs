/**
 * Stages the ZK artefacts the PWA fetches at run time, for the ledger-9 stack.
 *
 * WHERE THEY COME FROM
 * --------------------
 * `examples/passport-balancer/contracts-stagenet/managed/<contract>` — the
 * ONE build of the Passport contracts that matches what is deployed on
 * stagenet. Compiled with compactc 0.33.0-rc.2 (language 0.25.0, runtime
 * 0.18.0-rc.1) on 2026/08/24, the same artefacts the deployment harness used,
 * so a verifier key the PWA ships is byte-identical to the one the deployed
 * contract carries. Nothing here compiles anything: two builds of the same
 * contract in one repository is exactly how a `findDeployedContract` mismatch
 * gets introduced.
 *
 * This replaces the pair of ledger-8 scripts (`prepare-c1.mjs`, which invoked
 * whatever `compact` happened to be on PATH, and `prepare-midnames-assets.mjs`,
 * which read the account-custody prototype's own managed output). Both produced
 * a 0.31.1 / runtime-0.16 build, which the ledger-9 runtime does not load.
 *
 * WHAT IS COPIED, AND WHY ALL OF IT
 * ---------------------------------
 * `compiler/`, `keys/`, and `zkir/`.
 *
 * `compiler/` is not optional any more. midnight-js 5 verifies every artefact
 * it fetches against `compiler/contract-manifest.json` and its integrity mode
 * defaults to `require` — fail-closed. A staged tree without the manifest makes
 * every prove attempt throw `ZkArtifactIntegrityError` rather than fall back to
 * an unverified fetch. `contract-info.json` rides along in the same directory.
 *
 * The generated contract MODULE (`contract/index.js`, plus its `.d.ts`) does not
 * go into `public/` — the app imports it through the bundler. It is copied into
 * `contracts/stagenet/<contract>/` INSIDE this workspace instead, and that
 * location is load-bearing rather than tidy. The module's first two lines are
 *
 *     import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
 *     __compactRuntime.checkRuntimeVersion('0.18.0-rc.1');
 *
 * and a bundler resolves that specifier from the MODULE's own directory,
 * walking upwards. Left where it was built — under
 * `examples/passport-balancer/` — it would walk past this workspace into the
 * repository root, where the runtime is deliberately the LEDGER-8 0.16.0 that
 * the funder and the account-custody prototype need (see the root
 * `package.json`), and `checkRuntimeVersion` would refuse it. Copied here it
 * walks into `examples/passport-demo/node_modules`, finds 0.18.0-rc.1, and
 * loads. The same trap, from the other direction, is documented in
 * `examples/passport-funder/src/midnames.ts`.
 *
 * `public/zk/` and `contracts/stagenet/` are both gitignored; nothing this
 * writes is ever committed.
 *
 *   PASSPORT_STAGENET_CONTRACTS  overrides the source `managed` directory.
 *   FORCE_ZK_STAGE=1             re-copies even when the staged tree is current.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptsDirectory, '..');
const workspaceRoot = resolve(appDirectory, '..', '..');

const managedRoot =
  process.env.PASSPORT_STAGENET_CONTRACTS?.trim() ||
  resolve(workspaceRoot, 'examples', 'passport-balancer', 'contracts-stagenet', 'managed');

/** The contracts the PWA proves circuits for. The mUSD faucet has no caller here. */
const CONTRACTS = ['account', 'midnames'];
const STAGED_SUBDIRECTORIES = ['compiler', 'keys', 'zkir'];

function fail(message) {
  console.error(`prepare-zk-assets: ${message}`);
  process.exit(1);
}

function newestMtime(path) {
  return statSync(path).mtimeMs;
}

/** A staged tree is current when its manifest is no older than every source directory. */
function stagedIsCurrent(source, destination) {
  if (process.env.FORCE_ZK_STAGE === '1') return false;
  const manifest = resolve(destination, 'compiler', 'contract-manifest.json');
  if (!existsSync(manifest)) return false;
  const staged = newestMtime(manifest);
  const newestSource = Math.max(
    ...STAGED_SUBDIRECTORIES.map((name) => newestMtime(resolve(source, name))),
  );
  return staged >= newestSource;
}

/** Copies one directory into place atomically, replacing whatever was there. */
function replaceDirectory(next, destination) {
  const previous = `${destination}.previous-${process.pid}`;
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) renameSync(destination, previous);
  renameSync(next, destination);
  rmSync(previous, { recursive: true, force: true });
}

function stage(name) {
  const source = resolve(managedRoot, name);
  const destination = resolve(appDirectory, 'public', 'zk', name);
  const moduleDestination = resolve(appDirectory, 'contracts', 'stagenet', name);

  if (!existsSync(resolve(source, 'contract', 'index.js'))) {
    fail(
      `the stagenet build of the ${name} contract was not found.\n` +
        `  Expected artefacts under ${source}\n` +
        '  These are produced by the stagenet deployment harness\n' +
        '  (examples/passport-balancer/contracts-stagenet); point\n' +
        '  PASSPORT_STAGENET_CONTRACTS at them if they live elsewhere.',
    );
  }
  for (const subdirectory of STAGED_SUBDIRECTORIES) {
    if (!existsSync(resolve(source, subdirectory))) {
      fail(`the ${name} build is incomplete — ${subdirectory}/ is missing.`);
    }
  }
  if (!existsSync(resolve(source, 'compiler', 'contract-manifest.json'))) {
    fail(
      `the ${name} build carries no compiler/contract-manifest.json.\n` +
        '  midnight-js 5 verifies fetched artefacts against it and fails closed\n' +
        '  without it, so staging a tree that lacks one would ship a PWA that\n' +
        '  cannot prove a single circuit.',
    );
  }

  if (
    stagedIsCurrent(source, destination) &&
    existsSync(resolve(moduleDestination, 'index.js')) &&
    existsSync(resolve(moduleDestination, 'index.d.ts'))
  ) {
    console.log(`${name} ZK assets are current.`);
    return;
  }

  const next = `${destination}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  for (const subdirectory of STAGED_SUBDIRECTORIES) {
    cpSync(resolve(source, subdirectory), resolve(next, subdirectory), { recursive: true });
  }
  replaceDirectory(next, destination);

  const moduleNext = `${moduleDestination}.next-${process.pid}`;
  rmSync(moduleNext, { recursive: true, force: true });
  mkdirSync(moduleNext, { recursive: true });
  for (const file of ['index.js', 'index.d.ts']) {
    cpSync(resolve(source, 'contract', file), resolve(moduleNext, file));
  }
  replaceDirectory(moduleNext, moduleDestination);

  console.log(`Staged ${name} ZK assets into ${destination}`);
  console.log(`Staged the ${name} contract module into ${moduleDestination}`);
}

for (const name of CONTRACTS) stage(name);

/**
 * The in-tab prover's own key material is a SEPARATE, much larger tree, and
 * since the move to stagenet it is on the default path rather than behind
 * `?prover=browser`: stagenet publishes no proof server, so with
 * VITE_MIDNIGHT_PROVING_URL unset every circuit is proved in this tab.
 *
 * It is not fetched here. 45 MB measured on 2026/08/24 (the eight KZG SRS
 * slices k=9..16 plus the four system circuits), which is a download a build
 * naming a proof server has no use for at all — so making `dev` and `build`
 * pull it would be wrong for one deployment and slow for the other. But its
 * absence used to be a niche opt-in problem and is now the difference between
 * an app that can prove and one that cannot, so it is said loudly here rather
 * than discovered at the first transaction.
 *
 * Not a failure, for the same reason: a proof-server build is legitimate, and
 * this script cannot see the environment the app will run with.
 */
if (!existsSync(resolve(appDirectory, 'public', 'zk-params', 'dust', '9', 'spend.prover'))) {
  console.warn('');
  console.warn('prepare-zk-assets: public/zk-params is not staged.');
  console.warn('  Stagenet publishes no proof server, so with VITE_MIDNIGHT_PROVING_URL');
  console.warn('  unset this app proves every circuit in the browser — and the in-tab');
  console.warn('  prover reads its key material from there. Without it the first');
  console.warn('  transaction fails with an explicit "missing …" error rather than');
  console.warn('  anything subtle, but it does fail.');
  console.warn('');
  console.warn('  Stage it once:   node scripts/fetch-zk-params.mjs');
  console.warn('  Or name a server: VITE_MIDNIGHT_PROVING_URL=http://127.0.0.1:6300');
  console.warn('    (docker run -p 6300:6300 midnightntwrk/proof-server:9.0.0-rc.6)');
  console.warn('');
}
