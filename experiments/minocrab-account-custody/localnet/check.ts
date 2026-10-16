import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allCircuits } from '../../../contract/src/wallet/wave-deploy.js';
import { ledgerApi, NativeKeys } from './adapter.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const keys = new NativeKeys();
for (const name of allCircuits()) {
    const preimage = readFileSync(`${root}/artifacts/preimages/minocrab/${name}.preimage`);
    const response = await fetch('http://127.0.0.1:6300/check', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ledgerApi.createCheckPayload(preimage, await keys.getZKIR(name)) });
    if (!response.ok)
        throw new Error(`${response.status}: ${await response.text()}`);
    ledgerApi.parseCheckResult(new Uint8Array(await response.arrayBuffer()));
    console.log('PASS proof-server check', name);
}
