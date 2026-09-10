// Budget-driven wave deployment of the account contract.
//
// The co-resident-arms contract at `spec_version = 2` exports 30 impure
// circuits (2 deposits, 8 device circuits per arm, 3 grant twins per arm,
// and 3 grant-lifecycle circuits per arm), and a deploy carrying all of
// their verifier keys exceeds two of the ledger-9 per-block limits. The
// measurement was taken on the 18-circuit roster (bytes_written 53,076
// against a 50,000 budget, compute_time 2.011 s against 2.000 s), so it can
// never be included in a block — the fee computation refuses it up front
// ("exceeded block limit in transaction fee computation"). The 30-circuit
// roster prices at 74,286 verifier bytes and is refused by a wider margin.
// The account therefore deploys in waves that each fit a block:
//
//   wave 1  deposits + the initial device's arm (10 operations), the
//           constructor's ledger state, and the maintenance authority —
//           a functional single-arm account;
//   wave 2  and every wave after it, the remaining 20 verifier keys packed
//           greedily under a per-update payload budget and added by batched
//           contract maintenance updates signed by the authority key wave 1
//           stored locally. The LAST of those updates also retires that
//           authority (see the note on deployAccountInWaves for why the
//           default is to retire it).
//
// At the measured key sizes the 30-circuit roster plans as THREE waves: the
// deploy plus two maintenance updates. The plan is computed from the real
// artefacts rather than from the table, so a roster or key-size change
// re-plans itself.
//
// The maintenance waves are not a workaround detail: adding circuits to a
// LIVE account by maintenance update is exactly how the planned secp256r1
// arm would reach accounts deployed before it exists. Note the tension that
// creates, and which the retirement resolves in favour of custody: an
// authority able to add an arm is equally able to replace an existing arm's
// verifier key, which is a path around the seam. The block-limit finding is
// upstream-report material (any contract with this many entry points is
// undeployable in one transaction under the current parameters).

