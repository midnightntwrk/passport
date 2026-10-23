// Constraint-level negatives of the `evm_eip712` arm, on local account states
// (no deploy, no node, no wallet), proved at the proof server.
//
// For every case:
//   positive   an honest call through the PATCHED module (the negatives' own
//              path) is proved by the proof server: the path works, so a
//              refusal is the tampering's;
//   simulator  the bad call, executed with the ORIGINAL module, is refused by
//              the generated JavaScript (or the runtime's own type checks);
//   prover     the bad call, executed with the named asserts bypassed (and,
//              where a degenerate value must reach the transcript, the
//              runtime's validators relaxed), is refused by the proof server:
//              the rule is a constraint of the proof.
//
// Sections (all by default; or name them on the command line):
//   activation       wrong blind, wrong address, the point at infinity in both
//                    encodings;
//   reactivation     activating an account that is already booted;
//   qa1              a coordinate not reduced below the base-field modulus;
//   seam             rotate_enc_key: the binding matrix, the authorisation
//                    fields, zero and degenerate signatures, the replay matrix
//                    (account, arm, operation, role, nonce) and the high-S
//                    twin;
//   frame            a malicious-prover mutant that forges the address the
//                    generated JavaScript derives from the attacker's point;
//   custody          append_inbox and withdraw_unshielded: binding, a
//                    cross-operation replay, the mirror's over-withdrawal;
//   witness          the shielded withdrawals on a local Zswap tree: a valid
//                    signature over one coin with the held_coin witness
//                    answering another (colour, value, nonce, Merkle index);
//   devices          add_device and remove_device by readable descriptor:
//                    every target scheme, binding of each field and of the
//                    scheme, unregistered or other-recipe tags, a passkey
//                    origin with a space, a k256 envelope of 2 and a Solana
//                    target at the identity point under a valid signature,
//                    both removal forms, S13, the last
//                    device, an entry planted at device_epoch + 1 evicted at
//                    that epoch, (r, s) = (0, 0);
//   grants           issue_grant, revoke_grant, revoke_all_grants and the
//                    grantee twins: binding, the arm's issue rules and the
//                    grantee descriptor and label rules under a valid
//                    signature, the stale grant nonce, the forged grantee
//                    address, witness substitution;
//   grant-matrix     the three grantee twins: scope violations under a valid
//                    signature (caps, max coin value, recipient pin, caller
//                    pin with the caller injected into the call context, the
//                    object and spent openings), the record's liveness, the
//                    frame's site label, the zero scalars, every signed field
//                    of the shielded twins substituted, a stale encryption key;
//   frame-lifecycle  the forged-address mutant on the lifecycle, grant and
//                    shielded grantee exports, and a grant scope salt the
//                    prover chose at issue_grant;
//   qa-s3            the Field-to-Bytes<32> rendering of the recovery lines is
//                    canonical (value + r refused);
//   recovery         publish_recovery_session and recover_cancel: binding of
//                    every signed member, the shared chips' asserts under a
//                    valid signature, the seam's asserts, and the old devices
//                    and a planted entry after a finalised recovery (#183).
//
// Every prover-level negative records the refusing request's circuit (it must
// be the circuit under test) and the refusal's kind: `constraint` (the
// circuit's relation fails) or `decoding` (the honest proof server could not
// decode the preimage, which a malicious prover never runs).
//
// A copy bypasses only the asserts a case names; every other assert still
// throws, so a case that names one assert isolates it. Some inputs break two
// asserts that no input separates, and those cases name both:
//   r = 0 or s = 0 with a valid signature otherwise: the zero-scalar assert
//     and the signature check. In the circuit, s = 0 has no inverse (the ZKIR
//     `inv` of the ECDSA relation is unsatisfiable for 0) and r = 0 needs the
//     x-coordinate of u1·G to be 0 mod n, which no one can find; the
//     zero-scalar assert is the attributable refusal, with the relation behind
//     it. The (r, s) = (0, 0) cases isolate the assert in the copy (with
//     inverses of 0 taken as 0, the signature check passes); at the proof
//     server the relation's inverse refuses s = 0 as well;
//   an unregistered grant-id tag: the arm's tag assert and the base's 64-byte
//     grant-id assert (an unregistered tag selects that class, and the class
//     accepts only registered tags).
//
// Needs a proof server at upstream's endpoint (CONFIG.proofServer); a missing
// proof server is an ERROR, never a pass. Writes
// $EVIDENCE_DIR/evm-eip712-prover[-<sections>].json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { CONFIG } from '../node/wallet.js';
import { JubjubDevice, K256Device, k256Challenges, jubjubChallenges, authArgs } from '../wallet/signer.js';
import { recoveryKey, signRecoverSubmit, recoverSubmitArgs, recoverSubmitChallenge, JUBJUB_IDENTITY, JUBJUB_ORDER_TWO } from '../wallet/recovery-gate.js';
import { SoftwareEvmWallet, EvmEip712Device, EvmEip712Grantee, highSTwin, parseEvmSignature, serialiseEvmSignature, evmEip712DescriptorInput, evmDeviceDescriptor, EVM_EIP712_UNUSED_DESCRIPTOR, evmEip712GranteeInput, evmEip712IssueArgs, evmEip712GrantScopeSalt, solArgs, EVM_EIP712_SOL_FILLER_ARGS } from '../wallet/signer-evm-eip712.js';
import { grantLabel, grantOriginHash } from '../wallet/descriptors.js';
import { K256Grantee, originHash as upstreamOriginHash, grantAuthArgs, RECIPIENT_USER_ADDRESS, scopeArgs, scopeDigest, type GrantOpening, type PlainScope } from '../wallet/signer.js';
import type { IssueScope } from '../wallet/evm-eip712-codec.js';
import { DESCRIPTOR_TAGS, padTag, type Descriptor } from '../wallet/descriptors.js';
import { softwarePasskey } from './p256-fixtures.js';
import { TEST_SITE, KEEP_HINTS } from './evm-eip712-hint-fill.js';
import { evmEip712SeamHint, evmEip712GrantSeamHint, evmEip712IssueHint, evmEip712DescriptorHint, evmEip712RemoveHint, evmEip712AmountHint, evmEip712CoinHint,
  evmEip712KeyHint, evmEip712GranteeHint, leHint } from '../wallet/evm-eip712-hints.js';
import { base58Inputs, base58Text32, utcDateTimeInputs } from '../wallet/rendering.js';
import { EVM_EIP712_AMOUNT_LABEL_PREFIX, solanaKeyText } from '../wallet/evm-eip712-codec.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { evmEip712Messages, typedDataDigest, EVM_EIP712_PASSKEY_RP_POINTER, EVM_EIP712_WINDOW_POINTER, amountLabelText, type Eip712TypedData } from '../wallet/evm-eip712-codec.js';
import { NEVER_TEXT, NOT_APPLICABLE_TEXT } from '../wallet/rendering.js';
import { expectRefusal, expectSuccess, type NegativeResult, type PositiveResult } from './constraint-negative.js';
import {
  Original, loadPatched, dormant, execute, prove, ledgerOf, proofLog, forgery, withLocalCoins, coinStoreAnswering,
  localCoinPublicKeyBytes, transportRetries, FORGE_ADDRESS_OVERRIDES, POINT_AT_INFINITY_OVERRIDES, NON_CANONICAL_COORDINATE_OVERRIDES, type LocalAccount, type LocalCoin,
  CALLER_OVERRIDES, callerInjection, withLedgerCell, forgedHintArgs, HINT_CARRY_OVERRIDES, CHOSEN_SALT_OVERRIDES, saltChoice,
} from './evm-eip712-negative.js';
import type { BypassedContractModule } from './constraint-negative.js';

const SECTIONS = process.argv.slice(2).length ? process.argv.slice(2) : ['activation', 'reactivation', 'qa1', 'seam', 'frame', 'custody', 'witness', 'devices', 'grants', 'grant-matrix', 'frame-lifecycle', 'qa-s3', 'recovery', 'hints', 'texts', 'isolate', 'places'];
// EVM_EIP712_DRY=1: the JavaScript layer only, with no proof server and never
// a verdict of record: a positive executes, not
// proved, through its module with no bypassed assert firing; a negative's
// simulator half runs as always, then its patched copy executes the honest
// control with no bypassed assert firing and the attempt to the end (what the
// proof server would then see), the expected assert firing when it is one of
// the bypassed. A case the client refuses while it is being built throws and
// fails the run, so every section must run through.
const DRY = process.env.EVM_EIP712_DRY === '1';
// Every section draws its own deterministic stream, seeded by the suite and
// the section's name, so a section draws the same values whether it runs
// alone or with the others; draws outside any section use the stream "common".
const SEED = 'evm-eip712-prover/v1';
let stream = 'common';
let ctr = 0;
// Positive controls. Every negative's patched copy (its circuit, bypass set,
// runtime overrides and mutant) proves an honest call through itself, so a
// copy that broke the generated JavaScript cannot pass a negative by an
// unrelated refusal. A case names its control (`opts.control`), or takes the
// honest call of its circuit from the first positive of its section. In the
// sections of the checked hints and the readable texts every negative proves
// its own; elsewhere the negatives of one copy share the first control proved
// through that copy, and a copy whose section proves its circuit's honest call
// only later gets its own control row at the end of the section. Each result
// records which control covers it.
let currentSection = 'common';
const OWN_CONTROL_SECTIONS = new Set(['hints', 'isolate', 'texts', 'places']);
// section -> circuit -> the first honest call of that circuit in the section
const sectionControls = new Map<string, Map<string, { a: LocalAccount; args: unknown[] }>>();
// section and copy key -> the case whose control proved through that copy
const copyControls = new Map<string, string>();
const pendingControls: { key: string; circuit: string; bypass: string[]; overrides: string; section: string; results: any[] }[] = [];
const honestOf = (sec: string, circuit: string) => sectionControls.get(sec)?.get(circuit);
const section = (name: string) => { stream = name; ctr = 0; currentSection = name; };
/** The honest call of `circuit` in the current section (a section with no
 *  positive of that circuit names it here). */
const honestCall = (circuit: string, a: LocalAccount, args: unknown[]) => {
  const m = sectionControls.get(currentSection) ?? new Map();
  m.set(circuit, { a, args }); sectionControls.set(currentSection, m);
};
const rnd = (n: number) => {
  const out = new Uint8Array(n);
  const tag = String(ctr++);
  // one SHA-256 block per 32 bytes
  for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(`${SEED}/${stream}`).update(tag).update(i ? `/${i}` : '').digest().subarray(0, Math.min(32, n - i)), i);
  return out;
};
const pc = Original.pureCircuits;
const recoveryPk = JubjubDevice.generate().pk;

const ACTIVATE = 'activate_initial_device_with_evm_eip712';
const ROTATE = 'rotate_enc_key_with_evm_eip712';
const INFINITY = 'evm_eip712: device key is the point at infinity';
const BOOT = 'boot commitment mismatch';
const UNKNOWN = 'unknown device entry';
const INVALID = 'invalid signature';
const ZERO = 'evm_eip712: signature scalar is zero';
const K256_INVALID = 'invalid signature';
// The copy takes the inverse of 0 as 0 and the x-coordinate of the identity as
// 0, so (r, s) = (0, 0) verifies in its JavaScript against any key.
const ZERO_INV_OVERRIDES = `secp256k1ScalarInv(x) { return x === 0n ? 0n : __compactRuntimeOriginal.secp256k1ScalarInv(x); },
  secp256k1PointX(p) { return p && p.identity ? 0n : __compactRuntimeOriginal.secp256k1PointX(p); },`;

type RefusalKind = 'constraint' | 'decoding';
interface Result { section: string; circuit: string; case: string; kind: 'positive' | 'negative'; expect?: string; bypassed?: string[];
  overrides?: string; positive?: PositiveResult; simulator?: NegativeResult; prover?: NegativeResult;
  refusal?: { circuit?: string; kind: RefusalKind | 'none'; rule?: string; expectedKind: RefusalKind }; mutant?: string;
  /** How the refused predicate is enforced against a MALICIOUS
   *  prover: `constraint` (the relation over the call's own inputs), or
   *  `constraint on a declared read` (the predicate tests a value the circuit
   *  reads from the ledger or the call context; the read enters the proof as
   *  a declared public transcript value, so against a malicious prover it is
   *  the node's transcript replay against the real state that refuses, the
   *  constraint holding for the declared value) */
  enforcement?: 'constraint' | 'constraint on a declared read (+ node transcript replay)';
  /** The ledger value a case's refusing check compares, named by the case
   *  (the check's message does not tell: a word hint is checked against an
   *  argument or against a ledger read alike) */
  declaredRead?: string }
// Asserts whose predicate tests a ledger or call-context read
const READ_ASSERTS = new Set(['unknown device entry', 'unknown grant', 'grant revoked', 'grant epoch stale', 'grant generation stale', 'grant expired',
  'stale encryption key', 'amount above per-call cap', 'cumulative cap exceeded', 'recipient not admitted by pin', 'coin above max_coin_value',
  'grant requires a contract caller', 'grant caller mismatch', 'scope object mismatch', 'spent opening mismatch', 'operation not in scope',
  'insufficient balance', 'already activated', 'boot commitment mismatch', 'cannot remove last device', 'recovery pending; cancel first',
  'no recovery pending', 'session nonce reused', 'recovery commitment reused', 'grant already active']);
const enforcementOf = (expect: string, name: string): Result['enforcement'] =>
  READ_ASSERTS.has(expect) || ((expect === 'invalid signature' || expect === 'invalid grant signature') && /authNonce|nonce advanced|replay\/nonce|record nonce|after its|stale|grant nonce/i.test(name))
    ? 'constraint on a declared read (+ node transcript replay)' : 'constraint';
const results: Result[] = [];
let failures = 0, errors = 0;
const tally = (...r: (PositiveResult | NegativeResult | undefined)[]) => {
  for (const x of r) { if (!x) continue; if (x.verdict === 'FAIL') failures++; if (x.verdict === 'ERROR') errors++; }
};
const line = (r: Result) => {
  const dry = (r as any).dryCopy as { verdict: string; reason: string; detail?: string } | undefined;
  const parts = [r.positive && `positive ${r.positive.verdict}`, r.simulator && `simulator ${r.simulator.verdict}`, r.prover && `prover ${r.prover.verdict} (${r.prover.layer}${r.prover.proofServer.at(-1)?.status ? `, ${r.prover.proofServer.at(-1)!.endpoint} ${r.prover.proofServer.at(-1)!.status}` : ''}${r.refusal ? `, ${r.refusal.kind}` : ''})`,
    dry && `copy ${dry.verdict} (DRY)`].filter(Boolean);
  const okAll = [r.positive, r.simulator, r.prover, dry].every((x) => !x || x.verdict === 'PASS');
  if (dry && dry.verdict !== 'PASS') console.log(`      dry copy: ${dry.reason} ${dry.detail ?? ''}`.slice(0, 600));
  console.log(`  ${okAll ? '✓' : '✗'} [${r.section}] ${r.case}: ${parts.join(', ')}`);
  for (const [k, x] of [['positive', r.positive], ['simulator', r.simulator], ['prover', r.prover]] as const) {
    if (x && x.verdict !== 'PASS') console.log(`      ${k}: ${x.reason} ${(x as any).detail ?? ''}`.slice(0, 600));
  }
};

/** One positive control: the honest call proved through `mod` (a patched
 *  copy, which records it as its positive control) or the original module. */
async function positive(section: string, name: string, mod: BypassedContractModule | undefined, a: LocalAccount, circuit: string, args: unknown[]) {
  await settleControls();
  const m = sectionControls.get(section) ?? new Map();
  if (!m.has(circuit)) m.set(circuit, { a, args });
  sectionControls.set(section, m);
  const r: Result = { section, circuit, case: name, kind: 'positive' };
  if (DRY) {
    const startedAt = new Date().toISOString(), t0 = Date.now();
    try {
      mod?.resetFired();
      await execute(mod ? mod.Contract : Original.Contract, a, circuit, args);
      const f = mod?.fired() ?? [];
      r.positive = { name, verdict: f.length ? 'FAIL' : 'PASS', reason: f.length ? `DRY: a bypassed assert fired on the honest call: ${f.map((x) => x.message).join('; ')}` : 'DRY: executed (not proved)',
        proofServer: [], startedAt, ms: Date.now() - t0 };
    } catch (e: any) {
      r.positive = { name, verdict: 'FAIL', reason: 'DRY: execution failed', detail: String(e?.message ?? e).slice(0, 600), proofServer: [], startedAt, ms: Date.now() - t0 };
    }
    tally(r.positive); results.push(r); line(r);
    return r.positive.verdict === 'PASS';
  }
  r.positive = await expectSuccess({ name: `${circuit}: ${name}`, proofLog, through: mod,
    attempt: () => prove(mod ? mod.Contract : Original.Contract, a, circuit, args) });
  r.positive = { ...r.positive, result: undefined };
  tally(r.positive); results.push(r); line(r);
  return r.positive.verdict === 'PASS';
}

/** A negative that only the generated JavaScript can refuse, with the reason
 *  the prover level is unreachable from a JavaScript-built call (recorded,
 *  never counted as a constraint-level refusal). */
async function runtimeOnly(section: string, name: string, a: LocalAccount, circuit: string, args: unknown[], expect: string, why: string) {
  const r: Result = { section, circuit, case: name, kind: 'negative', expect };
  r.simulator = await expectRefusal({ name: `${circuit}: ${name} (generated JavaScript)`, expectedLayer: 'runtime', proofLog,
    attempt: () => execute(Original.Contract, a, circuit, args) });
  if (r.simulator.verdict === 'PASS' && !String(r.simulator.detail ?? '').includes(expect)) {
    r.simulator.verdict = 'FAIL'; r.simulator.reason = `refused at runtime, but not by "${expect}"`;
  }
  (r as any).proverLevel = `not reachable from a JavaScript-built call: ${why}`;
  tally(r.simulator); results.push(r); line(r);
}

/** A negative that no JavaScript-built call carries, the counterpart of
 *  runtimeOnly: the generated JavaScript derives the value itself, so only a
 *  modified prover (`mod`, a copy whose runtime override `arm(true)` switches
 *  on) puts another value in the transcript, and there is no simulator half.
 *  The honest call (the override off) proves through the same copy first;
 *  then the attempt must be refused by the proof server, by `circuit`.
 *  `check` compares the copy's state after the honest call and after the
 *  attempt, and names what is wrong (the override must reach the
 *  transcript). */
async function proverOnly(section: string, name: string, a: LocalAccount, circuit: string, args: unknown[], mod: BypassedContractModule,
  mutant: string, arm: (on: boolean) => void, check: (honest: LocalAccount, forged: LocalAccount) => string | undefined) {
  await settleControls();
  const r: Result = { section, circuit, case: name, kind: 'negative', expect: 'the proof of the transcript the copy built', bypassed: [],
    overrides: 'runtime override', mutant, enforcement: 'constraint' };
  (r as any).simulatorHalf = 'not applicable: the generated JavaScript derives the value itself, so no call it builds carries another';
  (r as any).controlRef = { kind: 'own' };
  // `check` runs while the override is still on: switching it off resets
  // the override's own counters, which the check reads
  const states = async () => {
    arm(false); const honest = (await execute(mod.Contract, a, circuit, args)).after;
    arm(true); const forged = (await execute(mod.Contract, a, circuit, args)).after;
    const bad = check(honest, forged);
    arm(false);
    return bad;
  };
  if (DRY) {
    const dry: { verdict: string; reason: string; detail?: string } = { verdict: 'PASS', reason: 'DRY: the copy executes the attempt to the end with the override in its state (it would reach the proof server)' };
    try { const bad = await states(); if (bad) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: ${bad}` }); }
    catch (e: any) { Object.assign(dry, { verdict: 'FAIL', reason: 'DRY: the copy refused the call in JavaScript (it would never reach the proof server)', detail: String(e?.message ?? e).slice(0, 600) }); }
    finally { arm(false); }
    (r as any).dryCopy = dry;
    tally(dry as any); results.push(r); line(r);
    return;
  }
  let bad: string | undefined;
  try { bad = await states(); } catch (e: any) { bad = `the copy refused the call in JavaScript: ${String(e?.message ?? e).slice(0, 300)}`; }
  try {
    r.prover = await expectRefusal({ name: `${circuit}: ${name} (${mutant})`, expectedLayer: 'prover', bypassed: mod, proofLog,
      positiveControl: () => { arm(false); return prove(mod.Contract, a, circuit, args); },
      attempt: () => { arm(true); return prove(mod.Contract, a, circuit, args); } });
  } finally { arm(false); }
  const rej = r.prover.rejection;
  r.refusal = { circuit: rej?.keyLocation, kind: rej ? rej.kind : 'none', rule: rej?.rule, expectedKind: 'constraint' };
  if (r.prover.verdict === 'PASS') {
    const refusedCircuit = rej?.keyLocation.match(/\/([A-Za-z0-9_]+)(\?|$)/)?.[1] ?? rej?.keyLocation;
    if (refusedCircuit !== circuit) { r.prover.verdict = 'FAIL'; r.prover.reason = `refused by ${rej?.keyLocation ?? 'no recorded request'}, not by ${circuit}`; }
    else if (bad) { r.prover.verdict = 'FAIL'; r.prover.reason = bad; }
  }
  tally(r.prover); results.push(r); line(r);
}

/** One negative: refused by the simulator, and by the proof server with
 *  `bypass` (or through `opts.module`, a mutant). At the proof server, the
 *  refusing request must be a recognised rejection (constraint-negative.ts)
 *  by `circuit`, of the expected kind: `constraint` (layer prover) or
 *  `decoding` (layer decoding, an honest-toolchain refusal). A copy with
 *  runtime overrides first proves `opts.control` (the honest call) through
 *  itself. */
async function negative(section: string, name: string, a: LocalAccount, circuit: string, args: unknown[],
  expect: string, bypass: string[], overrides = '',
  opts: { module?: BypassedContractModule; mutant?: string; kind?: RefusalKind; check?: () => string | undefined;
          control?: { a: LocalAccount; args: unknown[] };
          /** the ledger value the refusing check compares, when it is one:
           *  the case is then enforced by the node's replay of that read */
          declaredRead?: string;
          /** the module the simulator runs (default: the original),
           *  for a case whose call context is injected (CALLER_OVERRIDES) */
          simulatorModule?: BypassedContractModule;
          /** run before the simulator, the positive control and the
           *  attempt respectively (e.g. the caller each one presents) */
          hooks?: { simulator?: () => void; control?: () => void; attempt?: () => void } } = {}) {
  await settleControls();
  const r: Result = { section, circuit, case: name, kind: 'negative', expect, bypassed: bypass, overrides: overrides ? 'runtime validators relaxed' : undefined, mutant: opts.mutant };
  const key = `${section}|${circuit}|${[...bypass].sort().join('|')}|${overrides}|${opts.mutant ?? ''}`;
  let pending = false;
  if (!opts.control) {
    const shared = OWN_CONTROL_SECTIONS.has(section) ? undefined : copyControls.get(key);
    const own = honestOf(section, circuit);
    if (shared) (r as any).controlRef = { kind: 'shared', with: shared };
    else if (own && !opts.module) opts = { ...opts, control: own };
    else if (!opts.module) pending = true;
  }
  if (opts.control) (r as any).controlRef = { kind: 'own' };
  if ((opts.kind ?? 'constraint') === 'constraint') {
    r.enforcement = opts.mutant?.startsWith('forged-address') ? 'constraint'
      : opts.declaredRead ? 'constraint on a declared read (+ node transcript replay)' : enforcementOf(expect, name);
    if (opts.declaredRead) r.declaredRead = opts.declaredRead;
  }
  r.simulator = await expectRefusal({ name: `${circuit}: ${name} (generated JavaScript)`, expectedLayer: 'runtime', proofLog,
    attempt: () => { opts.hooks?.simulator?.(); return execute((opts.simulatorModule ?? Original).Contract, a, circuit, args); } });
  if (r.simulator.verdict === 'PASS' && !String(r.simulator.detail ?? '').includes(expect)) {
    r.simulator.verdict = 'FAIL'; r.simulator.reason = `refused at runtime, but not by "${expect}"`;
  }
  let patched: BypassedContractModule;
  try {
    patched = opts.module ?? await loadPatched(bypass, overrides);
  } catch (e: any) {
    // A copy that cannot be built (an assert it names is absent from the
    // generated contract) is this case's error; the suite goes on with the
    // next case, so one such case hides no other result.
    const err: any = { name: `${circuit}: ${name} (patched copy)`, expectedLayer: 'prover', layer: 'none', verdict: 'ERROR',
      reason: 'not a verdict: the patched copy could not be built', detail: String(e?.message ?? e).slice(0, 600), proofServer: [] };
    if (DRY) (r as any).dryCopy = err; else r.prover = err;
    tally(r.simulator, err); results.push(r); line(r);
    return;
  }
  const expectedKind = opts.kind ?? 'constraint';
  const control = opts.control;
  if (DRY) {
    const dry: { verdict: string; reason: string; detail?: string; fired?: string[] } = { verdict: 'PASS', reason: 'DRY: the copy executes the attempt to the end (it would reach the proof server)' };
    try {
      if (control) {
        patched.resetFired(); opts.hooks?.control?.();
        await execute(patched.Contract, control.a, circuit, control.args);
        const f = patched.fired();
        if (f.length) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: the control fired ${f.map((x) => x.message).join('; ')}` });
      }
      if (dry.verdict === 'PASS') {
        patched.resetFired(); opts.hooks?.attempt?.();
        await execute(patched.Contract, a, circuit, args);
        const f = patched.fired().map((x) => x.message);
        dry.fired = f;
        if (bypass.includes(expect) && !f.includes(expect)) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: the expected assert "${expect}" was bypassed but never fired (fired: ${f.join('; ') || 'none'})` });
        else { const bad = opts.check?.(); if (bad) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: ${bad}` }); }
      }
    } catch (e: any) {
      const chain: string[] = []; for (let x = e, i = 0; x && i < 6; x = x.cause, i++) chain.push(String(x?.message ?? x));
      Object.assign(dry, { verdict: 'FAIL', reason: 'DRY: the copy refused the call in JavaScript (it would never reach the proof server)', detail: chain.join(' | ').slice(0, 600) });
    }
    (r as any).dryCopy = dry;
    tally(r.simulator, dry as any); results.push(r); line(r);
    controlled(r, key, pending, control !== undefined && dry.verdict === 'PASS', circuit, bypass, overrides);
    return;
  }
  r.prover = await expectRefusal({ name: `${circuit}: ${name} (${opts.mutant ?? 'JavaScript checks bypassed'})`,
    expectedLayer: expectedKind === 'decoding' ? 'decoding' : 'prover', bypassed: patched, proofLog,
    positiveControl: control ? () => { opts.hooks?.control?.(); return prove(patched.Contract, control.a, circuit, control.args); } : undefined,
    attempt: () => { opts.hooks?.attempt?.(); return prove(patched.Contract, a, circuit, args); } });
  const rej = r.prover.rejection;
  r.refusal = r.refusal ?? { circuit: rej?.keyLocation, kind: rej ? rej.kind : 'none', rule: rej?.rule, expectedKind };
  if (r.prover.verdict === 'PASS') {
    // key locations read `contract:<address>/<circuit>?vk=<hash>`
    const refusedCircuit = rej?.keyLocation.match(/\/([A-Za-z0-9_]+)(\?|$)/)?.[1] ?? rej?.keyLocation;
    if (refusedCircuit !== circuit) { r.prover.verdict = 'FAIL'; r.prover.reason = `refused by ${rej?.keyLocation ?? 'no recorded request'}, not by ${circuit}`; }
    else { const bad = opts.check?.(); if (bad) { r.prover.verdict = 'FAIL'; r.prover.reason = bad; } }
  }
  tally(r.simulator, r.prover); results.push(r); line(r);
  controlled(r, key, pending, control !== undefined && r.prover.verdict === 'PASS', circuit, bypass, overrides);
}

/** After a negative: a control proved through its copy covers the copy's
 *  later negatives (outside the own-control sections); a negative with no
 *  control yet waits for its section's honest call. */
function controlled(r: Result, key: string, pending: boolean, proved: boolean, circuit: string, bypass: string[], overrides: string) {
  if (proved && !copyControls.has(key)) copyControls.set(key, `${r.section}: ${r.case}`);
  if (!pending) return;
  const p = pendingControls.find((x) => x.key === key && !OWN_CONTROL_SECTIONS.has(x.section));
  if (p) p.results.push(r);
  else pendingControls.push({ key, circuit, bypass: [...bypass], overrides, section: r.section, results: [r] });
}

/** The controls of a finished section's waiting negatives: the copy's control
 *  if one was proved since, else one control row through a fresh copy of the
 *  same bypass set with the section's honest call of the circuit; a negative
 *  left with none fails. */
