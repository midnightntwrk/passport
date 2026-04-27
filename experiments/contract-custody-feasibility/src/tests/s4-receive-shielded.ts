// S4 — receiveShielded: user sends shielded tokens to a contract.
//
// **The most critical net-new test in the entire experiment.** This test
// originally surfaced as FAIL because the runner passed the user-supplied
// (contract-scoped) color into the ShieldedCoinInfo, but the wallet
// indexes notes by the *on-chain* color, which is derived from
// (contract_address, contract_scoped_color).
//
// The fix is the recipe demonstrated in `midnight-receive-shielded-sdk-gap-repro`:
//
//     import { rawTokenType, encodeRawTokenType, encodeShieldedCoinInfo }
//       from '@midnight-ntwrk/ledger-v8';
//     const onChainColor = encodeRawTokenType(
//       rawTokenType(contractScopedColor, contractAddress),
//     );
//     await contract.callTx.receive_shielded(
//       encodeShieldedCoinInfo({ type: onChainColor, nonce, value }),
//     );
//
// `rawTokenType` and the `availableCoins` enumeration are both real public
// SDK surfaces — the prior FAIL was operator error, not an SDK gap.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import {
  rawTokenType,
  encodeRawTokenType,
} from '@midnight-ntwrk/ledger-v8';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S4';
const SHIELDED_COLOR_HEX = process.env.S4_COLOR ?? '00'.repeat(31) + '04';

await runTest({
  testId: TEST_ID,
  name: 'receive-shielded',
  description: 'user → contract: receive_shielded (NET-NEW, the dealbreaker)',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());
    const coinPubKey = state.shielded.coinPublicKey;
    const coinHex =
      typeof coinPubKey?.toHexString === 'function'
        ? coinPubKey.toHexString()
        : String(coinPubKey?.bytes ?? coinPubKey);
    const userShieldedKey = { bytes: hexToBytes32(coinHex) };
    const amount = BigInt(process.env.S4_AMOUNT ?? '500');
    const setupNonce = new Uint8Array(randomBytes(32));
    const SHIELDED_COLOR = hexToBytes32(SHIELDED_COLOR_HEX);

    // ── Setup: mint a fresh shielded note to the user wallet ───────────────
    console.log(`Setup: minting ${amount} shielded to user with nonce ${shortHex(setupNonce)}`);
    const setupResult = await contract.found.callTx.mint_and_send_shielded(
      SHIELDED_COLOR,
      amount,
      setupNonce,
      userShieldedKey,
    );
    const setupTx = setupResult?.public?.txId ?? setupResult?.public?.transactionHash;
    if (!setupTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'setup-failed',
        note: 'Setup mint_and_send_shielded did not land.',
        details: {},
      };
    }

    console.log('Waiting 15s for the wallet to index the new note...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── Derive the on-chain color the wallet indexes by ────────────────────
    //
    // The wallet stores notes under a derived on-chain color, not the
    // contract-scoped color the source code uses. ledger-v8 exports the
    // exact derivation primitive.
    const derivedRawHex = rawTokenType(SHIELDED_COLOR, contract.address);
    const derivedColor = encodeRawTokenType(derivedRawHex);
    console.log(`Derived on-chain color: 0x${derivedRawHex.replace(/^0x/, '')}`);

    // Sanity-check that the wallet actually has a note under that color.
    const stateAfter = await firstValueFrom(walletCtx.wallet.state());
    const walletColors = Object.keys(stateAfter.shielded.balances as Record<string, bigint>);
    const matchesDerived = walletColors.some(
      (c) => c.replace(/^0x/, '') === derivedRawHex.replace(/^0x/, ''),
    );
    if (!matchesDerived) {
      console.log('  ⚠ wallet does not yet show a balance under the derived color.');
      console.log(`  wallet colors: ${walletColors.map((c) => '0x' + c.slice(0, 10) + '…').join(', ')}`);
    }

    // ── The S4 call: user → contract via receive_shielded ──────────────────
    //
    // Pass the struct directly (same shape as Demo B in the tutorial repo):
    //   nonce: Uint8Array(32)
    //   color: Uint8Array(32) — the on-chain color from rawTokenType
    //   value: bigint
    // `encodeShieldedCoinInfo` is for the wallet-availableCoins path and
    // expects hex-string fields (Demo C in the tutorial); we don't need it.
    const coin = {
      nonce: setupNonce,
      color: derivedColor,
      value: amount,
    };
    console.log(`S4: user → contract: receive_shielded (rawTokenType-derived color)`);
    const result = await contract.found.callTx.receive_shielded(coin);
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    if (!txHash) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-tx-hash',
        note: 'receive_shielded callTx returned without a tx hash.',
        details: { contractAddress: contract.address, setupTx, derivedColor: derivedRawHex },
      };
    }

    return {
      verdict: 'PASS',
      txHash,
      note: 'receive_shielded user → contract confirmed on devnet using the rawTokenType-derived on-chain color. Shielded contract custody is feasible on v1 with a public ledger-v8 surface.',
      details: {
        contractAddress: contract.address,
        contractScopedColor: SHIELDED_COLOR_HEX,
        derivedOnChainColor: derivedRawHex,
        amount: amount.toString(),
        setupTx,
        recipe: 'receive_shielded({nonce, color: encodeRawTokenType(rawTokenType(color, contractAddress)), value})',
      },
    };
  },
});

function shortHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex').slice(0, 12) + '…';
}
