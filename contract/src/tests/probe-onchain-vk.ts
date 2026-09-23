/**
 * Probe: deploy the account contract on the localnet and read every
 * circuit's verifier key back from chain state, comparing it byte for byte
 * with the `keys/<circuit>.verifier` file compactc produced.
 *
 * Feeds experiments/proving-key-regeneration: if the on-chain bytes are the
 * file bytes, the deployed verifier key is a sufficient input to setup_pk.
 *
 *   WALLET_SEED=... npx tsx src/tests/probe-onchain-vk.ts <out-dir>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupWallet, deployAccount } from '../node/setup.js';
import { zkConfigPath } from '../node/wallet.js';
import { K256Device } from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';

async function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: probe-onchain-vk.ts <out-dir>');
  fs.mkdirSync(outDir, { recursive: true });

  const ctx = await setupWallet();
  const account = await deployAccount(ctx, K256Device.generate(), generateEncKeyPair());
  console.log(`account @ ${account.address}`);

  const state = await ctx.providers.publicDataProvider.queryContractState(account.address);
  if (!state) throw new Error('contract state not found on the indexer');

  const keysDir = path.join(zkConfigPath, 'keys');
  const names = fs
    .readdirSync(keysDir)
    .filter((f) => f.endsWith('.verifier'))
    .map((f) => f.replace(/\.verifier$/, ''))
    .sort();

  const rows: Record<string, unknown>[] = [];
  for (const name of names) {
    const op = state.operation(name);
    const file = fs.readFileSync(path.join(keysDir, `${name}.verifier`));
    if (!op) {
      rows.push({ circuit: name, onChain: false, fileBytes: file.length });
      continue;
    }
    const chain = Buffer.from(op.verifierKey);
    fs.writeFileSync(path.join(outDir, `${name}.verifier.onchain`), chain);
    rows.push({
      circuit: name,
      onChain: true,
      chainBytes: chain.length,
      fileBytes: file.length,
      identical: chain.equals(file),
      chainIsTailOfFile:
        file.length > chain.length && file.subarray(file.length - chain.length).equals(chain),
    });
  }
  const summary = {
    address: account.address,
    readAt: new Date().toISOString(),
    onChain: rows.filter((r) => r.onChain).length,
    total: rows.length,
    rows,
  };
  fs.writeFileSync(path.join(outDir, 'onchain-vk-summary.json'), JSON.stringify(summary, null, 2));
  console.table(rows);
  console.log(`${summary.onChain}/${summary.total} circuits on chain`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