let settling = false;
async function settleControls(final = false) {
  if (settling) return;
  settling = true;
  try {
    for (const p of pendingControls.filter((x) => final || x.section !== currentSection)) {
      pendingControls.splice(pendingControls.indexOf(p), 1);
      const shared = OWN_CONTROL_SECTIONS.has(p.section) ? undefined : copyControls.get(p.key);
      if (shared) { for (const r of p.results) r.controlRef = { kind: 'shared', with: shared }; continue; }
      const honest = honestOf(p.section, p.circuit);
      if (!honest) {
        for (const r of p.results) { r.controlRef = { kind: 'missing' }; failures++; console.log(`  ✗ [${r.section}] ${r.case}: no positive control through its copy`); }
        continue;
      }
      const name = `the positive control of the copy bypassing [${[...p.bypass].sort().join('; ') || 'nothing'}]${p.overrides ? ' with runtime overrides' : ''}`;
      const copy = await loadPatched(p.bypass, p.overrides);
      const ok = await positive(p.section, name, copy, honest.a, p.circuit, honest.args);
      for (const r of p.results) r.controlRef = { kind: ok ? 'shared' : 'failed', with: `${p.section}: ${name}` };
      if (ok) copyControls.set(p.key, `${p.section}: ${name}`);
    }
  } finally { settling = false; }
}

// ═════════════════════════════════════════════════════════════════════════════
// The device and its accounts
// ═════════════════════════════════════════════════════════════════════════════

const SK = 0xa11ce5n;
const wallet = new SoftwareEvmWallet(SK);
const device = await EvmEip712Device.enrol(wallet, 'undeployed', 0);
const device1 = await EvmEip712Device.enrol(wallet, 'undeployed', 1);
const other = new SoftwareEvmWallet(0xb0bn);
const salt = rnd(32);

// ── activation ─────────────────────────────────────────────────────────
if (SECTIONS.includes('activation')) {
  section('activation');
  const honestBoot = device.bootCommitment(salt);
  const infinityAddress = keccak_256(new Uint8Array(64)).subarray(12);
  const infinityBoot = pc.derive_boot_commitment_with_evm_eip712(salt, infinityAddress, device.blind);
  const all = await loadPatched([BOOT, INFINITY], POINT_AT_INFINITY_OVERRIDES);
  await positive('activation', 'honest activation (patched path)', all, await dormant(honestBoot, recoveryPk), ACTIVATE, device.activationArgs(salt));
  const activationControl = { a: await dormant(honestBoot, recoveryPk), args: device.activationArgs(salt) };
  await negative('activation', 'wrong blind', await dormant(honestBoot, recoveryPk), ACTIVATE, [device.pk, salt, rnd(32)], BOOT, [BOOT]);
  await negative('activation', 'wrong address (another key, the committed blind)', await dormant(honestBoot, recoveryPk), ACTIVATE, [other.pk, salt, device.blind], BOOT, [BOOT]);
  await negative('activation', 'point at infinity, flagged {0, 0, identity}', await dormant(infinityBoot, recoveryPk), ACTIVATE,
    [{ x: 0n, y: 0n, identity: true }, salt, device.blind], 'identity point', [INFINITY], POINT_AT_INFINITY_OVERRIDES, { control: activationControl });
  await negative('activation', 'point at infinity, unflagged {0, 0, not identity} (honest-toolchain decoding refusal; in-circuit: the on-curve assignment)', await dormant(infinityBoot, recoveryPk), ACTIVATE,
    [{ x: 0n, y: 0n, identity: false }, salt, device.blind], 'expected value of type Secp256k1Point', [INFINITY], POINT_AT_INFINITY_OVERRIDES, { kind: 'decoding', control: activationControl });
}

// ── reactivation ──────────────────────────────────────────────────────
if (SECTIONS.includes('reactivation')) {
  section('reactivation');
  const ALREADY = 'already activated';
  const fresh = await dormant(device.bootCommitment(salt), recoveryPk);
  const patched = await loadPatched([ALREADY, BOOT]);
  await positive('reactivation', 'first activation (patched path)', patched, fresh, ACTIVATE, device.activationArgs(salt));
  const booted = (await execute(Original.Contract, fresh, ACTIVATE, device.activationArgs(salt))).after;
  // the same device again (its boot commitment was cleared: two asserts fail)
  await negative('reactivation', 'activate a booted account again (same device)', booted, ACTIVATE, device.activationArgs(salt), ALREADY, [ALREADY, BOOT]);
}

// ── coordinates not reduced below p ─────────────────────────────
//
// A secp256k1 point with a small coordinate c < 2^256 - p, presented as
// c + p: the same field element, a non-canonical representation. The boot
// commitment is made to the address a NON-reducing byte conversion would give
// (keccak256(be(c + p) || be(other))[12..]), so if the proof accepted the
// unreduced limbs as bytes, activation would go through; it must not.
if (SECTIONS.includes('qa1')) {
  section('qa1');
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const P = secp256k1.Point.Fp.ORDER;
  const be = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const smallX = (() => { for (let x = 1n; ; x++) { try { const pt = secp256k1.Point.fromAffine({ x, y: secp256k1.Point.Fp.sqrt((x ** 3n + 7n) % P) }); pt.assertValidity(); return pt.toAffine(); } catch { /* next */ } } })();
  // (A y + p case needs a point with y < 2^32 + 977, i.e. a cube root mod p;
  // the x + p case alone exercises the representation boundary.)
  const cases: [string, { x: bigint; y: bigint }, { x: bigint; y: bigint }][] = [['x + p', smallX, { x: smallX.x + P, y: smallX.y }]];
  for (const [label, real, shifted] of cases) {
    const naiveAddress = keccak_256(new Uint8Array([...be(shifted.x), ...be(shifted.y)])).subarray(12);
    const naiveBoot = pc.derive_boot_commitment_with_evm_eip712(salt, naiveAddress, device.blind);
    const realBoot = pc.derive_boot_commitment_with_evm_eip712(salt, keccak_256(new Uint8Array([...be(real.x), ...be(real.y)])).subarray(12), device.blind);
    const patched = await loadPatched([BOOT], NON_CANONICAL_COORDINATE_OVERRIDES);
    await positive('qa1', `canonical point with a small coordinate (${label.split(' ')[0]} = ${label.startsWith('x') ? real.x : real.y}) activates (patched path)`,
      patched, await dormant(realBoot, recoveryPk), ACTIVATE, [{ ...real, identity: false }, salt, device.blind]);
    // Here the generated JavaScript computes the unreduced bytes too, so no
    // assert needs bypassing: only the validators are relaxed.
    // these are honest-toolchain DECODING refusals, not constraint
    // refusals; in the circuit the byte cast is canonical (EVM-EIP712.md section 9).
    const qaControl = { a: await dormant(realBoot, recoveryPk), args: [{ ...real, identity: false }, salt, device.blind] };
    await negative('qa1', `non-canonical ${label}: boot commitment to the unreduced bytes`, await dormant(naiveBoot, recoveryPk), ACTIVATE,
      [{ ...shifted, identity: false }, salt, device.blind], 'expected value of type Secp256k1Point', [], NON_CANONICAL_COORDINATE_OVERRIDES, { kind: 'decoding', control: qaControl });
    await negative('qa1', `non-canonical ${label}: boot commitment to the real address`, await dormant(realBoot, recoveryPk), ACTIVATE,
      [{ ...shifted, identity: false }, salt, device.blind], 'expected value of type Secp256k1Point', [BOOT], NON_CANONICAL_COORDINATE_OVERRIDES, { kind: 'decoding', control: qaControl });
  }
}

// ── The seam: rotate_enc_key_with_evm_eip712 ──────────────────────────
if (SECTIONS.includes('seam')) {
  section('seam');
  // Account A: the device at index 0. Account B: the same wallet at index 1
  // (another account, another blind). Account K: the same secret key enrolled
  // on the k256 arm (envelope 0).
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after;
  const B0 = (await execute(Original.Contract, await dormant(device1.bootCommitment(salt), recoveryPk), ACTIVATE, device1.activationArgs(salt))).after;
  const k1 = new K256Device(SK);
  const K0 = (await execute(Original.Contract, await dormant(k1.bootCommitment(salt), recoveryPk), 'activate_initial_device_with_k256', [k1.pk, salt, 0n])).after;
  const newKey = rnd(32), otherKey = rnd(32);
  const ctxOf = (a: LocalAccount, d: EvmEip712Device) => ({ account: a.addressBytes, device: d.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const td = (a: LocalAccount, key = newKey) => evmEip712Messages.rotateEncKey(ctxOf(a, device), key);
  const sign = (t: Eip712TypedData) => wallet.signDigest(typedDataDigest(t));
  const authOf = (sig: Uint8Array, counter = 0n, d = device) => {
    const p = parseEvmSignature(sig);
    return { pk: d.pk, use_counter: counter, blind: d.blind, sig: { r: p.r, s: p.s } };
  };
  const honest = authOf(sign(td(A0)));
  const mutate = (f: (t: any) => void) => { const t = JSON.parse(JSON.stringify(td(A0))); f(t); return authOf(sign(t)); };
  const rename = (t: any, from: string, to: string) => {
    t.types[to] = t.types[from]; delete t.types[from]; t.primaryType = to;
  };
  const posPath = await loadPatched([INVALID, UNKNOWN, ZERO]);

  // positives: the honest call and its high-S twin, both from A0
  await positive('seam', 'honest rotate_enc_key (patched path)', posPath, A0, ROTATE, [newKey, honest]);
  const twinSig = highSTwin(parseEvmSignature(sign(td(A0))));
  const twin = { ...honest, sig: { r: twinSig.r, s: twinSig.s } };
  await positive('seam', 'the high-S twin of the honest signature', posPath, A0, ROTATE, [newKey, twin]);
  const K256_ROT = 'rotate_enc_key_with_k256';
  const kAuth = k1.sign(k256Challenges.rotateEncKey({ contractAddress: K0.addressBytes, authNonce: 0n }, k1.pk, newKey), 0n);
  await positive('seam', 'honest k256 rotate on account K (the cross-arm control)', posPath, K0, K256_ROT, [newKey, kAuth.pk, 0n, kAuth.sig, 0n]);

  // binding matrix: every signed member, changed after signing
  const B: [string, any][] = [
    ['newKey: signed K\', executed K', authOf(sign(td(A0, otherKey)))],
    ['account member: another account', mutate((t) => { t.message.account = '0x' + Buffer.from(B0.addressBytes).toString('hex'); })],
    ['device member: another address', mutate((t) => { t.message.device = '0x' + Buffer.from(other.addressBytes).toString('hex'); })],
    ['authNonce: n + 1', mutate((t) => { t.message.authNonce = '1'; })],
    ['effect line: another text', mutate((t) => { t.message.effect = 'Sets nothing'; })],
    ['domain name', mutate((t) => { t.domain.name = 'Midnight Passport Accounts'; })],
    ['domain version ("2", not the frozen "1")', mutate((t) => { t.domain.version = '2'; })],
    ['domain verifyingContract', mutate((t) => { t.domain.verifyingContract = '0x' + Buffer.from(rnd(20)).toString('hex'); })],
    ['primary type name', mutate((t) => rename(t, 'RotateEncKey', 'RotateEncryptionKey'))],
    ['a member renamed (newKey -> key)', mutate((t) => { t.types.RotateEncKey = t.types.RotateEncKey.map((f: any) => (f.name === 'newKey' ? { ...f, name: 'key' } : f)); t.message.key = t.message.newKey; delete t.message.newKey; })],
  ];
  for (const [name, auth] of B) await negative('seam', `binding: ${name}`, A0, ROTATE, [newKey, auth], INVALID, [INVALID]);

  // the authorisation fields and degenerate signatures
  await negative('seam', 'auth: an unenrolled key signs the right message', A0, ROTATE,
    [newKey, { pk: other.pk, use_counter: 0n, blind: device.blind, sig: authOf(other.signDigest(typedDataDigest(evmEip712Messages.rotateEncKey({ ...ctxOf(A0, device), device: other.addressBytes }, newKey)))).sig }], UNKNOWN, [UNKNOWN]);
  await negative('seam', 'auth: the right key with another blind', A0, ROTATE, [newKey, { ...honest, blind: device1.blind }], UNKNOWN, [UNKNOWN]);
  await negative('seam', 'auth: a wrong use counter', A0, ROTATE, [newKey, { ...honest, use_counter: 1n }], UNKNOWN, [UNKNOWN]);
  // every runtime-override copy below first proves the honest call
  // through itself (the negative's positive control)
  const seamControl = { a: A0, args: [newKey, honest] };
  await negative('seam', 'signature r = 0: the zero-scalar assert and the signature check', A0, ROTATE, [newKey, { ...honest, sig: { r: 0n, s: honest.sig.s } }], ZERO, [ZERO, INVALID], '', { control: seamControl });
  await negative('seam', 'signature s = 0: the zero-scalar assert and the signature check', A0, ROTATE, [newKey, { ...honest, sig: { r: honest.sig.r, s: 0n } }], ZERO, [ZERO, INVALID], ZERO_INV_OVERRIDES, { control: seamControl });
  await negative('seam', '(r, s) = (0, 0), which verifies against the identity point when inverses of 0 are taken as 0', A0, ROTATE,
    [newKey, { ...honest, sig: { r: 0n, s: 0n } }], ZERO, [ZERO], ZERO_INV_OVERRIDES, { control: seamControl });
  await negative('seam', 'device key = the point at infinity (flagged)', A0, ROTATE,
    [newKey, { ...honest, pk: { x: 0n, y: 0n, identity: true } }], 'identity point', [INFINITY, UNKNOWN, INVALID], POINT_AT_INFINITY_OVERRIDES, { control: seamControl });

  // replay matrix
  await negative('seam', 'replay/account: a signature for account B executed on account A', A0, ROTATE,
    [newKey, authOf(sign(evmEip712Messages.rotateEncKey(ctxOf(B0, device1), newKey)))], INVALID, [INVALID]);
  await negative('seam', 'replay/arm: the EIP-712 signature presented to the k256 arm', K0, K256_ROT,
    [newKey, k1.pk, 0n, authOf(sign(td(K0))).sig, 0n], K256_INVALID, [K256_INVALID]);
  const k256OnA = k1.sign(k256Challenges.rotateEncKey({ contractAddress: A0.addressBytes, authNonce: 0n }, k1.pk, newKey), 0n);
  await negative('seam', 'replay/arm: a k256 signature for the same key presented to the evm arm', A0, ROTATE, [newKey, { ...honest, sig: k256OnA.sig }], INVALID, [INVALID]);
  await negative('seam', 'replay/operation: a CancelRecovery signature (same frame)', A0, ROTATE,
    [newKey, authOf(sign(evmEip712Messages.cancelRecovery(ctxOf(A0, device))))], INVALID, [INVALID]);
  await negative('seam', 'replay/operation: a RevokeAllGrants signature (same frame)', A0, ROTATE,
    [newKey, authOf(sign(evmEip712Messages.revokeAllGrants(ctxOf(A0, device))))], INVALID, [INVALID]);
  const lbl = new Uint8Array(32); lbl.set(new TextEncoder().encode('Midnight'));
  await negative('seam', 'replay/role: a grantee-role signature by the same key', A0, ROTATE,
    [newKey, authOf(sign(evmEip712Messages.withdrawUnshieldedAsGrantee({ account: A0.addressBytes, grantee: device.address, label: lbl, slot: 0n, issuedAt: 0n, grantNonce: 0n }, rnd(32), 1n, rnd(32), TEST_SITE)))], INVALID, [INVALID]);
  // nonce: after one honest rotate (A1: counter 1, auth_nonce 1)
  const A1 = (await execute(Original.Contract, A0, ROTATE, [newKey, twin])).after;
  if (ledgerOf(A1).auth_nonce !== 1n) throw new Error('setup: the twin did not advance auth_nonce');
  await positive('seam', 'the next honest rotate on A1 (counter 1, nonce 1)', posPath, A1, ROTATE, [otherKey, authOf(sign(evmEip712Messages.rotateEncKey(ctxOf(A1, device), otherKey)), 1n)]);
  // (its entry is consumed AND its message names the old nonce: both asserts fail)
  await negative('seam', 'replay/nonce: the low-S original after its high-S twin executed (entry consumed)', A1, ROTATE, [newKey, honest], UNKNOWN, [UNKNOWN, INVALID]);
  await negative('seam', 'replay/nonce: the old signature with the current counter (nonce advanced)', A1, ROTATE, [newKey, { ...honest, use_counter: 1n }], INVALID, [INVALID]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Custody, and the frame mutant
// ═════════════════════════════════════════════════════════════════════════════

const APPEND = 'append_inbox_with_evm_eip712';
const WU = 'withdraw_unshielded_with_evm_eip712';
const WS = 'withdraw_shielded_with_evm_eip712';
const WSC = 'withdraw_shielded_to_contract_with_evm_eip712';
const COLOUR = 'held coin colour does not match the withdrawn colour';
const AMOUNT_ABOVE = "amount above the spent coin's value";
const NEGATIVE_SUB = 'result of subtraction would be negative';
const INSUFFICIENT = 'insufficient balance';

const S6 = ['frame', 'custody', 'witness', 'hints', 'texts', 'isolate', 'places'].some((x) => SECTIONS.includes(x));
const sig65 = (t: Eip712TypedData, w = wallet) => parseEvmSignature(w.signDigest(typedDataDigest(t)));
const authFor = (t: Eip712TypedData, counter = 0n, d = device, w = wallet) => {
  const p = sig65(t, w);
  return { pk: d.pk, use_counter: counter, blind: d.blind, sig: { r: p.r, s: p.s } };
};
const frameOf = (a: LocalAccount, d = device) => ({ account: a.addressBytes, device: d.address, authNonce: ledgerOf(a).auth_nonce as bigint });
/** The scope salt issue_grant_with_evm_eip712 derived for the grant `id` of
 *  `a`: from the issuing device's blind, the account and the auth_nonce the
 *  issuance consumed (the record's issued_at − 1); zero for no such grant. */
const grantSaltOf = (a: LocalAccount, id: Uint8Array, d = device): Uint8Array => {
  const g = ledgerOf(a).grants;
  return g.member(id) ? evmEip712GrantScopeSalt(d.blind, a.addressBytes, (g.lookup(id).issued_at as bigint) - 1n) : new Uint8Array(32);
};
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);

// The activated account (device index 0) every custody section starts from.
const S6_A0 = S6 ? (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after : undefined;

// Unshielded: two colours deposited locally (deposit_unshielded is upstream's
// permissionless circuit; local execution records the receive).
const COL_U = fill(32, 0xc1), COL_X = fill(32, 0xc2);
const RECIPIENT_U = fill(32, 0x77);
const depositedU = async () => {
  let a = S6_A0!;
  for (const c of [COL_U, COL_X]) a = (await execute(Original.Contract, a, 'deposit_unshielded', [c, 1000n])).after;
  return a;
};

// Shielded: an account whose local Zswap tree holds `coins` (in order) and
// whose held_coin witness answers `answer` for colour key `key`.
const COL_A = fill(32, 0xa1), COL_B = fill(32, 0xb2);
const NONCE_H = fill(32, 0x11), NONCE_OTHER = fill(32, 0x12), FILLER = (i: number) => fill(32, 0xf0 + i);
const shieldedAccount = (coins: { nonce: Uint8Array; color: Uint8Array; value: bigint }[], key: Uint8Array, pick: number) => {
  const { account, coins: placed } = withLocalCoins(S6_A0!, coins);
  return { a: { ...account, privateState: coinStoreAnswering([{ key, coin: placed[pick] }]) } as LocalAccount, coin: placed[pick] };
};
const RECIPIENT_CONTRACT = fill(32, 0x3c);
const shieldedMessage = (circuit: string, a: LocalAccount, amount: bigint, coin: { nonce: Uint8Array; value: bigint; mtIndex: bigint }, color = COL_A) =>
  circuit === WS
    ? evmEip712Messages.withdrawShielded(frameOf(a), color, amount, localCoinPublicKeyBytes(), coin, TEST_SITE)
    : evmEip712Messages.withdrawShieldedToContract(frameOf(a), color, amount, RECIPIENT_CONTRACT, coin, TEST_SITE);
const shieldedArgs = (circuit: string, amount: bigint, auth: unknown, color = COL_A) =>
  circuit === WS ? [{ bytes: localCoinPublicKeyBytes() }, color, amount, auth] : [{ bytes: RECIPIENT_CONTRACT }, color, amount, auth];

// ── The frame mutant ──────────────────────────────────────────────────
//
// The attacker holds the victim device's blind and counter (worst case) and
// its own key. The mutant's generated JavaScript derives the VICTIM's address
// from the attacker's point, so locally the victim's entry matches, the
// message names the victim's address, and the attacker's signature verifies
// against the attacker's point: no JavaScript check fails. The proof derives
// the address from the point itself, so the disclosed entry cannot be
// reproduced: refused at the proof server.
if (SECTIONS.includes('frame')) {
  section('frame');
  const attacker = new SoftwareEvmWallet(0xbad5eedn);
  const forging = await loadPatched([], FORGE_ADDRESS_OVERRIDES);
  const A0 = S6_A0!;
  const AU = await depositedU();
  const victimAuth = (t: Eip712TypedData) => { const p = sig65(t, attacker); return { pk: attacker.pk, use_counter: 0n, blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const fired = () => (forgery.fired > 0 ? undefined : 'the forgery never fired (the mutant missed its target)');
  const k = fill(32, 0x6b), e = rnd(192);
  // [label, account, circuit, message, args(auth)]: each case's honest call
  // (the device's own signature) is the copy's positive control, proved
  // through the forging copy with the forgery armed (it fires only for the
  // attacker's point, so the honest call is untouched)
  const cases: [string, LocalAccount, string, Eip712TypedData, (auth: unknown) => unknown[]][] = [
    ['rotate_enc_key', A0, ROTATE, evmEip712Messages.rotateEncKey(frameOf(A0), k), (au) => [k, au]],
    ['append_inbox', A0, APPEND, evmEip712Messages.appendInbox(frameOf(A0), e), (au) => [e, au]],
    ['withdraw_unshielded', AU, WU, evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 10n, RECIPIENT_U, TEST_SITE), (au) => [COL_U, 10n, { bytes: RECIPIENT_U }, au]],
  ];
  for (const circuit of [WS, WSC]) {
    const { a, coin } = shieldedAccount([{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }], COL_A, 1);
    cases.push([circuit.replace('_with_evm_eip712', ''), a, circuit, shieldedMessage(circuit, a, 300n, coin), (au) => shieldedArgs(circuit, 300n, au)]);
  }
  for (const [label, a, circuit, td, args] of cases) {
    // the message names the victim's address (what the forged derivation yields)
    forgery.set({ pk: attacker.pk, address: device.address });
    await negative('frame', `${label}: the attacker's key with the victim's address forged into the derivation`, a, circuit, args(victimAuth(td)),
      UNKNOWN, [], '', { module: forging, mutant: 'forged-address mutant (keccak256 override: the copy derives the victim address from the attacker point)',
        check: fired, control: { a, args: args(authFor(td)) } });
  }
  forgery.set(undefined);
}

// ── The checked byte hints at the proof server ─────────────────────────
//
// Each hint is exactly the bytes of a value the circuit computes, checked by
// rebuilding the value. Here one byte of one hint is changed on an otherwise
// honest call: refused by the generated JavaScript with the check's message,
// and through a copy that bypasses that check (and the checks downstream of
// the changed bytes in JavaScript) refused at the proof server by the
// circuit's own constraint. The carry attack (one byte + 256, the next − 1:
// the same number, a byte above 8 bits) travels through a copy that lets the
// byte past the type check and encodes it as given; no assert bypasses it (the
// number it rebuilds is unchanged), and the circuit's 8-bit range check of
// the hint refuses it.
if (SECTIONS.includes('hints')) {
  section('hints');
  const BYTE_H = 'evm_eip712: byte hint does not match its value';
  const HASH_H = 'evm_eip712: hash hint does not match the hash';
  const DIGEST_H = 'evm_eip712: digest hint does not match the digest';
  const WORD_H = 'evm_eip712: word hint does not match its value';
  const A0 = S6_A0!;
  const k = fill(32, 0x48);
  const rot = [k, authFor(evmEip712Messages.rotateEncKey(frameOf(A0), k))];
  honestCall(ROTATE, A0, rot);
  const F = (a: LocalAccount, circuit: string, args: unknown[], ai: number, where: 'auth' | 'op' | number, p: string[], at = 0, mode: 'flip' | 'carry' = 'flip') =>
    forgedHintArgs(a, circuit, args, ai, where, p, mode, at);
  // the device seam (one-type body)
  await negative('hints', "device seam: a byte of the key's x coordinate", A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['key', 'x'], 3), BYTE_H, [BYTE_H, HASH_H]);
  await negative('hints', 'device seam: a byte of the key hash outside the address', A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['key', 'key_hash'], 5), HASH_H, [HASH_H]);
  await negative('hints', 'device seam: a byte of the account hash outside the verifying contract', A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['account_hash'], 5), HASH_H, [HASH_H]);
  await negative('hints', 'device seam: a byte of the digest', A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['digest'], 3), DIGEST_H, [DIGEST_H, INVALID]);
  await negative('hints', 'device seam: a byte of auth_nonce', A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['nonce'], 0), WORD_H, [WORD_H, DIGEST_H]);
  await negative('hints', 'device seam: the carry attack on auth_nonce (byte + 256, next − 1)', A0, ROTATE, F(A0, ROTATE, rot, 1, 'auth', ['nonce'], 0, 'carry'),
    'type error', [], HINT_CARRY_OVERRIDES, { control: { a: A0, args: rot } });
  // activation
  const D0 = await dormant(device.bootCommitment(salt), recoveryPk);
  honestCall(ACTIVATE, D0, device.activationArgs(salt));
  await negative('hints', "activation: a byte of the key's y coordinate", D0, ACTIVATE, F(D0, ACTIVATE, device.activationArgs(salt), 3, 3, ['y'], 3), BYTE_H, [BYTE_H, HASH_H]);
  // the operations' own hints
  const AU = await depositedU();
  const wu = [COL_U, 10n, { bytes: RECIPIENT_U }, authFor(evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 10n, RECIPIENT_U, TEST_SITE))];
  honestCall(WU, AU, wu);
  await negative('hints', 'withdraw_unshielded: a byte of the amount', AU, WU, F(AU, WU, wu, 3, 'op', ['amount'], 0), WORD_H, [WORD_H, DIGEST_H]);
  // the display inputs: the site's label with one digit changed (the digits
  // then read back to another amount)
  const LABEL_H = 'display: the site amount label does not match the value';
  await negative('hints', "withdraw_unshielded: a digit of the site's amount label", AU, WU, F(AU, WU, wu, 3, 'op', ['label'], 6), LABEL_H, [LABEL_H, DIGEST_H]);
  await negative('hints', 'withdraw_unshielded: the carry attack on the amount', AU, WU, F(AU, WU, wu, 3, 'op', ['amount'], 0, 'carry'),
    'type error', [], HINT_CARRY_OVERRIDES, { control: { a: AU, args: wu } });
  const { a: AS, coin } = shieldedAccount([{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }], COL_A, 1);
  const ws = shieldedArgs(WS, 300n, authFor(shieldedMessage(WS, AS, 300n, coin)));
  honestCall(WS, AS, ws);
  await negative('hints', 'withdraw_shielded: a byte of the change', AS, WS, F(AS, WS, ws, 3, 'op', ['change'], 0), WORD_H, [WORD_H, DIGEST_H]);
  // descriptors
  const K = new K256Device(0x41n);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const add = [kIn, ...solArgs(kIn), authFor(evmEip712Messages.addDevice(frameOf(A0), kIn))];
  honestCall('add_device_with_evm_eip712', A0, add);
  await negative('hints', "add_device: a byte of the target's x coordinate", A0, 'add_device_with_evm_eip712', F(A0, 'add_device_with_evm_eip712', add, 4, 'op', ['key'], 3),
    BYTE_H, [BYTE_H, DIGEST_H]);
  // the Solana key inputs, checked by the shared encoder: the filler key of a
  // k256 target (its results are discarded), and a Solana target's shown key
  const SOL_Y = "descriptor: the Ed25519 key bytes do not match the point's y";
  const SOL_X = "descriptor: the Ed25519 x bytes do not match the point's x";
  await negative('hints', "add_device: a byte of the filler key's encoding (k256 target)", A0, 'add_device_with_evm_eip712',
    F(A0, 'add_device_with_evm_eip712', add, 4, 2, [], 5), SOL_Y, [SOL_Y]);
  const solIn = evmEip712DescriptorInput({ scheme: 'sol_ed25519', key: ed25519.getPublicKey(fill(32, 0x53)), blind: fill(32, 0x54) });
  const addS = [solIn, ...solArgs(solIn), authFor(evmEip712Messages.addDevice(frameOf(A0), solIn))];
  await negative('hints', "add_device: a byte of a Solana target's x coordinate", A0, 'add_device_with_evm_eip712',
    F(A0, 'add_device_with_evm_eip712', addS, 4, 3, [], 5), SOL_X, [SOL_X]);
  await negative('hints', "add_device: a byte of a Solana target's encoding (the key shown)", A0, 'add_device_with_evm_eip712',
    F(A0, 'add_device_with_evm_eip712', addS, 4, 2, [], 5), SOL_Y, [SOL_Y, DIGEST_H]);
  // the base58 text of a Solana target with one digit changed
  const B58_H = 'display: the base58 carry hints do not split the leading digits';
  await negative('hints', "add_device: a digit of a Solana target's base58 text", A0, 'add_device_with_evm_eip712',
    F(A0, 'add_device_with_evm_eip712', addS, 4, 'op', ['b58', 'digits'], 5), B58_H, [B58_H, DIGEST_H]);
  const pk = softwarePasskey();
  const pIn = evmEip712DescriptorInput({ scheme: 'p256', x: pk.pk.x, y: pk.pk.y, policy: { rpIdHash: fill(32, 0x52), origin: new TextEncoder().encode('https://ab.example.co') } } as Descriptor);
  const addP = [pIn, ...solArgs(pIn), authFor(evmEip712Messages.addDevice(frameOf(A0), pIn))];
  await negative('hints', "add_device: a byte of a passkey target's origin", A0, 'add_device_with_evm_eip712', F(A0, 'add_device_with_evm_eip712', addP, 4, 'op', ['origin'], 3),
    BYTE_H, [BYTE_H]);
  // a grantee and its twin
  const gWallet = new SoftwareEvmWallet(0x4a17en);
  const eg = await EvmEip712Grantee.enrol(gWallet, 'undeployed', A0.addressBytes, grantLabel('bank.example'), 0n);
  const egIn = eg.descriptor();
  const sc: IssueScope = { opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: COL_U,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: RECIPIENT_U, maxCoinValue: 300n, perCallCap: 300n, cap: 1000n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null };
  const issue = (a: LocalAccount) => [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(sc), authFor(evmEip712Messages.issueGrant(frameOf(a), egIn, sc))];
  const ISSUE_H = 'issue_grant_with_evm_eip712';
  honestCall(ISSUE_H, AU, issue(AU));
  await negative('hints', "issue_grant: a byte of the grantee's site label", AU, ISSUE_H, F(AU, ISSUE_H, issue(AU), 20, 'op', ['grantee', 'label'], 0), BYTE_H, [BYTE_H, DIGEST_H]);
  await negative('hints', "issue_grant: a byte of the scope's cap", AU, ISSUE_H, F(AU, ISSUE_H, issue(AU), 20, 'op', ['cap'], 0), WORD_H, [WORD_H, DIGEST_H]);
  // the expiry's date with its seconds changed (2030-01-01 00:00:00 UTC shown as 00:00:01)
  const DATE_H = 'display: the date and time do not match the value';
  const scE: IssueScope = { ...sc, expiresAt: 1893456000n };
  const issueE = (a: LocalAccount) => [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(scE), authFor(evmEip712Messages.issueGrant(frameOf(a), egIn, scE))];
  await negative('hints', "issue_grant: a digit of the expiry's UTC date", AU, ISSUE_H, F(AU, ISSUE_H, issueE(AU), 20, 'op', ['expiry_text'], 18), DATE_H, [DATE_H, DIGEST_H]);
  const AG = (await execute(Original.Contract, AU, ISSUE_H, issue(AU))).after;
  const rec = ledgerOf(AG).grants.lookup(eg.grantId(AG.addressBytes));
  const gtd = evmEip712Messages.withdrawUnshieldedAsGrantee({ account: AG.addressBytes, grantee: eg.address, label: eg.label, slot: 0n, issuedAt: rec.issued_at, grantNonce: rec.nonce },
    COL_U, 50n, RECIPIENT_U, TEST_SITE);
  const gp = parseEvmSignature(gWallet.signDigest(typedDataDigest(gtd)));
  const gAuth: any = { arm: 'evm_eip712', pk: eg.pk, blind: eg.blind, label: eg.label, sig: { r: gp.r, s: gp.s } };
  const opening: GrantOpening = { originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AG, eg.grantId(AG.addressBytes)), recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: RECIPIENT_U, maxCoinValue: 300n, spentPrev: 0n };
  const tw = [COL_U, 50n, { bytes: RECIPIENT_U }, ...grantAuthArgs(opening, gAuth)];
  const GWU_H = 'withdraw_unshielded_with_grant_evm_eip712';
  honestCall(GWU_H, AG, tw);
  await negative('hints', "grant seam: a byte of the frame's site label", AG, GWU_H, F(AG, GWU_H, tw, 10, 'auth', ['label'], 0), BYTE_H, [BYTE_H, DIGEST_H]);
  await negative('hints', "grant seam: a byte of the record's issuedAt", AG, GWU_H, F(AG, GWU_H, tw, 10, 'auth', ['issued_at'], 0), WORD_H, [WORD_H, DIGEST_H]);
  await negative('hints', 'grant seam: a byte of the digest', AG, GWU_H, F(AG, GWU_H, tw, 10, 'auth', ['digest'], 3), DIGEST_H, [DIGEST_H, 'invalid grant signature']);
}

