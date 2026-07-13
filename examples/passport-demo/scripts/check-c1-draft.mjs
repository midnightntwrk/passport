import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { signingKeyFromBip340 } from '@midnight-ntwrk/compact-runtime';
import { sampleCoinPublicKey, sampleEncryptionPublicKey } from '@midnight-ntwrk/ledger-v8';
import { createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createVerifierKey } from '@midnight-ntwrk/midnight-js-types';

import { Contract, pureCircuits } from '../.generated/passport-c1/contract/index.js';

const deviceSecret = new Uint8Array(32).fill(17);
const maintenanceSource = new Uint8Array(32).fill(29);

try {
  setNetworkId('preview');

  const compiledContract = CompiledContract.make('passport_c1', Contract).pipe(
    CompiledContract.withWitnesses({
      device_secret(context) {
        return [context.privateState, context.privateState.deviceSecret];
      },
    }),
    CompiledContract.withCompiledFileAssets('/zk/passport-c1'),
  );

  const draft = await createUnprovenDeployTx({
    zkConfigProvider: {
      async getVerifierKey(circuitId) {
        const path = new URL(`../.generated/passport-c1/keys/${circuitId}.verifier`, import.meta.url);
        return createVerifierKey(new Uint8Array(await readFile(path)));
      },
    },
    walletProvider: {
      getCoinPublicKey: () => sampleCoinPublicKey(),
      getEncryptionPublicKey: () => sampleEncryptionPublicKey(),
    },
  }, {
    compiledContract,
    signingKey: signingKeyFromBip340(maintenanceSource),
    initialPrivateState: { deviceSecret },
    args: [pureCircuits.derive_device_commitment(deviceSecret)],
  });

  const serialized = draft.private.unprovenTx.serialize();
  assert.match(String(draft.public.contractAddress), /^[0-9a-f]{64}$/i);
  assert.ok(serialized instanceof Uint8Array && serialized.byteLength > 100, 'Expected a non-empty unsigned C1 transaction.');
  process.stdout.write('C1 deployment draft check passed.\n');
} finally {
  deviceSecret.fill(0);
  maintenanceSource.fill(0);
}
