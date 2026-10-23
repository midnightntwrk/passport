// Test-only helpers for the `evm_eip712` constraint-level negatives, on top of
// constraint-negative.ts:
//
//   - loadPatched: constraint-negative.ts's loadBypassedContract over the
//     compiled account module (named asserts record instead of throwing;
//     named runtime functions replaced through `overrides`, so that a
//     degenerate point can reach the transcript; a copy with overrides needs
//     a positive control proved through it); the patch is client-side only,
//     the proof server still sees the real constraints;
//   - a local account: a constructor state, then each call executed locally
//     from the previous call's state (the "simulator"), optionally proved by
//     the proof server; no node, no wallet;
//   - a local Zswap commitment tree holding chosen contract-owned coins at
//     known indexes, and a coin store whose `held_coin` answers are chosen
//     by the test (witness substitution): the Zswap half of a shielded
//     spend is then valid, so a refusal is the arm circuit's own;
//   - a malicious-prover mutant that forges the address the generated
//     JavaScript derives from the device's point, as a runtime
//     override of `keccak256`: the victim's entry matches while the attacker's
//     key signs, and only the proof's own derivation can refuse it.
//   - the calling contract `kernel.caller()` presents, injected into
//     the local call context (a root call has none; the ledger authenticates
//     the real caller at admission), and a ledger-cell copy that builds a
//     state no shared chip produces (a grant record of an older generation).

import { withExecutedHints, forgeHints, storeCoin, type HintContext } from './evm-eip712-hint-fill.js';
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

// Transport: the base helper's recording provider sends every proof-server
// request over its own connection (constraint-negative.ts freshConnection; a
// reused keep-alive connection can break the upload of a large prover key
// with EPIPE before the proof server sees it).
export const proofProvider = recordingProofProvider(CONFIG.proofServer, zk, proofLog);
const coinPublicKey = '00'.repeat(32);
const encryptionPublicKey = '00'.repeat(32);
const privateState = emptyCoinStore(new Uint8Array(32).fill(7));

// ── Patched modules ─────────────────────────────────────────────────────────


/** Lets the point at infinity, in either encoding, reach the transcript: the
 *  validator accepts (0, 0), and the coordinate accessors return 0 for the
 *  flagged identity instead of throwing. */
export const POINT_AT_INFINITY_OVERRIDES = `
  isValidSecp256k1Point(p) {
    if (p && p.x === 0n && p.y === 0n && typeof p.identity === 'boolean') return true;
    return __compactRuntimeOriginal.isValidSecp256k1Point(p);
  },
  secp256k1PointX(p) { return p && p.identity && p.x === 0n && p.y === 0n ? 0n : __compactRuntimeOriginal.secp256k1PointX(p); },
  secp256k1PointY(p) { return p && p.identity && p.x === 0n && p.y === 0n ? 0n : __compactRuntimeOriginal.secp256k1PointY(p); },`;

/** Lets a non-identity point whose coordinates are NOT reduced below the
 *  base-field modulus p (x + p, y + p) pass the validator AND reach the
 *  transcript as unreduced limbs: Secp256k1Base travels as (value - 1) in a
 *  low-192 / high-64 limb pair, and the honest encoder refuses value > p - 1;
 *  this one encodes value - 1 as given, the representation an honest encoder
 *  never produces. */
