// Test-only helpers for the `sol_ed25519` constraint-level negatives, on
// top of constraint-negative.ts:
//
//   - loadPatched: constraint-negative.ts's loadBypassedContract over the
//     compiled account module (named asserts record instead of throwing;
//     named runtime functions replaced through `overrides`); the patch is
//     client-side only, the proof server still sees the real constraints,
//     and a copy with overrides needs a positive control proved through it;
//   - runtime overrides that let a value the generated JavaScript refuses
//     reach the transcript: a point outside the prime-order subgroup
//     (TYPE_OVERRIDES), a non-canonical limb encoding of a point's y
//     (LIMB_OVERRIDES) or of a signature scalar (S + L), and a byte input of
//     256 or more (HINT_OVERRIDES);
//   - a local account: a constructor state, then each call executed locally
//     from the previous call's state (the "simulator"), optionally proved by
//     the proof server; no node, no wallet;
//   - a local Zswap commitment tree holding chosen contract-owned coins at
//     known indexes, and a coin store whose `held_coin` answers are chosen
//     by the test (witness substitution): the Zswap half of a shielded spend
//     is then valid for the substituted coin, so a refusal is the arm
//     circuit's own;
//   - the calling contract `kernel.caller()` presents, injected
//     into the local call context (a root call has none; the ledger
//     authenticates the real caller at admission); a ledger-cell copy that
//     builds a state no shared chip produces (a grant record of an older
//     generation); and a forged grant-id mutant (GRANT_ID_FORGE_OVERRIDES):
//     the copy's JavaScript derives another grant's id from the presented
//     blind, so a call through an id with no record reaches the proof server;
//   - relaxedContractsModule: a copy of midnight-js-contracts without the
//     client-side claim pre-check, for the first half of a direct transfer.

import * as path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { LedgerParameters, ZswapChainState, ZswapOffer, ZswapOutput, ZswapSecretKeys, sampleSigningKey } from '@midnightntwrk/ledger-v9';
// midnight-js keeps contract state in the on-chain runtime's classes (via compact-runtime).
import { ChargedState, ContractState, StateValue } from '@midnight-ntwrk/compact-runtime';
import { CONFIG, zkConfigPath } from '../node/wallet.js';
import { emptyCoinStore, makeWitnesses, type CoinStorePrivateState } from '../wallet/witnesses.js';
import { loadBypassedContract, recordingProofProvider, type BypassedContractModule, type ProofServerRequest } from './constraint-negative.js';

export const ACCOUNT_JS = path.join(zkConfigPath, 'contract', 'index.js');
export const Original: any = await import(pathToFileURL(ACCOUNT_JS).href);
export const zk = new NodeZkConfigProvider(zkConfigPath);
export const proofLog: ProofServerRequest[] = [];
/** The requests of a transaction's Zswap parts (spends and outputs), kept
 *  apart from `proofLog`: the ledger proves a shielded transaction's parts
 *  concurrently, so a Zswap `/prove` can be recorded after the arm circuit's
 *  refusing `/check`, and the base helper attributes a refusal to the LAST
 *  recorded request (it would then call a genuine refusal "not a verdict").
 *  `proofLog` therefore holds only contract-circuit requests. */
export const zswapLog: ProofServerRequest[] = [];
const routedLog = {
  push(...items: ProofServerRequest[]) {
    for (const r of items) (String(r.keyLocation).startsWith('contract:') ? proofLog : zswapLog).push(r);
    return proofLog.length;
  },
} as unknown as ProofServerRequest[];

// The base helper's recording provider sends every proof-server request over
// its own connection (constraint-negative.ts freshConnection).
export const proofProvider = recordingProofProvider(CONFIG.proofServer, zk, routedLog);
const coinPublicKey = '00'.repeat(32);
const encryptionPublicKey = '00'.repeat(32);
const privateState = emptyCoinStore(new Uint8Array(32).fill(7));

