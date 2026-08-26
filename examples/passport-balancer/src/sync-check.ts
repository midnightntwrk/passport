/**
 * The sync proof.
 *
 * One question, answered against the live chain: can the ledger-9 beta wallet
 * SDK open a wallet on stagenet and reach `isSynced`? The v8 SDK cannot — it
 * dies on the indexer's schema with a ParseError — and every other thing this
 * service does is downstream of that fact.
 *
 * It opens the balancer wallet exactly as `server.ts` does, prints the chain
 * position every five seconds, and reports the wall-clock at the end. Nothing
 * is submitted and nothing is spent; a wallet with no funds proves the point
 * just as well as a funded one.
 *
 *   BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env npm run sync-check
 */

import { applyEnvFile, loadConfig } from './config.js';
import { formatNight, openBalancerWallet } from './wallet.js';

function elapsed(startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1_000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${(seconds - minutes * 60).toFixed(0)} s`;
}

async function main(): Promise<void> {
  applyEnvFile();
  const config = loadConfig();
  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`indexerWs ${config.indexerWsUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(`prover    ${config.provingServerUrl ?? 'in-process WASM prover'}`);
  console.log(`state     ${config.stateDir}\n`);

  const startedAt = Date.now();
  const wallet = await openBalancerWallet(config);
  console.log(`address   ${wallet.address}`);
  console.log(`opened in ${elapsed(startedAt)}\n`);

  const syncStartedAt = Date.now();
  await wallet.waitForSync((progress) => {
    console.log(
      `[sync ${elapsed(syncStartedAt).padStart(9)}] shielded ${progress.shielded.applied}/${progress.shielded.highestRelevant}  unshielded ${progress.unshielded.applied}/${progress.unshielded.highestRelevant}  dust ${progress.dust.applied}/${progress.dust.highestRelevant}`,
    );
  });

  const syncSeconds = (Date.now() - syncStartedAt) / 1_000;
  const state = await wallet.currentState();
  const night = await wallet.nightBalance(state);
  const dust = await wallet.dustBalance(state);
  const progress = await wallet.progress(state);

  /* `applied of relevant` is the pair the SDK's own verdict is computed from;
     `tip` is what the indexer claims the chain is at, printed beside it so the
     two are never confused. */
  const line = (name: string, p: (typeof progress)['shielded']): string =>
    `  ${name.padEnd(14)} applied ${p.applied} of ${p.highestRelevant} relevant (indexer tip ${p.highest}), connected ${p.connected}, complete ${p.complete}`;

  console.log('\nSYNCED');
  console.log(`  wall clock     ${elapsed(syncStartedAt)} (${syncSeconds.toFixed(1)} s)`);
  console.log(line('shielded', progress.shielded));
  console.log(line('unshielded', progress.unshielded));
  console.log(line('dust', progress.dust));
  console.log(`  NIGHT          ${formatNight(night)} (${night} atomic)`);
  console.log(`  DUST           ${dust} Specks`);

  await wallet.close();
  console.log('\nsnapshot saved — a restart resumes from here rather than from genesis.');
}

main().catch((cause) => {
  console.error('\nSYNC PROOF FAILED');
  console.error(cause);
  process.exit(1);
});
