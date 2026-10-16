// Independent read-back of the accepted ledger transactions and installed keys.
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NativeKeys, ledgerApi, nativeModule } from './adapter.js';
import { allCircuits } from '../../../contract/src/wallet/wave-deploy.js';
import { CONFIG } from '../../../contract/src/node/wallet.js';
const require = createRequire(new URL('../../../contract/package.json', import.meta.url));
const { indexerPublicDataProvider } = await import(require.resolve('@midnight-ntwrk/midnight-js-indexer-public-data-provider'));
const file = process.argv[2] ?? fileURLToPath(new URL('../evidence/localnet.json', import.meta.url));
const evidence = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(evidence.status, 'passed', 'audit requires a completed run');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const accepted = new Set<string>();
const addresses = new Set(evidence.accounts.map((a: any) => a.address));
for (const row of evidence.transactions) {
    const response = await fetch(CONFIG.indexer, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query($offset: TransactionOffset!) { transactions(offset: $offset) { hash raw block { height hash } ... on RegularTransaction { transactionResult { status } } } }', variables: { offset: { identifier: row.id } } }) });
    assert.ok(response.ok);
    const body: any = await response.json();
    assert.equal(body.errors, undefined);
    const tx = body.data.transactions[0];
    assert.ok(tx);
    assert.equal(tx.transactionResult.status, 'SUCCESS');
    const raw = Buffer.from(tx.raw.replace(/^0x/, ''), 'hex');
    const decoded = ledgerApi.Transaction.deserialize('signature', 'proof', 'binding', raw);
    assert.equal(decoded.transactionHash(), tx.hash);
    if (row.hash)
        assert.equal(row.hash, tx.hash);
    if (row.bytes)
        assert.equal(row.bytes, raw.length, 'submitted bytes equal indexed ledger bytes');
    row.hash = tx.hash;
    row.bytes = raw.length;
    row.serialized_sha256 = hash(raw);
    row.status = 'SUCCESS';
    row.block_height = tx.block.height;
    row.block_hash = tx.block.hash;
    row.calls = [...decoded.intents.values()].flatMap((intent: any) => intent.actions.filter((action: any) => action.entryPoint !== undefined).map((action: any) => ({ address: action.address, circuit: typeof action.entryPoint === 'string' ? action.entryPoint : Buffer.from(action.entryPoint).toString('utf8') })));
    for (const call of row.calls)
        if (addresses.has(call.address))
            accepted.add(call.circuit);
}
const pdp = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS), keys = new NativeKeys();
const expectedFingerprints = nativeModule.expectedVk;
evidence.installed_keys = {};
for (const address of addresses) {
    const state: any = await pdp.queryContractState(address);
    assert.ok(state);
    const contract = ledgerApi.ContractState.deserialize(state.serialize());
    assert.equal(contract.maintenanceAuthority.committee.length, 0);
    assert.equal(contract.maintenanceAuthority.threshold, 1);
    const hashes: Record<string, string> = {};
    for (const circuit of allCircuits()) {
        const expected = await keys.getVerifierKey(circuit), seen = contract.operation(circuit)?.verifierKey;
        assert.deepEqual(seen, new Uint8Array(expected));
        hashes[circuit] = hash(seen);
        assert.equal(expectedFingerprints[circuit], hashes[circuit], 'callee module fingerprint matches deployed native key');
    }
    evidence.installed_keys[address as string] = { maintenance_authority_retired: true, verifier_key_sha256: hashes };
    if (address === evidence.account) {
        const ledger = nativeModule.ledger(state.data);
        assert.equal(ledger.device_epoch, 1n);
        assert.equal(ledger.device_count, 1n);
        assert.equal(ledger.pending_recovery, false);
        evidence.recovered_account = { device_epoch: String(ledger.device_epoch), device_count: String(ledger.device_count), pending_recovery: ledger.pending_recovery };
    }
}
evidence.coverage = { accepted: [...accepted].sort(), missing: allCircuits().filter(name => !accepted.has(name)) };
assert.deepEqual(evidence.coverage.missing, []);
evidence.audited_at = new Date().toISOString();
const forged = evidence.negatives.find((item: any) => item.label === 'forged caller with valid native proof');
assert.ok(forged?.hash, 'forged caller reached node submission');
const logs = spawnSync('docker', ['logs', '--since', evidence.started_at, '--until', evidence.completed_at, process.env.MIDNIGHT_NODE_CONTAINER ?? 'minocrab-account-custody-node-1'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
assert.equal(logs.status, 0, logs.error?.message ?? logs.stderr.slice(-1000));
const rejection = `${logs.stdout}\n${logs.stderr}`.split('\n').find(line => line.includes(forged.hash) && line.includes('Rejected transaction'));
assert.ok(rejection, 'node log contains the submitted forged transaction hash');
assert.match(rejection, /mismatch between expected .* and actual .* read/);
forged.node_rejection = rejection;
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceHashes: Record<string, string> = {};
function snapshot(path: string) {
    for (const item of readdirSync(root + path, { withFileTypes: true })) {
        const child = `${path}/${item.name}`;
        if (item.isDirectory())
            snapshot(child);
        else if (!item.name.endsWith('.md'))
            sourceHashes[child] = hash(readFileSync(root + child));
    }
}
for (const path of ['localnet', 'bin/measure/src', 'crates/account-custody/src', '../../contract/src'])
    snapshot(path);
for (const path of [
    'Cargo.toml', 'Cargo.lock', 'bin/measure/Cargo.toml', 'crates/account-custody/Cargo.toml',
    'package.json', 'package-lock.json', '../../contract/package.json', '../../contract/package-lock.json',
    '../../contract/infra/docker-compose.yml', '../../contract/infra/docker-compose.macos.yml',
    'reference/provenance.json', '../../contract/contracts/managed/account/contract/index.js',
])
    sourceHashes[path] = hash(readFileSync(root + path));
const sdkHashes = Object.fromEntries([
    '@midnight-ntwrk/midnight-js-contracts',
    '@midnight-ntwrk/midnight-js-types',
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
    '@midnight-ntwrk/midnight-js-http-client-proof-provider',
    '@midnight-ntwrk/compact-js',
    '@midnight-ntwrk/compact-runtime',
    '@midnightntwrk/ledger-v9',
].map(name => [name, hash(readFileSync(require.resolve(name).replace('/dist/cjs/', '/dist/esm/')))]));
const images = [
    ['node', 'midnightntwrk/midnight-node:2.1.0-rc.4'],
    ['indexer', 'ghcr.io/midnightntwrk/indexer-standalone:4.4.0-rc.6-b5e6c809'],
    ['proof-server', 'midnightntwrk/proof-server:9.0.0-rc.8'],
].map(([service, tag]) => {
    const container = `minocrab-account-custody-${service}-1`;
    const running = JSON.parse(execFileSync('docker', ['inspect', '--type', 'container', '--format', '{"id":{{json .Image}},"tag":{{json .Config.Image}}}', container], { encoding: 'utf8' }));
    assert.equal(running.tag, tag);
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"architecture":{{json .Architecture}}}', running.id], { encoding: 'utf8' }));
    return { container, tag, ...image };
});
evidence.provenance = {
    reference_commit: JSON.parse(readFileSync(root + 'reference/provenance.json', 'utf8')).commit,
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    images,
    audited_sources_sha256: sourceHashes,
    sdk_entry_modules_sha256: sdkHashes,
    rust_bridge_binary_sha256: hash(readFileSync(root + 'target/release/project-custody-measure')),
    native_zkir_sha256: Object.fromEntries(allCircuits().map(name => [name, hash(readFileSync(root + `artifacts/localnet/zkir/${name}.bzkir`))])),
};
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
console.log(`AUDIT PASS: ${evidence.transactions.length} indexed transactions; ${accepted.size} native entrypoints; ${addresses.size} native accounts`);
