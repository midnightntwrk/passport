#!/usr/bin/env node
/**
 * fund-localnet.mjs — the captcha-free faucet for the disposable localnet.
 *
 * Sends NIGHT from the genesis wallet (funded at genesis by the node's
 * CFG_PRESET=dev preset) to any `mn_addr_undeployed1…` address. This is what
 * replaces the public faucets, which are Cloudflare-Turnstile gated and so
 * cannot be driven from code.
 *
 *   node fund-localnet.mjs mn_addr_undeployed1…            # 100 NIGHT
 *   node fund-localnet.mjs mn_addr_undeployed1… 250        # 250 NIGHT
 *
 * Endpoints are overridable; the defaults match the localnet brought up from
 * experiments/account-custody-prototype/infra, with the node published on
 * 19944 because 9944 was already taken on this machine:
 *
 *   MIDNIGHT_INDEXER   http://localhost:8088/api/v4/graphql
 *   MIDNIGHT_NODE      http://localhost:19944
 *   MIDNIGHT_PROVER    http://127.0.0.1:6300
 *   GENESIS_SEED       0000…0001
 *
 * Deliberately standalone: it drives the Midnight wallet SDK directly, the same
 * transferTransaction → signRecipe → finalizeRecipe → submitTransaction
 * sequence that examples/passport-demo/src/lib/localWallet.ts uses, so it works
 * with plain `node` and needs no TypeScript loader.
 */

import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

globalThis.WebSocket = WebSocket;

// ledger-v8 8.0.3 can panic inside MerkleTree::collapse while applying a Zswap
// offer. Same guard the prototype and the demo both install.
const originalTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function tryApply(...args) {
  try {
    return originalTryApply.apply(this, args);
  } catch {
    return [this, new Map()];
  }
};

const NETWORK_ID = process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed';
const INDEXER = process.env.MIDNIGHT_INDEXER ?? 'http://localhost:8088/api/v4/graphql';
const INDEXER_WS = process.env.MIDNIGHT_INDEXER_WS ?? `${INDEXER.replace(/^http/, 'ws')}/ws`;
const NODE = process.env.MIDNIGHT_NODE ?? 'http://localhost:19944';
const PROVER = process.env.MIDNIGHT_PROVER ?? 'http://127.0.0.1:6300';
const GENESIS_SEED =
  process.env.GENESIS_SEED ??
  '0000000000000000000000000000000000000000000000000000000000000001';
// A fresh localnet wallet accrues only a few blocks of DUST, so a large fee
// margin can make it refuse its own transactions. Five matches the prototype.
const FEE_BLOCKS_MARGIN = Number(process.env.FEE_BLOCKS_MARGIN ?? '5');

const NIGHT_DECIMALS = 6;
const NIGHT_RAW = ledger.nativeToken().raw;

const [, , recipientArg, amountArg] = process.argv;

if (!recipientArg || recipientArg === '--help' || recipientArg === '-h') {
  console.error(
    'usage: node fund-localnet.mjs <mn_addr_undeployed1…> [NIGHT amount, default 100]',
  );
  process.exit(recipientArg ? 0 : 1);
}

const nightAmount = amountArg ? Number(amountArg) : 100;
if (!Number.isFinite(nightAmount) || nightAmount <= 0) {
  console.error(`Not a valid NIGHT amount: ${amountArg}`);
  process.exit(1);
}
const atomicAmount = BigInt(Math.round(nightAmount * 10 ** NIGHT_DECIMALS));

const formatNight = (value) => {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};

// The genesis seed is public knowledge, so this script must only ever drive a
// disposable localnet. Anything that is not a loopback node and indexer on the
// localnet network id is refused outright — a public network pointed at by
// accident is not a faucet, it is a wallet drainer.
const isLoopback = (endpoint) => {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
};
if (NETWORK_ID !== 'undeployed' || ![NODE, INDEXER, INDEXER_WS].every(isLoopback)) {
  console.error(
    'Refusing to run: this faucet only works against a localnet — the node and indexer must be on localhost or 127.0.0.1, and MIDNIGHT_NETWORK_ID must be "undeployed".',
  );
  process.exit(1);
}

setNetworkId(NETWORK_ID);

// Account 0, index 0 — the derivation the demo and the prototype share.
function deriveRoleKeys(seedHex) {
  const wallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (wallet.type !== 'seedOk') throw new Error('The genesis seed was rejected.');
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed.');
  return derived.keys;
}