// ── append_inbox and withdraw_unshielded ───────────────────────────────
if (SECTIONS.includes('custody')) {
  section('custody');
  const A0 = S6_A0!;
  const posPath = await loadPatched([INVALID, UNKNOWN, INSUFFICIENT]);
  // append_inbox
  const E1 = rnd(192), E2 = rnd(192);
  const tdE = evmEip712Messages.appendInbox(frameOf(A0), E1);
  await positive('custody', 'append_inbox: honest (patched path)', posPath, A0, APPEND, [E1, authFor(tdE)]);
  await negative('custody', 'append_inbox binding: entry signed E2, executed E1', A0, APPEND, [E1, authFor(evmEip712Messages.appendInbox(frameOf(A0), E2))], INVALID, [INVALID]);
  const E1b = new Uint8Array(E1); E1b[191] ^= 1;
  await negative('custody', 'append_inbox binding: the last ciphertext byte flipped', A0, APPEND, [E1b, authFor(tdE)], INVALID, [INVALID]);
  await negative('custody', 'append_inbox replay/operation: a RotateEncKey signature', A0, APPEND,
    [E1, authFor(evmEip712Messages.rotateEncKey(frameOf(A0), E1.subarray(0, 32)))], INVALID, [INVALID]);
  // withdraw_unshielded (mirror: 1000 of COL_U and of COL_X)
  const AU = await depositedU();
  const tdU = evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 400n, RECIPIENT_U, TEST_SITE);
  await positive('custody', 'withdraw_unshielded: honest 400 of 1000 (patched path)', posPath, AU, WU, [COL_U, 400n, { bytes: RECIPIENT_U }, authFor(tdU)]);
  await positive('custody', 'withdraw_unshielded: the whole mirror, 1000 (patched path)', posPath, AU, WU,
    [COL_U, 1000n, { bytes: RECIPIENT_U }, authFor(evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 1000n, RECIPIENT_U, TEST_SITE))]);
  await negative('custody', 'withdraw_unshielded binding: amount signed 400, executed 401', AU, WU, [COL_U, 401n, { bytes: RECIPIENT_U }, authFor(tdU)], INVALID, [INVALID]);
  await negative('custody', 'withdraw_unshielded binding: colour signed U, executed X', AU, WU, [COL_X, 400n, { bytes: RECIPIENT_U }, authFor(tdU)], INVALID, [INVALID]);
  await negative('custody', 'withdraw_unshielded binding: another recipient', AU, WU, [COL_U, 400n, { bytes: fill(32, 0x78) }, authFor(tdU)], INVALID, [INVALID]);
  // the site's amount label is part of what is signed: the label of another
  // decimal point (the executed call carries the test site's label)
  const tdU0 = JSON.parse(JSON.stringify(tdU)); tdU0.message.amountLabel = amountLabelText(400n, { decimals: 0, symbol: 'TOKEN' });
  await negative('custody', 'withdraw_unshielded binding: the amount label of another decimal point signed', AU, WU, [COL_U, 400n, { bytes: RECIPIENT_U }, authFor(tdU0)], INVALID, [INVALID]);
  await runtimeOnly('custody', 'withdraw_unshielded: over-withdrawal (1001 of a 1000 mirror), honestly signed', AU, WU,
    [COL_U, 1001n, { bytes: RECIPIENT_U }, authFor(evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 1001n, RECIPIENT_U, TEST_SITE))], INSUFFICIENT,
    "upstream's shared chip (debit_unshielded); with its assert and the checked subtraction bypassed, the generated JavaScript's type encoder refuses the negative balance ('expected UnsignedInteger'), which is not an assert; in-circuit, the assert and the subtraction's range check refuse it");
  await negative('custody', 'withdraw_unshielded replay/operation: an AppendInbox signature', AU, WU, [COL_U, 400n, { bytes: RECIPIENT_U }, authFor(tdE)], INVALID, [INVALID]);
}

// ── Witness substitution on the shielded spends ────────────────────────
//
// The honest coin H = (NONCE_H, COL_A, 1000) sits at Merkle index 1 (a filler
// coin at 0). Each negative signs a valid message over H, then the local
// tree holds a DIFFERENT coin where the substituted witness says it is, so
// the Zswap spend of the substituted coin is valid and only the arm
// circuit can refuse it.
if (SECTIONS.includes('witness')) {
  section('witness');
  for (const circuit of [WS, WSC]) {
    const tag = circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract';
    const posPath = await loadPatched([INVALID, COLOUR, AMOUNT_ABOVE, NEGATIVE_SUB]);
    const honestTree = [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }];
    const H = shieldedAccount(honestTree, COL_A, 1);
    const tdH = shieldedMessage(circuit, H.a, 300n, H.coin);
    const authH = authFor(tdH);
    await positive('witness', `${tag}: honest partial spend 300 of 1000 (change 700, patched path)`, posPath, H.a, circuit, shieldedArgs(circuit, 300n, authH));
    await positive('witness', `${tag}: honest full spend 1000 (no change)`, posPath, H.a, circuit,
      shieldedArgs(circuit, 1000n, authFor(shieldedMessage(circuit, H.a, 1000n, H.coin))));
    // colour: the witness coin is (NONCE_H, COL_B, 1000) at index 1; the
    // signature over colour A still verifies (colour is shown once, as the
    // argument), so only the colour assert refuses
    const colour = shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_B, value: 1000n }], COL_A, 1);
    await negative('witness', `${tag}: valid signature for colour A, witness coin of colour B (same nonce, value, index)`, colour.a, circuit,
      shieldedArgs(circuit, 300n, authH), COLOUR, [COLOUR]);
    // value: the witness coin is (NONCE_H, COL_A, 999) at index 1
    const value = shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_A, value: 999n }], COL_A, 1);
    await negative('witness', `${tag}: valid signature for coin value 1000, witness coin of value 999`, value.a, circuit,
      shieldedArgs(circuit, 300n, authH), INVALID, [INVALID]);
    // nonce: the witness coin is (NONCE_OTHER, COL_A, 1000) at index 1
    const nonce = shieldedAccount([honestTree[0], { nonce: NONCE_OTHER, color: COL_A, value: 1000n }], COL_A, 1);
    await negative('witness', `${tag}: valid signature for coin nonce N, witness coin of nonce N'`, nonce.a, circuit,
      shieldedArgs(circuit, 300n, authH), INVALID, [INVALID]);
    // index: H sits at index 2 (another coin at 1); the signature says index 1
    const index = shieldedAccount([honestTree[0], { nonce: FILLER(1), color: COL_A, value: 7n }, honestTree[1]], COL_A, 2);
    await negative('witness', `${tag}: valid signature for Merkle index 1, witness coin at index 2`, index.a, circuit,
      shieldedArgs(circuit, 300n, authH), INVALID, [INVALID]);
    // amount above the coin's value: a witness coin of value 200 against a
    // signed amount of 300 (the client refuses to build such a message)
    const small = shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_A, value: 200n }], COL_A, 1);
    await runtimeOnly('witness', `${tag}: witness coin of value 200 below the signed amount 300`, small.a, circuit,
      shieldedArgs(circuit, 300n, authH), AMOUNT_ABOVE,
      "with the arm's assert and the checked subtraction bypassed, the generated JavaScript's type encoder refuses the negative change ('expected UnsignedInteger'), which is not an assert; in-circuit, the assert, the subtraction's range check and the signature over the shown value refuse it");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Device lifecycle with readable descriptors
// ═════════════════════════════════════════════════════════════════════════════