import {
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  MaintenanceUpdate,
  ReplaceAuthority,
  Transaction,
  VerifierKeyInsert,
  signData,
  type SingleUpdate,
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

/** The asset-releasing circuits that have a grantee twin (MIP 6.1). */
const GRANT_TWIN_BASES = [
  'withdraw_unshielded',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
] as const;

/** The grant-lifecycle circuits, authorised on a device arm (MIP 7). */
const LIFECYCLE_BASES = [
  'issue_grant',
  'revoke_grant',
  'revoke_all_grants',
] as const;

/** Every impure circuit of one arm, activation included. */
export const armCircuits = (arm: Arm): string[] =>
  ['activate_initial_device', ...GATED_BASES].map((base) => `${base}_with_${arm}`);

/** The grantee twins of one arm: `<op>_with_grant_<arm>`. */
export const grantTwins = (arm: Arm): string[] =>
  GRANT_TWIN_BASES.map((base) => `${base}_with_grant_${arm}`);

/** The grant-lifecycle circuits of one arm: `<op>_with_<arm>`. */
export const lifecycleCircuits = (arm: Arm): string[] =>
  LIFECYCLE_BASES.map((base) => `${base}_with_${arm}`);

/** The two permissionless deposits, shared by both arms. */
export const SHARED_CIRCUITS = ['deposit_unshielded', 'deposit_shielded'];

/** The whole `spec_version = 2` roster: 30 impure circuits. */
export const allCircuits = (): string[] => [
  ...SHARED_CIRCUITS,
  ...armCircuits('k256'),
  ...armCircuits('jubjub'),
  ...grantTwins('k256'),
  ...lifecycleCircuits('k256'),
  ...grantTwins('jubjub'),
  ...lifecycleCircuits('jubjub'),
];

const otherArm = (arm: Arm): Arm => (arm === 'jubjub' ? 'k256' : 'jubjub');

/**
 * Verifier bytes admitted into one maintenance update.
 *
 * The ledger-9 rc parameters budget 50,000 `bytes_written` per block. A
 * transaction writes more than its verifier keys: the 18-key deploy priced
 * at 53,076 bytes_written against 43,938 verifier bytes, so about 9,138
 * bytes of overhead beyond the keys. 40,000 leaves roughly 10,000 bytes for
 * that overhead, which covers the measured figure with margin for the
 * update envelope and its signature.
 */
export const VERIFIER_BYTE_BUDGET = 40_000;

/** One planned wave: the deploy, or one batched maintenance update. */
export interface Wave {
  /** 1-based, in submission order. */
  index: number;
  /** The deploy carries wave 1; every later wave is a maintenance update. */
  kind: 'deploy' | 'maintenance';
  /** Operation ids carried by this wave, in insertion order. */
  circuits: string[];
  /** Sum of this wave's verifier key lengths, in bytes. */
  verifierBytes: number;
  /** Only the last maintenance wave retires the maintenance authority. */
  retiresAuthority: boolean;
}

/**
 * The wave plan for a roster, computed from measured verifier key lengths.
 *
 * Pure, so a suite can print the plan without a node: pass the lengths of
 * `getVerifierKey(id)` for every id of `allCircuits()`.
 *
 * Wave 1 is the deploy and is fixed: the deposits plus the initial device's
 * arm, which is the smallest functional account. The remaining 20 keys are
 * packed greedily under `VERIFIER_BYTE_BUDGET` in a deterministic order:
 * the other arm's device circuits first (so both device arms are live as
 * early as possible), then the first arm's grant twins and lifecycle, then
 * the other arm's. The authority retirement rides on the last wave, which
 * is the last operation that needs the authority.
 */
export function planWaves(
  sizes: Map<string, number>,
  firstArm: Arm,
  retireAuthority = true,
): Wave[] {
  const sizeOf = (id: string): number => {
    const n = sizes.get(id);
    if (n === undefined) throw new Error(`no verifier key size for '${id}'`);
    return n;
  };
  const total = (ids: string[]): number => ids.reduce((sum, id) => sum + sizeOf(id), 0);

  const second = otherArm(firstArm);
  const waveOne = [...SHARED_CIRCUITS, ...armCircuits(firstArm)];
  const waves: Wave[] = [{
    index: 1,
    kind: 'deploy',
    circuits: waveOne,
    verifierBytes: total(waveOne),
    retiresAuthority: false,
  }];

  const remaining = [
    ...armCircuits(second),
    ...grantTwins(firstArm),
    ...lifecycleCircuits(firstArm),
    ...grantTwins(second),
    ...lifecycleCircuits(second),
  ];

  let current: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    waves.push({
      index: waves.length + 1,
      kind: 'maintenance',
      circuits: current,
      verifierBytes: bytes,
      retiresAuthority: false,
    });
    current = [];
    bytes = 0;
  };
  for (const id of remaining) {
    const size = sizeOf(id);
    if (size > VERIFIER_BYTE_BUDGET) {
      throw new Error(`verifier key for '${id}' (${size} bytes) exceeds the per-update budget`);
    }
    if (bytes + size > VERIFIER_BYTE_BUDGET) flush();
    current.push(id);
    bytes += size;
  }
  flush();

  if (retireAuthority) waves[waves.length - 1].retiresAuthority = true;
  return waves;
}

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

/**
 * The maintenance authority counter AS IT STANDS ON CHAIN.
 *
 * A maintenance update must carry the counter the chain expects, and that
 * counter advances with every applied update, so each wave reads it rather
 * than assuming the deploy-time value. The public data provider hands back a
 * compact-runtime `ContractState`; the ledger's class reads the authority,
 * and the two bridge by serialisation.
 */
async function onChainAuthorityCounter(providers: any, address: string): Promise<bigint> {
  const state: any = await providers.publicDataProvider.queryContractState(address);
  if (!state) throw new Error(`no contract state found at ${address}`);
  const ledgerState: ContractState = ContractState.deserialize(state.serialize());
  return ledgerState.maintenanceAuthority.counter as bigint;
}