/** A patched copy of the account module (constraint-negative.ts). */
export const loadPatched = (bypass: readonly string[], overrides = ''): Promise<BypassedContractModule> =>
  loadBypassedContract(ACCOUNT_JS, bypass, overrides ? { overrides } : {});

// ── Runtime overrides ───────────────────────────────────────────────────────

const ST = "globalThis[Symbol.for('sol-ed25519-tests.overrides')]";
/** The state the overrides below read and count (which point or scalar to
 *  encode non-canonically, how many times each override fired). */
export const overrideState: { typeBypass: number; nonCanonical: number; target?: { x: bigint; y: bigint }; scalarTarget?: bigint } =
  ((globalThis as any)[Symbol.for('sol-ed25519-tests.overrides')] ??= { typeBypass: 0, nonCanonical: 0 });

/** The Curve25519Point validator accepts any point (each point it would have
 *  refused is counted), so a point outside the prime-order subgroup reaches
 *  the transcript; the proof server's input decoding is then the refusal. */
export const TYPE_OVERRIDES = `
  isValidCurve25519Point(p) { const v = __compactRuntimeOriginal.isValidCurve25519Point(p); if (!v) ${ST}.typeBypass++; return true; },`;

/** The point \`overrideState.target\` is encoded with a non-canonical
 *  limb encoding of its y: the runtime encodes (y - 1) as a 192 + 64-bit limb
 *  pair; this sends (y - 1 + p), the same residue in a form an honest encoder
 *  never produces. Any other point is encoded honestly. */
export const LIMB_OVERRIDES = `
  CompactTypeCurve25519Point: {
    alignment: () => __compactRuntimeOriginal.CompactTypeCurve25519Point.alignment(),
    fromValue: (v) => __compactRuntimeOriginal.CompactTypeCurve25519Point.fromValue(v),
    toValue: (pt) => {
      const st = ${ST};
      if (!st.target || pt.x !== st.target.x || pt.y !== st.target.y) return __compactRuntimeOriginal.CompactTypeCurve25519Point.toValue(pt);
      st.nonCanonical++;
      const P = (1n << 255n) - 19n, v = pt.y - 1n + P;
      return __compactRuntimeOriginal.CompactTypeCurve25519Base.toValue(pt.x)
        .concat(__compactRuntimeOriginal.bigIntToValue(v & ((1n << 192n) - 1n)))
        .concat(__compactRuntimeOriginal.bigIntToValue(v >> 192n));
    },
  },`;

/** S + L: the scalar \`overrideState.scalarTarget\` is sent as s + L (its
 *  encoding of (s + L) - 1 in the 204 + 52-bit limbs). */
export const SL_OVERRIDES = `
  CompactTypeCurve25519Scalar: {
    alignment: () => __compactRuntimeOriginal.CompactTypeCurve25519Scalar.alignment(),
    fromValue: (v) => __compactRuntimeOriginal.CompactTypeCurve25519Scalar.fromValue(v),
    toValue: (s) => {
      const st = ${ST};
      if (st.scalarTarget === undefined || s !== st.scalarTarget) return __compactRuntimeOriginal.CompactTypeCurve25519Scalar.toValue(s);
      st.nonCanonical++;
      const L = (1n << 252n) + 27742317777372353535851937790883648493n, v = s + L - 1n;
      return __compactRuntimeOriginal.bigIntToValue(v & ((1n << 204n) - 1n)).concat(__compactRuntimeOriginal.bigIntToValue(v >> 204n));
    },
  },`;

const HS = "globalThis[Symbol.for('sol-ed25519-tests.hints')]";
/** The state the byte-input override below reads and counts: whether it is
 *  on, how many argument type checks it suspended, and how many bytes of 256
 *  or more it encoded. */
export const hintOverride: { on: boolean; typeErrors: number; ranges: number } =
  ((globalThis as any)[Symbol.for('sol-ed25519-tests.hints')] ??= { on: false, typeErrors: 0, ranges: 0 });