export const NON_CANONICAL_COORDINATE_OVERRIDES = `
  isValidSecp256k1Point(p) {
    const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
    if (p && !p.identity && typeof p.x === 'bigint' && typeof p.y === 'bigint' && (p.x >= P || p.y >= P) && p.x < (1n << 256n) && p.y < (1n << 256n)) {
      return __compactRuntimeOriginal.isValidSecp256k1Point({ x: p.x % P, y: p.y % P, identity: false });
    }
    return __compactRuntimeOriginal.isValidSecp256k1Point(p);
  },
  CompactTypeSecp256k1Point: {
    alignment: () => __compactRuntimeOriginal.CompactTypeSecp256k1Point.alignment(),
    fromValue: (v) => __compactRuntimeOriginal.CompactTypeSecp256k1Point.fromValue(v),
    toValue(v) {
      const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
      if (v.identity || (v.x < P && v.y < P)) return __compactRuntimeOriginal.CompactTypeSecp256k1Point.toValue(v);
      const limbs = (c) => { const r = c === 0n ? P - 1n : c - 1n; return __compactRuntimeOriginal.bigIntToValue(r & ((1n << 192n) - 1n)).concat(__compactRuntimeOriginal.bigIntToValue(r >> 192n)); };
      return limbs(v.x).concat(limbs(v.y)).concat(__compactRuntimeOriginal.bigIntToValue(0n));
    },
  },`;

/** The forged-address mutant, as a runtime override: the
 *  generated JavaScript derives an address as keccak256 over the point's
 *  big-endian coordinates `[x_be, y_be]`; for the point `forgery.set` names,
 *  this override returns 12 bytes and then the chosen address, so the copy
 *  derives that address from the attacker's point. Any other hash is the
 *  real one, so honest calls through the copy behave as through the
 *  original (its positive control proves one). */
export const FORGE_ADDRESS_OVERRIDES = `
  keccak256(descriptor, value) {
    const f = globalThis[Symbol.for('passport-negative.evm.forgeAddress')];
    // the stdlib hashes [Vector<32, Uint<8>>, Vector<32, Uint<8>>] (arrays of
    // bigints); accept Bytes<32> (Uint8Array) as well
    const bytes = (b) => (b instanceof Uint8Array || Array.isArray(b)) && b.length === 32 ? Uint8Array.from(b, (v) => Number(v)) : null;
    if (f && Array.isArray(value) && value.length === 2 && bytes(value[0]) && bytes(value[1])) {
      const r = f(bytes(value[0]), bytes(value[1]));
      if (r) return r;
    }
    return __compactRuntimeOriginal.keccak256(descriptor, value);
  },`;

const FORGE = Symbol.for('passport-negative.evm.forgeAddress');
const be32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

/** The target of FORGE_ADDRESS_OVERRIDES: the copy derives `address` from
 *  `pk`. Counts the forgeries (a mutant case is valid only if one fired). */
export const forgery = {
  set(target: { pk: { x: bigint; y: bigint }; address: Uint8Array } | undefined) {
    const x = target && be32(target.pk.x), y = target && be32(target.pk.y);
    (globalThis as any)[FORGE] = target && ((a: Uint8Array, b: Uint8Array) => {
      if (!a.every((v, i) => v === x![i]) || !b.every((v, i) => v === y![i])) return undefined;
      forgery.fired++;
      return new Uint8Array([...new Uint8Array(12).fill(0xee), ...target.address]);
    });
    forgery.fired = 0;
  },
  fired: 0,
};

/** The chosen-salt mutant, as a runtime override: the generated JavaScript
 *  derives a grant's scope salt as persistentHash over the four values
 *  [tag, blind, account, auth_nonce]; while `saltChoice.set` names a tag and
 *  a salt, this override returns that salt for a four-value preimage under
 *  that tag, so the copy writes the record's commitments under a salt the
 *  prover chose. Every other hash is the real one, so honest calls through
 *  the copy behave as through the original (its positive control proves
 *  one). */
export const CHOSEN_SALT_OVERRIDES = `
  persistentHash(descriptor, value) {
    const f = globalThis[Symbol.for('passport-negative.evm.chooseSalt')];
    if (f && Array.isArray(value) && value.length === 4 && value[0] instanceof Uint8Array) {
      const r = f(value[0]);
      if (r) return r;
    }
    return __compactRuntimeOriginal.persistentHash(descriptor, value);
  },`;

const CHOOSE = Symbol.for('passport-negative.evm.chooseSalt');