if (SECTIONS.includes('devices')) {
  section('devices');
  const ADD = 'add_device_with_evm_eip712';
  const REMOVE = 'remove_device_with_evm_eip712';
  const NOT_DEVICE_TAG = 'evm_eip712: not a registered device tag';
  const W117 = 'descriptor: not a 117-byte device tag';
  const LAST = 'cannot remove last device';
  const SELF = 'cannot remove the authorising device';
  const NONCANON = 'noncanonical absent entry';
  const RP_ZERO = "evm_eip712: a passkey's RP hash is zero";
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after;
  const frame = (a: LocalAccount) => ({ account: a.addressBytes, device: device.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const signAs = (t: Eip712TypedData, counter: bigint) => { const p = parseEvmSignature(wallet.signDigest(typedDataDigest(t))); return { pk: device.pk, use_counter: counter, blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const counterOf = (a: LocalAccount) => { for (let k = 0n; k < 64n; k++) if (ledgerOf(a).devices.member(device.entryAt(a.addressBytes, ledgerOf(a).device_epoch, k))) return k; throw new Error('device not live'); };
  const NONE = { is_some: false, value: new Uint8Array(32) };
  // targets, one per scheme
  const jub = JubjubDevice.generate();
  const k1 = new K256Device(0x5eed1n);
  const pass = softwarePasskey();
  const evm2 = await EvmEip712Device.enrol(new SoftwareEvmWallet(0xe2n), 'undeployed', 0);
  const solSk = new Uint8Array(32).fill(0x51);
  const solKey = ed25519.getPublicKey(solSk);
  const targets: [string, Descriptor, (acc: LocalAccount, epoch: bigint) => Uint8Array][] = [
    ['jubjub', { scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y }, (acc, ep) => jub.entryAt(acc.addressBytes, ep, 0n)],
    ['k256', { scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: 0 }, (acc, ep) => k1.entryAt(acc.addressBytes, ep, 0n)],
    ['p256', { scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } }, (acc, ep) => pass.device.entryAt(acc.addressBytes, ep, 0n)],
    ['evm_eip712', evmDeviceDescriptor(evm2), (acc, ep) => evm2.entryAt(acc.addressBytes, ep, 0n)],
    ['sol_ed25519', { scheme: 'sol_ed25519', key: solKey, blind: rnd(32) }, () => new Uint8Array(0)],
  ];
  const posPath = await loadPatched([INVALID, UNKNOWN, NOT_DEVICE_TAG, W117, SELF, LAST, NONCANON]);
  // add_device: every target scheme; the enrolled entry is the target
  // scheme's own derivation (upstream's derive_device_entry_with_<arm> for
  // jubjub, k256 and p256; the descriptor recipe for the new arms) at the
  // current epoch and counter 0
  for (const [scheme, d, upstreamEntry] of targets) {
    const input = evmEip712DescriptorInput(d);
    const td = evmEip712Messages.addDevice(frame(A0), input);
    const args = [input, ...solArgs(input), signAs(td, 0n)];
    await positive('devices', `add_device: a ${scheme} target (patched path)`, posPath, A0, ADD, args);
    const after = (await execute(Original.Contract, A0, ADD, args)).after;
    const l = ledgerOf(after);
    const expected = scheme === 'sol_ed25519'
      ? pc.derive_descriptor_entry_ed25519(padTag(DESCRIPTOR_TAGS.device.sol_ed25519), { bytes: A0.addressBytes }, ...solArgs(input), input.key2, 0n, 0n)[1]
      : upstreamEntry(A0, 0n);
    const ok = l.devices.member(expected) && l.device_count === 2n && !l.devices.member(scheme === 'sol_ed25519' ? new Uint8Array(32) : upstreamEntry(A0, 1n));
    const r: Result = { section: 'devices', circuit: ADD, case: `add_device: the ${scheme} entry equals ${scheme === 'sol_ed25519' ? 'the ed25519 class recipe (from the point)' : `upstream's derive_device_entry_with_${scheme}`} at epoch 0, counter 0; nothing at epoch 1`, kind: 'positive' };
    r.positive = { name: r.case, verdict: ok ? 'PASS' : 'FAIL', reason: ok ? 'state checked' : 'entry missing or wrong', proofServer: [], startedAt: new Date().toISOString(), ms: 0 };
    tally(r.positive); results.push(r); line(r);
  }
  // binding of descriptor fields and of the scheme
  const kIn = evmEip712DescriptorInput(targets[1][1]);
  const kTd = evmEip712Messages.addDevice(frame(A0), kIn);
  const flip = (b: Uint8Array) => { const c = new Uint8Array(b); c[0] ^= 1; return c; };
  await negative('devices', 'add_device binding: k256 x changed after signing', A0, ADD, [{ ...kIn, key: flip(kIn.key) }, ...solArgs({ ...kIn, key: flip(kIn.key) }), signAs(kTd, 0n)], INVALID, [INVALID]);
  await negative('devices', 'add_device binding: k256 envelope changed after signing', A0, ADD, [{ ...kIn, envelope: 1n }, ...solArgs({ ...kIn, envelope: 1n }), signAs(kTd, 0n)], INVALID, [INVALID]);
  const pIn = evmEip712DescriptorInput(targets[2][1]);
  const pTd = evmEip712Messages.addDevice(frame(A0), pIn);
  const o2 = new Uint8Array(pIn.origin); o2[20] = 0x39;
  await negative('devices', 'add_device binding: passkey origin changed after signing', A0, ADD, [{ ...pIn, origin: o2 }, ...solArgs({ ...pIn, origin: o2 }), signAs(pTd, 0n)], INVALID, [INVALID]);
  await negative('devices', 'add_device binding: passkey RP hash changed after signing', A0, ADD, [{ ...pIn, rp_id_hash: flip(pIn.rp_id_hash) }, ...solArgs({ ...pIn, rp_id_hash: flip(pIn.rp_id_hash) }), signAs(pTd, 0n)], INVALID, [INVALID]);
  const eIn = evmEip712DescriptorInput(targets[3][1]);
  const eTd = evmEip712Messages.addDevice(frame(A0), eIn);
  await negative('devices', 'add_device binding: EVM target privacy salt changed after signing', A0, ADD, [{ ...eIn, key2: flip(eIn.key2) }, ...solArgs({ ...eIn, key2: flip(eIn.key2) }), signAs(eTd, 0n)], INVALID, [INVALID]);
  await negative('devices', 'add_device binding: EVM target address changed after signing', A0, ADD, [{ ...eIn, address: flip(eIn.address) }, ...solArgs({ ...eIn, address: flip(eIn.address) }), signAs(eTd, 0n)], INVALID, [INVALID]);
  // the circuit-fixed consequence line: a message whose effect line
  // says something else is not this circuit's message
  const softer = JSON.parse(JSON.stringify(kTd)); softer.message.effect = 'Adds a helper key';
  await negative('devices', 'add_device: the effect line changed in the signed message', A0, ADD, [kIn, ...solArgs(kIn), signAs(softer, 0n)], INVALID, [INVALID]);
  const jIn = evmEip712DescriptorInput(targets[0][1]);
  await negative('devices', 'add_device binding: a JubjubDevice signature executed under the Solana tag (same 64 payload bytes)', A0, ADD,
    [{ ...jIn, tag: padTag(DESCRIPTOR_TAGS.device.sol_ed25519) }, ...EVM_EIP712_SOL_FILLER_ARGS, signAs(evmEip712Messages.addDevice(frame(A0), jIn), 0n)], INVALID, [INVALID]);
  // unregistered tag under a VALID signature: the passkey branch's struct hash
  // names the scheme by its constant, not by the tag bytes, so a signature
  // over a PasskeyDevice message verifies; only the tag checks refuse
  for (const [label, tag] of [['an unregistered tag', padTag('midnight:account:device:zz:v9')], ["another recipe's tag (k256 boot)", padTag('midnight:account:boot:k1:v2')]] as const) {
    await negative('devices', `add_device: ${label}, valid signature over the passkey fields (the 117-byte class assert refuses the same tag)`, A0, ADD,
      [{ ...pIn, tag }, ...solArgs({ ...pIn, tag }), signAs(pTd, 0n)], NOT_DEVICE_TAG, [NOT_DEVICE_TAG, W117], '', { control: { a: A0, args: [pIn, ...solArgs(pIn), signAs(pTd, 0n)] } });
  }
  // a passkey origin that is not visible ASCII (a space): the approval shows
  // the executed origin (the codec refuses it, so its message is patched and
  // then signed); positive control: the passkey with its own origin
  const NOT_ORIGIN = 'evm_eip712: the passkey origin is not visible ASCII';
  const oSpace = new Uint8Array(pIn.origin); oSpace[10] = 0x20;
  const pSpaceIn = { ...pIn, origin: oSpace };
  const pSpaceTd = JSON.parse(JSON.stringify(pTd)); pSpaceTd.message.newDevice.origin = String.fromCharCode(...oSpace);
  await negative('devices', 'add_device: a passkey target whose origin holds a space, honestly signed', A0, ADD,
    [pSpaceIn, ...solArgs(pSpaceIn), signAs(pSpaceTd, 0n)], NOT_ORIGIN, [NOT_ORIGIN], '', { control: { a: A0, args: [pIn, ...solArgs(pIn), signAs(pTd, 0n)] } });
  // a Solana target at the identity point: the descriptor module's ed25519
  // class refuses it (A != O); the approval shows the key the circuit derives,
  // the identity's encoding 01 00…00; positive control: the Solana target
  const NOT_IDENTITY = 'descriptor: the Ed25519 key is the identity';
  const solIn = evmEip712DescriptorInput(targets[4][1]);
  const idEncoding = new Uint8Array(32); idEncoding[0] = 1;
  const solIdIn = { ...solIn, key: idEncoding };
  await negative('devices', 'add_device: a Solana target at the identity point, honestly signed (the approval shows its encoding 01 00…00)', A0, ADD,
    [solIdIn, { x: 0n, y: 1n }, [...idEncoding].map(BigInt), new Array(32).fill(0n), signAs(evmEip712Messages.addDevice(frame(A0), solIdIn), 0n)], NOT_IDENTITY, [NOT_IDENTITY], '',
    { control: { a: A0, args: [solIn, ...solArgs(solIn), signAs(evmEip712Messages.addDevice(frame(A0), solIn), 0n)] } });
  // a k256 target with envelope 2: the approval shows the envelope-1 label,
  // which the circuit selects for any non-zero envelope
  const NOT_ENVELOPE = 'evm_eip712: not a k256 envelope';
  const kEnv2In = { ...kIn, envelope: 2n };
  await negative('devices', 'add_device: a k256 target with envelope 2, shown with the envelope-1 label the circuit selects, honestly signed', A0, ADD,
    [kEnv2In, ...solArgs(kEnv2In), signAs(evmEip712Messages.addDevice(frame(A0), { ...kIn, envelope: 1n }), 0n)], NOT_ENVELOPE, [NOT_ENVELOPE], '',
    { control: { a: A0, args: [kIn, ...solArgs(kIn), signAs(kTd, 0n)] } });
  // remove_device: an account with the device D and a k256 device K
  const AK = (await execute(Original.Contract, A0, ADD, [kIn, ...solArgs(kIn), signAs(kTd, 0n)])).after; // D now at counter 1
  const kEntry = k1.entryAt(AK.addressBytes, 0n, 0n);
  // A passkey's own RP pin is never zero. add_device: under an approval
  // honestly covering the zero hash (the codec refuses it, so its message is
  // patched and then signed); positive control: the passkey with its RP.
  const hx = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
  const pZeroIn = { ...pIn, rp_id_hash: new Uint8Array(32) };
  const pZeroTd = JSON.parse(JSON.stringify(pTd)); pZeroTd.message.newDevice.passkeyRpHash = hx(new Uint8Array(32));
  await negative('devices', 'add_device: a passkey target with a zero RP hash, honestly signed', A0, ADD,
    [pZeroIn, ...solArgs(pZeroIn), signAs(pZeroTd, 0n)], RP_ZERO, [RP_ZERO], '', { control: { a: A0, args: [pIn, ...solArgs(pIn), signAs(pTd, 0n)] } });
  // remove_device by descriptor: K (an upstream arm) plants the zero-RP
  // passkey entry raw, so that the entry exists and only that rule refuses its
  // removal by descriptor; positive control: the same entry removed by the
  // literal-entry form, which remains the way to evict it
  const zEntry = pc.evm_eip712_descriptor_entry({ bytes: AK.addressBytes }, pZeroIn, new Uint8Array(32), 0n, 0n);
  const kz = k1.sign(k256Challenges.addDevice({ contractAddress: AK.addressBytes, authNonce: ledgerOf(AK).auth_nonce }, k1.pk, zEntry), 0n);
  const APZ = (await execute(Original.Contract, AK, 'add_device_with_k256', [zEntry, kz.pk, 0n, kz.sig, 0n])).after;
  const pzRemTd = JSON.parse(JSON.stringify(evmEip712Messages.removeDevice(frame(APZ), pIn, 0n, 0n))); pzRemTd.message.target.passkeyRpHash = hx(new Uint8Array(32));
  await negative('devices', 'remove_device (descriptor form): a passkey target with a zero RP hash, honestly signed', APZ, REMOVE,
    [pZeroIn, ...solArgs(pZeroIn), 0n, 0n, NONE, signAs(pzRemTd, 1n)], RP_ZERO, [RP_ZERO], '',
    { control: { a: APZ, args: [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: zEntry }, signAs(evmEip712Messages.removeUnknownDevice(frame(APZ), zEntry), 1n)] } });
  const remTd = (a: LocalAccount, input: typeof kIn, ep: bigint, ctr: bigint) => evmEip712Messages.removeDevice(frame(a), input, ep, ctr);
  // remove_device by descriptor of a passkey whose origin holds a space: K
  // plants that entry raw, so the entry exists and only the origin rule
  // refuses; positive control: the same entry removed by the literal form
  const oEntry = pc.evm_eip712_descriptor_entry({ bytes: AK.addressBytes }, pSpaceIn, new Uint8Array(32), 0n, 0n);
  const ko = k1.sign(k256Challenges.addDevice({ contractAddress: AK.addressBytes, authNonce: ledgerOf(AK).auth_nonce }, k1.pk, oEntry), 0n);
  const APO = (await execute(Original.Contract, AK, 'add_device_with_k256', [oEntry, ko.pk, 0n, ko.sig, 0n])).after;
  const poRemTd = JSON.parse(JSON.stringify(remTd(APO, pIn, 0n, 0n))); poRemTd.message.target.origin = String.fromCharCode(...oSpace);
  await negative('devices', 'remove_device (descriptor form): a passkey target whose origin holds a space, honestly signed', APO, REMOVE,
    [pSpaceIn, ...solArgs(pSpaceIn), 0n, 0n, NONE, signAs(poRemTd, 1n)], NOT_ORIGIN, [NOT_ORIGIN], '',
    { control: { a: APO, args: [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: oEntry }, signAs(evmEip712Messages.removeUnknownDevice(frame(APO), oEntry), 1n)] } });
  // remove_device by descriptor of a k256 entry with envelope 2, planted raw
  // by K; positive control: the same entry removed by the literal form
  const e2Entry = pc.evm_eip712_descriptor_entry({ bytes: AK.addressBytes }, kEnv2In, new Uint8Array(32), 0n, 0n);
  const ke = k1.sign(k256Challenges.addDevice({ contractAddress: AK.addressBytes, authNonce: ledgerOf(AK).auth_nonce }, k1.pk, e2Entry), 0n);
  const APE = (await execute(Original.Contract, AK, 'add_device_with_k256', [e2Entry, ke.pk, 0n, ke.sig, 0n])).after;
  await negative('devices', 'remove_device (descriptor form): a k256 target with envelope 2, shown with the envelope-1 label, honestly signed', APE, REMOVE,
    [kEnv2In, ...solArgs(kEnv2In), 0n, 0n, NONE, signAs(remTd(APE, { ...kIn, envelope: 1n }, 0n, 0n), 1n)], NOT_ENVELOPE, [NOT_ENVELOPE], '',
    { control: { a: APE, args: [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: e2Entry }, signAs(evmEip712Messages.removeUnknownDevice(frame(APE), e2Entry), 1n)] } });
  // the two-form body's zero-scalar assert, isolated in the copy
  await negative('devices', 'remove_device: (r, s) = (0, 0), which verifies against the identity point when inverses of 0 are taken as 0', AK, REMOVE,
    [kIn, ...solArgs(kIn), 0n, 0n, NONE, { ...signAs(remTd(AK, kIn, 0n, 0n), 1n), sig: { r: 0n, s: 0n } }], ZERO, [ZERO], ZERO_INV_OVERRIDES,
    { control: { a: AK, args: [kIn, ...solArgs(kIn), 0n, 0n, NONE, signAs(remTd(AK, kIn, 0n, 0n), 1n)] } });
  await positive('devices', 'remove_device: the k256 device by descriptor (epoch 0, counter 0)', posPath, AK, REMOVE,
    [kIn, ...solArgs(kIn), 0n, 0n, NONE, signAs(remTd(AK, kIn, 0n, 0n), 1n)]);
  await positive('devices', 'remove_device: the k256 entry by the literal form', posPath, AK, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: kEntry }, signAs(evmEip712Messages.removeUnknownDevice(frame(AK), kEntry), 1n)]);
  await negative('devices', 'remove_device binding: targetCounter signed 0, executed 1', AK, REMOVE, [kIn, ...solArgs(kIn), 0n, 1n, NONE, signAs(remTd(AK, kIn, 0n, 0n), 1n)], INVALID, [INVALID, UNKNOWN]);
  await negative('devices', 'remove_device binding: the literal entry changed after signing', AK, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: flip(kEntry) }, signAs(evmEip712Messages.removeUnknownDevice(frame(AK), kEntry), 1n)], INVALID, [INVALID, UNKNOWN]);
  await negative('devices', 'remove_device form swap: a RemoveUnknownDevice signature executed in the descriptor form', AK, REMOVE,
    [kIn, ...solArgs(kIn), 0n, 0n, NONE, signAs(evmEip712Messages.removeUnknownDevice(frame(AK), kEntry), 1n)], INVALID, [INVALID]);
  await negative('devices', 'remove_device form swap: a RemoveDevice signature executed in the literal form', AK, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: kEntry }, signAs(remTd(AK, kIn, 0n, 0n), 1n)], INVALID, [INVALID]);
  const unkTd = JSON.parse(JSON.stringify(evmEip712Messages.removeUnknownDevice(frame(AK), kEntry))); unkTd.message.effect = 'Removes a device';
  await negative('devices', 'remove_device (literal form): the fixed revocation line changed in the signed message', AK, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: kEntry }, signAs(unkTd, 1n)], INVALID, [INVALID]);
  await negative('devices', 'remove_device: a non-canonical absent literal entry', AK, REMOVE,
    [kIn, ...solArgs(kIn), 0n, 0n, { is_some: false, value: kEntry }, signAs(remTd(AK, kIn, 0n, 0n), 1n)], NONCANON, [NONCANON]);
  // S13: the caller's own post-roll entry (D at counter 1 rolls to 2)
  const self = evmEip712DescriptorInput(evmDeviceDescriptor(device));
  const selfPost = device.entryAt(AK.addressBytes, 0n, 2n);
  await negative('devices', 'S13: the device removes its own post-roll entry by descriptor', AK, REMOVE,
    [self, ...solArgs(self), 0n, 2n, NONE, signAs(remTd(AK, self, 0n, 2n), 1n)], SELF, [SELF]);
  await negative('devices', 'S13: the device removes its own post-roll entry by the literal form', AK, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: selfPost }, signAs(evmEip712Messages.removeUnknownDevice(frame(AK), selfPost), 1n)], SELF, [SELF]);
  // the last device: only D (A0); a literal entry of nothing
  await negative('devices', 'the last device cannot be removed (account with one device)', A0, REMOVE,
    [EVM_EIP712_UNUSED_DESCRIPTOR, ...solArgs(EVM_EIP712_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: device.entryAt(A0.addressBytes, 0n, 1n) },
     signAs(evmEip712Messages.removeUnknownDevice(frame(A0), device.entryAt(A0.addressBytes, 0n, 1n)), 0n)], LAST, [LAST, SELF]);
  // the future-epoch plant (README erratum 7): K (an upstream arm) enrols a
  // raw entry derived at device_epoch + 1; D evicts it by descriptor at
  // that epoch. add_device_with_evm_eip712 itself takes no epoch.
  const W = await EvmEip712Device.enrol(new SoftwareEvmWallet(0x3a37n), 'undeployed', 0);
  const plant = W.entryAt(AK.addressBytes, 1n, 0n);
  const kAuth = k1.sign(k256Challenges.addDevice({ contractAddress: AK.addressBytes, authNonce: ledgerOf(AK).auth_nonce }, k1.pk, plant), 0n);
  const AP = (await execute(Original.Contract, AK, 'add_device_with_k256', [plant, kAuth.pk, 0n, kAuth.sig, 0n])).after;
  const planted: Result = { section: 'devices', circuit: 'add_device_with_k256', case: 'the upstream residual: a k256 device plants an evm_eip712 entry at device_epoch + 1 (raw entry)', kind: 'positive' };
  const plantedOk = ledgerOf(AP).devices.member(plant) && ledgerOf(AP).device_count === 3n;
  planted.positive = { name: planted.case, verdict: plantedOk ? 'PASS' : 'FAIL', reason: plantedOk ? 'the planted entry is in the set (simulator)' : 'not planted', proofServer: [], startedAt: new Date().toISOString(), ms: 0 };
  tally(planted.positive); results.push(planted); line(planted);
  const wIn = evmEip712DescriptorInput(evmDeviceDescriptor(W));
  await positive('devices', 'remove_device: the planted entry evicted by descriptor at target epoch 1 (= device_epoch + 1)', posPath, AP, REMOVE,
    [wIn, ...solArgs(wIn), 1n, 0n, NONE, signAs(remTd(AP, wIn, 1n, 0n), counterOf(AP))]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Grants
// ═════════════════════════════════════════════════════════════════════════════

if (SECTIONS.includes('grants')) {
  section('grants');
  const ISSUE = 'issue_grant_with_evm_eip712', REVOKE = 'revoke_grant_with_evm_eip712', REVOKE_ALL = 'revoke_all_grants_with_evm_eip712';
  const GWU = 'withdraw_unshielded_with_grant_evm_eip712', GWS = 'withdraw_shielded_with_grant_evm_eip712';
  const READ_KEY = 'evm_eip712: a read key without read';
  const RP_ONLY = 'evm_eip712: an RP hash belongs to a spending passkey grant';
  const RP_ZERO_G = "evm_eip712: a spending passkey grant's RP hash is zero";
  const ANY_R = 'evm_eip712: a recipient for any recipient';
  const GINVALID = 'invalid grant signature';
  const UNKNOWN_GRANT = 'unknown grant';
  const COLOUR_G = 'held coin colour does not match the withdrawn colour';
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after;
  const frame = (a: LocalAccount) => ({ account: a.addressBytes, device: device.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const signAs = (t: Eip712TypedData, counter: bigint) => { const p = parseEvmSignature(wallet.signDigest(typedDataDigest(t))); return { pk: device.pk, use_counter: counter, blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const counterOf = (a: LocalAccount) => { for (let k = 0n; k < 64n; k++) if (ledgerOf(a).devices.member(device.entryAt(a.addressBytes, ledgerOf(a).device_epoch, k))) return k; throw new Error('device not live'); };
  const scopeOf = (o: Partial<IssueScope>): IssueScope => ({ opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
    color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null, ...o });
  const issueArgs = (a: LocalAccount, gin: any, sc: IssueScope, signed: IssueScope = sc, rawReadPk?: Uint8Array) => {
    const args = evmEip712IssueArgs(sc);
    if (rawReadPk) args[12] = rawReadPk;
    return [gin, ...solArgs(gin), ...args, signAs(evmEip712Messages.issueGrant(frame(a), gin, signed), counterOf(a))];
  };
  // grantees
  const label = grantLabel('bank.example');
  const gWallet = new SoftwareEvmWallet(0x6a17een);
  const eg = await EvmEip712Grantee.enrol(gWallet, 'undeployed', A0.addressBytes, label, 0n);
  const kg = K256Grantee.generate();
  const kOrigin = upstreamOriginHash('https://bank.example');
  const pass = softwarePasskey();
  const egIn = eg.descriptor();
  const kgIn = evmEip712GranteeInput({ scheme: 'k256', x: kg.pk.x, y: kg.pk.y, envelope: 0 }, { originHash: kOrigin }, 0n);
  const pgIn = evmEip712GranteeInput({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y }, { origin: pass.policy.origin }, 0n);
  const COL = fill(32, 0xc7), RCPT = fill(32, 0x7e);
  const unsh = scopeOf({ opWithdrawUnshielded: true, color: COL, cap: 450n, perCallCap: 300n, maxCoinValue: 300n, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT });
  const posPath = await loadPatched([INVALID, UNKNOWN, READ_KEY, RP_ONLY, GINVALID, UNKNOWN_GRANT, COLOUR_G]);

  // issue_grant positives: an evm_eip712, a k256 and a passkey grantee (with its RP)
  await positive('grants', 'issue_grant: an evm_eip712 grantee, unshielded scope (patched path)', posPath, A0, ISSUE, issueArgs(A0, egIn, unsh));
  await positive('grants', 'issue_grant: a k256 grantee (labelled origin hash), pinned caller', posPath, A0, ISSUE, issueArgs(A0, kgIn, { ...unsh, caller: fill(32, 0xca) }));
  const rd = fill(32, 0x9d);
  // The RP pin is checked by upstream only on the passkey spend path, so a
  // passkey grant carries its RP hash exactly when its scope can spend
  await positive('grants', 'issue_grant: a passkey grantee that can spend, with its RP hash', posPath, A0, ISSUE,
    issueArgs(A0, pgIn, { ...unsh, rpIdHash: pass.policy.rp_id_hash }));
  await positive('grants', 'issue_grant: a read-only passkey grantee, its RP hash zero ("not applicable")', posPath, A0, ISSUE,
    issueArgs(A0, pgIn, scopeOf({ read: true, readPk: rd })));
  // binding: a scope field, the caller pin, the grantee descriptor, the labelled origin hash
  const signedUnsh = issueArgs(A0, egIn, unsh);
  await negative('grants', 'issue_grant binding: cap signed 450, executed 451', A0, ISSUE, [egIn, ...solArgs(egIn), ...evmEip712IssueArgs({ ...unsh, cap: 451n }), signedUnsh.at(-1)], INVALID, [INVALID]);
  await negative('grants', 'issue_grant binding: a caller pin added after signing', A0, ISSUE, [egIn, ...solArgs(egIn), ...evmEip712IssueArgs({ ...unsh, caller: fill(32, 0xca) }), signedUnsh.at(-1)], INVALID, [INVALID]);
  await negative('grants', 'issue_grant binding: the grantee\'s site label changed after signing', A0, ISSUE, [{ ...egIn, label: grantLabel('evil.example') }, ...solArgs({ ...egIn, label: grantLabel('evil.example') }), ...evmEip712IssueArgs(unsh), signedUnsh.at(-1)], INVALID, [INVALID]);
  await negative('grants', 'issue_grant binding: the grantee slot changed after signing', A0, ISSUE, [{ ...egIn, slot: 1n }, ...solArgs({ ...egIn, slot: 1n }), ...evmEip712IssueArgs(unsh), signedUnsh.at(-1)], INVALID, [INVALID]);
  const signedK = issueArgs(A0, kgIn, unsh);
  await negative('grants', 'issue_grant binding: a k256 grantee\'s labelled origin hash changed after signing', A0, ISSUE,
    [{ ...kgIn, origin_hash: upstreamOriginHash('https://evil.example') }, ...solArgs({ ...kgIn, origin_hash: upstreamOriginHash('https://evil.example') }), ...evmEip712IssueArgs(unsh), signedK.at(-1)], INVALID, [INVALID]);
  const issueSoft = JSON.parse(JSON.stringify(evmEip712Messages.issueGrant(frame(A0), egIn, unsh))); issueSoft.message.effect = 'Lets this site read your balance';
  await negative('grants', 'issue_grant: the effect line changed in the signed message', A0, ISSUE, [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(unsh), signAs(issueSoft, counterOf(A0))], INVALID, [INVALID]);
  // the arm's issue rules under a VALID signature
  await negative('grants', 'issue_grant: a read key without read (signed with readKey zero, executed with a key)', A0, ISSUE,
    issueArgs(A0, egIn, unsh, unsh, fill(32, 0x11)), READ_KEY, [READ_KEY], '', { control: { a: A0, args: issueArgs(A0, egIn, unsh) } });
  // The client codec refuses these scopes; each approval below
  // is the codec's message for an admissible scope, patched to the executed
  // values and then signed, so it honestly covers what is executed and only the
  // circuit's own rule refuses. Each has a positive control: the admissible
  // call proved through the same patched copy.
  const signedPatched = (a: LocalAccount, gin: any, sc: IssueScope, patch: (m: any) => void) => {
    const t = JSON.parse(JSON.stringify(evmEip712Messages.issueGrant(frame(a), gin, sc))); patch(t.message); return signAs(t, counterOf(a));
  };
  const hx = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
  const unshCtl = { a: A0, args: issueArgs(A0, egIn, unsh) };
  const rpX = fill(32, 0x3f);
  await negative('grants', 'issue_grant: an RP hash for a non-passkey grantee, honestly signed', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs({ ...unsh, rpIdHash: rpX }), signedPatched(A0, egIn, unsh, (m) => { m.passkeyRpHash = hx(rpX); m.passkeyRp = EVM_EIP712_PASSKEY_RP_POINTER; })],
    RP_ONLY, [RP_ONLY], '', { control: unshCtl });
  const pScope = { ...unsh, rpIdHash: pass.policy.rp_id_hash }; // a spending passkey grant: its RP pin is checked
  const pCtl = { a: A0, args: issueArgs(A0, pgIn, pScope) };
  const pRead = scopeOf({ read: true, readPk: rd }); // a read-only passkey grant: zero
  await negative('grants', 'issue_grant: a read-only passkey grant with its RP hash, honestly signed', A0, ISSUE,
    [pgIn, ...solArgs(pgIn), ...evmEip712IssueArgs({ ...pRead, rpIdHash: pass.policy.rp_id_hash }),
     signedPatched(A0, pgIn, pRead, (m) => { m.passkeyRpHash = hx(pass.policy.rp_id_hash); m.passkeyRp = EVM_EIP712_PASSKEY_RP_POINTER; })],
    RP_ONLY, [RP_ONLY], '', { control: { a: A0, args: issueArgs(A0, pgIn, pRead) } });
  await negative('grants', "issue_grant: a spending passkey grant with a zero RP hash, honestly signed", A0, ISSUE,
    [pgIn, ...solArgs(pgIn), ...evmEip712IssueArgs({ ...pScope, rpIdHash: new Uint8Array(32) }),
     signedPatched(A0, pgIn, pScope, (m) => { m.passkeyRpHash = hx(new Uint8Array(32)); m.passkeyRp = NOT_APPLICABLE_TEXT; })],
    RP_ZERO_G, [RP_ZERO_G], '', { control: pCtl });
  const any0 = { ...unsh, recipientKind: 0n, recipient: new Uint8Array(32) };
  await negative('grants', 'issue_grant: "any recipient" with a recipient, honestly signed', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs({ ...any0, recipient: RCPT }), signedPatched(A0, egIn, any0, (m) => { m.recipient = hx(RCPT); })],
    ANY_R, [ANY_R], '', { control: { a: A0, args: issueArgs(A0, egIn, any0) } });
  // a forged exact word (the approval shows the other text than the one the circuit selects)
  const expScope = { ...unsh, expiresAt: 1893456000n };
  await negative('grants', 'issue_grant: the expiry word "never" signed for a non-zero expiresAt (forged word)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(expScope), signedPatched(A0, egIn, expScope, (m) => { m.expiry = NEVER_TEXT; })],
    INVALID, [INVALID], '', { control: { a: A0, args: issueArgs(A0, egIn, expScope) } });
  await negative('grants', 'issue_grant: the date of 0 signed for expiresAt 0 in place of "never" (forged text)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(unsh), signedPatched(A0, egIn, unsh, (m) => { m.expiry = '1970-01-01 00:00:00 UTC'; })],
    INVALID, [INVALID], '', { control: unshCtl });
  // the expiry's UTC date: another second, the words above the range, the date padded
  await negative('grants', 'issue_grant: the date one second later signed for expiresAt 1893456000 (forged text)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(expScope), signedPatched(A0, egIn, expScope, (m) => { m.expiry = '2030-01-01 00:00:01 UTC'; })],
    INVALID, [INVALID], '', { control: { a: A0, args: issueArgs(A0, egIn, expScope) } });
  await negative('grants', 'issue_grant: the words "after 9999-12-31 23:59:59 UTC" signed for an expiry in range (forged text)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(expScope), signedPatched(A0, egIn, expScope, (m) => { m.expiry = 'after 9999-12-31 23:59:59 UTC'; })],
    INVALID, [INVALID], '', { control: { a: A0, args: issueArgs(A0, egIn, expScope) } });
  await negative('grants', 'issue_grant: the expiry date space-padded to 29 bytes (the exact text is signed)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(expScope), signedPatched(A0, egIn, expScope, (m) => { m.expiry = '2030-01-01 00:00:00 UTC'.padEnd(29, ' '); })],
    INVALID, [INVALID], '', { control: { a: A0, args: issueArgs(A0, egIn, expScope) } });
  // the window word: the pointer signed for a zero window
  await negative('grants', 'issue_grant: the window pointer signed for a zero window in place of "no window" (forged word)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(unsh), signedPatched(A0, egIn, unsh, (m) => { m.window = EVM_EIP712_WINDOW_POINTER; })],
    INVALID, [INVALID], '', { control: unshCtl });
  await negative('grants', 'issue_grant: the passkeyRp word "not applicable" signed for a passkey grantee\'s RP hash (forged word)', A0, ISSUE,
    [pgIn, ...solArgs(pgIn), ...evmEip712IssueArgs(pScope), signedPatched(A0, pgIn, pScope, (m) => { m.passkeyRp = NOT_APPLICABLE_TEXT; })],
    INVALID, [INVALID], '', { control: pCtl });
  await negative('grants', 'issue_grant: the passkeyRp pointer signed for a non-passkey grant (forged word)', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(unsh), signedPatched(A0, egIn, unsh, (m) => { m.passkeyRp = EVM_EIP712_PASSKEY_RP_POINTER; })],
    INVALID, [INVALID], '', { control: unshCtl });
  // read on with no read key: the approval shows the zero key
  const READ_NO_KEY = 'evm_eip712: read without a read key';
  const rdScope = scopeOf({ read: true, readPk: rd });
  await negative('grants', 'issue_grant: read on with a zero read key, honestly signed', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(scopeOf({ read: true })), signedPatched(A0, egIn, rdScope, (m) => { m.readKey = hx(new Uint8Array(32)); })],
    READ_NO_KEY, [READ_NO_KEY], '', { control: { a: A0, args: issueArgs(A0, egIn, rdScope) } });
  // The grantee descriptor and label rules: each executed descriptor breaks
  // one rule, and its approval shows what the circuit shows for it (the
  // codec's message for the admissible descriptor, patched, then signed).
  const NOT_GRANT_TAG = 'evm_eip712: not a registered grant-id tag', W64_GRANT = 'descriptor: not a 64-byte grant-id tag';
  const NOT_LABEL = 'evm_eip712: not a site label', NOT_ORIGIN = 'evm_eip712: the passkey origin is not visible ASCII';
  const NOT_ENVELOPE = 'evm_eip712: not a k256 envelope', NOT_KIND = 'evm_eip712: not a recipient kind';
  const ascii = (b: Uint8Array) => String.fromCharCode(...b);
  const badLabel = new Uint8Array(32); badLabel.set(new TextEncoder().encode('bank  example'));
  const badLabelText = ascii(badLabel.map((c) => (c === 0 ? 32 : c)));
  const egBad = { ...egIn, label: badLabel };
  const badOrigin = new Uint8Array(pgIn.origin); badOrigin[10] = 0x20;
  const pgBad = { ...pgIn, origin: badOrigin };
  const kg1 = { ...kgIn, envelope: 1n }, kg2 = { ...kgIn, envelope: 2n };
  const unregistered = padTag('midnight:account:grant:zz:v9'), otherRecipe = padTag(DESCRIPTOR_TAGS.device.p256);
  const pReadCtl = { a: A0, args: issueArgs(A0, pgIn, pRead) };
  const tagCopy = await loadPatched([NOT_GRANT_TAG, W64_GRANT]);
  for (const [what, tag] of [['an unregistered grant-id tag', unregistered], ["another recipe's tag (the passkey device tag)", otherRecipe]] as const) {
    const pgTag = { ...pgIn, tag };
    await negative('grants', `issue_grant: ${what} on a passkey grantee's fields, valid signature (the 64-byte grant-id class assert refuses the same tag)`, A0, ISSUE,
      [pgTag, ...solArgs(pgTag), ...evmEip712IssueArgs(pRead), signAs(evmEip712Messages.issueGrant(frame(A0), pgIn, pRead), counterOf(A0))],
      NOT_GRANT_TAG, [NOT_GRANT_TAG, W64_GRANT], '', { module: tagCopy, control: pReadCtl });
  }
  await negative('grants', 'issue_grant: an evm_eip712 grantee whose site label has two spaces in a row, honestly signed', A0, ISSUE,
    [egBad, ...solArgs(egBad), ...evmEip712IssueArgs(unsh), signedPatched(A0, egIn, unsh, (m) => { m.grantee.siteLabel = badLabelText; })],
    NOT_LABEL, [NOT_LABEL], '', { control: unshCtl });
  await negative('grants', 'issue_grant: a passkey grantee whose origin holds a space, honestly signed', A0, ISSUE,
    [pgBad, ...solArgs(pgBad), ...evmEip712IssueArgs(pRead), signedPatched(A0, pgIn, pRead, (m) => { m.grantee.origin = ascii(badOrigin); })],
    NOT_ORIGIN, [NOT_ORIGIN], '', { control: pReadCtl });
  await negative('grants', 'issue_grant: a k256 grantee with envelope 2, shown with the envelope-1 label the circuit selects, honestly signed', A0, ISSUE,
    [kg2, ...solArgs(kg2), ...evmEip712IssueArgs(unsh), signAs(evmEip712Messages.issueGrant(frame(A0), kg1, unsh), counterOf(A0))],
    NOT_ENVELOPE, [NOT_ENVELOPE], '', { control: { a: A0, args: issueArgs(A0, kgIn, unsh) } });
  await negative('grants', 'issue_grant: recipient kind 4, shown with the kind-3 label the circuit selects, honestly signed', A0, ISSUE,
    [egIn, ...solArgs(egIn), ...evmEip712IssueArgs({ ...unsh, recipientKind: 4n }), signAs(evmEip712Messages.issueGrant(frame(A0), egIn, { ...unsh, recipientKind: 3n }), counterOf(A0))],
    NOT_KIND, [NOT_KIND], '', { control: unshCtl });
  // revoke_grant / revoke_all over an account holding the evm grant
  const AG = (await execute(Original.Contract, A0, ISSUE, issueArgs(A0, egIn, unsh))).after;
  await positive('grants', 'revoke_grant: the evm_eip712 grantee by descriptor', posPath, AG, REVOKE, [egIn, ...solArgs(egIn), signAs(evmEip712Messages.revokeGrant(frame(AG), egIn), counterOf(AG))]);
  // revoke_grant reaches the same descriptor rules. Each refused descriptor
  // names a grant that a k256 device of the account planted (upstream's
  // issue_grant_with_k256 takes the grant id raw), so the grant exists and
  // only the descriptor rule refuses; positive control: the evm_eip712
  // grantee revoked through the same copy.
  const kIssuer = new K256Device(0x5eed2n);
  const kIssuerIn = evmEip712DescriptorInput({ scheme: 'k256', x: kIssuer.pk.x, y: kIssuer.pk.y, envelope: 0 });
  let AKP = (await execute(Original.Contract, AG, 'add_device_with_evm_eip712', [kIssuerIn, ...solArgs(kIssuerIn), signAs(evmEip712Messages.addDevice(frame(AG), kIssuerIn), counterOf(AG))])).after;
  const plantScope: PlainScope = { opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: true,
    color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPkHash: fill(32, 0x1d), windowLen: 0n, windowCap: 0n, caller: undefined };
  const plantSalt = fill(32, 0x5c);
  let kCounter = 0n;
  const plantFor = async (gin: any, mod: BypassedContractModule) => {
    const self = { bytes: AKP.addressBytes };
    const oh = mod.pureCircuits.evm_eip712_grantee_origin_hash(gin);
    const si = mod.pureCircuits.evm_eip712_sol_grantee_target(self, gin, oh, ...solArgs(gin))[1];
    const gid = mod.pureCircuits.evm_eip712_grantee_grant_id(self, gin, oh, si);
    const k = kIssuer.sign(k256Challenges.issueGrant({ contractAddress: AKP.addressBytes, authNonce: ledgerOf(AKP).auth_nonce }, kIssuer.pk, gid, scopeDigest(plantSalt, plantScope)), kCounter);
    AKP = (await execute(Original.Contract, AKP, 'issue_grant_with_k256', [gid, ...scopeArgs(plantScope), plantSalt, k.pk, kCounter, k.sig, 0n])).after;
    kCounter++;
    if (!ledgerOf(AKP).grants.member(gid)) throw new Error('setup: the planted grant is not in the map');
  };
  const pgUnreg = { ...pgIn, tag: unregistered };
  await plantFor(pgUnreg, tagCopy);
  await plantFor(egBad, posPath);
  await plantFor(pgBad, posPath);
  await plantFor(kg2, posPath);
  const revokeSigned = (gin: any, patch?: (m: any) => void) => {
    const t = JSON.parse(JSON.stringify(evmEip712Messages.revokeGrant(frame(AKP), gin))); patch?.(t.message); return signAs(t, counterOf(AKP));
  };
  const revokeCtl = { a: AKP, args: [egIn, ...solArgs(egIn), revokeSigned(egIn)] };
  await negative('grants', "revoke_grant: a planted grant named with an unregistered grant-id tag on a passkey grantee's fields, valid signature (the 64-byte grant-id class assert refuses the same tag)", AKP, REVOKE,
    [pgUnreg, ...solArgs(pgUnreg), revokeSigned(pgIn)], NOT_GRANT_TAG, [NOT_GRANT_TAG, W64_GRANT], '', { module: tagCopy, control: revokeCtl });
  await negative('grants', 'revoke_grant: a planted grant named by an evm_eip712 grantee whose site label has two spaces in a row, honestly signed', AKP, REVOKE,
    [egBad, ...solArgs(egBad), revokeSigned(egIn, (m) => { m.grantee.siteLabel = badLabelText; })], NOT_LABEL, [NOT_LABEL], '', { control: revokeCtl });
  await negative('grants', 'revoke_grant: a planted grant named by a passkey grantee whose origin holds a space, honestly signed', AKP, REVOKE,
    [pgBad, ...solArgs(pgBad), revokeSigned(pgIn, (m) => { m.grantee.origin = ascii(badOrigin); })], NOT_ORIGIN, [NOT_ORIGIN], '', { control: revokeCtl });
  await negative('grants', 'revoke_grant: a planted grant named by a k256 grantee with envelope 2, shown with the envelope-1 label, honestly signed', AKP, REVOKE,
    [kg2, ...solArgs(kg2), revokeSigned(kg1)], NOT_ENVELOPE, [NOT_ENVELOPE], '', { control: revokeCtl });
  // a second live grant (slot 1): the signed slot 0, the executed slot 1
  const eg1In = { ...egIn, slot: 1n };
  const AG2 = (await execute(Original.Contract, AG, ISSUE, issueArgs(AG, eg1In, unsh))).after;
  await negative('grants', 'revoke_grant binding: signed for slot 0, executed for the live slot-1 grant', AG2, REVOKE,
    [eg1In, ...solArgs(eg1In), signAs(evmEip712Messages.revokeGrant(frame(AG2), egIn), counterOf(AG2))], INVALID, [INVALID]);
  await positive('grants', 'revoke_all_grants', posPath, AG, REVOKE_ALL, [signAs(evmEip712Messages.revokeAllGrants(frame(AG)), counterOf(AG))]);
  await negative('grants', 'revoke_all_grants replay/operation: a CancelRecovery signature (same bare frame)', AG, REVOKE_ALL,
    [signAs(evmEip712Messages.cancelRecovery(frame(AG)), counterOf(AG))], INVALID, [INVALID]);

  // the grantee twins
  const AU = (await execute(Original.Contract, AG, 'deposit_unshielded', [COL, 1000n])).after;
  const rec = (a: LocalAccount) => ledgerOf(a).grants.lookup(eg.grantId(a.addressBytes));
  const gframe = (a: LocalAccount, nonce?: bigint) => ({ account: a.addressBytes, grantee: eg.address, label, slot: 0n, issuedAt: rec(a).issued_at, grantNonce: nonce ?? rec(a).nonce });
  const opening: GrantOpening = { originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AG, eg.grantId(AG.addressBytes)), recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: RCPT, maxCoinValue: 300n, spentPrev: 0n };
  const gSign = (t: Eip712TypedData, w = gWallet, pk = eg.pk) => { const p = parseEvmSignature(w.signDigest(typedDataDigest(t))); return { arm: 'evm_eip712' as const, pk, blind: eg.blind, label, sig: { r: p.r, s: p.s } }; };
  const tdU = (a: LocalAccount, amt: bigint, nonce?: bigint) => evmEip712Messages.withdrawUnshieldedAsGrantee(gframe(a, nonce), COL, amt, RCPT, TEST_SITE);
  const twinArgs = (amt: bigint, auth: any, o: GrantOpening = opening) => [COL, amt, { bytes: RCPT }, ...grantAuthArgs(o, auth)];
  await positive('grants', 'withdraw_unshielded_with_grant: 200 by the evm_eip712 grantee (patched path)', posPath, AU, GWU, twinArgs(200n, gSign(tdU(AU, 200n))));
  // auth_nonce and every device entry untouched (simulator state check)
  const AU1 = (await execute(Original.Contract, AU, GWU, twinArgs(200n, gSign(tdU(AU, 200n))))).after;
  const untouched: Result = { section: 'grants', circuit: GWU, case: 'the grant call advanced only its record (nonce +1), never auth_nonce or a device entry', kind: 'positive' };
  const okU = ledgerOf(AU1).auth_nonce === ledgerOf(AU).auth_nonce && rec(AU1).nonce === rec(AU).nonce + 1n
    && [...ledgerOf(AU1).devices].map((d: Uint8Array) => Buffer.from(d).toString('hex')).sort().join() === [...ledgerOf(AU).devices].map((d: Uint8Array) => Buffer.from(d).toString('hex')).sort().join();
  untouched.positive = { name: untouched.case, verdict: okU ? 'PASS' : 'FAIL', reason: okU ? 'state checked' : 'auth_nonce or a device entry changed', proofServer: [], startedAt: new Date().toISOString(), ms: 0 };
  tally(untouched.positive); results.push(untouched); line(untouched);
  await negative('grants', 'grantee binding: amount signed 200, executed 201', AU, GWU, twinArgs(201n, gSign(tdU(AU, 200n))), GINVALID, [GINVALID]);
  await negative('grants', 'grantee replay: the approval of the first call after the record nonce advanced', AU1, GWU, twinArgs(200n, gSign(tdU(AU, 200n)), { ...opening, spentPrev: 200n }), GINVALID, [GINVALID]);
  await runtimeOnly('grants', 'grantee: another blind (a grant id with no record)', AU, GWU, twinArgs(200n, { ...gSign(tdU(AU, 200n)), blind: fill(32, 0x13) }), UNKNOWN_GRANT,
    "the blind is a ledger-pinned opening (not in the signed frame): another blind names a grant id with no record; with the membership assert bypassed the generated JavaScript's map lookup throws ('expected a cell'), which is not an assert; in-circuit the membership assert refuses it");
  await negative('grants', 'grantee replay/role: a device-role WithdrawUnshielded signature by the grantee key', AU, GWU,
    twinArgs(200n, gSign(evmEip712Messages.withdrawUnshielded({ account: AU.addressBytes, device: eg.address, authNonce: ledgerOf(AU).auth_nonce }, COL, 200n, RCPT, TEST_SITE))), GINVALID, [GINVALID]);
  // the grant seam's forged address: the attacker presents its own
  // point with the victim grantee's blind and label; the copy derives the
  // victim's address from it
  const forging = await loadPatched([], FORGE_ADDRESS_OVERRIDES);
  const attacker = new SoftwareEvmWallet(0xbad6n);
  forgery.set({ pk: attacker.pk, address: eg.address });
  await negative('grants', 'grant seam: the attacker\'s key with the grantee\'s address forged into the derivation', AU, GWU,
    twinArgs(200n, gSign(tdU(AU, 200n), attacker, attacker.pk)), UNKNOWN_GRANT, [], '',
    { module: forging, mutant: 'forged-address mutant (keccak256 override) on the grant seam', check: () => (forgery.fired > 0 ? undefined : 'the forgery never fired'),
      control: { a: AU, args: twinArgs(200n, gSign(tdU(AU, 200n))) } });
  forgery.set(undefined);
  // the shielded grantee twin on a local Zswap tree: a valid approval over
  // coin H, the witness answering another coin
  const shScope = scopeOf({ opWithdrawShielded: true, read: true, readPk: fill(32, 0x77), color: COL_A, cap: 2000n, perCallCap: 1000n, maxCoinValue: 1000n });
  const AS0 = (await execute(Original.Contract, A0, ISSUE, issueArgs(A0, egIn, shScope))).after;
  const shOpening: GrantOpening = { originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AS0, eg.grantId(AS0.addressBytes)), recipientKind: 0n, pinnedRecipient: new Uint8Array(32), maxCoinValue: 1000n, spentPrev: 0n };
  const shAccount = (coins: { nonce: Uint8Array; color: Uint8Array; value: bigint }[], pick: number) => {
    const { account, coins: placed } = withLocalCoins(AS0, coins);
    return { a: { ...account, privateState: coinStoreAnswering([{ key: COL_A, coin: placed[pick] }]) } as LocalAccount, coin: placed[pick] };
  };
  const tree = [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }];
  const H = shAccount(tree, 1);
  const change = fill(192, 0x2c);
  const enc = ledgerOf(AS0).enc_key;
  const rS = (ledgerOf(AS0).grants.lookup(eg.grantId(AS0.addressBytes)));
  const tdS = evmEip712Messages.withdrawShieldedAsGrantee({ account: AS0.addressBytes, grantee: eg.address, label, slot: 0n, issuedAt: rS.issued_at, grantNonce: rS.nonce },
    COL_A, 300n, localCoinPublicKeyBytes(), change, enc, { nonce: NONCE_H, value: 1000n, mtIndex: H.coin.mtIndex }, TEST_SITE);
  const sArgs = (auth: any) => [{ bytes: localCoinPublicKeyBytes() }, COL_A, 300n, change, enc, ...grantAuthArgs(shOpening, auth)];
  await positive('grants', 'withdraw_shielded_with_grant: 300 of a 1000 coin (change appended, patched path)', posPath, H.a, GWS, sArgs(gSign(tdS)));
  // the colour: upstream's scope check binds the SPENT coin's colour to the
  // grant's object commitment, so the colour assert is isolated with a grant
  // whose scope colour is B: the grantee's valid approval names colour A, the
  // witness coin is B (admitted by the scope); only coin.color == color refuses
  const shScopeB = { ...shScope, color: COL_B };
  const ASB = (await execute(Original.Contract, A0, ISSUE, issueArgs(A0, egIn, shScopeB))).after;
  const { account: treeB, coins: placedB } = withLocalCoins(ASB, [tree[0], { nonce: NONCE_H, color: COL_B, value: 1000n }]);
  const colourB = { ...treeB, privateState: coinStoreAnswering([{ key: COL_A, coin: placedB[1] }]) } as LocalAccount;
  const rB = ledgerOf(ASB).grants.lookup(eg.grantId(ASB.addressBytes));
  const tdSB = evmEip712Messages.withdrawShieldedAsGrantee({ account: ASB.addressBytes, grantee: eg.address, label, slot: 0n, issuedAt: rB.issued_at, grantNonce: rB.nonce },
    COL_A, 300n, localCoinPublicKeyBytes(), change, enc, { nonce: NONCE_H, value: 1000n, mtIndex: placedB[1].mtIndex }, TEST_SITE);
  const shCtl = { a: H.a, args: sArgs(gSign(tdS)) };
  await negative('grants', 'grantee shielded: valid approval for colour A, witness coin of colour B (a grant scoped to B)', colourB, GWS, sArgs(gSign(tdSB)), COLOUR_G, [COLOUR_G], '', { control: shCtl });
  const value999 = shAccount([tree[0], { nonce: NONCE_H, color: COL_A, value: 999n }], 1);
  await negative('grants', 'grantee shielded: valid approval for coin value 1000, witness coin of value 999', value999.a, GWS, sArgs(gSign(tdS)), GINVALID, [GINVALID], '', { control: shCtl });
}