/** While \`hintOverride.on\`, every \`Vector<32, Uint<8>>\` argument is encoded
 *  with two-byte atoms instead of one-byte atoms, and the argument type
 *  checks are suspended (each counted). For every byte value the two
 *  encodings give the same proof preimage, so an honest call proves
 *  unchanged; an element of 256 or more (the carry attack: a byte plus 256,
 *  its neighbour minus one) can then be encoded, and reaches the proof server
 *  as that field element, where only the circuit's 8-bit range check on the
 *  input can refuse it. Off, the copy behaves as the original. */
export const HINT_OVERRIDES = `
  typeError(...a) { const h = ${HS}; if (h && h.on) { h.typeErrors++; return; } return __compactRuntimeOriginal.typeError(...a); },
  CompactTypeVector: class extends __compactRuntimeOriginal.CompactTypeVector {
    wide() { const h = ${HS}; return !!(h && h.on) && this.length === 32 && this.type instanceof __compactRuntimeOriginal.CompactTypeUnsignedInteger && this.type.maxValue === 255n && this.type.length === 1; }
    alignment() { if (!this.wide()) return super.alignment(); return Array.from({ length: 32 }, () => ({ tag: 'atom', value: { tag: 'bytes', length: 2 } })); }
    toValue(v) {
      if (!this.wide()) return super.toValue(v);
      const h = ${HS};
      return v.flatMap((x) => { if (x > 255n) h.ranges++; return __compactRuntimeOriginal.bigIntToValue(x); });
    }
  },`;

/** Sets the CALLER the call context presents to \`kernel.caller()\`:
 *  before each ledger query of the copy, the current query context's block
 *  carries \`callerInjection\`'s caller (\`{ tag: 'contract', address }\`). A
 *  root call built by midnight-js has no caller, and a caller can only come
 *  from a call tree, which this local harness cannot build; the caller is a
 *  context value that the ledger authenticates at admission, so this
 *  injection exercises exactly what the circuit does with it (the caller pin
 *  of upstream's shared check_spend_scope) and nothing the prover could
 *  choose on chain. With no caller set, calls through the copy behave as
 *  through the original. */
export const CALLER_OVERRIDES = `
  queryLedgerState(context, partialProofData, program) {
    const c = globalThis[Symbol.for('sol-ed25519-tests.injectCaller')];
    const q = c && c.tag && context && context.callContext && context.callContext.currentQueryContext;
    if (q) q.block = { ...q.block, caller: c };
    const r = __compactRuntimeOriginal.queryLedgerState(context, partialProofData, program);
    // a NON-CANONICAL absent caller: kernel.caller()'s read (dup 2,
    // context index 6, then a type test) answers the canonical none
    // { is_some: false, value: { is_left: false, ... } }; the copy flips
    // is_left to true in the value the circuit receives, which is the same
    // object as the read's popeq result in the public transcript (a declared
    // read the node's transcript replay would refuse)
    if (c && c.nonCanonicalAbsent && r && Array.isArray(r.value) && r.value.length === 4 && r.value[0].length === 0
        && Array.isArray(program) && program[0] && program[0].dup && program[0].dup.n === 2 && program.includes('type')
        && program[1] && program[1].idx && program[1].idx.path[0].value.value[0][0] === 6) {
      // in place: the read's result object is also the transcript's popeq result
      r.value[1] = __compactRuntimeOriginal.CompactTypeBoolean.toValue(true)[0];
      c.flipped++;
      return r;
    }
    return r;
  },`;

const CALLER = Symbol.for('sol-ed25519-tests.injectCaller');
export const callerInjection = {
  /** The contract the next calls through a CALLER_OVERRIDES copy present as
   *  their caller (undefined: none, as for a root call). */
  set(contract: Uint8Array | undefined) {
    (globalThis as any)[CALLER] = contract && { tag: 'contract', address: Buffer.from(contract).toString('hex') };
  },
  /** A USER (not a contract) as the caller (the type assert alone). */
  setUser(user: Uint8Array) {
    (globalThis as any)[CALLER] = { tag: 'user', address: Buffer.from(user).toString('hex') };
  },
  /** No caller, but answered NON-CANONICALLY: is_some = false with
   *  value.is_left = true and value.left = the zero address, so that only the
   *  presence assert fails. The ledger never produces it (kernel.caller()'s
   *  read program pushes the canonical none, is_left false, for an absent
   *  caller); it exists only as a prover-declared read. */
  setNonCanonicalAbsent() {
    (globalThis as any)[CALLER] = { nonCanonicalAbsent: true, flipped: 0 };
  },
  /** How many caller reads the last setNonCanonicalAbsent() flipped. */
  flipped(): number { return (globalThis as any)[CALLER]?.flipped ?? 0; },
};