/** The target of CHOSEN_SALT_OVERRIDES: the salt the copy returns for the
 *  derivation under `tag` (undefined: none, the real derivation). Counts the
 *  substitutions (a mutant case is valid only if one fired). */
export const saltChoice = {
  set(target: { tag: Uint8Array; salt: Uint8Array } | undefined) {
    (globalThis as any)[CHOOSE] = target && ((t: Uint8Array) => {
      if (t.length !== target.tag.length || !t.every((v, i) => v === target.tag[i])) return undefined;
      saltChoice.fired++;
      return Uint8Array.from(target.salt);
    });
    saltChoice.fired = 0;
  },
  fired: 0,
};

/** Sets the CALLER the call context presents to `kernel.caller()`:
 *  before each ledger query of the copy, the current query context's block
 *  carries `callerInjection`'s caller (`{ tag: 'contract', address }`). A
 *  root call built by midnight-js has no caller, and a caller can only come
 *  from a call tree, which this local harness cannot build; the caller is a
 *  context value that the ledger authenticates at admission, so this
 *  injection exercises exactly what the circuit does with it (the caller pin
 *  of upstream's shared check_spend_scope) and nothing the prover could
 *  choose on chain. Honest calls through the copy behave as through the
 *  original when no caller is set (its positive control proves one with the
 *  pinned caller). */
export const CALLER_OVERRIDES = `
  queryLedgerState(context, partialProofData, program) {
    const c = globalThis[Symbol.for('passport-negative.evm.injectCaller')];
    const q = c && context && context.callContext && context.callContext.currentQueryContext;
    if (q) q.block = { ...q.block, caller: c };
    return __compactRuntimeOriginal.queryLedgerState(context, partialProofData, program);
  },`;

const CALLER = Symbol.for('passport-negative.evm.injectCaller');
export const callerInjection = {
  /** The contract the next calls through a CALLER_OVERRIDES copy present as
   *  their caller (undefined: none, as for a root call). */
  set(contract: Uint8Array | undefined) {
    (globalThis as any)[CALLER] = contract && { tag: 'contract', address: Buffer.from(contract).toString('hex') };
  },
  /** A user, not a contract, as the caller. */
  setUser(user: Uint8Array) {
    (globalThis as any)[CALLER] = { tag: 'user', address: Buffer.from(user).toString('hex') };
  },
};

/** A copy of account `a` whose ledger cell at the two-level `path` (top-level
 *  index, then index inside it) is the one `from` holds there. It builds a
 *  state no shared chip produces (a grant record of an
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

/** The pure circuits each executing module computes its hints with
 *  (evm-eip712-hint-fill.ts): the original's own, and for a patched copy a
 *  twin copy with the same bypasses and overrides, so that computing the
 *  hints never counts as one of the copy's bypassed asserts. */
const HINT_PURE = new WeakMap<object, { pure: any; forgesAddresses: boolean }>([[Original.Contract, { pure: Original.pureCircuits, forgesAddresses: false }]]);

/** A patched copy of the account module (constraint-negative.ts). */
export async function loadPatched(bypass: readonly string[], overrides = ''): Promise<BypassedContractModule> {
  const patched = await loadBypassedContract(ACCOUNT_JS, bypass, { overrides });
  const twin = await loadBypassedContract(ACCOUNT_JS, bypass, { overrides });
  HINT_PURE.set(patched.Contract, { pure: twin.pureCircuits, forgesAddresses: overrides.includes(FORGE_ADDRESS_OVERRIDES) });
  return patched;
}

/** The hint context of a local account; a forged-address copy computes its
 *  key hash through the forgery (not counted as one of its forgeries). */
function hintContext(a: LocalAccount, forgesAddresses: boolean): HintContext {
  return {
    account: a.addressBytes, ledger: ledgerOf(a), coin: (c) => storeCoin(a.privateState ?? privateState, c),
    keyHash: (pk) => {
      const f = (globalThis as any)[FORGE];
      if (!forgesAddresses || !f) return undefined;
      const n = forgery.fired;
      const r = f(be32(pk.x), be32(pk.y));
      forgery.fired = n;
      return r;
    },
  };
}

