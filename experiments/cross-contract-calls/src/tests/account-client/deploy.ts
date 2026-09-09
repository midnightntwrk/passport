// VENDORED SLICE — account deployment and call plumbing.
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/wave-deploy.ts and src/node/setup.ts, commit 2b0b55d,
// trimmed to what P5 needs:
//
//   - deployAccountJubjubArm: the k1-arm harness measured that a deploy
//     carrying all 18 verifier keys exceeds two ledger-9 per-block limits
//     (bytes_written 53,076 vs 50,000; compute 2.011 s vs 2.000 s) and is
//     refused by the fee computation up front, so the account deploys as
//     the upstream harness's WAVE 1 only: the constructor's ledger state
//     plus the 10 operations P5 exercises (the two deposits and the jubjub
//     arm, activation included). The k256 arm's keys are never inserted —
//     P5 does not touch them — so no maintenance update is needed and the
//     maintenance authority stays live but unused (P5 is a probe; the
//     reference posture retires it, see the upstream wave-deploy note).
//
//   - callAccount: circuit calls through midnight-js's submitCallTx rather
//     than findDeployedContract/callTx, because the deployed instance
//     carries a SUBSET of the compiled operations and findDeployedContract
//     verifies the full operation set. submitCallTx needs only the target
//     circuit's deployed key, which wave 1 installed.
//
//   - submitWithDustRetry: the wallet's dust view lags the chain by a sync
//     cycle; a rejected submission changes no state, so rebuild and retry.

import { setTimeout as delay } from 'node:timers/promises';

import {
  ContractDeploy,
  ContractState as LedgerContractState,
  Intent,
  Transaction,
} from '@midnightntwrk/ledger-v9';
import {
  createUnprovenDeployTx,
  submitCallTx,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { accountZkConfigPath } from '../../node/wallet.js';
import { Contract, ledger } from './contract.js';

/** Wave 1 of the upstream two-wave deploy: deposits + the jubjub arm. */
export const JUBJUB_WAVE_OPERATIONS = [
  'deposit_unshielded',
  'deposit_shielded',
  'activate_initial_device_with_jubjub',
  'withdraw_unshielded_with_jubjub',
  'append_inbox_with_jubjub',
  'withdraw_shielded_with_jubjub',
  'withdraw_shielded_to_contract_with_jubjub',
  'rotate_enc_key_with_jubjub',
  'add_device_with_jubjub',
  'remove_device_with_jubjub',
] as const;

/** P5 is coinless by design: the held_coin witness must never be invoked
 *  (and a callee may not invoke witnesses at all). */
export function makeAccountWitnesses() {
  return {
    held_coin(): never {
      throw new Error(
        'held_coin witness invoked — P5 is coinless by design (and callees may not invoke witnesses)',
      );
    },
  };
}

export function compiledAccount() {
  return (CompiledContract as any).make('account', Contract).pipe(
    (CompiledContract as any).withWitnesses(makeAccountWitnesses()),
    (CompiledContract as any).withCompiledFileAssets(accountZkConfigPath),
  );
}

export async function submitWithDustRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const dustRace = /SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/.test(msg);
      if (!dustRace || attempt >= 3) throw e;
      console.log(`  (${label}: submission rejected — dust-state race; retrying in 10s)`);
      await delay(10_000);
    }
  }
}

/**
 * Deploy the account contract restricted to the jubjub wave and return its
 * address. Runs the constructor through the standard pipeline (its full
 * 18-operation transaction is discarded — it cannot fit a block), then
 * hand-builds a deploy whose ContractState carries the same ledger data and
 * maintenance authority but only the wave's operations.
 */
export async function deployAccountJubjubArm(
  providers: any,
  compiledContract: any,
  args: unknown[],
): Promise<string> {
  const deployData: any = await createUnprovenDeployTx(providers, {
    compiledContract,
    privateStateId: 'account-p5',
    initialPrivateState: { coins: {} },
    args,
  } as any);

  // The pipeline hands back a compact-runtime ContractState; the ledger's
  // deploy needs the ledger's class, and the two bridge by serialisation
  // (the same conversion midnight-js performs internally).
  const full: any = (LedgerContractState as any).deserialize(
    deployData.public.initialContractState.serialize(),
  );

  const wave = new (LedgerContractState as any)();
  wave.data = full.data;
  wave.maintenanceAuthority = full.maintenanceAuthority;
  for (const id of JUBJUB_WAVE_OPERATIONS) {
    const op = full.operation(id);
    if (!op) throw new Error(`compiled account has no operation '${id}'`);
    wave.setOperation(id, op);
  }

  const deploy = new (ContractDeploy as any)(wave);
  const address = String(deploy.address);
  const ttl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
  const unprovenTx = (Transaction as any).fromParts(
    getNetworkId(), undefined, undefined, (Intent as any).new(ttl).addDeploy(deploy),
  );

  console.log(`  deploying ${JUBJUB_WAVE_OPERATIONS.length} operations (jubjub arm + deposits) — the 18-key full deploy exceeds block limits`);
  const finalized: any = await submitWithDustRetry('account deploy', () =>
    (submitTx as any)(providers, { unprovenTx }));
  if (finalized?.status && String(finalized.status).toLowerCase().includes('fail')) {
    throw new Error(`account deploy failed: ${JSON.stringify(finalized.status)}`);
  }
  return address;
}

/** Decoded account ledger state via the indexer. */
export async function accountLedger(providers: any, address: string): Promise<any> {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (!state) throw new Error(`no contract state at ${address}`);
  return ledger(state.data);
}

/**
 * One account circuit call through submitCallTx (see the header for why not
 * findDeployedContract). Returns the finalized call tx data.
 */
export async function callAccount(
  providers: any,
  compiledContract: any,
  address: string,
  circuitId: string,
  args: unknown[],
): Promise<any> {
  return submitWithDustRetry(circuitId, () =>
    (submitCallTx as any)(providers, {
      compiledContract,
      circuitId,
      contractAddress: address,
      args,
    }),
  );
}
