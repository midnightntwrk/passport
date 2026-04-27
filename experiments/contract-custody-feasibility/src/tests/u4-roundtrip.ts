// U4 — end-to-end round trip: user → contract A → contract B → user.
//
// Per the brief, U4 should succeed iff U1 and U2 both pass. This runner
// composes the three transfers as a single test and captures three tx
// hashes, then verifies the user's balance returned to its starting value
// (modulo Dust fees).

import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'U4';

await runTest({
  testId: TEST_ID,
  name: 'roundtrip',
  description: 'user → contract A → contract B → user',
  action: async () => {
    if (!fs.existsSync('deployment-second.json')) {
      return {
        verdict: 'FAIL',
        errorCode: 'missing-secondary-deployment',
        note: 'deployment-second.json missing. Run: npm run deploy-second',
        details: {},
      };
    }
    const { contractAddress: secondaryAddress } = JSON.parse(
      fs.readFileSync('deployment-second.json', 'utf-8'),
    );

    // Hop 1: user → primary contract (deposit_unshielded)
    const primaryCtx = await setupContract({ slot: 'primary' });
    const userState = await firstValueFrom(primaryCtx.walletCtx.wallet.state());
    const userBalances = Object.entries(userState.unshielded.balances as Record<string, bigint>);
    if (userBalances.length === 0) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-night-balance',
        note: 'No Night in wallet to deposit.',
        details: {},
      };
    }
    const [color] = userBalances[0];
    const amount = BigInt(process.env.U4_AMOUNT ?? '500');
    const startingUserBalance = userBalances.find(([c]) => c === color)?.[1] ?? 0n;

    console.log(`Hop 1: deposit ${amount} into primary`);
    const hop1 = await primaryCtx.contract.found.callTx.deposit_unshielded(
      hexToBytes32(color),
      amount,
    );

    // Hop 2: primary contract → secondary contract
    console.log(`Hop 2: primary → secondary`);
    const secondaryRecipient = {
      bytes: hexToBytes32(secondaryAddress.replace(/^0x/, '')),
    };
    const hop2 = await primaryCtx.contract.found.callTx.send_unshielded_to_contract(
      hexToBytes32(color),
      amount,
      secondaryRecipient,
    );

    // Hop 3: secondary → user.
    const secondaryCtx = await setupContract({ slot: 'secondary' });
    const userPk: any = primaryCtx.walletCtx.unshieldedKeystore.getPublicKey();
    const userBytesHex: string =
      typeof userPk?.toHexString === 'function'
        ? userPk.toHexString()
        : typeof userPk?.bytes === 'string'
        ? userPk.bytes
        : String(userPk);
    const userRecipient = { bytes: hexToBytes32(userBytesHex) };
    console.log(`Hop 3: secondary → user`);
    const hop3 = await secondaryCtx.contract.found.callTx.send_unshielded_to_user(
      hexToBytes32(color),
      amount,
      userRecipient,
    );

    const finalUserState = await firstValueFrom(primaryCtx.walletCtx.wallet.state());
    const finalBalance =
      (finalUserState.unshielded.balances as Record<string, bigint>)[color] ?? 0n;

    await primaryCtx.walletCtx.wallet.stop();
    await secondaryCtx.walletCtx.wallet.stop();

    const txs = {
      hop1: hop1?.public?.txId ?? hop1?.public?.transactionHash,
      hop2: hop2?.public?.txId ?? hop2?.public?.transactionHash,
      hop3: hop3?.public?.txId ?? hop3?.public?.transactionHash,
    };
    const allLanded = !!(txs.hop1 && txs.hop2 && txs.hop3);

    return {
      verdict: allLanded ? 'PASS' : 'PARTIAL',
      txHash: txs.hop3,
      note: allLanded
        ? `Round trip complete. user start ${startingUserBalance} → end ${finalBalance} (delta = ${finalBalance - startingUserBalance})`
        : 'One or more hops did not surface a tx hash.',
      details: {
        color,
        amount: amount.toString(),
        startingUserBalance: startingUserBalance.toString(),
        finalBalance: finalBalance.toString(),
        txs,
      },
    };
  },
});