/** The forged grant-id mutant, as a runtime override of
 *  \`persistentHash\`: for the grant-id preimage
 *  [tag, account, key, blind, origin_hash, slot] whose blind is the one
 *  \`grantIdForgery.set\` names, the copy's JavaScript derives the chosen
 *  (victim's) grant id instead. The transcript then reads the victim grant's
 *  record (it exists, so the generated JavaScript and the transcript's
 *  partition go through), while the circuit derives the id from the presented
 *  key and blind: an id with no record, which only the proof can refuse. Any
 *  other hash is the real one, so honest calls through the copy behave as
 *  through the original (its positive control proves one). */
export const GRANT_ID_FORGE_OVERRIDES = `
  persistentHash(descriptor, value) {
    const f = globalThis[Symbol.for('sol-ed25519-tests.forgeGrantId')];
    const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
    if (f && Array.isArray(value) && value.length === 6 && same(value[0], f.tag) && same(value[3], f.blind)) { f.fired++; return new Uint8Array(f.id); }
    return __compactRuntimeOriginal.persistentHash(descriptor, value);
  },`;

const FORGE_GRANT_ID = Symbol.for('sol-ed25519-tests.forgeGrantId');
export const grantIdForgery = {
  /** The copy derives grant id \`id\` from any grant-id preimage with this
   *  tag and blind (undefined: no forgery). */
  set(target: { tag: Uint8Array; blind: Uint8Array; id: Uint8Array } | undefined) {
    (globalThis as any)[FORGE_GRANT_ID] = target && { tag: new Uint8Array(target.tag), blind: new Uint8Array(target.blind), id: new Uint8Array(target.id), fired: 0 };
  },
  get fired(): number { return (globalThis as any)[FORGE_GRANT_ID]?.fired ?? 0; },
};

/** A copy of account `a` whose ledger cell at the two-level `path`
 *  (top-level index, then index inside it) is the one `from` holds there.
 *  It builds a state no shared chip produces (a grant record of an
 *  older grant generation: revoke_all_grants clears the map, as the MIP
 *  permits, so the "grant generation stale" assert is defence in depth and
 *  is otherwise unreachable); the proof server only sees the transcript of
 *  the reads, so the constraint is exercised as it would be on such a
 *  ledger. */
export function withLedgerCell(a: LocalAccount, from: LocalAccount, path2: [number, number]): LocalAccount {
  const top = a.state.data.state.asArray();
  const src = from.state.data.state.asArray();
  if (!top || !src) throw new Error('withLedgerCell: the ledger root is not an array');
  const sub = top[path2[0]].asArray(), srcSub = src[path2[0]].asArray();
  if (!sub || !srcSub) throw new Error('withLedgerCell: the path does not name an array');
  let newSub = StateValue.newArray();
  sub.forEach((v: any, i: number) => { newSub = newSub.arrayPush(i === path2[1] ? srcSub[i] : v); });
  let newTop = StateValue.newArray();
  top.forEach((v: any, i: number) => { newTop = newTop.arrayPush(i === path2[0] ? newSub : v); });
  const next = ContractState.deserialize(a.state.serialize());
  next.data = new ChargedState(newTop);
  return { ...a, state: next };
}