// ═════════════════════════════════════════════════════════════════════════════
// The grant matrix at the constraint level, all three grantee twins
// ═════════════════════════════════════════════════════════════════════════════
//
// Every case is a VALID grantee approval (or a valid approval over values the
// call then changes), executed with the named asserts bypassed and proved; a
// positive control (the honest call of the same twin on its base account) is
// proved through the same patched copy first. The twins: U =
// withdraw_unshielded_with_grant, S = withdraw_shielded_with_grant, C =
// withdraw_shielded_to_contract_with_grant (the shielded twins on a local
// Zswap tree, so the Zswap half of every spend is valid).
if (SECTIONS.includes('grant-matrix')) {
  section('grant-matrix');
  const ISSUE = 'issue_grant_with_evm_eip712', REVOKE = 'revoke_grant_with_evm_eip712', REVOKE_ALL = 'revoke_all_grants_with_evm_eip712';
  const GWU = 'withdraw_unshielded_with_grant_evm_eip712', GWS = 'withdraw_shielded_with_grant_evm_eip712', GWSC = 'withdraw_shielded_to_contract_with_grant_evm_eip712';
  const GINVALID = 'invalid grant signature', COLOUR_G = 'held coin colour does not match the withdrawn colour';
  const PER_CALL = 'amount above per-call cap', CUMULATIVE = 'cumulative cap exceeded', PIN = 'recipient not admitted by pin';
  const NO_CALLER = 'grant requires a contract caller', CALLER_MISMATCH = 'grant caller mismatch';
  const MAX_COIN = 'coin above max_coin_value', STALE_ENC = 'stale encryption key';
  const REVOKED = 'grant revoked', EXPIRED = 'grant expired', EPOCH = 'grant epoch stale', GEN = 'grant generation stale';
  const OP = 'operation not in scope';
  const OBJECT = 'scope object mismatch', SPENT = 'spent opening mismatch';
  const AMOUNT_COIN = "amount above the spent coin's value";
  const birthG = 0xb1a7c0den;
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryKey(birthG).pk, 0n), ACTIVATE, device.activationArgs(salt))).after;
  const frame = (a: LocalAccount) => ({ account: a.addressBytes, device: device.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const counterOf = (a: LocalAccount) => { for (let k = 0n; k < 64n; k++) if (ledgerOf(a).devices.member(device.entryAt(a.addressBytes, ledgerOf(a).device_epoch, k))) return k; throw new Error('device not live'); };
  const signAs = (t: Eip712TypedData, a: LocalAccount) => { const p = parseEvmSignature(wallet.signDigest(typedDataDigest(t))); return { pk: device.pk, use_counter: counterOf(a), blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const scopeOf = (o: Partial<IssueScope>): IssueScope => ({ opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
    color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null, ...o });
  const sSalt = fill(32, 0x5b);
  const issue = async (a: LocalAccount, gin: any, sc: IssueScope) =>
    (await execute(Original.Contract, a, ISSUE, [gin, ...solArgs(gin), ...evmEip712IssueArgs(sc), signAs(evmEip712Messages.issueGrant(frame(a), gin, sc), a)])).after;
  const label = grantLabel('bank.example');
  const gWallet = new SoftwareEvmWallet(0x6a17een);
  const G = await Promise.all([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n].map((slot) => EvmEip712Grantee.enrol(gWallet, 'undeployed', A0.addressBytes, label, slot)));
  const CALLER_C = fill(32, 0xca), CALLER_W = fill(32, 0xcb);
  const COLG = fill(32, 0xc7), RCPT = fill(32, 0x7e), RCPT2 = fill(32, 0x7f), KEY2 = fill(32, 0x4b), CONTRACT2 = fill(32, 0x3d);
  const NONCE_H2 = fill(32, 0x13);
  const change = fill(192, 0x2c), change2 = fill(192, 0x2d), staleKey = fill(32, 0x5e);
  const callerCopyPlain = await loadPatched([], CALLER_OVERRIDES);
  const pinnedCaller = () => callerInjection.set(CALLER_C), wrongCaller = () => callerInjection.set(CALLER_W), noCaller = () => callerInjection.set(undefined);

  type T = 'U' | 'S' | 'C';
  const CIRCUIT: Record<T, string> = { U: GWU, S: GWS, C: GWSC };
  const tags: Record<T, string> = { U: 'withdraw_unshielded_with_grant', S: 'withdraw_shielded_with_grant', C: 'withdraw_shielded_to_contract_with_grant' };
  // per twin: the main scope (slot 0), the caller-pinned (2) and expired (3)
  // variants, and for the shielded twins a small max coin value (1) and a
  // grant scoped to colour B (4)
  const mainScope = (t: T): IssueScope => t === 'U'
    ? scopeOf({ opWithdrawUnshielded: true, color: COLG, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 300n, perCallCap: 300n, cap: 450n })
    : scopeOf({ ...(t === 'S' ? { opWithdrawShielded: true, recipientKind: 2n, recipient: localCoinPublicKeyBytes() } : { opWithdrawShieldedToContract: true, recipientKind: 3n, recipient: RECIPIENT_CONTRACT }),
        read: true, readPk: fill(32, 0x77), color: COL_A, maxCoinValue: 1000n, perCallCap: 500n, cap: 900n });
  const scopes = (t: T): IssueScope[] => {
    const m = mainScope(t);
    // slot 5 (the user-recipient twin only): pinned to another coin key; the
    // local builder can only build an output to its own key, so the pin
    // case executes to that key under a pin naming another
    // slot 6: the same object fields as the main
    // scope, admitting another operation only, so that only the grant seam's
    // operation check refuses this twin's call
    const other: IssueScope = t === 'U' ? { ...m, opWithdrawUnshielded: false, opWithdrawShielded: true, read: true, readPk: fill(32, 0x77) }
      : t === 'S' ? { ...m, opWithdrawShielded: false, opWithdrawUnshielded: true } : { ...m, opWithdrawShieldedToContract: false, opWithdrawShielded: true };
    // slot 7: pinned to the zero contract address, the value the
    // circuit reads as caller.value.left when the caller is absent or a user,
    // so that only the presence/type assert can refuse those calls
    return [m, { ...m, maxCoinValue: 600n }, { ...m, caller: CALLER_C }, { ...m, expiresAt: 1n }, { ...m, color: COL_B }, { ...m, recipient: KEY2 }, other, { ...m, caller: new Uint8Array(32) }];
  };
  const opening = (t: T, a: LocalAccount, slot: bigint, spentPrev = 0n): GrantOpening => {
    const sc = scopes(t)[Number(slot)];
    return { originHash: G[0].originHash, slot, scopeSalt: grantSaltOf(a, G[Number(slot)].grantId(a.addressBytes)), recipientKind: sc.recipientKind, pinnedRecipient: sc.recipient, maxCoinValue: sc.maxCoinValue, spentPrev };
  };
  const gframe = (a: LocalAccount, g: EvmEip712Grantee) => {
    const r = ledgerOf(a).grants.lookup(g.grantId(a.addressBytes));
    return { account: a.addressBytes, grantee: g.address, label, slot: g.slot, issuedAt: r.issued_at as bigint, grantNonce: r.nonce as bigint };
  };
  interface P { slot?: bigint; amount: bigint; recipient?: Uint8Array; coin?: LocalCoin; change?: Uint8Array; encPk?: Uint8Array; spentPrev?: bigint;
    /** opening members that differ from the record's (the opening is not signed) */
    opening?: Partial<GrantOpening>;
    signed?: { amount?: bigint; recipient?: Uint8Array; coin?: { nonce: Uint8Array; value: bigint; mtIndex: bigint }; change?: Uint8Array; encPk?: Uint8Array } }
  /** The twin's arguments with the grantee's approval over the SIGNED values
   *  (default: the executed ones). */
  const call = (t: T, a: LocalAccount, p: P) => {
    const g = G[Number(p.slot ?? 0n)];
    const sc = scopes(t)[Number(p.slot ?? 0n)];
    const rcpt = p.recipient ?? sc.recipient;
    const s = { amount: p.amount, recipient: rcpt, coin: p.coin && { nonce: p.coin.nonce, value: p.coin.value, mtIndex: p.coin.mtIndex }, change: p.change ?? change, encPk: p.encPk ?? ledgerOf(a).enc_key, ...p.signed };
    const td = t === 'U'
      ? evmEip712Messages.withdrawUnshieldedAsGrantee(gframe(a, g), COLG, s.amount, s.recipient, TEST_SITE)
      : t === 'S'
        ? evmEip712Messages.withdrawShieldedAsGrantee(gframe(a, g), COL_A, s.amount, s.recipient, s.change, s.encPk, s.coin!, TEST_SITE)
        : evmEip712Messages.withdrawShieldedToContractAsGrantee(gframe(a, g), COL_A, s.amount, s.recipient, s.change, s.encPk, s.coin!, TEST_SITE);
    const q = parseEvmSignature(gWallet.signDigest(typedDataDigest(td)));
    const auth: any = { arm: 'evm_eip712' as const, pk: g.pk, blind: g.blind, label, sig: { r: q.r, s: q.s } }; // hints: evm-eip712-hint-fill.ts
    const o = { ...opening(t, a, g.slot, p.spentPrev ?? 0n), ...p.opening };
    return t === 'U'
      ? [COLG, p.amount, { bytes: rcpt }, ...grantAuthArgs(o, auth)]
      : [{ bytes: rcpt }, COL_A, p.amount, p.change ?? change, p.encPk ?? ledgerOf(a).enc_key, ...grantAuthArgs(o, auth)];
  };
  // the recovery gate, then the finalisation: device_epoch + 1, grants kept
  const finalised = async (a: LocalAccount) => {
    const l = ledgerOf(a);
    const Q = JubjubDevice.generate();
    const nowUpper = now() + 2n;
    const sub = signRecoverSubmit(recoveryKey(birthG), Q,
      recoverSubmitChallenge({ contractAddress: a.addressBytes, authNonce: l.auth_nonce }, l.recovery_pk, Q.pk, recoveryKey(0x9a1n).pk as any, l.device_epoch + 1n, nowUpper),
      { successorRecoveryPk: recoveryKey(0x9a1n).pk as any, expectedEpoch: l.device_epoch, expectedNonce: l.auth_nonce, nowUpper });
    const p = (await execute(Original.Contract, a, 'recover_submit', recoverSubmitArgs(sub))).after;
    await new Promise((r) => setTimeout(r, 3500));
    return (await execute(Original.Contract, p, 'recover_finalise', [])).after;
  };

  // (EVM_EIP712_GRANT_TWINS=U,S,C: a subset of the twins, for a partial re-run)
  const twins = (process.env.EVM_EIP712_GRANT_TWINS ?? 'U,S,C').split(',') as T[];
  for (const t of twins) {
    const circuit = CIRCUIT[t], tag = tags[t];
    // the account: every grant of this twin issued, funded
    let AT = A0;
    const used: Record<T, number[]> = { U: [0, 2, 3, 6, 7], S: [0, 1, 2, 3, 5, 6, 7], C: [0, 1, 2, 3, 4, 6, 7] };
    for (const [i, sc] of scopes(t).entries()) if (used[t].includes(i)) AT = await issue(AT, G[i].descriptor(), sc);
    let H1: LocalCoin | undefined, H2: LocalCoin | undefined;
    let bare: LocalAccount = AT; // the account before its coins were placed (substitution trees start from it)
    const answering = (a: LocalAccount, coin: LocalCoin) => ({ ...a, privateState: coinStoreAnswering([{ key: COL_A, coin }]) }) as LocalAccount;
    if (t === 'U') AT = (await execute(Original.Contract, AT, 'deposit_unshielded', [COLG, 1000n])).after;
    else {
      bare = AT;
      const placed = withLocalCoins(AT, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }, { nonce: NONCE_H2, color: COL_A, value: 1000n }]);
      [, H1, H2] = placed.coins;
      AT = answering(placed.account, H1);
    }
    const honest: P = t === 'U' ? { amount: 200n } : { amount: 300n, coin: H1 };
    const base = { a: AT, args: call(t, AT, honest) };
    const posPath = await loadPatched([GINVALID]);
    await positive('grant-matrix', `${tag}: the honest call on the base account (patched path)`, posPath, AT, circuit, base.args);
    const neg = (name: string, a: LocalAccount, args: unknown[], expect: string, bypass: string[], opts: Parameters<typeof negative>[8] = {}) =>
      negative('grant-matrix', `${tag}: ${name}`, a, circuit, args, expect, bypass, '', { control: base, ...opts });

    // ── valid-signature scope violations ──
    await neg('over the per-call cap, honestly signed', AT, call(t, AT, { ...honest, amount: t === 'U' ? 301n : 501n }), PER_CALL, [PER_CALL]);
    await neg('a grant scoped to another operation only (same object fields), valid approval', AT, call(t, AT, { ...honest, slot: 6n }), OP, [OP]);
    {
      const first: P = t === 'U' ? { amount: 200n } : { amount: 500n, coin: H1 };
      const A1 = (await execute(Original.Contract, AT, circuit, call(t, AT, first))).after;
      const A1n = t === 'U' ? A1 : answering(A1, H2!);
      const second: P = t === 'U' ? { amount: 260n, spentPrev: 200n } : { amount: 450n, coin: H2, spentPrev: 500n };
      await neg(`over the cumulative cap (${t === 'U' ? '200 + 260 > 450' : '500 + 450 > 900'}), honestly signed with the live spent opening`, A1n, call(t, A1n, second), CUMULATIVE, [CUMULATIVE]);
    }
    if (t !== 'U') {
      await neg('a coin above the grant\'s max coin value (1000 > 600), honestly signed', AT, call(t, AT, { ...honest, slot: 1n }), MAX_COIN, [MAX_COIN]);
    } else {
      const r: Result = { section: 'grant-matrix', circuit, case: `${tag}: max coin value`, kind: 'positive' };
      (r as any).notApplicable = 'the unshielded twin spends from the mirror, not a coin: max_coin_value enters only the object commitment (a changed opening is "scope object mismatch"); the coin bound (MIP R7) is the shielded twins\' check_shielded_grant_bounds';
      results.push(r);
    }
    // the openings: the object commitment and the spent commitment, each
    // opened wrong under a valid approval (neither opening is signed). The
    // max coin value enters only the object commitment (a larger one still
    // bounds the coin), and a claimed spend of 100 keeps the cumulative cap
    await neg(`a wrong object opening (max coin value ${t === 'U' ? '301, the record 300' : '1001, the record 1000'}), valid approval`, AT,
      call(t, AT, { ...honest, opening: { maxCoinValue: t === 'U' ? 301n : 1001n } }), OBJECT, [OBJECT]);
    await neg('a wrong spent opening (100 claimed, the record holds 0), valid approval', AT, call(t, AT, { ...honest, spentPrev: 100n }), SPENT, [SPENT]);
    await neg('a recipient other than the pinned one, honestly signed', AT,
      call(t, AT, t === 'S' ? { ...honest, slot: 5n, recipient: localCoinPublicKeyBytes() } : { ...honest, recipient: t === 'U' ? RCPT2 : CONTRACT2 }), PIN, [PIN]);
    // the caller pin: no caller (a root call), then a wrong contract caller;
    // the control is the pinned contract presenting itself
    {
      const callerCopy = await loadPatched([NO_CALLER, CALLER_MISMATCH], CALLER_OVERRIDES);
      const pinnedArgs = call(t, AT, { ...honest, slot: 2n });
      await neg('caller-pinned grant, no contract caller (a root call)', AT, pinnedArgs, NO_CALLER, [NO_CALLER, CALLER_MISMATCH],
        { module: callerCopy, mutant: 'caller injected into the local call context (CALLER_OVERRIDES): none', control: { a: AT, args: pinnedArgs },
          hooks: { simulator: noCaller, control: pinnedCaller, attempt: noCaller } });
      const mismatchCopy = await loadPatched([CALLER_MISMATCH], CALLER_OVERRIDES);
      await neg('caller-pinned grant, called by another contract', AT, pinnedArgs, CALLER_MISMATCH, [CALLER_MISMATCH],
        { module: mismatchCopy, simulatorModule: callerCopyPlain, mutant: 'caller injected into the local call context (CALLER_OVERRIDES): another contract', control: { a: AT, args: pinnedArgs },
          hooks: { simulator: wrongCaller, control: pinnedCaller, attempt: wrongCaller } });
      // the presence/type asserts apart from the commitment: a
      // grant pinned to the zero contract address matches the commitment the
      // circuit computes from the default caller.value.left, so only "grant
      // requires a contract caller" can refuse; the control is the zero
      // contract presenting itself on the same copy. Upstream's
      // `caller.is_some` and `caller.value.is_left` asserts share that one
      // message, and the copy bypasses by message, so both are bypassed in
      // both cases. An absent caller is the default Maybe, whose value is not
      // left, so it fails both (the record shows count 2): no caller the ledger
      // produces isolates the presence assert. A user caller is present and
      // not left, so it fails the type assert alone (count 1).
      const zeroCaller = () => callerInjection.set(new Uint8Array(32)), userCaller = () => callerInjection.setUser(fill(32, 0x75));
      const presenceCopy = await loadPatched([NO_CALLER], CALLER_OVERRIDES);
      const zeroArgs = call(t, AT, { ...honest, slot: 7n });
      await neg('pinned to the zero contract address, no caller (a root call): the presence and type asserts (one message), the commitment matching', AT, zeroArgs, NO_CALLER, [NO_CALLER],
        { module: presenceCopy, simulatorModule: callerCopyPlain, mutant: 'caller injected into the local call context (CALLER_OVERRIDES): none', control: { a: AT, args: zeroArgs },
          hooks: { simulator: noCaller, control: zeroCaller, attempt: noCaller } });
      await neg('pinned to the zero contract address, a user caller: the type assert alone fires (one message with presence), the commitment matching', AT, zeroArgs, NO_CALLER, [NO_CALLER],
        { module: presenceCopy, simulatorModule: callerCopyPlain, mutant: 'caller injected into the local call context (CALLER_OVERRIDES): a user', control: { a: AT, args: zeroArgs },
          hooks: { simulator: userCaller, control: zeroCaller, attempt: userCaller } });
      noCaller();
    }

    // ── the record's liveness (the grant seam's four asserts) ──
    const AR = (await execute(Original.Contract, AT, REVOKE, [G[0].descriptor(), ...solArgs(G[0].descriptor()), signAs(evmEip712Messages.revokeGrant(frame(AT), G[0].descriptor()), AT)])).after;
    await neg('a revoked grant (tombstone), valid approval over its record', AR, call(t, AR, honest), REVOKED, [REVOKED]);
    await neg('an expired grant (expires_at 1), valid approval', AT, call(t, AT, { ...honest, slot: 3n }), EXPIRED, [EXPIRED]);
    const AE = await finalised(AT);
    if (ledgerOf(AE).device_epoch !== 1n || !ledgerOf(AE).grants.member(G[0].grantId(AE.addressBytes))) throw new Error('setup: the finalisation did not bump the epoch with the grant kept');
    await neg('a grant of a stale device epoch (after a recovery finalisation), valid approval', AE, call(t, AE, honest), EPOCH, [EPOCH]);
    const AX = (await execute(Original.Contract, AT, REVOKE_ALL, [signAs(evmEip712Messages.revokeAllGrants(frame(AT)), AT)])).after;
    const AGN = withLedgerCell(AT, AX, [1, 3]);
    if (ledgerOf(AGN).grant_generation !== 1n || !ledgerOf(AGN).grants.member(G[0].grantId(AGN.addressBytes))) throw new Error('setup: the stale-generation state is not as built');
    // "grant generation stale" is unreachable in this contract: revoke_all_grants
    // bumps the generation AND clears the map (do_revoke_all_grants), and no
    // chip writes a record of another generation; the assert is defence in
    // depth for a ledger that would keep records. The state is built by
    // copying the generation cell of the post-revoke_all ledger into the
    // pre-revoke_all one, so the constraint is exercised as on such a ledger.
    await neg('a grant of a stale generation (UNREACHABLE today: revoke_all clears the map; the state built by copying the generation cell), valid approval', AGN, call(t, AGN, honest), GEN, [GEN]);

    // ── the grantee frame's site label ──
    // A grant for the grantee's key and blind under a site label with two
    // spaces, planted raw by a k256 device of the account (upstream's
    // issue_grant_with_k256 takes the grant id) with this twin's main scope;
    // the grantee's approval shows that label in its frame (the codec refuses
    // it, so its message is patched and then signed)
    {
      const NOT_LABEL = 'evm_eip712: not a site label';
      const badLabel = new Uint8Array(32); badLabel.set(new TextEncoder().encode('bank  example'));
      const badLabelText = String.fromCharCode(...badLabel.map((c) => (c === 0 ? 32 : c)));
      const kd = new K256Device(0x5eed3n);
      const kdIn = evmEip712DescriptorInput({ scheme: 'k256', x: kd.pk.x, y: kd.pk.y, envelope: 0 });
      let AL = (await execute(Original.Contract, bare, 'add_device_with_evm_eip712', [kdIn, ...solArgs(kdIn), signAs(evmEip712Messages.addDevice(frame(bare), kdIn), bare)])).after;
      const gBad = { ...G[0].descriptor(), label: badLabel };
      const self = { bytes: AL.addressBytes };
      const ohBad = pc.derive_grant_origin_hash_label(badLabel);
      const gid = pc.evm_eip712_grantee_grant_id(self, gBad, ohBad, pc.evm_eip712_sol_grantee_target(self, gBad, ohBad, ...solArgs(gBad))[1]);
      const sc = mainScope(t);
      const plain: PlainScope = { opWithdrawUnshielded: sc.opWithdrawUnshielded, opWithdrawShielded: sc.opWithdrawShielded, opWithdrawShieldedToContract: sc.opWithdrawShieldedToContract,
        read: sc.read, color: sc.color, recipientKind: sc.recipientKind, recipient: sc.recipient, maxCoinValue: sc.maxCoinValue, perCallCap: sc.perCallCap, cap: sc.cap,
        expiresAt: sc.expiresAt, rpIdHash: sc.rpIdHash, readPkHash: sc.read ? fill(32, 0x1e) : new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: undefined };
      const kAuth = kd.sign(k256Challenges.issueGrant({ contractAddress: AL.addressBytes, authNonce: ledgerOf(AL).auth_nonce }, kd.pk, gid, scopeDigest(sSalt, plain)), 0n);
      AL = (await execute(Original.Contract, AL, 'issue_grant_with_k256', [gid, ...scopeArgs(plain), sSalt, kAuth.pk, 0n, kAuth.sig, 0n])).after;
      if (!ledgerOf(AL).grants.member(gid)) throw new Error('setup: the planted grant is not in the map');
      let hCoin: LocalCoin | undefined;
      if (t === 'U') AL = (await execute(Original.Contract, AL, 'deposit_unshielded', [COLG, 1000n])).after;
      else {
        const placed = withLocalCoins(AL, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }]);
        hCoin = placed.coins[1];
        AL = answering(placed.account, hCoin);
      }
      const g = G[0];
      const r = ledgerOf(AL).grants.lookup(gid);
      const fr = { account: AL.addressBytes, grantee: g.address, label, slot: 0n, issuedAt: r.issued_at as bigint, grantNonce: r.nonce as bigint };
      const spentCoin = hCoin && { nonce: hCoin.nonce, value: hCoin.value, mtIndex: hCoin.mtIndex };
      const td = t === 'U'
        ? evmEip712Messages.withdrawUnshieldedAsGrantee(fr, COLG, 200n, sc.recipient, TEST_SITE)
        : t === 'S'
          ? evmEip712Messages.withdrawShieldedAsGrantee(fr, COL_A, 300n, sc.recipient, change, ledgerOf(AL).enc_key, spentCoin!, TEST_SITE)
          : evmEip712Messages.withdrawShieldedToContractAsGrantee(fr, COL_A, 300n, sc.recipient, change, ledgerOf(AL).enc_key, spentCoin!, TEST_SITE);
      const tdBad = JSON.parse(JSON.stringify(td)); tdBad.message.siteLabel = badLabelText;
      const q = parseEvmSignature(gWallet.signDigest(typedDataDigest(tdBad)));
      const auth: any = { arm: 'evm_eip712' as const, pk: g.pk, blind: g.blind, label: badLabel, sig: { r: q.r, s: q.s } };
      const o: GrantOpening = { originHash: ohBad, slot: 0n, scopeSalt: sSalt, recipientKind: sc.recipientKind, pinnedRecipient: sc.recipient, maxCoinValue: sc.maxCoinValue, spentPrev: 0n };
      const args = t === 'U' ? [COLG, 200n, { bytes: sc.recipient }, ...grantAuthArgs(o, auth)] : [{ bytes: sc.recipient }, COL_A, 300n, change, ledgerOf(AL).enc_key, ...grantAuthArgs(o, auth)];
      await neg('a grant planted for the grantee under a site label with two spaces, the approval showing that label in its frame', AL, args, NOT_LABEL, [NOT_LABEL]);
    }

    // ── the grant seam's zero-scalar assert ──
    const ZERO_G = 'evm_eip712: signature scalar is zero';
    const withSig = (args: unknown[], sig: { r?: bigint; s?: bigint }) => {
      const a = [...args]; const au: any = a.at(-1); a[a.length - 1] = { ...au, sig: { ...au.sig, ...sig } }; return a;
    };
    await neg('signature r = 0 on the grantee path: the zero-scalar assert and the signature check', AT, withSig(base.args, { r: 0n }), ZERO_G, [ZERO_G, GINVALID]);
    const zeroInv = await loadPatched([ZERO_G, GINVALID], ZERO_INV_OVERRIDES);
    await neg('signature s = 0 on the grantee path (inverse of 0 taken as 0 in the copy): the zero-scalar assert and the signature check', AT, withSig(base.args, { s: 0n }), ZERO_G, [ZERO_G, GINVALID], { module: zeroInv });
    const zeroOnly = await loadPatched([ZERO_G], ZERO_INV_OVERRIDES);
    await neg('(r, s) = (0, 0) on the grantee path, which verifies against the identity point when inverses of 0 are taken as 0', AT, withSig(base.args, { r: 0n, s: 0n }), ZERO_G, [ZERO_G], { module: zeroOnly });

    // ── the shielded twins: every signed field substituted ──
    if (t !== 'U') {
      const coinH = H1!;
      const nonceAcc = answering(withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_OTHER, color: COL_A, value: 1000n }]).account, { ...coinH, nonce: NONCE_OTHER });
      await neg('coin nonce: signed N, witness coin N\' (same colour, value, index)', nonceAcc, call(t, nonceAcc, { ...honest, coin: { ...coinH, nonce: NONCE_OTHER }, signed: { coin: { nonce: NONCE_H, value: 1000n, mtIndex: coinH.mtIndex } } }), GINVALID, [GINVALID]);
      const idxPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: FILLER(1), color: COL_A, value: 7n }, { nonce: NONCE_H, color: COL_A, value: 1000n }]);
      const idxAcc = answering(idxPlaced.account, idxPlaced.coins[2]);
      await neg('Merkle index: signed 1, witness coin at index 2', idxAcc, call(t, idxAcc, { ...honest, coin: idxPlaced.coins[2], signed: { coin: { nonce: NONCE_H, value: 1000n, mtIndex: 1n } } }), GINVALID, [GINVALID]);
      await neg('change ciphertext: signed C1, executed C2', AT, call(t, AT, { ...honest, change: change2, signed: { change } }), GINVALID, [GINVALID]);
      await neg('encryption key: signed a stale key, executed with the live key', AT, call(t, AT, { ...honest, signed: { encPk: staleKey } }), GINVALID, [GINVALID]);
      await neg('a stale encryption key, honestly signed (the change sealed to a key that is no longer live)', AT, call(t, AT, { ...honest, encPk: staleKey }), STALE_ENC, [STALE_ENC]);
      await neg('amount: signed 300, executed 301', AT, call(t, AT, { ...honest, amount: 301n, signed: { amount: 300n } }), GINVALID, [GINVALID]);
      // the twin's own amount bound: a witness coin of 200 under a signed
      // amount of 300 (the client refuses to build a message whose coin is
      // smaller than its amount, so the approval names the coin of 1000)
      const lowPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 200n }]);
      const lowAcc = answering(lowPlaced.account, lowPlaced.coins[1]);
      await runtimeOnly('grant-matrix', `${tag}: witness coin of value 200 below the signed amount 300`, lowAcc, circuit,
        call(t, lowAcc, { ...honest, coin: lowPlaced.coins[1], signed: { coin: { nonce: NONCE_H, value: 1000n, mtIndex: coinH.mtIndex } } }), AMOUNT_COIN,
        "with the arm's assert and the checked subtraction bypassed, the generated JavaScript's type encoder refuses the negative change ('expected UnsignedInteger'), which is not an assert; in-circuit, the assert, the subtraction's range check and the signature over the shown value refuse it");
      if (t === 'C') {
        // as the S8 section did for the user-recipient twin: the colour assert
        // isolated with a grant scoped to B (slot 4), the approval naming A
        const colPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_B, value: 1000n }]);
        const colAcc = answering(colPlaced.account, colPlaced.coins[1]);
        await neg('valid approval for colour A, witness coin of colour B (a grant scoped to B)', colAcc, call(t, colAcc, { ...honest, slot: 4n, coin: colPlaced.coins[1] }), COLOUR_G, [COLOUR_G]);
        const valPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 999n }]);
        const valAcc = answering(valPlaced.account, valPlaced.coins[1]);
        await neg('valid approval for coin value 1000, witness coin of value 999', valAcc, call(t, valAcc, { ...honest, coin: valPlaced.coins[1], signed: { coin: { nonce: NONCE_H, value: 1000n, mtIndex: coinH.mtIndex } } }), GINVALID, [GINVALID]);
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The forged-address frame mutant on the remaining gated exports
// ═════════════════════════════════════════════════════════════════════════════
//
// As section `frame`: the mutant's generated JavaScript derives the
// VICTIM's address from the attacker's point, so locally the victim's entry
// (or grant id) matches and the attacker's signature verifies; only the
// proof's own derivation can refuse it. Here for add_device, remove_device
// (both forms), issue_grant, revoke_grant, revoke_all_grants and the two
// shielded grantee twins; each with the honest call proved through the same
// forging copy first.
if (SECTIONS.includes('frame-lifecycle')) {
  section('frame-lifecycle');
  const ADD = 'add_device_with_evm_eip712', REMOVE = 'remove_device_with_evm_eip712';
  const ISSUE = 'issue_grant_with_evm_eip712', REVOKE = 'revoke_grant_with_evm_eip712', REVOKE_ALL = 'revoke_all_grants_with_evm_eip712';
  const GWS = 'withdraw_shielded_with_grant_evm_eip712', GWSC = 'withdraw_shielded_to_contract_with_grant_evm_eip712';
  const UNKNOWN_GRANT = 'unknown grant';
  const attacker = new SoftwareEvmWallet(0xbad7n);
  const forging = await loadPatched([], FORGE_ADDRESS_OVERRIDES);
  const fired = () => (forgery.fired > 0 ? undefined : 'the forgery never fired (the mutant missed its target)');
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after;
  const frame = (a: LocalAccount) => ({ account: a.addressBytes, device: device.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const counterOf = (a: LocalAccount) => { for (let k = 0n; k < 64n; k++) if (ledgerOf(a).devices.member(device.entryAt(a.addressBytes, ledgerOf(a).device_epoch, k))) return k; throw new Error('device not live'); };
  const honestAuth = (t: Eip712TypedData, a: LocalAccount) => { const p = parseEvmSignature(wallet.signDigest(typedDataDigest(t))); return { pk: device.pk, use_counter: counterOf(a), blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const victimAuth = (t: Eip712TypedData, a: LocalAccount) => { const p = parseEvmSignature(attacker.signDigest(typedDataDigest(t))); return { pk: attacker.pk, use_counter: counterOf(a), blind: device.blind, sig: { r: p.r, s: p.s } }; };
  const mutantDevice = async (label: string, a: LocalAccount, circuit: string, td: Eip712TypedData, args: (auth: unknown) => unknown[]) => {
    forgery.set({ pk: attacker.pk, address: device.address });
    await negative('frame-lifecycle', `${label}: the attacker's key with the victim device's address forged into the derivation`, a, circuit, args(victimAuth(td, a)),
      UNKNOWN, [], '', { module: forging, mutant: 'forged-address mutant (keccak256 override: the copy derives the victim address from the attacker point)',
        check: fired, control: { a, args: args(honestAuth(td, a)) } });
    forgery.set(undefined);
  };
  // add_device (a k256 target)
  const k1 = new K256Device(0x5eed2n);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: 0 });
  await mutantDevice('add_device', A0, ADD, evmEip712Messages.addDevice(frame(A0), kIn), (au) => [kIn, ...solArgs(kIn), au]);
  // remove_device, both forms, on an account holding the k256 device
  const AK = (await execute(Original.Contract, A0, ADD, [kIn, ...solArgs(kIn), honestAuth(evmEip712Messages.addDevice(frame(A0), kIn), A0)])).after;
  const kEntry = k1.entryAt(AK.addressBytes, 0n, 0n);
  const NONE = { is_some: false, value: new Uint8Array(32) };
  await mutantDevice('remove_device (descriptor form)', AK, REMOVE, evmEip712Messages.removeDevice(frame(AK), kIn, 0n, 0n), (au) => [kIn, ...solArgs(kIn), 0n, 0n, NONE, au]);
  await mutantDevice('remove_device (literal form)', AK, REMOVE, evmEip712Messages.removeUnknownDevice(frame(AK), kEntry),
    (au) => [EVM_EIP712_UNUSED_DESCRIPTOR, ...EVM_EIP712_SOL_FILLER_ARGS, 0n, 0n, { is_some: true, value: kEntry }, au]);
  // issue_grant / revoke_grant / revoke_all_grants
  const label = grantLabel('bank.example');
  const gWallet = new SoftwareEvmWallet(0x6a17een);
  const eg = await EvmEip712Grantee.enrol(gWallet, 'undeployed', A0.addressBytes, label, 0n);
  const egIn = eg.descriptor();
  const shScope: IssueScope = { opWithdrawUnshielded: false, opWithdrawShielded: true, opWithdrawShieldedToContract: true, read: true,
    color: COL_A, recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 1000n, perCallCap: 1000n, cap: 2000n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: fill(32, 0x77), windowLen: 0n, windowCap: 0n, caller: null };
  await mutantDevice('issue_grant', A0, ISSUE, evmEip712Messages.issueGrant(frame(A0), egIn, shScope), (au) => [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(shScope), au]);
  // The grant's scope salt chosen by the prover: the circuit derives it from
  // the device's blind, the account and auth_nonce, and takes no salt, so the
  // generated JavaScript cannot be given one. A copy whose salt derivation
  // returns a chosen value writes the record's commitments under that salt;
  // the device's honest approval is unchanged (the salt is not signed), so
  // only the proof can refuse it. The salt tag's own check (another tag
  // refused) is a constraint of the descriptor module, refused through the
  // base probe that takes the tag as an argument; this arm passes its fixed
  // tag, so no input of this circuit reaches that check.
  {
    const choosing = await loadPatched([], CHOSEN_SALT_OVERRIDES);
    const issueArgs = [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(shScope), honestAuth(evmEip712Messages.issueGrant(frame(A0), egIn, shScope), A0)];
    const derived = evmEip712GrantScopeSalt(device.blind, A0.addressBytes, ledgerOf(A0).auth_nonce as bigint);
    const chosen = fill(32, 0x5a);
    const tag = pc.salt_tag_evm_eip712();
    const gid = eg.grantId(A0.addressBytes);
    const spentOf = (a: LocalAccount) => ledgerOf(a).grants.member(gid) ? ledgerOf(a).grants.lookup(gid).spent_commit as Uint8Array : undefined;
    const same = (x: Uint8Array | undefined, y: Uint8Array) => x !== undefined && x.length === y.length && x.every((v, i) => v === y[i]);
    await proverOnly('frame-lifecycle', 'issue_grant: a scope salt the prover chose, with the device\'s honest approval', A0, ISSUE, issueArgs, choosing,
      'chosen-salt mutant (persistentHash override: the copy derives a chosen scope salt)',
      (on) => saltChoice.set(on ? { tag, salt: chosen } : undefined),
      (honest, forged) => {
        if (saltChoice.fired === 0) return 'the substitution never fired (the mutant missed the derivation)';
        if (!same(spentOf(honest), pc.derive_grant_spent_commit(derived, 0n))) return 'the honest record is not committed under the derived salt';
        if (!same(spentOf(forged), pc.derive_grant_spent_commit(chosen, 0n))) return 'the attempt\'s record is not committed under the chosen salt';
        return undefined;
      });
  }
  const AG = (await execute(Original.Contract, A0, ISSUE, [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(shScope), honestAuth(evmEip712Messages.issueGrant(frame(A0), egIn, shScope), A0)])).after;
  await mutantDevice('revoke_grant', AG, REVOKE, evmEip712Messages.revokeGrant(frame(AG), egIn), (au) => [egIn, ...solArgs(egIn), au]);
  await mutantDevice('revoke_all_grants', AG, REVOKE_ALL, evmEip712Messages.revokeAllGrants(frame(AG)), (au) => [au]);
  // the two shielded grantee twins: the grant seam derives the grantee's
  // address from the presented point; the attacker presents its own point
  // with the grantee's blind and label
  const placed = withLocalCoins(AG, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }]);
  const AS = { ...placed.account, privateState: coinStoreAnswering([{ key: COL_A, coin: placed.coins[1] }]) } as LocalAccount;
  const coin = { nonce: NONCE_H, value: 1000n, mtIndex: placed.coins[1].mtIndex };
  const rec = ledgerOf(AS).grants.lookup(eg.grantId(AS.addressBytes));
  const gf = { account: AS.addressBytes, grantee: eg.address, label, slot: 0n, issuedAt: rec.issued_at as bigint, grantNonce: rec.nonce as bigint };
  const enc = ledgerOf(AS).enc_key, chg = fill(192, 0x2c);
  const op: GrantOpening = { originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AS, eg.grantId(AS.addressBytes)), recipientKind: 0n, pinnedRecipient: new Uint8Array(32), maxCoinValue: 1000n, spentPrev: 0n };
  const gAuthOf = (td: Eip712TypedData, w: SoftwareEvmWallet, pk: { x: bigint; y: bigint }) => { const p = parseEvmSignature(w.signDigest(typedDataDigest(td))); return { arm: 'evm_eip712' as const, pk, blind: eg.blind, label, sig: { r: p.r, s: p.s } }; };
  const gAuth = gAuthOf;
  // the unshielded twin as well (its mutant ran at S8 in section `grants`;
  // repeated here so that one run of `frame frame-lifecycle recovery` covers
  // all 15 gated exports): a grant with the unshielded operation and a mirror
  const GWU = 'withdraw_unshielded_with_grant_evm_eip712';
  const uScope: IssueScope = { ...shScope, opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, readPk: new Uint8Array(32), color: fill(32, 0xc7), maxCoinValue: 300n, perCallCap: 300n, cap: 450n };
  const AU0 = (await execute(Original.Contract, A0, ISSUE, [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(uScope), honestAuth(evmEip712Messages.issueGrant(frame(A0), egIn, uScope), A0)])).after;
  const AU = (await execute(Original.Contract, AU0, 'deposit_unshielded', [fill(32, 0xc7), 1000n])).after;
  const recU = ledgerOf(AU).grants.lookup(eg.grantId(AU.addressBytes));
  const gfU = { account: AU.addressBytes, grantee: eg.address, label, slot: 0n, issuedAt: recU.issued_at as bigint, grantNonce: recU.nonce as bigint };
  const opU: GrantOpening = { originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AU, eg.grantId(AU.addressBytes)), recipientKind: 0n, pinnedRecipient: new Uint8Array(32), maxCoinValue: 300n, spentPrev: 0n };
  const RU = fill(32, 0x7e);
  const tdU = evmEip712Messages.withdrawUnshieldedAsGrantee(gfU, fill(32, 0xc7), 200n, RU, TEST_SITE);
  const argsU = (au: any) => [fill(32, 0xc7), 200n, { bytes: RU }, ...grantAuthArgs(opU, au)];
  forgery.set({ pk: attacker.pk, address: eg.address });
  await negative('frame-lifecycle', `${GWU.replace('_evm_eip712', '')}: grant seam, the attacker's key with the grantee's address forged into the derivation`, AU, GWU,
    argsU(gAuthOf(tdU, attacker, attacker.pk)), UNKNOWN_GRANT, [], '',
    { module: forging, mutant: 'forged-address mutant (keccak256 override) on the grant seam', check: fired, control: { a: AU, args: argsU(gAuthOf(tdU, gWallet, eg.pk)) } });
  forgery.set(undefined);
  for (const [circuit, td, args] of [
    [GWS, evmEip712Messages.withdrawShieldedAsGrantee(gf, COL_A, 300n, localCoinPublicKeyBytes(), chg, enc, coin, TEST_SITE), (au: any) => [{ bytes: localCoinPublicKeyBytes() }, COL_A, 300n, chg, enc, ...grantAuthArgs(op, au)]],
    [GWSC, evmEip712Messages.withdrawShieldedToContractAsGrantee(gf, COL_A, 300n, RECIPIENT_CONTRACT, chg, enc, coin, TEST_SITE), (au: any) => [{ bytes: RECIPIENT_CONTRACT }, COL_A, 300n, chg, enc, ...grantAuthArgs(op, au)]],
  ] as [string, Eip712TypedData, (au: any) => unknown[]][]) {
    forgery.set({ pk: attacker.pk, address: eg.address });
    await negative('frame-lifecycle', `${circuit.replace('_evm_eip712', '')}: grant seam, the attacker's key with the grantee's address forged into the derivation`, AS, circuit,
      args(gAuth(td, attacker, attacker.pk)), UNKNOWN_GRANT, [], '',
      { module: forging, mutant: 'forged-address mutant (keccak256 override) on the grant seam', check: fired, control: { a: AS, args: args(gAuth(td, gWallet, eg.pk)) } });
    forgery.set(undefined);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The Field-to-Bytes<32> rendering in the signed bytes
// ═════════════════════════════════════════════════════════════════════════════
//
// PublishRecoverySession shows the JubJub recovery key's coordinates and the
// phi values as 32-byte little-endian words: the circuit casts each Field to
// Bytes<32> (ZKIR `div_mod_power_of_two(val, 248)`). If that decomposition
// were not forced below the scalar-field modulus r, a value f would have a
// second rendering f + r (f + r < 2^256 for every f < r), and an approval
// could show a non-canonical word for the value that executes. ZKIR 3.1
// lowers the instruction to `assigned_to_le_bits(val, None, enforce_canonical
// = true)` over all 255 bits (midnight-circuits 7.2.4 native_gadget.rs: the
// low bit is tied to sgn0(val), which leaves one bit vector), so the
// rendering is canonical. Probed as section qa1 does: an approval signed over
// the non-canonical rendering of the executed value must be refused by the
// proof server.
if (SECTIONS.includes('qa-s3')) {
  section('qa-s3');
  const PUBLISH = 'publish_recovery_session_with_evm_eip712';
  const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n; // the BLS12-381 scalar field modulus
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryPk), ACTIVATE, device.activationArgs(salt))).after;
  const sess = { recoveryPk: recoveryKey(0x5e57n).pk, sessionNonce: rnd(32), phi: [7n, 0x1234n, 0n, 0n] as [bigint, bigint, bigint, bigint], phiLen: 2n, wrap: rnd(64) };
  const sargs = (auth: unknown) => [sess.recoveryPk, sess.sessionNonce, ...sess.phi, sess.phiLen, sess.wrap, auth];
  const td = evmEip712Messages.publishRecoverySession(frameOf(A0), sess);
  const le = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } if (x) throw new Error('above 2^256'); return '0x' + Buffer.from(o).toString('hex'); };
  const control = { a: A0, args: sargs(authFor(td)) };
  await positive('qa-s3', 'publish_recovery_session: the canonical renderings (patched path)', await loadPatched([INVALID]), A0, PUBLISH, control.args);
  // phi3 is an unused slot, so its value is 0: the one value whose sign bit has
  // two witnesses; its non-canonical rendering is r itself
  for (const [member, value] of [['phi1', sess.phi[0]], ['phi2', sess.phi[1]], ['phi3', sess.phi[2]], ['recoveryKeyX', sess.recoveryPk.x], ['recoveryKeyY', sess.recoveryPk.y]] as const) {
    const t = JSON.parse(JSON.stringify(td));
    t.message[member] = le(value + R);
    if (t.message[member] === td.message[member]) throw new Error('setup: the renderings coincide');
    await negative('qa-s3', `${member} shown as the non-canonical rendering of the executed value (value + r, little-endian)`, A0, PUBLISH, sargs(authFor(t)),
      INVALID, [INVALID], '', { control });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Recovery: the session and the cancel through the arm
// ═════════════════════════════════════════════════════════════════════════════

if (SECTIONS.includes('recovery')) {
  section('recovery');
  const PUBLISH = 'publish_recovery_session_with_evm_eip712';
  const CANCEL = 'recover_cancel_with_evm_eip712';
  const PENDING = 'recovery pending; cancel first';
  const EMPTY = 'phi must not be empty';
  const RANGE = 'phi length out of range';
  const SLOT2 = 'unused phi slot 2 not zero', SLOT3 = 'unused phi slot 3 not zero', SLOT4 = 'unused phi slot 4 not zero';
  const SIDZERO = 'session nonce is zero', SIDREUSE = 'session nonce reused', PKREUSE = 'recovery commitment reused';
  const IDENT = 'recovery key is the identity', SMALL = 'recovery key has small order';
  const NOPENDING = 'no recovery pending';
  // The account's birth recovery key is one whose secret the test holds, so
  // that it can open the recovery gate (recover_submit) itself.
  const birth = 0xb1a7n;
  const field = (n: number) => BigInt('0x' + Buffer.from(rnd(31)).toString('hex')) + BigInt(n);
  type Sess = { recoveryPk: { x: bigint; y: bigint }; sessionNonce: Uint8Array; phi: [bigint, bigint, bigint, bigint]; phiLen: bigint; wrap: Uint8Array };
  const sessionOf = (secret: bigint): Sess => ({ recoveryPk: recoveryKey(secret).pk, sessionNonce: rnd(32), phi: [field(1), field(2), 0n, 0n], phiLen: 2n, wrap: rnd(64) });
  const sArgs = (x: Sess) => [x.recoveryPk, x.sessionNonce, ...x.phi, x.phiLen, x.wrap];
  const frame = (a: LocalAccount, d: EvmEip712Device = device) => ({ account: a.addressBytes, device: d.address, authNonce: ledgerOf(a).auth_nonce as bigint });
  const counterIn = (a: LocalAccount, d: EvmEip712Device) => { for (let k = 0n; k < 64n; k++) if (ledgerOf(a).devices.member(d.entryAt(a.addressBytes, ledgerOf(a).device_epoch, k))) return k; return 0n; };
  const signBy = async (d: EvmEip712Device, t: Eip712TypedData, counter: bigint) => { const { arm, ...auth } = await d.authorise(t, counter); return auth; };
  const pubArgs = async (a: LocalAccount, x: Sess, d: EvmEip712Device = device, signed?: (t: any) => void, counter = counterIn(a, d)) => {
    const td = evmEip712Messages.publishRecoverySession(frame(a, d), x);
    const t = signed ? JSON.parse(JSON.stringify(td)) : td;
    if (signed) signed(t);
    return [...sArgs(x), await signBy(d, t, counter)];
  };
  const cancelArgs = async (a: LocalAccount, d: EvmEip712Device = device, t?: Eip712TypedData, counter = counterIn(a, d)) =>
    [await signBy(d, t ?? evmEip712Messages.cancelRecovery(frame(a, d)), counter)];
  /** The shared JubJub gate: the recovery key `secret` and the successor co-sign. */
  const submitArgs = (a: LocalAccount, secret: bigint, successor: JubjubDevice, successorRecoveryPk: { x: bigint; y: bigint }, nowUpper: bigint) => {
    const l = ledgerOf(a);
    const auth = signRecoverSubmit(recoveryKey(secret), successor,
      recoverSubmitChallenge({ contractAddress: a.addressBytes, authNonce: l.auth_nonce }, l.recovery_pk, successor.pk, successorRecoveryPk as any, l.device_epoch + 1n, nowUpper),
      { successorRecoveryPk: successorRecoveryPk as any, expectedEpoch: l.device_epoch, expectedNonce: l.auth_nonce, nowUpper });
    return recoverSubmitArgs(auth);
  };
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const posPath = await loadPatched([INVALID, UNKNOWN, ZERO, PENDING, EMPTY, RANGE, SLOT2, SLOT3, SLOT4, SIDZERO, SIDREUSE, PKREUSE, IDENT, SMALL, NOPENDING]);

  // A0: the device, activated (counter 0); window 0 (the constructor's
  // minimum) so that a finalisation can run locally
  const A0 = (await execute(Original.Contract, await dormant(device.bootCommitment(salt), recoveryKey(birth).pk, 0n), ACTIVATE, device.activationArgs(salt))).after;
  const S1 = sessionOf(0x5e55n);
  await positive('recovery', 'publish_recovery_session: the honest session (patched path)', posPath, A0, PUBLISH, await pubArgs(A0, S1));
  const A1 = (await execute(Original.Contract, A0, PUBLISH, await pubArgs(A0, S1))).after; // device at counter 1, S1 stored
  if (ledgerOf(A1).recovery_phi_len !== 2n) throw new Error('setup: the session did not land');

  // binding: the signed message differs from the executed values in one member
  const S2 = sessionOf(0x5e56n);
  const otherKey = recoveryKey(0x0dd0n).pk;
  const hex32 = (v: bigint) => '0x' + Buffer.from(Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn))).toString('hex');
  const flipHex = (h: string) => h.slice(0, -2) + (h.slice(-2) === '00' ? '01' : '00');
  const bindings: [string, (t: any) => void][] = [
    ['the effect line', (t) => { t.message.effect = 'Adds a backup'; }],
    ['recoveryKeyX', (t) => { t.message.recoveryKeyX = hex32(otherKey.x); }],
    ['recoveryKeyY', (t) => { t.message.recoveryKeyY = hex32(otherKey.y); }],
    ['sessionNonce', (t) => { t.message.sessionNonce = flipHex(t.message.sessionNonce); }],
    ['phi1', (t) => { t.message.phi1 = flipHex(t.message.phi1); }],
    ['phi2', (t) => { t.message.phi2 = flipHex(t.message.phi2); }],
    ['phi3 (signed non-zero, executed zero)', (t) => { t.message.phi3 = hex32(7n); }],
    ['phi4 (signed non-zero, executed zero)', (t) => { t.message.phi4 = hex32(7n); }],
    ['phiLength (signed 3, executed 2)', (t) => { t.message.phiLength = '3'; }],
    ['wrap (one byte)', (t) => { t.message.wrap = flipHex(t.message.wrap); }],
    ['authNonce (n + 1)', (t) => { t.message.authNonce = String(BigInt(t.message.authNonce) + 1n); }],
  ];
  for (const [name, f] of bindings) await negative('recovery', `publish binding: ${name} changed in the signed message`, A1, PUBLISH, await pubArgs(A1, S2, device, f), INVALID, [INVALID]);
  await negative('recovery', 'publish replay/operation: a CancelRecovery signature (bare frame) presented as the session approval', A1, PUBLISH,
    [...sArgs(S2), await signBy(device, evmEip712Messages.cancelRecovery(frame(A1)), 1n)], INVALID, [INVALID]);
  await negative('recovery', 'publish replay: the landed session approval replayed (entry consumed, nonce advanced, stored values)', A1, PUBLISH,
    await pubArgs(A0, S1, device, undefined, 0n), UNKNOWN, [UNKNOWN, INVALID, SIDREUSE, PKREUSE]);

  // the shared chip, through the arm, under a VALID signature
  const chip: [string, Sess, string, string[]][] = [
    ['an empty vector (length 0)', { ...S2, phi: [0n, 0n, 0n, 0n], phiLen: 0n }, EMPTY, [EMPTY]],
    ['a length beyond the slot bound (5)', { ...S2, phi: [1n, 2n, 3n, 4n], phiLen: 5n }, RANGE, [RANGE]],
    ['length 1 with phi2 non-zero', { ...S2, phi: [1n, 2n, 0n, 0n], phiLen: 1n }, SLOT2, [SLOT2]],
    ['length 2 with phi3 non-zero', { ...S2, phi: [1n, 2n, 3n, 0n], phiLen: 2n }, SLOT3, [SLOT3]],
    ['length 3 with phi4 non-zero', { ...S2, phi: [1n, 2n, 3n, 4n], phiLen: 3n }, SLOT4, [SLOT4]],
    ['an all-zero session identifier', { ...S2, sessionNonce: new Uint8Array(32) }, SIDZERO, [SIDZERO]],
    ['the stored session identifier reused', { ...S2, sessionNonce: new Uint8Array(S1.sessionNonce) }, SIDREUSE, [SIDREUSE]],
    ['the stored recovery commitment reused', { ...S2, recoveryPk: S1.recoveryPk }, PKREUSE, [PKREUSE]],
    ['the identity as the new recovery key', { ...S2, recoveryPk: JUBJUB_IDENTITY }, IDENT, [IDENT, SMALL]],
  ];
  for (const [name, x, expect, bypass] of chip) await negative('recovery', `publish under a valid signature: ${name}`, A1, PUBLISH, await pubArgs(A1, x), expect, bypass);
  {
    // A torsion point traps in the runtime's JubJub code (a WASM
    // `unreachable`) before the circuit body runs, which the base helper's
    // classifier does not count as a recognised refusal (attempt 1 ERROR,
    // e/s9/prover/…-attempt1-ERROR-trap.json); the trap is checked here
    // directly: the circuit's execution fails with RuntimeError
    // "unreachable" and nothing else ran. Prover level: unreachable from a
    // JavaScript-built call.
    const name = 'publish under a valid signature: a small-order recovery key (runtime trap)';
    const r: Result = { section: 'recovery', circuit: PUBLISH, case: name, kind: 'negative', expect: 'unreachable' };
    const t0 = Date.now(); const startedAt = new Date().toISOString();
    let chain: string[] = [];
    let refused = false;
    try { await execute(Original.Contract, A1, PUBLISH, await pubArgs(A1, { ...S2, recoveryPk: JUBJUB_ORDER_TWO })); }
    catch (e: any) { refused = true; for (let x = e; x; x = x.cause) chain.push(`${x.name}: ${x.message}`); }
    const trap = refused && chain.some((m) => /^RuntimeError: unreachable$/.test(m)) && chain.some((m) => m.includes(`Error executing circuit '${PUBLISH}'`));
    r.simulator = { name, expectedLayer: 'runtime', layer: trap ? 'runtime' : 'unknown', verdict: trap ? 'PASS' : refused ? 'ERROR' : 'FAIL',
      reason: trap ? 'refused by the runtime: a WASM trap in JubJub point handling before the circuit body (RuntimeError "unreachable")' : refused ? 'refused, but not by the trap' : 'not refused',
      detail: chain.join(' | '), proofServer: [], startedAt, ms: Date.now() - t0 } as any;
    (r as any).proverLevel = 'not reachable from a JavaScript-built call: the runtime cannot construct a JubJub point outside the prime-order subgroup, and the proving toolchain constrains every assigned point into the subgroup (upstream recovery-sim; require_live_jubjub_point is defence in depth)';
    tally(r.simulator); results.push(r); line(r);
  }

  // the seam on the new circuits
  const stranger = await EvmEip712Device.enrol(other, 'undeployed', 0);
  await negative('recovery', 'publish: an unenrolled evm key signs the session', A1, PUBLISH, await pubArgs(A1, S2, stranger, undefined, 0n), UNKNOWN, [UNKNOWN]);
  await negative('recovery', 'publish: the device key with another blind', A1, PUBLISH,
    [...sArgs(S2), { ...(await signBy(device, evmEip712Messages.publishRecoverySession(frame(A1), S2), 1n)), blind: device1.blind }], UNKNOWN, [UNKNOWN]);
  await negative('recovery', 'publish: signature r = 0: the zero-scalar assert and the signature check', A1, PUBLISH,
    [...sArgs(S2), { ...(await signBy(device, evmEip712Messages.publishRecoverySession(frame(A1), S2), 1n)), sig: { r: 0n, s: 5n } }], ZERO, [ZERO, INVALID]);

  // a pending recovery (AP): the device publishes, the gate opens with the
  // session's secret, a k256 device K and a jubjub device J are enrolled, and
  // J plants an evm_eip712 entry for W at device_epoch + 1 (erratum 7)
  const jub = JubjubDevice.generate();
  const jIn = evmEip712DescriptorInput({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y });
  const AJ = (await execute(Original.Contract, A1, 'add_device_with_evm_eip712', [jIn, ...solArgs(jIn), await signBy(device, evmEip712Messages.addDevice(frame(A1), jIn), 1n)])).after;
  const e2 = await EvmEip712Device.enrol(new SoftwareEvmWallet(0xe2e2n), 'undeployed', 0);
  const e2In = evmEip712DescriptorInput(evmDeviceDescriptor(e2));
  const AE = (await execute(Original.Contract, AJ, 'add_device_with_evm_eip712', [e2In, ...solArgs(e2In), await signBy(device, evmEip712Messages.addDevice(frame(AJ), e2In), 2n)])).after;
  const W = await EvmEip712Device.enrol(new SoftwareEvmWallet(0x3a38n), 'undeployed', 0);
  const plant = W.entryAt(AE.addressBytes, 1n, 0n);
  const jPlant = jub.sign(jubjubChallenges.addDevice({ contractAddress: AE.addressBytes, authNonce: ledgerOf(AE).auth_nonce }, jub.pk, plant), 0n);
  const AW = (await execute(Original.Contract, AE, 'add_device_with_jubjub', [plant, ...authArgs(jPlant)])).after;
  if (!ledgerOf(AW).devices.member(plant)) throw new Error('setup: the plant did not land');
  const Q = JubjubDevice.generate();
  const QR = 0x9e11n;
  const AP = (await execute(Original.Contract, AW, 'recover_submit', submitArgs(AW, 0x5e55n, Q, recoveryKey(QR).pk, now() + 2n))).after;
  if (!ledgerOf(AP).pending_recovery) throw new Error('setup: the submission did not land');
  await negative('recovery', 'publish under a valid signature while a recovery is pending', AP, PUBLISH, await pubArgs(AP, S2), PENDING, [PENDING]);
  await positive('recovery', 'recover_cancel: the second evm device vetoes the pending recovery (patched path)', posPath, AP, CANCEL, await cancelArgs(AP, e2));
  await negative('recovery', 'cancel binding: a RevokeAllGrants signature over the same bare frame', AP, CANCEL, await cancelArgs(AP, e2, evmEip712Messages.revokeAllGrants(frame(AP, e2))), INVALID, [INVALID]);
  await negative('recovery', 'cancel binding: a CancelRecovery signature over authNonce + 1', AP, CANCEL,
    await cancelArgs(AP, e2, evmEip712Messages.cancelRecovery({ ...frame(AP, e2), authNonce: ledgerOf(AP).auth_nonce + 1n })), INVALID, [INVALID]);
  await negative('recovery', 'cancel binding: a CancelRecovery signature for another account', AP, CANCEL,
    await cancelArgs(AP, e2, evmEip712Messages.cancelRecovery({ ...frame(AP, e2), account: rnd(32) })), INVALID, [INVALID]);
  await negative('recovery', 'cancel: an unenrolled evm key', AP, CANCEL, await cancelArgs(AP, stranger, undefined, 0n), UNKNOWN, [UNKNOWN]);
  await negative('recovery', 'cancel: signature r = 0: the zero-scalar assert and the signature check', AP, CANCEL, [{ ...(await cancelArgs(AP, e2))[0] as any, sig: { r: 0n, s: 5n } }], ZERO, [ZERO, INVALID]);
  // the bare body's zero-scalar assert, isolated in the copy
  await negative('recovery', 'cancel: (r, s) = (0, 0), which verifies against the identity point when inverses of 0 are taken as 0', AP, CANCEL,
    [{ ...(await cancelArgs(AP, e2))[0] as any, sig: { r: 0n, s: 0n } }], ZERO, [ZERO], ZERO_INV_OVERRIDES, { control: { a: AP, args: await cancelArgs(AP, e2) } });
  await negative('recovery', 'cancel under a valid signature with nothing pending', A1, CANCEL, await cancelArgs(A1), NOPENDING, [NOPENDING]);
  const AC = (await execute(Original.Contract, AP, CANCEL, await cancelArgs(AP, e2))).after;
  const landedCancel = await cancelArgs(AP, e2);
  await negative('recovery', 'cancel replay: the landed cancel replayed (entry consumed, nonce advanced, nothing pending)', AC, CANCEL, landedCancel, UNKNOWN, [UNKNOWN, INVALID, NOPENDING]);

  // the seam owns the frame on both recovery circuits: the forged-address
  // mutant derives the victim's address from the attacker's point, so the
  // victim's entry matches and the attacker's signature verifies locally;
  // the proof must refuse it
  {
    const attacker = new SoftwareEvmWallet(0xbad5eedn);
    const forging = await loadPatched([], FORGE_ADDRESS_OVERRIDES);
    const fired = () => (forgery.fired > 0 ? undefined : 'the forgery never fired (the mutant missed its target)');
    const asAttacker = (t: Eip712TypedData, counter: bigint) => { const p = parseEvmSignature(attacker.signDigest(typedDataDigest(t))); return { pk: attacker.pk, use_counter: counter, blind: device.blind, sig: { r: p.r, s: p.s } }; };
    const tdP = evmEip712Messages.publishRecoverySession(frame(A1), S2);
    forgery.set({ pk: attacker.pk, address: device.address });
    await negative('recovery', 'publish: the attacker\'s key with the victim\'s address forged into the derivation (frame mutant)', A1, PUBLISH,
      [...sArgs(S2), asAttacker(tdP, 1n)], UNKNOWN, [], '', { module: forging, mutant: 'forged-address mutant (keccak256 override: the copy derives the victim address from the attacker point)',
        check: fired, control: { a: A1, args: await pubArgs(A1, S2) } });
    const cDev = counterIn(AP, device);
    const tdC = evmEip712Messages.cancelRecovery(frame(AP));
    forgery.set({ pk: attacker.pk, address: device.address });
    await negative('recovery', 'cancel: the attacker\'s key with the victim\'s address forged into the derivation (frame mutant)', AP, CANCEL,
      [asAttacker(tdC, cDev)], UNKNOWN, [], '', { module: forging, mutant: 'forged-address mutant (keccak256 override: the copy derives the victim address from the attacker point)',
        check: fired, control: { a: AP, args: await cancelArgs(AP, device) } });
    forgery.set(undefined);
  }

  // finalised (AF): resubmit, wait out the window (0 s + the 2 s bound), finalise
  const AP2 = (await execute(Original.Contract, AC, 'recover_submit', submitArgs(AC, 0x5e55n, Q, recoveryKey(QR).pk, now() + 2n))).after;
  await new Promise((r) => setTimeout(r, 3500));
  const AF0 = (await execute(Original.Contract, AP2, 'recover_finalise', [])).after;
  const lf = ledgerOf(AF0);
  const finalised: Result = { section: 'recovery', circuit: 'recover_finalise', case: 'finalised (simulator): the set holds only the successor; the plant is the planted device\'s entry at the new epoch and is gone', kind: 'positive' };
  const fOk = lf.devices.size() === 1n && lf.device_epoch === 1n && !lf.devices.member(plant) && Buffer.from(plant).equals(Buffer.from(W.entryAt(AF0.addressBytes, lf.device_epoch, 0n)));
  finalised.positive = { name: finalised.case, verdict: fOk ? 'PASS' : 'FAIL', reason: fOk ? 'state checked' : 'unexpected post-finalise state', proofServer: [], startedAt: new Date().toISOString(), ms: 0 };
  tally(finalised.positive); results.push(finalised); line(finalised);
  // the successor enrols a fresh evm device F and opens a new recovery, so
  // that a cancel has something pending; F's own session is the positive
  const F = await EvmEip712Device.enrol(new SoftwareEvmWallet(0xf0f0n), 'undeployed', 0);
  const fEntry = F.entryAt(AF0.addressBytes, lf.device_epoch, 0n);
  const AF = (await execute(Original.Contract, AF0, 'add_device_with_jubjub', [fEntry, ...authArgs(Q.sign(jubjubChallenges.addDevice({ contractAddress: AF0.addressBytes, authNonce: lf.auth_nonce }, Q.pk, fEntry), 0n))])).after;
  const S3 = sessionOf(0x5e57n);
  await positive('recovery', 'after the recovery: a fresh evm device enrolled by the successor publishes a session (patched path)', posPath, AF, PUBLISH, await pubArgs(AF, S3, F));
  const AFP = (await execute(Original.Contract, AF, 'recover_submit', submitArgs(AF, QR, JubjubDevice.generate(), recoveryKey(0x9e12n).pk, now() + 600n))).after;
  await positive('recovery', 'after the recovery: the fresh evm device cancels a new pending recovery (patched path)', posPath, AFP, CANCEL, await cancelArgs(AFP, F));
  // every old evm_eip712 device, the plant included, refused by membership
  for (const [name, d, ctr] of [['the planted entry\'s device W (counter 0 at the new epoch)', W, 0n], ['the original device', device, 3n], ['the second evm device', e2, 1n]] as const) {
    await negative('recovery', `after the recovery: ${name} publishes`, AF, PUBLISH, await pubArgs(AF, S3, d, undefined, ctr), UNKNOWN, [UNKNOWN]);
    await negative('recovery', `after the recovery: ${name} cancels a pending recovery`, AFP, CANCEL, await cancelArgs(AFP, d, undefined, ctr), UNKNOWN, [UNKNOWN]);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The shared display checks, through this arm's circuits
// ═════════════════════════════════════════════════════════════════════════════
//
// Every assert of the shared rendering and descriptor modules that a circuit
// of this arm reaches is refused here through that circuit: the expiry's UTC
// date (issue_grant), a Solana key's base58 text and checked encoding
// (add_device), the site's amount label (withdraw_unshielded). Each display
// input breaks exactly one rule while every other check holds, and the
// approval is signed over what the circuit renders from those inputs, so only
// that rule refuses; the call's hints are passed as built (the digest hint is
// the digest of the signed message). The honest call is proved first through
// the same patched copy.
if (SECTIONS.includes('texts')) {
  section('texts');
  const A0 = S6_A0!;
  const keep = <T extends object>(h: T): T => Object.assign(h, { [KEEP_HINTS]: true });
  const big = (b: Uint8Array) => [...b].map(BigInt);
  const ascii = (v: bigint[]) => String.fromCharCode(...v.map(Number));
  // the device's authorisation over `t` with the seam hint of that message
  const signed = (a: LocalAccount, t: Eip712TypedData) =>
    ({ ...authFor(t), hint: evmEip712SeamHint(device.pk, a.addressBytes, typedDataDigest(t), ledgerOf(a).auth_nonce as bigint) });
  const patch = (t: Eip712TypedData, f: (m: any) => void): Eip712TypedData => { const c = JSON.parse(JSON.stringify(t)); f(c.message); return c; };
  // the read-back hints of any base58 digits (58 is padding)
  const b58hints = (digits: bigint[]) => {
    const group = (g: bigint[]) => g.reduce(([v, m], d) => (d === 58n ? [v, m] : [v * 58n + d, m * 58n]), [0n, 1n]);
    const [v1] = group(digits.slice(0, 21)), [v2, m2] = group(digits.slice(21, 42)), [v3, m3] = group(digits.slice(42));
    const l2 = m2 * v1 + v2, low = l2 % (1n << 128n);
    return { digits, carry: l2 >> 128n, low, top: (m3 * low + v3) >> 128n };
  };
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const shown = (digits: bigint[]) => digits.map((d) => (d === 58n ? ' ' : ALPHABET[Number(d)])).join('');

  // ── the expiry's UTC date (issue_grant) ──
  const gWallet = new SoftwareEvmWallet(0x7e575n);
  const eg = await EvmEip712Grantee.enrol(gWallet, 'undeployed', A0.addressBytes, grantLabel('bank.example'), 0n);
  const egIn = eg.descriptor();
  const sc: IssueScope = { opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: COL_U,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: RECIPIENT_U, maxCoinValue: 300n, perCallCap: 300n, cap: 1000n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null };
  const ISSUE_T = 'issue_grant_with_evm_eip712';
  const at = (y: number, m: number, d: number) => BigInt(Date.UTC(y, m - 1, d) / 1000);
  const t29 = (x: string) => big(new TextEncoder().encode(x.padEnd(29, ' ')));
  const splitOf = (year: bigint) => { const y1 = year - 1n; return [y1 / 400n, (y1 % 400n) / 100n, (y1 % 100n) / 4n, y1 % 4n]; };
  const issueCall = (scope: IssueScope, expiryText: bigint[], yearSplit: bigint[], showDate: boolean) => {
    const td = evmEip712Messages.issueGrant(frameOf(A0), egIn, scope);
    const t = showDate ? patch(td, (m) => { m.expiry = ascii(expiryText).slice(0, 23); }) : td;
    const op = keep({ ...evmEip712IssueHint(egIn, scope), expiry_text: expiryText, year_split: yearSplit });
    return [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(scope), signed(A0, t), op];
  };
  const honestIssue = (scope: IssueScope) => [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(scope), authFor(evmEip712Messages.issueGrant(frameOf(A0), egIn, scope))];
  const dateCase = async (name: string, v: bigint, text: string, split: bigint[], expect: string, showDate = true) => {
    const scope = { ...sc, expiresAt: v };
    await negative('texts', `issue_grant: ${name}`, A0, ISSUE_T, issueCall(scope, t29(text), split, showDate), expect, [expect], '', { control: { a: A0, args: honestIssue(scope) } });
  };
  await dateCase('expiry 0 ("never" shown) with a date text of another shape, 1970/01-01', 0n, '1970/01-01 00:00:00 UTC', utcDateTimeInputs(0n).yearSplit,
    'display: not a UTC date and time', false);
  await dateCase('1970-12-01 shown as month 13 of 1970 (signed as shown)', at(1970, 12, 1), '1970-13-01 00:00:00 UTC', utcDateTimeInputs(0n).yearSplit,
    'display: month out of range');
  await dateCase('2100-03-01 shown as 2100-02-29 (signed as shown)', at(2100, 3, 1), '2100-02-29 00:00:00 UTC', utcDateTimeInputs(at(2100, 3, 1)).yearSplit,
    'display: day out of range');
  await dateCase('86400 shown as 1970-01-01 24:00:00 (signed as shown)', 86400n, '1970-01-01 24:00:00 UTC', utcDateTimeInputs(0n).yearSplit,
    'display: time of day out of range');
  await dateCase('2026-06-01 with the year split of 2027', at(2026, 6, 1), '2026-06-01 00:00:00 UTC', splitOf(2027n),
    'display: the year split is not canonical');
  await dateCase('253402300800 (the words shown) with the date text 9999-12-31 23:59:59', 253402300800n, '9999-12-31 23:59:59 UTC', [0n, 0n, 0n, 0n],
    'display: not the words for a time after 9999-12-31 23:59:59 UTC', false);
  await dateCase('2030-01-01 00:00:00 shown as 00:00:01 (signed as shown)', 1893456000n, '2030-01-01 00:00:01 UTC', utcDateTimeInputs(1893456000n).yearSplit,
    'display: the date and time do not match the value');

  // ── a Solana key's base58 text and its checked encoding (add_device) ──
  const ADD_T = 'add_device_with_evm_eip712';
  const K = new K256Device(0x7e57n);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const kTd = evmEip712Messages.addDevice(frameOf(A0), kIn);
  const kCtl = { a: A0, args: [kIn, ...solArgs(kIn), authFor(kTd)] };
  // a k256 target: the filler key's base58 text is checked but not shown, so
  // the approval is the honest one
  const [fPt, fBytes, fX] = EVM_EIP712_SOL_FILLER_ARGS as unknown as [unknown, bigint[], bigint[]];
  const fillerCall = (b58: unknown, bytes: bigint[] = fBytes) =>
    [kIn, fPt, bytes, fX, signed(A0, kTd), keep({ ...evmEip712DescriptorHint(kIn), b58 })];
  const fDigits = base58Inputs(Uint8Array.from(fBytes.map(Number))).digits;
  const iShift = fDigits[42] > 0n && fDigits[43] < 58n ? 42 : 41;
  const shifted = [...fDigits]; shifted[iShift] -= 1n; shifted[iShift + 1] += 58n;
  await negative('texts', 'add_device (k256 target): the filler key\'s base58 digits with a digit of 58 or more (the value kept)', A0, ADD_T,
    fillerCall(b58hints(shifted)), 'display: not a left-aligned base58 text', ['display: not a left-aligned base58 text'], '', { control: kCtl });
  const flipped = (i: number) => { const c = Uint8Array.from(fBytes.map(Number)); c[i] ^= 1; return base58Inputs(c); };
  const bumped = [...fDigits]; bumped[5] = (bumped[5] + 1n) % 58n;
  const fHints = base58Inputs(Uint8Array.from(fBytes.map(Number)));
  await negative('texts', 'add_device (k256 target): the filler key\'s base58 digits with one digit changed, the read-back hints kept', A0, ADD_T,
    fillerCall({ ...fHints, digits: bumped }), 'display: the base58 carry hints do not split the leading digits', ['display: the base58 carry hints do not split the leading digits'], '', { control: kCtl });
  await negative('texts', 'add_device (k256 target): the filler key\'s base58 digits of a value with byte 20 changed', A0, ADD_T,
    fillerCall(flipped(20)), "display: the base58 digits do not match the value's low bytes", ["display: the base58 digits do not match the value's low bytes"], '', { control: kCtl });
  await negative('texts', 'add_device (k256 target): the filler key\'s base58 digits of a value with byte 3 changed', A0, ADD_T,
    fillerCall(flipped(3)), "display: the base58 digits do not match the value's high bytes", ["display: the base58 digits do not match the value's high bytes"], '', { control: kCtl });
  // the filler key's encoding with the other sign bit (its base58 inputs those of the changed bytes)
  const signFlipped = [...fBytes]; signFlipped[31] ^= 0x80n;
  await negative('texts', 'add_device (k256 target): the filler key\'s encoding with the other sign bit', A0, ADD_T,
    fillerCall(base58Inputs(Uint8Array.from(signFlipped.map(Number))), signFlipped), "descriptor: the Ed25519 sign bit is not x's parity",
    ["descriptor: the Ed25519 sign bit is not x's parity"], '', { control: kCtl });
  // a Solana target with a 43-character base58 key, shown with one "1" too many
  let solKey: Uint8Array | undefined;
  for (let i = 0; i < 4096 && !solKey; i++) { const k = ed25519.getPublicKey(rnd(32)); if (base58Text32(k).length === 43) solKey = k; }
  if (!solKey) throw new Error('setup: no Solana key with a 43-character base58 text');
  const sIn = evmEip712DescriptorInput({ scheme: 'sol_ed25519', key: solKey, blind: fill(32, 0x5c) });
  const sTd = evmEip712Messages.addDevice(frameOf(A0), sIn);
  const lead = [0n, ...base58Inputs(solKey).digits.slice(0, 43)];
  const sTdShown = patch(sTd, (m) => { m.newDevice.publicKey = shown(lead); });
  await negative('texts', 'add_device (Solana target): its key shown with a leading "1" too many (signed as shown)', A0, ADD_T,
    [sIn, ...solArgs(sIn), signed(A0, sTdShown), keep({ ...evmEip712DescriptorHint(sIn), b58: b58hints(lead) })],
    'display: the leading base58 ones do not match the leading zero bytes', ['display: the leading base58 ones do not match the leading zero bytes'], '',
    { control: { a: A0, args: [sIn, ...solArgs(sIn), authFor(sTd)] } });

  // ── the site's amount label (withdraw_unshielded) ──
  const AU = await depositedU();
  const label49 = (x: string) => big(new TextEncoder().encode(x.padEnd(49, ' ')));
  const labelCase = async (amount: bigint, label: string, expect: string) => {
    const td = evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, amount, RECIPIENT_U, TEST_SITE);
    const l = label49(label);
    const t = patch(td, (m) => { m.amountLabel = EVM_EIP712_AMOUNT_LABEL_PREFIX + ascii(l); });
    await negative('texts', `withdraw_unshielded: ${amount} shown as "${label.replaceAll('\n', '\\n')}" (signed as shown)`, AU, WU,
      [COL_U, amount, { bytes: RECIPIENT_U }, signed(AU, t), keep({ amount: leHint(amount, 16), label: l })], expect, [expect], '',
      { control: { a: AU, args: [COL_U, amount, { bytes: RECIPIENT_U }, authFor(td)] } });
  };
  await labelCase(10n, '0.000010 TO\nKEN', 'display: not a site amount label');
  await labelCase(10n, '0.000010 .5', 'display: the symbol does not start with a letter');
  await labelCase(1n, '0.0000000000000000001 TOKEN', 'display: more than 18 decimals');
  await labelCase(10n, '0.000010 ABCDEFGHI', 'display: symbol longer than 8');
  await labelCase(15n, '01.5 X', 'display: leading zero in the site amount label');
  await labelCase(10n, '0.000011 TOKEN', 'display: the site amount label does not match the value');
}

