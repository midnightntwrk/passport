// Test-only SDK bridge. Reference JS supplies ABI encoding, witnesses and Zswap
// bookkeeping; Rust independently executes both circuits and replaces the public
// transcript with Minocrab's. Only Minocrab keys are installed on the native account.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import * as Reference from '../../../contract/contracts/managed/account/contract/index.js';
import { makeWitnesses } from '../../../contract/src/wallet/witnesses.js';
import { createProviders, CONFIG, managedPath, zkConfigPath } from '../../../contract/src/node/wallet.js';
const require = createRequire(new URL('../../../contract/package.json', import.meta.url));
const resolve = (name: string) => require.resolve(name).replace('/dist/cjs/', '/dist/esm/');
export const rt = await import(resolve('@midnight-ntwrk/compact-runtime'));
export const sdk = await import(resolve('@midnight-ntwrk/compact-js'));
export const contracts = await import(resolve('@midnight-ntwrk/midnight-js-contracts'));
export const types = await import(resolve('@midnight-ntwrk/midnight-js-types'));
const { NodeZkConfigProvider } = await import(resolve('@midnight-ntwrk/midnight-js-node-zk-config-provider'));
const { httpClientProofProvider } = await import(resolve('@midnight-ntwrk/midnight-js-http-client-proof-provider'));
export const ledgerApi = await import(resolve('@midnightntwrk/ledger-v9'));
const root = fileURLToPath(new URL('../', import.meta.url));
// Fail before transacting if the shared SDK oracle has drifted from the benchmark.
const provenance = JSON.parse(readFileSync(`${root}/reference/provenance.json`, 'utf8'));
for (const [group, directory] of [
    ['source_sha256', `${root}/../../contract`],
    ['zkir_sha256', `${root}/../../contract/contracts/managed/account/zkir`],
] as const) {
    for (const [name, expected] of Object.entries(provenance[group])) {
        const actual = createHash('sha256').update(readFileSync(`${directory}/${name}`)).digest('hex');
        assert.equal(actual, expected, `reference drift: ${name}`);
    }
}
export function clean(x: any): any {
    if (x instanceof Uint8Array)
        return [...x];
    if (typeof x === 'bigint')
        return x.toString();
    if (x instanceof Map)
        return [...x].map(clean);
    if (Array.isArray(x))
        return x.map(clean);
    if (x && typeof x === 'object')
        return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v)]));
    return x;
}
export function state(s: any): any {
    if (typeof s.type !== 'function')
        return state(s.state ?? s.data);
    const tag = s.type();
    if (tag === 'null')
        return { tag };
    if (tag === 'cell')
        return { tag, value: clean(s.asCell()) };
    if (tag === 'array')
        return { tag, value: s.asArray().map(state) };
    if (tag === 'map') {
        const m = s.asMap();
        return { tag, value: m.keys().map((k: any) => [clean(k), state(m.get(k))]) };
    }
    throw new Error(`unsupported account state ${tag}`);
}
function revive(x: any): any {
    if (Array.isArray(x))
        return x.map(revive);
    if (!x || typeof x !== 'object')
        return x;
    if ('alignment' in x && 'value' in x)
        return { alignment: x.alignment, value: x.value.map((v: number[]) => new Uint8Array(v)) };
    if (x.tag === 'map') {
        const entries = Array.isArray(x.content) ? x.content : Object.entries(x.content);
        assert.equal(entries.length, 0, 'only empty maps are constructed by account transcripts');
        return { tag: 'map', content: new Map() };
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, revive(v)]));
}
function bridge(command: string, input: any): any {
    const result = spawnSync(`${root}/target/release/project-custody-measure`, [command], {
        input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0)
        throw new Error(`Rust ${command} failed: ${result.stderr}`);
    return revive(JSON.parse(result.stdout));
}
export const executions: {
    circuit: string;
    address: string;
    native_ops: number;
    reference_ops: number;
}[] = [];
export class NativeContract extends Reference.Contract {
    constructor(witnesses: any) {
        super(witnesses);
        for (const [name, original] of Object.entries(this.provableCircuits)) {
            const wrapped = async (context: any, ...args: any[]) => {
                const result = await (original as any)(context, ...args);
                const trace = result.context.callProofDataTrace;
                const entry = trace.at(-1);
                assert.equal(entry.circuitId, name);
                const q = entry.initialQueryContext, block = q.block;
                const ops = bridge('localnet-execute', {
                    name, address: [...Buffer.from(entry.contractAddress, 'hex')], before: state(q.state), after: state(entry.finalQueryContext.state),
                    input: clean(entry.input), output: clean(entry.output), witnesses: clean(entry.privateTranscriptOutputs),
                    time: Number(block.secondsSinceEpoch), time_error: block.secondsSinceEpochErr, last_block_time: Number(block.lastBlockTime),
                    parent_block_hash: block.parentBlockHash, caller: block.caller ?? null,
                    commitments: [...q.comIndices].map(([k, v]: any) => [k, Number(v)]), balances: clean(block.balance),
                });
                const native = q.query(ops.map((op: any) => op?.popeq ? { popeq: { ...op.popeq, result: null } } : op), result.context.costModel, result.context.gasLimit);
                assert.deepEqual(state(native.context.state), state(entry.finalQueryContext.state), 'native VM post-state');
                assert.deepEqual(native.context.effects, entry.finalQueryContext.effects, 'native VM effects');
                executions.push({ circuit: name, address: entry.contractAddress, native_ops: ops.length, reference_ops: entry.publicTranscript.length });
                entry.publicTranscript = ops;
                entry.finalQueryContext = native.context;
                result.context.callContext.currentQueryContext = native.context;
                result.context.queryContexts[entry.contractAddress] = native.context;
                result.context.callContext.currentGasCost = native.gasCost;
                result.context.gasCosts[entry.contractAddress] = native.gasCost;
                return result;
            };
            (this.provableCircuits as any)[name] = wrapped;
            (this.circuits as any)[name] = wrapped;
        }
    }
    async initialState(...args: any[]) {
        const initialized = await (super.initialState as any)(...args);
        const native = rt.StateValue.decode(bridge('localnet-constructor', state(initialized.currentContractState)));
        assert.deepEqual(state(native), state(initialized.currentContractState));
        initialized.currentContractState.data = new rt.ChargedState(native);
        return initialized;
    }
}
export const nativeModule = {
    ...Reference,
    Contract: NativeContract,
    get expectedVk() {
        return Object.fromEntries(Object.keys(Reference.expectedVk).map(name => [name,
            createHash('sha256').update(readFileSync(`${root}/artifacts/localnet/keys/${name}.verifier`)).digest('hex'),
        ]));
    },
};
export class NativeKeys extends types.ZKConfigProvider {
    async getArtifactRuntimeVersion() { return '0.20.0'; }
    async getProverKey(id: string) { return types.createProverKey(readFileSync(`${root}/artifacts/localnet/keys/${id}.prover`)); }
    async getVerifierKey(id: string) { return types.createVerifierKey(readFileSync(`${root}/artifacts/localnet/keys/${id}.verifier`)); }
    async getZKIR(id: string) { return types.createZKIR(readFileSync(`${root}/artifacts/localnet/zkir/${id}.bzkir`)); }
}
export function compiledNative() {
    return sdk.CompiledContract.make('account-minocrab', NativeContract).pipe(sdk.CompiledContract.withWitnesses(makeWitnesses()), sdk.CompiledContract.withCompiledFileAssets(zkConfigPath));
}
export async function nativeProviders(wallet: any, assetPath = zkConfigPath, nativeAccount = true) {
    const providers = await createProviders(wallet, assetPath);
    const registry = new types.ZKConfigRegistry([new NativeKeys(), ...readdirSync(managedPath).map(name => new NodeZkConfigProvider(`${managedPath}/${name}`))]);
    if (nativeAccount)
        providers.zkConfigProvider = new NativeKeys() as any;
    providers.proofProvider = httpClientProofProvider(CONFIG.proofServer, registry);
    return providers;
}
