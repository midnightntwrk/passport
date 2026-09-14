// P9 helpers — reading calls and claims out of an unproven ledger
// transaction, and grafting two independently built call transactions into
// ONE intent (the shape the ledger's caller derivation inspects).
//
// Kept separate from the probe so the byte-level composition can be shaken
// out chainless (fixtures from createUnprovenDeployTxFromVerifierKeys plus
// createUnprovenCallTxFromInitialStates) before the localnet stage.
//
// Ground truth this module encodes (ledger tag ledger-9.1.0.0-rc.3):
//
//   - ContractCall.communicationCommitment at the wasm boundary is
//     to_hex_ser(&Fr) (ledger-wasm/src/contract.rs): Fr serialises as a
//     SCALE compact big-integer (transient-crypto/src/curve.rs ->
//     serialize/src/util.rs ScaleBigInt): a marker byte whose low two bits
//     select the mode, then the little-endian magnitude. For a uniformly
//     random Fr that is 0x73 (= (33-5)<<2 | 0b11) followed by 32 LE bytes,
//     which is what every commitment observed on this stack looks like.
//   - The Compact `Field` a circuit receives from TypeScript is a bigint;
//     the runtime encodes it as a field atom (LE bytes), which is exactly
//     the Fr's magnitude. So the bigint the Lender must be handed is the LE
//     integer of the Fr's 32 magnitude bytes. Verified offline: feeding
//     that bigint to Lender.lend emits a claim whose commitment bytes are
//     byte-for-byte the source call's communicationCommitment.
//   - ep_hash = persistent_commit(entry_point_bytes, "midnight:entry-point"
//     padded to 32 bytes) (onchain-state/src/state.rs). Exposed as
//     `entryPointHash` by BOTH @midnightntwrk/ledger-v9 and
//     @midnight-ntwrk/compact-runtime, and the two agree.
//   - Effects.claimedContractCalls is Array<[seq, ContractAddress, ep_hash,
//     Fr]>; the runtime sets seq = size of the claimed set at emission time
//     (so a contract claiming one call emits seq 0).
//   - A ContractCall<PreProof> carries no intent binding: the binding input
//     is injected at proving time from the call's own fields plus the
//     transaction's binding commitment (ledger/src/prove.rs, verify.rs), and
//     Transaction.intents / Intent.actions are writable while unbound and
//     unproven (ledger-v9.d.ts: "writing to this re-computes binding
//     information if and only if this transaction is unbound *and*
//     unproven"). Moving an unproven call between intents is therefore a
//     construction-legal operation; whether the RESULT is accepted is what
//     the probe measures.
//   - Two ordering rules bear on the composition, both in verify.rs:
//     call_sequencing_check requires a claimed call to sit at a STRICTLY
//     GREATER position in the intent than its claimant, and effects_check
//     requires (a) every claim to match a real call in the same segment
//     (RealCallsSubsetCheckFailure) and (b) no two claims on one triple in
//     one segment (ClaimedCallsUniquenessFailure). The claimant therefore
//     goes FIRST in the merged action sequence.

import * as ledger from '@midnightntwrk/ledger-v9';
import { entryPointHash as runtimeEntryPointHash } from '@midnight-ntwrk/compact-runtime';

