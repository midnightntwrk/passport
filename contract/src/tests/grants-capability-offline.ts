// The client must refuse an old account before asking its device to sign,
// and the externally signed entrypoint must enforce the same schema check.
import { strict as assert } from 'node:assert';
import { CustodyAccount } from '../wallet/account.js';
import { JubjubDevice, readOnlyScope, type Authorisation } from '../wallet/signer.js';
import { runScenario, step } from './runner.js';

void runScenario('grants-capability-offline', async () => {
  const device = JubjubDevice.generate();
  const bytes = new Uint8Array(32);
  const scope = readOnlyScope({ expiresAt: 0n, readPkHash: Uint8Array.from({ length: 32 }, () => 1) });
  const auth: Authorisation = device.sign(() => bytes, 0n);
  let signingContexts = 0, submissions = 0;
  const account = Object.create(CustodyAccount.prototype) as CustodyAccount;
  Object.assign(account, {
    callContext: async () => { signingContexts++; throw new Error('unexpected signing context'); },
    handle: { callTx: { issue_grant_with_jubjub: async () => {
      submissions++;
      return { public: { txId: 'accepted-v3' } };
    } } },
  });

  step('v1, v2 and missing schema refuse before signing or submission');
  for (const version of [1n, 2n, undefined]) {
    Object.assign(account, { ledgerState: async () => ({ spec_version: version }) });
    await assert.rejects(() => account.issueGrant(device, bytes, scope, bytes), /account_not_capable/);
    await assert.rejects(() => account.issueGrantWithAuth(bytes, scope, bytes, auth), /account_not_capable/);
  }
  assert.equal(signingContexts, 0);
  assert.equal(submissions, 0);

  step('current schema permits an externally signed grant to reach submission');
  Object.assign(account, { ledgerState: async () => ({ spec_version: 3n }) });
  assert.deepEqual(await account.issueGrantWithAuth(bytes, scope, bytes, auth), { txId: 'accepted-v3' });
  assert.equal(submissions, 1);
});