// ── A call builder for a direct transfer's first half ───────────────────────
//
// midnight-js 5.0.0-rc.2 refuses to assemble a call whose shielded output is
// addressed to a contract that does not claim it inside the SAME call tree
// (`assertReceivesMatchClaims`). A direct transfer
// (`withdraw_shielded_to_contract_*`, MIP-0012 §6.6) is claimed by the
// recipient's own `deposit_shielded` call, so the sender's half can only be
// built with that client-side pre-check removed. This loads a copy of
// midnight-js-contracts whose only change is that call (its bare imports
// resolved to the same module instances); proving does not depend on it, and
// the node still checks the claim on a composed transaction.
const MJS_CHECK = '    assertReceivesMatchClaims(calls, segmentedOffers);\n';
let relaxed: any;
export async function relaxedContractsModule(): Promise<any> {
  if (relaxed) return relaxed;
  const url = import.meta.resolve('@midnight-ntwrk/midnight-js-contracts');
  const src = await readFile(new URL(url), 'utf8');
  if (src.split(MJS_CHECK).length !== 2) throw new Error('sol-ed25519-negative: midnight-js claim pre-check not found where expected');
  let body = src.replace(MJS_CHECK, '    /* claim pre-check removed for a direct transfer composed by the test */\n');
  body = body.replace(/from '(@[^']+)'/g, (_m, spec) => `from ${JSON.stringify(import.meta.resolve(spec))}`)
             .replace(/from 'effect'/g, `from ${JSON.stringify(import.meta.resolve('effect'))}`)
             .replace(/^\/\/# sourceMappingURL=.*$/m, '');
  const dir = await mkdtemp(path.join(tmpdir(), 'sol-ed25519-mjs-'));
  const file = path.join(dir, 'index.mjs');
  await writeFile(file, body);
  relaxed = await import(pathToFileURL(file).href);
  return relaxed;
}

// ── A local account ─────────────────────────────────────────────────────────

const compiled = (C: any) => (CompiledContract.make('account', C) as any).pipe(
  (CompiledContract as any).withWitnesses(makeWitnesses()),
  (CompiledContract as any).withCompiledFileAssets(zkConfigPath),
);

export interface LocalAccount {
  contractAddress: string;
  addressBytes: Uint8Array;
  state: ContractState;
  /** The local Zswap commitment tree (default: empty). */
  zswap?: ZswapChainState;
  /** The coin store the held_coin witness answers from (default: empty). */
  privateState?: CoinStorePrivateState;
  /** Build calls as the local wallet `localKeys` (needed for outputs to a
   *  user's Zswap key); default: the all-zero keys. */
  withKeys?: boolean;
}

/** A deterministic local wallet (coin and encryption keys) for shielded
 *  outputs to a user's key. */
export const localKeys = ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(0x5b));
export const localCoinPublicKeyBytes = (): Uint8Array => new Uint8Array(Buffer.from(String(localKeys.coinPublicKey), 'hex'));

const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

export interface LocalCoin { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint }

/** Inserts contract-owned coins of `a` into its local Zswap tree, in order;
 *  returns each coin with the Merkle index it received. */
export function withLocalCoins(a: LocalAccount, coins: { nonce: Uint8Array; color: Uint8Array; value: bigint }[]): { account: LocalAccount; coins: LocalCoin[] } {
  let st = a.zswap ?? new ZswapChainState();
  const out: LocalCoin[] = [];
  for (const c of coins) {
    const info = { type: hexOf(c.color), nonce: hexOf(c.nonce), value: c.value } as any;
    const o = ZswapOutput.newContractOwned(info, 0, a.contractAddress as any);
    const at = st.firstFree;
    const [next, inserted] = st.tryApply(ZswapOffer.fromOutput(o as any, info.type, info.value));
    const idx = inserted.get(o.commitment) ?? at;
    if (next.firstFree !== at + 1n) throw new Error('withLocalCoins: the coin was not inserted into the local tree');
    st = next;
    out.push({ ...c, mtIndex: idx });
  }
  return { account: { ...a, zswap: st, withKeys: true }, coins: out };
}

/** A coin store whose `held_coin(color)` answers `coin` for each listed
 *  colour key (the coin's own colour may differ: witness substitution). */
