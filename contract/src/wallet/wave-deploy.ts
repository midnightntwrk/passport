// Two-wave deployment of the account contract.
//
// The co-resident-arms contract exports 18 impure circuits, and a deploy
// carrying all 18 verifier keys exceeds two of the ledger-9 per-block
// limits (measured on the rc parameters: bytes_written 53,076 against a
// 50,000 budget, compute_time 2.011 s against 2.000 s), so it can never be
// included in a block — the fee computation refuses it up front ("exceeded
// block limit in transaction fee computation"). The account therefore
// deploys in waves that each fit a block:
//
//   wave 1  deposits + the initial device's arm (10 operations), the
//           constructor's ledger state, and the maintenance authority —
//           a functional single-arm account;
//   wave 2  the other arm's 8 verifier keys, added in one batched
//           contract maintenance update signed by the authority key
//           wave 1 stored locally.
//
// Wave 2 is not a workaround detail: adding an arm's circuits to a LIVE
// account by maintenance update is exactly how the planned secp256r1 arm
// reaches accounts deployed before it exists. The block-limit finding is
// upstream-report material (any contract with this many entry points is
// undeployable in one transaction under the current parameters).

import {
  ContractDeploy,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  signData,
} from '@midnightntwrk/ledger-v9';
import {
  createUnprovenDeployTx,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import type { Arm } from './signer.js';

const GATED_BASES = [
  'withdraw_unshielded',
  'append_inbox',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
  'rotate_enc_key',
  'add_device',
  'remove_device',
] as const;

/** Every impure circuit of one arm, activation included. */
export const armCircuits = (arm: Arm): string[] =>
  ['activate_initial_device', ...GATED_BASES].map((base) => `${base}_with_${arm}`);

const SHARED_CIRCUITS = ['deposit_unshielded', 'deposit_shielded'];

const otherArm = (arm: Arm): Arm => (arm === 'jubjub' ? 'k256' : 'jubjub');

async function withDustRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const dustRace = /SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/.test(msg);
      if (!dustRace || attempt >= 3) throw e;
      console.log(`  (${label}: submission rejected — dust-state race; retrying in 10s)`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

export interface WaveDeployOptions {
  /** The initial device's arm — deployed in wave 1 so activation works. */
  firstArm: Arm;
  /** Constructor arguments (boot commitment, encryption key). */
  args: unknown[];
  privateStateId: string;
  initialPrivateState: unknown;
}

/**
 * Deploys the account contract in two waves and returns its address. On
 * return the contract carries all 18 operations, the constructor state,
 * and a maintenance authority whose signing key is stored in the private
 * state provider under the contract address (the same place midnight-js's
 * own deploy puts it).
 */
export async function deployAccountInWaves(
  providers: any,
  compiledContract: any,
  options: WaveDeployOptions,
): Promise<string> {
  // Run the constructor and collect the full 18-operation state through
  // the standard pipeline; its transaction is discarded (it cannot fit a
  // block), its state and authority are re-used.
  const deployData: any = await createUnprovenDeployTx(providers, {
    compiledContract,
    privateStateId: options.privateStateId,
    initialPrivateState: options.initialPrivateState,
    args: options.args,
  } as any);
  // The pipeline hands back a compact-runtime ContractState; the ledger's
  // deploy needs the ledger's class, and the two bridge by serialisation
  // (the same conversion midnight-js performs internally).
  const full: ContractState = ContractState.deserialize(
    deployData.public.initialContractState.serialize(),
  );

  // Wave 1: same ledger data and maintenance authority, operations
  // restricted to the deposits and the initial device's arm.
  const wave1 = new ContractState();
  wave1.data = full.data;
  wave1.maintenanceAuthority = full.maintenanceAuthority;
  const waveOneIds = [...SHARED_CIRCUITS, ...armCircuits(options.firstArm)];
  for (const id of waveOneIds) {
    const op = full.operation(id);
    if (!op) throw new Error(`compiled contract has no operation '${id}'`);
    wave1.setOperation(id, op);
  }
  const deploy = new ContractDeploy(wave1);
  const address = String(deploy.address);
  const ttl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
  const unprovenTx = Transaction.fromParts(
    getNetworkId(), undefined, undefined, Intent.new(ttl).addDeploy(deploy),
  );

  console.log(`  wave 1: deploying ${waveOneIds.length} operations (${options.firstArm} arm + deposits)`);
  const finalized: any = await withDustRetry('wave-1 deploy', () =>
    (submitTx as any)(providers, { unprovenTx }));
  if (finalized.status && String(finalized.status).toLowerCase().includes('fail')) {
    throw new Error(`wave-1 deploy failed: ${JSON.stringify(finalized.status)}`);
  }

  // The bookkeeping midnight-js's own deploy performs: the maintenance
  // authority key (wave 2 and future maintenance read it from here) and
  // the private state.
  if (typeof providers.privateStateProvider.setContractAddress === 'function') {
    await providers.privateStateProvider.setContractAddress(address);
  }
  await providers.privateStateProvider.setSigningKey(address, deployData.private.signingKey);
  await providers.privateStateProvider.set(options.privateStateId, deployData.private.initialPrivateState);

  // Wave 2: the other arm's 8 verifier keys in ONE batched maintenance
  // update, hand-built against the ledger API and signed with the stored
  // authority key. midnight-js's published per-circuit maintenance
  // interface cannot be used here: compact-js 2.5.5-rc.6 hardcodes
  // ContractOperationVersion 'v3', whose raw keys carry the
  // 'midnight:verifier-key[v6]:' header, while compactc 0.33.0-rc.2 emits
  // v7-headed keys (version tag 'v4') — the insert throws before a
  // transaction exists. A version-matrix gap in the published stack;
  // upstream-report candidate.
  const secondArm = otherArm(options.firstArm);
  const waveTwoIds = armCircuits(secondArm);
  const updates: VerifierKeyInsert[] = [];
  for (const id of waveTwoIds) {
    const vk = await providers.zkConfigProvider.getVerifierKey(id);
    if (!vk) throw new Error(`compiled contract has no verifier key for '${id}'`);
    updates.push(new VerifierKeyInsert(id, new ContractOperationVersionedVerifierKey('v4', vk)));
  }
  console.log(`  wave 2: one maintenance update inserting ${updates.length} verifier keys (${secondArm} arm)`);
  // The authority counter is the one the deploy carried: the signing key
  // exists only locally, so no other maintenance update can have advanced
  // it between the waves.
  const bare = new MaintenanceUpdate(address, updates, full.maintenanceAuthority.counter);
  const signedUpdate = bare.addSignature(0n, signData(deployData.private.signingKey, bare.dataToSign));
  const waveTwoTtl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
  const waveTwoTx = Transaction.fromParts(
    getNetworkId(), undefined, undefined, Intent.new(waveTwoTtl).addMaintenanceUpdate(signedUpdate),
  );
  const waveTwoFinal: any = await withDustRetry('wave-2 maintenance', () =>
    (submitTx as any)(providers, { unprovenTx: waveTwoTx }));
  if (waveTwoFinal.status && String(waveTwoFinal.status).toLowerCase().includes('fail')) {
    throw new Error(`wave-2 maintenance failed: ${JSON.stringify(waveTwoFinal.status)}`);
  }

  return address;
}
