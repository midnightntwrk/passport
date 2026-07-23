import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIDNAMES_REPOSITORY = 'https://github.com/midnames/sdk.git';
const MIDNAMES_REVISION = '83f8422b0b39113d5c14aa8adc3d42804edaf492';
const COMPACT_VERSION = '0.31.1';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = resolve(projectRoot, '.cache');
const checkout = resolve(cacheRoot, 'midnames-sdk-preview');
const stampPath = resolve(checkout, '.passport-build.json');
const contractEntry = resolve(checkout, 'packages/contract/dist/index.js');
const sdkEntry = resolve(checkout, 'packages/sdk/dist/index.js');
const builtManagedContract = resolve(
  checkout,
  'packages',
  'contract',
  'dist',
  'managed',
  'leaf',
);
const publishedManagedContract = resolve(projectRoot, 'contracts', 'managed', 'midnames');
const force = process.argv.includes('--force');

function run(command, args, cwd = projectRoot, stdio = 'inherit') {
  return execFileSync(command, args, { cwd, stdio, encoding: 'utf8' });
}

function readStamp() {
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureCheckout() {
  mkdirSync(cacheRoot, { recursive: true });
  if (!existsSync(resolve(checkout, '.git'))) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', MIDNAMES_REPOSITORY, checkout]);
  }

  run('git', ['remote', 'set-url', 'origin', MIDNAMES_REPOSITORY], checkout, 'ignore');
  try {
    run('git', ['cat-file', '-e', `${MIDNAMES_REVISION}^{commit}`], checkout, 'ignore');
  } catch {
    run('git', ['fetch', '--depth=1', 'origin', MIDNAMES_REVISION], checkout);
  }

  const current = run('git', ['rev-parse', 'HEAD'], checkout, 'pipe').trim();
  if (current !== MIDNAMES_REVISION) {
    run('git', ['checkout', '--detach', MIDNAMES_REVISION], checkout);
  }
}

function ensureCompactCompiler() {
  try {
    run('compact', ['compile', `+${COMPACT_VERSION}`, '--version'], projectRoot, 'ignore');
  } catch {
    run('compact', ['update', COMPACT_VERSION]);
  }
}

function publishManagedContract() {
  if (!existsSync(resolve(builtManagedContract, 'contract', 'index.js'))) {
    throw new Error('Midnames generated contract is missing after the Preview build.');
  }
  rmSync(publishedManagedContract, { recursive: true, force: true });
  mkdirSync(dirname(publishedManagedContract), { recursive: true });
  cpSync(builtManagedContract, publishedManagedContract, { recursive: true });
}

ensureCheckout();

const stamp = readStamp();
if (
  !force &&
  stamp?.revision === MIDNAMES_REVISION &&
  stamp?.compactVersion === COMPACT_VERSION &&
  existsSync(contractEntry) &&
  existsSync(sdkEntry)
) {
  publishManagedContract();
  console.log(`Midnames preview ${MIDNAMES_REVISION.slice(0, 12)} is ready.`);
  process.exit(0);
}

ensureCompactCompiler();
run('bun', ['install', '--frozen-lockfile'], checkout);
run('bun', ['run', '--filter', '@midnames/ns', 'compact'], checkout);
run('bun', ['run', '--filter', '@midnames/ns', 'build'], checkout);
run('bun', ['run', '--filter', '@midnames/sdk', 'build'], checkout);
publishManagedContract();

writeFileSync(
  stampPath,
  `${JSON.stringify(
    {
      repository: MIDNAMES_REPOSITORY,
      revision: MIDNAMES_REVISION,
      compactVersion: COMPACT_VERSION,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Midnames preview ${MIDNAMES_REVISION.slice(0, 12)} built successfully.`);
