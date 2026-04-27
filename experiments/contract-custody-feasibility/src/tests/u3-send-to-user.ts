// U3 — sendUnshielded → UserAddress: contract sends Night to a user wallet.
//
// Known to work since midnight-js-contracts v3.2.0. Re-run as a regression
// check on the latest v1 SDK.

import { firstValueFrom } from 'rxjs';
import { Buffer } from 'node:buffer';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'U3';

await runTest({
  testId: TEST_ID,
  name: 'send-to-user',
  description: 'contract → user: sendUnshielded → UserAddress',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());

    const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
    if (held.length === 0) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-balance-to-send',
        note: 'Contract has no Night to send. Run U1 first.',
        details: {},
      };
    }

    const [color] = held[0];
    const amount = BigInt(process.env.U3_AMOUNT ?? '50');
    // UserAddress is a struct {bytes: Bytes<32>}. The keystore's PublicKey
    // exposes `bytes` as a hex string; the JS binding wants Uint8Array.
    // Convert via hexToBytes32 — works whether the source is hex string,
    // Uint8Array, or has a .toHexString()/.toBytes() method.
    const userPk: any = walletCtx.unshieldedKeystore.getPublicKey();
    const userBytesHex: string =
      typeof userPk?.toHexString === 'function'
        ? userPk.toHexString()
        : typeof userPk?.bytes === 'string'
        ? userPk.bytes
        : userPk?.bytes instanceof Uint8Array
        ? Buffer.from(userPk.bytes).toString('hex')
        : String(userPk);
    const recipient = { bytes: hexToBytes32(userBytesHex) };

    console.log(`Sending ${amount} of ${color} from ${contract.address} → user`);
    const result = await contract.found.callTx.send_unshielded_to_user(
      hexToBytes32(color),
      amount,
      recipient,
    );
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    return {
      verdict: txHash ? 'PASS' : 'PARTIAL',
      txHash,
      note: txHash
        ? 'sendUnshielded → UserAddress accepted (regression check on v1).'
        : 'callTx returned without surfacing a tx hash.',
      details: {
        from: contract.address,
        toUser: walletCtx.unshieldedKeystore.getBech32Address(),
        color,
        amount: amount.toString(),
      },
    };
  },
});
