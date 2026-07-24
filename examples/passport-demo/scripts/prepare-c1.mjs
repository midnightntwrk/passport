import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptsDir, '..');
const workspaceRoot = resolve(appDir, '..', '..');
const custodyRoot = resolve(
  workspaceRoot,
  'experiments',
  'account-custody-prototype',
);

const targets = [
  {
    label: 'Passport C1',
    source: resolve(appDir, 'contracts', 'passport_c1.compact'),
    generated: resolve(appDir, '.generated', 'passport-c1'),
    publicAssets: resolve(appDir, 'public', 'zk', 'passport-c1'),
  },
  ...['account', 'faucet', 'identity_registry'].map((name) => ({
    label: `Local ${name}`,
    source: resolve(custodyRoot, 'contracts', `${name}.compact`),
    generated: resolve(custodyRoot, 'contracts', 'managed', name),
    publicAssets: resolve(appDir, 'public', 'zk', name),
  })),
];

function outputIsCurrent({ source, generated, publicAssets }) {
  const generatedContract = resolve(generated, 'contract', 'index.js');
  const publicContractInfo = resolve(publicAssets, 'compiler', 'contract-info.json');
  return (
    process.env.FORCE_C1_COMPILE !== '1' &&
    existsSync(generatedContract) &&
    existsSync(publicContractInfo) &&
    statSync(generatedContract).mtimeMs >= statSync(source).mtimeMs &&
    statSync(publicContractInfo).mtimeMs >= statSync(source).mtimeMs
  );
}

function replaceDirectory(nextDirectory, destination) {
  const previousDirectory = `${destination}.previous-${process.pid}`;
  rmSync(previousDirectory, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, previousDirectory);
  renameSync(nextDirectory, destination);
  rmSync(previousDirectory, { recursive: true, force: true });
}

function prepareTarget(target) {
  if (!existsSync(target.source)) {
    throw new Error(`${target.label} source was not found: ${target.source}`);
  }
  if (outputIsCurrent(target)) {
    console.log(`${target.label} artifacts are current.`);
    return;
  }

  const generatedNext = `${target.generated}.next-${process.pid}`;
  const publicNext = `${target.publicAssets}.next-${process.pid}`;
  rmSync(generatedNext, { recursive: true, force: true });
  rmSync(publicNext, { recursive: true, force: true });
  mkdirSync(dirname(generatedNext), { recursive: true });
  execFileSync('compact', ['compile', target.source, generatedNext], {
    stdio: 'inherit',
  });
  mkdirSync(dirname(publicNext), { recursive: true });
  cpSync(generatedNext, publicNext, {
    recursive: true,
    filter: (entry) => !entry.endsWith('/contract') && !entry.includes('/contract/'),
  });
  replaceDirectory(generatedNext, target.generated);
  replaceDirectory(publicNext, target.publicAssets);
}

for (const target of targets) prepareTarget(target);
