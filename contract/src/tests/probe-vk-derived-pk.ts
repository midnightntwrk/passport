/**
 * Probe: prove a public circuit call with a prover key that was built from
 * the ZKIR and the ON-CHAIN verifier key only (experiments/
 * proving-key-regeneration/pk-from-vk), and have the node verify it.
 *
 * The caller swaps `keys/<circuit>.prover` for the derived key before
 * running this; the probe itself only connects to a deployed account and
 * calls deposit_unshielded, which has no device authorisation, so the only
 * thing under test is whether the node accepts the proof.
 *
 *   WALLET_SEED=... npx tsx src/tests/probe-vk-derived-pk.ts <account-address> [amount]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { setupWallet, connectAccount } from '../node/setup.js';
import { zkConfigPath } from '../node/wallet.js';

const NIGHT = new Uint8Array(32);

async function main() {
  const address = process.argv[2];
  if (!address) throw new Error('usage: probe-vk-derived-pk.ts <account-address> [amount]');
  const amount = BigInt(process.argv[3] ?? '1000');

  const pkPath = path.join(zkConfigPath, 'keys', 'deposit_unshielded.prover');
  const digest = createHash('sha256').update(fs.readFileSync(pkPath)).digest('hex');
  console.log(`prover key in use: ${pkPath}\n  sha256 ${digest}`);

  const ctx = await setupWallet();
  const account = await connectAccount(ctx, address);
  console.log(`account @ ${account.address}`);
  const t0 = Date.now();
  const { txId } = await account.depositUnshielded(NIGHT, amount);
  console.log(`deposit_unshielded(${amount} Night) accepted: tx ${txId} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
