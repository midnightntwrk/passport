// U1 — receiveUnshielded: user wallet deposits Night into the contract.
//
// Historical context: failed with ledger error 168 on SDK ≤ 3.2.0. The CTO
// did NOT confirm a fix for 168. This test re-runs the deposit and captures
// either a tx hash (PASS) or the specific error code (FAIL).

import { firstValueFrom } from 'rxjs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'U1';

await runTest({
  testId: TEST_ID,
  name: 'receive-unshielded',
  description: 'user → contract: receiveUnshielded',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());

    const unshielded = Object.entries(state.unshielded.balances as Record<string, bigint>);
    if (unshielded.length === 0) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-night-balance',
        note: 'Wallet has no Night to deposit. Did the genesis fund WALLET_SEED?',
        details: { walletAddress: walletCtx.unshieldedKeystore.getBech32Address() },
      };
    }

    const [color, available] = unshielded[0];
    const amount = BigInt(process.env.U1_AMOUNT ?? '1000');
    if (amount > available) {
      return {
        verdict: 'FAIL',
        errorCode: 'insufficient-balance',
        note: `Wallet holds ${available} of ${color}; cannot deposit ${amount}.`,
        details: { color, available: available.toString(), amount: amount.toString() },
      };
    }

    console.log(`Depositing ${amount} of ${color} into ${contract.address}`);
    const result = await contract.found.callTx.deposit_unshielded(hexToBytes32(color), amount);
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    if (!txHash) {
      return {
        verdict: 'PARTIAL',
        note: 'callTx returned without an error but no tx hash was surfaced.',
        details: { rawResult: serialiseShallow(result) },
      };
    }

    return {
      verdict: 'PASS',
      txHash,
      note: 'receiveUnshielded landed on devnet.',
      details: {
        contractAddress: contract.address,
        color,
        amount: amount.toString(),
        blockHeight: result?.public?.blockHeight ?? null,
      },
    };
  },
});

function serialiseShallow(o: any): Record<string, unknown> {
  if (!o || typeof o !== 'object') return { value: String(o) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    out[k] = typeof v === 'bigint' ? v.toString() : (typeof v === 'object' ? '[object]' : v);
  }
  return out;
}
