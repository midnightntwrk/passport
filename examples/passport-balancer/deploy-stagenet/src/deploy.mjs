/**
 * Puts the Midnight Passport contracts onto stagenet.
 *
 * Five legs, in one process, spending sequentially from the balancer's wallet:
 *
 *   1. the mUSD faucet/mint contract;
 *   2. one account-custody contract, throwaway secrets, as the smoke test that
 *      ACC deploys work on ledger-9;
 *   3. our `.night` TLD registry instance, with the preview registry's own
 *      cost and behaviour parameters (600/140/10, BUY_ENABLED);
 *   4. a resolver leaf pointing at the account-custody contract from leg 2;
 *   5. `register_domain_for` on the TLD for a throwaway label, paid by the
 *      balancer, then read back through the registry.
 *
 * Everything is recorded to `state/deployments-stagenet.json` as it lands, so a
 * failure half way through never loses the addresses already paid for.
 *
 *   BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env node src/deploy.mjs [leg...]
 *
 * With no arguments it runs every leg. Named legs — `faucet`, `account`, `tld`,
 * `register` — run only those, reusing whatever the state file already holds.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  applyEnvFile,
  bytesToHex,
  contractAddressBytes,
  deriveMidnamesOwnerKey,
  formatNight,
  hexToBytes,
  inMemoryPrivateStateProvider,
  loadConfig,
  nativeColourBytes,
  openWallet,
  rawContractAddress,
  resolveTransactionHash,
  wait,
  walletProviderFrom,
} from './chain.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILDS = join(HERE, '..', '..', 'contracts-stagenet', 'managed');

const MIDNAMES_TLD = 'night';

/* -------------------------------------------------------------------------- */
/* Midnames encodings — byte-identical to the funder's and the PWA's           */
/* -------------------------------------------------------------------------- */

function domainToKey(name) {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(`Domain name must be 1-32 bytes, got ${bytes.length}.`);
  }
  const key = new Uint8Array(32).fill(255);
  key.set(bytes);
  return { key, len: BigInt(bytes.length) };
}

const maybeBytes = (value) =>
  value ? { is_some: true, value } : { is_some: false, value: new Uint8Array(32) };
const maybeString = (value) => (value ? { is_some: true, value } : { is_some: false, value: '' });
const emptyKvs = () => Array.from({ length: 10 }, () => ({ is_some: false, value: ['', ''] }));

/** What a leaf's `DOMAIN_TARGET` points at, decoded — the funder's own reader. */
function decodeDomainTarget(target) {
  if (target.is_left) return { kind: 'contract', hex: bytesToHex(target.left.bytes) };
  if (target.right.is_left) return { kind: 'shielded', hex: bytesToHex(target.right.left.bytes) };
  return { kind: 'wallet', hex: bytesToHex(target.right.right.bytes) };
}

/* -------------------------------------------------------------------------- */
/* Record keeping                                                             */
/* -------------------------------------------------------------------------- */

const elapsed = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

async function loadRecord(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { network: 'stagenet', startedAt: new Date().toISOString(), legs: {} };
  }
}

