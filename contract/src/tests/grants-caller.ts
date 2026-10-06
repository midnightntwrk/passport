// Real caller-bound grant spends: contract -> account and A -> B -> account.
// The forged-context control keeps the real circuit/VK and tests a transcript
// built with a fabricated caller, without supplying any corresponding claim.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { createCallContext } from '@midnight-ntwrk/compact-runtime';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import * as AccountModule from '../../contracts/managed/account/contract/index.js';
import * as Proxy from '../../contracts/managed/probe-grant-caller/contract/index.js';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { createProviders, managedPath, zkConfigPath, userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { makeWitnesses } from '../wallet/witnesses.js';
import { JubjubDevice, JubjubGrantee, originHash, spendScope, openingOf, jubjubGrantChallenges, grantAuthArgs } from '../wallet/signer.js';
import { queryTxPosition } from '../wallet/capture.js';
import { runScenario, step, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
await runScenario('caller-bound scoped grants', async () => {
  const transactions: unknown[] = [], negatives: unknown[] = [];
  const record = async (label: string, txId: string) => {
    const position = await queryTxPosition(txId);
    assert.equal(position.error, undefined);
    assert.equal(position.status, 'SUCCESS');
    transactions.push({ label, txId, blockHeight: position.blockHeight, status: position.status });
    console.log(`  accepted ${label}: ${txId}`);
  };
  const ctx = await setupWallet();
  const owner = JubjubDevice.generate();
  const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), owner, generateEncKeyPair());
  assert.equal((await account.ledgerState()).spec_version, 3n);
  const proxyPath = path.join(managedPath, 'probe-grant-caller');
  const modules = new Map<string, typeof Proxy | typeof AccountModule>([[account.address, AccountModule]]);
  const contractModuleProvider = { resolve: (address: string) => {
    const module = modules.get(address);
    return module ? async () => module : undefined;
  } };
  const proxies = [];
  for (let i = 0; i < 2; i++) {
    const providers = Object.assign(await createProviders<keyof Proxy.ProvableCircuits<{}>>(ctx.walletCtx, proxyPath), { contractModuleProvider });
    const compiled = CompiledContract.make('probe-grant-caller', Proxy.Contract).pipe(
      CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(proxyPath));
    const deployed = await deployContract(providers, { compiledContract: compiled, privateStateId: `grant-caller-proxy-${i}`, initialPrivateState: {} });
    const address = deployed.deployTxData.public.contractAddress;
    modules.set(address, Proxy);
    proxies.push({ address, deployed, providers });
  }
  const [a, b] = proxies;
  const accountRef = { bytes: account.addressBytes };
  const bRef = { bytes: bytes(b.address) };

  step('fund an actual non-native unshielded spend');
  const faucet = await deployFaucet(ctx.walletCtx);
  const domain = rnd(), recipient = userAddressBytes(ctx.walletCtx), color = await faucet.unshieldedColor(domain);
  await record('mint', await faucet.mintUnshielded(domain, 100n, recipient));
  await sleep(15_000); // wallet indexing, as in grants-unshielded.ts
  await record('deposit', (await account.depositUnshielded(color, 100n)).txId);
  const grantee = JubjubGrantee.generate(), origin = originHash('https://bank.example');
  let salt = rnd();
  const id = grantee.grantId(account.addressBytes, origin, 0n);
  const scope = spendScope({ withdrawUnshielded: true, color, cap: 30n, perCallCap: 10n, caller: bRef.bytes });
  let opening = openingOf(scope, salt, origin, 0n);
  await record('issue pinned to B', (await account.issueGrant(owner, id, scope, salt)).txId);
  const material = async () => {
    const context = await account.grantContext(id);
    const auth = grantee.sign(jubjubGrantChallenges.withdrawUnshielded(context, grantee.pk, color, 5n, recipient));
    const call: Proxy.GrantJubjubCall = { color, amount: 5n, recipient: { bytes: recipient }, pk: grantee.pk,
      origin_hash: origin, slot: 0n, scope_salt: salt, recipient_kind: opening.recipientKind,
      pinned_recipient: opening.pinnedRecipient, max_coin_value: opening.maxCoinValue, spent_prev: opening.spentPrev,
      sig_r: auth.sig_r, sig_s: auth.sig_s, grind_nonce: auth.grind_nonce };
    return { auth, call, args: [color, 5n, { bytes: recipient }, ...grantAuthArgs(opening, auth)] };
  };
  const refused = async (label: string, run: () => Promise<unknown>, expected: RegExp) => {
    await assert.rejects(run, error => {
      const message = String(error);
      assert.match(message, expected);
      negatives.push({ label, stage: 'build', message });
      console.log(`  rejected ${label}: ${message.slice(0, 180)}`);
      return true;
    });
  };
  const first = await material();
  await refused('direct root', () => account.withdrawUnshieldedWithGrantAuth(color, 5n, recipient, opening, first.auth), /requires a contract caller/);
  await refused('wrong immediate caller A', () => a.deployed.callTx.forward_jubjub(accountRef, first.call), /grant caller mismatch/);
  await record('B -> account', (await b.deployed.callTx.forward_jubjub(accountRef, first.call)).public.txId);
  opening = { ...opening, spentPrev: 5n };
  const second = await material();
  await record('A -> B -> account (B observed)', (await a.deployed.callTx.relay_jubjub(bRef, accountRef, second.call)).public.txId);
  opening = { ...opening, spentPrev: 10n };
  await refused('replay through B', () => b.deployed.callTx.forward_jubjub(accountRef, { ...second.call, spent_prev: 10n }), /invalid grant signature|range error/);
  assert.equal((await account.ledgerState()).grants.lookup(id).nonce, 2n);

  step('fabricated caller context: real proof, no claiming contract');
  const forged = await material();
  class ForgedContextAccount extends AccountModule.Contract {
    constructor(witnesses: any) {
      super(witnesses);
      const original = this.provableCircuits.withdraw_unshielded_with_grant_jubjub;
      this.provableCircuits.withdraw_unshielded_with_grant_jubjub = async (c, ...args) => {
        const old = c.callContext;
        c.callContext = createCallContext(old.circuitId, old.contractAddress, old.currentZswapLocalState!,
          old.currentQueryContext.state, old.currentPrivateState, old.time, old.parentBlockHash,
          { tag: 'contract', address: b.address });
        c.queryContexts[old.contractAddress] = c.callContext.currentQueryContext;
        return original(c, ...args);
      };
    }
  }
  const compiledForged = CompiledContract.make('account', ForgedContextAccount).pipe(
    CompiledContract.withWitnesses(makeWitnesses()), CompiledContract.withCompiledFileAssets(zkConfigPath));
  let stage = 'build';
  let forgedTxHash: string | undefined;
  const forgedSince = new Date().toISOString();
  const providers = { ...ctx.providers,
    proofProvider: { ...ctx.providers.proofProvider, proveTx: async (...args: any[]) => {
      stage = 'prove'; const result = await ctx.providers.proofProvider.proveTx(...args); stage = 'balance'; return result;
    } },
    midnightProvider: { ...ctx.providers.midnightProvider, submitTx: async (...args: any[]) => {
      stage = 'node-submit';
      forgedTxHash = args[0].tx.transactionHash();
      return ctx.providers.midnightProvider.submitTx(...args);
    } },
  };
  await assert.rejects(() => (submitCallTx as any)(providers, { compiledContract: compiledForged,
    contractAddress: account.address, circuitId: 'withdraw_unshielded_with_grant_jubjub',
    privateStateId: account.privateStateId, args: forged.args }), error => {
      const message = String(error);
      assert.equal(stage, 'node-submit', message);
      // RPC exposes guaranteed-execution failure 104; the node log supplies
      // the exact read mismatch. Match the submitted hash, not an older error.
      const rpcError = message.match(/Custom error:\s*104\b/)?.[0];
      assert.ok(rpcError, message);
      assert.ok(forgedTxHash);
      let nodeLog: string | undefined;
      if (process.env.MIDNIGHT_NODE_CONTAINER) {
        const logs = spawnSync('docker', ['logs', '--since', forgedSince, process.env.MIDNIGHT_NODE_CONTAINER], { encoding: 'utf8' });
        assert.equal(logs.status, 0, logs.stderr);
        nodeLog = `${logs.stdout}\n${logs.stderr}`.split('\n').find(line => line.includes(forgedTxHash!) && line.includes('Rejected transaction'));
        assert.ok(nodeLog, `no node rejection for ${forgedTxHash}`);
        assert.match(nodeLog, /mismatch between expected .* and actual .* read/);
      }
      negatives.push({ label: 'fabricated caller without claim', stage, rpcError, txHash: forgedTxHash, nodeLog });
      console.log(`  rejected at node: ${rpcError}; ${nodeLog ?? 'set MIDNIGHT_NODE_CONTAINER for the exact node diagnostic'}`);
      return true;
    });
  assert.equal((await account.ledgerState()).grants.lookup(id).nonce, 2n);

  step('revoke/reissue without pin, then direct call');
  await record('revoke', (await account.revokeGrant(owner, id)).txId);
  salt = rnd();
  await record('reissue unrestricted', (await account.issueGrant(owner, id, { ...scope, caller: undefined }, salt)).txId);
  opening = { ...opening, scopeSalt: salt, spentPrev: 0n };
  const direct = await material();
  await record('unrestricted root', (await account.withdrawUnshieldedWithGrantAuth(color, 5n, recipient, opening, direct.auth)).txId);
  assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 85n);
  writeEvidence({ testId: 'grants-caller', name: 'conformance', fileName: 'conformance.json', verdict: 'PASS',
    description: 'Callee-enforced immediate contract caller pin on scoped grants',
    note: 'Real unshielded JubJub grant spends; wrong/direct callers fail at build, fabricated caller fails at node admission. Both arms/all six gates are also covered offline.',
    details: { account: account.address, proxyA: a.address, proxyB: b.address, transactions, negatives,
      compiler: '0.35.0', runtime: '0.20.0', accountZkir: '3.1', proxyZkir: '2.0', schema: 3,
      limitation: 'Caller authenticates the ledger claiming contract; a contract exposing arbitrary claimContractCall can lend its identity. It does not attest a browser origin or a calling circuit.' } });
});
