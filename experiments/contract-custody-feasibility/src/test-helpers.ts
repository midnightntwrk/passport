// Shared helpers for individual test runners under src/tests/.
//
// Each test under src/tests/ should:
//   1. import setupContract() to deploy-or-find the contract instance
//   2. await the test action (a circuit call, a transaction submission, …)
//   3. write evidence via writeEvidence() with verdict + tx hash or error code
//
// The intent is that adding a 10th test is no more than one tiny file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { firstValueFrom } from 'rxjs';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, CustodyContract, zkConfigPath, PRIVATE_STATE_ID } from './utils.js';
import { syncWallet, printBalances, writeEvidence, type Verdict, type Evidence } from './common.js';

export interface ContractHandle {
  address: string;
  found: any; // The deployed contract handle from midnight-js-contracts
}

const COMPILED = () =>
  CompiledContract.make('custody', CustodyContract.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

// Slot decides which deployment file we read/write. 'primary' is the default;
// 'secondary' is used by U2 (sendUnshielded → ContractAddress) which needs
// two distinct contract instances.
export type DeploySlot = 'primary' | 'secondary';

const DEPLOYMENT_FILE: Record<DeploySlot, string> = {
  primary: 'deployment.json',
  secondary: 'deployment-second.json',
};

export async function setupContract(opts: {
  slot?: DeploySlot;
  walletSeed?: string; // override; defaults to WALLET_SEED env var
  reuseDeployment?: boolean; // default true
}): Promise<{ providers: any; walletCtx: any; contract: ContractHandle }> {
  const slot = opts.slot ?? 'primary';
  const reuse = opts.reuseDeployment ?? true;
  const seed = opts.walletSeed ?? process.env.WALLET_SEED;
  if (!seed) throw new Error('WALLET_SEED env var or opts.walletSeed required');

  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    throw new Error(`Contract not compiled. Run: npm run compile`);
  }

  const walletCtx = await createWallet(seed);
  await syncWallet(walletCtx, `wallet-${slot}`);
  printBalances(await firstValueFrom(walletCtx.wallet.state()));
  const providers = await createProviders(walletCtx);

  const compiled = COMPILED();
  const deploymentFile = DEPLOYMENT_FILE[slot];

  let address: string;
  let found: any;
  if (reuse && fs.existsSync(deploymentFile)) {
    address = JSON.parse(fs.readFileSync(deploymentFile, 'utf-8')).contractAddress;
    console.log(`Connecting to ${slot} contract @ ${address}`);
    found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract: compiled,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
  } else {
    console.log(`Deploying ${slot} contract instance...`);
    const deployed = await deployContract(providers, {
      compiledContract: compiled,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    address = deployed.deployTxData.public.contractAddress;
    fs.writeFileSync(
      deploymentFile,
      JSON.stringify(
        { contractAddress: address, slot, deployedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(`Deployed ${slot} @ ${address}`);
    found = deployed;
  }

  return { providers, walletCtx, contract: { address, found } };
}

// Run a test action and write its evidence. The action returns either a tx
// hash (PASS), an error code string (FAIL), or throws. Anything thrown is
// captured as FAIL with errorCode = thrown.message.
export async function runTest(opts: {
  testId: string;       // 'U1', 'S4', etc.
  name: string;         // descriptive: 'receive-unshielded'
  description: string;
  action: () => Promise<{ verdict: Verdict; txHash?: string; errorCode?: string; note: string; details: Record<string, unknown> }>;
}): Promise<void> {
  const banner = `\n━━━ ${opts.testId}: ${opts.description} ━━━`;
  console.log(banner);
  let result: Awaited<ReturnType<typeof opts.action>>;
  try {
    result = await opts.action();
  } catch (e: any) {
    result = {
      verdict: 'FAIL',
      errorCode: classifyError(e),
      note: `Threw: ${e?.message ?? String(e)}`,
      details: { error: serialiseError(e) },
    };
  }
  const file = writeEvidence(opts.testId, {
    test: opts.testId,
    name: opts.name,
    verdict: result.verdict,
    txHash: result.txHash,
    errorCode: result.errorCode,
    note: result.note,
    evidence: result.details,
  });
  console.log(`◆ ${opts.testId} verdict: ${result.verdict}`);
  if (result.txHash) console.log(`  tx:    ${result.txHash}`);
  if (result.errorCode) console.log(`  error: ${result.errorCode}`);
  console.log(`  note:  ${result.note}`);
  console.log(`  evidence: ${path.relative(process.cwd(), file)}`);

  // Force exit. Wallet/indexer subscriptions keep the event loop alive
  // even after walletCtx.wallet.stop() in the success path; on the
  // failure path stop() is never reached and the process hangs entirely.
  // The bash orchestrator captures the exit code with `|| true`, so
  // exiting non-zero on FAIL is harmless and surfaces failures clearly.
  setTimeout(() => process.exit(result.verdict === 'FAIL' ? 1 : 0), 100).unref();
}

// Classify a thrown error into a stable code that FINDINGS.md can group on.
// Recognises the historical Midnight ledger errors (168, 186) and maps
// everything else to a generic `node-error` / `compile-error` / `js-error`.
export function classifyError(e: any): string {
  const msg = (e?.message ?? String(e)).toLowerCase();
  const ledgerMatch = msg.match(/ledger[\s-_:]?(?:error)?[\s-_:]?(\d{3})/);
  if (ledgerMatch) return `ledger-${ledgerMatch[1]}`;
  const errorCodeMatch = msg.match(/error\s+code[\s:]+(\w+)/i);
  if (errorCodeMatch) return `node-${errorCodeMatch[1]}`;
  if (msg.includes('not rehashed')) return 'merkle-not-rehashed';
  if (msg.includes('compile') || msg.includes('compact')) return 'compile-error';
  if (msg.includes('insufficient') && msg.includes('dust')) return 'insufficient-dust';
  return 'js-error';
}

export function serialiseError(e: any): Record<string, unknown> {
  if (!e) return { value: null };
  return {
    name: e?.name ?? typeof e,
    message: e?.message ?? String(e),
    stack: e?.stack?.split('\n').slice(0, 8).join('\n') ?? null,
    cause: e?.cause ? { message: (e.cause as any)?.message } : null,
  };
}
