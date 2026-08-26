/**
 * THE SHIELDED-RECEIPT DRILL — one question, live on stagenet:
 *
 *   Does a THIRD-PARTY recipient wallet DETECT a shielded coin paid out by the
 *   account-custody contract's `withdraw_shielded`?
 *
 * Contract-sent shielded notes are created by the contract, not by a wallet's
 * own output builder. Nobody in this project has yet watched a recipient wallet
 * that had no part in the transaction pick one up. The preview drill got as far
 * as constructing the call (`additionalCoinEncPublicKeyMappings` is what makes
 * that possible at all) and then died on a 502 from the public proof server, so
 * the question was left open. Stagenet has a local proof server.
 *
 * Cast:
 *   BALANCER — the stagenet balancer wallet, opened from its seed file. Pays
 *              every fee, and stands in for the USER (it owns the ACC, holds
 *              the minted mUSD, and signs the withdrawal).
 *   MERCHANT — a fresh random wallet created in this process. Never funded,
 *              never used to sign anything, never referenced by the transaction
 *              other than as a coin public key inside the circuit. The only
 *              thing it does is watch its own state.
 *
 * Legs, strictly sequential — four spends in total, because the balancer's
 * droplet service is live against the same wallet:
 *
 *   1. open + sync the BALANCER
 *   2. create + sync the MERCHANT; record its mn_shield-addr
 *   3. deploy a fresh ACC, throwaway device/grant/recovery secrets   [spend 1]
 *   4. mint 500 mUSD to the BALANCER's shielded address              [spend 2]
 *   5. deposit_shielded(500) into the ACC                            [spend 3]
 *   6. withdraw_shielded(MERCHANT coin pk, mUSD, 200)                [spend 4]
 *      then WATCH the merchant's own wallet for the 200.
 *
 * Every assertion is read from the chain (the indexer's view of the contract
 * ledger) or from a wallet's own state. Nothing is inferred from what this
 * process remembers doing.
 *
 *   BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env \
 *     node src/shielded-receipt-drill.mjs
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  deployContract,
  findDeployedContract,
  withContractScopedTransaction,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { MidnightBech32m, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import * as ledger from '@midnightntwrk/ledger-v9';

import {
  applyEnvFile,
  bytesToHex,
  formatNight,
  hexToBytes,
  inMemoryPrivateStateProvider,
  loadConfig,
  openWallet,
  rawContractAddress,
  resolveTransactionHash,
  wait,
  walletProviderFrom,
} from './chain.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILDS = join(HERE, '..', '..', 'contracts-stagenet', 'managed');
const LOG_FILE = join(HERE, '..', 'shielded-receipt-drill.log');

/** The mUSD faucet already on stagenet (deploy-stagenet `faucet` leg, block 157,776). */
const FAUCET_ADDRESS = '4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f';

/** The faucet's domain separator for mUSD, as the preview drills used it. */
const MUSD_DOMAIN_SEPARATOR = (() => {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x06;
  return bytes;
})();

const MINT_AMOUNT = 500n;
const WITHDRAW_AMOUNT = 200n;
const CHANGE_AMOUNT = MINT_AMOUNT - WITHDRAW_AMOUNT;

const LIVE_WATCH_MS = 5 * 60_000;
const RESYNC_WATCH_MS = 3 * 60_000;
const POLL_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

const startedAt = Date.now();
const stamp = () => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(7)}s`;

function log(line = '') {
  const text = line === '' ? '' : `[${stamp()}] ${line}`;
  console.log(text);
  try {
    appendFileSync(LOG_FILE, `${text}\n`, 'utf8');
  } catch {
    // A drill that cannot write its log still runs; the console is the fallback.
  }
}

let checks = 0;
let failures = 0;
function check(label, ok, observed) {
  checks += 1;
  if (!ok) failures += 1;
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}${observed === undefined ? '' : `  — ${observed}`}`);
  return ok;
}

const elapsed = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

const legTimes = [];
function timeLeg(name, since) {
  const ms = Date.now() - since;
  legTimes.push([name, ms]);
  log(`[leg time] ${name}: ${(ms / 1000).toFixed(1)} s`);
}