async function saveRecord(path, record) {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  applyEnvFile();
  const config = loadConfig();
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const legs = requested.length > 0 ? new Set(requested) : new Set(['faucet', 'account', 'tld', 'register']);

  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(`prover    ${config.proofServerUrl} (contract circuits)`);
  console.log(`wallet    ${config.walletProverUrl ?? 'in-process WASM prover'} (fee legs)`);
  console.log(`legs      ${[...legs].join(', ')}\n`);

  await mkdir(config.stateDir, { recursive: true });
  const recordPath = join(config.stateDir, 'deployments-stagenet.json');
  const record = await loadRecord(recordPath);
  record.stack = {
    compiler: '0.33.0-rc.2',
    compactRuntime: '0.18.0-rc.1',
    compactJs: '2.5.5-rc.7',
    midnightJs: '5.0.0-beta.6',
    walletSdk: '2.0.0-beta.2',
    ledger: '@midnightntwrk/ledger-v9 1.0.0-rc.3',
    proofServer: '9.0.0-rc.6 (local)',
  };

  /* ---------------------------------------------------------------------- */
  /* Wallet                                                                  */
  /* ---------------------------------------------------------------------- */

  const openedAt = Date.now();
  const wallet = await openWallet(config);
  console.log(`address   ${wallet.address}`);
  console.log(`opened in ${elapsed(openedAt)}`);

  const syncStartedAt = Date.now();
  await wallet.waitForSync((state) => {
    console.log(
      `[sync ${elapsed(syncStartedAt).padStart(8)}] shielded ${state.shielded.progress.appliedIndex}/${state.shielded.progress.highestRelevantWalletIndex} dust ${state.dust.progress.appliedIndex}/${state.dust.progress.highestRelevantWalletIndex}`,
    );
  });
  console.log(`synced in ${elapsed(syncStartedAt)}`);
  record.sync = { openedInMs: syncStartedAt - openedAt, syncedInMs: Date.now() - syncStartedAt };

  const opening = await wallet.balances();
  console.log(
    `balance   ${formatNight(opening.night)} NIGHT (${opening.night} atomic), ${opening.dust} Specks DUST\n`,
  );
  if (opening.night === 0n) throw new Error('The balancer wallet holds no NIGHT on stagenet.');
  if (opening.dust === 0n) throw new Error('The balancer wallet holds no DUST; fees cannot be paid.');
  record.openingBalance = { nightAtomic: String(opening.night), dustSpecks: String(opening.dust) };

  const walletProvider = walletProviderFrom(wallet, config);
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: config.indexerHttpUrl,
    subscriptionURL: config.indexerWsUrl,
  });

  /** One provider set per contract build; only the ZK artefacts differ. */
  const providersFor = (build, privateStateId, initialPrivateState) => {
    const zkConfigProvider = new NodeZkConfigProvider(join(BUILDS, build));
    return {
      privateStateProvider: inMemoryPrivateStateProvider(
        privateStateId ? { [privateStateId]: initialPrivateState } : {},
      ),
      publicDataProvider,
      zkConfigProvider,
      proofProvider: httpClientProofProvider({
        url: config.proofServerUrl,
        zkConfigProvider,
        timeout: 600_000,
      }),
      walletProvider,
      midnightProvider: walletProvider,
    };
  };

  const load = async (build) => import(join(BUILDS, build, 'contract', 'index.js'));

  /** Records a landed leg: address, identifier, resolved 64-hex hash, block. */
  const remember = async (name, extra) => {
    const resolved = extra.txIdentifier
      ? await resolveTransactionHash(config.indexerHttpUrl, extra.txIdentifier)
      : { hash: null, block: null };
    record.legs[name] = {
      ...extra,
      txHash: resolved.hash,
      block: resolved.block,
      at: new Date().toISOString(),
    };
    await saveRecord(recordPath, record);
    console.log(
      `  → ${name}: ${extra.contractAddress ?? ''} tx ${resolved.hash} ${resolved.block ? `block ${resolved.block}` : ''}\n`,
    );
  };

  const identifierOf = (data) => String(data?.public?.txId ?? data?.public?.transactionHash ?? '');

  try {
    /* -------------------------------------------------------------------- */
    /* 1. The mUSD faucet / mint contract                                    */
    /* -------------------------------------------------------------------- */

    if (legs.has('faucet')) {
      console.log('=== faucet (mUSD mint) ===');
      const startedAt = Date.now();
      const module = await load('faucet');
      const compiled = CompiledContract.make('passport-musd-faucet', module.Contract).pipe(
        /* No witnesses at all: `mint_shielded` takes everything as arguments. */
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(join(BUILDS, 'faucet')),
      );
      const deployed = await deployContract(providersFor('faucet'), { compiledContract: compiled });
      const address = rawContractAddress(deployed.deployTxData.public.contractAddress);
      await remember('faucet', {
        contract: 'faucet.compact (mUSD mint)',
        contractAddress: address,
        txIdentifier: identifierOf(deployed.deployTxData),
        wallClockMs: Date.now() - startedAt,
      });
    }

    /* -------------------------------------------------------------------- */
    /* 2. One account-custody contract — the ACC smoke-test deploy           */
    /* -------------------------------------------------------------------- */

    if (legs.has('account')) {
      console.log('=== account custody (smoke test, throwaway secrets) ===');
      const startedAt = Date.now();
      const module = await load('account');
      /* Throwaway, generated here, never stored anywhere but this process. */
      const deviceSecret = new Uint8Array(randomBytes(32));
      const grantSecret = new Uint8Array(randomBytes(32));
      const recoverySecret = new Uint8Array(randomBytes(32));
      const privateStateId = 'passport-stagenet-account-smoke';
      const initialPrivateState = { deviceSecret: bytesToHex(deviceSecret) };

      const compiled = CompiledContract.make('passport-account-custody', module.Contract).pipe(
        CompiledContract.withWitnesses({
          device_secret: ({ privateState }) => [privateState, deviceSecret],
          grant_secret: ({ privateState }) => [privateState, grantSecret],
          recovery_secret: ({ privateState }) => [privateState, recoverySecret],
        }),
        CompiledContract.withCompiledFileAssets(join(BUILDS, 'account')),
      );

      const deployed = await deployContract(
        providersFor('account', privateStateId, initialPrivateState),
        {
          compiledContract: compiled,
          privateStateId,
          initialPrivateState,
          args: [
            module.pureCircuits.derive_device_commitment(deviceSecret),
            module.pureCircuits.derive_recovery_commitment(recoverySecret),
            new Uint8Array(randomBytes(32)),
            new Uint8Array(randomBytes(32)),
            new Uint8Array(randomBytes(32)),
          ],
        },
      );
      const address = rawContractAddress(deployed.deployTxData.public.contractAddress);
      await remember('account', {
        contract: 'account.compact (custody smoke test)',
        contractAddress: address,
        txIdentifier: identifierOf(deployed.deployTxData),
        wallClockMs: Date.now() - startedAt,
        note: 'Throwaway device/grant/recovery secrets; this instance is a proof that ACC deploys work on ledger-9, not a user account.',
      });
    }

    /* -------------------------------------------------------------------- */
    /* 3. Our `.night` TLD registry instance                                 */
    /* -------------------------------------------------------------------- */

    if (legs.has('tld')) {
      console.log('=== midnames .night TLD (our stagenet instance) ===');
      const startedAt = Date.now();
      const module = await load('midnames');

      /* The TLD owner. Deriving it from the seed rather than randomising means
         a later `update_costs` or `transfer_domain` is still ours to make after
         a restart; the secret never leaves this process. It is deliberately NOT
         the caller secret below, so a registration through this instance takes
         COST exactly as it does on the preview registry. */
      const ownerSecret = new Uint8Array(
        createHash('sha256')
          .update('midnight.passport.stagenet.midnames.tld.owner')
          .update(Buffer.from(config.seedHex, 'hex'))
          .digest(),
      );
      const ownerKey = deriveMidnamesOwnerKey(ownerSecret);

      /* COST is paid to `DOMAIN_OWNER[1]`, a UserAddress — the balancer's own
         unshielded address, so a sponsored registration pays us rather than a
         hole in the ground. */
      const ownerAddressBytes = new Uint8Array(
        MidnightBech32m.parse(wallet.address, UnshieldedAddress).data,
      );

      const compiled = CompiledContract.make('passport-midnames-leaf', module.Contract).pipe(
        CompiledContract.withWitnesses({
          secretKey: ({ privateState }) => [privateState, hexToBytes(privateState.secretKey)],
        }),
        CompiledContract.withCompiledFileAssets(join(BUILDS, 'midnames')),
      );

      const privateStateId = 'passport-stagenet-midnames-tld';
      const initialPrivateState = { secretKey: bytesToHex(ownerSecret) };

      /* Read off the deployed preview registry on 2026/08/24:
           PARENT_DOMAIN   none            PARENT_RESOLVER 32 zero bytes
           DOMAIN          "night"         COST 600 / 140 / 10
           BUY_ENABLED     true            DEFAULT_FIELD   none
         The only fields that differ here are the ones that MUST: the owner key
         and the address COST is paid to. */
      const deployed = await deployContract(
        providersFor('midnames', privateStateId, initialPrivateState),
        {
          compiledContract: compiled,
          privateStateId,
          initialPrivateState,
          args: [
            maybeBytes(undefined),
            { bytes: new Uint8Array(32) },
            [new Uint8Array(32), module.AddressType.UnshieldedAddr],
            maybeBytes(domainToKey(MIDNAMES_TLD).key),
            nativeColourBytes(),
            600n,
            140n,
            10n,
            maybeString(),
            true,
            ownerKey,
            { bytes: ownerAddressBytes },
            emptyKvs(),
          ],
        },
      );
      const address = rawContractAddress(deployed.deployTxData.public.contractAddress);
      await remember('tld', {
        contract: 'midnames.compact (leaf.compact) deployed as the .night TLD',
        contractAddress: address,
        txIdentifier: identifierOf(deployed.deployTxData),
        wallClockMs: Date.now() - startedAt,
        parameters: {
          PARENT_DOMAIN: 'none',
          PARENT_RESOLVER: '00'.repeat(32),
          DOMAIN: 'night',
          COIN_COLOR: bytesToHex(nativeColourBytes()),
          COST_SHORT: '600',
          COST_MED: '140',
          COST_LONG: '10',
          BUY_ENABLED: true,
          DEFAULT_FIELD: 'none',
          DOMAIN_OWNER_pubkey: bytesToHex(ownerKey),
          DOMAIN_OWNER_address: bytesToHex(ownerAddressBytes),
        },
      });
    }

    /* -------------------------------------------------------------------- */
    /* 4 + 5. A real registration on our TLD, and the read-back              */
    /* -------------------------------------------------------------------- */

    if (legs.has('register')) {
      const tldAddress = record.legs.tld?.contractAddress;
      if (!tldAddress) throw new Error('No TLD in the state file — run the `tld` leg first.');
      const targetAddress = record.legs.account?.contractAddress;
      if (!targetAddress) throw new Error('No account contract in the state file — run `account` first.');

      const label = process.env.DEPLOY_LABEL?.trim() || `passport-${randomBytes(3).toString('hex')}`;
      console.log(`=== register ${label}.${MIDNAMES_TLD} on our TLD ===`);
      const module = await load('midnames');

      /* The CALLER's secret, distinct from the TLD owner's: `register_domain_for`
         derives the caller's public key from this witness, sees that it is not
         `DOMAIN_OWNER[0]`, asserts `BUY_ENABLED` and takes COST. That is the
         sponsored path the funder uses on preview, and proving it works is the
         point of this leg. */
      const callerSecret = new Uint8Array(
        createHash('sha256')
          .update('midnight.passport.stagenet.midnames.caller')
          .update(Buffer.from(config.seedHex, 'hex'))
          .digest(),
      );
      /* The name's owner: a throwaway user key, exactly as a sponsored
         registration records a user rather than the payer.
         It is derived from the LABEL rather than randomised so that a re-run
         which reuses an already-deployed resolver leaf registers the name to
         the same owner the leaf was built for. */
      const nameOwnerSecret = new Uint8Array(
        createHash('sha256')
          .update(`midnight.passport.stagenet.midnames.name-owner:${label}`)
          .update(Buffer.from(config.seedHex, 'hex'))
          .digest(),
      );
      const nameOwnerKey = deriveMidnamesOwnerKey(nameOwnerSecret);

      const compiled = CompiledContract.make('passport-midnames-leaf', module.Contract).pipe(
        CompiledContract.withWitnesses({
          secretKey: ({ privateState }) => [privateState, hexToBytes(privateState.secretKey)],
        }),
        CompiledContract.withCompiledFileAssets(join(BUILDS, 'midnames')),
      );

      const privateStateId = `passport-stagenet-midnames-${label}`;
      const initialPrivateState = { secretKey: bytesToHex(callerSecret) };
      const providers = providersFor('midnames', privateStateId, initialPrivateState);

      /* 4. The resolver leaf: DOMAIN_TARGET is the account-custody contract, so
            the name resolves to a contract exactly as a Passport alias does.
            A leaf already paid for in an earlier run is reused rather than
            deployed again — the state file, not the wallet, is the record. */
      const { key: labelKey, len } = domainToKey(label);
      let resolverAddress = null;
      if (record.legs.resolver?.domain === `${label}.${MIDNAMES_TLD}`) {
        resolverAddress = record.legs.resolver.contractAddress;
        console.log(`  reusing the resolver leaf already deployed at ${resolverAddress}`);
      } else {
        const leafStartedAt = Date.now();
        const leaf = await deployContract(providers, {
          compiledContract: compiled,
          privateStateId,
          initialPrivateState,
          args: [
            maybeBytes(domainToKey(MIDNAMES_TLD).key),
            { bytes: contractAddressBytes(tldAddress) },
            [contractAddressBytes(targetAddress), module.AddressType.ContractAddr],
            maybeBytes(labelKey),
            nativeColourBytes(),
            0n,
            0n,
            0n,
            maybeString(),
            false,
            nameOwnerKey,
            { bytes: new Uint8Array(32) },
            emptyKvs(),
          ],
        });
        resolverAddress = rawContractAddress(leaf.deployTxData.public.contractAddress);
        await remember('resolver', {
          contract: 'midnames.compact deployed as the resolver leaf for this name',
          contractAddress: resolverAddress,
          txIdentifier: identifierOf(leaf.deployTxData),
          wallClockMs: Date.now() - leafStartedAt,
          domain: `${label}.${MIDNAMES_TLD}`,
          target: { kind: 'contract', address: targetAddress },
        });
      }

      /* 5. The paid call. */
      const registerStartedAt = Date.now();
      const tld = await findDeployedContract(providers, {
        compiledContract: compiled,
        contractAddress: tldAddress,
        privateStateId,
        initialPrivateState,
      });
      const registration = await tld.callTx.register_domain_for(nameOwnerKey, labelKey, len, {
        bytes: contractAddressBytes(resolverAddress),
      });
      await remember('register', {
        contract: `register_domain_for on ${tldAddress}`,
        domain: `${label}.${MIDNAMES_TLD}`,
        txIdentifier: identifierOf(registration),
        wallClockMs: Date.now() - registerStartedAt,
        costAtomicNight: len <= 3n ? '600' : len === 4n ? '140' : '10',
        ownerKey: bytesToHex(nameOwnerKey),
        resolverAddress,
      });

      /* The read-back. Not "the name exists" — the name resolving, through the
         registry, to the contract we pointed it at. */
      console.log('=== read-back ===');
      let confirmed = null;
      for (let attempt = 0; attempt < 45 && !confirmed; attempt += 1) {
        try {
          const registryState = await publicDataProvider.queryContractState(tldAddress);
          if (registryState) {
            const registry = module.ledger(registryState.data);
            if (registry.domains.member(labelKey)) {
              const entry = registry.domains.lookup(labelKey);
              const readResolver = rawContractAddress(bytesToHex(entry.resolver.bytes));
              const leafState = await publicDataProvider.queryContractState(readResolver);
              if (leafState) {
                const target = decodeDomainTarget(module.ledger(leafState.data).DOMAIN_TARGET);
                confirmed = {
                  domain: `${label}.${MIDNAMES_TLD}`,
                  ownerKeyOnChain: bytesToHex(entry.owner),
                  resolverAddress: readResolver,
                  target,
                  registrySize: String(registry.domains.size()),
                  registryCosts: `${registry.COST_SHORT}/${registry.COST_MED}/${registry.COST_LONG}`,
                  buyEnabled: registry.BUY_ENABLED,
                };
              }
            }
          }
        } catch (cause) {
          console.log(`  (indexer lag: ${cause?.message ?? cause})`);
        }
        if (!confirmed) await wait(2_000);
      }
      if (!confirmed) throw new Error('The registry never showed the registration.');
      console.log(JSON.stringify(confirmed, null, 2));
      record.legs.readback = { ...confirmed, at: new Date().toISOString() };
      await saveRecord(recordPath, record);
    }

    const closing = await wallet.balances();
    record.closingBalance = {
      nightAtomic: String(closing.night),
      dustSpecks: String(closing.dust),
    };
    record.finishedAt = new Date().toISOString();
    await saveRecord(recordPath, record);
    console.log(
      `\nclosing balance ${formatNight(closing.night)} NIGHT (${closing.night} atomic), ${closing.dust} Specks DUST`,
    );
    console.log(`record written to ${recordPath}`);
  } finally {
    await wallet.close();
  }
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error('\nDEPLOY FAILED');
    console.error(cause);
    process.exit(1);
  },
);