// ── A call builder for a direct transfer's first half ───────────────────────
//
// midnight-js 5.0.0-rc.2 refuses to assemble a call whose shielded output is
// addressed to a contract that does not claim it inside the SAME call tree
// (`assertReceivesMatchClaims`: "A shielded coin addressed to a contract must
// be claimed as received by that contract..."). A direct transfer
// (`withdraw_shielded_to_contract_*`, MIP-0012 §6.6) is claimed by the
// recipient's own `deposit_shielded` call in another intent of the same
// transaction, the composition upstream's custody-payments suite builds by
// grafting the recipient's intent onto the sender's call. So the sender's
// half can only be built with that client-side pre-check removed. This loads
// a copy of midnight-js-contracts whose only change is that call (its bare
// imports resolved to the same module instances); the node still checks the
// claim on the composed transaction, and proving does not depend on it.
//
// The copy also exports two of the module's internal functions, under
// `passportNegative*` names: `createUnprovenLedgerCallTx` (one intent from a list of
// executed calls, as a cross-contract call tree is assembled) and
// `createEncryptionPublicKeyResolver`. A direct transfer lands only when the
// recipient's claim is in the SAME intent as the sender's output: the ledger
// requires the contract-addressed outputs and the claimed receives to be
// equal by (segment, commitment, recipient), error 218 otherwise, and a claim
// grafted as another intent sits in another segment (and brings a second
// copy of the output). Built together, the two calls give one output (the
// builder keys outputs by commitment), claimed by the recipient's transcript.
const MJS_CHECK = '    assertReceivesMatchClaims(calls, segmentedOffers);\n';
let relaxed: any;
export async function relaxedContractsModule(): Promise<any> {
  if (relaxed) return relaxed;
  const url = import.meta.resolve('@midnight-ntwrk/midnight-js-contracts');
  const src = await readFile(new URL(url), 'utf8');
  if (src.split(MJS_CHECK).length !== 2) throw new Error('evm-eip712-negative: midnight-js claim pre-check not found where expected');
  let body = src.replace(MJS_CHECK, '    /* passport-negative: claim pre-check removed for a grafted direct transfer */\n');
  body = body.replace(/from '(@[^']+)'/g, (_m, spec) => `from ${JSON.stringify(import.meta.resolve(spec))}`)
             .replace(/from 'effect'/g, `from ${JSON.stringify(import.meta.resolve('effect'))}`)
             .replace(/^\/\/# sourceMappingURL=.*$/m, '');
  for (const name of ['createUnprovenLedgerCallTx', 'createEncryptionPublicKeyResolver']) {
    if (!new RegExp(`^const ${name} = `, 'm').test(body)) throw new Error(`evm-eip712-negative: midnight-js internal ${name} not found`);
  }
  body += '\nexport { createUnprovenLedgerCallTx as passportNegativeCreateUnprovenLedgerCallTx, createEncryptionPublicKeyResolver as passportNegativeCreateEncryptionPublicKeyResolver };\n';
  const dir = await mkdtemp(path.join(tmpdir(), 'evm-eip712-mjs-'));
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
export const localKeys = ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(0x5a));
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
 *  (veto window three days unless given; a test of finalisation passes 0). */
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

/** The call against account `a` with one hint changed (forgeHints), computed
 *  with the original module (what an honest client computes). */
export const forgedHintArgs = (a: LocalAccount, circuitId: string, args: unknown[], authIndex: number,
  where: 'auth' | 'op' | number, path: string[], mode: 'flip' | 'carry', at = 0): unknown[] =>
  forgeHints(Original.pureCircuits, hintContext(a, false), circuitId, args, authIndex, where, path, mode, at);

/** The carry attack's transport: a copy whose type check lets a hint byte above
 *  255 through, whose `Uint<8>` encoder writes it as given (two bytes), and
 *  whose call data widens that one input atom to match, so the byte reaches
 *  the proof server unchanged. Values below 256 encode as before (the honest
 *  call through the copy is its positive control). */