// ═════════════════════════════════════════════════════════════════════════════
// Each checked byte hint, refused alone
// ═════════════════════════════════════════════════════════════════════════════
//
// A hint binds a value the circuit executes to the bytes it shows and signs.
// Each case below forges one hint and has the approval signed over what the
// circuit renders from the forged hint (with the digest hint of that message),
// so the hint's own check is the only one that refuses: the digest check (a key
// signs an unrelated 32-byte value, passed as the digest hint), the word checks
// (a replay after the device's or the grant record's nonce advanced, with the
// nonce hint set to the signed nonce; a removal's epoch and counter; an
// amount, a change and a scope cap shown other than executed), and the byte
// check of the bytes the circuit reads (a target's shown key, a site label,
// the device key's coordinates against a boot commitment made over the
// address they hash to). Without the check each forgery would execute. Also
// here: the two-form body's own membership check (an unenrolled key removes a
// live device). Each case proves the honest call through its own patched copy
// first. The two replays compare the nonce hint with a value the circuit reads
// from the ledger (auth_nonce; the grant record's nonce): an honest prover
// declares the real value and the check fails at the proof server, while a
// malicious prover can declare the old one, and then the node's replay of
// the transcript against the real state refuses it. Those two cases are
// recorded as refused through a declared read.
if (SECTIONS.includes('isolate')) {
  section('isolate');
  const BYTE_H = 'evm_eip712: byte hint does not match its value';
  const DIGEST_H = 'evm_eip712: digest hint does not match the digest';
  const WORD_H = 'evm_eip712: word hint does not match its value';
  const ADD = 'add_device_with_evm_eip712', REMOVE = 'remove_device_with_evm_eip712', ISSUE = 'issue_grant_with_evm_eip712', GWU = 'withdraw_unshielded_with_grant_evm_eip712';
  const keep = <T extends object>(h: T): T => Object.assign(h, { [KEEP_HINTS]: true });
  const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
  const patch = (t: Eip712TypedData, f: (m: any) => void): Eip712TypedData => { const c = JSON.parse(JSON.stringify(t)); f(c.message); return c; };
  const counterOf = (a: LocalAccount, d = device) => { for (let n = 0n; n < 64n; n++) if (ledgerOf(a).devices.member(d.entryAt(a.addressBytes, ledgerOf(a).device_epoch, n))) return n; throw new Error('device not live'); };
  const nonceOf = (a: LocalAccount) => ledgerOf(a).auth_nonce as bigint;
  // the device's approval of `t` on account `a`: the signature over `signed`
  // (the message the circuit renders) and the seam hint of that message, with
  // the nonce hint `nonce`
  const deviceAuth = (a: LocalAccount, signed: Eip712TypedData, nonce = nonceOf(a), digest = typedDataDigest(signed)) => {
    const p = parseEvmSignature(wallet.signDigest(digest));
    return { pk: device.pk, use_counter: counterOf(a), blind: device.blind, sig: { r: p.r, s: p.s }, hint: evmEip712SeamHint(device.pk, a.addressBytes, digest, nonce) };
  };
  const A0 = S6_A0!;

  // ── the digest check: the device signs an unrelated 32-byte value ──
  const k = fill(32, 0x49);
  const rotCtl = { a: A0, args: [k, authFor(evmEip712Messages.rotateEncKey(frameOf(A0), k))] };
  const unrelated = rnd(32);
  await negative('isolate', 'rotate_enc_key: the device\'s signature over an unrelated 32-byte value, passed as the digest hint', A0, ROTATE,
    [k, keep(deviceAuth(A0, evmEip712Messages.rotateEncKey(frameOf(A0), k), nonceOf(A0), unrelated))], DIGEST_H, [DIGEST_H], '', { control: rotCtl });

  // ── the word check of auth_nonce: an approval replayed after the nonce advanced ──
  const signedAt0 = evmEip712Messages.rotateEncKey(frameOf(A0), k);
  const A1 = (await execute(Original.Contract, A0, ROTATE, [k, authFor(signedAt0)])).after;
  await negative('isolate', 'rotate_enc_key: the approval made at authNonce 0, replayed at authNonce 1 with the nonce hint of 0 (its signed nonce)', A1, ROTATE,
    [k, keep(deviceAuth(A1, signedAt0, 0n))], WORD_H, [WORD_H],
    '', { control: { a: A1, args: [k, authFor(evmEip712Messages.rotateEncKey(frameOf(A1), k), 1n)] }, declaredRead: 'auth_nonce' });

  // ── the word check of an amount (be16): 11 shown and signed, 10 executed ──
  const AU = await depositedU();
  const tdU = evmEip712Messages.withdrawUnshielded(frameOf(AU), COL_U, 10n, RECIPIENT_U, TEST_SITE);
  const tdU11 = patch(tdU, (m) => { m.amount = '11'; });
  await negative('isolate', 'withdraw_unshielded: the amount hint of 11, shown and signed, 10 executed (the label is the executed amount\'s)', AU, WU,
    [COL_U, 10n, { bytes: RECIPIENT_U }, deviceAuth(AU, tdU11), keep({ ...evmEip712AmountHint(10n, TEST_SITE), amount: leHint(11n, 16) })], WORD_H, [WORD_H],
    '', { control: { a: AU, args: [COL_U, 10n, { bytes: RECIPIENT_U }, authFor(tdU)] } });

  // ── the word check of a change: 701 shown and signed, 700 executed ──
  const { a: AS, coin } = shieldedAccount([{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }], COL_A, 1);
  const tdS = shieldedMessage(WS, AS, 300n, coin);
  const tdS701 = patch(tdS, (m) => { m.change = '701'; });
  await negative('isolate', 'withdraw_shielded: the change hint of 701, shown and signed, 700 executed', AS, WS,
    shieldedArgs(WS, 300n, deviceAuth(AS, tdS701)).concat([keep({ ...evmEip712CoinHint(300n, coin.value, coin.mtIndex, TEST_SITE), change: leHint(701n, 16) })]), WORD_H, [WORD_H],
    '', { control: { a: AS, args: shieldedArgs(WS, 300n, authFor(tdS)) } });

  // ── the byte check of a target's key: a k256 target shown with another x ──
  const K = new K256Device(0x15a7en);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const kTd = evmEip712Messages.addDevice(frameOf(A0), kIn);
  const kCtl = { a: A0, args: [kIn, ...solArgs(kIn), authFor(kTd)] };
  const dh = evmEip712DescriptorHint(kIn);
  const forgedKey = [...dh.key]; forgedKey[3] ^= 1n;
  const shownX = Uint8Array.from(forgedKey.map(Number)).reverse();
  await negative('isolate', 'add_device: the k256 target\'s x hint with a byte changed, the shown x signed, the real x executed', A0, ADD,
    [kIn, ...solArgs(kIn), deviceAuth(A0, patch(kTd, (m) => { m.newDevice.x = hex(shownX); })), keep({ ...dh, key: forgedKey })], BYTE_H, [BYTE_H],
    '', { control: kCtl });

  // ── the removal's epoch (be4) and counter (be8), each shown and signed other than executed ──
  const AK = (await execute(Original.Contract, A0, ADD, kCtl.args)).after;
  const ep = ledgerOf(AK).device_epoch as bigint;
  const rmTd = (epoch: bigint, counter: bigint) => evmEip712Messages.removeDevice(frameOf(AK), kIn, epoch, counter);
  const NONE = { is_some: false, value: new Uint8Array(32) };
  const rmArgs = (auth: unknown, hint?: unknown) => [kIn, ...solArgs(kIn), ep, 0n, NONE, auth, ...(hint ? [hint] : [])];
  const rmCtl = { a: AK, args: rmArgs(authFor(rmTd(ep, 0n), counterOf(AK))) };
  await negative('isolate', `remove_device: targetEpoch ${ep + 1n} shown and signed, ${ep} executed (the epoch hint of ${ep + 1n})`, AK, REMOVE,
    rmArgs(deviceAuth(AK, rmTd(ep + 1n, 0n)), keep(evmEip712RemoveHint(kIn, ep + 1n, 0n))), WORD_H, [WORD_H], '', { control: rmCtl });
  await negative('isolate', 'remove_device: targetCounter 1 shown and signed, 0 executed (the counter hint of 1)', AK, REMOVE,
    rmArgs(deviceAuth(AK, rmTd(ep, 1n)), keep(evmEip712RemoveHint(kIn, ep, 1n))), WORD_H, [WORD_H], '', { control: rmCtl });
  // the two-form body's own membership check: an unenrolled key removes a live device
  const stranger = new SoftwareEvmWallet(0x5a7e5n);
  const strangerDevice = await EvmEip712Device.enrol(stranger, 'undeployed', 0);
  const sTd = evmEip712Messages.removeDevice({ account: AK.addressBytes, device: strangerDevice.address, authNonce: nonceOf(AK) }, kIn, ep, 0n);
  const sp = parseEvmSignature(stranger.signDigest(typedDataDigest(sTd)));
  await negative('isolate', 'remove_device: an unenrolled evm key signs the removal of a live device (the two-form body\'s membership check)', AK, REMOVE,
    rmArgs({ pk: strangerDevice.pk, use_counter: 0n, blind: strangerDevice.blind, sig: { r: sp.r, s: sp.s } }), UNKNOWN, [UNKNOWN], '', { control: rmCtl });

  // ── a grant: a scope cap and a site label shown other than executed ──
  const gWallet = new SoftwareEvmWallet(0x15a7e6n);
  const eg = await EvmEip712Grantee.enrol(gWallet, 'undeployed', AU.addressBytes, grantLabel('bank.example'), 0n);
  const egIn = eg.descriptor();
  const sc: IssueScope = { opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: COL_U,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: RECIPIENT_U, maxCoinValue: 300n, perCallCap: 300n, cap: 1000n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null };
  const iTd = evmEip712Messages.issueGrant(frameOf(AU), egIn, sc);
  const issueArgs = (auth: unknown, hint?: unknown) => [egIn, ...solArgs(egIn), ...evmEip712IssueArgs(sc), auth, ...(hint ? [hint] : [])];
  const iCtl = { a: AU, args: issueArgs(authFor(iTd)) };
  await negative('isolate', 'issue_grant: the cap hint of 1001, shown and signed, 1000 executed', AU, ISSUE,
    issueArgs(deviceAuth(AU, patch(iTd, (m) => { m.cap = '1001'; })), keep({ ...evmEip712IssueHint(egIn, sc), cap: leHint(1001n, 16) })), WORD_H, [WORD_H], '', { control: iCtl });
  const ih = evmEip712IssueHint(egIn, sc);
  const forgedLabel = [...ih.grantee.label]; forgedLabel[0] ^= 1n; // "bank.example" shown as "cank.example"
  await negative('isolate', 'issue_grant: the grantee\'s site label hint shown as "cank.example" and signed, "bank.example" executed', AU, ISSUE,
    issueArgs(deviceAuth(AU, patch(iTd, (m) => { m.grantee.siteLabel = 'c' + m.grantee.siteLabel.slice(1); })), keep({ ...ih, grantee: { ...ih.grantee, label: forgedLabel } })),
    BYTE_H, [BYTE_H], '', { control: iCtl });

  // ── the grant seam: an unrelated value as the digest, and a replay after the record's nonce advanced ──
  const AG = (await execute(Original.Contract, AU, ISSUE, iCtl.args)).after;
  const rec = ledgerOf(AG).grants.lookup(eg.grantId(AG.addressBytes));
  const opening = (spentPrev: bigint): GrantOpening => ({ originHash: eg.originHash, slot: 0n, scopeSalt: grantSaltOf(AG, eg.grantId(AG.addressBytes)), recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: RECIPIENT_U, maxCoinValue: 300n, spentPrev });
  const gFrame = (a: LocalAccount, r: { issued_at: bigint; nonce: bigint }) => ({ account: a.addressBytes, grantee: eg.address, label: eg.label, slot: 0n, issuedAt: r.issued_at, grantNonce: r.nonce });
  const gtd0 = evmEip712Messages.withdrawUnshieldedAsGrantee(gFrame(AG, rec), COL_U, 50n, RECIPIENT_U, TEST_SITE);
  const grantAuth = (a: LocalAccount, signed: Eip712TypedData, r: { issued_at: bigint }, grantNonce: bigint, digest = typedDataDigest(signed)) => {
    const p = parseEvmSignature(gWallet.signDigest(digest));
    return { arm: 'evm_eip712', pk: eg.pk, blind: eg.blind, label: eg.label, sig: { r: p.r, s: p.s },
      hint: evmEip712GrantSeamHint(eg.pk, a.addressBytes, digest, eg.label, r.issued_at, grantNonce), op: keep(evmEip712AmountHint(50n, TEST_SITE)) };
  };
  const honestG = (a: LocalAccount, r: any, spent: bigint) => {
    const t = evmEip712Messages.withdrawUnshieldedAsGrantee(gFrame(a, r), COL_U, 50n, RECIPIENT_U, TEST_SITE);
    const p = parseEvmSignature(gWallet.signDigest(typedDataDigest(t)));
    return [COL_U, 50n, { bytes: RECIPIENT_U }, ...grantAuthArgs(opening(spent), { arm: 'evm_eip712', pk: eg.pk, blind: eg.blind, label: eg.label, sig: { r: p.r, s: p.s } } as any)];
  };
  const gCtl = { a: AG, args: honestG(AG, rec, 0n) };
  await negative('isolate', 'grantee twin: the grantee\'s signature over an unrelated 32-byte value, passed as the digest hint', AG, GWU,
    [COL_U, 50n, { bytes: RECIPIENT_U }, ...grantAuthArgs(opening(0n), grantAuth(AG, gtd0, rec, rec.nonce, rnd(32)) as any)], DIGEST_H, [DIGEST_H], '', { control: gCtl });
  const AG1 = (await execute(Original.Contract, AG, GWU, gCtl.args)).after;
  const rec1 = ledgerOf(AG1).grants.lookup(eg.grantId(AG1.addressBytes));
  await negative('isolate', 'grantee twin: the approval made at grantNonce 0, replayed at grantNonce 1 with the nonce hint of 0 and the current spent opening', AG1, GWU,
    [COL_U, 50n, { bytes: RECIPIENT_U }, ...grantAuthArgs(opening(50n), grantAuth(AG1, gtd0, rec1, 0n) as any)], WORD_H, [WORD_H], '',
    { control: { a: AG1, args: honestG(AG1, rec1, 50n) }, declaredRead: "the grant record's nonce" });

  // ── the device key's coordinates: a y hint with a byte changed, against a
  //    boot commitment made over the address those bytes hash to ──
  const kh = evmEip712KeyHint(device.pk);
  const yForged = [...kh.y]; yForged[3] ^= 1n;
  const pre = new Uint8Array([...Uint8Array.from(kh.x.map(Number)).reverse(), ...Uint8Array.from(yForged.map(Number)).reverse()]);
  const forgedHash = keccak_256(pre);
  const forgedBoot = pc.derive_boot_commitment_with_evm_eip712(salt, forgedHash.subarray(12), device.blind);
  const actCtl = { a: await dormant(device.bootCommitment(salt), recoveryPk), args: device.activationArgs(salt) };
  await negative('isolate', 'activation: the key\'s y hint with a byte changed, the boot commitment made over the address those bytes hash to', await dormant(forgedBoot, recoveryPk), ACTIVATE,
    [device.pk, salt, device.blind, keep({ x: kh.x, y: yForged, key_hash: [...forgedHash].map(BigInt) })], BYTE_H, [BYTE_H], '', { control: actCtl });
}