/** Blocks until the chain shows the counter a wave has advanced to. */
async function awaitAuthorityCounter(
  providers: any,
  address: string,
  expected: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const seen = await onChainAuthorityCounter(providers, address);
    if (seen >= expected) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`authority counter never reached ${expected} at ${address}`);
}

export interface WaveDeployOptions {
  /** The initial device's arm — deployed in wave 1 so activation works. */
  firstArm: Arm;
  /** Constructor arguments (boot commitment, encryption key). */
  args: unknown[];
  privateStateId: string;
  initialPrivateState: unknown;
  /**
   * Retire the contract maintenance authority in the LAST maintenance wave
   * (default true). See the authority note on `deployAccountInWaves`: while an
   * authority is live it sits ABOVE the MIP-0013 seam, so the reference posture
   * is to retire it. Pass false only for an account that must remain open to a
   * future arm, and only having accepted that the authority key is then
   * equivalent to full custody of the account.
   */
  retireAuthority?: boolean;
}

/**
 * Deploys the account contract in a planned sequence of waves and returns its
 * address. On return the contract carries all 30 operations and the
 * constructor state.
 *
 * The maintenance authority, and why this retires it by default.
 * ---------------------------------------------------------------
 * Deploying a contract mints a maintenance authority and stores its signing
 * key locally; midnight-js's own `deployContract` does the same, so this is
 * inherited rather than introduced here. What the authority can do is total:
 * a `VerifierKeyInsert` REPLACES an operation's verifier key, and a
 * `ContractOperation` carries nothing but that key, so whoever holds the
 * signing key can substitute their own relation for `withdraw_shielded_with_*`
 * and release the account's assets with no device signature and no auth_nonce
 * advance. That is a path around the seam the contract header calls the gate
 * on every asset-releasing circuit, and a single key holding it contradicts
 * the 1-of-n device model MIP-0013 specifies.
 *
 * The maintenance waves need the authority (they are how the second arm and
 * the grant circuits get in), so the update that LAST needs it also retires
 * it: that batch ends with a `ReplaceAuthority` installing an unsatisfiable
 * authority (empty committee, threshold 1), after which no maintenance update
 * can ever be signed for this contract.
 *
 * The cost is explicit: a retired account can never receive a future arm's
 * circuits, so the secp256r1 arm will reach it only by migrating to a new
 * account. The maintenance waves still demonstrate the mechanism by which an
 * arm reaches a LIVE account; `retireAuthority: false` keeps that door open
 * for a deployer who has weighed the custody risk above.
 */