export const HINT_CARRY_OVERRIDES = `
  typeError(circuit, argument, location, type, value) {
    if (/Hint/.test(String(type))) return;
    return __compactRuntimeOriginal.typeError(circuit, argument, location, type, value);
  },
  CompactTypeUnsignedInteger: class extends __compactRuntimeOriginal.CompactTypeUnsignedInteger {
    toValue(v) { return this.maxValue === 255n && v >= 256n && v <= 511n ? __compactRuntimeOriginal.CompactTypeField.toValue(v) : super.toValue(v); }
  },
  finalizeCallProofData(context, proofData) {
    // an input atom narrower than its value (a two-byte carried hint byte) is
    // widened to the value, so the proof server receives the byte as given
    const al = proofData.input.alignment, v = proofData.input.value;
    proofData.input.alignment = al.map((a, i) => (a.tag === 'atom' && a.value.tag === 'bytes' && v[i] && v[i].length > a.value.length
      ? { tag: 'atom', value: { tag: 'bytes', length: v[i].length } } : a));
    return __compactRuntimeOriginal.finalizeCallProofData(context, proofData);
  },`;

/** Executes `circuitId` locally with module `C` against `a`'s state (the
 *  generated JavaScript is the simulator: a failed assert throws here). */
export async function execute(C: any, a: LocalAccount, circuitId: string, args0: unknown[]) {
  const m = HINT_PURE.get(C) ?? { pure: Original.pureCircuits, forgesAddresses: false };
  const args = withExecutedHints(m.pure, hintContext(a, m.forgesAddresses), circuitId, args0);
  // a direct transfer's first half (see relaxedContractsModule)
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
 *  HTTP answer: "fetch failed", EPIPE, ECONNRESET — seen when uploading
 *  prover keys of a few hundred MB: the upload breaks with EPIPE about half
 *  a second in and the proof server never logs the request) is retried, at
 *  most four times, 20 s apart, and recorded in `transportRetries`. Nothing
 *  else is retried: an HTTP answer (a refusal) is final, and a fifth
 *  transport failure is thrown and classified as infrastructure (ERROR),
 *  never a pass. */
export async function prove(C: any, a: LocalAccount, circuitId: string, args: unknown[]) {
  const { call, after } = await execute(C, a, circuitId, args);
  for (let attempt = 1; ; attempt++) {
    const before = proofLog.length;
    try {
      const proven = await proofProvider.proveTx({ version: 'v9', tx: call.private.unprovenTx } as any);
      return { proven, after };
    } catch (e: any) {
      // A transaction's proofs are made concurrently: a Zswap proof of the same
      // transaction (midnight/zswap/*) can finish after the circuit's own
      // refusal, and the classifier reads the LAST request. Keep every entry of
      // this attempt's window, but put the circuit's refusal last (marked), so
      // the refusal is attributed to the circuit under test.
      const win = proofLog.splice(before);
      const iRef = win.map((q, i) => [q, i] as const)
        .filter(([q]) => q.status !== null && !q.ok && String(q.keyLocation ?? '').startsWith('contract:')).map(([, i]) => i).at(-1);
      if (iRef !== undefined && iRef !== win.length - 1) { const [ref] = win.splice(iRef, 1); win.push({ ...ref, reorderedAfterConcurrentProofs: true } as ProofServerRequest); }
      proofLog.push(...win);
      const answered = proofLog.slice(before).some((q) => q.status !== null && !q.ok);
      const text = String(e?.message ?? e) + ' ' + String(e?.cause?.message ?? '') + ' ' + String(e?.cause?.code ?? '');
      const transport = !answered && /fetch failed|epipe|econnreset|socket hang up|other side closed/i.test(text);
      if (!transport || attempt >= 5) throw e;
      transportRetries.push({ circuitId, attempt, error: text.slice(0, 300), at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}