// ═════════════════════════════════════════════════════════════════════════════
// The shared Ed25519 encoding checks at every place a Solana key enters, and
// the expiry's year split by its bound
// ═════════════════════════════════════════════════════════════════════════════
//
// A Solana key enters this arm as a target (add_device, remove_device by
// descriptor) or a grantee (issue_grant, revoke_grant). At each place the
// circuit passes the key's 32 encoded bytes both to the shared encoder, which
// checks them against the point (y, x and x's parity), and to the base58 text
// it shows. Each case breaks one of those checks: the encoding with one byte
// of y changed or with the other sign bit (shown in base58 and signed as
// shown, with the base58 inputs and the digest hint of that message), or the
// x bytes with one byte changed and x's parity kept (x is not shown, so the
// approval is the honest one; the call's hints are passed as built, so the
// forged bytes are not replaced by those of the point). Where the forged encoding names another entry
// or grant (a removal, a revocation), an upstream k256 device of the account
// plants that entry or grant raw, so the encoding check is the only one that
// refuses. Last, an expiry whose year split keeps the split's equation and
// breaks its bound: one leap day fewer, so the date one day later reads back
// to the same seconds. Each case proves the honest call through its own
// patched copy first.
if (SECTIONS.includes('places')) {
  section('places');
  const SOL_Y = "descriptor: the Ed25519 key bytes do not match the point's y";
  const SOL_X = "descriptor: the Ed25519 x bytes do not match the point's x";
  const SOL_SIGN = "descriptor: the Ed25519 sign bit is not x's parity";
  const SPLIT = 'display: the year split is not canonical';
  const ADD = 'add_device_with_evm_eip712', REMOVE = 'remove_device_with_evm_eip712', ISSUE = 'issue_grant_with_evm_eip712', REVOKE = 'revoke_grant_with_evm_eip712';
  const keep = <T extends object>(h: T): T => Object.assign(h, { [KEEP_HINTS]: true });
  const patch = (t: Eip712TypedData, f: (m: any) => void): Eip712TypedData => { const c = JSON.parse(JSON.stringify(t)); f(c.message); return c; };
  const u8 = (v: bigint[]) => Uint8Array.from(v.map(Number));
  const counterOf = (a: LocalAccount) => { for (let n = 0n; n < 64n; n++) if (ledgerOf(a).devices.member(device.entryAt(a.addressBytes, ledgerOf(a).device_epoch, n))) return n; throw new Error('device not live'); };
  // the device's approval of `signed` on `a`, with the seam hint of that message
  const deviceAuth = (a: LocalAccount, signed: Eip712TypedData) => {
    const digest = typedDataDigest(signed);
    const p = parseEvmSignature(wallet.signDigest(digest));
    return { pk: device.pk, use_counter: counterOf(a), blind: device.blind, sig: { r: p.r, s: p.s },
      hint: evmEip712SeamHint(device.pk, a.addressBytes, digest, ledgerOf(a).auth_nonce as bigint) };
  };
  const A0 = S6_A0!;
  // the Solana key, its encoding and x bytes, and the three forgeries: one
  // byte of y changed (byte 5, below the sign bit), the other sign bit, and
  // one byte of x changed (byte 5; x's parity is bit 0 of byte 0, kept)
  const solKey = ed25519.getPublicKey(fill(32, 0x9a));
  const sIn = evmEip712DescriptorInput({ scheme: 'sol_ed25519', key: solKey, blind: fill(32, 0x9b) });
  const [solPt, solBytes, solX] = solArgs(sIn) as unknown as [unknown, bigint[], bigint[]];
  const yForged = [...solBytes]; yForged[5] ^= 1n;
  const signForged = [...solBytes]; signForged[31] ^= 0x80n;
  const xForged = [...solX]; xForged[5] ^= 1n;
  const bytesOf: [string, bigint[], string][] = [['one byte of y changed', yForged, SOL_Y], ['the other sign bit', signForged, SOL_SIGN]];
  const self = (a: LocalAccount) => ({ bytes: a.addressBytes });

  // ── a Solana target of add_device ──
  const addTd = evmEip712Messages.addDevice(frameOf(A0), sIn);
  const addCtl = { a: A0, args: [sIn, ...solArgs(sIn), authFor(addTd)] };
  for (const [what, bytes, expect] of bytesOf) {
    await negative('places', `add_device: the Solana target's encoding with ${what}, shown in base58 and signed as shown`, A0, ADD,
      [sIn, solPt, bytes, solX, deviceAuth(A0, patch(addTd, (m) => { m.newDevice.publicKey = solanaKeyText(u8(bytes)); })),
        keep({ ...evmEip712DescriptorHint(sIn), b58: base58Inputs(u8(bytes)) })], expect, [expect], '', { control: addCtl });
  }

  // ── a Solana grantee of issue_grant ──
  const sgIn = evmEip712GranteeInput({ scheme: 'sol_ed25519', key: solKey, blind: fill(32, 0x9c) } as Descriptor, { label: grantLabel('bank.example') }, 0n);
  const sc: IssueScope = { opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: COL_U,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: RECIPIENT_U, maxCoinValue: 300n, perCallCap: 300n, cap: 1000n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null };
  const issueTd = (a: LocalAccount, scope = sc) => evmEip712Messages.issueGrant(frameOf(a), sgIn, scope);
  const issueCall = (a: LocalAccount, bytes: bigint[], x: bigint[], auth: unknown, hint?: unknown, scope = sc) =>
    [sgIn, solPt, bytes, x, ...evmEip712IssueArgs(scope), auth, ...(hint ? [hint] : [])];
  const issueCtl = (scope = sc) => ({ a: A0, args: [sgIn, ...solArgs(sgIn), ...evmEip712IssueArgs(scope), authFor(issueTd(A0, scope))] });
  const ih = evmEip712IssueHint(sgIn, sc);
  for (const [what, bytes, expect] of bytesOf) {
    await negative('places', `issue_grant: the Solana grantee's encoding with ${what}, shown in base58 and signed as shown`, A0, ISSUE,
      issueCall(A0, bytes, solX, deviceAuth(A0, patch(issueTd(A0), (m) => { m.grantee.publicKey = solanaKeyText(u8(bytes)); })),
        keep({ ...ih, grantee: { ...ih.grantee, b58: base58Inputs(u8(bytes)) } })), expect, [expect], '', { control: issueCtl() });
  }
  await negative('places', "issue_grant: the Solana grantee's x bytes with one byte changed (x's parity kept), under the honest approval", A0, ISSUE,
    issueCall(A0, solBytes, xForged, deviceAuth(A0, issueTd(A0)), keep(evmEip712IssueHint(sgIn, sc))), SOL_X, [SOL_X], '', { control: issueCtl() });

  // ── a Solana target of remove_device (descriptor form) ──
  // the account holds the device D, a k256 device K and the Solana target;
  // K plants raw the entries the two forged encodings name
  const K = new K256Device(0x9e57n);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const AK = (await execute(Original.Contract, A0, ADD, [kIn, ...solArgs(kIn), authFor(evmEip712Messages.addDevice(frameOf(A0), kIn), counterOf(A0))])).after;
  const AS = (await execute(Original.Contract, AK, ADD, [sIn, ...solArgs(sIn), authFor(evmEip712Messages.addDevice(frameOf(AK), sIn), counterOf(AK))])).after;
  const ep = ledgerOf(AS).device_epoch as bigint;
  let AP = AS, kUse = 0n;
  for (const [, bytes, expect] of bytesOf) {
    const copy = await loadPatched([expect]);
    const se = copy.pureCircuits.evm_eip712_sol_device_target(self(AP), sIn, solPt, bytes, solX, ep, 0n)[1];
    const entry = pc.evm_eip712_descriptor_entry(self(AP), sIn, se, ep, 0n);
    const kz = K.sign(k256Challenges.addDevice({ contractAddress: AP.addressBytes, authNonce: ledgerOf(AP).auth_nonce }, K.pk, entry), kUse);
    AP = (await execute(Original.Contract, AP, 'add_device_with_k256', [entry, kz.pk, kUse, kz.sig, 0n])).after;
    kUse++;
    if (!ledgerOf(AP).devices.member(entry)) throw new Error('setup: the planted entry is not in the device set');
  }
  const NONE = { is_some: false, value: new Uint8Array(32) };
  const rmTd = evmEip712Messages.removeDevice(frameOf(AP), sIn, ep, 0n);
  const rh = evmEip712RemoveHint(sIn, ep, 0n);
  const rmCtl = { a: AP, args: [sIn, ...solArgs(sIn), ep, 0n, NONE, authFor(rmTd, counterOf(AP))] };
  for (const [what, bytes, expect] of bytesOf) {
    await negative('places', `remove_device: the Solana target's encoding with ${what} (its entry planted), shown in base58 and signed as shown`, AP, REMOVE,
      [sIn, solPt, bytes, solX, ep, 0n, NONE, deviceAuth(AP, patch(rmTd, (m) => { m.target.publicKey = solanaKeyText(u8(bytes)); })),
        keep({ ...rh, target: { ...rh.target, b58: base58Inputs(u8(bytes)) } })], expect, [expect], '', { control: rmCtl });
  }
  await negative('places', "remove_device: the Solana target's x bytes with one byte changed (x's parity kept), under the honest approval", AP, REMOVE,
    [sIn, solPt, solBytes, xForged, ep, 0n, NONE, deviceAuth(AP, rmTd), keep(evmEip712RemoveHint(sIn, ep, 0n))], SOL_X, [SOL_X], '', { control: rmCtl });

  // ── a Solana grantee of revoke_grant ──
  // the account holds the Solana grant; K plants raw the grants the two
  // forged encodings name
  const AG = (await execute(Original.Contract, AS, ISSUE,
    [sgIn, ...solArgs(sgIn), ...evmEip712IssueArgs(sc), authFor(issueTd(AS), counterOf(AS))])).after;
  const plantScope: PlainScope = { opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: true,
    color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
    rpIdHash: new Uint8Array(32), readPkHash: fill(32, 0x1e), windowLen: 0n, windowCap: 0n, caller: undefined };
  const plantSalt = fill(32, 0x9f);
  let AGP = AG, gUse = 0n;
  for (const [, bytes, expect] of bytesOf) {
    const copy = await loadPatched([expect]);
    const oh = copy.pureCircuits.evm_eip712_grantee_origin_hash(sgIn);
    const si = copy.pureCircuits.evm_eip712_sol_grantee_target(self(AGP), sgIn, oh, solPt, bytes, solX)[1];
    const gid = copy.pureCircuits.evm_eip712_grantee_grant_id(self(AGP), sgIn, oh, si);
    const k = K.sign(k256Challenges.issueGrant({ contractAddress: AGP.addressBytes, authNonce: ledgerOf(AGP).auth_nonce }, K.pk, gid, scopeDigest(plantSalt, plantScope)), gUse);
    AGP = (await execute(Original.Contract, AGP, 'issue_grant_with_k256', [gid, ...scopeArgs(plantScope), plantSalt, k.pk, gUse, k.sig, 0n])).after;
    gUse++;
    if (!ledgerOf(AGP).grants.member(gid)) throw new Error('setup: the planted grant is not in the map');
  }
  const rvTd = evmEip712Messages.revokeGrant(frameOf(AGP), sgIn);
  const gh = evmEip712GranteeHint(sgIn);
  const rvCtl = { a: AGP, args: [sgIn, ...solArgs(sgIn), authFor(rvTd, counterOf(AGP))] };
  for (const [what, bytes, expect] of bytesOf) {
    await negative('places', `revoke_grant: the Solana grantee's encoding with ${what} (its grant planted), shown in base58 and signed as shown`, AGP, REVOKE,
      [sgIn, solPt, bytes, solX, deviceAuth(AGP, patch(rvTd, (m) => { m.grantee.publicKey = solanaKeyText(u8(bytes)); })),
        keep({ ...gh, b58: base58Inputs(u8(bytes)) })], expect, [expect], '', { control: rvCtl });
  }
  await negative('places', "revoke_grant: the Solana grantee's x bytes with one byte changed (x's parity kept), under the honest approval", AGP, REVOKE,
    [sgIn, solPt, solBytes, xForged, deviceAuth(AGP, rvTd), keep(evmEip712GranteeHint(sgIn))], SOL_X, [SOL_X], '', { control: rvCtl });

  // ── the expiry's year split: the equation kept, the bound broken ──
  // 2026-06-01 00:00:00 UTC with the split (5, 0, 5, 5): 400·5 + 4·5 + 5 =
  // 2025 = year − 1, but the last digit is above 3, so the split counts one
  // leap day fewer and the date one day later, 2026-06-02, reads back to the
  // same seconds; shown and signed as shown
  const v = BigInt(Date.UTC(2026, 5, 1) / 1000);
  const scD: IssueScope = { ...sc, expiresAt: v };
  const text = [...new TextEncoder().encode('2026-06-02 00:00:00 UTC'.padEnd(29, ' '))].map(BigInt);
  const ihD = evmEip712IssueHint(sgIn, scD);
  await negative('places', 'issue_grant: 2026-06-01 shown as 2026-06-02 with the year split (5, 0, 5, 5), which keeps the equation and breaks the bound (signed as shown)', A0, ISSUE,
    issueCall(A0, solBytes, solX, deviceAuth(A0, patch(issueTd(A0, scD), (m) => { m.expiry = String.fromCharCode(...text.map(Number)).slice(0, 23); })),
      keep({ ...ihD, expiry_text: text, year_split: [5n, 0n, 5n, 5n] }), scD), SPLIT, [SPLIT], '', { control: issueCtl(scD) });
}

