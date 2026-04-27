// S3 — cross-transaction shielded custody: a contract holds shielded
// tokens for one or more blocks, then sends them in a later transaction.
//
// Historical blocker: "Merkle tree not rehashed" — the Zswap protocol
// previously did not let a contract-owned shielded note be referenced
// from a later transaction. Whether v1 still has this constraint is
// what S3 measures.
//
// Procedure:
//   1. Run mint_shielded_to_self (same circuit as S1) to put shielded
//      notes on the contract.
//   2. Wait for the indexer to confirm the mint block.
//   3. In a separate transaction, call send_held_shielded.
//   4. PASS iff both txs land. FAIL if step 3 trips the Merkle rehash
//      error or a similar protocol-level rejection.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { firstValueFrom } from 'rxjs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S3';
const SHIELDED_COLOR =
  process.env.S3_COLOR ?? '00'.repeat(31) + '03';

await runTest({
  testId: TEST_ID,
  name: 'cross-tx-custody',
  description: 'mint shielded to contract, then send from held in a later block',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const amount = BigInt(process.env.S3_AMOUNT ?? '500');
    const mintNonce = new Uint8Array(randomBytes(32));

    // Hop 1 — mint shielded to contract.
    console.log(`Hop 1: mint ${amount} shielded to contract`);
    const mintResult = await contract.found.callTx.mint_shielded_to_self(
      hexToBytes32(SHIELDED_COLOR),
      amount,
      mintNonce,
    );
    const mintTx = mintResult?.public?.txId ?? mintResult?.public?.transactionHash;
    if (!mintTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'mint-step-no-tx',
        note: 'mint_shielded_to_self did not surface a tx hash.',
        details: {},
      };
    }

    // Wait for indexer to advance one block before attempting the send.
    console.log('Waiting 15s for indexer to settle the mint block...');
    await new Promise((r) => setTimeout(r, 15_000));

    // Hop 2 — send shielded from held balance.
    //
    // sendShielded requires a QualifiedShieldedCoinInfo {nonce, color, value,
    // mt_index}. nonce, color, and value we know — but mt_index is set by
    // the ledger when the mint commits. The off-chain prover must look it
    // up. This is itself the precise shape of the "Merkle rehash" finding.
    //
    // Look-up strategies, in order of preference:
    //   1. providers.publicDataProvider exposes a contract-utxo query
    //      (probe at runtime).
    //   2. Fall back to env var S3_MT_INDEX, set by hand from the indexer
    //      after running U1/S1 once.
    //   3. Try mt_index = 0n and let the runtime error reveal whether
    //      the lookup is needed.

    const state = await firstValueFrom(walletCtx.wallet.state());
    const recipientShieldedKey = state.shielded.coinPublicKey;

    let mtIndex: bigint | null = null;
    let mtIndexSource: string;
    try {
      const provs: any = (walletCtx as any).__providers ?? null;
      if (provs?.publicDataProvider?.queryContractShieldedNotes) {
        const notes = await provs.publicDataProvider.queryContractShieldedNotes(
          contract.address,
          hexToBytes32(SHIELDED_COLOR),
        );
        if (Array.isArray(notes) && notes.length > 0) {
          mtIndex = BigInt(notes[0].mt_index ?? notes[0].mtIndex ?? 0);
          mtIndexSource = 'publicDataProvider';
        } else {
          mtIndexSource = 'publicDataProvider-empty';
        }
      } else {
        mtIndexSource = 'no-publicDataProvider-api';
      }
    } catch (e: any) {
      mtIndexSource = `lookup-error:${e?.message ?? e}`;
    }
    if (mtIndex === null && process.env.S3_MT_INDEX) {
      mtIndex = BigInt(process.env.S3_MT_INDEX);
      mtIndexSource = 'env-S3_MT_INDEX';
    }
    if (mtIndex === null) {
      mtIndex = 0n;
      mtIndexSource = 'fallback-0';
    }

    const coin = {
      nonce:    mintNonce,
      color:    hexToBytes32(SHIELDED_COLOR),
      value:    amount,
      mt_index: mtIndex,
    };

    console.log(`Hop 2: send_held_shielded → user (mt_index=${mtIndex} via ${mtIndexSource})`);
    const sendResult = await contract.found.callTx.send_held_shielded(
      coin,
      recipientShieldedKey,
      amount,
    );
    const sendTx = sendResult?.public?.txId ?? sendResult?.public?.transactionHash;

    await walletCtx.wallet.stop();

    return {
      verdict: sendTx ? 'PASS' : 'PARTIAL',
      txHash: sendTx,
      note: sendTx
        ? `Cross-tx shielded custody confirmed: contract held shielded notes across blocks and spent them later (mt_index source: ${mtIndexSource}).`
        : `send_held_shielded did not surface a tx hash. mt_index source: ${mtIndexSource}. The "Merkle rehash" finding's exact shape is whether the off-chain prover can recover the contract-held note's mt_index — capture node logs.`,
      details: {
        mintTx,
        mintNonce: Buffer.from(mintNonce).toString('hex'),
        sendTx,
        color: SHIELDED_COLOR,
        amount: amount.toString(),
        mtIndex: mtIndex.toString(),
        mtIndexSource,
      },
    };
  },
});
