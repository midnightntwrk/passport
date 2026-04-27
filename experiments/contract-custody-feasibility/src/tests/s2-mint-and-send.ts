// S2 — atomic mint+send shielded: contract mints a shielded token and sends
// it to the user inside a single circuit invocation. Known to work; this is
// the pattern that bypasses cross-block shielded custody and is what
// existing dApps use today.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S2';
const SHIELDED_COLOR =
  process.env.S2_COLOR ?? '00'.repeat(31) + '02';

await runTest({
  testId: TEST_ID,
  name: 'mint-and-send',
  description: 'atomic mint+send shielded → user',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());
    const amount = BigInt(process.env.S2_AMOUNT ?? '500');
    const nonce = new Uint8Array(randomBytes(32));

    // ZswapCoinPublicKey is a struct {bytes: Bytes<32>}. The wallet state's
    // coinPublicKey is a class with .toHexString(); wrap as the struct.
    const coinPubKey = state.shielded.coinPublicKey;
    const coinHex =
      typeof coinPubKey?.toHexString === 'function'
        ? coinPubKey.toHexString()
        : String(coinPubKey?.bytes ?? coinPubKey);
    const recipientShieldedKey = { bytes: hexToBytes32(coinHex) };

    console.log(`Atomic mint+send ${amount} shielded → user`);
    const result = await contract.found.callTx.mint_and_send_shielded(
      hexToBytes32(SHIELDED_COLOR),
      amount,
      nonce,
      recipientShieldedKey,
    );
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    return {
      verdict: txHash ? 'PASS' : 'PARTIAL',
      txHash,
      note: txHash
        ? 'sendImmediateShielded landed (atomic mint+send regression OK).'
        : 'callTx returned without surfacing a tx hash.',
      details: {
        contractAddress: contract.address,
        color: SHIELDED_COLOR,
        amount: amount.toString(),
      },
    };
  },
});
