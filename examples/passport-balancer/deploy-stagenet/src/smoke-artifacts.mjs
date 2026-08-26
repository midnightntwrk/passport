/**
 * Does each 0.33.0-rc.2 build actually load against the ledger-9 runtime?
 *
 * The generated module's first statement is
 * `checkRuntimeVersion('0.18.0-rc.1')`, so importing it at all is the version
 * assertion. Everything after that answers the harder question: can the runtime
 * build an initial state from the constructor arguments a deploy would pass,
 * without a chain, a wallet, or a proof server anywhere in sight.
 *
 *   node src/smoke-artifacts.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/*
 * `constructorContext` (0.16) is `createConstructorContext` in 0.18.0-rc.1 —
 * one of the renames a ledger-8 caller trips over first.
 */
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';

const BUILDS = '../../contracts-stagenet/managed';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const zeros = () => new Uint8Array(32);

/** The Midnames key encoding: UTF-8 left-aligned in 32 bytes, 0xff padding. */
function domainKey(name) {
  const bytes = new TextEncoder().encode(name);
  const key = new Uint8Array(32).fill(255);
  key.set(bytes);
  return key;
}

const maybeBytes = (value) =>
  value ? { is_some: true, value } : { is_some: false, value: zeros() };
const maybeString = (value) => (value ? { is_some: true, value } : { is_some: false, value: '' });
const emptyKvs = () =>
  Array.from({ length: 10 }, () => ({ is_some: false, value: ['', ''] }));

let failures = 0;

function report(name, detail) {
  console.log(`  ${name.padEnd(26)} ${detail}`);
}

async function loadModule(build) {
  const url = new URL(`${BUILDS}/${build}/contract/index.js`, import.meta.url);
  return import(url.href);
}

function buildInfo(build) {
  const url = new URL(`${BUILDS}/${build}/compiler/contract-info.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * Runs a constructor exactly the way `deployContract` does: a fresh empty
 * state, an all-zero caller context, and the circuit's own initial-state
 * routine. A build whose arguments do not typecheck fails here, on this
 * machine, instead of on chain after a fee has been paid.
 */
async function runConstructor(module, witnesses, privateState, args, label) {
  const contract = new module.Contract(witnesses);
  /* `initialState` is async in the 0.33 output — it was synchronous before. */
  const initial = await contract.initialState(
    createConstructorContext(privateState, hex(zeros())),
    ...args,
  );
  const state = initial.currentContractState;
  const ledgerView = module.ledger(state.data);
  report(label, 'initialState OK');
  return { contract, state, ledgerView };
}

const runtimePkg = JSON.parse(
  readFileSync(new URL('../node_modules/@midnight-ntwrk/compact-runtime/package.json', import.meta.url), 'utf8'),
);
console.log(`compact-runtime ${runtimePkg.version}`);

for (const build of ['faucet', 'account', 'midnames']) {
  const info = buildInfo(build);
  console.log(`\n=== ${build} ===`);
  report('compiler', `${info['compiler-version']} (language ${info['language-version']})`);
  report('runtime declared', info['runtime-version']);
  report('circuits', (info.circuits ?? []).map((c) => c.name).join(', ') || '(none)');

  try {
    const module = await loadModule(build);
    report('module import', `OK — checkRuntimeVersion('${info['runtime-version']}') passed`);
    report('exports', Object.keys(module).join(', '));

    if (build === 'faucet') {
      /* No constructor arguments and no witnesses: the mint contract's entire
         state is the empty ledger. */
      await runConstructor(module, {}, {}, [], 'faucet initial state');
    }

    if (build === 'account') {
      /* Throwaway secrets: this state never leaves the process. */
      const derive = (label) =>
        new Uint8Array(createHash('sha256').update(`passport-smoke-account:${label}`).digest());
      const device = derive('device');
      const recovery = derive('recovery');
      const witnesses = {
        device_secret: ({ privateState }) => [privateState, device],
        grant_secret: ({ privateState }) => [privateState, derive('grant')],
        recovery_secret: ({ privateState }) => [privateState, recovery],
      };
      report('pure circuits', Object.keys(module.pureCircuits).join(', '));
      const { ledgerView } = await runConstructor(
        module,
        witnesses,
        { deviceSecret: hex(device) },
        [
          module.pureCircuits.derive_device_commitment(device),
          module.pureCircuits.derive_recovery_commitment(recovery),
          derive('share1'),
          derive('share2'),
          derive('share3'),
        ],
        'account initial state',
      );
      report(
        'decoded',
        `round=${ledgerView.round} device_epoch=${ledgerView.device_epoch} ` +
          `device_count=${ledgerView.device_count} recovery_shares=${ledgerView.recovery_shares.size()}`,
      );
    }

    if (build === 'midnames') {
      const secret = new Uint8Array(createHash('sha256').update('passport-smoke-midnames').digest());
      const witnesses = { secretKey: ({ privateState }) => [privateState, secret] };
      const { ledgerView } = await runConstructor(
        module,
        witnesses,
        { secretKey: hex(secret) },
        [
          maybeBytes(undefined),
          { bytes: zeros() },
          [zeros(), module.AddressType.UnshieldedAddr],
          maybeBytes(domainKey('night')),
          zeros(),
          600n,
          140n,
          10n,
          maybeString(),
          true,
          new Uint8Array(createHash('sha256').update('owner').digest()),
          { bytes: zeros() },
          emptyKvs(),
        ],
        'midnames TLD state',
      );
      report(
        'decoded',
        `DOMAIN="${Buffer.from(ledgerView.DOMAIN.value).toString('utf8').replace(/�|\xff/g, '')}" ` +
          `COST ${ledgerView.COST_SHORT}/${ledgerView.COST_MED}/${ledgerView.COST_LONG} ` +
          `BUY_ENABLED=${ledgerView.BUY_ENABLED} domains=${ledgerView.domains.size()}`,
      );
    }
  } catch (cause) {
    failures += 1;
    report('FAILED', cause?.message ?? String(cause));
    if (process.env.SMOKE_VERBOSE) console.error(cause);
  }
}

console.log(`\n${failures === 0 ? 'ALL BUILDS LOAD' : `${failures} BUILD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