await settleControls(true);
const verdict = errors ? 'ERROR' : failures ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  const suffix = `${DRY ? '-dry' : ''}${process.argv.slice(2).length ? `-${process.argv.slice(2).join('-')}` : ''}`;
  const file = path.join(process.env.EVIDENCE_DIR, `evm-eip712-prover${suffix}.json`);
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  // totals by refusing layer
  const totals: Record<string, number> = {};
  const bump = (k: string) => { totals[k] = (totals[k] ?? 0) + 1; };
  for (const r of results) {
    if (r.kind === 'positive') bump((r as any).notApplicable ? 'not applicable (reason recorded)' : r.positive?.proofServer?.length ? 'positive: proved at the proof server' : 'positive: state-only (simulator state check, no proof)');
    else if ((r as any).proverLevel) bump('negative: runtime-only (generated JavaScript; prover level unreachable, reason recorded)');
    else bump(`negative: refused at the proof server, layer ${r.refusal?.kind}${r.refusal?.kind === 'constraint' ? ` (${r.enforcement})` : ''}${r.prover?.verdict !== 'PASS' ? ` [verdict ${r.prover?.verdict}]` : ''}`);
    if (r.prover?.positiveControl) bump('positive controls proved through a negative\'s own patched copy');
  }
  fs.writeFileSync(file, JSON.stringify({ suite: 'evm-eip712-prover', sections: SECTIONS, ranAt: new Date().toISOString(), proofServer: DRY ? 'none (DRY: JavaScript layer only, not a verdict of record)' : CONFIG.proofServer, dry: DRY,
    device: { address: device.checksumAddress }, totalsByLayer: totals, cases: results, requests: proofLog.length, transportRetries, verdict,
  }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v), 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log(`\n◆ evm-eip712-prover${DRY ? ' DRY (JavaScript layer only; not a verdict of record)' : ''} [${SECTIONS.join(', ')}]: ${verdict} (${results.length} cases; ${failures} FAIL, ${errors} ERROR; ${proofLog.length} proof-server requests)`);
process.exit(verdict === 'PASS' ? 0 : 1);