const txRecord = [];
async function confirmLanded(config, label, identifier) {
  if (!/^[0-9a-f]{2,}$/i.test(identifier)) {
    check(`${label}: midnight-js returned a transaction identifier`, false, identifier || '(empty)');
    return null;
  }
  const resolved = await resolveTransactionHash(config.indexerHttpUrl, identifier);
  const isHash = /^[0-9a-f]{64}$/.test(resolved.hash) && resolved.hash !== identifier;
  txRecord.push({ label, hash: resolved.hash, block: resolved.block });
  log(`${label} tx ${resolved.hash}${resolved.block ? `  (block ${resolved.block})` : ''}`);
  check(
    `${label}: the indexer resolves it to a 64-hex ledger hash in a block`,
    isHash && resolved.block !== null,
    `${resolved.hash} block ${resolved.block}`,
  );
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Wallet observation                                                         */
/* -------------------------------------------------------------------------- */

/** A wallet's own view of its shielded balance for one raw token type. */
async function shieldedBalanceOf(wallet, tokenType) {
  const state = await wallet.currentState();
  return state.shielded.balances[tokenType] ?? 0n;
}

/** The available (spendable) shielded coins a wallet holds of one colour. */
async function availableCoinsOf(wallet, tokenType) {
  const state = await wallet.currentState();
  return state.shielded.availableCoins.filter((entry) => entry.coin.type === tokenType);
}

async function watchBalance(label, wallet, tokenType, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await shieldedBalanceOf(wallet, tokenType);
  let firstSeenAt = null;
  const watchStartedAt = Date.now();
  log(`watching: ${label} (up to ${(timeoutMs / 60_000).toFixed(0)} min, polling every ${POLL_MS / 1000} s)`);
  let ticks = 0;
  while (last < target && Date.now() < deadline) {
    await wait(POLL_MS);
    last = await shieldedBalanceOf(wallet, tokenType);
    ticks += 1;
    if (ticks % 6 === 0) {
      const state = await wallet.currentState();
      log(
        `  … ${((Date.now() - watchStartedAt) / 1000).toFixed(0)} s: balance ${last}, synced ${state.isSynced}, ` +
          `shielded ${state.shielded.progress.appliedIndex}/${state.shielded.progress.highestRelevantWalletIndex}, ` +
          `coins ${state.shielded.totalCoins.length}`,
      );
    }
  }
  if (last >= target) firstSeenAt = Date.now() - watchStartedAt;
  return { value: last, afterMs: firstSeenAt };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  applyEnvFile();
  const config = loadConfig();

  log('='.repeat(78));
  log('SHIELDED-RECEIPT DRILL — stagenet');
  log(`started ${new Date().toISOString()}`);
  log('='.repeat(78));
  log(`network   ${config.networkId}`);
  log(`indexer   ${config.indexerHttpUrl}`);
  log(`node      ${config.nodeUrl}`);
  log(`prover    ${config.proofServerUrl} (contract circuits)`);
  log(`wallet    ${config.walletProverUrl ?? 'in-process WASM prover'} (fee legs)`);
  log(
    'stack     compiler 0.33.0-rc.2 / runtime 0.18.0-rc.1 / compact.js 2.5.5-rc.7 / ' +
      'midnight.js 5.0.0-beta.6 / wallet SDK 2.0.0-beta.2 / @midnightntwrk/ledger-v9 1.0.0-rc.3',
  );
  log(`faucet    ${FAUCET_ADDRESS} (already on chain, block 157,776)`);
  log('');

  const runId = randomBytes(3).toString('hex');
  const merchantDirs = [];
  let balancer = null;
  let merchant = null;

  const answer = {
    detected: false,
    balance: null,
    afterMs: null,
    resynced: false,
    observed: {},
  };

  try {
    /* ------------------------------------------------------------------ */
    /* 1. The BALANCER: payer, and the USER stand-in                       */
    /* ------------------------------------------------------------------ */

    log('--- 1. BALANCER wallet (payer + USER stand-in) ---');
    let legStart = Date.now();
    const openedAt = Date.now();
    balancer = await openWallet(config, log);
    log(`balancer unshielded ${balancer.address}`);
    log(`opened in ${elapsed(openedAt)}`);

    const balancerSyncStart = Date.now();
    await balancer.waitForSync((state) => {
      log(
        `  [sync ${elapsed(balancerSyncStart).padStart(8)}] shielded ${state.shielded.progress.appliedIndex}/${state.shielded.progress.highestRelevantWalletIndex} dust ${state.dust.progress.appliedIndex}/${state.dust.progress.highestRelevantWalletIndex}`,
      );
    });
    log(`balancer synced in ${elapsed(balancerSyncStart)}`);

    const opening = await balancer.balances();
    log(`balancer ${formatNight(opening.night)} NIGHT (${opening.night} atomic), ${opening.dust} Specks DUST`);
    check('the balancer holds NIGHT', opening.night > 0n, String(opening.night));
    check('the balancer holds DUST (fees can be paid)', opening.dust > 0n, String(opening.dust));

    const balancerShieldedAddress = await balancer.facade.shielded.getAddress();
    const balancerCoinPk = new Uint8Array(balancerShieldedAddress.coinPublicKey.data);
    log(
      `balancer shielded   ${MidnightBech32m.encode(config.networkId, balancerShieldedAddress).asString()}`,
    );
    timeLeg('1. balancer open + sync', legStart);
    log('');

    /* ------------------------------------------------------------------ */
    /* 2. A FRESH MERCHANT wallet — the third party                        */
    /* ------------------------------------------------------------------ */

    log('--- 2. MERCHANT wallet (fresh, random, never funded, never signs) ---');
    legStart = Date.now();
    const merchantSeedHex = randomBytes(32).toString('hex');
    const merchantDir = join(config.stateDir, `merchant-${runId}`);
    merchantDirs.push(merchantDir);
    await mkdir(merchantDir, { recursive: true });
    const merchantOpenedAt = Date.now();
    merchant = await openWallet({ ...config, seedHex: merchantSeedHex, stateDir: merchantDir }, log);
    const merchantSyncStart = Date.now();
    await merchant.waitForSync();
    log(`merchant synced in ${elapsed(merchantSyncStart)} (opened in ${elapsed(merchantOpenedAt)} total)`);

    const merchantAddressObject = await merchant.facade.shielded.getAddress();
    const merchantShieldedAddress = MidnightBech32m.encode(
      config.networkId,
      merchantAddressObject,
    ).asString();
    log(`merchant unshielded ${merchant.address}`);
    log(`merchant shielded   ${merchantShieldedAddress}`);

    /* Decode the address the way an Otrix integration would: it is handed the
       bech32m string and nothing else, and it needs BOTH keys out of it. */
    const decoded = ShieldedAddress.codec.decode(
      config.networkId,
      MidnightBech32m.parse(merchantShieldedAddress),
    );
    const merchantCoinPk = new Uint8Array(decoded.coinPublicKey.data);
    const merchantEncPk = new Uint8Array(decoded.encryptionPublicKey.data);
    log(`merchant coin pk        ${bytesToHex(merchantCoinPk)}`);
    log(`merchant encryption pk  ${bytesToHex(merchantEncPk)}`);

    const merchantOwnCpk = (await merchant.currentState()).shielded.coinPublicKey
      .toHexString()
      .replace(/^0x/, '')
      .toLowerCase();
    check(
      'the coin pk decoded from mn_shield-addr is the merchant wallet’s own',
      bytesToHex(merchantCoinPk) === merchantOwnCpk,
      bytesToHex(merchantCoinPk),
    );
    check(
      'the merchant and the balancer are different wallets',
      bytesToHex(merchantCoinPk) !== bytesToHex(balancerCoinPk),
      `${bytesToHex(merchantCoinPk).slice(0, 16)}… vs ${bytesToHex(balancerCoinPk).slice(0, 16)}…`,
    );
    timeLeg('2. merchant create + sync', legStart);
    log('');

    /* A dry run stops here: everything above is read-only, so it proves the
       wallet bring-up and the address decoding without a single spend. */
    if (process.argv.includes('--preflight')) {
      log('--preflight: stopping before the first spend.');
      answer.observed.abortedWith = 'preflight only (no spends attempted)';
      return failures === 0;
    }

    /* ------------------------------------------------------------------ */
    /* Providers                                                           */
    /* ------------------------------------------------------------------ */

    const walletProvider = walletProviderFrom(balancer, config, log);
    const publicDataProvider = indexerPublicDataProvider({
      queryURL: config.indexerHttpUrl,
      subscriptionURL: config.indexerWsUrl,
    });

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
          timeout: 900_000,
        }),
        walletProvider,
        midnightProvider: walletProvider,
      };
    };

    const load = (build) => import(join(BUILDS, build, 'contract', 'index.js'));
    const identifierOf = (data) =>
      String(data?.public?.txId ?? data?.public?.transactionHash ?? data?.txId ?? '');

    /** Polls the indexer's view of the ACC ledger until a predicate holds. */
    const waitForAccLedger = async (accountModule, address, label, predicate, timeoutMs = 4 * 60_000) => {
      const deadline = Date.now() + timeoutMs;
      log(`waiting: ${label}`);
      for (;;) {
        try {
          const state = await publicDataProvider.queryContractState(address);
          if (state) {
            const decodedLedger = accountModule.ledger(state.data);
            if (predicate(decodedLedger)) return decodedLedger;
          }
        } catch (cause) {
          log(`  (indexer: ${cause?.message ?? cause})`);
        }
        if (Date.now() > deadline) return null;
        await wait(3_000);
      }
    };

    /* ------------------------------------------------------------------ */
    /* 3. A fresh ACC                                                      */
    /* ------------------------------------------------------------------ */

    log('--- 3. DEPLOY a fresh account-custody contract (throwaway secrets, balancer pays) ---');
    legStart = Date.now();
    const accountModule = await load('account');
    const deviceSecret = new Uint8Array(randomBytes(32));
    const grantSecret = new Uint8Array(randomBytes(32));
    const recoverySecret = new Uint8Array(randomBytes(32));
    const accPrivateStateId = `shielded-receipt-drill-acc-${runId}`;
    const accInitialPrivateState = { deviceSecret: bytesToHex(deviceSecret) };

    const compiledAccount = CompiledContract.make('passport-account-custody', accountModule.Contract).pipe(
      CompiledContract.withWitnesses({
        device_secret: ({ privateState }) => [privateState, deviceSecret],
        grant_secret: ({ privateState }) => [privateState, grantSecret],
        recovery_secret: ({ privateState }) => [privateState, recoverySecret],
      }),
      CompiledContract.withCompiledFileAssets(join(BUILDS, 'account')),
    );

    const accProviders = providersFor('account', accPrivateStateId, accInitialPrivateState);
    const deployedAcc = await deployContract(accProviders, {
      compiledContract: compiledAccount,
      privateStateId: accPrivateStateId,
      initialPrivateState: accInitialPrivateState,
      args: [
        accountModule.pureCircuits.derive_device_commitment(deviceSecret),
        accountModule.pureCircuits.derive_recovery_commitment(recoverySecret),
        new Uint8Array(randomBytes(32)),
        new Uint8Array(randomBytes(32)),
        new Uint8Array(randomBytes(32)),
      ],
    });
    const accAddress = rawContractAddress(deployedAcc.deployTxData.public.contractAddress);
    log(`ACC address ${accAddress}`);
    check('the ACC deployed', /^[0-9a-f]{64}$/.test(accAddress), accAddress);
    await confirmLanded(config, 'ACC deploy', identifierOf(deployedAcc.deployTxData));
    answer.observed.accAddress = accAddress;
    timeLeg('3. ACC deploy', legStart);
    log('');

    /* ------------------------------------------------------------------ */
    /* 4. Mint 500 mUSD to the BALANCER's shielded address                 */
    /* ------------------------------------------------------------------ */

    log('--- 4. MINT 500 mUSD (shielded) to the BALANCER ---');
    legStart = Date.now();
    const faucetModule = await load('faucet');
    const compiledFaucet = CompiledContract.make('passport-musd-faucet', faucetModule.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(join(BUILDS, 'faucet')),
    );
    const faucet = await findDeployedContract(providersFor('faucet'), {
      compiledContract: compiledFaucet,
      contractAddress: FAUCET_ADDRESS,
    });
    log(`faucet found at ${FAUCET_ADDRESS}`);

    /* The on-chain colour is bound to the minting contract:
       rawTokenType(domain separator, faucet address). */
    const musdTokenType = ledger.rawTokenType(MUSD_DOMAIN_SEPARATOR, FAUCET_ADDRESS);
    const musdColourBytes = ledger.encodeRawTokenType(musdTokenType);
    log(`mUSD colour (raw token type) ${musdTokenType}`);

    const musdBefore = await shieldedBalanceOf(balancer, musdTokenType);
    log(`balancer mUSD before the mint: ${musdBefore}`);

    const mintNonce = new Uint8Array(randomBytes(32));
    const mint = await faucet.callTx.mint_shielded(MUSD_DOMAIN_SEPARATOR, MINT_AMOUNT, mintNonce, {
      bytes: balancerCoinPk,
    });
    await confirmLanded(config, 'mint_shielded (500 mUSD to BALANCER)', identifierOf(mint));

    const wantMusd = musdBefore + MINT_AMOUNT;
    const minted = await watchBalance(
      'BALANCER wallet reports the minted mUSD',
      balancer,
      musdTokenType,
      wantMusd,
      6 * 60_000,
    );
    check(
      `the balancer’s OWN wallet holds ${wantMusd} mUSD after the mint`,
      minted.value === wantMusd,
      String(minted.value),
    );
    if (minted.value !== wantMusd) throw new Error('the mint never reached the balancer wallet');

    /* The coin to deposit, taken from the wallet's own coin set rather than
       assumed from the mint arguments. */
    let musdCoins = await availableCoinsOf(balancer, musdTokenType);
    for (let attempt = 0; attempt < 20 && musdCoins.length === 0; attempt += 1) {
      await wait(3_000);
      musdCoins = await availableCoinsOf(balancer, musdTokenType);
    }
    const depositCoin = musdCoins.find((entry) => entry.coin.value === MINT_AMOUNT) ?? musdCoins[0];
    check(
      'the minted coin is spendable in the balancer’s own coin set',
      depositCoin !== undefined && depositCoin.coin.value === MINT_AMOUNT,
      depositCoin ? `value ${depositCoin.coin.value}, nonce ${depositCoin.coin.nonce}` : 'no coin',
    );
    if (!depositCoin) throw new Error('the minted coin never became spendable');
    check(
      'the coin’s nonce is the nonce the mint was called with',
      String(depositCoin.coin.nonce).replace(/^0x/, '').toLowerCase() === bytesToHex(mintNonce),
      `${String(depositCoin.coin.nonce)} vs ${bytesToHex(mintNonce)}`,
    );
    timeLeg('4. mint 500 mUSD', legStart);
    log('');

    /* ------------------------------------------------------------------ */
    /* 5. deposit_shielded — 500 mUSD into the ACC                         */
    /* ------------------------------------------------------------------ */

    log('--- 5. deposit_shielded(500 mUSD) into the ACC ---');
    legStart = Date.now();
    const deposit = await deployedAcc.callTx.deposit_shielded({
      nonce: hexToBytes(String(depositCoin.coin.nonce)),
      color: musdColourBytes,
      value: depositCoin.coin.value,
    });
    await confirmLanded(config, 'deposit_shielded', identifierOf(deposit));

    const afterDeposit = await waitForAccLedger(
      accountModule,
      accAddress,
      `ACC coins[mUSD].value == ${MINT_AMOUNT} (from the indexer)`,
      (l) => l.coins.member(musdColourBytes) && l.coins.lookup(musdColourBytes).value === MINT_AMOUNT,
    );
    const heldValue =
      afterDeposit && afterDeposit.coins.member(musdColourBytes)
        ? afterDeposit.coins.lookup(musdColourBytes).value
        : null;
    check(
      `the ACC ledger coins map shows ${MINT_AMOUNT} mUSD (read from the indexer)`,
      heldValue === MINT_AMOUNT,
      String(heldValue),
    );
    if (heldValue !== MINT_AMOUNT) throw new Error('the deposit never registered in the ACC coins map');
    answer.observed.accHeldAfterDeposit = String(heldValue);

    /* The other side of the same fact: the money left the payer's wallet. */
    let balancerAfter = await shieldedBalanceOf(balancer, musdTokenType);
    for (let attempt = 0; attempt < 20 && balancerAfter !== musdBefore; attempt += 1) {
      await wait(POLL_MS);
      balancerAfter = await shieldedBalanceOf(balancer, musdTokenType);
    }
    check(
      'the balancer’s own wallet no longer holds the deposited mUSD',
      balancerAfter === musdBefore,
      `${balancerAfter} (was ${musdBefore} before the mint)`,
    );
    timeLeg('5. deposit_shielded', legStart);
    log('');

    /* ------------------------------------------------------------------ */
    /* 6. THE QUESTION                                                     */
    /* ------------------------------------------------------------------ */

    log('--- 6. withdraw_shielded(MERCHANT coin pk, mUSD, 200) — THE QUESTION ---');
    log('    The merchant has no part in this transaction: it does not sign it,');
    log('    does not pay for it, and is named only by a coin public key inside');
    log('    the circuit. Whatever its wallet does next is the result.');
    legStart = Date.now();

    const merchantBefore = await shieldedBalanceOf(merchant, musdTokenType);
    check('the MERCHANT holds no mUSD beforehand', merchantBefore === 0n, String(merchantBefore));

    /* The coin-pk → encryption-pk mapping. The circuit takes only the coin pk;
       the output ciphertext needs the recipient's ENCRYPTION pk, which cannot
       be derived from the coin pk, and without which midnight-js refuses to
       build the transaction at all. Both keys come out of the one bech32m
       address the merchant handed over. */
    const mappings = new Map([[bytesToHex(merchantCoinPk), bytesToHex(merchantEncPk)]]);
    log(`additionalCoinEncPublicKeyMappings: ${bytesToHex(merchantCoinPk)} → ${bytesToHex(merchantEncPk)}`);

    const withdrawStartedAt = Date.now();
    const withdrawal = await withContractScopedTransaction(
      accProviders,
      async (txCtx) => {
        await deployedAcc.callTx.withdraw_shielded(
          txCtx,
          { bytes: merchantCoinPk },
          musdColourBytes,
          WITHDRAW_AMOUNT,
        );
      },
      {
        scopeName: `shielded-receipt-drill-withdraw-${runId}`,
        additionalCoinEncPublicKeyMappings: mappings,
      },
    );
    log(`withdraw_shielded constructed, proved, balanced, and submitted in ${elapsed(withdrawStartedAt)}`);
    const withdrawResolved = await confirmLanded(config, 'withdraw_shielded', identifierOf(withdrawal));
    answer.observed.withdrawTx = withdrawResolved?.hash ?? null;
    answer.observed.withdrawBlock = withdrawResolved?.block ?? null;

    const afterWithdraw = await waitForAccLedger(
      accountModule,
      accAddress,
      `ACC coins[mUSD] change re-registered as ${CHANGE_AMOUNT}`,
      (l) => l.coins.member(musdColourBytes) && l.coins.lookup(musdColourBytes).value === CHANGE_AMOUNT,
    );
    const changeValue =
      afterWithdraw && afterWithdraw.coins.member(musdColourBytes)
        ? afterWithdraw.coins.lookup(musdColourBytes).value
        : null;
    check(
      `the ACC coins map shows the ${CHANGE_AMOUNT} change (read from the indexer)`,
      changeValue === CHANGE_AMOUNT,
      String(changeValue),
    );
    answer.observed.accChange = String(changeValue);

    log('');
    log(`THE WATCH — up to ${LIVE_WATCH_MS / 60_000} minutes on the merchant's own live wallet:`);
    let observed = await watchBalance(
      `MERCHANT wallet reports ${WITHDRAW_AMOUNT} mUSD`,
      merchant,
      musdTokenType,
      WITHDRAW_AMOUNT,
      LIVE_WATCH_MS,
    );
    log(`merchant live-wallet mUSD after the window: ${observed.value}`);

    if (observed.value < WITHDRAW_AMOUNT) {
      log('');
      log('Not seen live. Restart-resync attempt: the merchant wallet is stopped and');
      log('rebuilt from its own seed with no saved state, so it re-scans the chain.');
      answer.resynced = true;
      await merchant.facade.stop().catch(() => undefined);
      const resyncDir = join(config.stateDir, `merchant-resync-${runId}`);
      merchantDirs.push(resyncDir);
      await mkdir(resyncDir, { recursive: true });
      const resyncStart = Date.now();
      merchant = await openWallet({ ...config, seedHex: merchantSeedHex, stateDir: resyncDir }, log);
      await merchant.waitForSync();
      log(`merchant re-synced from scratch in ${elapsed(resyncStart)}`);
      const resyncedCpk = (await merchant.currentState()).shielded.coinPublicKey
        .toHexString()
        .replace(/^0x/, '')
        .toLowerCase();
      check(
        'the resynced merchant wallet is the same wallet (same coin pk)',
        resyncedCpk === bytesToHex(merchantCoinPk),
        resyncedCpk,
      );
      observed = await watchBalance(
        `MERCHANT (resynced) reports ${WITHDRAW_AMOUNT} mUSD`,
        merchant,
        musdTokenType,
        WITHDRAW_AMOUNT,
        RESYNC_WATCH_MS,
      );
      log(`merchant resynced-wallet mUSD: ${observed.value}`);
    }

    const finalMerchantState = await merchant.currentState();
    answer.observed.merchantBalances = JSON.stringify(
      Object.fromEntries(
        Object.entries(finalMerchantState.shielded.balances).map(([k, v]) => [k, String(v)]),
      ),
    );
    answer.observed.merchantCoinCount = finalMerchantState.shielded.totalCoins.length;
    answer.observed.merchantSynced = finalMerchantState.isSynced;
    answer.observed.merchantProgress = `${finalMerchantState.shielded.progress.appliedIndex}/${finalMerchantState.shielded.progress.highestRelevantWalletIndex}`;

    answer.detected = observed.value >= WITHDRAW_AMOUNT;
    answer.balance = observed.value;
    answer.afterMs = observed.afterMs;

    if (answer.detected) {
      check(
        'THE ANSWER: the MERCHANT’s own wallet reports the contract-sent shielded coin',
        true,
        `${observed.value} mUSD after ${((observed.afterMs ?? 0) / 1000).toFixed(0)} s`,
      );
    } else {
      failures += 1;
      checks += 1;
      log('FAIL  THE ANSWER: the third-party recipient wallet NEVER detected the');
      log('      contract-sent shielded note — not live, not after a full restart-resync.');
      log(`      Observed: withdraw_shielded is on chain (${answer.observed.withdrawTx}, block ${answer.observed.withdrawBlock}),`);
      log(`                the ACC coins map re-registered the ${answer.observed.accChange} change,`);
      log(`                the merchant wallet is synced (${answer.observed.merchantSynced}, ${answer.observed.merchantProgress})`);
      log(`                and holds ${answer.observed.merchantCoinCount} shielded coins, balances ${answer.observed.merchantBalances}.`);
    }
    timeLeg('6. withdraw_shielded to a third party (incl. the watch)', legStart);
    log('');
  } catch (cause) {
    failures += 1;
    log(`DRILL ABORTED: ${cause?.message ?? cause}`);
    log(String(cause?.stack ?? ''));
    answer.observed.abortedWith = String(cause?.message ?? cause);
  } finally {
    /* ------------------------------------------------------------------ */
    /* Summary                                                             */
    /* ------------------------------------------------------------------ */

    log('='.repeat(78));
    log('SUMMARY');
    log('='.repeat(78));
    for (const entry of txRecord) {
      log(`  ${entry.label.padEnd(38)} ${entry.hash}${entry.block ? `  block ${entry.block}` : ''}`);
    }
    log('');
    for (const [name, ms] of legTimes) {
      log(`  ${name.padEnd(54)} ${(ms / 1000).toFixed(1)} s`);
    }
    log('');
    log(`checks ${checks - failures}/${checks} passed`);
    log('');
    log('THE ANSWER');
    if (answer.observed.abortedWith) {
      log(
        `  INCONCLUSIVE — the drill stopped before the question could be answered: ${answer.observed.abortedWith}`,
      );
    } else if (answer.detected) {
      log(
        `  DETECTED — the third-party MERCHANT wallet, which took no part in the transaction, ` +
          `reported ${answer.balance} mUSD of the contract-sent shielded coin in its own state ` +
          `${((answer.afterMs ?? 0) / 1000).toFixed(0)} s after withdraw_shielded landed` +
          `${answer.resynced ? ' (after a restart-resync; not seen on the live wallet)' : ' (live, no restart needed)'}.`,
      );
    } else {
      log(
        `  NOT DETECTED — withdraw_shielded is on chain (${answer.observed.withdrawTx}, block ${answer.observed.withdrawBlock}), ` +
          `the ACC re-registered its ${answer.observed.accChange} change, and the MERCHANT wallet ` +
          `stayed empty for the whole ${LIVE_WATCH_MS / 60_000}-minute live window and a full restart-resync ` +
          `(synced ${answer.observed.merchantSynced}, ${answer.observed.merchantProgress}, ` +
          `${answer.observed.merchantCoinCount} coins, balances ${answer.observed.merchantBalances}).`,
      );
    }
    log('='.repeat(78));

    if (merchant) await merchant.facade.stop().catch(() => undefined);
    if (balancer) await balancer.close().catch(() => undefined);
    for (const dir of merchantDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return failures === 0;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (cause) => {
    log(`DRILL CRASHED: ${cause?.message ?? cause}`);
    console.error(cause);
    process.exit(1);
  },
);
