import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { compiledNative, nativeModule, nativeProviders, NativeContract, rt, contracts, sdk, ledgerApi } from './adapter.js';
import { CustodyAccount } from '../../../contract/src/wallet/account.js';
import { JubjubDevice, JubjubGrantee, K256Grantee, originHash, spendScope, openingOf, authArgs, grantAuthArgs, jubjubChallenges, k256Challenges, jubjubGrantChallenges, k256GrantChallenges } from '../../../contract/src/wallet/signer.js';
import { p256Challenges, p256GrantChallenges } from '../../../contract/src/wallet/signer-p256.js';
import { softwarePasskey, TEST_ORIGIN, sha256 } from '../../../contract/src/tests/p256-fixtures.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../../../contract/src/wallet/inbox.js';
import { makeWitnesses } from '../../../contract/src/wallet/witnesses.js';
import { deployFaucet } from '../../../contract/src/node/setup.js';
import { managedPath, zkConfigPath, userAddressBytes } from '../../../contract/src/node/wallet.js';
import { userCoinPublicKey } from '../../../contract/src/tests/flow.js';
import { candidateIndices } from '../../../contract/src/wallet/capture.js';
import { recoveryKey } from '../../../contract/src/wallet/recovery-gate.js';
import { newRecoverySecret } from '../../../contract/src/wallet/recovery.js';
import * as Proxy from '../../../contract/contracts/managed/probe-grant-caller/contract/index.js';
const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function fundedSuite(h: any) {
    const { wallet, providers, account, devices, evidence, record, check, pointAt } = h;
    const cache: Map<string, any> = h.cache ??= new Map();
    const memo = async (key: string, run: () => Promise<any>) => {
        if (cache.has(key))
            return cache.get(key);
        const value = await run();
        cache.set(key, value);
        return value;
    };
    h.memo = memo;
    const { color, recipient, cpk } = await memo('funding', async () => {
        const ctx = { walletCtx: wallet, providers };
        console.log('Funding with faucet-issued shielded and unshielded tokens');
        const faucet = await deployFaucet(wallet);
        const domain = rnd(), recipient = userAddressBytes(wallet), cpk = await userCoinPublicKey(ctx);
        const color = await faucet.unshieldedColor(domain);
        await record('mint unshielded', { txId: await faucet.mintUnshielded(domain, 1000n, recipient) });
        await record('mint shielded', { txId: await faucet.mint(domain, 3000n, rnd(), cpk) });
        await sleep(15000);
        await pointAt(account);
        await record('deposit_unshielded', await account.depositUnshielded(color, 1000n));
        for (const device of devices)
            await record(`withdraw_unshielded_with_${device.arm}`, await account.withdrawUnshielded(device, color, 1n, recipient));
        check('funded unshielded deposit and device withdrawals under all three arms');
        return { color, recipient, cpk };
    });
    // Deploy the other bootstrap arms as well. Each receives the complete native roster.
    const { receiverDevice, receiverKeys, receiver } = await memo('receiver', async () => {
        const receiverDevice = JubjubDevice.generate(), receiverKeys = generateEncKeyPair();
        const receiver = await CustodyAccount.deploy(providers, compiledNative(), receiverDevice, receiverKeys);
        await h.verifyKeys(receiver);
        evidence.accounts.push({ role: 'receiver', address: receiver.address });
        return { receiverDevice, receiverKeys, receiver };
    });
    await memo('p256-bootstrap', async () => {
        const pBorn = await CustodyAccount.deploy(providers, compiledNative(), softwarePasskey().device, generateEncKeyPair());
        await h.verifyKeys(pBorn);
        evidence.accounts.push({ role: 'p256-bootstrap', address: pBorn.address });
    });
    check('all three bootstrap arms activated with native keys');
    const deposit = async () => {
        await pointAt(account);
        const coin = { nonce: rnd(), color, value: 100n };
        const result = await account.depositShielded(coin, sealInboxEntry(await account.encKey(), coin));
        await record('deposit_shielded', result);
        const { candidates } = await candidateIndices(result.txId);
        assert.ok(candidates.length, 'deposit has commitment positions');
        return { coin, candidates };
    };
    const tryCoin = async (target: any, coin: any, candidates: bigint[], fn: () => Promise<any>) => {
        const failures: any[] = [];
        for (const index of candidates) {
            await pointAt(target);
            await target.putCoin({ ...coin, mtIndex: index });
            const submitted = evidence.transactions.length;
            try {
                return await fn();
            }
            catch (error: any) {
                // A candidate belonging to the wallet is pruned from the contract's tree.
                // ledger-v9 traps while constructing that path; another candidate can be valid.
                // Restrict this workaround to the observed constructor and never retry a submission.
                const stacks = [error, error?.cause, error?.cause?.cause].map(e => String(e?.stack ?? e)).join('\n');
                const prunedCandidate = /RuntimeError: unreachable/.test(stacks) && /ZswapInput.newContractOwned/.test(stacks);
                if (evidence.transactions.length !== submitted || (!prunedCandidate && !/Failed Proof Server response|failed to prove|Proof.*failed/i.test(String(error))))
                    throw error;
                failures.push({ index: String(index), message: String(error) });
                (evidence.coin_candidate_retries ??= []).push({ address: target.address, index: String(index), reason: prunedCandidate ? 'pruned candidate: ledger-v9 constructor trap' : 'proof failure' });
            }
        }
        throw new Error(`no coin index proved: ${JSON.stringify(failures)}`);
    };
    for (const device of devices)
        await memo(`shielded-${device.arm}`, async () => {
            const { coin, candidates } = await deposit();
            await record(`withdraw_shielded_with_${device.arm}`, await tryCoin(account, coin, candidates, () => account.withdrawShielded(device, cpk, color, 100n)));
        });
    check('funded shielded device withdrawals under all three arms');
    async function composed(device: any, grant?: any) {
        const { coin, candidates } = await deposit();
        const result = await tryCoin(account, coin, candidates, async () => {
            await pointAt(account);
            const held = await account.heldCoin(color);
            let args: any[], name: string;
            if (grant) {
                const g = await account.grantContext(grant.id), enc = await account.encKey(), entry = rnd(192);
                const challenges = grant.signer.arm === 'jubjub' ? jubjubGrantChallenges : grant.signer.arm === 'p256' ? p256GrantChallenges : k256GrantChallenges;
                const auth = await grant.signer.sign(challenges.withdrawShieldedToContract(g, grant.signer.pk, receiver.addressBytes, color, 100n, entry, enc, held));
                name = `withdraw_shielded_to_contract_with_grant_${grant.signer.arm}`;
                args = [{ bytes: receiver.addressBytes }, color, 100n, entry, enc, ...grantAuthArgs(grant.opening, auth)];
            }
            else {
                const context = await account.callContext(), counter = await account.resolveUseCounter(device);
                const challenges = device.arm === 'jubjub' ? jubjubChallenges : device.arm === 'p256' ? p256Challenges : k256Challenges;
                const auth = await device.sign(challenges.withdrawShieldedToContract(context, device.pk, receiver.addressBytes, color, 100n, held), counter);
                name = `withdraw_shielded_to_contract_with_${device.arm}`;
                args = [{ bytes: receiver.addressBytes }, color, 100n, ...authArgs(auth)];
            }
            const { composeExactSpend } = await import(`./compose.js?revision=${Date.now()}`);
            return composeExactSpend(providers, account, receiver, receiverKeys.publicKey, cpk, name, args, held);
        });
        await record(`${result.name} + receiver.deposit_shielded`, result);
        const l = await receiver.ledgerState();
        const opened = openInboxEntry(receiverKeys.secretKey, l.inbox.lookup(l.inbox_count - 1n));
        assert.ok(opened);
        assert.deepEqual(opened, result.sent);
        const { candidates: receivedCandidates } = await candidateIndices(result.txId);
        await record('receiver onward spend', await tryCoin(receiver, result.sent, receivedCandidates, () => receiver.withdrawShielded(receiverDevice, cpk, color, 100n)));
        await pointAt(account);
    }
    for (const device of devices)
        await memo(`direct-${device.arm}`, () => composed(device));
    check('device contract-to-contract transfers claimed and spent by receiver under all three arms');
    const grantees = [K256Grantee.generate(), JubjubGrantee.generate(), softwarePasskey().grantee];
    for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        await memo(`grant-${device.arm}`, async () => {
            const signer = grantees[i], origin = originHash(signer.arm === 'p256' ? TEST_ORIGIN : 'https://localnet.invalid');
            const salt = rnd(), id = signer.grantId(account.addressBytes, origin, 0n);
            const scope = spendScope({ withdrawUnshielded: true, withdrawShielded: true, withdrawShieldedToContract: true, color, cap: 500n, perCallCap: 100n, maxCoinValue: 100n, readPkHash: sha256(generateEncKeyPair().publicKey), rpIdHash: signer.arm === 'p256' ? signer.policy.rp_id_hash : undefined });
            const opening = openingOf(scope, salt, origin, 0n);
            await pointAt(account);
            await record(`issue_grant_with_${device.arm}`, await account.issueGrant(device, id, scope, salt));
            await record(`withdraw_unshielded_with_grant_${signer.arm}`, await account.withdrawUnshieldedWithGrant(signer, opening, color, 1n, recipient));
            opening.spentPrev += 1n;
            const { coin, candidates } = await deposit();
            await record(`withdraw_shielded_with_grant_${signer.arm}`, await tryCoin(account, coin, candidates, () => account.withdrawShieldedWithGrant(signer, opening, cpk, color, 100n, rnd(192))));
            opening.spentPrev += 100n;
            await composed(undefined, { signer, id, opening });
            opening.spentPrev += 100n;
            await record(`revoke_grant_with_${device.arm}`, await account.revokeGrant(device, id));
            await record(`revoke_all_grants_with_${device.arm}`, await account.revokeAllGrants(device));
        });
    }
    check('all grant issuance, funded spend, composition and revocation arms');
    await memo('caller-suite', () => callerSuite(h, color, recipient));
    await memo('recovery-suite', () => recoverySuite(h));
}
async function callerSuite(h: any, color: Uint8Array, recipient: Uint8Array) {
    const { wallet, providers, account, devices, record, check, pointAt, negative } = h;
    // Bind dynamic dispatch to the same native artifacts installed on this account.
    const accountModule = { ...nativeModule, expectedVk: Object.fromEntries(await Promise.all(Object.keys(nativeModule.expectedVk).map(async (name) => [name, sdk.hashVerifierKey(await providers.zkConfigProvider.getVerifierKey(name))]))) };
    const modules = new Map<string, any>([[account.address, accountModule]]);
    const contractModuleProvider = { resolve: (address: string) => modules.has(address) ? async () => modules.get(address) : undefined };
    const proxies: any[] = [];
    for (let i = 0; i < 2; i++) {
        const path = `${managedPath}/probe-grant-caller`;
        const p = await nativeProviders(wallet, path, false);
        Object.assign(p, { contractModuleProvider });
        h.instrument(p);
        const compiled = sdk.CompiledContract.make('probe-grant-caller', Proxy.Contract).pipe(sdk.CompiledContract.withVacantWitnesses, sdk.CompiledContract.withCompiledFileAssets(path));
        const deployed: any = await contracts.deployContract(p, { compiledContract: compiled, privateStateId: `minocrab-proxy-${i}-${Date.now()}`, initialPrivateState: {} });
        const address = deployed.deployTxData.public.contractAddress;
        modules.set(address, Proxy);
        proxies.push({ deployed, address });
    }
    const [a, b] = proxies, signer = JubjubGrantee.generate(), origin = originHash('https://caller.localnet.invalid'), salt = rnd();
    const id = signer.grantId(account.addressBytes, origin, 0n);
    const scope = spendScope({ withdrawUnshielded: true, color, cap: 30n, perCallCap: 10n, caller: new Uint8Array(Buffer.from(b.address, 'hex')) });
    const opening = openingOf(scope, salt, origin, 0n);
    await pointAt(account);
    await record('issue caller-bound grant', await account.issueGrant(devices[0], id, scope, salt));
    const material = async () => {
        const g = await account.grantContext(id);
        const auth = signer.sign(jubjubGrantChallenges.withdrawUnshielded(g, signer.pk, color, 5n, recipient));
        return { auth, call: { color, amount: 5n, recipient: { bytes: recipient }, pk: signer.pk, origin_hash: origin, slot: 0n, scope_salt: salt, recipient_kind: opening.recipientKind, pinned_recipient: opening.pinnedRecipient, max_coin_value: opening.maxCoinValue, spent_prev: opening.spentPrev, sig_r: auth.sig_r, sig_s: auth.sig_s, grind_nonce: auth.grind_nonce } };
    };
    const ref = { bytes: account.addressBytes }, first = await material();
    await negative('caller-bound direct root', () => account.withdrawUnshieldedWithGrantAuth(color, 5n, recipient, opening, first.auth), /requires a contract caller/);
    await negative('wrong immediate caller', () => a.deployed.callTx.forward_jubjub(ref, first.call), /grant caller mismatch/);
    const r = await b.deployed.callTx.forward_jubjub(ref, first.call);
    await record('B -> native account', r.public);
    opening.spentPrev += 5n;
    const second = await material();
    const nested = await a.deployed.callTx.relay_jubjub({ bytes: new Uint8Array(Buffer.from(b.address, 'hex')) }, ref, second.call);
    await record('A -> B -> native account', nested.public);
    opening.spentPrev += 5n;
    await negative('caller-bound replay', () => b.deployed.callTx.forward_jubjub(ref, { ...second.call, spent_prev: opening.spentPrev }), /invalid grant signature|range error/);
    assert.equal((await account.ledgerState()).grants.lookup(id).nonce, 2n);
    // A valid native proof over a forged caller must still fail ledger replay.
    const forged = await material();
    class ForgedCaller extends NativeContract {
        constructor(witnesses: any) {
            super(witnesses);
            const original = this.provableCircuits.withdraw_unshielded_with_grant_jubjub;
            this.provableCircuits.withdraw_unshielded_with_grant_jubjub = async (context: any, ...args: any[]) => {
                const old = context.callContext;
                context.callContext = rt.createCallContext(old.circuitId, old.contractAddress, old.currentZswapLocalState, old.currentQueryContext.state, old.currentPrivateState, old.time, old.parentBlockHash, { tag: 'contract', address: b.address });
                context.queryContexts[old.contractAddress] = context.callContext.currentQueryContext;
                return (original as any)(context, ...args);
            };
        }
    }
    const compiledForged = sdk.CompiledContract.make('forged-caller-control', ForgedCaller).pipe(sdk.CompiledContract.withWitnesses(makeWitnesses()), sdk.CompiledContract.withCompiledFileAssets(zkConfigPath));
    let stage = 'build', hash: string | undefined;
    const forgedProviders = { ...providers,
        proofProvider: { ...providers.proofProvider, proveTx: async (...args: any[]) => { stage = 'prove'; const result = await providers.proofProvider.proveTx(...args); stage = 'balance'; return result; } },
        midnightProvider: { ...providers.midnightProvider, submitTx: async (envelope: any) => { stage = 'node-submit'; hash = envelope.tx.transactionHash(); return providers.midnightProvider.submitTx(envelope); } },
    };
    await pointAt(account);
    await assert.rejects(() => contracts.submitCallTx(forgedProviders, { compiledContract: compiledForged, contractAddress: account.address, circuitId: 'withdraw_unshielded_with_grant_jubjub', privateStateId: account.privateStateId, args: [color, 5n, { bytes: recipient }, ...grantAuthArgs(opening, forged.auth)] }), error => {
        assert.equal(stage, 'node-submit', String(error));
        assert.match(String(error), /Custom error:\s*104\b/);
        h.evidence.negatives.push({ label: 'forged caller with valid native proof', stage, hash, message: String(error) });
        return true;
    });
    assert.equal((await account.ledgerState()).grants.lookup(id).nonce, 2n);
    check('caller-bound grants observe the immediate caller through one and two hops; direct/wrong/replay refused');
}
async function recoverySuite(h: any) {
    const { account, devices, record, check, pointAt, negative, memo } = h;
    await pointAt(account);
    const { successor, next } = await memo('recovery-material', async () => ({ successor: JubjubDevice.generate(), next: recoveryKey(newRecoverySecret().field).pk }));
    let secret: any;
    for (const device of devices) {
        secret = await memo(`recovery-secret-${device.arm}`, async () => newRecoverySecret());
        await memo(`recovery-publish-${device.arm}`, async () => record(`publish_recovery_session_with_${device.arm}`, await account.publishRecoverySession(device, { recoveryPk: recoveryKey(secret.field).pk, sessionNonce: rnd(), phi: [1n, 2n], wrap: rnd(64) })));
        await memo(`recovery-submit-${device.arm}`, async () => record('recover_submit', await account.recoverSubmit(secret.field, successor, next, BigInt(Math.floor(Date.now() / 1000) + 60))));
        await memo(`recovery-early-${device.arm}`, () => negative('early recovery finalise', () => account.recoverFinalise(), /window|early|elapsed|deadline/i));
        await memo(`recovery-cancel-${device.arm}`, async () => record(`recover_cancel_with_${device.arm}`, await account.recoverCancel(device)));
    }
    await record('recover_submit final', await account.recoverSubmit(secret.field, successor, next, BigInt(Math.floor(Date.now() / 1000) + 60)));
    console.log('Waiting for recovery veto deadline');
    for (let i = 0; i < 9; i++)
        await sleep(15000);
    const before = await account.ledgerState();
    await record('recover_finalise', await account.recoverFinalise());
    const after = await account.ledgerState();
    assert.equal(after.device_epoch, before.device_epoch + 1n);
    assert.equal(after.device_count, 1n);
    assert.equal(after.pending_recovery, false);
    await negative('old owner after recovery', () => account.addDevice(devices[0], JubjubDevice.generate()), /enrolled|device|counter|entry/i);
    account.registerDevice(successor.pk);
    await record('successor controls recovered account', await account.appendInbox(successor, rnd(192)));
    check('recovery publication/cancel under every arm, real veto wait, epoch change and successor control');
}