async function openGenesisWallet() {
  const keys = deriveRoleKeys(GENESIS_SEED);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const facade = await WalletFacade.init({
    configuration: {
      networkId: getNetworkId(),
      indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
      provingServerUrl: new URL(PROVER),
      relayURL: new URL(NODE.replace(/^http/, 'ws')),
      costParameters: { feeBlocksMargin: FEE_BLOCKS_MARGIN },
      txHistoryStorage: {
        upsert: async () => undefined,
        getAll: async () => [],
        get: async () => undefined,
        serialize: async () => '',
      },
    },
    shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);
  return { facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

const syncedState = (facade) =>
  Rx.firstValueFrom(facade.state().pipe(Rx.filter((state) => state.isSynced)));

async function main() {
  console.log(`network   ${NETWORK_ID}`);
  console.log(`indexer   ${INDEXER}`);
  console.log(`node      ${NODE}`);
  console.log(`prover    ${PROVER}`);
  console.log(`recipient ${recipientArg}`);
  console.log(`amount    ${nightAmount} NIGHT (${atomicAmount} atomic units)\n`);

  // Parsed exactly as localWallet.ts parses a recipient, so an address this
  // script accepts is one the demo would accept too.
  const recipient = MidnightBech32m.parse(recipientArg.trim()).decode(
    UnshieldedAddress,
    getNetworkId(),
  );

  process.stdout.write('syncing the genesis wallet');
  const wallet = await openGenesisWallet();
  const ticker = setInterval(() => process.stdout.write('.'), 1000);
  let state;
  try {
    state = await syncedState(wallet.facade);
  } finally {
    clearInterval(ticker);
    process.stdout.write('\n');
  }

  const held = state.unshielded.balances[NIGHT_RAW] ?? 0n;
  console.log(`genesis holds ${formatNight(held)} NIGHT`);
  if (held < atomicAmount) {
    throw new Error(
      `genesis holds ${formatNight(held)} NIGHT; ${formatNight(atomicAmount)} was requested`,
    );
  }
  if (state.dust.balance(new Date()) === 0n) {
    throw new Error('the genesis wallet has no DUST, so it cannot pay a fee');
  }

  const ttl = new Date(Date.now() + 30 * 60 * 1000);
  const recipe = await wallet.facade.transferTransaction(
    [
      {
        type: 'unshielded',
        outputs: [{ type: NIGHT_RAW, receiverAddress: recipient, amount: atomicAmount }],
      },
    ],
    { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
    { ttl },
  );
  console.log('balanced; signing');
  const signed = await wallet.facade.signRecipe(recipe, (payload) =>
    wallet.unshieldedKeystore.signData(payload),
  );
  console.log('signed; proving against the local proof server');
  const finalized = await wallet.facade.finalizeRecipe(signed);
  console.log('proved; submitting');
  const txId = await wallet.facade.submitTransaction(finalized);

  console.log(`\nSUBMITTED  ${txId}`);
  console.log('(that is the transaction IDENTIFIER — look it up in the indexer with');
  console.log(' `transactions(offset: { identifier: "…" })`, not by hash)');

  // Wait for the sender's own balance to move, which only happens once the
  // transaction is in a block.
  process.stdout.write('waiting for inclusion');
  const applied = await Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.throttleTime(1000),
      Rx.tap(() => process.stdout.write('.')),
      Rx.filter((next) => next.isSynced && (next.unshielded.balances[NIGHT_RAW] ?? 0n) < held),
      Rx.timeout(300_000),
    ),
  );
  process.stdout.write('\n');
  const after = applied.unshielded.balances[NIGHT_RAW] ?? 0n;
  // The genesis wallet spends a whole UTxO and takes change back, and the
  // change output lands a moment later — so this figure is a snapshot, not a
  // cost. What matters is that the balance moved, which means the transaction
  // is in a block.
  console.log(`genesis balance moved: ${formatNight(held)} → ${formatNight(after)} NIGHT`);
  console.log('(change comes back over the next block or two; that drop is not the fee)');
  console.log(`\nFUNDED ${recipientArg} with ${nightAmount} NIGHT.`);
  console.log('\nNOTE: NIGHT alone does not let that wallet SEND. Fees are paid in DUST,');
  console.log('and DUST only accrues once the wallet registers its NIGHT UTxOs for');
  console.log('generation — which only the wallet holding the keys can sign.');

  await wallet.facade.stop();
}

main()
  .then(() => setTimeout(() => process.exit(0), 500).unref())
  .catch((cause) => {
    console.error('\nFUNDING FAILED');
    console.error(cause);
    setTimeout(() => process.exit(1), 500).unref();
  });