export async function deployAccountInWaves(
  providers: any,
  compiledContract: any,
  options: WaveDeployOptions,
): Promise<string> {
  // Run the constructor and collect the full 30-operation state through
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

  // The plan is computed from the compiled artefacts: every roster id's real
  // verifier key length, not the measurement table.
  const verifierKeys = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  for (const id of allCircuits()) {
    const vk: Uint8Array = await providers.zkConfigProvider.getVerifierKey(id);
    if (!vk) throw new Error(`compiled contract has no verifier key for '${id}'`);
    verifierKeys.set(id, vk);
    sizes.set(id, vk.length);
  }
  const retire = options.retireAuthority !== false;
  const waves = planWaves(sizes, options.firstArm, retire);
  console.log(
    `  wave plan: ${waves.length} waves for ${allCircuits().length} circuits ` +
    `(budget ${VERIFIER_BYTE_BUDGET} verifier bytes per maintenance update)`,
  );
  for (const wave of waves) {
    console.log(
      `    wave ${wave.index} (${wave.kind}): ${wave.circuits.length} circuits, ` +
      `${wave.verifierBytes} verifier bytes` +
      (wave.retiresAuthority ? ', retires the maintenance authority' : ''),
    );
  }

  // Wave 1: same ledger data and maintenance authority, operations
  // restricted to the deposits and the initial device's arm.
  const [waveOne, ...maintenanceWaves] = waves;
  const wave1 = new ContractState();
  wave1.data = full.data;
  wave1.maintenanceAuthority = full.maintenanceAuthority;
  for (const id of waveOne.circuits) {
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

  console.log(
    `  wave 1: deploying ${waveOne.circuits.length} operations ` +
    `(${options.firstArm} arm + deposits, ${waveOne.verifierBytes} verifier bytes)`,
  );
  const finalized: any = await withDustRetry('wave-1 deploy', () =>
    (submitTx as any)(providers, { unprovenTx }));
  if (finalized.status && String(finalized.status).toLowerCase().includes('fail')) {
    throw new Error(`wave-1 deploy failed: ${JSON.stringify(finalized.status)}`);
  }

  // The bookkeeping midnight-js's own deploy performs: the maintenance
  // authority key (the later waves and future maintenance read it from here)
  // and the private state.
  if (typeof providers.privateStateProvider.setContractAddress === 'function') {
    await providers.privateStateProvider.setContractAddress(address);
  }
  await providers.privateStateProvider.setSigningKey(address, deployData.private.signingKey);
  await providers.privateStateProvider.set(options.privateStateId, deployData.private.initialPrivateState);

  // The maintenance waves: each carries its batch of verifier keys in ONE
  // hand-built maintenance update, signed with the stored authority key.
  // midnight-js's published per-circuit maintenance interface cannot be used
  // here: compact-js 2.5.5-rc.6 hardcodes ContractOperationVersion 'v3',
  // whose raw keys carry the 'midnight:verifier-key[v6]:' header, while
  // compactc 0.33.0-rc.2 emits v7-headed keys (version tag 'v4') — the
  // insert throws before a transaction exists. A version-matrix gap in the
  // published stack; upstream-report candidate.
  for (const wave of maintenanceWaves) {
    // The counter as it stands on chain at THIS point: it advances with each
    // applied update, so the deploy-time value is right for the first
    // maintenance wave only. Waiting for the previous wave to be visible in
    // this read is also what keeps the waves ordered.
    const counter = await onChainAuthorityCounter(providers, address);
    const updates: SingleUpdate[] = [];
    for (const id of wave.circuits) {
      const vk = verifierKeys.get(id)!;
      updates.push(new VerifierKeyInsert(id, new ContractOperationVersionedVerifierKey('v4', vk)));
    }

    // Retire the authority in the update that last needs it. An empty
    // committee with threshold 1 can never be satisfied, so this contract
    // accepts no further maintenance update — the seam becomes the only way
    // to move the account's assets. The replacement authority carries the
    // counter this update's application will expect: one past the counter
    // the update itself is built against.
    if (wave.retiresAuthority) {
      updates.push(new ReplaceAuthority(new ContractMaintenanceAuthority([], 1, counter + 1n)));
    }
    console.log(
      `  wave ${wave.index}: one maintenance update inserting ${wave.circuits.length} ` +
      `verifier keys (${wave.verifierBytes} verifier bytes, authority counter ${counter})` +
      (wave.retiresAuthority
        ? ', then retiring the maintenance authority'
        : ''),
    );

    const signingKey = deployData.private.signingKey;
    const bare = new MaintenanceUpdate(address, updates, counter);
    const signedUpdate = bare.addSignature(0n, signData(signingKey, bare.dataToSign));
    const waveTtl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
    const waveTx = Transaction.fromParts(
      getNetworkId(), undefined, undefined, Intent.new(waveTtl).addMaintenanceUpdate(signedUpdate),
    );
    const waveFinal: any = await withDustRetry(`wave-${wave.index} maintenance`, () =>
      (submitTx as any)(providers, { unprovenTx: waveTx }));
    if (waveFinal.status && String(waveFinal.status).toLowerCase().includes('fail')) {
      throw new Error(`wave-${wave.index} maintenance failed: ${JSON.stringify(waveFinal.status)}`);
    }
    // Do not build the next update until the chain shows this one applied:
    // the next counter read must be the advanced value, not the stale one.
    await awaitAuthorityCounter(providers, address, counter + 1n);
  }

  if (!retire) {
    console.log('  authority left LIVE (retireAuthority: false)');
  }

  return address;
}
