import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compiledNative, nativeProviders, executions, clean, ledgerApi } from './adapter.js';
import { createWallet, syncWallet } from '../../../contract/src/node/wallet.js';
import { CustodyAccount } from '../../../contract/src/wallet/account.js';
import { K256Device, JubjubDevice } from '../../../contract/src/wallet/signer.js';
import { softwarePasskey } from '../../../contract/src/tests/p256-fixtures.js';
import { generateEncKeyPair } from '../../../contract/src/wallet/inbox.js';
import { queryTxPosition } from '../../../contract/src/wallet/capture.js';
import { allCircuits } from '../../../contract/src/wallet/wave-deploy.js';
const out = fileURLToPath(new URL('../evidence/localnet.json', import.meta.url));
const evidence: any = { started_at: new Date().toISOString(), status: 'running', transactions: [], accounts: [], checks: [], negatives: [], executions };
const persist = () => writeFileSync(out, JSON.stringify(clean(evidence), null, 2) + '\n');
const rnd = (n = 32) => new Uint8Array(randomBytes(n));
let wallet: any;
try {
    wallet = await createWallet(process.env.WALLET_SEED ?? '0'.repeat(63) + '1');
    await syncWallet(wallet, 'minocrab-localnet');
    const providers = await nativeProviders(wallet);
    let label = 'deployment';
    const instrument = (p: any) => {
        const submit = p.midnightProvider.submitTx.bind(p.midnightProvider);
        p.midnightProvider.submitTx = async (envelope: any) => {
            const tx = envelope.tx;
            const calls = [...tx.intents.values()].flatMap((intent: any) => intent.actions.filter((action: any) => action.entryPoint !== undefined).map((action: any) => ({ address: action.address, circuit: typeof action.entryPoint === 'string' ? action.entryPoint : Buffer.from(action.entryPoint).toString('utf8') })));
            const entry = { label, hash: tx.transactionHash(), bytes: tx.serialize().length, calls, submitted_at: new Date().toISOString() };
            const id = await submit(envelope);
            evidence.transactions.push({ ...entry, id });
            persist();
            return id;
        };
    };
    instrument(providers);
    const record = async (name: string, result: any) => {
        const position = await queryTxPosition(result.txId);
        assert.equal(position.status, 'SUCCESS', `${name}: ${JSON.stringify(position)}`);
        assert.equal(position.error, undefined);
        const tx = evidence.transactions.find((t: any) => t.id === result.txId);
        if (tx)
            Object.assign(tx, { label: name, status: position.status, block_height: position.blockHeight });
        else
            evidence.transactions.push({ label: name, id: result.txId, status: position.status, block_height: position.blockHeight, scaffolding: true });
        persist();
        console.log('ACCEPTED', name, result.txId);
        return result;
    };
    const check = (name: string) => { evidence.checks.push(name); persist(); console.log('CHECK', name); };
    const pointAt = async (a: any) => providers.privateStateProvider.setContractAddress(a.address);
    const negative = async (name: string, fn: () => Promise<any>, pattern: RegExp) => {
        const count = evidence.transactions.length;
        await assert.rejects(fn, error => { assert.match(String(error), pattern); evidence.negatives.push({ label: name, stage: 'construction', message: String(error) }); return true; });
        assert.equal(evidence.transactions.length, count, 'negative did not submit');
        persist();
    };
    const verifyKeys = async (a: any) => {
        const onchain: any = await providers.publicDataProvider.queryContractState(a.address);
        const deployed = ledgerApi.ContractState.deserialize(onchain.serialize());
        for (const id of allCircuits())
            assert.deepEqual(deployed.operation(id)?.verifierKey, new Uint8Array(await providers.zkConfigProvider.getVerifierKey(id)), id);
        assert.equal(deployed.maintenanceAuthority.committee.length, 0);
        assert.equal(deployed.maintenanceAuthority.threshold, 1);
        check(`all 52 on-chain Minocrab keys match; authority retired: ${a.address}`);
    };
    const owner = K256Device.generate();
    console.log('Deploying independent Minocrab account, all 52 keys');
    const account = await CustodyAccount.deploy(providers, compiledNative(), owner, generateEncKeyPair(), { recovery: { recoveryPk: JubjubDevice.generate().pk, wrap: new Uint8Array(64), vetoWindowSeconds: 60n } });
    evidence.account = account.address;
    persist();
    evidence.accounts.push({ role: 'primary', address: account.address });
    await verifyKeys(account);
    const j = JubjubDevice.generate(), p = softwarePasskey().device;
    for (const device of [j, p])
        await account.addDevice(owner, device);
    for (const device of [owner, j, p]) {
        const extra = JubjubDevice.generate();
        await account.addDevice(device, extra);
        await account.removeDevice(device, extra);
        await account.appendInbox(device, rnd(192));
        await account.rotateEncKey(device, rnd());
    }
    assert.equal((await account.ledgerState()).device_count, 3n);
    check('k256, JubJub and P256 device lifecycle accepted');
    const context = { wallet, providers, account, devices: [owner, j, p], evidence, record, check, pointAt, negative, verifyKeys, instrument };
    for (;;) {
        const revision = Date.now();
        try {
            const { fundedSuite } = await import(`./suite.js?revision=${revision}`);
            await fundedSuite(context);
            break;
        }
        catch (error) {
            if (!process.argv.includes('--retry-suite'))
                throw error;
            (evidence.suite_attempts ??= []).push({ at: new Date().toISOString(), error: String(error) });
            persist();
            console.error('SUITE FAILED; waiting for artifacts/localnet/retry to change', error);
            const retry = fileURLToPath(new URL('../artifacts/localnet/retry', import.meta.url));
            const previous = existsSync(retry) ? statSync(retry).mtimeMs : 0;
            while (!existsSync(retry) || statSync(retry).mtimeMs === previous)
                await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    for (const tx of evidence.transactions) {
        if (tx.status === 'SUCCESS')
            continue;
        const position = await queryTxPosition(tx.id);
        assert.equal(position.status, 'SUCCESS');
        assert.equal(position.error, undefined);
        Object.assign(tx, { status: position.status, block_height: position.blockHeight });
        persist();
    }
    const nativeAddresses = new Set(evidence.accounts.map((a: any) => a.address));
    const covered = new Set(evidence.transactions.flatMap((t: any) => (t.calls ?? []).filter((c: any) => nativeAddresses.has(c.address)).map((c: any) => c.circuit)));
    evidence.coverage = { accepted: [...covered].sort(), missing: allCircuits().filter(id => !covered.has(id)) };
    assert.deepEqual(evidence.coverage.missing, [], 'all 52 native entrypoints accepted');
    evidence.status = 'passed';
    evidence.completed_at = new Date().toISOString();
    persist();
    console.log('PASS', evidence.transactions.length, 'transactions');
}
catch (error: any) {
    evidence.status = 'failed';
    evidence.error = String(error?.stack ?? error);
    persist();
    console.error(error);
    process.exitCode = 1;
}
finally {
    if (wallet)
        await wallet.wallet.stop();
}