export function coinStoreAnswering(entries: { key: Uint8Array; coin: LocalCoin }[]): CoinStorePrivateState {
  const s = emptyCoinStore(new Uint8Array(32).fill(7));
  for (const { key, coin } of entries) {
    s.coins[hexOf(key)] = { nonceHex: hexOf(coin.nonce), colorHex: hexOf(coin.color), value: coin.value.toString(), mtIndex: coin.mtIndex.toString() };
  }
  return s;
}

/** A dormant account: the constructor state with boot commitment `boot`
 *  (veto window three days unless given; a local finalisation uses 0). */
export async function dormant(boot: Uint8Array, recoveryPk: unknown, vetoWindowSeconds = 3n * 24n * 3600n): Promise<LocalAccount> {
  const deploy: any = await createUnprovenDeployTxFromVerifierKeys(zk as any, coinPublicKey, {
    compiledContract: compiled(Original.Contract), signingKey: sampleSigningKey(), initialPrivateState: privateState,
    args: [boot, new Uint8Array(32).fill(9), recoveryPk, new Uint8Array(64), vetoWindowSeconds],
  } as any, encryptionPublicKey);
  const contractAddress = String(deploy.public.contractAddress);
  return { contractAddress, addressBytes: new Uint8Array(Buffer.from(contractAddress, 'hex')), state: deploy.public.initialContractState };
}

/** The decoded ledger of a local account. */
export const ledgerOf = (a: LocalAccount): any => Original.ledger(a.state.data);

/** Executes `circuitId` locally with module `C` against `a`'s state (the
 *  generated JavaScript is the simulator: a failed assert throws here). */
export async function execute(C: any, a: LocalAccount, circuitId: string, args: unknown[]) {
  const build = /_to_contract_with_/.test(circuitId)
    ? (await relaxedContractsModule()).createUnprovenCallTxFromInitialStates
    : createUnprovenCallTxFromInitialStates;
  const call: any = await build(zk as any, {
    compiledContract: compiled(C), circuitId, contractAddress: a.contractAddress,
    coinPublicKey: a.withKeys ? localKeys.coinPublicKey : coinPublicKey,
    initialContractState: a.state, initialZswapChainState: a.zswap ?? new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(), args, initialPrivateState: a.privateState ?? privateState,
  } as any, a.withKeys ? localKeys.encryptionPublicKey : encryptionPublicKey);
  const next = ContractState.deserialize(a.state.serialize());
  next.data = new ChargedState(call.public.nextContractState);
  return { call, after: { ...a, state: next } as LocalAccount };
}

/** Transport retries of `prove` (see below), for the evidence. */
export const transportRetries: { circuitId: string; attempt: number; error: string; at: string }[] = [];

/** Executes locally, then proves the call at the proof server.
 *
 *  A TRANSPORT failure (the request never reached the proof server or got no
 *  HTTP answer: "fetch failed", EPIPE, ECONNRESET) is retried, at most four
 *  times, 20 s apart, and recorded in `transportRetries`. Nothing else is
 *  retried: an HTTP answer (a refusal) is final, and a fifth transport
 *  failure is thrown and classified as infrastructure (ERROR), never a pass. */
export async function prove(C: any, a: LocalAccount, circuitId: string, args: unknown[]) {
  const { call, after } = await execute(C, a, circuitId, args);
  for (let attempt = 1; ; attempt++) {
    const before = proofLog.length;
    try {
      const proven = await proofProvider.proveTx({ version: 'v9', tx: call.private.unprovenTx } as any);
      return { proven, after };
    } catch (e: any) {
      const answered = proofLog.slice(before).some((q) => q.status !== null && !q.ok);
      const text = String(e?.message ?? e) + ' ' + String(e?.cause?.message ?? '') + ' ' + String(e?.cause?.code ?? '');
      const transport = !answered && /fetch failed|epipe|econnreset|socket hang up|other side closed/i.test(text);
      if (!transport || attempt >= 5) throw e;
      transportRetries.push({ circuitId, attempt, error: text.slice(0, 300), at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}