import {
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as LenderModule from '../../contracts/managed/Lender/contract/index.js';

import { compiledWitnessFree, contractRefArg } from '../node/setup.js';
import { tallyZkConfigPath, lenderZkConfigPath } from '../node/wallet.js';
import { serialiseError } from './evidence.js';
import { bytesToHex, hexToBytes } from '../wallet/hex.js';

// ── SCALE compact big-integer -> bigint ─────────────────────────────────────

export interface ScaleDecoded {
  mode: 'one-byte' | 'two-byte' | 'four-byte' | 'n-byte';
  /** Little-endian magnitude bytes. */
  leBytes: Uint8Array;
  value: bigint;
}

function leToBigInt(le: Uint8Array): bigint {
  let v = 0n;
  for (let i = le.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(le[i]);
  return v;
}

/** Decode a SCALE compact-integer byte string (serialize/src/util.rs). */
export function scaleCompactDecode(bytes: Uint8Array): ScaleDecoded {
  if (bytes.length === 0) throw new Error('empty SCALE encoding');
  const first = bytes[0];
  switch (first & 0b11) {
    case 0b00: {
      if (bytes.length !== 1) throw new Error(`one-byte SCALE mode with ${bytes.length} bytes`);
      const le = new Uint8Array([first >> 2]);
      return { mode: 'one-byte', leBytes: le, value: leToBigInt(le) };
    }
    case 0b01: {
      if (bytes.length !== 2) throw new Error(`two-byte SCALE mode with ${bytes.length} bytes`);
      const v = (first >> 2) | (bytes[1] << 6);
      const le = new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
      return { mode: 'two-byte', leBytes: le, value: BigInt(v) };
    }
    case 0b10: {
      if (bytes.length !== 4) throw new Error(`four-byte SCALE mode with ${bytes.length} bytes`);
      const v = ((first >> 2) | (bytes[1] << 6) | (bytes[2] << 14) | (bytes[3] << 22)) >>> 0;
      const le = new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
      return { mode: 'four-byte', leBytes: le, value: BigInt(v) };
    }
    default: {
      const n = (first >> 2) + 4; // number of magnitude bytes that follow
      if (bytes.length !== n + 1) {
        throw new Error(`n-byte SCALE mode announces ${n} bytes but ${bytes.length - 1} follow`);
      }
      const le = bytes.slice(1);
      return { mode: 'n-byte', leBytes: le, value: leToBigInt(le) };
    }
  }
}

/** The bigint a Compact `Field` parameter must receive for this Fr hex. */
export function frHexToBigInt(frHex: string): bigint {
  return scaleCompactDecode(hexToBytes(frHex.replace(/^0x/, ''))).value;
}

// ── Entry-point hash ────────────────────────────────────────────────────────

const hexString = (v: unknown): string =>
  v instanceof Uint8Array ? bytesToHex(v) : String(v).replace(/^0x/, '').toLowerCase();

/** ep_hash(name) as hex; cross-checked between ledger-v9 and compact-runtime. */
export function entryPointHashHex(entryPoint: string): string {
  const viaLedger = hexString((ledger as any).entryPointHash(entryPoint));
  const viaRuntime = hexString(runtimeEntryPointHash(entryPoint as any));
  if (viaLedger !== viaRuntime) {
    throw new Error(`entryPointHash disagrees: ledger ${viaLedger} vs runtime ${viaRuntime}`);
  }
  if (viaLedger.length !== 64) {
    throw new Error(`entryPointHash is ${viaLedger.length / 2} bytes, expected 32`);
  }
  return viaLedger;
}

/** ep_hash(name) as the Bytes<32> the Lender circuit takes. */
export function entryPointHashBytes(entryPoint: string): Uint8Array {
  return hexToBytes(entryPointHashHex(entryPoint));
}

// ── Reading calls and claims out of a transaction ───────────────────────────

export interface ClaimView {
  section: 'guaranteed' | 'fallible';
  seq: string;
  address: string;
  entryPointHash: string;
  commitment: string;
}

export interface CallView {
  segment: number;
  index: number;
  address: string;
  entryPoint: string;
  entryPointHash: string;
  communicationCommitment: string;
  /** The commitment as the bigint a Compact `Field` argument must carry. */
  commBigInt: string;
  claims: ClaimView[];
  unshieldedInputsInIntent: number;
}

function claimsOf(section: 'guaranteed' | 'fallible', transcript: any): ClaimView[] {
  const list: any[] = transcript?.effects?.claimedContractCalls ?? [];
  return list.map((c: any) => ({
    section,
    seq: String(c[0]),
    address: hexString(c[1]),
    entryPointHash: hexString(c[2]),
    commitment: hexString(c[3]),
  }));
}

/** Every ContractCall in every intent of `tx`, with its claims, in order. */
export function listCalls(tx: any): CallView[] {
  const out: CallView[] = [];
  const intents: Map<number, any> | undefined = tx.intents;
  if (!intents) return out;
  for (const [segment, intent] of intents) {
    const actions: any[] = intent.actions ?? [];
    const gOffer = intent.guaranteedUnshieldedOffer;
    const fOffer = intent.fallibleUnshieldedOffer;
    const unshieldedInputs = (gOffer?.inputs?.length ?? 0) + (fOffer?.inputs?.length ?? 0);
    actions.forEach((a, index) => {
      if (a?.entryPoint === undefined || a?.communicationCommitment === undefined) return;
      const entryPoint = typeof a.entryPoint === 'string' ? a.entryPoint : hexString(a.entryPoint);
      const comm = hexString(a.communicationCommitment);
      out.push({
        segment: Number(segment),
        index,
        address: hexString(a.address),
        entryPoint,
        entryPointHash: hexString((ledger as any).entryPointHash(a.entryPoint)),
        communicationCommitment: comm,
        commBigInt: frHexToBigInt(comm).toString(),
        claims: [
          ...claimsOf('guaranteed', a.guaranteedTranscript),
          ...claimsOf('fallible', a.fallibleTranscript),
        ],
        unshieldedInputsInIntent: unshieldedInputs,
      });
    });
  }
  return out;
}

/** The one call at `address` with entry point `entryPoint`, or throw. */
export function findCall(tx: any, address: string, entryPoint: string): CallView {
  const addr = address.replace(/^0x/, '').toLowerCase();
  const hits = listCalls(tx).filter(
    (c) => c.address.toLowerCase() === addr && c.entryPoint === entryPoint,
  );
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one ${entryPoint}@${addr.slice(0, 12)} call, found ${hits.length}`,
    );
  }
  return hits[0];
}

/** The single intent of a one-intent transaction (segment id and Intent). */
export function soleIntent(tx: any): { segment: number; intent: any } {
  const intents: Map<number, any> | undefined = tx.intents;
  if (!intents || intents.size !== 1) {
    throw new Error(`expected exactly one intent, found ${intents?.size ?? 0}`);
  }
  const [segment, intent] = [...intents.entries()][0];
  return { segment: Number(segment), intent };
}

// ── Grafting ────────────────────────────────────────────────────────────────

export interface GraftResult {
  tx: any;
  segment: number;
  actionCount: number;
  order: string[];
}

/**
 * ONE-INTENT graft (the P9 shape): move every action of `donor`'s sole intent
 * into `base`'s sole intent, so the ledger's per-intent caller derivation,
 * per-segment effects_check, and per-intent call_sequencing_check see both
 * calls together. Both transactions must be unproven and unbound.
 *
 * `position` places the donor's actions before ('prepend') or after
 * ('append') the base's own. It is load-bearing: verify.rs's
 * call_sequencing_check requires a claimed call to sit at a strictly greater
 * index than the call claiming it.
 */
export function graftIntoOneIntent(
  base: any,
  donor: any,
  position: 'append' | 'prepend' = 'append',
): GraftResult {
  const b = soleIntent(base);
  const d = soleIntent(donor);
  const baseActions: any[] = b.intent.actions ?? [];
  const donorActions: any[] = d.intent.actions ?? [];
  const merged =
    position === 'append' ? [...baseActions, ...donorActions] : [...donorActions, ...baseActions];
  // The getters hand back wrapper copies: mutate the copy, then write the
  // whole intents map back (the setter recomputes the binding randomness).
  b.intent.actions = merged;
  const map = new Map<number, any>();
  map.set(b.segment, b.intent);
  base.intents = map;
  const after = listCalls(base);
  return {
    tx: base,
    segment: b.segment,
    actionCount: after.length,
    order: after.map((c) => `${c.entryPoint}@${c.address.slice(0, 12)}`),
  };
}

// ── Summaries for evidence ──────────────────────────────────────────────────

/**
 * Does every claim in `tx` name a real call in the same segment, and is no
 * triple claimed twice? This is the TypeScript reading of effects_check —
 * a pre-flight expectation, NOT the ledger's verdict.
 */
export function claimAudit(tx: any): Record<string, unknown> {
  const calls = listCalls(tx);
  const key = (segment: number, addr: string, ep: string, comm: string) =>
    `${segment}|${addr}|${ep}|${comm}`;
  const real = new Set(
    calls.map((c) => key(c.segment, c.address, c.entryPointHash, c.communicationCommitment)),
  );
  const seen = new Map<string, number>();
  const unmatched: string[] = [];
  const matched: Array<Record<string, unknown>> = [];
  for (const c of calls) {
    for (const cl of c.claims) {
      const k = key(c.segment, cl.address, cl.entryPointHash, cl.commitment);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      const target = calls.find(
        (t) =>
          t.segment === c.segment &&
          t.address === cl.address &&
          t.entryPointHash === cl.entryPointHash &&
          t.communicationCommitment === cl.commitment,
      );
      if (!target) {
        unmatched.push(`${c.entryPoint}@${c.address.slice(0, 12)} claims ${cl.commitment.slice(0, 16)}`);
      } else {
        matched.push({
          claimant: `${c.entryPoint}@${c.address.slice(0, 12)}`,
          claimantIndex: c.index,
          claimed: `${target.entryPoint}@${target.address.slice(0, 12)}`,
          claimedIndex: target.index,
          sequencingOk: c.index < target.index,
        });
      }
    }
  }
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return {
    // Expectations under verify.rs; the node has the last word.
    subsetCheckExpected: unmatched.length === 0 ? 'pass' : 'FAIL (RealCallsSubsetCheckFailure)',
    uniquenessCheckExpected:
      duplicated.length === 0 ? 'pass' : 'FAIL (ClaimedCallsUniquenessFailure)',
    sequencingCheckExpected: matched.every((m) => m.sequencingOk)
      ? 'pass'
      : 'FAIL (CallSequencingViolation)',
    matched,
    unmatched,
    duplicated,
  };
}

export function summariseTx(tx: any): Record<string, unknown> {
  let bytes: number | null = null;
  try {
    bytes = tx.serialize().length;
  } catch {
    bytes = null;
  }
  return {
    serializedBytes: bytes,
    segments: tx.intents ? [...tx.intents.keys()].map(Number) : [],
    calls: listCalls(tx),
    claimAudit: claimAudit(tx),
  };
}

// ── The offline composition (no node, no indexer) ──────────────────────────
//
// Lives here rather than in the probe so it can be exercised chainless.


/**
 * Build the whole composition offline, exactly as P8's offline arm builds
 * write_then_read: the contracts "deployed" through midnight-js's own deploy
 * path (keyed initial states, derived addresses), a local callee-state stub
 * in place of the indexer, verifier keys from disk, dummy wallet keys. This
 * answers the construction-legality half of the question without touching a
 * chain, and it proves the Field encoding: the commitment read off the set
 * call, handed to Lender.lend as a bigint, must come back out of the lend
 * transcript as the same 33 bytes.
 */
export async function buildOfflineComposition(
  details: Record<string, unknown>,
  value: bigint,
): Promise<Uint8Array | null> {
  const offline: Record<string, unknown> = {};
  details.offline = offline;
  try {
    const COIN_PK = '0'.repeat(64);
    const ENC_PK = '0'.repeat(64);
    const blockHash = 'de'.repeat(32);

    const offlineDeploy = async (name: string, mod: any, zkPath: string) => {
      const d: any = await (createUnprovenDeployTxFromVerifierKeys as any)(
        new NodeZkConfigProvider(zkPath),
        COIN_PK,
        { compiledContract: compiledWitnessFree(name, mod, zkPath) },
        ENC_PK,
      );
      return {
        address: d.public.contractAddress as string,
        state: d.public.initialContractState,
      };
    };

    const tally = await offlineDeploy('tally', TallyModule, tallyZkConfigPath);
    const lender = await offlineDeploy('lender', LenderModule, lenderZkConfigPath);
    offline.addressesFrom =
      'offline deploy (ContractDeploy.address of locally built deploy transactions; NOT the live pair)';
    offline.tallyAddress = tally.address;
    offline.lenderAddress = lender.address;

    const buildCall = async (
      name: string,
      mod: any,
      zkPath: string,
      address: string,
      state: any,
      circuitId: string,
      args: unknown[],
    ) => {
      const built: any = await (createUnprovenCallTxFromInitialStates as any)(
        new NodeZkConfigProvider(zkPath),
        {
          compiledContract: compiledWitnessFree(name, mod, zkPath),
          contractAddress: address,
          circuitId,
          args,
          coinPublicKey: COIN_PK,
          initialContractState: state,
          initialZswapChainState: new (ledger as any).ZswapChainState(),
          ledgerParameters: (ledger as any).LedgerParameters.initialParameters(),
        },
        ENC_PK,
        {
          publicDataProvider: {
            queryContractState: async (a: string) =>
              a.replace(/^0x/, '').toLowerCase() === address.replace(/^0x/, '').toLowerCase()
                ? state
                : null,
          },
          blockHash,
        },
      );
      return built.private.unprovenTx;
    };

    const t0 = performance.now();
    const setTx = await buildCall(
      'tally', TallyModule, tallyZkConfigPath, tally.address, tally.state, 'set', [value],
    );
    const setCall = findCall(setTx, tally.address, 'set');
    offline.setCall = {
      entryPoint: setCall.entryPoint,
      entryPointHash: setCall.entryPointHash,
      communicationCommitment: setCall.communicationCommitment,
      commBigInt: setCall.commBigInt,
    };

    const lendTx = await buildCall(
      'lender', LenderModule, lenderZkConfigPath, lender.address, lender.state, 'lend',
      [contractRefArg(tally.address), entryPointHashBytes('set'), BigInt(setCall.commBigInt)],
    );
    offline.buildMs = Math.round(performance.now() - t0);

    // The Field round trip: the claim the Lender emitted must carry the
    // source call's commitment byte for byte.
    const lendCall = findCall(lendTx, lender.address, 'lend');
    const claim = lendCall.claims[0];
    offline.claimEmitted = claim ?? null;
    offline.fieldRoundTrip =
      claim &&
      claim.address === setCall.address &&
      claim.entryPointHash === setCall.entryPointHash &&
      claim.commitment === setCall.communicationCommitment
        ? 'exact (address, ep_hash, and commitment all match the source call)'
        : 'MISMATCH — the Field encoding does not reproduce the commitment';

    const graft = graftIntoOneIntent(lendTx, setTx, 'append');
    offline.graft = { accepted: true, segment: graft.segment, order: graft.order };
    offline.merged = summariseTx(graft.tx);
    offline.possible = true;
    console.log(
      `  offline composition OK: [${graft.order.join(', ')}] in segment ${graft.segment}; ` +
      `field round trip: ${offline.fieldRoundTrip}`,
    );
    return graft.tx.serialize();
  } catch (e: any) {
    offline.possible = false;
    offline.error = serialiseError(e);
    console.log(`  offline composition NOT possible: ${e?.message ?? e}`);
    return null;
  }
}
