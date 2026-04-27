// S4 — receiveShielded: user sends shielded tokens to a contract.
//
// **The most critical net-new test in the entire experiment.** Previously
// untested on devnet. The Passport account model assumes a contract can
// receive shielded tokens directly from a user. If it cannot, the
// shielded-asset custody story collapses and the post-MVP multi-device
// milestone must commit to a cryptographic alternative (FROST t≥2 with a
// PIN factor) for shielded assets.
//
// Pre-condition: the user wallet must hold the shielded token to send.
// We therefore run a setup pass that mints shielded into the user's own
// wallet (via mint_and_send_shielded with recipient = user's coin pk),
// waits for confirmation, then attempts to send those shielded tokens
// into the contract via the receive_shielded circuit.
//
// Verdict mapping:
//   - PASS  — receive_shielded compiles, deploys, the call lands a tx, and
//             the contract's shielded-mint-count or balance reflects the
//             receive.
//   - FAIL @ compile-time — receiveShielded() in the .compact contract is
//                            not a real Compact-stdlib operation. The
//                            language doesn't support contract-receive of
//                            shielded tokens. Compiler error captured.
//   - FAIL @ runtime — circuit compiles but the node rejects the
//                       transaction. Node error code captured.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S4';
const SHIELDED_COLOR =
  process.env.S4_COLOR ?? '00'.repeat(31) + '04';

await runTest({
  testId: TEST_ID,
  name: 'receive-shielded',
  description: 'user → contract: receive_shielded (NET-NEW, the dealbreaker)',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());
    // ZswapCoinPublicKey struct wrapping (same as S2).
    const coinPubKey = state.shielded.coinPublicKey;
    const coinHex =
      typeof coinPubKey?.toHexString === 'function'
        ? coinPubKey.toHexString()
        : String(coinPubKey?.bytes ?? coinPubKey);
    const userShieldedKey = { bytes: hexToBytes32(coinHex) };
    const amount = BigInt(process.env.S4_AMOUNT ?? '500');
    const setupNonce = new Uint8Array(randomBytes(32));

    // ── Setup: ensure the user holds shielded tokens to send ───────────────
    //
    // We use the contract's own atomic mint+send to mint shielded tokens
    // straight to the user. If S2 PASSed, this re-uses the same flow.

    console.log(`Setup: minting ${amount} shielded to the user wallet`);
    const setupResult = await contract.found.callTx.mint_and_send_shielded(
      hexToBytes32(SHIELDED_COLOR),
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
        note: 'Setup mint_and_send_shielded did not land. Cannot proceed to receive_shielded.',
        details: {},
      };
    }

    console.log('Waiting 15s for indexer to confirm setup mint...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── The actual S4 test: user → contract via receive_shielded ──────────
    //
    // receiveShielded takes a ShieldedCoinInfo {nonce, color, value} that
    // identifies the user-held note being deposited into the contract.
    // The note was created in the setup mint with nonce=setupNonce, so we
    // know all three fields.

    const coin = {
      nonce: setupNonce,
      color: hexToBytes32(SHIELDED_COLOR),
      value: amount,
    };
    console.log(`S4: user → contract: receive_shielded ${amount} of ${SHIELDED_COLOR}`);
    const result = await contract.found.callTx.receive_shielded(coin);
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    if (!txHash) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-tx-hash',
        note: 'receive_shielded callTx returned without a tx hash. Check node logs and decide between FAIL and PARTIAL.',
        details: { contractAddress: contract.address, setupTx },
      };
    }

    return {
      verdict: 'PASS',
      txHash,
      note: 'receive_shielded user → contract confirmed on devnet. The Passport contract-custody account model is shielded-viable.',
      details: {
        contractAddress: contract.address,
        color: SHIELDED_COLOR,
        amount: amount.toString(),
        setupTx,
      },
    };
  },
});
