// Constraint-level negatives of the `sol_ed25519` arm, on local
// account states (no deploy, no node, no wallet), proved at the proof server.
//
// For every case:
//   positive   an honest call is proved by the proof server; through a
//              patched module copy, the honest call proved through that copy
//              (its positive control) precedes the copy's first negative of
//              each circuit, so a refusal is the tampering's; a negative of a
//              verification-input or readable-format check proves its own,
//              and every negative records the control it is attributed to;
//   simulator  the bad call, executed with the ORIGINAL module, is refused by
//              the generated JavaScript (or the runtime's own type checks)
//              with the expected message;
//   prover     the bad call, executed with the named asserts bypassed (and,
//              where a value the runtime refuses must reach the transcript,
//              named runtime functions overridden), is refused by the proof
//              server, the refusing request being the circuit under test.
//
// Sections (all by default; or name them on the command line):
//   activation   the identity key; a wrong blind, salt or key against
//                the boot commitment; small- and mixed-order keys (the
//                runtime's type check, then the proof server's decoding);
//   seam         rotate_enc_key_with_sol_ed25519: the binding of every
//                signed member (consistent display inputs), the replays, the
//                frame nibbles, R = O with the verification equation
//                holding, a flipped S bit, inconsistent display inputs; small-
//                and mixed-order R, S + L and a non-canonical limb encoding
//                of the signer's y at the proof server's decoding;
//   replay       what another arm's device signs for the same call,
//                the arm's own blind request and another operation's
//                approval, each signed raw by the Solana key;
//   frame        the seam owns the frame on the custody exports: the
//                wallet signed a message showing a foreign account;
//   custody      append_inbox and withdraw_unshielded: positives,
//                binding, inconsistent display inputs, operation separation,
//                the mirror's over-withdrawal (runtime only, reason recorded);
//   witness      withdraw_shielded and withdraw_shielded_to_contract on
//                a local Zswap tree: partial and full spends, then a valid
//                signature over one coin with held_coin answering another
//                (colour, value, nonce, Merkle index);
//   devices      add_device for all five target schemes (each entry the
//                target scheme's own derivation), removal by descriptor and by
//                the literal form, a plant at device_epoch + 1 evicted by
//                descriptor; the binding of each shown descriptor field, the
//                removal's counter, epoch, literal entry and form; the guards
//                under a valid signature (an unregistered tag, unshown fields
//                non-zero, the forms' unshown halves, S13, the last device,
//                a Solana target's point checks, the seam's A != O);
//   grants       issue_grant to sol_ed25519, k256 and passkey grantees,
//                revoke_grant, revoke_all_grants, the grantee twins; binding,
//                the arm's issue rules, the grantee's point, the grant seam's
//                replay, roles and frame;
//   grantee-scope the three grantee twins at the constraint
//                level, each a VALID grantee approval over an inadmissible
//                call: every scope check on its own (operation not in scope,
//                the object commitment's colour, the caller pin with no
//                contract caller and with another contract — the caller
//                injected into the local call context —; on a grant pinned
//                to the zero contract address, an absent caller (the presence
//                and type asserts, which share one message), a NON-CANONICAL
//                absent caller (is_some false, is_left true: the presence
//                assert alone) and a user caller (the type assert
//                alone); the per-call cap,
//                the spent opening, the cumulative cap, the max coin value,
//                the recipient pin), the record's liveness (revoked, expired,
//                a stale device epoch after a local recover_finalise, a stale
//                generation — unreachable while revoke_all_grants clears the
//                map, built by copying a ledger cell —, an unknown grant id and the record absent after
//                revoke_all_grants, both with the record read answered by a
//                runtime override), the grant seam's R = O, and for the
//                shielded twins the colour assert and the scope's object
//                check each on its own, the four signed substitutions (coin
//                nonce, Merkle index, change entry, encryption key), the coin
//                value, the amount and a stale encryption key;
//   frame-lifecycle the foreign-account frame on add_device,
//                remove_device (both forms), issue_grant, revoke_grant,
//                revoke_all_grants and the two shielded grantee twins (with
//                `frame`, `seam`, `grants` and `recovery`: every gated export);
//   recovery     publish_recovery_session_with_sol_ed25519 and
//                recover_cancel_with_sol_ed25519: positives, the binding of
//                every shown operand, operation, nonce and frame, inconsistent
//                display inputs, every assert of the shared chips reached
//                through the arm under a valid signature, the seam, the
//                replays, and after a finalised recovery every old device;
//   field-rendering the Field-to-Bytes<32> rendering of the recovery
//                lines is canonical: an approval over the non-canonical
//                rendering (value + r) of each phi and key coordinate;
//   readability  (the exact words; every number in full digits) the
//                message text of the circuits with amounts, caps, an expiry or
//                an RP hash, the honest calls proved, a forged amount, cap or
//                word signed by the wallet, forged digits;
//   rules        a passkey target's RP hash is
//                never zero (add_device, remove_device by descriptor); at
//                issue_grant the RP hash is non-zero exactly for a passkey
//                grantee whose scope can spend (zero for a read-only grant);
//                an any-recipient grant carries no recipient; each refused at
//                the constraint level under a valid signature over the
//                contract's own bytes;
//   hints        the verification's checked inputs (R's encoding and R's
//                x bytes) forged under a signature made over the forged
//                encoding, so only those checks can refuse: one byte
//                flipped, the sign bit flipped, y + p (also for y below 19,
//                as R = O) and x + p; and the carry attack (a byte of 256
//                or more, its neighbour minus one), which reaches the proof
//                server through a copy that encodes byte vectors with
//                two-byte atoms; and each encoding check on its own at every
//                key the arm checks (the signing key, a Solana target and
//                grantee, the grant seam's signer, the boot key), the forged
//                bytes rendered and signed, any entry, grant or boot
//                commitment derived from them;
//   module       the base modules' asserts that this arm's exports reach,
//                each under a valid signature: the Ed25519 class's A != O on
//                a grantee (issue_grant), an unregistered grant-id tag (the
//                arm's class check, then the module's width-64 recipe; at
//                runtime past the class check), a blank decimal (the
//                empty-decimal check), an unknown recipient kind and an
//                unknown k256 signing envelope (the renderer's labels).
//   arm-asserts  the arm's own asserts no other section refuses, each under
//                a valid signature over what the circuit renders: a second
//                activation; the read flag with a zero read key; the label
//                grammar (a site label and a grantee label with two spaces);
//                characters that differ from their bytes (a grantee label, a
//                passkey origin); a passkey origin ending in a control byte;
//                every unused descriptor field of a target and a grantee
//                non-zero (not shown, so the signature is over the contract's
//                own bytes); a literal removal's display inputs other than an
//                empty target's;
//   formats      the two signing formats at every circuit that verifies a
//                signature (the 12 device-gated exports, the 3 grantee
//                twins): the honest approval proved raw and as an off-chain
//                message v1, with the same key, blind, counters and operands
//                from one state, and the two calls' public parts equal (the
//                public transcript, the contract call's guaranteed and
//                fallible transcripts with their effects and gas, the state
//                after the call; the proof and the hiding communications
//                commitment excluded); each format's signature presented
//                with the other format's flag, for the same validly enrolled
//                device, refused by the proof server
//                (SOL_ED25519_FORMATS_CIRCUITS=<circuit,...> runs a subset);
//   display-module the base rendering module's asserts through this arm's
//                exports, each text signed as shown: the UTC expiry line's
//                shape, month, day and time of day, each text equal to the
//                expiry by the date arithmetic, and other words above the
//                range; the window digits (digits, leading zero, none, a digit
//                after the padding); a Solana target's base58 text with the
//                padding before its last character, a digit above 57, the
//                leading "1" dropped, the first read-back equation failing,
//                and the digits of a value with the other 128-bit half; the
//                site's amount label's grammar (a character after the
//                padding, a symbol starting with a digit, 19 decimals, a
//                9-character symbol, a leading zero) and its read-back; a
//                non-canonical year split with the date one day later (the
//                expiry's own seconds), refused by the split alone.
//
// Every prover-level negative records the refusing request's circuit (it must
// be the circuit under test) and the refusal's kind: `constraint` (the
// circuit's relation fails) or `decoding` (the honest proof server could not
// decode an input, which a malicious prover never runs). A
// constraint refusal is labelled by how the refused predicate is enforced
// against a malicious prover: `constraint` (a relation over the
// call's own inputs) or `constraint on a declared read (+ node transcript
// replay)` (the predicate tests a value the circuit reads from the ledger or
// the call context; the read is a declared public transcript value, so it is
// the node's transcript replay against the real state that refuses a false
// declaration, the constraint holding for the declared value).
//
// Needs a proof server at upstream's endpoint (CONFIG.proofServer); a missing
// proof server is an ERROR, never a pass. SOL_ED25519_DRY=1 runs the
// JavaScript layer only (no proof server; never a verdict of record). Writes
// $EVIDENCE_DIR/sol-ed25519-prover[-<sections>].json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { CONFIG } from '../node/wallet.js';
import {
  JubjubDevice, K256Device, K256Grantee, authArgs, grantAuthArgs, jubjubChallenges, k256Challenges, p256Challenges, originHash,
  RECIPIENT_USER_ADDRESS, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, RECIPIENT_CONTRACT_ADDRESS,
} from '../wallet/signer.js';
import { recoveryKey, signRecoverSubmit, recoverSubmitArgs, recoverSubmitChallenge, JUBJUB_IDENTITY, JUBJUB_ORDER_TWO } from '../wallet/recovery-gate.js';
import { DESCRIPTOR_TAGS, grantOriginHash, padTag } from '../wallet/descriptors.js';
import { base58Text32, utcDateTimeInputs } from '../wallet/rendering.js';
import * as sol from '../wallet/signer-sol-ed25519.js';
import * as msg from '../wallet/sol-ed25519-message.js';
import { softwarePasskey } from './p256-fixtures.js';
import { expectRefusal, expectSuccess, type BypassedContractModule, type NegativeResult, type PositiveResult } from './constraint-negative.js';
import {
  Original, loadPatched, dormant, execute, prove, ledgerOf, proofLog, withLocalCoins, coinStoreAnswering, localCoinPublicKeyBytes,
  transportRetries, overrideState, TYPE_OVERRIDES, LIMB_OVERRIDES, SL_OVERRIDES, CALLER_OVERRIDES, HINT_OVERRIDES, hintOverride, callerInjection,
  GRANT_ID_FORGE_OVERRIDES, grantIdForgery, withLedgerCell, zswapLog, type LocalAccount, type LocalCoin,
} from './sol-ed25519-negative.js';

const ALL = ['activation', 'seam', 'replay', 'frame', 'custody', 'witness', 'devices', 'grants', 'grantee-scope', 'frame-lifecycle', 'recovery', 'field-rendering', 'readability', 'rules', 'module', 'hints', 'arm-asserts', 'formats', 'display-module'];
const SECTIONS = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const s of SECTIONS) if (!ALL.includes(s)) throw new Error(`sol-ed25519-prover: unknown section ${s} (${ALL.join(', ')})`);
const DRY = process.env.SOL_ED25519_DRY === '1';

/** Deterministic bytes, one stream per section (a subset of sections draws
 *  the same values as the full run). */
const rng = (section: string) => {
  let ctr = 0;
  return (n = 32) => {
    const out = new Uint8Array(n);
    const tag = String(ctr++);
    for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(`sol-ed25519-prover/v1/${section}`).update(tag).update(`/${i}`).digest().subarray(0, Math.min(32, n - i)), i);
    return out;
  };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const Z32 = new Uint8Array(32);
const J = (v: any) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x)));

// circuits
const ACTIVATE = 'activate_initial_device_with_sol_ed25519';
const ROTATE = 'rotate_enc_key_with_sol_ed25519';
const APPEND = 'append_inbox_with_sol_ed25519';
const WU = 'withdraw_unshielded_with_sol_ed25519';
const WS = 'withdraw_shielded_with_sol_ed25519';
const WSC = 'withdraw_shielded_to_contract_with_sol_ed25519';
const ADD = 'add_device_with_sol_ed25519';
const REMOVE = 'remove_device_with_sol_ed25519';
const ISSUE = 'issue_grant_with_sol_ed25519';
const REVOKE = 'revoke_grant_with_sol_ed25519';
const REVOKE_ALL = 'revoke_all_grants_with_sol_ed25519';
const PUBLISH = 'publish_recovery_session_with_sol_ed25519';
const CANCEL = 'recover_cancel_with_sol_ed25519';
const GWU = 'withdraw_unshielded_with_grant_sol_ed25519';
const GWS = 'withdraw_shielded_with_grant_sol_ed25519';
const GWSC = 'withdraw_shielded_to_contract_with_grant_sol_ed25519';
// assert messages
const INVALID = 'invalid signature';
const GINVALID = 'invalid grant signature';
const UNKNOWN = 'unknown device entry';
const BOOT = 'boot commitment mismatch';
const RID = 'ed25519: R is the identity';
const HEXD = 'display: hex digits do not match the value';
const DIGITS = 'display: digits do not match the value';
const CLAIM = 'display: the site amount label does not match the value';
const LEADING = 'display: leading zero';
const ALIGN = 'display: not a left-aligned decimal';
const COLOUR = 'held coin colour does not match the withdrawn colour';
const ABOVE = "amount above the spent coin's value";
const INSUFFICIENT = 'insufficient balance';
const NOTREG = 'descriptor: not a registered device tag';
const W52 = 'descriptor: not a 52-byte device tag';
const AUTHORISING = 'cannot remove the authorising device';
const LAST = 'cannot remove last device';
const IDENTITY_KEY = 'ed25519: the key is the identity';
const KEY_IS_IDENTITY = 'descriptor: the Ed25519 key is the identity';
const NOT_POINT = "descriptor: the Ed25519 key is not the point's encoding";
// the Ed25519 core's encoding check, for keys and for R alike
const KEYY = "ed25519: the encoding does not match the point's y";
const KEYX = "ed25519: the x bytes do not match the point's x";
const KEYSIGN = "ed25519: the sign bit is not x's parity";
const UNUSED_KEY = 'descriptor: unused key bytes must be zero';
// the base rendering module's base58 checks
const B58LO = "display: the base58 digits do not match the value's low bytes";
const B58HI = "display: the base58 digits do not match the value's high bytes";
const B58CARRY = 'display: the base58 carry hints do not split the leading digits';
const B58LEAD = 'display: the leading base58 ones do not match the leading zero bytes';
const B58ALIGN = 'display: not a left-aligned base58 text';
const DATE = 'display: the date and time do not match the value';
const SPLIT = 'display: the year split is not canonical';
const NOTREG_GRANT = 'descriptor: not a registered grant-id tag';
const W52G = 'descriptor: not a 52-byte grant-id tag';
const EMPTY_DECIMAL = 'display: empty decimal';
const UNKNOWN_KIND = 'display: unknown recipient kind';
const ENVELOPE = 'display: unknown signing envelope';
const NOT_IN_SCOPE = 'operation not in scope';
const OBJECT = 'scope object mismatch';
const PER_CALL = 'amount above per-call cap';
const SPENT = 'spent opening mismatch';
const CUMULATIVE = 'cumulative cap exceeded';
const PIN = 'recipient not admitted by pin';
const NO_CALLER = 'grant requires a contract caller';
const CALLER_MISMATCH = 'grant caller mismatch';
const MAX_COIN = 'coin above max_coin_value';
const STALE_ENC = 'stale encryption key';
const REVOKED = 'grant revoked';
const EXPIRED = 'grant expired';
const EPOCH = 'grant epoch stale';
const GEN = 'grant generation stale';
const UNKNOWN_GRANT = 'unknown grant';
const PENDING = 'recovery pending; cancel first';
const EMPTY = 'phi must not be empty', RANGE = 'phi length out of range';
const SLOT2 = 'unused phi slot 2 not zero', SLOT3 = 'unused phi slot 3 not zero', SLOT4 = 'unused phi slot 4 not zero';
const SIDZERO = 'session nonce is zero', SIDREUSE = 'session nonce reused', PKREUSE = 'recovery commitment reused';
const IDENT = 'recovery key is the identity', SMALL = 'recovery key has small order';
const NOPENDING = 'no recovery pending';
const FQ = 52435875175126190479447740508185965837690552500527637822603658699938581184513n; // r, the BLS12-381 scalar field
const MAX128 = (1n << 128n) - 1n;
// the order-8 point (RFC 8032 torsion) used for small- and mixed-order values
const T8 = ed25519.Point.fromBytes(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex'), false);
const aff = (p: any) => { const q = p.toAffine(); return { x: q.x as bigint, y: q.y as bigint }; };
/** A point followed by its checked byte inputs, as the circuits take a key. */
const kin = (p: { x: bigint; y: bigint }): [{ x: bigint; y: bigint }, bigint[], bigint[]] => { const h = sol.solKeyHints(p); return [p, h.pk_bytes, h.pk_x]; };
/** The key argument (SolKey) of a point with its own consistent byte inputs. */
const keyOf = (p: { x: bigint; y: bigint }) => ({ pk: { x: p.x, y: p.y }, ...sol.solKeyHints(p) });

// ═════════════════════════════════════════════════════════════════════════════
// The harness
// ═════════════════════════════════════════════════════════════════════════════

type Expect = string | RegExp;
type RefusalKind = 'constraint' | 'decoding';
type Enforcement = 'constraint' | 'constraint on a declared read (+ node transcript replay)';
interface Result {
  section: string; circuit: string; case: string; kind: 'positive' | 'negative' | 'not applicable' | 'text' | 'state';
  expect?: string; bypassed?: string[]; overrides?: string; mutant?: string;
  positive?: PositiveResult | { verdict: string; reason: string; detail?: string; proofServer?: unknown[] };
  check?: { verdict: string; reason: string };
  simulator?: NegativeResult; prover?: NegativeResult;
  refusal?: { keyLocation?: string; kind: RefusalKind | 'none'; rule?: string; expectedKind: RefusalKind };
  enforcement?: Enforcement; proverLevel?: string; notApplicable?: string;
  /** the positive control this negative's refusal is attributed to: proved
   *  through the same patched copy for the same circuit, by this case itself
   *  (`own`) or by the earlier case named */
  control?: { case: string; own: boolean; copy: { bypassed: string[]; overrides?: string } };
}
// asserts whose predicate tests a ledger or call-context read
const READ_ASSERTS = new Set([UNKNOWN, UNKNOWN_GRANT, REVOKED, EPOCH, GEN, EXPIRED, STALE_ENC, PER_CALL, CUMULATIVE, PIN, MAX_COIN, NO_CALLER, CALLER_MISMATCH,
  OBJECT, SPENT, NOT_IN_SCOPE, INSUFFICIENT, 'already activated', BOOT, LAST, PENDING, NOPENDING, SIDREUSE, PKREUSE]);
const enforcementOf = (expect: Expect, name: string): Enforcement =>
  (typeof expect === 'string' && READ_ASSERTS.has(expect))
  || (typeof expect === 'string' && (expect === INVALID || expect === GINVALID) && /replay|nonce advanced|record nonce|stale|landed/i.test(name))
    ? 'constraint on a declared read (+ node transcript replay)' : 'constraint';
const matches = (detail: unknown, e: Expect) => (typeof e === 'string' ? String(detail ?? '').includes(e) : e.test(String(detail ?? '')));

const results: Result[] = [];
let failures = 0, errors = 0;
const tally = (...r: ({ verdict: string } | undefined)[]) => {
  for (const x of r) { if (!x) continue; if (x.verdict === 'FAIL') failures++; if (x.verdict === 'ERROR') errors++; }
};
const strip = <T>(x: T): T => (x ? { ...(x as any), result: undefined } : x);
const line = (r: Result) => {
  const parts = [r.positive && `positive ${r.positive.verdict}`, r.check && `check ${r.check.verdict}`, r.simulator && `simulator ${r.simulator.verdict}`,
    r.prover && `prover ${r.prover.verdict} (${r.prover.layer}${r.refusal ? `, ${r.refusal.kind}${r.refusal.rule ? ` ${r.refusal.rule}` : ''}` : ''})`,
    r.proverLevel && 'runtime only', r.notApplicable && 'not applicable'].filter(Boolean);
  const dry = (r as any).dryCopy as { verdict: string } | undefined;
  if (dry) parts.push(`copy ${dry.verdict} (DRY)`);
  const okAll = [r.positive, r.check, r.simulator, r.prover, dry].every((x) => !x || x.verdict === 'PASS');
  console.log(`  ${okAll ? '✓' : '✗'} [${r.section}] ${r.case}: ${parts.join(', ')}`);
  for (const [k, x] of [['positive', r.positive], ['check', r.check], ['simulator', r.simulator], ['prover', r.prover]] as const) {
    if (x && x.verdict !== 'PASS') console.log(`      ${k}: ${(x as any).reason} ${String((x as any).detail ?? '').slice(0, 500)}`);
  }
};

// One patched copy per (bypass list, overrides), reused across cases. Every
// negative's refusal is attributed to a positive control proved through the
// same copy for the same circuit: its own, or the first one proved there.
// The checks of the verification inputs and of the readable formats prove
// their own control for every case (CONTROL_PER_CASE).
const copies = new Map<string, BypassedContractModule>();
async function copyFor(bypass: string[], overrides = ''): Promise<BypassedContractModule> {
  const k = JSON.stringify([[...bypass].sort(), overrides]);
  if (!copies.has(k)) copies.set(k, await loadPatched(bypass, overrides));
  return copies.get(k)!;
}
const controlled = new Set<string>();
/** (copy file | circuit) -> the case whose control was proved there first */
const controlledBy = new Map<string, string>();
/** The asserts of the verification inputs (the key and R encodings) and of
 *  the readable formats (base58, the UTC date, the amount label, the literal
 *  removal's display inputs): a negative of one proves its own control. */
const OWN_CONTROL_ASSERTS = new Set([
  "ed25519: the key is the identity",
  "descriptor: unused key bytes must be zero",
  "display: a literal removal's display inputs are not those of an empty target",
  "display: day out of range",
  "display: leading zero in the site amount label",
  "display: month out of range",
  "display: not a UTC date and time",
  "display: not a left-aligned base58 text",
  "display: not the words for a time after 9999-12-31 23:59:59 UTC",
  "display: the base58 carry hints do not split the leading digits",
  "display: the base58 digits do not match the value's high bytes",
  "display: the base58 digits do not match the value's low bytes",
  "display: the date and time do not match the value",
  "display: the leading base58 ones do not match the leading zero bytes",
  "display: the site amount label does not match the value",
  "display: the year split is not canonical",
  "display: time of day out of range",
  "ed25519: the encoding does not match the point's y",
  "ed25519: the sign bit is not x's parity",
  "ed25519: the x bytes do not match the point's x",
]);
/** Sections all of whose negatives target those checks or the arm's own
 *  single asserts: each proves its own control. */
const OWN_CONTROL_SECTIONS = new Set(['hints', 'arm-asserts', 'display-module']);
const ownControl = (section: string, expect: Expect, bypass: string[]) =>
  OWN_CONTROL_SECTIONS.has(section) || OWN_CONTROL_ASSERTS.has(String(expect)) || bypass.some((m) => OWN_CONTROL_ASSERTS.has(m));

/** A positive: proved through `mod` (a patched copy, which records it as its
 *  positive control) or the original module; `check` runs on the state
 *  after the call and must return true. Returns that state (or undefined). */
async function positive(section: string, name: string, mod: BypassedContractModule | undefined, a: LocalAccount, circuit: string, args: unknown[],
  check?: (after: LocalAccount) => boolean | Promise<boolean>, hook?: () => void, capture?: (x: { call: any; after: LocalAccount; proven?: any }) => void): Promise<LocalAccount | undefined> {
  const r: Result = { section, circuit, case: name, kind: 'positive' };
  let after: LocalAccount | undefined;
  if (DRY) {
    try { hook?.(); const x = await execute((mod ?? Original).Contract, a, circuit, args); after = x.after; capture?.(x); r.positive = { verdict: 'PASS', reason: 'DRY: executed (not proved)' }; }
    catch (e: any) { r.positive = { verdict: 'FAIL', reason: 'DRY: execution failed', detail: String(e?.message ?? e) }; }
  } else {
    r.positive = strip(await expectSuccess({ name: `${circuit}: ${name}`, proofLog, through: mod,
      attempt: async () => { hook?.(); const x = await prove((mod ?? Original).Contract, a, circuit, args); after = x.after; capture?.(x); return x; } }));
    if (mod && r.positive.verdict === 'PASS') { controlled.add(`${mod.file}|${circuit}`); if (!controlledBy.has(`${mod.file}|${circuit}`)) controlledBy.set(`${mod.file}|${circuit}`, name); }
  }
  // DRY: the copy's execution stands in for the proof (the same bookkeeping)
  if (DRY && mod && r.positive.verdict === 'PASS' && !controlledBy.has(`${mod.file}|${circuit}`)) controlledBy.set(`${mod.file}|${circuit}`, name);
  if (check && r.positive.verdict === 'PASS') { const okc = await check(after!); r.check = { verdict: okc ? 'PASS' : 'FAIL', reason: okc ? 'state as expected' : 'state check failed' }; }
  tally(r.positive, r.check); results.push(r); line(r);
  return r.positive.verdict === 'PASS' && (!r.check || r.check.verdict === 'PASS') ? after : undefined;
}

interface NegOpts {
  /** the copy the prover level runs (default: copyFor(bypass, overrides)) */
  module?: BypassedContractModule;
  /** runtime overrides of the default copy */
  overrides?: string;
  /** what the overrides do (recorded) */
  overridesLabel?: string;
  /** the module the simulator runs (default: the original) */
  simulatorModule?: BypassedContractModule;
  /** what the simulator must be refused by, when it differs from `expect` */
  simulatorExpect?: Expect;
  /** the arguments the simulator runs, when they differ from the attempt's
   *  (e.g. S + L: the runtime refuses the scalar itself, while the attempt
   *  sends the honest scalar with only its encoding changed) */
  simulatorArgs?: unknown[];
  /** no simulator refusal exists (the tamper is an encoding the JavaScript
   *  never sees): the reason, recorded */
  noSimulator?: string;
  mutant?: string;
  kind?: RefusalKind;
  enforcement?: Enforcement;
  /** run before the simulator, the positive control and the attempt */
  hooks?: { simulator?: () => void; control?: () => void; attempt?: () => void };
  /** run after the case (e.g. clearing an override's target) */
  after?: () => void;
  /** a final check of a PASS (e.g. that an override fired): a reason to FAIL */
  check?: () => string | undefined;
}

/** One negative: refused by the simulator with `expect`, and by the proof
 *  server for `circuit` with `bypass` bypassed, of the expected kind. The
 *  copy first proves `control` (the honest call) through itself, once per
 *  (copy, circuit). */
async function negative(section: string, name: string, a: LocalAccount, circuit: string, args: unknown[], expect: Expect, bypass: string[],
  control: { a: LocalAccount; args: unknown[] } | undefined, opts: NegOpts = {}) {
  const kind = opts.kind ?? 'constraint';
  const r: Result = { section, circuit, case: name, kind: 'negative', expect: String(expect), bypassed: bypass,
    overrides: opts.overridesLabel ?? (opts.overrides ? 'runtime functions overridden' : undefined), mutant: opts.mutant };
  if (kind === 'constraint') r.enforcement = opts.enforcement ?? enforcementOf(expect, name);
  if (opts.noSimulator) (r as any).simulatorLevel = `no JavaScript refusal: ${opts.noSimulator}`;
  else {
    r.simulator = await expectRefusal({ name: `${circuit}: ${name} (generated JavaScript)`, expectedLayer: 'runtime', proofLog,
      attempt: () => { opts.hooks?.simulator?.(); return execute((opts.simulatorModule ?? Original).Contract, a, circuit, opts.simulatorArgs ?? args); } });
    if (r.simulator.verdict === 'PASS' && !matches(r.simulator.detail, opts.simulatorExpect ?? expect)) {
      r.simulator.verdict = 'FAIL'; r.simulator.reason = `refused at runtime, but not by ${String(opts.simulatorExpect ?? expect)}`;
    }
  }
  if (!DRY) {
    const patched = opts.module ?? await copyFor(bypass, opts.overrides ?? '');
    const key = `${patched.file}|${circuit}`;
    const own = ownControl(section, expect, bypass);
    const copyDesc = { bypassed: [...patched.bypassed].sort(), ...(r.overrides ? { overrides: r.overrides } : {}) };
    if ((own || !controlled.has(key)) && !control) {
      r.prover = { name, expectedLayer: 'prover', bypassed: patched.bypassed, overridden: Boolean(patched.overrides), startedAt: new Date().toISOString(), layer: 'none', verdict: 'ERROR',
        reason: own ? 'not a verdict: this check needs its own positive control and the case gives none' : 'not a verdict: no positive control through this copy for this circuit', fired: [], proofServer: [], ms: 0 } as any;
    } else {
      r.prover = await expectRefusal({ name: `${circuit}: ${name} (${opts.mutant ?? 'JavaScript checks bypassed'})`,
        expectedLayer: kind === 'decoding' ? 'decoding' : 'prover', bypassed: patched, proofLog, requirePositiveControl: true,
        positiveControl: (own || !controlled.has(key)) && control ? () => { opts.hooks?.control?.(); return prove(patched.Contract, control.a, circuit, control.args); } : undefined,
        attempt: () => { opts.hooks?.attempt?.(); return prove(patched.Contract, a, circuit, args); } });
      opts.after?.();
      if (r.prover.positiveControl?.verdict === 'PASS') { controlled.add(key); if (!controlledBy.has(key)) controlledBy.set(key, name); }
      if (r.prover.positiveControl?.verdict === 'PASS') r.control = { case: name, own: true, copy: copyDesc };
      else if (controlledBy.has(key)) r.control = { case: controlledBy.get(key)!, own: false, copy: copyDesc };
      else if (r.prover.verdict === 'PASS') { r.prover.verdict = 'ERROR'; r.prover.reason = 'not a verdict: no positive control through this copy for this circuit'; }
    }
    const rej = r.prover.rejection;
    r.refusal = { keyLocation: rej?.keyLocation, kind: rej ? (rej.kind as RefusalKind) : 'none', rule: rej?.rule, expectedKind: kind };
    if (r.prover.verdict === 'PASS') {
      // key locations read `contract:<address>/<circuit>?vk=<hash>`
      const refusedCircuit = rej?.keyLocation?.match(/\/([A-Za-z0-9_]+)(\?|$)/)?.[1] ?? rej?.keyLocation;
      if (refusedCircuit !== circuit) { r.prover.verdict = 'FAIL'; r.prover.reason = `refused by ${rej?.keyLocation ?? 'no recorded request'}, not by ${circuit}`; }
      else { const bad = opts.check?.(); if (bad) { r.prover.verdict = 'FAIL'; r.prover.reason = bad; } }
    }
    r.prover = strip(r.prover);
    if (r.prover.positiveControl) r.prover.positiveControl = strip(r.prover.positiveControl);
  } else {
    // DRY: the copy's JavaScript layer — the honest control runs through the
    // copy with no bypassed assert firing, and the attempt runs through it
    // with every bypassed assert firing (what the proof server then sees)
    const patched = opts.module ?? await copyFor(bypass, opts.overrides ?? '');
    const dry: { verdict: string; reason: string; detail?: string } = { verdict: 'PASS', reason: 'DRY: the copy executes the attempt with every bypassed assert firing' };
    const key = `${patched.file}|${circuit}`;
    const own = ownControl(section, expect, bypass);
    const copyDesc = { bypassed: [...patched.bypassed].sort(), ...(r.overrides ? { overrides: r.overrides } : {}) };
    if (control && (own || !controlledBy.has(key))) { r.control = { case: name, own: true, copy: copyDesc }; if (!controlledBy.has(key)) controlledBy.set(key, name); }
    else if (!own && controlledBy.has(key)) r.control = { case: controlledBy.get(key)!, own: false, copy: copyDesc };
    else Object.assign(dry, { verdict: 'FAIL', reason: own ? 'DRY: this check needs its own positive control and the case gives none' : 'DRY: no positive control through this copy for this circuit' });
    try {
      if (dry.verdict === 'PASS' && control) {
        patched.resetFired(); opts.hooks?.control?.();
        await execute(patched.Contract, control.a, circuit, control.args);
        const f = patched.fired();
        if (f.length) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: the control fired ${f.map((x) => x.message).join('; ')}` });
      }
      if (dry.verdict === 'PASS') {
        patched.resetFired(); opts.hooks?.attempt?.();
        await execute(patched.Contract, a, circuit, args);
        const f = patched.fired().map((x) => x.message);
        const missed = bypass.filter((m) => !f.includes(m));
        if (missed.length) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: bypassed but never fired: ${missed.join('; ')}` });
        else { const bad = opts.check?.(); if (bad) Object.assign(dry, { verdict: 'FAIL', reason: `DRY: ${bad}` }); }
      }
    } catch (e: any) {
      const chain: string[] = []; for (let x = e, i = 0; x && i < 6; x = x.cause, i++) chain.push(String(x?.message ?? x));
      Object.assign(dry, { verdict: 'FAIL', reason: 'DRY: the copy refused the call in JavaScript (it would never reach the proof server)', detail: chain.join(' | ').slice(0, 600) });
      if (process.env.SOL_ED25519_DEBUG) console.error(e);
    }
    opts.after?.();
    (r as any).dryCopy = dry;
    tally(dry);
    if (dry.verdict !== 'PASS') console.log(`      dry copy: ${dry.reason} ${dry.detail ?? ''}`);
  }
  tally(r.simulator, r.prover); results.push(r); line(r);
}

/** A negative that only the generated JavaScript can refuse, with the reason
 *  the prover level is unreachable from a JavaScript-built call (recorded,
 *  never counted as a constraint-level refusal). */
async function runtimeOnly(section: string, name: string, a: LocalAccount, circuit: string, args: unknown[], expect: Expect, why: string) {
  const r: Result = { section, circuit, case: name, kind: 'negative', expect: String(expect) };
  r.simulator = await expectRefusal({ name: `${circuit}: ${name} (generated JavaScript)`, expectedLayer: 'runtime', proofLog,
    attempt: () => execute(Original.Contract, a, circuit, args) });
  if (r.simulator.verdict === 'PASS' && !matches(r.simulator.detail, expect)) { r.simulator.verdict = 'FAIL'; r.simulator.reason = `refused at runtime, but not by ${String(expect)}`; }
  r.proverLevel = `not reachable from a JavaScript-built call: ${why}`;
  tally(r.simulator); results.push(r); line(r);
}
function notApplicable(section: string, circuit: string, name: string, why: string) {
  const r: Result = { section, circuit, case: name, kind: 'not applicable', notApplicable: why };
  results.push(r); line(r);
}
function stateOnly(section: string, name: string, okc: boolean) {
  const r: Result = { section, circuit: '(state)', case: name, kind: 'state', positive: { verdict: okc ? 'PASS' : 'FAIL', reason: okc ? 'state checked (simulator; no proof)' : 'unexpected state', proofServer: [] } };
  tally(r.positive); results.push(r); line(r);
}
function textCheck(section: string, name: string, okc: boolean, detail?: string) {
  const r: Result = { section, circuit: '(message text)', case: name, kind: 'text', positive: { verdict: okc ? 'PASS' : 'FAIL', reason: okc ? "the client's and the circuit's message shows it" : 'not shown', detail } };
  tally(r.positive); results.push(r); line(r);
}

// ── Devices, accounts and messages ──────────────────────────────────────────

type Dev = InstanceType<typeof sol.SolEd25519Device>;
async function solDevice(seed: Uint8Array): Promise<{ seed: Uint8Array; d: Dev }> {
  const s = sol.solSoftwareSigner(seed);
  return { seed, d: sol.SolEd25519Device.fromSigner(s, await sol.deriveSolBlind(s, { network: 'undeployed', accountIndex: 0 })) };
}
const ctxOf = (a: LocalAccount) => ({ contractAddress: a.addressBytes, authNonce: ledgerOf(a).auth_nonce as bigint });
const counterIn = (a: LocalAccount, d: Dev) => { const l = ledgerOf(a); for (let k = 0n; k < 64n; k++) if (l.devices.member(d.entryAt(a.addressBytes, l.device_epoch, k))) return k; return 0n; };
const withShow = (x: any, showArgs: unknown[]) => ({ ...x, showArgs });
const leInt = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
/** A signature with R = O for which [s]B == R + [k]A holds: s = k a mod L (a
 *  the key's secret scalar, from its seed), so only the Ed25519 core's R != O
 *  assert can refuse it. */
const rIdentityFor = (seed: Uint8Array, key: Uint8Array) => (message: Uint8Array) => {
  const h = sha512(seed).slice(0, 32); h[0] &= 248; h[31] &= 127; h[31] |= 64;
  const a = leInt(h) % sol.ED25519_L;
  const encO = new Uint8Array(32); encO[0] = 1;
  const k = leInt(sha512(new Uint8Array([...encO, ...key, ...message]))) % sol.ED25519_L;
  return { r: { x: 0n, y: 1n }, s: (k * a) % sol.ED25519_L };
};
/** The device's signature over `text` in its format as a wallet that signs
 *  whatever it is given makes it: the format's head, then the bytes, with no
 *  client-side check of the text (some cases sign texts the client refuses
 *  to build, such as one ending in a control byte). */
const signRawOver = async (d: Dev, text: Uint8Array) => {
  const head = msg.solMessageHead(d.format, d.key) as Uint8Array;
  const message = new Uint8Array(head.length + text.length); message.set(head); message.set(text, head.length);
  return { ...(await d.signBytes(message)), message };
};
/** A local account activated by `d` (recovery key `recoverySecret`). */
async function activated(d: Dev, salt: Uint8Array, recoverySecret?: bigint, window?: bigint): Promise<LocalAccount> {
  const rpk = recoverySecret === undefined ? JubjubDevice.generate().pk : recoveryKey(recoverySecret).pk;
  return (await execute(Original.Contract, await dormant(d.bootCommitment(salt), rpk, window), ACTIVATE, d.activationArgs(salt))).after;
}
const issueArgsOf = (g: any, sc: any, au: any, pk: unknown = msg.solTargetPointArg(g)) => [msg.solGranteeArg(g), pk, sc.opWithdrawUnshielded, sc.opWithdrawShielded,
  sc.opWithdrawShieldedToContract, sc.read, sc.color, sc.recipientKind, sc.recipient, sc.maxCoinValue, sc.perCallCap, sc.cap, sc.expiresAt, sc.rpIdHash, sc.readPk,
  sc.windowLen, sc.windowCap, { is_some: sc.caller !== null, value: { bytes: sc.caller ?? Z32 } }, ...authArgs(au)];
/** The scope salt issue_grant derives when device `d` issues on `a` (at its
 *  current auth_nonce), as the issuing client computes it for the grantee. */
const saltAt = (a: LocalAccount, d: Dev) => sol.solGrantScopeSalt(d.blind, a.addressBytes, ledgerOf(a).auth_nonce as bigint);
const scopeOf = (o: any = {}) => ({ opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: Z32, recipientKind: 0n,
  recipient: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n, rpIdHash: Z32, readPk: Z32, windowLen: 0n, windowCap: 0n, caller: null, ...o });

/** The frame negative: the wallet signed the message of `o` showing
 *  a FOREIGN account (its frame nibbles with it); only the seam's frame
 *  check (the display check of the account's hex) can refuse it. */
async function foreignFrameDevice(section: string, rnd: (n?: number) => Uint8Array, a: LocalAccount, d: Dev, site: string, circuit: string, o: any,
  argsOf: (au: any) => unknown[], label = circuit.replace('_with_sol_ed25519', '')) {
  const honest = await sol.authoriseSolDevice(d, ctxOf(a), site, o, counterIn(a, d));
  const frame = JSON.stringify(J(msg.solFrameNibbles(a.addressBytes, d.key)));
  const ix = honest.showArgs.findIndex((x) => JSON.stringify(J(x)) === frame);
  if (ix < 0) throw new Error(`foreignFrame: no frame nibbles in the display inputs of ${circuit}`);
  const foreign = rnd();
  const forged = [...honest.showArgs]; forged[ix] = msg.solFrameNibbles(foreign, d.key);
  const bytes = msg.solMessageBytes(msg.solDeviceMessageText({ site, account: foreign, key: d.key, nonce: ledgerOf(a).auth_nonce as bigint }, o));
  const { sig } = await d.signApproval(bytes);
  await negative(section, `${label}: the wallet signed a message showing a foreign account (seam-owned frame)`, a, circuit,
    argsOf({ ...honest, sig, showArgs: forged }), HEXD, [HEXD], { a, args: argsOf(honest) });
}
async function foreignFrameGrantee(section: string, rnd: (n?: number) => Uint8Array, a: LocalAccount, G: any, ctx: any, site: string, circuit: string, o: any,
  argsOf: (au: any) => unknown[], label = circuit.replace('_sol_ed25519', '')) {
  const honest = await sol.authoriseSolGrantee(G.device, ctx, site, o);
  const frame = JSON.stringify(J(msg.solFrameNibbles(a.addressBytes, G.key)));
  const ix = honest.showArgs.findIndex((x) => JSON.stringify(J(x)) === frame);
  if (ix < 0) throw new Error(`foreignFrame: no frame nibbles in the display inputs of ${circuit}`);
  const foreign = rnd();
  const forged = [...honest.showArgs]; forged[ix] = msg.solFrameNibbles(foreign, G.key);
  const bytes = msg.solMessageBytes(msg.solGranteeMessageText({ site, account: foreign, key: G.key, label: ctx.label, slot: ctx.slot, issuedAt: ctx.issuedAt, nonce: ctx.grantNonce }, o));
  const { sig } = await G.device.signApproval(bytes);
  await negative(section, `${label}: the grantee signed a message showing a foreign account (seam-owned frame)`, a, circuit,
    argsOf({ ...honest, sig, showArgs: forged }), HEXD, [HEXD], { a, args: argsOf(honest) });
}

// ═════════════════════════════════════════════════════════════════════════════
// activation
// ═════════════════════════════════════════════════════════════════════════════
async function sectionActivation() {
  const rnd = rng('activation');
  const { d } = await solDevice(rnd());
  const salt = rnd();
  const recoveryPk = JubjubDevice.generate().pk;
  const at = await dormant(d.bootCommitment(salt), recoveryPk);
  const control = { a: at, args: d.activationArgs(salt) };
  await positive('activation', 'honest activation (original module)', undefined, at, ACTIVATE, control.args,
    (after) => ledgerOf(after).booted === true && ledgerOf(after).devices.member(d.entryAt(after.addressBytes, ledgerOf(after).device_epoch, 0n)));
  // the identity: a boot commitment for O committed (computed with the
  // descriptor module's A != O bypassed); only A != O refuses it
  const O = { x: 0n, y: 1n };
  const blindO = rnd();
  const idCopy = await copyFor([KEY_IS_IDENTITY]);
  const atO = await dormant(idCopy.pureCircuits.derive_boot_commitment_with_sol_ed25519(salt, ...kin(O), blindO), recoveryPk);
  idCopy.resetFired();
  await negative('activation', 'the identity as the device key (its boot commitment committed): refused by the descriptor module\'s A != O', atO, ACTIVATE, [...kin(O), salt, blindO], KEY_IS_IDENTITY, [KEY_IS_IDENTITY], control);
  for (const [name, args] of [['wrong blind', [...kin(d.pk), salt, rnd()]], ['wrong salt', [...kin(d.pk), rnd(), d.blind]],
    ['another key (the committed blind)', [...kin(sol.solPublicKeyFromSeed(rnd()).pk), salt, d.blind]]] as [string, unknown[]][]) {
    await negative('activation', name, at, ACTIVATE, args, BOOT, [BOOT], control);
  }
  // small- and mixed-order keys: the runtime's point type refuses them; with
  // the validator overridden the proof server's input decoding does
  for (const [name, p] of [['a small-order key (order 8)', aff(T8)], ['a mixed-order key A + T8', aff(ed25519.Point.fromBytes(d.key, false).add(T8))]] as [string, { x: bigint; y: bigint }][]) {
    const blind = rnd();
    const typeCopy = await copyFor([], TYPE_OVERRIDES);
    const atT = await dormant(typeCopy.pureCircuits.derive_boot_commitment_with_sol_ed25519(salt, ...kin(p), blind), recoveryPk);
    const before = overrideState.typeBypass;
    await negative('activation', `${name} (honest-toolchain decoding refusal; in-circuit: the subgroup assignment)`, atT, ACTIVATE, [...kin(p), salt, blind], /Curve25519Point/, [], control,
      { overrides: TYPE_OVERRIDES, overridesLabel: 'Curve25519Point validator overridden (counted)', kind: 'decoding',
        check: () => (overrideState.typeBypass > before ? undefined : 'the type-check override never fired') });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// seam: rotate_enc_key_with_sol_ed25519
// ═════════════════════════════════════════════════════════════════════════════
async function sectionSeam() {
  const rnd = rng('seam');
  const SITE = 'Seam prover test';
  const { seed: seedA, d: device } = await solDevice(rnd());
  const salt = rnd();
  const A0 = await activated(device, salt);
  const k1 = rnd();
  const a1 = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'rotate_enc_key', newKey: k1 }, 0n);
  const A1 = await positive('seam', 'honest rotation (nonce 0, counter 0)', undefined, A0, ROTATE, [k1, ...authArgs(a1)])
    ?? (await execute(Original.Contract, A0, ROTATE, [k1, ...authArgs(a1)])).after;
  // negatives at nonce 1, counter 1
  const k2 = rnd();
  const a2 = await sol.authoriseSolDevice(device, ctxOf(A1), SITE, { op: 'rotate_enc_key', newKey: k2 }, 1n);
  const honestArgs = [k2, ...authArgs(a2)];
  const control = { a: A1, args: honestArgs };
  const { d: devB } = await solDevice(rnd());
  const bSig = (await sol.authoriseSolDevice(devB, ctxOf(A1), SITE, { op: 'rotate_enc_key', newKey: k2 }, 1n)).sig;
  const appendSig = (await sol.authoriseSolDevice(device, ctxOf(A1), SITE, { op: 'append_inbox', entry: rnd(192) }, 1n)).sig;
  // display inputs consistent with the executed values; the wallet's signature
  const cons = (newKey: Uint8Array, a: any, site = SITE) =>
    [newKey, ...authArgs({ ...a, showArgs: sol.solDeviceMessageCircuit(device.key, ctxOf(A1), site, { op: 'rotate_enc_key', newKey }).showArgs })];
  const rIdentity = rIdentityFor(seedA, device.key);
  const mDigits = await copyFor([DIGITS]);
  const mHex = await copyFor([HEXD]);
  // a signature over the message rendered with nonce digits "2" (the digit
  // check bypassed in the copy's pure circuit)
  const wrongNonceMsg: Uint8Array = mDigits.pureCircuits.sol_message_rotate_enc_key({ bytes: A1.addressBytes }, device.key, ledgerOf(A1).auth_nonce, k2,
    msg.solShow(SITE, 2n), a2.showArgs[1], a2.showArgs[2]);
  const wrongNonceSig = (await device.signApproval(wrongNonceMsg)).sig;
  // foreign frame nibbles (account; signing key), signed by the wallet
  const foreignAccountFrame = msg.solFrameNibbles(rnd(), device.key);
  const foreignKeyFrame = msg.solFrameNibbles(A1.addressBytes, sol.solSoftwareSigner(rnd()).publicKey);
  const mB58 = await copyFor([B58LO, B58HI]);
  const frameSig = async (frame: any, copy = mHex) => (await device.signApproval(copy.pureCircuits.sol_message_rotate_enc_key({ bytes: A1.addressBytes }, device.key,
    ledgerOf(A1).auth_nonce, k2, a2.showArgs[0], frame, a2.showArgs[2]))).sig;
  const NEG: [string, unknown[], Expect, string[]][] = [
    ['binding: another new key at execution (consistent display inputs)', cons(rnd(), a2), INVALID, [INVALID]],
    ['binding: another site label at execution (consistent display inputs)', cons(k2, a2, 'Another site'), INVALID, [INVALID]],
    ["binding: device B's signature with A's key", cons(k2, { ...a2, sig: bSig }), INVALID, [INVALID]],
    ['seam: another use counter', cons(k2, { ...a2, use_counter: 2n }), UNKNOWN, [UNKNOWN]],
    ['seam: another blind', cons(k2, { ...a2, blind: rnd() }), UNKNOWN, [UNKNOWN]],
    ['operation: the signature of another operation (append_inbox)', cons(k2, { ...a2, sig: appendSig }), INVALID, [INVALID]],
    ['replay: the landed signature at the current counter', cons(k1, { ...a1, use_counter: 1n }), INVALID, [INVALID]],
    ['replay: the landed authorisation (consumed entry; its old nonce fails the signature too)', cons(k1, a1), UNKNOWN, [UNKNOWN, INVALID]],
    ['seam: R = O with the verification equation holding (s = k a)', cons(k2, { ...a2, sig: rIdentity(a2.message) }), RID, [RID]],
    ['seam: a flipped S bit', cons(k2, { ...a2, sig: { r: a2.sig.r, s: a2.sig.s ^ 1n } }), INVALID, [INVALID]],
    ['display: the wallet shown nonce 2 while the call executes at nonce 1 (signed over the wrong digits)',
      [k2, ...authArgs({ ...a2, sig: wrongNonceSig, showArgs: [msg.solShow(SITE, 2n), a2.showArgs[1], a2.showArgs[2]] })], DIGITS, [DIGITS]],
    ['display: the hex nibbles of the signed key while another key executes', [rnd(), ...authArgs(a2)], HEXD, [HEXD]],
    ['frame: the frame shows a foreign account (signed over it)', [k2, ...authArgs({ ...a2, sig: await frameSig(foreignAccountFrame), showArgs: [a2.showArgs[0], foreignAccountFrame, a2.showArgs[2]] })], HEXD, [HEXD]],
    ['frame: the frame shows a foreign signing key in base58 (signed over it)', [k2, ...authArgs({ ...a2, sig: await frameSig(foreignKeyFrame, mB58), showArgs: [a2.showArgs[0], foreignKeyFrame, a2.showArgs[2]] })], B58LO, [B58LO, B58HI]],
  ];
  for (const [name, args, expect, bypass] of NEG) await negative('seam', name, A1, ROTATE, args, expect, bypass, control);
  // type-level degenerate R (the runtime's point type, then decoding)
  for (const [name, sig] of [['R of small order', { r: aff(T8), s: a2.sig.s }], ['R of mixed order', { r: aff(ed25519.Point.fromAffine(a2.sig.r).add(T8)), s: a2.sig.s }]] as [string, any][]) {
    const before = overrideState.typeBypass;
    await negative('seam', `degenerate: ${name} (honest-toolchain decoding refusal)`, A1, ROTATE, cons(k2, { ...a2, sig }), /Curve25519Point/, [INVALID], control,
      { overrides: TYPE_OVERRIDES, overridesLabel: 'Curve25519Point validator overridden (counted)', kind: 'decoding',
        check: () => (overrideState.typeBypass > before ? undefined : 'the type-check override never fired') });
  }
  // S + L: never a Curve25519Scalar in the runtime; at the proof server, the
  // honest signature's s sent as s + L in the scalar limbs
  {
    const nS = overrideState.nonCanonical;
    await negative('seam', 'degenerate: S + L (the runtime refuses s + L as a scalar; at the proof server the honest s sent as s + L in the scalar limbs: decoding refusal)', A1, ROTATE,
      honestArgs, /Curve25519Scalar|scalar|expected/i, [], control,
      { overrides: SL_OVERRIDES, overridesLabel: 'Curve25519Scalar encoder overridden for the target scalar', kind: 'decoding',
        simulatorArgs: cons(k2, { ...a2, sig: { r: a2.sig.r, s: a2.sig.s + sol.ED25519_L } }),
        hooks: { control: () => { overrideState.scalarTarget = undefined; }, attempt: () => { overrideState.scalarTarget = a2.sig.s; } },
        after: () => { overrideState.scalarTarget = undefined; },
        check: () => (overrideState.nonCanonical > nS ? undefined : 'the scalar encoder override never fired') });
  }
  // the honest call with only the signer's point's encoding changed
  {
    const nc = overrideState.nonCanonical;
    await negative('seam', "one point, one encoding: the signer's point with a non-canonical y limb encoding (y - 1 + p) (honest-toolchain decoding refusal)", A1, ROTATE,
      honestArgs, 'non-canonical', [], control,
      { overrides: LIMB_OVERRIDES, overridesLabel: 'Curve25519Point encoder overridden for the target point', kind: 'decoding',
        noSimulator: "the JavaScript holds the canonical point; only the limb encoding sent to the proof server is non-canonical",
        hooks: { control: () => { overrideState.target = undefined; }, attempt: () => { overrideState.target = { x: device.pk.x, y: device.pk.y }; } },
        after: () => { overrideState.target = undefined; },
        check: () => (overrideState.nonCanonical > nc ? undefined : 'the point encoder override never fired') });
  }
  await positive('seam', 'the honest rotation at nonce 1 after every refusal (original module)', undefined, A1, ROTATE, honestArgs);
}

// ═════════════════════════════════════════════════════════════════════════════
// replay, frame, custody, witness
// ═════════════════════════════════════════════════════════════════════════════
async function sectionCustody() {
  const rnd = rng('custody');
  const SITE = 'Custody prover test';
  const { d: device } = await solDevice(rnd());
  const A0 = await activated(device, rnd());
  const authFor = (a: LocalAccount, o: any) => sol.authoriseSolDevice(device, ctxOf(a), SITE, o, counterIn(a, device));
  const shownFor = (a: LocalAccount, o: any) => sol.solDeviceMessageCircuit(device.key, ctxOf(a), SITE, o).showArgs;
  const COL_U = fill(32, 0xc1), COL_X = fill(32, 0xc2), RECIPIENT_U = fill(32, 0x77);
  let AU = A0;
  for (const c of [COL_U, COL_X]) AU = (await execute(Original.Contract, AU, 'deposit_unshielded', [c, 1000n])).after;
  const amt = (color: Uint8Array, amount: bigint, decimals = 2, symbol = 'tTOK') => ({ color, amount, decimals, symbol });
  const COL_A = fill(32, 0xa1), COL_B = fill(32, 0xb2), NONCE_H = fill(32, 0x11), NONCE_OTHER = fill(32, 0x12), FILLER = (i: number) => fill(32, 0xf0 + i);
  const shieldedAccount = (coins: { nonce: Uint8Array; color: Uint8Array; value: bigint }[], key: Uint8Array, pick: number) => {
    const { account, coins: placed } = withLocalCoins(A0, coins);
    return { a: { ...account, privateState: coinStoreAnswering([{ key, coin: placed[pick] }]) } as LocalAccount, coin: placed[pick] };
  };
  const RECIPIENT_CONTRACT = fill(32, 0x3c);
  const recipientOf = (circuit: string) => (circuit === WS ? localCoinPublicKeyBytes() : RECIPIENT_CONTRACT);
  const sOp = (circuit: string, amount: bigint, coin: LocalCoin, color = COL_A) => ({
    op: circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract', amount: amt(color, amount, 0, 'tA'), recipient: recipientOf(circuit),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mt_index: coin.mtIndex } });
  const sArgs = (circuit: string, amount: bigint, au: any, color = COL_A) => [{ bytes: recipientOf(circuit) }, color, amount, ...authArgs(au)];

  if (SECTIONS.includes('replay')) {
    // what another arm's device signs for the same call, or the arm's own
    // blind request, signed raw by this Solana key; display inputs consistent
    const newKey = rnd();
    const aR = await authFor(A0, { op: 'rotate_enc_key', newKey });
    const ctlR = { a: A0, args: [newKey, ...authArgs(aR)] };
    await positive('replay', 'rotate_enc_key: honest (original module)', undefined, A0, ROTATE, ctlR.args);
    const k = K256Device.generate();
    const pass = softwarePasskey();
    const cctx = ctxOf(A0);
    const cases: [string, Uint8Array][] = [
      ["replay/arm: the k256 arm's rotate_enc_key challenge (same account, nonce, key) signed by the Solana key", k256Challenges.rotateEncKey(cctx, k.pk, newKey)],
      ["replay/arm: the p256 arm's rotate_enc_key challenge (same account, nonce, key) signed by the Solana key", p256Challenges.rotateEncKey(cctx, pass.pk, newKey)],
      ['replay/purpose: the blind request (non-authorising) signed by the same key', sol.solBlindMessage(device.key, { network: 'undeployed', accountIndex: 0 }).bytes],
      ['replay/operation: an append_inbox approval (same frame) signed by the same key', (await authFor(A0, { op: 'append_inbox', entry: rnd(192) })).message],
    ];
    for (const [name, bytes] of cases) {
      const { sig } = await device.signBytes(bytes);
      await negative('replay', name, A0, ROTATE, [newKey, ...authArgs({ ...aR, sig })], INVALID, [INVALID], ctlR);
    }
  }

  if (SECTIONS.includes('frame')) {
    const e = rnd(192);
    await foreignFrameDevice('frame', rnd, A0, device, SITE, APPEND, { op: 'append_inbox', entry: e }, (au) => [e, ...authArgs(au)]);
    await foreignFrameDevice('frame', rnd, AU, device, SITE, WU, { op: 'withdraw_unshielded', amount: amt(COL_U, 10n), recipient: RECIPIENT_U },
      (au) => [COL_U, 10n, { bytes: RECIPIENT_U }, ...authArgs(au)]);
    for (const circuit of [WS, WSC]) {
      const H = shieldedAccount([{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }], COL_A, 1);
      await foreignFrameDevice('frame', rnd, H.a, device, SITE, circuit, sOp(circuit, 300n, H.coin), (au) => sArgs(circuit, 300n, au));
    }
  }

  if (SECTIONS.includes('custody')) {
    const pass = await copyFor([]);
    const E1 = rnd(192), E2 = rnd(192);
    const aE = await authFor(A0, { op: 'append_inbox', entry: E1 });
    const ctlE = { a: A0, args: [E1, ...authArgs(aE)] };
    await positive('custody', 'append_inbox: honest (original module)', undefined, A0, APPEND, ctlE.args,
      (after) => ledgerOf(after).inbox_count === ledgerOf(A0).inbox_count + 1n);
    await negative('custody', 'append_inbox binding: signed E1, executed E2 (consistent display inputs)', A0, APPEND,
      [E2, ...authArgs(withShow(aE, shownFor(A0, { op: 'append_inbox', entry: E2 })))], INVALID, [INVALID], ctlE);
    const E1b = new Uint8Array(E1); E1b[191] ^= 1;
    await negative('custody', 'append_inbox binding: the last ciphertext byte flipped (consistent display inputs)', A0, APPEND,
      [E1b, ...authArgs(withShow(aE, shownFor(A0, { op: 'append_inbox', entry: E1b })))], INVALID, [INVALID], ctlE);
    await negative('custody', "append_inbox display: E2 executed with the signed entry's nibbles", A0, APPEND, [E2, ...authArgs(aE)], HEXD, [HEXD], ctlE);
    const aRot = await authFor(A0, { op: 'rotate_enc_key', newKey: E1.subarray(0, 32) });
    await negative('custody', 'append_inbox operation: a rotate_enc_key signature over the same nonce', A0, APPEND, [E1, ...authArgs({ ...aE, sig: aRot.sig })], INVALID, [INVALID], ctlE);
    const oU = { op: 'withdraw_unshielded', amount: amt(COL_U, 400n), recipient: RECIPIENT_U };
    const aU = await authFor(AU, oU);
    const ctlU = { a: AU, args: [COL_U, 400n, { bytes: RECIPIENT_U }, ...authArgs(aU)] };
    await positive('custody', 'withdraw_unshielded: honest 400 of 1000 (original module)', undefined, AU, WU, ctlU.args,
      (after) => ledgerOf(after).unshielded_balances.lookup(COL_U) === 600n);
    const aU1000 = await authFor(AU, { op: 'withdraw_unshielded', amount: amt(COL_U, 1000n), recipient: RECIPIENT_U });
    await positive('custody', 'withdraw_unshielded: the whole mirror, 1000 (patched path, no bypass)', pass, AU, WU, [COL_U, 1000n, { bytes: RECIPIENT_U }, ...authArgs(aU1000)]);
    const cons = (o: any) => [o.amount.color, o.amount.amount, { bytes: o.recipient }, ...authArgs(withShow(aU, shownFor(AU, o)))];
    await negative('custody', 'withdraw_unshielded binding: amount signed 400, executed 401', AU, WU, cons({ ...oU, amount: amt(COL_U, 401n) }), INVALID, [INVALID], ctlU);
    await negative('custody', 'withdraw_unshielded binding: colour signed U, executed X', AU, WU, cons({ ...oU, amount: amt(COL_X, 400n) }), INVALID, [INVALID], ctlU);
    await negative('custody', 'withdraw_unshielded binding: another recipient', AU, WU, cons({ ...oU, recipient: fill(32, 0x78) }), INVALID, [INVALID], ctlU);
    await negative('custody', "withdraw_unshielded binding: the site's decimal point moved (4.00 shown as 0.400)", AU, WU, cons({ ...oU, amount: amt(COL_U, 400n, 3) }), INVALID, [INVALID], ctlU);
    await negative('custody', "withdraw_unshielded display: 401 executed with the signed amount's digits", AU, WU,
      [COL_U, 401n, { bytes: RECIPIENT_U }, ...authArgs(aU)], DIGITS, [DIGITS, CLAIM], ctlU);
    const aOver = await authFor(AU, { op: 'withdraw_unshielded', amount: amt(COL_U, 1001n), recipient: RECIPIENT_U });
    await runtimeOnly('custody', 'withdraw_unshielded: over-withdrawal (1001 of a 1000 mirror), honestly signed', AU, WU,
      [COL_U, 1001n, { bytes: RECIPIENT_U }, ...authArgs(aOver)], INSUFFICIENT,
      "upstream's shared chip (debit_unshielded); with its assert bypassed, the generated JavaScript's type encoder refuses the negative balance, which is not an assert; in-circuit, the assert and the subtraction's range check refuse it");
    await negative('custody', 'withdraw_unshielded operation: an append_inbox signature over the same nonce', AU, WU,
      [COL_U, 400n, { bytes: RECIPIENT_U }, ...authArgs({ ...aU, sig: (await authFor(AU, { op: 'append_inbox', entry: E1 })).sig })], INVALID, [INVALID], ctlU);
  }

  if (SECTIONS.includes('witness')) {
    for (const circuit of [WS, WSC]) {
      const tag = circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract';
      const honestTree = [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }];
      const H = shieldedAccount(honestTree, COL_A, 1);
      const oH = sOp(circuit, 300n, H.coin);
      const aH = await authFor(H.a, oH);
      const ctl = { a: H.a, args: sArgs(circuit, 300n, aH) };
      await positive('witness', `${tag}: honest partial spend 300 of 1000 at index 1 (change 700)`, undefined, H.a, circuit, ctl.args);
      await positive('witness', `${tag}: honest full spend 1000 (change 0)`, undefined, H.a, circuit, sArgs(circuit, 1000n, await authFor(H.a, sOp(circuit, 1000n, H.coin))));
      // colour: the message shows colour A as the Token line, so the
      // signature still verifies: only the export's colour assert refuses
      const colour = shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_B, value: 1000n }], COL_A, 1);
      await negative('witness', `${tag}: valid signature for colour A, witness coin of colour B (same nonce, value, index)`, colour.a, circuit, sArgs(circuit, 300n, aH), COLOUR, [COLOUR], ctl);
      const sub = async (label: string, acc: { a: LocalAccount; coin: LocalCoin }) => {
        await negative('witness', `${tag}: ${label} (display inputs consistent with the substitute)`, acc.a, circuit,
          sArgs(circuit, 300n, withShow(aH, shownFor(acc.a, sOp(circuit, 300n, acc.coin)))), INVALID, [INVALID], ctl);
        return acc;
      };
      const value = await sub('valid signature for coin value 1000, witness coin of value 999', shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_A, value: 999n }], COL_A, 1));
      await negative('witness', `${tag}: witness coin of value 999 with the signed coin's digits (display check)`, value.a, circuit, sArgs(circuit, 300n, aH), DIGITS, [DIGITS], ctl);
      const nonce = await sub("valid signature for coin nonce N, witness coin of nonce N'", shieldedAccount([honestTree[0], { nonce: NONCE_OTHER, color: COL_A, value: 1000n }], COL_A, 1));
      await negative('witness', `${tag}: witness coin of nonce N' with the signed nonce's nibbles (display check)`, nonce.a, circuit, sArgs(circuit, 300n, aH), HEXD, [HEXD], ctl);
      const index = await sub('valid signature for Merkle index 1, witness coin H at index 2', shieldedAccount([honestTree[0], { nonce: FILLER(1), color: COL_A, value: 7n }, honestTree[1]], COL_A, 2));
      await negative('witness', `${tag}: witness coin at index 2 with the signed index's digits (display check)`, index.a, circuit, sArgs(circuit, 300n, aH), DIGITS, [DIGITS], ctl);
      const small = shieldedAccount([honestTree[0], { nonce: NONCE_H, color: COL_A, value: 200n }], COL_A, 1);
      await runtimeOnly('witness', `${tag}: witness coin of value 200 below the signed amount 300`, small.a, circuit, sArgs(circuit, 300n, aH), ABOVE,
        "the client renderer refuses to build such a message (no change digits exist); with the arm's assert bypassed, the change (value - amount) is negative and the generated JavaScript's type encoder refuses it, which is not an assert; in-circuit, the assert, the subtraction's range check and the signature over the shown value refuse it");
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// devices
// ═════════════════════════════════════════════════════════════════════════════
async function sectionDevices() {
  const rnd = rng('devices');
  const SITE = 'Devices prover test';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const authFor = (a: LocalAccount, o: any, d = S) => sol.authoriseSolDevice(d, ctxOf(a), SITE, o, counterIn(a, d));
  const shownFor = (a: LocalAccount, o: any) => sol.solDeviceMessageCircuit(S.key, ctxOf(a), SITE, o).showArgs;
  const live = (a: LocalAccount, e: Uint8Array) => ledgerOf(a).devices.member(e);
  const epochOf = (a: LocalAccount) => ledgerOf(a).device_epoch as bigint;
  const leN = (v: bigint, n: number) => { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  // the evm_k256 entry by its preimage pad32(tag) || account || address(20) || blind(32) || le4(epoch) || le8(counter)
  const evmEntry = (account: Uint8Array, address: Uint8Array, blind: Uint8Array, e: bigint, c: bigint): Uint8Array =>
    new Uint8Array(createHash('sha256').update(padTag(DESCRIPTOR_TAGS.device.evm_k256)).update(account).update(address).update(blind).update(leN(e, 4)).update(leN(c, 8)).digest());
  const jub = JubjubDevice.generate();
  const k1 = K256Device.generate();
  const pass = softwarePasskey();
  const evmAddr = rnd(20), evmBlind = rnd();
  const { d: S2 } = await solDevice(rnd());
  const targets: [string, any, (addr: Uint8Array, epoch: bigint, counter: bigint) => Uint8Array][] = [
    ['jubjub', { scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y }, (a, e, c) => jub.entryAt(a, e, c)],
    ['k256', { scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) }, (a, e, c) => k1.entryAt(a, e, c)],
    ['p256', { scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } }, (a, e, c) => pass.device.entryAt(a, e, c)],
    ['evm_k256', { scheme: 'evm_k256', address: evmAddr, blind: evmBlind }, (a, e, c) => evmEntry(a, evmAddr, evmBlind, e, c)],
    ['sol_ed25519', S2.descriptor(), (a, e, c) => S2.entryAt(a, e, c)],
  ];
  const addArgs = (t: any, au: any) => [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(au)];
  const pass0 = await copyFor([]);
  for (const [scheme, d, entryOf] of targets) {
    const t = sol.solTargetOf(d);
    const au = await authFor(A0, { op: 'add_device', target: t });
    const ep = epochOf(A0);
    await positive('devices', `add_device: a ${scheme} target by descriptor; the entry equals ${scheme === 'evm_k256' ? 'the spec recipe (SHA-256, recomputed)' : `the ${scheme} arm's own derivation`} at (epoch, 0); nothing at epoch + 1`,
      scheme === 'jubjub' ? pass0 : undefined, A0, ADD, addArgs(t, au),
      (after) => live(after, entryOf(after.addressBytes, ep, 0n)) && !live(after, entryOf(after.addressBytes, ep + 1n, 0n)) && ledgerOf(after).device_count === 2n);
  }
  // A1: S plus J, K and the passkey P
  let A1 = A0;
  for (const [, d] of targets.slice(0, 3)) {
    const t = sol.solTargetOf(d);
    A1 = (await execute(Original.Contract, A1, ADD, addArgs(t, await authFor(A1, { op: 'add_device', target: t })))).after;
  }
  const tJ = sol.solTargetOf(targets[0][1]), tK = sol.solTargetOf(targets[1][1]), tP = sol.solTargetOf(targets[2][1]);
  const ep1 = epochOf(A1);
  const remArgs = (literal: boolean, t: any, counter: bigint, epoch: bigint, entry: Uint8Array, au: any) => [literal, msg.solTargetArg(t), literal ? msg.solUnusedKey() : msg.solTargetPointArg(t), counter, epoch, entry, ...authArgs(au)];
  const oRemJ = { op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep1 };
  const ctlRem = { a: A1, args: remArgs(false, tJ, 0n, ep1, new Uint8Array(32), await authFor(A1, oRemJ)) };
  await positive('devices', 'remove_device by descriptor: the jubjub device J at (epoch, 0)', undefined, A1, REMOVE, ctlRem.args,
    (after) => !live(after, jub.entryAt(after.addressBytes, ep1, 0n)) && ledgerOf(after).device_count === 3n);
  const eK = k1.entryAt(A1.addressBytes, ep1, 0n);
  const ctlLit = { a: A1, args: remArgs(true, { tag: '' }, 0n, 0n, eK, await authFor(A1, { op: 'remove_device', literal: true, entry: eK })) };
  await positive('devices', 'remove_device by the literal form ("Removes a device this wallet cannot identify"): K\'s entry', undefined, A1, REMOVE, ctlLit.args,
    (after) => !live(after, eK) && ledgerOf(after).device_count === 3n);
  // the future-epoch plant: K enrols a sol entry at device_epoch + 1 through
  // upstream's raw add_device_with_k256; S evicts it by descriptor at that epoch
  const { d: Wd } = await solDevice(rnd());
  const plant = Wd.entryAt(A1.addressBytes, ep1 + 1n, 0n);
  const kAuth = k1.sign(k256Challenges.addDevice({ contractAddress: A1.addressBytes, authNonce: ledgerOf(A1).auth_nonce }, k1.pk, plant), 0n);
  const A2 = await positive('devices', 'plant: the upstream residual — k256 device K plants a sol_ed25519 entry at device_epoch + 1 (raw add_device_with_k256)', undefined, A1, 'add_device_with_k256', [plant, ...authArgs(kAuth)],
    (after) => live(after, plant));
  if (A2) {
    const tW = sol.solTargetOf(Wd.descriptor());
    const au = await authFor(A2, { op: 'remove_device', literal: false, target: tW, counter: 0n, epoch: ep1 + 1n });
    await positive('devices', 'plant: S evicts the planted entry by descriptor at target epoch device_epoch + 1', undefined, A2, REMOVE, remArgs(false, tW, 0n, ep1 + 1n, new Uint8Array(32), au),
      (after) => !live(after, plant));
  }
  // binding: a shown field changed at execution (consistent display inputs)
  const consAdd = async (a: LocalAccount, signed: any, executed: any) => {
    const au = await authFor(a, { op: 'add_device', target: signed });
    return addArgs(executed, withShow(au, shownFor(a, { op: 'add_device', target: executed })));
  };
  const ctlAdd = { a: A0, args: addArgs(tJ, await authFor(A0, { op: 'add_device', target: tJ })) };
  const flip = (b: Uint8Array) => { const o = new Uint8Array(b); o[0] ^= 1; return o; };
  const tE = sol.solTargetOf(targets[3][1]), tS2 = sol.solTargetOf(targets[4][1]);
  const B: [string, any, any][] = [
    ['the jubjub x coordinate', tJ, { ...tJ, a: flip(tJ.a!) }],
    ['the k256 envelope (0 -> 1)', tK, { ...tK, envelope: 1n }],
    ['the passkey origin', tP, { ...tP, origin: new TextEncoder().encode('https://b.example.com') }],
    ['the passkey RP hash', tP, { ...tP, c: flip((tP as any).c) }],
    ['the evm address', tE, { ...tE, address: flip((tE as any).address) }],
    ['the sol key (another valid key)', tS2, { ...tS2, a: sol.solSoftwareSigner(rnd()).publicKey }],
    ['the device privacy salt (sol)', tS2, { ...tS2, b: flip((tS2 as any).b) }],
    ['the scheme: a jubjub key signed, the same bytes executed as an evm target', tJ, { tag: DESCRIPTOR_TAGS.device.evm_k256, address: new Uint8Array(20), a: tJ.a }],
  ];
  for (const [name, signed, executed] of B) await negative('devices', `binding: add_device, ${name} changed at execution`, A0, ADD, await consAdd(A0, signed, executed), INVALID, [INVALID], ctlAdd);
  const consRem = async (signed: any, executed: any, a: LocalAccount = A1) => {
    const au = await authFor(a, signed);
    return executed.literal ? remArgs(true, { tag: '' }, 0n, 0n, executed.entry, withShow(au, shownFor(a, executed)))
      : remArgs(false, executed.target, executed.counter, executed.epoch, new Uint8Array(32), withShow(au, shownFor(a, executed)));
  };
  // the executed (epoch, counter) must name a LIVE entry: K plants J's entry there first
  const kPlant = async (a: LocalAccount, entry: Uint8Array) => {
    const l = ledgerOf(a);
    const kc = (() => { for (let c = 0n; c < 64n; c++) if (l.devices.member(k1.entryAt(a.addressBytes, l.device_epoch, c))) return c; throw new Error('K not live'); })();
    const ka = k1.sign(k256Challenges.addDevice({ contractAddress: a.addressBytes, authNonce: l.auth_nonce }, k1.pk, entry), kc);
    return (await execute(Original.Contract, a, 'add_device_with_k256', [entry, ...authArgs(ka)])).after;
  };
  {
    const Ac = await kPlant(A1, jub.entryAt(A1.addressBytes, ep1, 1n));
    const ctlRc = { a: Ac, args: remArgs(false, tJ, 0n, ep1, new Uint8Array(32), await authFor(Ac, oRemJ)) };
    await negative('devices', "binding: remove_device, the counter changed at execution (0 -> 1; J's counter-1 entry live)", Ac, REMOVE, await consRem(oRemJ, { ...oRemJ, counter: 1n }, Ac), INVALID, [INVALID], ctlRc);
    const Ae = await kPlant(A1, jub.entryAt(A1.addressBytes, ep1 + 1n, 0n));
    const ctlRe = { a: Ae, args: remArgs(false, tJ, 0n, ep1, new Uint8Array(32), await authFor(Ae, oRemJ)) };
    await negative('devices', "binding: remove_device, the epoch changed at execution (J's entry at epoch + 1 live)", Ae, REMOVE, await consRem(oRemJ, { ...oRemJ, epoch: ep1 + 1n }, Ae), INVALID, [INVALID], ctlRe);
  }
  await negative('devices', 'binding: remove_device, the literal entry changed at execution', A1, REMOVE,
    await consRem({ op: 'remove_device', literal: true, entry: eK }, { op: 'remove_device', literal: true, entry: jub.entryAt(A1.addressBytes, ep1, 0n) }), INVALID, [INVALID], ctlRem);
  await negative('devices', "binding: remove_device, the form swapped (a literal approval of J's entry executed as J's descriptor)", A1, REMOVE,
    await consRem({ op: 'remove_device', literal: true, entry: jub.entryAt(A1.addressBytes, ep1, 0n) }, oRemJ), INVALID, [INVALID], ctlRem);
  // guards under a VALID signature
  {
    // an unregistered tag: past the arm's registration check no kind is
    // named, so the message shows the first kind's tag text and key lines
    // (evm_k256's) and the entry takes its recipe (w52), whose admission
    // refuses the tag too; signed with both checks bypassed in the copy's
    // pure circuit, over an evm_k256-shaped target
    const mTag = await copyFor([NOTREG, W52]);
    const badArg = { ...msg.solTargetArg(tE), tag: padTag('midnight:account:device:zz:v9') };
    const shown = shownFor(A0, { op: 'add_device', target: tE });
    const bytes = mTag.pureCircuits.sol_message_add_device({ bytes: A0.addressBytes }, S.key, ledgerOf(A0).auth_nonce, badArg, ...shown);
    const { sig } = await S.signApproval(bytes);
    const au = { ...(await authFor(A0, { op: 'add_device', target: tE })), sig };
    await negative('devices', "guards: add_device, an unregistered tag under a valid signature (the message shows the first kind's text)", A0, ADD, [badArg, msg.solUnusedKey(), ...authArgs(au)], NOTREG, [NOTREG, W52],
      { a: A0, args: addArgs(tE, await authFor(A0, { op: 'add_device', target: tE })) });
  }
  {
    const odd = { ...msg.solTargetArg(tJ), envelope: 1n };
    const au = await authFor(A0, { op: 'add_device', target: tJ });
    const shE = au.showArgs as any[];
    await negative('devices', 'guards: add_device, a jubjub target carrying a non-zero envelope (not shown; refused by the canonical-descriptor check)', A0, ADD,
      [odd, msg.solTargetPointArg(tJ), ...authArgs(withShow(au, [msg.solTargetShow({ ...tJ, envelope: 1n } as any), shE[1], shE[2], shE[3]]))], 'descriptor: unused envelope must be zero', ['descriptor: unused envelope must be zero'], ctlAdd);
    const oddAddr = { ...msg.solTargetArg(tJ), address: rnd(20) };
    await negative('devices', 'guards: add_device, a jubjub target carrying a non-zero address (not shown; refused by the canonical-descriptor check)', A0, ADD,
      [oddAddr, msg.solTargetPointArg(tJ), ...authArgs(withShow(au, shownFor(A0, { op: 'add_device', target: { ...tJ, address: oddAddr.address } })))], 'descriptor: unused address must be zero', ['descriptor: unused address must be zero'], ctlAdd);
  }
  {
    const au = await authFor(A1, oRemJ);
    const hexWith = sol.solDeviceMessageCircuit(S.key, ctxOf(A1), SITE, oRemJ as any).showArgs as any[];
    const nib = msg.nibblesOf(...msg.solDeviceHexValues({ op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep1 } as any).slice(0, 4), eK);
    await negative('devices', 'guards: remove_device descriptor form carrying a non-zero literal entry (not shown; never executed)', A1, REMOVE,
      [false, msg.solTargetArg(tJ), msg.solTargetPointArg(tJ), 0n, ep1, eK, ...authArgs(withShow(au, [hexWith[0], hexWith[1], hexWith[2], nib]))], 'remove_device: a descriptor removal carries no literal entry',
      ['remove_device: a descriptor removal carries no literal entry'], ctlRem);
    const auL = await authFor(A1, { op: 'remove_device', literal: true, entry: eK });
    const lsh = sol.solDeviceMessageCircuit(S.key, ctxOf(A1), SITE, { op: 'remove_device', literal: true, entry: eK } as any).showArgs as any[];
    const nibL = msg.nibblesOf(...msg.solDeviceHexValues({ op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: 0n } as any).slice(0, 4), eK);
    await negative('devices', 'guards: remove_device literal form carrying a non-zero descriptor (not shown; never executed)', A1, REMOVE,
      [true, msg.solTargetArg(tJ), msg.solUnusedKey(), 0n, 0n, eK, ...authArgs(withShow(auL, [lsh[0], lsh[1], lsh[2], nibL]))], 'remove_device: a literal removal carries no descriptor',
      ['remove_device: a literal removal carries no descriptor'], ctlLit);
  }
  {
    const c = counterIn(A1, S);
    const tS = sol.solTargetOf(S.descriptor());
    const oS = { op: 'remove_device', literal: false, target: tS, counter: c + 1n, epoch: ep1 };
    await negative('devices', 'guards: S13, S removes its own post-roll entry by descriptor', A1, REMOVE, remArgs(false, tS, c + 1n, ep1, new Uint8Array(32), await authFor(A1, oS)), AUTHORISING, [AUTHORISING], ctlRem);
    const ownNext = S.entryAt(A1.addressBytes, ep1, c + 1n);
    await negative('devices', 'guards: S13, S removes its own post-roll entry by the literal form', A1, REMOVE,
      remArgs(true, { tag: '' }, 0n, 0n, ownNext, await authFor(A1, { op: 'remove_device', literal: true, entry: ownNext })), AUTHORISING, [AUTHORISING], ctlLit);
    const lone = rnd();
    await negative('devices', 'guards: the last device, S alone removes another entry (literal form)', A0, REMOVE,
      remArgs(true, { tag: '' }, 0n, 0n, lone, await authFor(A0, { op: 'remove_device', literal: true, entry: lone })), LAST, [LAST, UNKNOWN], { a: A1, args: ctlLit.args });
  }
  // a Solana target is a point whose encoding the circuit derives
  {
    const other = sol.solSoftwareSigner(rnd()).publicKey;
    const au = await authFor(A0, { op: 'add_device', target: tS2 });
    // the message shows the key argument's bytes (the wallet signs that key);
    // the descriptor's `a` is another key, whose hex nibbles are supplied
    const mOther = sol.solDeviceMessageCircuit(S.key, ctxOf(A0), SITE, { op: 'add_device', target: { ...tS2, a: other } });
    const shOther = mOther.showArgs as any[];
    const auOther = { ...au, sig: (await S.signApproval(mOther.bytes)).sig,
      showArgs: [shOther[0], shOther[1], shOther[2], msg.nibblesOf(...msg.solDeviceHexValues({ op: 'add_device', target: tS2 } as any))] };
    await negative('devices', "guards: a sol target whose descriptor key is not its key argument's (the message shows the key argument's; only the descriptor check refuses)", A0, ADD,
      [msg.solTargetArg(tS2), keyOf(msg.solTargetPoint(other)), ...authArgs(auOther)], NOT_POINT, [NOT_POINT], ctlAdd);
    const auJ = await authFor(A0, { op: 'add_device', target: tJ });
    await negative('devices', 'guards: a jubjub target carrying a non-identity point (not shown; refused by the canonical-descriptor check)', A0, ADD,
      [msg.solTargetArg(tJ), { ...msg.solUnusedKey(), pk: msg.solTargetPoint(other) }, ...authArgs(auJ)], 'descriptor: unused point must be the identity', ['descriptor: unused point must be the identity'], ctlAdd);
    // the identity as a sol target: the message renders 0100..00 and the
    // wallet signs it; only the derivation's A != O refuses
    const idKey = new Uint8Array(32); idKey[0] = 1;
    const tId = { tag: DESCRIPTOR_TAGS.device.sol_ed25519, a: idKey, b: rnd() };
    const idArg = { ...msg.solTargetArg({ tag: 'midnight:account:device:v1' } as any), tag: padTag(DESCRIPTOR_TAGS.device.sol_ed25519), a: idKey, b: tId.b };
    const shownId = [msg.solTargetShow(tId as any), msg.solShow(SITE, ledgerOf(A0).auth_nonce), msg.solFrameNibbles(A0.addressBytes, S.key), msg.nibblesOf(...msg.solDeviceHexValues({ op: 'add_device', target: tId } as any))];
    const idBytes = Original.pureCircuits.sol_message_add_device({ bytes: A0.addressBytes }, S.key, ledgerOf(A0).auth_nonce, idArg, ...shownId);
    const auId = { ...au, sig: (await S.signApproval(idBytes)).sig, showArgs: shownId };
    await negative('devices', 'guards: the identity point as a sol target (its encoding 0100..00 shown and signed): refused by A != O in the derivation', A0, ADD,
      [idArg, keyOf({ x: 0n, y: 1n }), ...authArgs(auId)], KEY_IS_IDENTITY, [KEY_IS_IDENTITY], ctlAdd);
  }
  // the seam's A != O: an identity sol entry planted through an upstream
  // arm's raw add_device (that pure derivation checks no key), then a call
  // for the identity key
  {
    const idKey = new Uint8Array(32); idKey[0] = 1; // the RFC 8032 encoding of O = (0, 1)
    const idBlind = rnd();
    const kA = ledgerOf(A1);
    const le = (v: bigint, n: number) => { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
    const idEntry = new Uint8Array(createHash('sha256').update(new Uint8Array([...padTag(DESCRIPTOR_TAGS.device.sol_ed25519), ...A1.addressBytes, ...idKey, ...idBlind, ...le(kA.device_epoch, 4), ...le(0n, 8)])).digest());
    const kc = (() => { for (let c = 0n; c < 64n; c++) if (kA.devices.member(k1.entryAt(A1.addressBytes, kA.device_epoch, c))) return c; throw new Error('K not live'); })();
    const kAuth2 = k1.sign(k256Challenges.addDevice({ contractAddress: A1.addressBytes, authNonce: kA.auth_nonce }, k1.pk, idEntry), kc);
    const AO = await positive('devices', "guards (e) setup: k256 device K plants the identity's sol entry (raw add_device_with_k256; the pure derivation checks no key)", undefined, A1, 'add_device_with_k256', [idEntry, ...authArgs(kAuth2)],
      (after) => live(after, idEntry));
    if (AO) {
      // a signature valid for A = O: R = [s]B, so [s]B == R + [k]O holds
      const sc = 12345678901234567890n;
      const R = ed25519.Point.BASE.multiply(sc).toAffine();
      const newKey = rnd();
      const idShow = sol.solDeviceMessageCircuit(idKey, ctxOf(AO), SITE, { op: 'rotate_enc_key', newKey }).showArgs;
      const auth = { pk: { x: 0n, y: 1n }, ...sol.solKeyHints({ x: 0n, y: 1n }), blind: idBlind, use_counter: 0n, offchain: false, sig: { r: { x: R.x, y: R.y }, s: sc }, ...sol.solSignatureHints({ r: { x: R.x, y: R.y }, s: sc }) };
      const honestRot = await authFor(AO, { op: 'rotate_enc_key', newKey });
      await negative('devices', "guards (e): the seam's A != O — a call signed for the identity key (its entry planted, the verification equation holding) is refused only by A != O (the descriptor module's signer derivation and the verification's identity-key assert)", AO, ROTATE,
        [newKey, ...idShow, auth], KEY_IS_IDENTITY, [KEY_IS_IDENTITY, IDENTITY_KEY], { a: AO, args: [newKey, ...authArgs(honestRot)] });
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// grants
// ═════════════════════════════════════════════════════════════════════════════
async function sectionGrants() {
  const rnd = rng('grants');
  const SITE = 'Grants prover test';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const authFor = (a: LocalAccount, o: any) => sol.authoriseSolDevice(S, ctxOf(a), SITE, o, counterIn(a, S));
  const shownFor = (a: LocalAccount, o: any) => sol.solDeviceMessageCircuit(S.key, ctxOf(a), SITE, o).showArgs;
  /** A valid signature over the CONTRACT's own bytes for a call the client's
   *  renderer refuses to build (the issue rules it mirrors), so only the
   *  circuit can refuse it. */
  const circuitAuth = async (a: LocalAccount, o: any) => {
    const { bytes, showArgs } = sol.solDeviceMessageCircuit(S.key, ctxOf(a), SITE, o);
    return { ...(await authFor(a, { op: 'revoke_all_grants' })), ...(await signRawOver(S, bytes)), showArgs };
  };
  const gSigner = sol.solSoftwareSigner(rnd());
  const G = await sol.SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const K = K256Grantee.generate();
  const ohK = originHash('https://k.example');
  const pass = softwarePasskey();
  const gG = G.grantee(0n);
  const gK = sol.solGranteeOf({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 } as any, { originHash: ohK }, 0n);
  const gP = sol.solGranteeOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y } as any, { origin: pass.policy.origin }, 0n);
  const COL_U = fill(32, 0xc1), PINNED = fill(32, 0x77);
  const scope = (o: any = {}) => scopeOf({ opWithdrawUnshielded: true, color: COL_U, maxCoinValue: 600n, perCallCap: 600n, cap: 1000n, ...o });
  const sU = scope({ recipientKind: RECIPIENT_USER_ADDRESS, recipient: PINNED });
  const saltU = saltAt(A0, S);
  const auG = await authFor(A0, { op: 'issue_grant', grantee: gG, ...sU });
  const ctlIssue = { a: A0, args: issueArgsOf(gG, sU, auG) };
  const A1 = await positive('grants', 'issue_grant to a sol_ed25519 grantee (unshielded, recipient pinned)', undefined, A0, ISSUE, ctlIssue.args,
    (after) => ledgerOf(after).grants.member(G.grantId(after.addressBytes, 0n)));
  await positive('grants', 'issue_grant to a k256 grantee (the labelled origin hash)', undefined, A0, ISSUE, issueArgsOf(gK, sU, await authFor(A0, { op: 'issue_grant', grantee: gK, ...sU })),
    (after) => ledgerOf(after).grants.member(K.grantId(after.addressBytes, ohK, 0n)));
  const sP = scope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), rpIdHash: Z32, color: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
  await positive('grants', 'issue_grant to a passkey grantee (read-only, so no RP hash)', undefined, A0, ISSUE, issueArgsOf(gP, sP, await authFor(A0, { op: 'issue_grant', grantee: gP, ...sP })),
    (after) => ledgerOf(after).grants.member(pass.grantee.grantId(after.addressBytes, grantOriginHash(pass.policy.origin), 0n)));
  const cons = (signed: any, eg: any, esc: any) => issueArgsOf(eg, esc, withShow(signed, shownFor(A0, { op: 'issue_grant', grantee: eg, ...esc })));
  await negative('grants', 'issue binding: the cap changed at execution', A0, ISSUE, cons(auG, gG, { ...sU, cap: 999n }), INVALID, [INVALID], ctlIssue);
  await negative('grants', 'issue binding: a caller pin added at execution', A0, ISSUE, cons(auG, gG, { ...sU, caller: rnd() }), INVALID, [INVALID], ctlIssue);
  await negative('grants', 'issue binding: the grantee label changed', A0, ISSUE, cons(auG, { ...gG, label: 'Other dApp' }, sU), INVALID, [INVALID], ctlIssue);
  await negative('grants', 'issue binding: the grantee slot changed', A0, ISSUE, cons(auG, { ...gG, slot: 1n }, sU), INVALID, [INVALID], ctlIssue);
  const auK = await authFor(A0, { op: 'issue_grant', grantee: gK, ...sU });
  const flip = (b: Uint8Array) => { const o = new Uint8Array(b); o[0] ^= 1; return o; };
  await negative('grants', "issue binding: the k256 grantee's labelled origin hash changed", A0, ISSUE, cons(auK, { ...gK, originHash: flip(ohK) }, sU), INVALID, [INVALID], ctlIssue);
  const sRead = scope({ readPk: rnd() });
  await negative('grants', 'issue rule: a read key without read (a valid signature over the contract\'s bytes; the renderer refuses this message)', A0, ISSUE, issueArgsOf(gG, sRead, await circuitAuth(A0, { op: 'issue_grant', grantee: gG, ...sRead })),
    'sol_ed25519: a read key without read', ['sol_ed25519: a read key without read'], ctlIssue);
  const sRp = scope({ rpIdHash: rnd() });
  await negative('grants', 'issue rule: an RP hash on a non-passkey grantee (a valid signature over the contract\'s bytes; the renderer refuses this message)', A0, ISSUE, issueArgsOf(gG, sRp, await circuitAuth(A0, { op: 'issue_grant', grantee: gG, ...sRp })),
    'sol_ed25519: an RP hash belongs to a passkey grantee', ['sol_ed25519: an RP hash belongs to a passkey grantee'], ctlIssue);
  {
    // the message shows the key argument's bytes (the wallet signs that key);
    // the descriptor's `a` is the grantee's key, whose hex nibbles are supplied
    const other = sol.solSoftwareSigner(rnd()).publicKey;
    const mO = sol.solDeviceMessageCircuit(S.key, ctxOf(A0), SITE, { op: 'issue_grant', grantee: { ...gG, a: other }, ...sU } as any);
    const shO = mO.showArgs as any[];
    const hexG = (shownFor(A0, { op: 'issue_grant', grantee: gG, ...sU }) as any[]).at(-1);
    const auO = { ...auG, sig: (await S.signApproval(mO.bytes)).sig, showArgs: [...shO.slice(0, -1), hexG] };
    await negative('grants', "issue: the grantee's descriptor key is not its key argument's (the message shows the key argument's; only the descriptor check refuses)", A0, ISSUE,
      issueArgsOf(gG, sU, auO, keyOf(msg.solTargetPoint(other))), NOT_POINT, [NOT_POINT], ctlIssue);
  }
  if (A1) {
    const auR = await authFor(A1, { op: 'revoke_grant', grantee: gG });
    const ctlRev = { a: A1, args: [msg.solGranteeArg(gG), msg.solTargetPointArg(gG), ...authArgs(auR)] };
    await positive('grants', 'revoke_grant by descriptor', undefined, A1, REVOKE, ctlRev.args, (after) => ledgerOf(after).grants.lookup(G.grantId(after.addressBytes, 0n)).active === false);
    // a second live grant to G at slot 1, so the executed slot exists and only the signature refuses
    const A1s = (await execute(Original.Contract, A1, ISSUE, issueArgsOf(G.grantee(1n), sU, await authFor(A1, { op: 'issue_grant', grantee: G.grantee(1n), ...sU })))).after;
    const auRs = await authFor(A1s, { op: 'revoke_grant', grantee: gG });
    const ctlRevS = { a: A1s, args: [msg.solGranteeArg(gG), msg.solTargetPointArg(gG), ...authArgs(auRs)] };
    await negative('grants', 'revoke binding: another slot executed (a live grant at slot 1; the approval names slot 0)', A1s, REVOKE,
      [msg.solGranteeArg({ ...gG, slot: 1n }), msg.solTargetPointArg(gG), ...authArgs(withShow(auRs, shownFor(A1s, { op: 'revoke_grant', grantee: { ...gG, slot: 1n } })))], INVALID, [INVALID], ctlRevS);
    const auAll = await authFor(A1, { op: 'revoke_all_grants' });
    const ctlAll = { a: A1, args: authArgs(auAll) };
    await positive('grants', 'revoke_all_grants', undefined, A1, REVOKE_ALL, ctlAll.args, (after) => ledgerOf(after).grant_generation === ledgerOf(A1).grant_generation + 1n);
    const cancelSig = (await authFor(A1, { op: 'recover_cancel' })).sig;
    await negative('grants', 'revoke_all operation: a recover_cancel signature presented as revoke_all_grants', A1, REVOKE_ALL, authArgs({ ...auAll, sig: cancelSig }), INVALID, [INVALID], ctlAll);
  }
  // the grant seam
  if (A1) {
    const AU = (await execute(Original.Contract, A1, 'deposit_unshielded', [COL_U, 1000n])).after;
    const opening = (spent: bigint) => ({ originHash: grantOriginHash(msg.labelBytes(G.label)), slot: 0n, scopeSalt: saltU, recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: PINNED, maxCoinValue: 600n, spentPrev: spent });
    const gctx = (a: LocalAccount, slot = 0n, g: any = G) => { const r = ledgerOf(a).grants.lookup(g.grantId(a.addressBytes, slot)); return { contractAddress: a.addressBytes, label: g.label, slot, issuedAt: r.issued_at, grantNonce: r.nonce }; };
    const amt = (n: bigint, c = COL_U) => ({ color: c, amount: n, decimals: 0, symbol: 'tU' });
    const o200 = { op: 'withdraw_unshielded_with_grant', amount: amt(200n), recipient: PINNED };
    const ga = await sol.authoriseSolGrantee(G.device, gctx(AU), SITE, o200 as any);
    const gArgs = (au: any, n = 200n, spent = 0n) => [COL_U, n, { bytes: PINNED }, ...grantAuthArgs(opening(spent) as any, au)];
    const ctlG = { a: AU, args: gArgs(ga) };
    const AU2 = await positive('grants', 'the unshielded grantee twin: 200 under the grant; auth_nonce and the device entries untouched', undefined, AU, GWU, ctlG.args,
      (after) => { const l = ledgerOf(after), b = ledgerOf(AU); return l.auth_nonce === b.auth_nonce && l.grants.lookup(G.grantId(after.addressBytes, 0n)).nonce === 1n
        && JSON.stringify([...l.devices].map(hex)) === JSON.stringify([...b.devices].map(hex)); });
    const consG = (au: any, a: LocalAccount, o: any) => ({ ...au, showArgs: sol.solGranteeMessageCircuit(G.key, gctx(a), SITE, o).showArgs });
    await negative('grants', 'grantee binding: the amount changed at execution (consistent display inputs)', AU, GWU, gArgs(consG(ga, AU, { ...o200, amount: amt(201n) }), 201n), GINVALID, [GINVALID], ctlG);
    if (AU2) {
      await negative('grants', 'grantee replay: the landed approval with the current opening and display inputs for the current record nonce', AU2, GWU,
        gArgs(consG(ga, AU2, o200), 200n, 200n), GINVALID, [GINVALID], { a: AU2, args: gArgs(await sol.authoriseSolGrantee(G.device, gctx(AU2), SITE, o200 as any), 200n, 200n) });
    }
    // cross-role: the same key as a device of AX and a grantee of AX
    const wS = sol.solSoftwareSigner(rnd());
    const W = sol.SolEd25519Device.fromSigner(wS, await sol.deriveSolBlind(wS, { network: 'undeployed', accountIndex: 0 }));
    let AX = await activated(W, rnd());
    const WG = await sol.SolEd25519Grantee.enrol(wS, { network: 'undeployed', issuingAccount: AX.addressBytes }, 'Example dApp');
    const sX = scope();
    const saltX = saltAt(AX, W);
    AX = (await execute(Original.Contract, AX, ISSUE, issueArgsOf(WG.grantee(0n), sX,
      await sol.authoriseSolDevice(W, ctxOf(AX), SITE, { op: 'issue_grant', grantee: WG.grantee(0n), ...sX } as any, 0n)))).after;
    AX = (await execute(Original.Contract, AX, 'deposit_unshielded', [COL_U, 1000n])).after;
    const to = rnd();
    const oX = { op: 'withdraw_unshielded_with_grant', amount: amt(100n), recipient: to };
    const gAuth = await sol.authoriseSolGrantee(WG.device, gctx(AX, 0n, WG), SITE, oX as any);
    const dAuth = await sol.authoriseSolDevice(W, ctxOf(AX), SITE, { op: 'withdraw_unshielded', amount: amt(100n), recipient: to } as any, 1n);
    const xOpen = { originHash: grantOriginHash(msg.labelBytes(WG.label)), slot: 0n, scopeSalt: saltX, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 600n, spentPrev: 0n };
    const ctlX = { a: AX, args: [COL_U, 100n, { bytes: to }, ...grantAuthArgs(xOpen as any, gAuth as any)] };
    await negative('grants', "roles: the same key's device-role approval of the same withdrawal presented to the grant seam", AX, GWU,
      [COL_U, 100n, { bytes: to }, ...grantAuthArgs(xOpen as any, { ...gAuth, sig: dAuth.sig } as any)], GINVALID, [GINVALID], ctlX);
    await negative('grants', "roles: the same key's grantee-role approval presented to the device seam", AX, WU,
      [COL_U, 100n, { bytes: to }, ...authArgs({ ...dAuth, sig: gAuth.sig })], INVALID, [INVALID], { a: AX, args: [COL_U, 100n, { bytes: to }, ...authArgs(dAuth)] });
    await foreignFrameGrantee('grants', rnd, AU, G, gctx(AU), SITE, GWU, o200, (au) => gArgs(au));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// grantee-scope: the three grantee twins at the constraint level
// ═════════════════════════════════════════════════════════════════════════════
async function sectionGranteeScope() {
  const rnd = rng('grantee-scope');
  const SITE = 'Grantee scope prover';
  const { d: S } = await solDevice(rnd());
  const birthG = 0xb1a7c0den;
  // veto window 0, so that a finalisation can run locally
  const A0 = await activated(S, rnd(), birthG, 0n);
  // each grant's scope salt, as issue_grant derives it (the latest issuance per slot)
  const salts = new Map<bigint, Uint8Array>();
  const issue = async (a: LocalAccount, g: any, sc: any) => {
    salts.set(g.slot, saltAt(a, S));
    return (await execute(Original.Contract, a, ISSUE, issueArgsOf(g, sc, await sol.authoriseSolDevice(S, ctxOf(a), SITE, { op: 'issue_grant', grantee: g, ...sc } as any, counterIn(a, S))))).after;
  };
  // the grantee G: one key, one grantee blind for this issuing account
  const gSeed = rnd();
  const LABEL = 'bank.example';
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(gSeed), { network: 'undeployed', issuingAccount: A0.addressBytes }, LABEL);
  const ohG = grantOriginHash(msg.labelBytes(LABEL));
  const rIdentity = rIdentityFor(gSeed, G.key);
  const COLG = fill(32, 0xc7), COLX = fill(32, 0xc8), COL_A = fill(32, 0xa1), COL_B = fill(32, 0xb2);
  const RCPT = fill(32, 0x7e), RCPT2 = fill(32, 0x7f), KEY2 = fill(32, 0x4b), RECIPIENT_CONTRACT = fill(32, 0x3c), CONTRACT2 = fill(32, 0x3d);
  const CALLER_C = fill(32, 0xca), CALLER_W = fill(32, 0xcb);
  const NONCE_H = fill(32, 0x11), NONCE_H2 = fill(32, 0x13), NONCE_OTHER = fill(32, 0x12), FILLER = (i: number) => fill(32, 0xf0 + i);
  const change = fill(192, 0x2c), change2 = fill(192, 0x2d), staleKey = fill(32, 0x5e), readPk = fill(32, 0x77);

  type T = 'U' | 'S' | 'C';
  const CIRCUIT: Record<T, string> = { U: GWU, S: GWS, C: GWSC };
  const TAG: Record<T, string> = { U: 'withdraw_unshielded_with_grant', S: 'withdraw_shielded_with_grant', C: 'withdraw_shielded_to_contract_with_grant' };
  const mainScope = (t: T) => t === 'U'
    ? scopeOf({ opWithdrawUnshielded: true, color: COLG, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 300n, perCallCap: 300n, cap: 450n })
    : scopeOf({ ...(t === 'S' ? { opWithdrawShielded: true, recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, recipient: localCoinPublicKeyBytes() }
      : { opWithdrawShieldedToContract: true, recipientKind: RECIPIENT_CONTRACT_ADDRESS, recipient: RECIPIENT_CONTRACT }),
      read: true, readPk, color: COL_A, maxCoinValue: 1000n, perCallCap: 500n, cap: 900n });
  // slots: 0 main, 1 max coin 600, 2 caller-pinned, 3 expired, 4 colour B, 5 pinned to another key, 6 the operation not in scope,
  // 7 caller-pinned to the ZERO contract address (its commitment equals the one of the default caller.value.left)
  const scopes = (t: T) => {
    const m = mainScope(t);
    const notInScope = t === 'U' ? { ...m, opWithdrawUnshielded: false, opWithdrawShielded: true, read: true, readPk }
      : t === 'S' ? { ...m, opWithdrawShielded: false, opWithdrawShieldedToContract: true } : { ...m, opWithdrawShieldedToContract: false, opWithdrawShielded: true };
    return [m, { ...m, maxCoinValue: 600n }, { ...m, caller: CALLER_C }, { ...m, expiresAt: 1n }, { ...m, color: COL_B }, { ...m, recipient: KEY2 }, notInScope, { ...m, caller: Z32 }];
  };
  const opening = (t: T, slot: bigint, spentPrev = 0n) => {
    const sc = scopes(t)[Number(slot)];
    return { originHash: ohG, slot, scopeSalt: salts.get(slot) ?? fill(32, 0x5b), recipientKind: sc.recipientKind, pinnedRecipient: sc.recipient, maxCoinValue: sc.maxCoinValue, spentPrev };
  };
  const gctx = (a: LocalAccount, slot: bigint) => { const r = ledgerOf(a).grants.lookup(G.grantId(a.addressBytes, slot)); return { contractAddress: a.addressBytes, label: LABEL, slot, issuedAt: r.issued_at as bigint, grantNonce: r.nonce as bigint }; };
  interface V { amount: bigint; color: Uint8Array; recipient: Uint8Array; coin?: LocalCoin; change: Uint8Array; encPk: Uint8Array }
  interface P { slot?: bigint; amount: bigint; color?: Uint8Array; recipient?: Uint8Array; coin?: LocalCoin; change?: Uint8Array; encPk?: Uint8Array; spentPrev?: bigint; signed?: Partial<V>; ctx?: LocalAccount }
  const opOf = (t: T, v: V) => t === 'U' ? { op: 'withdraw_unshielded_with_grant', amount: { color: v.color, amount: v.amount, decimals: 0, symbol: 'tG' }, recipient: v.recipient }
    : { op: TAG[t], amount: { color: v.color, amount: v.amount, decimals: 0, symbol: 'tG' }, recipient: v.recipient, changeEntry: v.change, encPk: v.encPk,
      coin: { nonce: v.coin!.nonce, color: v.color, value: v.coin!.value, mt_index: v.coin!.mtIndex } };
  /** The twin's arguments with G's approval over the SIGNED values (default: the executed ones). */
  const call = async (t: T, a: LocalAccount, p: P) => {
    const slot = p.slot ?? 0n;
    const sc = scopes(t)[Number(slot)];
    const exec: V = { amount: p.amount, color: p.color ?? (t === 'U' ? COLG : COL_A), recipient: p.recipient ?? sc.recipient, coin: p.coin, change: p.change ?? change, encPk: p.encPk ?? ledgerOf(a).enc_key };
    const ctx = gctx(p.ctx ?? a, slot);
    const ga = await sol.authoriseSolGrantee(G.device, ctx, SITE, opOf(t, exec) as any);
    let auth: any = ga;
    if (p.signed) auth = { ...ga, sig: (await G.device.signApproval(sol.solGranteeMessageCircuit(G.key, ctx, SITE, opOf(t, { ...exec, ...p.signed }) as any).bytes)).sig };
    const o = opening(t, slot, p.spentPrev ?? 0n);
    const args = t === 'U' ? [exec.color, p.amount, { bytes: exec.recipient }, ...grantAuthArgs(o as any, auth)]
      : [{ bytes: exec.recipient }, exec.color, p.amount, exec.change, exec.encPk, ...grantAuthArgs(o as any, auth)];
    return { args, auth: ga };
  };
  const finalised = async (a: LocalAccount) => {
    const l = ledgerOf(a);
    const Q = JubjubDevice.generate();
    const nowUpper = BigInt(Math.floor(Date.now() / 1000)) + 2n;
    const sub = signRecoverSubmit(recoveryKey(birthG), Q,
      recoverSubmitChallenge({ contractAddress: a.addressBytes, authNonce: l.auth_nonce }, l.recovery_pk, Q.pk, recoveryKey(0x9a1n).pk as any, l.device_epoch + 1n, nowUpper),
      { successorRecoveryPk: recoveryKey(0x9a1n).pk as any, expectedEpoch: l.device_epoch, expectedNonce: l.auth_nonce, nowUpper });
    const p = (await execute(Original.Contract, a, 'recover_submit', recoverSubmitArgs(sub))).after;
    await new Promise((r) => setTimeout(r, 3500));
    return (await execute(Original.Contract, p, 'recover_finalise', [])).after;
  };
  const answering = (a: LocalAccount, key: Uint8Array, coin: LocalCoin) => ({ ...a, privateState: coinStoreAnswering([{ key, coin }]) }) as LocalAccount;
  const callerCopyPlain = await copyFor([], CALLER_OVERRIDES);
  for (const t of (process.env.SOL_GRANT_TWINS ?? 'U,S,C').split(',') as T[]) {
    const circuit = CIRCUIT[t], tag = TAG[t];
    console.log(`── ${tag}`);
    let AT = A0;
    const used: Record<T, number[]> = { U: [0, 2, 3, 6, 7], S: [0, 1, 2, 3, 4, 5, 6, 7], C: [0, 1, 2, 3, 4, 6, 7] };
    for (const [i, sc] of scopes(t).entries()) if (used[t].includes(i)) AT = await issue(AT, G.grantee(BigInt(i)), sc);
    const bare = AT;
    let H1: LocalCoin | undefined, H2: LocalCoin | undefined;
    if (t === 'U') { for (const c of [COLG, COLX]) AT = (await execute(Original.Contract, AT, 'deposit_unshielded', [c, 1000n])).after; }
    else {
      const placed = withLocalCoins(AT, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 1000n }, { nonce: NONCE_H2, color: COL_A, value: 1000n }]);
      [, H1, H2] = placed.coins;
      AT = answering(placed.account, COL_A, H1!);
    }
    const honest: P = t === 'U' ? { amount: 200n } : { amount: 300n, coin: H1 };
    const base = { a: AT, args: (await call(t, AT, honest)).args };
    await positive('grantee-scope', `${tag}: the honest call on the base account (original module)`, undefined, AT, circuit, base.args);
    const N = (name: string, a: LocalAccount, args: unknown[], expect: Expect, bypass: string[], opts: NegOpts = {}, control: { a: LocalAccount; args: unknown[] } = base) =>
      negative('grantee-scope', `${tag}: ${name}`, a, circuit, args, expect, bypass, control, opts);

    // ── the scope, each check on its own, under a valid approval ──
    await N("the operation not in the grant's scope (slot 6), honestly signed", AT, (await call(t, AT, { ...honest, slot: 6n })).args, NOT_IN_SCOPE, [NOT_IN_SCOPE]);
    if (t === 'U') {
      await N("the object commitment: a colour the grant does not cover (X, the grant's is G; X in the mirror), honestly signed", AT,
        (await call(t, AT, { ...honest, color: COLX })).args, OBJECT, [OBJECT]);
    } else {
      // the scope's object check on its own: a grant for colour A (slot 0),
      // a coin of colour B withdrawn as B, honestly signed (the colour assert
      // holds: the coin is the withdrawn colour)
      const placed = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_B, value: 1000n }]);
      const accB = answering(placed.account, COL_B, placed.coins[1]);
      await N("the object commitment on its own: a grant for colour A, a coin of colour B withdrawn as B, honestly signed (the colour assert holds)", accB,
        (await call(t, accB, { ...honest, color: COL_B, coin: placed.coins[1] })).args, OBJECT, [OBJECT]);
    }
    {
      const pinnedArgs = (await call(t, AT, { ...honest, slot: 2n })).args;
      const noCaller = () => callerInjection.set(undefined), pinned = () => callerInjection.set(CALLER_C), wrong = () => callerInjection.set(CALLER_W);
      const callerCopy = await copyFor([NO_CALLER, CALLER_MISMATCH], CALLER_OVERRIDES);
      await N('the caller pin (slot 2): no contract caller (a root call)', AT, pinnedArgs, NO_CALLER, [NO_CALLER, CALLER_MISMATCH],
        { module: callerCopy, mutant: 'the caller injected into the local call context (CALLER_OVERRIDES): none; control: the pinned contract', hooks: { simulator: noCaller, control: pinned, attempt: noCaller } },
        { a: AT, args: pinnedArgs });
      const mismatchCopy = await copyFor([CALLER_MISMATCH], CALLER_OVERRIDES);
      await N('the caller pin (slot 2): called by another contract', AT, pinnedArgs, CALLER_MISMATCH, [CALLER_MISMATCH],
        { module: mismatchCopy, simulatorModule: callerCopyPlain, mutant: 'the caller injected into the local call context (CALLER_OVERRIDES): another contract; control: the pinned contract', hooks: { simulator: wrong, control: pinned, attempt: wrong } },
        { a: AT, args: pinnedArgs });
      callerInjection.set(undefined);
      // each presence/type assert ON ITS OWN: a grant pinned to the
      // zero contract address, whose commitment equals the commitment of the
      // default `caller.value.left` (the zero address), so `grant caller
      // mismatch` holds and only `grant requires a contract caller` refuses;
      // the positive control on the same copy is the matched contract caller
      // (the zero address)
      const zeroPinnedArgs = (await call(t, AT, { ...honest, slot: 7n })).args;
      const presenceCopy = await copyFor([NO_CALLER], CALLER_OVERRIDES);
      const zeroContract = () => callerInjection.set(Z32);
      // an absent caller fails the presence AND the type assert: the
      // two share one message, so the bypass covers both (count 2). A
      // canonical absent caller is never is_left: kernel.caller()'s read
      // program pushes the constant none { is_some: false, value: { is_left:
      // false, left: 0, right: 0 } } when the context holds no caller.
      await N('the caller pin on its own (slot 7, pinned to the zero contract address): no caller at all — the presence and type asserts (one message), the commitment matching', AT, zeroPinnedArgs, NO_CALLER, [NO_CALLER],
        { module: presenceCopy, mutant: 'the caller injected into the local call context (CALLER_OVERRIDES): none; control: the zero contract address (matched)', hooks: { simulator: noCaller, control: zeroContract, attempt: noCaller } },
        { a: AT, args: zeroPinnedArgs });
      // the presence assert ALONE: a non-canonical absent caller
      // (is_some = false, value.is_left = true, value.left = the zero
      // address) declared in the read the circuit receives and in the
      // transcript's popeq result; the type assert holds and the commitment
      // matches, so only `caller.is_some` refuses (count 1). The ledger never
      // produces this value; the node's transcript replay would refuse it.
      const nonCanonical = () => callerInjection.setNonCanonicalAbsent();
      await N('the caller pin on its own (slot 7, pinned to the zero contract address): a NON-CANONICAL absent caller (is_some = false, is_left = true, left = the zero address) — the presence assert alone', AT, zeroPinnedArgs, NO_CALLER, [NO_CALLER],
        { module: presenceCopy, simulatorModule: callerCopyPlain, mutant: 'the caller read answered non-canonically in the local call context and the transcript (CALLER_OVERRIDES): none with is_left = true; control: the zero contract address (matched)', hooks: { simulator: nonCanonical, control: zeroContract, attempt: nonCanonical },
          check: () => {
            const n = presenceCopy.fired().find((f) => f.message === NO_CALLER)?.count ?? 0;
            return callerInjection.flipped() < 1 ? 'the caller read was never answered non-canonically (the override did not fire)'
              : n !== 1 ? `the presence/type message fired ${n} times (expected once: the presence assert alone)` : undefined;
          } },
        { a: AT, args: zeroPinnedArgs });
      const userCaller = () => callerInjection.setUser(fill(32, 0x5e));
      await N('the caller pin on its own (slot 7, pinned to the zero contract address): a USER as the caller — only the type assert is bypassed (the commitment of the default caller.value.left matches)', AT, zeroPinnedArgs, NO_CALLER, [NO_CALLER],
        { module: presenceCopy, simulatorModule: callerCopyPlain, mutant: 'the caller injected into the local call context (CALLER_OVERRIDES): a user address; control: the zero contract address (matched)', hooks: { simulator: userCaller, control: zeroContract, attempt: userCaller } },
        { a: AT, args: zeroPinnedArgs });
      await positive('grantee-scope', `${tag}: the caller pin (slot 7) with the matched caller, the zero contract address: proved through the presence copy`, presenceCopy, AT, circuit, zeroPinnedArgs, undefined, zeroContract);
      callerInjection.set(undefined);
    }
    await N('over the per-call cap, honestly signed', AT, (await call(t, AT, { ...honest, amount: t === 'U' ? 301n : 501n })).args, PER_CALL, [PER_CALL]);
    await N('a wrong spent opening (spent so far 100, the record holds 0), honestly signed', AT, (await call(t, AT, { ...honest, spentPrev: 100n })).args, SPENT, [SPENT]);
    {
      const first: P = t === 'U' ? { amount: 200n } : { amount: 500n, coin: H1 };
      const A1 = (await execute(Original.Contract, AT, circuit, (await call(t, AT, first)).args)).after;
      const A1n = t === 'U' ? A1 : answering(A1, COL_A, H2!);
      const second: P = t === 'U' ? { amount: 260n, spentPrev: 200n } : { amount: 450n, coin: H2, spentPrev: 500n };
      await N(`over the cumulative cap (${t === 'U' ? '200 + 260 > 450' : '500 + 450 > 900'}), honestly signed with the live spent opening`, A1n, (await call(t, A1n, second)).args, CUMULATIVE, [CUMULATIVE]);
    }
    if (t !== 'U') await N("a coin above the grant's max coin value (1000 > 600, slot 1), honestly signed", AT, (await call(t, AT, { ...honest, slot: 1n })).args, MAX_COIN, [MAX_COIN]);
    else notApplicable('grantee-scope', circuit, `${tag}: the max coin value`, 'the unshielded twin spends from the mirror, not a coin: max_coin_value enters only the object commitment (a changed opening is "scope object mismatch"); the coin bound is the shielded twins\' check_shielded_grant_bounds');
    await N('a recipient other than the pinned one, honestly signed', AT,
      (await call(t, AT, t === 'S' ? { ...honest, slot: 5n, recipient: localCoinPublicKeyBytes() } : { ...honest, recipient: t === 'U' ? RCPT2 : CONTRACT2 })).args, PIN, [PIN]);
    if (t !== 'U') await N('a stale encryption key, honestly signed (the change sealed to a key that is no longer live)', AT, (await call(t, AT, { ...honest, encPk: staleKey })).args, STALE_ENC, [STALE_ENC]);
    else notApplicable('grantee-scope', circuit, `${tag}: a stale encryption key`, 'the unshielded twin produces no change entry and takes no encryption key');

    // ── the record's liveness ──
    const AR = (await execute(Original.Contract, AT, REVOKE, [msg.solGranteeArg(G.grantee(0n)), msg.solTargetPointArg(G.grantee(0n)),
      ...authArgs(await sol.authoriseSolDevice(S, ctxOf(AT), SITE, { op: 'revoke_grant', grantee: G.grantee(0n) } as any, counterIn(AT, S)))])).after;
    await N('a revoked grant (its tombstone), a valid approval over its record', AR, (await call(t, AR, honest)).args, REVOKED, [REVOKED]);
    await N('an expired grant (expires_at 1, slot 3), a valid approval', AT, (await call(t, AT, { ...honest, slot: 3n })).args, EXPIRED, [EXPIRED]);
    const AE = await finalised(AT);
    if (ledgerOf(AE).device_epoch !== 1n || !ledgerOf(AE).grants.member(G.grantId(AE.addressBytes, 0n))) throw new Error('setup: the finalisation did not bump the epoch with the grant kept');
    await N('a grant of a stale device epoch (after a local recover_finalise), a valid approval', AE, (await call(t, AE, honest)).args, EPOCH, [EPOCH]);
    const AX = (await execute(Original.Contract, AT, REVOKE_ALL, authArgs(await sol.authoriseSolDevice(S, ctxOf(AT), SITE, { op: 'revoke_all_grants' } as any, counterIn(AT, S))))).after;
    // the generation cell: the two-level cell whose copy from AX gives generation 1 with the record kept
    let AGN: LocalAccount | undefined, genPath: [number, number] | undefined;
    const top = (AT.state as any).data.state.asArray();
    for (let i = 0; i < top.length && !AGN; i++) {
      const sub = top[i].asArray?.();
      if (!sub) continue;
      for (let j = 0; j < sub.length && !AGN; j++) {
        try {
          const c = withLedgerCell(AT, AX, [i, j]);
          if (ledgerOf(c).grant_generation === 1n && ledgerOf(c).grants.member(G.grantId(c.addressBytes, 0n)) && ledgerOf(c).auth_nonce === ledgerOf(AT).auth_nonce) { AGN = c; genPath = [i, j]; }
        } catch { /* not a copyable cell */ }
      }
    }
    if (!AGN) throw new Error('setup: no ledger cell gives a stale generation with the record kept');
    await N(`a grant of a stale generation — UNREACHABLE today (revoke_all_grants clears the map, account.compact do_revoke_all_grants); the state built by copying the generation cell ${JSON.stringify(genPath)} — a valid approval`,
      AGN, (await call(t, AGN, honest)).args, GEN, [GEN]);
    // an unknown grant id: another blind names an id with no record; the
    // forged grant-id mutant's JavaScript derives the real grant's id from it
    // (so the transcript reads that record), the circuit derives the id from
    // the presented blind
    {
      const forging = await copyFor([], GRANT_ID_FORGE_OVERRIDES);
      const otherBlind = rnd();
      const args = [...base.args]; const last: any = args.at(-1);
      args[args.length - 1] = { ...last, blind: otherBlind };
      const target = { tag: padTag(DESCRIPTOR_TAGS['grant-id'].sol_ed25519), blind: otherBlind, id: G.grantId(AT.addressBytes, 0n) };
      let f0 = 0;
      await N("an unknown grant: another blind (a grant id with no record), the copy's JavaScript deriving the real grant's id from it (forged grant-id mutant)",
        AT, args, UNKNOWN_GRANT, [],
        { module: forging, mutant: 'forged grant-id mutant (persistentHash override) on the grant seam', enforcement: 'constraint', hooks: { control: () => grantIdForgery.set(undefined), attempt: () => { grantIdForgery.set(target); f0 = grantIdForgery.fired; } },
          check: () => (grantIdForgery.fired > f0 ? undefined : 'the grant-id forgery never fired') });
      grantIdForgery.set(undefined);
    }
    await runtimeOnly('grantee-scope', `${tag}: after revoke_all_grants, an approval made before it: the record is absent (the map cleared)`, AX, circuit, (await call(t, AX, { ...honest, ctx: AT })).args, /unknown grant|expected a cell/,
      'revoke_all_grants clears the grants map, so no record exists to read: the generated JavaScript (and the transcript partition the client runs) cannot read one; in-circuit the membership assert refuses it, a constraint on a declared read, and the generation check refuses any copied record (the stale-generation case above)');
    // ── the grant seam ──
    {
      const { auth } = await call(t, AT, honest);
      const args = [...base.args]; const last: any = args.at(-1);
      const sigO = rIdentity(auth.message);
      args[args.length - 1] = { ...last, sig: sigO, ...sol.solSignatureHints(sigO) };
      await N('the grant seam: R = O with the verification equation holding (s = k a)', AT, args, RID, [RID]);
    }
    // ── the shielded twins: the coin and the change ──
    if (t !== 'U') {
      const coinH = H1!;
      // the colour assert on its own: a grant scoped to B (slot 4), a valid
      // approval withdrawing A, the witness coin of colour B (the scope's
      // object check holds: its object is the coin's colour, B)
      const colPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_B, value: 1000n }]);
      const colAcc = answering(colPlaced.account, COL_A, colPlaced.coins[1]);
      await N('the colour assert on its own: a grant scoped to B (slot 4), a valid approval withdrawing A, the witness coin of colour B', colAcc,
        (await call(t, colAcc, { ...honest, slot: 4n, coin: colPlaced.coins[1] })).args, COLOUR, [COLOUR]);
      const nonceAcc = answering(withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_OTHER, color: COL_A, value: 1000n }]).account, COL_A, { ...coinH, nonce: NONCE_OTHER });
      await N("substitution, the coin nonce: signed N, the witness coin N' (same colour, value, index)", nonceAcc,
        (await call(t, nonceAcc, { ...honest, coin: { ...coinH, nonce: NONCE_OTHER }, signed: { coin: coinH } })).args, GINVALID, [GINVALID]);
      const idxPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: FILLER(1), color: COL_A, value: 7n }, { nonce: NONCE_H, color: COL_A, value: 1000n }]);
      const idxAcc = answering(idxPlaced.account, COL_A, idxPlaced.coins[2]);
      await N('substitution, the Merkle index: signed 1, the witness coin at index 2', idxAcc,
        (await call(t, idxAcc, { ...honest, coin: idxPlaced.coins[2], signed: { coin: { ...idxPlaced.coins[2], mtIndex: 1n } } })).args, GINVALID, [GINVALID]);
      await N('substitution, the change entry: signed C1, executed C2', AT, (await call(t, AT, { ...honest, change: change2, signed: { change } })).args, GINVALID, [GINVALID]);
      await N('substitution, the encryption key: signed a stale key, executed with the live key', AT, (await call(t, AT, { ...honest, signed: { encPk: staleKey } })).args, GINVALID, [GINVALID]);
      const valPlaced = withLocalCoins(bare, [{ nonce: FILLER(0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value: 999n }]);
      const valAcc = answering(valPlaced.account, COL_A, valPlaced.coins[1]);
      await N('substitution, the coin value: signed 1000, the witness coin of value 999', valAcc,
        (await call(t, valAcc, { ...honest, coin: valPlaced.coins[1], signed: { coin: { ...valPlaced.coins[1], value: 1000n } } })).args, GINVALID, [GINVALID]);
      await N('substitution, the amount: signed 300, executed 301', AT, (await call(t, AT, { ...honest, amount: 301n, signed: { amount: 300n } })).args, GINVALID, [GINVALID]);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// frame-lifecycle: the foreign-account frame on the remaining
// gated exports
// ═════════════════════════════════════════════════════════════════════════════
async function sectionFrameLifecycle() {
  const rnd = rng('frame-lifecycle');
  const SITE = 'Frame lifecycle prover';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const jub = JubjubDevice.generate();
  const tJ = sol.solTargetOf({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y } as any);
  const addArgs = (t: any) => (au: any) => [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(au)];
  await foreignFrameDevice('frame-lifecycle', rnd, A0, S, SITE, ADD, { op: 'add_device', target: tJ }, addArgs(tJ));
  const A1 = (await execute(Original.Contract, A0, ADD, addArgs(tJ)(await sol.authoriseSolDevice(S, ctxOf(A0), SITE, { op: 'add_device', target: tJ } as any, counterIn(A0, S))))).after;
  const ep = ledgerOf(A1).device_epoch as bigint;
  await foreignFrameDevice('frame-lifecycle', rnd, A1, S, SITE, REMOVE, { op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep },
    (au) => [false, msg.solTargetArg(tJ), msg.solTargetPointArg(tJ), 0n, ep, new Uint8Array(32), ...authArgs(au)], 'remove_device (descriptor form)');
  const eJ = jub.entryAt(A1.addressBytes, ep, 0n);
  await foreignFrameDevice('frame-lifecycle', rnd, A1, S, SITE, REMOVE, { op: 'remove_device', literal: true, entry: eJ },
    (au) => [true, msg.solTargetArg({ tag: '' } as any), msg.solUnusedKey(), 0n, 0n, eJ, ...authArgs(au)], 'remove_device (literal form)');
  // grants: G is a sol grantee of A0
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const COL_A = fill(32, 0xa1);
  const sc = scopeOf({ opWithdrawShielded: true, opWithdrawShieldedToContract: true, read: true, readPk: fill(32, 0x77), color: COL_A, maxCoinValue: 1000n, perCallCap: 600n, cap: 1200n });
  const salt = saltAt(A0, S);
  const g0 = G.grantee(0n);
  await foreignFrameDevice('frame-lifecycle', rnd, A0, S, SITE, ISSUE, { op: 'issue_grant', grantee: g0, ...sc }, (au) => issueArgsOf(g0, sc, au));
  const AG = (await execute(Original.Contract, A0, ISSUE, issueArgsOf(g0, sc, await sol.authoriseSolDevice(S, ctxOf(A0), SITE, { op: 'issue_grant', grantee: g0, ...sc } as any, counterIn(A0, S))))).after;
  await foreignFrameDevice('frame-lifecycle', rnd, AG, S, SITE, REVOKE, { op: 'revoke_grant', grantee: g0 }, (au) => [msg.solGranteeArg(g0), msg.solTargetPointArg(g0), ...authArgs(au)]);
  await foreignFrameDevice('frame-lifecycle', rnd, AG, S, SITE, REVOKE_ALL, { op: 'revoke_all_grants' }, (au) => authArgs(au));
  // the two shielded grantee twins on a local Zswap tree
  const { account, coins } = withLocalCoins(AG, [{ nonce: fill(32, 0xf0), color: COL_A, value: 5n }, { nonce: fill(32, 0x11), color: COL_A, value: 1000n }]);
  const AS = { ...account, privateState: coinStoreAnswering([{ key: COL_A, coin: coins[1] }]) } as LocalAccount;
  const r = ledgerOf(AS).grants.lookup(G.grantId(AS.addressBytes, 0n));
  const ctx = { contractAddress: AS.addressBytes, label: G.label, slot: 0n, issuedAt: r.issued_at as bigint, grantNonce: r.nonce as bigint };
  const enc = ledgerOf(AS).enc_key;
  const chg = fill(192, 0x2c);
  const op = { originHash: grantOriginHash(msg.labelBytes(G.label)), slot: 0n, scopeSalt: salt, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 1000n, spentPrev: 0n };
  for (const [circuit, recipient, opName] of [[GWS, localCoinPublicKeyBytes(), 'withdraw_shielded_with_grant'], [GWSC, fill(32, 0x3c), 'withdraw_shielded_to_contract_with_grant']] as [string, Uint8Array, string][]) {
    const o = { op: opName, amount: { color: COL_A, amount: 300n, decimals: 0, symbol: 'tA' }, recipient, changeEntry: chg, encPk: enc,
      coin: { nonce: coins[1].nonce, color: COL_A, value: 1000n, mt_index: coins[1].mtIndex } };
    await foreignFrameGrantee('frame-lifecycle', rnd, AS, G, ctx, SITE, circuit, o, (au) => [{ bytes: recipient }, COL_A, 300n, chg, enc, ...grantAuthArgs(op as any, au)]);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// recovery and field-rendering (the canonical Field rendering)
// ═════════════════════════════════════════════════════════════════════════════
async function sectionRecovery(doRecovery: boolean, doFieldRendering: boolean) {
  const rnd = rng('recovery');
  const SITE = 'Recovery prover test';
  const { seed: sSeed, d: S } = await solDevice(rnd());
  const { d: S2 } = await solDevice(rnd());
  const { d: W } = await solDevice(rnd());
  const { d: stranger } = await solDevice(rnd());
  // window 0 (the constructor's minimum) so that a finalisation can run locally
  const A0 = await activated(S, rnd(), 0xb1a7n, 0n);
  const field = (n: number) => BigInt('0x' + hex(rnd(31))) + BigInt(n);
  const sessionOf = (secret: bigint) => sol.solRecoverySession({ recoveryPk: recoveryKey(secret).pk, sessionNonce: rnd(32), phi: [field(1), field(2)], wrap: rnd(64) } as any);
  type Sess = ReturnType<typeof sessionOf>;
  const sArgs = (x: Sess) => [x.recoveryPk, x.sessionNonce, ...x.phi, x.phiLen, x.wrap];
  const authFor = (a: LocalAccount, d: Dev, o: any, counter = counterIn(a, d)) => sol.authoriseSolDevice(d, ctxOf(a), SITE, o, counter);
  /** Display inputs as the client computes them (renderer values; a non-canonical rendering is possible). */
  const showArgsFor = (a: LocalAccount, d: Dev, o: any, nonce = ledgerOf(a).auth_nonce as bigint, account = a.addressBytes) => {
    const show = msg.solShow(SITE, nonce), frame = msg.solFrameNibbles(account, d.key);
    if (o.op === 'publish_recovery_session') return [msg.digitsOf(o.phiLen, 3), show, frame, msg.nibblesOf(...msg.solDeviceHexValues(o))];
    return [show, frame];
  };
  const bytesFor = (a: LocalAccount, d: Dev, o: any, nonce = ledgerOf(a).auth_nonce as bigint, account = a.addressBytes) =>
    msg.solMessageBytes(msg.solDeviceMessageText({ site: SITE, account, key: d.key, nonce }, o));
  /** The wallet signed `signed`; the call carries display inputs `show`. */
  const signedOver = async (a: LocalAccount, d: Dev, signed: Uint8Array, show: unknown[], counter = counterIn(a, d)) =>
    ({ ...(await authFor(a, d, { op: 'recover_cancel' }, counter)), sig: (await d.signApproval(signed)).sig, showArgs: show });
  const pubArgs = async (a: LocalAccount, x: Sess, d: Dev = S, counter = counterIn(a, d)) => [...sArgs(x), ...authArgs(await authFor(a, d, x, counter))];
  const cancelArgs = async (a: LocalAccount, d: Dev, counter = counterIn(a, d)) => authArgs(await authFor(a, d, { op: 'recover_cancel' }, counter));
  const rIdentity = rIdentityFor(sSeed, S.key);
  const submitArgs = (a: LocalAccount, secret: bigint, successor: any, successorRecoveryPk: any, nowUpper: bigint) => {
    const l = ledgerOf(a);
    const auth = signRecoverSubmit(recoveryKey(secret), successor,
      recoverSubmitChallenge({ contractAddress: a.addressBytes, authNonce: l.auth_nonce }, l.recovery_pk, successor.pk, successorRecoveryPk, l.device_epoch + 1n, nowUpper),
      { successorRecoveryPk, expectedEpoch: l.device_epoch, expectedNonce: l.auth_nonce, nowUpper });
    return recoverSubmitArgs(auth);
  };
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  const S1 = sessionOf(0x5e55n);
  const landed = await pubArgs(A0, S1);
  const A1x = doRecovery ? await positive('recovery', 'publish_recovery_session_with_sol_ed25519: the honest session (1,250-byte approval)', undefined, A0, PUBLISH, landed,
    (after) => { const l = ledgerOf(after); return l.recovery_phi_len === 2n && Buffer.from(l.recovery_session).equals(Buffer.from(S1.sessionNonce)) && l.auth_nonce === 1n; }) : undefined;
  const A1 = A1x ?? (await execute(Original.Contract, A0, PUBLISH, landed)).after;
  const X = sessionOf(0x5e56n);
  const ctlP = { a: A1, args: await pubArgs(A1, X) };

  if (doFieldRendering) {
    // a non-canonical rendering f + r of each shown Field, signed by the
    // wallet with matching display inputs: only the display check against
    // the canonical cast remains (the Field-to-Bytes<32> rendering is canonical)
    const nc: [string, Sess][] = [
      ['backup vector value 1 shown as f + r', { ...X, phi: [X.phi[0] + FQ, X.phi[1], 0n, 0n] }],
      ['backup vector value 2 shown as f + r', { ...X, phi: [X.phi[0], X.phi[1] + FQ, 0n, 0n] }],
      ['backup vector value 3 (zero) shown as 0 + r', { ...X, phi: [X.phi[0], X.phi[1], FQ, 0n] }],
      ["the recovery key's x shown as x + r", { ...X, recoveryPk: { ...X.recoveryPk, x: X.recoveryPk.x + FQ } }],
      ["the recovery key's y shown as y + r", { ...X, recoveryPk: { ...X.recoveryPk, y: X.recoveryPk.y + FQ } }],
    ] as any;
    for (const [name, shown] of nc) {
      await negative('field-rendering', `${name} (the executed value is f; the wallet signed the non-canonical rendering)`, A1, PUBLISH,
        [...sArgs(X), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, shown), showArgsFor(A1, S, shown)))], HEXD, [HEXD], ctlP);
    }
  }
  if (!doRecovery) return;

  const other = recoveryKey(0x0dd0n).pk;
  const flip = (b: Uint8Array, i: number) => { const o = new Uint8Array(b); o[i] ^= 1; return o; };
  const variants: [string, Sess][] = [
    ['the recovery key', { ...X, recoveryPk: other }],
    ['the session identifier', { ...X, sessionNonce: flip(X.sessionNonce, 31) }],
    ['backup vector value 1', { ...X, phi: [X.phi[0] + 1n, X.phi[1], 0n, 0n] }],
    ['backup vector value 2', { ...X, phi: [X.phi[0], X.phi[1] + 1n, 0n, 0n] }],
    ['backup vector value 3 (an unused slot) and the length', { ...X, phi: [X.phi[0], X.phi[1], 7n, 0n], phiLen: 3n }],
    ['the length (3, slot 3 zero)', { ...X, phiLen: 3n }],
    ['the wrap', { ...X, wrap: flip(X.wrap, 63) }],
  ] as any;
  for (const [name, Y] of variants) {
    await negative('recovery', `publish binding: ${name} — the wallet signed the session, the call executes another value`, A1, PUBLISH,
      [...sArgs(Y), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, X), showArgsFor(A1, S, Y)))], INVALID, [INVALID], ctlP);
  }
  await negative('recovery', 'publish binding: the nonce — the approval shows auth_nonce + 1', A1, PUBLISH,
    [...sArgs(X), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, X, ledgerOf(A1).auth_nonce + 1n), showArgsFor(A1, S, X)))], INVALID, [INVALID], ctlP);
  await negative('recovery', 'publish operation: a recover_cancel approval presented as the session approval', A1, PUBLISH,
    [...sArgs(X), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, { op: 'recover_cancel' }), showArgsFor(A1, S, X)))], INVALID, [INVALID], ctlP);
  {
    const acct = rnd();
    await negative('recovery', 'publish: the seam owns the frame — the wallet signed the session showing a foreign account (its frame nibbles with it)', A1, PUBLISH,
      [...sArgs(X), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, X, ledgerOf(A1).auth_nonce, acct), showArgsFor(A1, S, X, ledgerOf(A1).auth_nonce, acct)))], HEXD, [HEXD], ctlP);
  }
  const aX = await authFor(A1, S, X);
  {
    const Y = { ...X, phi: [X.phi[0] + 1n, X.phi[1], 0n, 0n] } as Sess;
    await negative('recovery', "publish display: the hex nibbles and the signed message show another backup vector value 1; the call executes the session's", A1, PUBLISH,
      [...sArgs(X), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, Y), showArgsFor(A1, S, Y)))], HEXD, [HEXD], ctlP);
  }
  {
    const Y = { ...X, phi: [X.phi[0], X.phi[1], 5n, 0n], phiLen: 3n } as Sess;
    const Z = { ...Y, phiLen: 2n } as Sess;
    await negative('recovery', 'publish display: the length digits and the signed message show 2, the call executes 3 (hex nibbles consistent)', A1, PUBLISH,
      [...sArgs(Y), ...authArgs(await signedOver(A1, S, bytesFor(A1, S, Z), showArgsFor(A1, S, Z)))], DIGITS, [DIGITS], ctlP);
  }
  const chip: [string, Sess, string, string[]][] = [
    ['an empty vector (length 0)', { ...X, phi: [0n, 0n, 0n, 0n], phiLen: 0n }, EMPTY, [EMPTY]],
    ['a length beyond the slot bound (5)', { ...X, phi: [1n, 2n, 3n, 4n], phiLen: 5n }, RANGE, [RANGE]],
    ['length 1 with slot 2 non-zero', { ...X, phi: [1n, 2n, 0n, 0n], phiLen: 1n }, SLOT2, [SLOT2]],
    ['length 2 with slot 3 non-zero', { ...X, phi: [1n, 2n, 3n, 0n], phiLen: 2n }, SLOT3, [SLOT3]],
    ['length 3 with slot 4 non-zero', { ...X, phi: [1n, 2n, 3n, 4n], phiLen: 3n }, SLOT4, [SLOT4]],
    ['an all-zero session identifier', { ...X, sessionNonce: new Uint8Array(32) }, SIDZERO, [SIDZERO]],
    ['the stored session identifier reused', { ...X, sessionNonce: new Uint8Array(S1.sessionNonce) }, SIDREUSE, [SIDREUSE]],
    ['the stored recovery commitment reused', { ...X, recoveryPk: S1.recoveryPk }, PKREUSE, [PKREUSE]],
    ['the identity as the new recovery key', { ...X, recoveryPk: JUBJUB_IDENTITY }, IDENT, [IDENT, SMALL]],
  ] as any;
  for (const [name, x, expect, bypass] of chip) await negative('recovery', `chip: publish under a valid signature, ${name}`, A1, PUBLISH, await pubArgs(A1, x), expect, bypass, ctlP);
  {
    // a torsion point traps in the runtime's JubJub code before the circuit body
    const name = 'chip: publish under a valid signature, a small-order recovery key (runtime trap)';
    const r: Result = { section: 'recovery', circuit: PUBLISH, case: name, kind: 'negative', expect: 'unreachable' };
    const chain: string[] = [];
    let refusedT = false;
    try { await execute(Original.Contract, A1, PUBLISH, await pubArgs(A1, { ...X, recoveryPk: JUBJUB_ORDER_TWO } as Sess)); }
    catch (e: any) { refusedT = true; for (let x = e; x; x = x.cause) chain.push(`${x.name}: ${x.message}`); }
    const trap = refusedT && chain.some((m) => /unreachable|small order/.test(m));
    r.simulator = { verdict: trap ? 'PASS' : refusedT ? 'ERROR' : 'FAIL', layer: 'runtime', reason: trap ? 'refused by the runtime (JubJub point handling) before the circuit body' : 'not refused as expected', detail: chain.join(' | ').slice(0, 600) } as any;
    r.proverLevel = 'not reachable from a JavaScript-built call: the runtime cannot construct a JubJub point outside the prime-order subgroup, and the proving toolchain constrains every assigned point into the subgroup (upstream recovery-sim; require_live_jubjub_point is defence in depth)';
    tally(r.simulator); results.push(r); line(r);
  }
  await negative('recovery', 'seam: publish, an unenrolled sol key signs the session', A1, PUBLISH, await pubArgs(A1, X, stranger, 0n), UNKNOWN, [UNKNOWN], ctlP);
  await negative('recovery', 'seam: publish, the device key with another blind', A1, PUBLISH, [...sArgs(X), ...authArgs({ ...aX, blind: rnd() })], UNKNOWN, [UNKNOWN], ctlP);
  await negative('recovery', 'seam: publish, a stale use counter (counter 0, already rolled)', A1, PUBLISH, await pubArgs(A1, X, S, 0n), UNKNOWN, [UNKNOWN], ctlP);
  await negative('recovery', 'seam: publish, R = O with the verification equation holding (s = k a)', A1, PUBLISH, [...sArgs(X), ...authArgs({ ...aX, sig: rIdentity(aX.message) })], RID, [RID], ctlP);
  await negative('recovery', 'replay: publish, the landed session approval replayed with display inputs for the current nonce (entry consumed, stored values)', A1, PUBLISH,
    [...sArgs(S1), ...authArgs({ ...(await authFor(A0, S, S1, 0n)), showArgs: showArgsFor(A1, S, S1) })], UNKNOWN, [UNKNOWN, INVALID, SIDREUSE, PKREUSE], ctlP);

  // a pending recovery: S adds S2 (sol) and J (jubjub) by descriptor, J plants W at epoch + 1
  const jub = JubjubDevice.generate();
  let AD = A1;
  for (const d of [S2.descriptor(), { scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y }]) {
    const t = sol.solTargetOf(d as any);
    AD = (await execute(Original.Contract, AD, ADD, [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(await authFor(AD, S, { op: 'add_device', target: t }))])).after;
  }
  const plant = W.entryAt(AD.addressBytes, 1n, 0n);
  const AW = (await execute(Original.Contract, AD, 'add_device_with_jubjub', [plant, ...authArgs(jub.sign(jubjubChallenges.addDevice(ctxOf(AD), jub.pk, plant), 0n))])).after;
  if (!ledgerOf(AW).devices.member(plant) || ledgerOf(AW).device_count !== 4n) throw new Error('setup: the plant did not land');
  const Q = JubjubDevice.generate();
  const QR = 0x9e11n;
  const AP = (await execute(Original.Contract, AW, 'recover_submit', submitArgs(AW, 0x5e55n, Q, recoveryKey(QR).pk, now() + 2n))).after;
  if (!ledgerOf(AP).pending_recovery) throw new Error('setup: the submission did not land');
  await negative('recovery', 'chip: publish under a valid signature while a recovery is pending', AP, PUBLISH, await pubArgs(AP, X), PENDING, [PENDING], ctlP);

  const C = { op: 'recover_cancel' };
  const cancelHonest = await cancelArgs(AP, S2);
  const ctlC = { a: AP, args: cancelHonest };
  const ACx = await positive('recovery', 'recover_cancel_with_sol_ed25519: the second sol device vetoes the pending recovery (391-byte approval)', undefined, AP, CANCEL, cancelHonest,
    (after) => ledgerOf(after).pending_recovery === false && ledgerOf(after).auth_nonce === ledgerOf(AP).auth_nonce + 1n);
  const AC = ACx ?? (await execute(Original.Contract, AP, CANCEL, cancelHonest)).after;
  await negative('recovery', 'cancel operation: a revoke_all_grants approval over the same frame presented as the cancel', AP, CANCEL,
    authArgs(await signedOver(AP, S2, bytesFor(AP, S2, { op: 'revoke_all_grants' }), showArgsFor(AP, S2, C))), INVALID, [INVALID], ctlC);
  await negative('recovery', 'cancel binding: the approval shows auth_nonce + 1', AP, CANCEL,
    authArgs(await signedOver(AP, S2, bytesFor(AP, S2, C, ledgerOf(AP).auth_nonce + 1n), showArgsFor(AP, S2, C))), INVALID, [INVALID], ctlC);
  await negative('recovery', "cancel binding: the approval shows another account (this account's frame nibbles)", AP, CANCEL,
    authArgs(await signedOver(AP, S2, bytesFor(AP, S2, C, ledgerOf(AP).auth_nonce, rnd()), showArgsFor(AP, S2, C))), INVALID, [INVALID], ctlC);
  {
    const acct = rnd();
    await negative('recovery', 'cancel: the seam owns the frame — the wallet signed a cancel showing a foreign account (its frame nibbles with it)', AP, CANCEL,
      authArgs(await signedOver(AP, S2, bytesFor(AP, S2, C, ledgerOf(AP).auth_nonce, acct), showArgsFor(AP, S2, C, ledgerOf(AP).auth_nonce, acct))), HEXD, [HEXD], ctlC);
  }
  await negative('recovery', 'cancel display: the nonce digits and the signed message show auth_nonce + 1', AP, CANCEL,
    authArgs(await signedOver(AP, S2, bytesFor(AP, S2, C, ledgerOf(AP).auth_nonce + 1n), showArgsFor(AP, S2, C, ledgerOf(AP).auth_nonce + 1n))), DIGITS, [DIGITS], ctlC);
  await negative('recovery', 'seam: cancel, an unenrolled sol key', AP, CANCEL, await cancelArgs(AP, stranger, 0n), UNKNOWN, [UNKNOWN], ctlC);
  {
    const a = await authFor(AP, S, C);
    await negative('recovery', 'seam: cancel, R = O with the verification equation holding (s = k a)', AP, CANCEL, authArgs({ ...a, sig: rIdentity(a.message) }), RID, [RID], ctlC);
  }
  await negative('recovery', 'chip: a valid cancel with nothing pending', A1, CANCEL, await cancelArgs(A1, S), NOPENDING, [NOPENDING], ctlC);
  await negative('recovery', 'replay: cancel, the landed cancel replayed with display inputs for the current nonce (entry consumed, nothing pending)', AC, CANCEL,
    authArgs({ ...(await authFor(AP, S2, C, 0n)), showArgs: showArgsFor(AC, S2, C) }), UNKNOWN, [UNKNOWN, INVALID, NOPENDING], ctlC);

  // finalisation (#183)
  const AP2 = (await execute(Original.Contract, AC, 'recover_submit', submitArgs(AC, 0x5e55n, Q, recoveryKey(QR).pk, now() + 2n))).after;
  const lastS = counterIn(AP2, S), lastS2 = counterIn(AP2, S2);
  await new Promise((r) => setTimeout(r, 3500));
  const AF0 = (await execute(Original.Contract, AP2, 'recover_finalise', [])).after;
  const lf = ledgerOf(AF0);
  stateOnly('recovery', "finalised: the set holds only the successor; the plant is W's entry at the new epoch and is gone",
    lf.devices.size() === 1n && lf.device_epoch === 1n && !lf.devices.member(plant) && Buffer.from(plant).equals(Buffer.from(W.entryAt(AF0.addressBytes, lf.device_epoch, 0n))));
  const { d: F } = await solDevice(rnd());
  const fEntry = F.entryAt(AF0.addressBytes, lf.device_epoch, 0n);
  const AF = (await execute(Original.Contract, AF0, 'add_device_with_jubjub', [fEntry, ...authArgs(Q.sign(jubjubChallenges.addDevice(ctxOf(AF0), Q.pk, fEntry), 0n))])).after;
  const S3 = sessionOf(0x5e57n);
  await positive('recovery', 'after the recovery: a fresh sol device enrolled by the successor publishes a session', undefined, AF, PUBLISH, await pubArgs(AF, S3, F),
    (after) => Buffer.from(ledgerOf(after).recovery_session).equals(Buffer.from(S3.sessionNonce)));
  const AFP = (await execute(Original.Contract, AF, 'recover_submit', submitArgs(AF, QR, JubjubDevice.generate(), recoveryKey(0x9e12n).pk, now() + 600n))).after;
  await positive('recovery', 'after the recovery: the fresh sol device cancels a new pending recovery', undefined, AFP, CANCEL, await cancelArgs(AFP, F),
    (after) => ledgerOf(after).pending_recovery === false);
  const ctlF = { a: AF, args: await pubArgs(AF, S3, F) };
  const ctlFC = { a: AFP, args: await cancelArgs(AFP, F) };
  for (const [name, d, c] of [["the planted entry's device W (counter 0 at the new epoch)", W, 0n], [`the original device S (its last counter ${lastS})`, S, lastS], [`the second sol device S2 (its last counter ${lastS2})`, S2, lastS2]] as const) {
    await negative('recovery', `after the recovery: ${name} publishes`, AF, PUBLISH, await pubArgs(AF, S3, d, c), UNKNOWN, [UNKNOWN], ctlF);
    await negative('recovery', `after the recovery: ${name} cancels a pending recovery`, AFP, CANCEL, await cancelArgs(AFP, d, c), UNKNOWN, [UNKNOWN], ctlFC);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// readability (the exact words; every number in full digits)
// ═════════════════════════════════════════════════════════════════════════════
async function sectionReadability() {
  const rnd = rng('readability');
  const SITE = 'Readability prover test';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const authFor = (a: LocalAccount, o: any) => sol.authoriseSolDevice(S, ctxOf(a), SITE, o, counterIn(a, S));
  /** The honest text with `from` replaced by `to` (exactly once, same length), as bytes the wallet signs. */
  const forge = (text: string, from: string, to: string) => {
    if (text.split(from).length !== 2) throw new Error(`forge: "${from}" not found exactly once`);
    if (from.length !== to.length) throw new Error('forge: the forged text must keep the layout');
    return msg.solMessageBytes(text.replace(from, to));
  };
  const forgedAuth = async (honest: any, from: string, to: string, dev: any = S) => ({ ...honest, sig: (await dev.signApproval(forge(honest.text, from, to))).sig });
  const d39 = (v: bigint | string) => String(v).padEnd(39, ' ');
  const amt = (color: Uint8Array, amount: bigint, decimals = 0, symbol = 'tTOK') => ({ color, amount, decimals, symbol });
  // custody
  const COL_U = fill(32, 0xc1), RU = fill(32, 0x77);
  const AU = (await execute(Original.Contract, A0, 'deposit_unshielded', [COL_U, 5_000_000n])).after;
  const oU = { op: 'withdraw_unshielded', amount: amt(COL_U, 1_000_000n, 6, 'tUSDC'), recipient: RU };
  const aU = await authFor(AU, oU);
  const uArgs = (au: any) => [COL_U, 1_000_000n, { bytes: RU }, ...authArgs(au)];
  const ctlU = { a: AU, args: uArgs(aU) };
  textCheck('readability', 'withdraw_unshielded: "Amount (base units): 1000000…" in full digits, no magnitude (600 bytes)', aU.text.length === 600 && aU.message.length === 50 + 600 && aU.text.includes(`Amount (base units): ${d39(1_000_000n)}\n`) && !aU.text.includes(' x 10^'));
  await positive('readability', 'withdraw_unshielded 10^6: proved', undefined, AU, WU, ctlU.args);
  await negative('readability', 'forged amount: the wallet signed "100000" for an executed 1000000', AU, WU, uArgs(await forgedAuth(aU, `Amount (base units): ${d39(1_000_000n)}`, `Amount (base units): ${d39(100_000n)}`)), INVALID, [INVALID], ctlU);
  for (const [name, units, expect] of [
    ['forged digits: a leading zero', '01000000', LEADING],
    ['forged digits: a digit after the padding', '1000000 0', ALIGN],
  ] as const) {
    const copy = await copyFor([expect]);
    const shown = [...aU.showArgs] as any[];
    shown[0] = { ...shown[0], units: [...Buffer.from(units.padEnd(39, ' '), 'ascii')].map(BigInt) };
    const bytes: Uint8Array = copy.pureCircuits.sol_message_withdraw_unshielded({ bytes: AU.addressBytes }, S.key, ledgerOf(AU).auth_nonce, COL_U, 1_000_000n, { bytes: RU }, ...shown);
    const { sig } = await S.signApproval(bytes);
    await negative('readability', `${name}, signed over what they render`, AU, WU, uArgs({ ...aU, sig, showArgs: shown }), expect, [expect], ctlU);
  }
  const COL_A = fill(32, 0xa1), NONCE_H = fill(32, 0x11), RC = fill(32, 0x3c);
  const shieldedAccount = (base: LocalAccount, value: bigint) => {
    const { account, coins } = withLocalCoins(base, [{ nonce: fill(32, 0xf0), color: COL_A, value: 5n }, { nonce: NONCE_H, color: COL_A, value }]);
    return { a: { ...account, privateState: coinStoreAnswering([{ key: COL_A, coin: coins[1] }]) } as LocalAccount, coin: coins[1] };
  };
  for (const circuit of [WS, WSC]) {
    const H = shieldedAccount(A0, 1000n);
    const recipient = circuit === WS ? localCoinPublicKeyBytes() : RC;
    const o = { op: circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract', amount: amt(COL_A, 300n), recipient,
      coin: { nonce: H.coin.nonce, color: COL_A, value: 1000n, mt_index: H.coin.mtIndex } };
    const au = await authFor(H.a, o);
    const sArgs = (x: any) => [{ bytes: recipient }, COL_A, 300n, ...authArgs(x)];
    const short = circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract';
    const len = circuit === WS ? 841 : 851;
    textCheck('readability', `${short}: the amount, the spent value and the change in full digits (${len} bytes)`, au.text.length === len && au.message.length === 50 + len
      && au.text.includes(`Spent coin value: ${d39(1000n)}\n`) && au.text.includes(`Change back to this account: ${d39(700n)}\n`) && au.text.includes(`Amount (base units): ${d39(300n)}\n`));
    await positive('readability', `${short} 300 of a 1000 coin: proved`, undefined, H.a, circuit, sArgs(au));
    if (circuit === WS) await negative('readability', 'forged change: the wallet signed the change as 70', H.a, circuit,
      sArgs(await forgedAuth(au, `Change back to this account: ${d39(700n)}`, `Change back to this account: ${d39(70n)}`)), INVALID, [INVALID], { a: H.a, args: sArgs(au) });
  }
  // devices: a passkey target shows its RP hash in hex (never a word)
  const pass = softwarePasskey();
  const tR = sol.solTargetOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } } as any);
  const aR = await authFor(A0, { op: 'add_device', target: tR });
  const addArgs = (t: any, x: any) => [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(x)];
  const ctlAdd = { a: A0, args: addArgs(tR, aR) };
  const NA = 'not applicable'.padEnd(64, ' ');
  textCheck('readability', 'add_device: a passkey target shows its RP hash as 64 hex digits (685 bytes)', aR.text.length === 685 && aR.message.length === 50 + 685 && aR.text.includes(`Passkey RP (hash): ${hex(pass.policy.rp_id_hash)}\n`));
  const A1 = await positive('readability', 'add_device of that passkey target: proved', undefined, A0, ADD, ctlAdd.args);
  await negative('readability', 'forged word: the wallet signed "not applicable" for a passkey target\'s RP hash', A0, ADD,
    addArgs(tR, await forgedAuth(aR, `Passkey RP (hash): ${hex(pass.policy.rp_id_hash)}`, `Passkey RP (hash): ${NA}`)), INVALID, [INVALID], ctlAdd);
  const A1x = A1 ?? (await execute(Original.Contract, A0, ADD, ctlAdd.args)).after;
  {
    const o = { op: 'remove_device', literal: false, target: tR, counter: 0n, epoch: ledgerOf(A1x).device_epoch as bigint };
    const au = await authFor(A1x, o);
    await positive('readability', 'remove_device of that passkey target by descriptor (its RP hash in hex in the removal\'s block): proved', undefined, A1x, REMOVE,
      [false, msg.solTargetArg(tR), msg.solTargetPointArg(tR), 0n, o.epoch, Z32, ...authArgs(au)], (after) => ledgerOf(after).device_count === 1n);
  }
  // grants
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const scope = (o: any = {}) => scopeOf({ opWithdrawUnshielded: true, color: COL_U, maxCoinValue: MAX128, perCallCap: MAX128, cap: MAX128, ...o });
  const sG = scope();
  const saltG = saltAt(A0, S);
  const gG = G.grantee(0n);
  const aI = await authFor(A0, { op: 'issue_grant', grantee: gG, ...sG });
  const ctlI = { a: A0, args: issueArgsOf(gG, sG, aI) };
  const MAXTXT = d39(MAX128);
  textCheck('readability', 'issue_grant: caps of 2^128 - 1 in full digits, expiry 0 reads "never", a non-passkey grantee\'s zero RP hash "not applicable", the expiry\'s UTC line "never", a zero window "no window" (1,690 bytes)',
    aI.text.length === 1690 && aI.message.length === 50 + 1690 && aI.text.includes(`Expires at (UTC): ${'never'.padEnd(29)}\n`) && aI.text.includes(`Window length: ${'no window'.padEnd(20)}\n`) && aI.text.includes(`Total cap: ${MAXTXT}\n`) && aI.text.includes(`Max coin value: ${MAXTXT}\n`) && aI.text.includes(`Per-call cap: ${MAXTXT}\n`)
    && aI.text.includes(`Expires at (block time, seconds): ${'never'.padEnd(20)}\n`) && aI.text.includes(`Passkey RP (hash): ${NA}\n`) && aI.text.includes(`Window cap: ${'no window'.padEnd(39)}\n`) && !aI.text.includes(' x 10^'));
  const AG = await positive('readability', 'issue_grant to a sol grantee with the words and the full digits: proved', undefined, A0, ISSUE, ctlI.args, (after) => ledgerOf(after).grants.member(G.grantId(after.addressBytes, 0n)));
  await negative('readability', 'forged cap: the wallet signed "no limit" for the total cap', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `Total cap: ${MAXTXT}`, `Total cap: ${d39('no limit')}`)), INVALID, [INVALID], ctlI);
  await negative('readability', 'forged word: the wallet signed "0" instead of "never" for an expiry of 0', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `seconds): ${'never'.padEnd(20)}`, `seconds): ${'0'.padEnd(20)}`)), INVALID, [INVALID], ctlI);
  await negative('readability', 'forged word: the wallet signed 64 zeros for a non-passkey grantee\'s zero RP hash', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `Passkey RP (hash): ${NA}`, `Passkey RP (hash): ${'0'.repeat(64)}`)), INVALID, [INVALID], ctlI);
  await negative('readability', 'forged date: the wallet signed a UTC date for an expiry of 0', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `Expires at (UTC): ${'never'.padEnd(29)}`, `Expires at (UTC): ${'1970-01-01 00:00:00 UTC'.padEnd(29)}`)), INVALID, [INVALID], ctlI);
  await negative('readability', 'forged word: the wallet signed "0" for a zero window', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `Window length: ${'no window'.padEnd(20)}`, `Window length: ${'0'.padEnd(20)}`)), INVALID, [INVALID], ctlI);
  {
    const keyText = base58Text32(S.key).padEnd(44, ' ');
    const hexText = Buffer.from(S.key).toString('hex').slice(0, 44);
    await negative('readability', 'forged key: the wallet signed the signing key in hex instead of base58', A0, ISSUE, issueArgsOf(gG, sG, await forgedAuth(aI, `Signing key: ${keyText}`, `Signing key: ${hexText}`)), INVALID, [INVALID], ctlI);
    // the date's display inputs: the date of another second, and a
    // non-canonical year split (which also miscounts the leap days, so the
    // date check refuses it too), each with the message unchanged (an expiry
    // of 0 reads "never" whatever the date text), so only the display checks
    // refuse
    const sh = aI.showArgs as any[];
    const ssOf = (patch: any) => [sh[0], { ...sh[1], ...patch }, ...sh.slice(2)];
    const d1 = utcDateTimeInputs(1n);
    await negative('readability', 'display: the UTC date text of another second (1970-01-01 00:00:01 for an expiry of 0)', A0, ISSUE,
      issueArgsOf(gG, sG, { ...aI, showArgs: ssOf({ expires_utc: d1.text, expires_split: d1.yearSplit }) }), DATE, [DATE], ctlI);
    const d0 = utcDateTimeInputs(0n);
    await negative('readability', 'display: a non-canonical year split of the UTC date (1969 = 400*4 + 100*3 + 4*16 + 5)', A0, ISSUE,
      issueArgsOf(gG, sG, { ...aI, showArgs: ssOf({ expires_utc: d0.text, expires_split: [4n, 3n, 16n, 5n] }) }), SPLIT, [SPLIT, DATE], ctlI);
  }
  {
    const gP = sol.solGranteeOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y } as any, { origin: pass.policy.origin }, 0n);
    // a spending grant to a passkey carries its real RP hash
    const sP = scope({ read: true, readPk: rnd(), rpIdHash: pass.policy.rp_id_hash, maxCoinValue: 100n, perCallCap: 100n, cap: 100n, expiresAt: 1_000n });
    const aP = await authFor(A0, { op: 'issue_grant', grantee: gP, ...sP });
    textCheck('readability', 'issue_grant, a spending grant to a passkey grantee: the RP hash in hex, the expiry in seconds, the caps in full digits',
      aP.text.includes(`Passkey RP (hash): ${hex(pass.policy.rp_id_hash)}\n`) && aP.text.includes(`Expires at (block time, seconds): ${'1000'.padEnd(20)}\n`) && aP.text.includes(`Total cap: ${d39(100n)}\n`));
    await positive('readability', 'issue_grant, a spending grant to a passkey grantee (RP hash, expiry 1000): proved', undefined, A0, ISSUE, issueArgsOf(gP, sP, aP));
    // a read-only grant to a passkey carries no RP hash: "not applicable"
    const sR = scope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), rpIdHash: Z32, color: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
    const aR0 = await authFor(A0, { op: 'issue_grant', grantee: { ...gP, slot: 1n }, ...sR });
    textCheck('readability', 'issue_grant, a read-only grant to a passkey grantee: "Passkey RP (hash): not applicable", zero caps read "0"',
      aR0.text.includes(`Passkey RP (hash): ${NA}\n`) && aR0.text.includes(`Total cap: ${d39(0n)}\n`));
    await positive('readability', 'issue_grant, a read-only grant to a passkey grantee (no RP hash): proved', undefined, A0, ISSUE, issueArgsOf({ ...gP, slot: 1n }, sR, aR0));
    const ctlP = { a: A0, args: issueArgsOf(gP, sP, aP) };
    await negative('readability', 'forged word: the wallet signed "never" for an expiry of 1000', A0, ISSUE, issueArgsOf(gP, sP, await forgedAuth(aP, `seconds): ${'1000'.padEnd(20)}`, `seconds): ${'never'.padEnd(20)}`)), INVALID, [INVALID], ctlP);
    await negative('readability', 'forged word: the wallet signed "not applicable" for a passkey grantee\'s RP hash', A0, ISSUE, issueArgsOf(gP, sP, await forgedAuth(aP, `Passkey RP (hash): ${hex(pass.policy.rp_id_hash)}`, `Passkey RP (hash): ${NA}`)), INVALID, [INVALID], ctlP);
  }
  // the grantee twins
  const AGx = AG ?? (await execute(Original.Contract, A0, ISSUE, ctlI.args)).after;
  const AGU = (await execute(Original.Contract, AGx, 'deposit_unshielded', [COL_U, 5_000_000n])).after;
  const opening = (slot: bigint, s: Uint8Array, spent: bigint, maxCoin: bigint) => ({ originHash: grantOriginHash(msg.labelBytes(G.label)), slot, scopeSalt: s, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: maxCoin, spentPrev: spent });
  const gctx = (a: LocalAccount, slot: bigint) => { const r = ledgerOf(a).grants.lookup(G.grantId(a.addressBytes, slot)); return { contractAddress: a.addressBytes, label: G.label, slot, issuedAt: r.issued_at, grantNonce: r.nonce }; };
  {
    const o = { op: 'withdraw_unshielded_with_grant', amount: amt(COL_U, 2_500_000n), recipient: RU };
    const ga = await sol.authoriseSolGrantee(G.device, gctx(AGU, 0n), SITE, o as any);
    const gArgs = (x: any) => [COL_U, 2_500_000n, { bytes: RU }, ...grantAuthArgs(opening(0n, saltG, 0n, MAX128) as any, x)];
    const ctlG = { a: AGU, args: gArgs(ga) };
    textCheck('readability', 'the unshielded twin: "Amount (base units): 2500000…" in full digits (726 bytes)', ga.text.length === 726 && ga.message.length === 50 + 726 && ga.text.includes(`Amount (base units): ${d39(2_500_000n)}\n`));
    await positive('readability', 'the unshielded twin: proved; auth_nonce untouched', undefined, AGU, GWU, ctlG.args, (after) => ledgerOf(after).auth_nonce === ledgerOf(AGU).auth_nonce);
    await negative('readability', 'forged amount: the grantee signed "250000" for an executed 2500000', AGU, GWU, gArgs(await forgedAuth(ga, `Amount (base units): ${d39(2_500_000n)}`, `Amount (base units): ${d39(250_000n)}`, G.device)), GINVALID, [GINVALID], ctlG);
  }
  {
    const sS = scope({ opWithdrawUnshielded: false, opWithdrawShielded: true, opWithdrawShieldedToContract: true, read: true, readPk: rnd(), color: COL_A, maxCoinValue: 1000n, perCallCap: 600n, cap: 600n });
    const saltS = saltAt(A0, S);
    const AS = (await execute(Original.Contract, A0, ISSUE, issueArgsOf(G.grantee(1n), sS, await authFor(A0, { op: 'issue_grant', grantee: G.grantee(1n), ...sS })))).after;
    for (const circuit of [GWS, GWSC]) {
      const H = shieldedAccount(AS, 1000n);
      const enc = ledgerOf(H.a).enc_key;
      const change = rnd(192);
      const recipient = circuit === GWS ? localCoinPublicKeyBytes() : RC;
      const o = { op: circuit === GWS ? 'withdraw_shielded_with_grant' : 'withdraw_shielded_to_contract_with_grant', amount: amt(COL_A, 300n), recipient, changeEntry: change, encPk: enc,
        coin: { nonce: H.coin.nonce, color: COL_A, value: 1000n, mt_index: H.coin.mtIndex } };
      const ga = await sol.authoriseSolGrantee(G.device, gctx(H.a, 1n), SITE, o as any);
      const len = circuit === GWS ? 1566 : 1576;
      textCheck('readability', `the ${circuit === GWS ? 'shielded' : 'to-contract'} twin: the amount, spent value and change in full digits (${len} bytes)`, ga.text.length === len && ga.message.length === 50 + len
        && ga.text.includes(`Spent coin value: ${d39(1000n)}\n`) && ga.text.includes(`Change back to this account: ${d39(700n)}\n`));
      await positive('readability', `the ${circuit === GWS ? 'shielded' : 'to-contract'} twin 300 of a 1000 coin: proved`, undefined, H.a, circuit,
        [{ bytes: recipient }, COL_A, 300n, change, enc, ...grantAuthArgs(opening(1n, saltS, 0n, 1000n) as any, ga)]);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// rules: a passkey's own RP hash is never zero; an
// any-recipient grant carries no recipient
// ═════════════════════════════════════════════════════════════════════════════
async function sectionRules() {
  const rnd = rng('rules');
  const SITE = 'Rules prover test';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const authFor = (a: LocalAccount, o: any) => sol.authoriseSolDevice(S, ctxOf(a), SITE, o, counterIn(a, S));
  /** A valid signature over the CONTRACT's own bytes (the client renderer
   *  refuses these values, so the bytes come from the pure message circuit). */
  const circuitAuth = async (a: LocalAccount, o: any) => {
    const { bytes, showArgs } = sol.solDeviceMessageCircuit(S.key, ctxOf(a), SITE, o);
    return { ...(await authFor(a, { op: 'revoke_all_grants' })), ...(await signRawOver(S, bytes)), showArgs };
  };
  const ZERO_PK = "descriptor: a passkey's RP hash is zero";
  const ZERO_GRANTEE = "sol_ed25519: a passkey grantee's RP hash is zero";
  const RECIPIENT = 'sol_ed25519: a recipient without a recipient kind';
  const pass = softwarePasskey();
  const tR = sol.solTargetOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } } as any);
  const tZ = { ...tR, c: new Uint8Array(32) };
  const addArgs = (t: any, x: any) => [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(x)];
  const ctlAdd = { a: A0, args: addArgs(tR, await authFor(A0, { op: 'add_device', target: tR })) };
  await negative('rules', 'add_device of a passkey target whose RP hash is zero, under a valid signature over the contract\'s bytes', A0, ADD,
    addArgs(tZ, await circuitAuth(A0, { op: 'add_device', target: tZ })), ZERO_PK, [ZERO_PK], ctlAdd);
  // remove_device by descriptor: the zero-hash passkey's entry planted
  // through an upstream arm's raw add_device (the w117 recipe, recomputed)
  const k1 = K256Device.generate();
  const A1 = (await execute(Original.Contract, A0, ADD, addArgs(sol.solTargetOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) } as any),
    await authFor(A0, { op: 'add_device', target: sol.solTargetOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) } as any) })))).after;
  const ep = ledgerOf(A1).device_epoch as bigint;
  const le = (v: bigint, n: number) => { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const w117 = (t: any, e: bigint, c: bigint) => new Uint8Array(createHash('sha256').update(new Uint8Array([...padTag(DESCRIPTOR_TAGS.device.p256), ...A1.addressBytes, ...t.a, ...t.b, ...t.c, ...t.origin, ...le(e, 4), ...le(c, 8)])).digest());
  if (!Buffer.from(w117(tR, ep, 0n)).equals(Buffer.from(pass.device.entryAt(A1.addressBytes, ep, 0n)))) throw new Error('setup: the w117 recipe does not reproduce the passkey entry');
  const plantZ = w117(tZ, ep, 0n);
  const plantR = pass.device.entryAt(A1.addressBytes, ep, 0n);
  let A2 = A1;
  for (const e of [plantZ, plantR]) {
    const l = ledgerOf(A2);
    const kc = (() => { for (let c = 0n; c < 64n; c++) if (l.devices.member(k1.entryAt(A2.addressBytes, l.device_epoch, c))) return c; throw new Error('K not live'); })();
    A2 = (await execute(Original.Contract, A2, 'add_device_with_k256', [e, ...authArgs(k1.sign(k256Challenges.addDevice(ctxOf(A2), k1.pk, e), kc))])).after;
  }
  if (!ledgerOf(A2).devices.member(plantZ) || !ledgerOf(A2).devices.member(plantR)) throw new Error('setup: the plants did not land');
  stateOnly('rules', 'setup: the zero-hash passkey entry (w117 recipe, reproduced for the real hash) and the real one planted by the k256 device', true);
  const remArgs = (t: any, x: any) => [false, msg.solTargetArg(t), msg.solTargetPointArg(t), 0n, ep, Z32, ...authArgs(x)];
  const ctlRem = { a: A2, args: remArgs(tR, await authFor(A2, { op: 'remove_device', literal: false, target: tR, counter: 0n, epoch: ep })) };
  await negative('rules', 'remove_device by descriptor of a passkey target whose RP hash is zero (its entry live), under a valid signature over the contract\'s bytes', A2, REMOVE,
    remArgs(tZ, await circuitAuth(A2, { op: 'remove_device', literal: false, target: tZ, counter: 0n, epoch: ep })), ZERO_PK, [ZERO_PK], ctlRem);
  // issue_grant
  const COL = fill(32, 0xc1);
  const gP = sol.solGranteeOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y } as any, { origin: pass.policy.origin }, 0n);
  // a spending grant to a passkey (the RP hash must be its real one) and a
  // read-only one (it must be zero)
  const sP = scopeOf({ opWithdrawUnshielded: true, color: COL, maxCoinValue: 100n, perCallCap: 100n, cap: 100n, read: true, readPk: rnd(), rpIdHash: pass.policy.rp_id_hash });
  const ctlIssue = { a: A0, args: issueArgsOf(gP, sP, await authFor(A0, { op: 'issue_grant', grantee: gP, ...sP })) };
  const sZ = { ...sP, rpIdHash: new Uint8Array(32) };
  await negative('rules', 'a spending grant to a passkey grantee whose RP hash is zero, under a valid signature over the contract\'s bytes', A0, ISSUE,
    issueArgsOf(gP, sZ, await circuitAuth(A0, { op: 'issue_grant', grantee: gP, ...sZ })), ZERO_GRANTEE, [ZERO_GRANTEE], ctlIssue);
  const sRO = scopeOf({ read: true, readPk: rnd(), rpIdHash: pass.policy.rp_id_hash });
  const READ_ONLY_RP = 'sol_ed25519: a read-only grant carries no RP hash';
  const ctlRO = { a: A0, args: issueArgsOf(gP, { ...sRO, rpIdHash: Z32 }, await authFor(A0, { op: 'issue_grant', grantee: gP, ...sRO, rpIdHash: Z32 })) };
  await negative('rules', 'a read-only grant to a passkey grantee carrying its RP hash (which nothing would check), under a valid signature over the contract\'s bytes', A0, ISSUE,
    issueArgsOf(gP, sRO, await circuitAuth(A0, { op: 'issue_grant', grantee: gP, ...sRO })), READ_ONLY_RP, [READ_ONLY_RP], ctlRO);
  await positive('rules', 'a read-only grant to a passkey grantee with a zero RP hash: proved (original module)', undefined, A0, ISSUE, ctlRO.args,
    (after) => ledgerOf(after).grants.member(pass.grantee.grantId(after.addressBytes, grantOriginHash(pass.policy.origin), 0n)));
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const sAny = scopeOf({ opWithdrawUnshielded: true, color: COL, maxCoinValue: 100n, perCallCap: 100n, cap: 100n, recipientKind: 0n, recipient: rnd() });
  await negative('rules', 'issue_grant to any recipient (kind 0) carrying a recipient, under a valid signature over the contract\'s bytes', A0, ISSUE,
    issueArgsOf(G.grantee(0n), sAny, await circuitAuth(A0, { op: 'issue_grant', grantee: G.grantee(0n), ...sAny })), RECIPIENT, [RECIPIENT], ctlIssue);
  await positive('rules', 'issue_grant to any recipient (kind 0) with a zero recipient: proved (original module)', undefined, A0, ISSUE,
    issueArgsOf(G.grantee(0n), { ...sAny, recipient: Z32 }, await authFor(A0, { op: 'issue_grant', grantee: G.grantee(0n), ...sAny, recipient: Z32 })),
    (after) => ledgerOf(after).grants.member(G.grantId(after.addressBytes, 0n)));
}

// ═════════════════════════════════════════════════════════════════════════════
// module: the base modules' asserts reached through this arm's exports
// ═════════════════════════════════════════════════════════════════════════════
async function sectionModule() {
  const rnd = rng('module');
  const SITE = 'module asserts prover';
  const IDP = { x: 0n, y: 1n };
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const authFor = (o: any) => sol.authoriseSolDevice(S, ctxOf(A0), SITE, o, counterIn(A0, S));
  const shownFor = (o: any) => sol.solDeviceMessageCircuit(S.key, ctxOf(A0), SITE, o).showArgs as any[];
  /** A valid signature over `bytes`, the call carrying `showArgs`. */
  const signedOver = async (bytes: Uint8Array, showArgs: unknown[]) =>
    ({ ...(await authFor({ op: 'revoke_all_grants' })), ...(await signRawOver(S, bytes)), showArgs });
  const head = [{ bytes: A0.addressBytes }, S.key, ledgerOf(A0).auth_nonce];
  /** issue_grant's message as `pc` renders it (the contract's pure circuit, or a copy's). */
  const issueBytes = (pc: any, garg: unknown, sc: any, sh: unknown[]): Uint8Array => pc.sol_message_issue_grant(...head, garg,
    sc.opWithdrawUnshielded, sc.opWithdrawShielded, sc.opWithdrawShieldedToContract, sc.read, sc.color, sc.recipientKind, sc.recipient,
    sc.maxCoinValue, sc.perCallCap, sc.cap, sc.expiresAt, sc.rpIdHash, sc.readPk, sc.windowLen, sc.windowCap,
    { is_some: sc.caller !== null, value: { bytes: sc.caller ?? Z32 } }, ...sh);
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const gG = G.grantee(0n);
  const sU = scopeOf({ opWithdrawUnshielded: true, color: fill(32, 0xc1), maxCoinValue: 600n, perCallCap: 600n, cap: 1000n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: fill(32, 0x77) });
  const ctlIssue = { a: A0, args: issueArgsOf(gG, sU, await authFor({ op: 'issue_grant', grantee: gG, ...sU })) };
  await positive('module', 'issue_grant to a sol_ed25519 grantee: proved (original module)', undefined, A0, ISSUE, ctlIssue.args,
    (after) => ledgerOf(after).grants.member(G.grantId(after.addressBytes, 0n)));
  // the identity as a grantee: its encoding (0100..00) shown and signed;
  // only the Ed25519 class's A != O in the grant-id derivation refuses it
  const idKey = new Uint8Array(32); idKey[0] = 1;
  const gO = { ...gG, a: idKey };
  const mO = sol.solDeviceMessageCircuit(S.key, ctxOf(A0), SITE, { op: 'issue_grant', grantee: gO, ...sU } as any);
  await negative('module', "issue_grant: the identity as a sol_ed25519 grantee (its encoding shown and signed): refused by the Ed25519 class's A != O in the grant-id derivation", A0, ISSUE,
    issueArgsOf(gO, sU, await signedOver(mO.bytes, mO.showArgs), keyOf(IDP)), KEY_IS_IDENTITY, [KEY_IS_IDENTITY], ctlIssue);
  // an unregistered grant-id tag: the arm's registration check refuses the
  // tag; past it no kind is named, so the message shows the first kind's tag
  // text and key lines (evm_k256's) and the grant id takes its recipe (w52),
  // whose admission refuses the tag too; over an evm_k256-shaped grantee
  const gE = sol.solGranteeOf({ scheme: 'evm_k256', address: fill(20, 0x5e), blind: rnd() } as any, { label: 'Example dApp' }, 0n);
  const sRO = scopeOf({ read: true, readPk: rnd() });
  const ctlE = { a: A0, args: issueArgsOf(gE, sRO, await authFor({ op: 'issue_grant', grantee: gE, ...sRO })) };
  const badArg = { ...msg.solGranteeArg(gE), tag: padTag('midnight:account:grant:zz:v9') };
  const mTag = await copyFor([NOTREG_GRANT, W52G]);
  const shE = shownFor({ op: 'issue_grant', grantee: gE, ...sRO });
  const tagArgs = issueArgsOf(gE, sRO, await signedOver(issueBytes(mTag.pureCircuits, badArg, sRO, shE), shE), msg.solUnusedKey());
  tagArgs[0] = badArg;
  await negative('module', "issue_grant: an unregistered grant-id tag under a valid signature (the message shows the first kind's text): at runtime past the arm's registration check, the module's w52 grant-id recipe refuses it; at the proof server both", A0, ISSUE,
    tagArgs, NOTREG_GRANT, [NOTREG_GRANT, W52G], ctlE, { simulatorModule: await copyFor([NOTREG_GRANT]), simulatorExpect: W52G });
  // an unknown recipient kind: the module's renderer has no label for 4
  // (past its check the text would be the last label's)
  const mKind = await copyFor([UNKNOWN_KIND]);
  const sK = { ...sU, recipientKind: 4n };
  const shU = shownFor({ op: 'issue_grant', grantee: gG, ...sU });
  await negative('module', 'issue_grant: recipient kind 4 under a valid signature over what the renderer shows past its check: refused by the module\'s recipient-kind labels', A0, ISSUE,
    issueArgsOf(gG, sK, await signedOver(issueBytes(mKind.pureCircuits, msg.solGranteeArg(gG), sK, shU), shU)), UNKNOWN_KIND, [UNKNOWN_KIND], ctlIssue);
  // a blank decimal: grantee slot 0 shown as three spaces (the digits read
  // back as 0); only the module's empty-decimal check refuses it
  const mEmpty = await copyFor([EMPTY_DECIMAL]);
  const shBlank = [{ ...shU[0], slot: [32n, 32n, 32n] }, ...shU.slice(1)];
  await negative('module', "issue_grant: grantee slot 0 shown as three spaces, signed over that text: refused by the module's empty-decimal check", A0, ISSUE,
    issueArgsOf(gG, sU, await signedOver(issueBytes(mEmpty.pureCircuits, msg.solGranteeArg(gG), sU, shBlank), shBlank)), EMPTY_DECIMAL, [EMPTY_DECIMAL], ctlIssue);
  // an unknown k256 signing envelope on a k256 target: the module's
  // renderer has no label for 2 (past its check it would show a blank)
  const k1 = K256Device.generate();
  const tK = sol.solTargetOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) } as any);
  const addArgs = (targ: unknown, au: any) => [targ, msg.solTargetPointArg(tK), ...authArgs(au)];
  const ctlAdd = { a: A0, args: addArgs(msg.solTargetArg(tK), await authFor({ op: 'add_device', target: tK })) };
  const mEnv = await copyFor([ENVELOPE]);
  const envArg = { ...msg.solTargetArg(tK), envelope: 2n };
  const shK = shownFor({ op: 'add_device', target: tK });
  const envBytes: Uint8Array = mEnv.pureCircuits.sol_message_add_device(...head, envArg, ...shK);
  await negative('module', "add_device: a k256 target with signing envelope 2 under a valid signature over what the renderer shows past its check: refused by the module's envelope labels", A0, ADD,
    addArgs(envArg, await signedOver(envBytes, shK)), ENVELOPE, [ENVELOPE], ctlAdd);
}

// ═════════════════════════════════════════════════════════════════════════════
// hints: the verification's checked inputs
// ═════════════════════════════════════════════════════════════════════════════
async function sectionHints() {
  const rnd = rng('hints');
  const SITE = 'Hints prover test';
  const { seed, d: device } = await solDevice(rnd());
  const A0 = await activated(device, rnd());
  const newKey = rnd();
  const a1 = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'rotate_enc_key', newKey }, 0n);
  const control = { a: A0, args: [newKey, ...authArgs(a1)] };
  await positive('hints', 'honest rotation with its verification inputs (original module)', undefined, A0, ROTATE, control.args);
  const L = sol.ED25519_L, P = (1n << 255n) - 19n;
  const h = sha512(seed).slice(0, 32); h[0] &= 248; h[31] &= 127; h[31] |= 64;
  const secret = leInt(h) % L;
  const le = (v: bigint) => Array.from({ length: 32 }, (_, i) => (v >> BigInt(8 * i)) & 0xffn);
  const val = (b: bigint[]) => b.reduce((acc, x, i) => acc + (x << BigInt(8 * i)), 0n);
  /** R = [r]B for a nonce whose x parity is `odd` (when given), with R's
   *  honest encoding and x bytes. */
  const nonce = (odd?: boolean) => {
    for (;;) {
      const r = leInt(rnd()) % L;
      if (r === 0n) continue;
      const R = ed25519.Point.BASE.multiply(r).toAffine();
      if (odd !== undefined && ((R.x & 1n) === 1n) !== odd) continue;
      return { r, R, e: Array.from(ed25519.Point.fromAffine(R).toBytes(), (x) => BigInt(x)), x: le(R.x) };
    }
  };
  /** A signature whose hash takes `e` as R's encoding: s = r + k a with
   *  k = SHA-512(e || A || M) mod L, so the equation holds for the bytes the
   *  circuit hashes and only the encoding checks can refuse. */
  const signedOver = (n: ReturnType<typeof nonce>, e: bigint[]) => {
    const k = leInt(sha512(new Uint8Array([...e.map((x) => Number(x & 0xffn)), ...device.key, ...a1.message]))) % L;
    return { r: { x: n.R.x, y: n.R.y }, s: (n.r + k * secret) % L };
  };
  const call = (sig: any, r_bytes: bigint[], r_x: bigint[]) => {
    const args = [newKey, ...authArgs(a1)];
    args[args.length - 1] = { ...(args.at(-1) as any), sig, r_bytes, r_x };
    return args;
  };
  const Y = KEYY, X = KEYX, SIGN = KEYSIGN;
  {
    const n = nonce(); const e = [...n.e]; e[5] ^= 1n;
    await negative('hints', "R's encoding with one byte flipped, signed over that encoding", A0, ROTATE, call(signedOver(n, e), e, n.x), Y, [Y], control);
  }
  {
    const n = nonce(); const e = [...n.e]; e[31] ^= 128n;
    await negative('hints', "R's encoding with the sign bit flipped, signed over that encoding", A0, ROTATE, call(signedOver(n, e), e, n.x), SIGN, [SIGN], control);
  }
  {
    const n = nonce(true); const e = le((n.R.y + P) & ((1n << 256n) - 1n));
    await negative('hints', "R's encoding as y + p (x odd, so the sign bit agrees), signed over that encoding", A0, ROTATE, call(signedOver(n, e), e, n.x), Y, [Y], control);
  }
  {
    // y + p for y below 19 stays below 2^255, so it is a second encoding with
    // the sign bit clear. Every curve point with y below 19 other than the
    // identity has a torsion component, so for R it is reachable only as
    // R = O (y = 1). The core's y check refuses it first (R != O reads the
    // checked x bytes after the encoding check); with that check bypassed,
    // R != O refuses it too.
    const e = le(1n + P);
    const k = leInt(sha512(new Uint8Array([...e.map((x) => Number(x)), ...device.key, ...a1.message]))) % L;
    await negative('hints', "R = O with R's encoding as y + p (y = 1, below 19), signed over that encoding: R != O and the y check both refuse", A0, ROTATE,
      call({ r: { x: 0n, y: 1n }, s: (k * secret) % L }, e, le(0n)), Y, [RID, Y], control);
  }
  {
    const n = nonce(); const x = [...n.x]; x[7] ^= 1n;
    await negative('hints', "R's x bytes with one byte flipped (the parity kept), under an honest signature", A0, ROTATE, call(signedOver(n, n.e), n.e, x), X, [X], control);
  }
  {
    const n = nonce(); const x = le(n.R.x + P);
    await negative('hints', "R's x bytes as x + p (the parity flips), under an honest signature", A0, ROTATE, call(signedOver(n, n.e), n.e, x), X, [X, SIGN], control);
  }
  // the carry attack: the same 256-bit value with a byte of 256 or more, its
  // neighbour minus one. The circuit rebuilds the right value from such
  // bytes, so only the 8-bit range check on every byte input can refuse it.
  // The runtime refuses the argument's type, and a one-byte input cannot
  // encode it; the copy encodes the byte vectors with two-byte atoms (the
  // same preimage for every honest byte, so its control proves) and lets the
  // value reach the proof server.
  const carry = (b: bigint[]) => {
    const c = [...b]; const i = c.findIndex((_, j) => j > 0 && j < 30 && c[j + 1] > 0n);
    c[i] += 256n; c[i + 1] -= 1n;
    if (val(c) !== val(b)) throw new Error('carry: not the same value');
    return c;
  };
  const wide = async (name: string, a: LocalAccount, circuit: string, args: unknown[], bypass: string[], ctl: { a: LocalAccount; args: unknown[] }) => {
    let t0 = 0, r0 = 0;
    await negative('hints', name, a, circuit, args, /type error/, bypass, ctl, {
      module: await copyFor(bypass, HINT_OVERRIDES),
      overridesLabel: 'byte vectors encoded with two-byte atoms and argument type checks suspended (HINT_OVERRIDES), also for the control',
      hooks: { control: () => { hintOverride.on = true; }, attempt: () => { hintOverride.on = true; t0 = hintOverride.typeErrors; r0 = hintOverride.ranges; }, simulator: () => { hintOverride.on = false; } },
      after: () => { hintOverride.on = false; },
      check: () => (hintOverride.ranges > r0 && hintOverride.typeErrors > t0 ? undefined : 'the byte of 256 or more never reached the proof request'),
    });
  };
  {
    const n = nonce();
    await wide("R's encoding with the carry attack (a byte of 256 or more, its neighbour minus one), under an honest signature", A0, ROTATE,
      call(signedOver(n, n.e), carry(n.e), n.x), [Y, INVALID], control);
  }
  {
    const n = nonce();
    await wide("R's x bytes with the carry attack, under an honest signature", A0, ROTATE, call(signedOver(n, n.e), n.e, carry(n.x)), [X], control);
  }

  // the signing key's byte inputs (the seam's derivation checks them against
  // the key's point before anything uses them)
  const keyIn = sol.solKeyHints(device.pk);
  const withKey = (pk_bytes: bigint[], pk_x: bigint[]) => {
    const args = [newKey, ...authArgs(a1)];
    args[args.length - 1] = { ...(args.at(-1) as any), pk_bytes, pk_x };
    return args;
  };
  {
    const x = [...keyIn.pk_x]; x[11] ^= 1n;
    await negative('hints', "the signing key's x bytes with one byte flipped (the parity kept), under an honest signature", A0, ROTATE, withKey(keyIn.pk_bytes, x), X, [X], control);
  }
  await wide("the signing key's bytes with the carry attack, under an honest signature", A0, ROTATE, withKey(carry(keyIn.pk_bytes), keyIn.pk_x),
    [Y, B58HI, UNKNOWN, INVALID], control);
  await wide("the signing key's x bytes with the carry attack, under an honest signature", A0, ROTATE, withKey(keyIn.pk_bytes, carry(keyIn.pk_x)), [X], control);

  // the signing key's bytes forged with everything else consistent with
  // them: an entry for the forged bytes planted through an upstream arm's
  // raw add_device (that pure derivation checks no key), the message
  // rendered with the forged bytes as the signing key, and a signature whose
  // hash takes the forged bytes (s = r + k a, a the key's secret scalar), so
  // only the key encoding's y check can refuse
  {
    const k = K256Device.generate();
    const tK = sol.solTargetOf({ scheme: 'k256', x: k.pk.x, y: k.pk.y, envelope: Number(k.envelope) } as any);
    const auK = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: tK }, counterIn(A0, device));
    const AK = (await execute(Original.Contract, A0, 'add_device_with_sol_ed25519', [msg.solTargetArg(tK), msg.solTargetPointArg(tK), ...authArgs(auK)])).after;
    const fb = Uint8Array.from(device.key); fb[9] ^= 4;
    const lK = ledgerOf(AK);
    const leN = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    const plant = new Uint8Array(createHash('sha256').update(new Uint8Array([...padTag(DESCRIPTOR_TAGS.device.sol_ed25519), ...AK.addressBytes, ...fb,
      ...device.blind, ...leN(lK.device_epoch as bigint, 4), ...leN(0n, 8)])).digest());
    const AP = (await execute(Original.Contract, AK, 'add_device_with_k256', [plant, ...authArgs(k.sign(k256Challenges.addDevice(ctxOf(AK), k.pk, plant), 0n))])).after;
    const nk = rnd();
    const m = sol.solDeviceMessageCircuit(fb, ctxOf(AP), SITE, { op: 'rotate_enc_key', newKey: nk });
    const n = nonce();
    const kk = leInt(sha512(new Uint8Array([...n.e.map((x) => Number(x)), ...fb, ...msg.solSignedMessage('raw', fb, m.bytes)]))) % L;
    const sig = { r: { x: n.R.x, y: n.R.y }, s: (n.r + kk * secret) % L };
    const forgedAuth = { pk: device.pk, pk_bytes: Array.from(fb, (b) => BigInt(b)), pk_x: keyIn.pk_x, blind: device.blind, use_counter: 0n, offchain: false, sig, r_bytes: n.e, r_x: n.x };
    const auH = await sol.authoriseSolDevice(device, ctxOf(AP), SITE, { op: 'rotate_enc_key', newKey: nk }, counterIn(AP, device));
    await negative('hints', "the signing key's bytes forged (an entry planted for them, the message and the signature over them): refused only by the key encoding's y check",
      AP, ROTATE, [nk, ...m.showArgs, forgedAuth], Y, [Y], { a: AP, args: [nk, ...authArgs(auH)] });
  }

  // a target's key inputs (add_device): a Solana target's are checked by the
  // same encoding; any other class must pass zero bytes
  {
    const { d: S3 } = await solDevice(rnd());
    const t3 = sol.solTargetOf(S3.descriptor());
    const au3 = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: t3 }, counterIn(A0, device));
    const k3 = msg.solTargetPointArg(t3) as any;
    const addArgs = (key: unknown) => [msg.solTargetArg(t3), key, ...authArgs(au3)];
    const ctlAdd = { a: A0, args: addArgs(k3) };
    await positive('hints', 'add_device of a Solana target with its key inputs (original module)', undefined, A0, ADD, ctlAdd.args);
    const x = [...k3.pk_x]; x[25] ^= 2n;
    await negative('hints', "add_device: the Solana target's x bytes with one byte flipped (the parity kept)", A0, ADD, addArgs({ ...k3, pk_x: x }), X, [X], ctlAdd);
    await wide("add_device: the Solana target's key bytes with the carry attack", A0, ADD, addArgs({ ...k3, pk_bytes: carry(k3.pk_bytes) }), [Y, B58HI, NOT_POINT], ctlAdd);
    await wide("add_device: the Solana target's x bytes with the carry attack", A0, ADD, addArgs({ ...k3, pk_x: carry(k3.pk_x) }), [X], ctlAdd);
    const jub = JubjubDevice.generate();
    const tJ = sol.solTargetOf({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y } as any);
    const auJ = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: tJ }, counterIn(A0, device));
    const ctlJ = { a: A0, args: [msg.solTargetArg(tJ), msg.solUnusedKey(), ...authArgs(auJ)] };
    const kbJ = [5n, ...new Array<bigint>(31).fill(0n)];
    const shJ = auJ.showArgs as any[];
    const auJ2 = { ...auJ, showArgs: [{ ...shJ[0], key: msg.solBase58(Uint8Array.from(kbJ, Number)) }, ...shJ.slice(1)] };
    await negative('hints', 'add_device: a jubjub target passing non-zero key bytes (its point the identity; their base58 inputs supplied, a jubjub block shows no Solana key)', A0, ADD,
      [msg.solTargetArg(tJ), { ...msg.solUnusedKey(), pk_bytes: kbJ }, ...authArgs(auJ2)], UNUSED_KEY, [UNUSED_KEY], ctlJ);
  }

  // Each encoding check on its own at every place the arm checks a key: the
  // signing key (its sign bit here; its y and x checks above), a Solana
  // target, a Solana grantee, the grant seam's signer and the boot key. The
  // forged byte input comes with everything else consistent with it: the
  // message renders a Solana key from its bytes, so it is rendered from the
  // forged bytes and signed (a hash that takes the forged bytes as the key's
  // encoding where they are the signer's own); an entry, grant or boot
  // commitment the call looks up is derived from the forged bytes. So only
  // the check under test can refuse. Flipping bit 255 keeps y (the y check
  // strips that bit) and breaks only the parity check.
  const flipY = (b: Uint8Array) => { const o = Uint8Array.from(b); o[9] ^= 4; return o; };
  const flipSign = (b: Uint8Array) => { const o = Uint8Array.from(b); o[31] ^= 128; return o; };
  const flipX = (x: bigint[]) => { const o = [...x]; o[13] ^= 1n; return o; };
  const big = (b: Uint8Array) => Array.from(b, (v) => BigInt(v));
  const secretOf = (sd: Uint8Array) => { const hh = sha512(sd).slice(0, 32); hh[0] &= 248; hh[31] &= 127; hh[31] |= 64; return leInt(hh) % L; };
  /** a raw signature by secret `sk` over the text `m` whose hash takes
   *  `claimed` as the key's encoding */
  const signClaimed = (sk: bigint, claimed: Uint8Array, m: Uint8Array) => {
    const n = nonce();
    const k = leInt(sha512(new Uint8Array([...n.e.map((v) => Number(v)), ...claimed, ...msg.solSignedMessage('raw', claimed, m)]))) % L;
    return { sig: { r: { x: n.R.x, y: n.R.y }, s: (n.r + k * sk) % L }, r_bytes: n.e, r_x: n.x };
  };
  const lastArg = (args: unknown[], o: Record<string, unknown>) => { const c = [...args]; c[c.length - 1] = { ...(c.at(-1) as any), ...o }; return c; };

  // the signing key with its sign bit flipped: an entry planted for those
  // bytes (an upstream arm's raw add_device), the message and the signature over them
  {
    const k = K256Device.generate();
    const tK = sol.solTargetOf({ scheme: 'k256', x: k.pk.x, y: k.pk.y, envelope: Number(k.envelope) } as any);
    const auK = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: tK }, counterIn(A0, device));
    const AK = (await execute(Original.Contract, A0, 'add_device_with_sol_ed25519', [msg.solTargetArg(tK), msg.solTargetPointArg(tK), ...authArgs(auK)])).after;
    const fb = flipSign(device.key);
    const lK = ledgerOf(AK);
    const leN = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    const plant = new Uint8Array(createHash('sha256').update(new Uint8Array([...padTag(DESCRIPTOR_TAGS.device.sol_ed25519), ...AK.addressBytes, ...fb,
      ...device.blind, ...leN(lK.device_epoch as bigint, 4), ...leN(0n, 8)])).digest());
    const AP = (await execute(Original.Contract, AK, 'add_device_with_k256', [plant, ...authArgs(k.sign(k256Challenges.addDevice(ctxOf(AK), k.pk, plant), 0n))])).after;
    const nk = rnd();
    const m = sol.solDeviceMessageCircuit(fb, ctxOf(AP), SITE, { op: 'rotate_enc_key', newKey: nk });
    const sc = signClaimed(secret, fb, m.bytes);
    const forgedAuth = { pk: device.pk, pk_bytes: big(fb), pk_x: keyIn.pk_x, blind: device.blind, use_counter: 0n, offchain: false, ...sc };
    const auH = await sol.authoriseSolDevice(device, ctxOf(AP), SITE, { op: 'rotate_enc_key', newKey: nk }, counterIn(AP, device));
    await negative('hints', "the signing key's sign bit flipped (an entry planted for those bytes, the message and the signature over them): refused only by the parity check",
      AP, ROTATE, [nk, ...m.showArgs, forgedAuth], SIGN, [SIGN], { a: AP, args: [nk, ...authArgs(auH)] });
  }

  // a Solana target (add_device): the descriptor's key and the key argument's
  // bytes forged together, the block rendered from them, the device's signature
  {
    const { d: S4 } = await solDevice(rnd());
    const t4 = sol.solTargetOf(S4.descriptor());
    const k4 = msg.solTargetPointArg(t4) as any;
    const ctl4 = { a: A0, args: [msg.solTargetArg(t4), k4, ...authArgs(await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: t4 }, counterIn(A0, device)))] };
    for (const [what, fb, expect] of [['key bytes with one byte flipped', flipY(t4.a!), Y], ['key bytes with the sign bit flipped', flipSign(t4.a!), SIGN]] as [string, Uint8Array, string][]) {
      const tF = { ...t4, a: fb };
      const auF = await sol.authoriseSolDevice(device, ctxOf(A0), SITE, { op: 'add_device', target: tF }, counterIn(A0, device));
      await negative('hints', `add_device: the Solana target's ${what} (its descriptor key too; the block shows them, the device signed it): refused only by ${expect === Y ? 'the y check' : 'the parity check'}`,
        A0, ADD, [msg.solTargetArg(tF), { ...k4, pk_bytes: big(fb) }, ...authArgs(auF)], expect, [expect], ctl4);
    }
  }

  // a Solana grantee (issue_grant) and, with a grant issued to it, the grant
  // seam's signer
  {
    const gSeed = rnd();
    const G4 = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(gSeed), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
    const g4 = G4.grantee(0n);
    const k4 = msg.solTargetPointArg(g4) as any;
    const COL = fill(32, 0xc1), PIN = fill(32, 0x77);
    const sc = scopeOf({ opWithdrawUnshielded: true, color: COL, maxCoinValue: 600n, perCallCap: 600n, cap: 1000n, recipientKind: RECIPIENT_USER_ADDRESS, recipient: PIN });
    const issueAuth = (a: LocalAccount, g: any) => sol.authoriseSolDevice(device, ctxOf(a), SITE, { op: 'issue_grant', grantee: g, ...sc } as any, counterIn(a, device));
    const auI = await issueAuth(A0, g4);
    const ctlI = { a: A0, args: issueArgsOf(g4, sc, auI) };
    for (const [what, fb, expect] of [['key bytes with one byte flipped', flipY(g4.a!), Y], ['key bytes with the sign bit flipped', flipSign(g4.a!), SIGN]] as [string, Uint8Array, string][]) {
      const gF = { ...g4, a: fb };
      await negative('hints', `issue_grant: the Solana grantee's ${what} (its descriptor key too; the grantee block shows them, the device signed it): refused only by ${expect === Y ? 'the y check' : 'the parity check'}`,
        A0, ISSUE, issueArgsOf(gF, sc, await issueAuth(A0, gF), { ...k4, pk_bytes: big(fb) }), expect, [expect], ctlI);
    }
    await negative('hints', "issue_grant: the Solana grantee's x bytes with one byte flipped (the parity kept; the message shows its bytes, unchanged)",
      A0, ISSUE, issueArgsOf(g4, sc, auI, { ...k4, pk_x: flipX(k4.pk_x) }), X, [X], ctlI);

    // the grant seam: the honest grant, then a grant planted for each forged
    // encoding (issued through a copy that skips that check in JavaScript,
    // executed locally only), the grantee's message rendered from the forged
    // bytes and signed with a hash that takes them
    const A1 = (await execute(Original.Contract, A0, ISSUE, ctlI.args)).after;
    const AU = (await execute(Original.Contract, A1, 'deposit_unshielded', [COL, 1000n])).after;
    const label = msg.labelBytes(G4.label);
    // each grant's own scope salt: the honest grant's issued on A0, a planted one on AU
    const openingOf = (salt: Uint8Array) => ({ originHash: grantOriginHash(label), slot: 0n, scopeSalt: salt, recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: PIN, maxCoinValue: 600n, spentPrev: 0n });
    const o200 = { op: 'withdraw_unshielded_with_grant', amount: { color: COL, amount: 200n, decimals: 0, symbol: 'tU' }, recipient: PIN };
    const gctxOf = (a: LocalAccount, id: Uint8Array) => { const r = ledgerOf(a).grants.lookup(id); return { contractAddress: a.addressBytes, label: G4.label, slot: 0n, issuedAt: r.issued_at, grantNonce: r.nonce }; };
    const gArgs = (au: any, salt = saltAt(A0, device)) => [COL, 200n, { bytes: PIN }, ...grantAuthArgs(openingOf(salt) as any, au)];
    const honestG = async (a: LocalAccount) => gArgs(await sol.authoriseSolGrantee(G4.device, gctxOf(a, G4.grantId(a.addressBytes, 0n)), SITE, o200 as any));
    const ctlU = { a: AU, args: await honestG(AU) };
    await negative('hints', "withdraw_unshielded_with_grant: the grantee's x bytes with one byte flipped (the parity kept), under its honest signature",
      AU, GWU, lastArg(ctlU.args, { pk_x: flipX((ctlU.args.at(-1) as any).pk_x) }), X, [X], ctlU);
    for (const [what, fb, expect] of [['key bytes with one byte flipped', flipY(G4.key), Y], ['key bytes with the sign bit flipped', flipSign(G4.key), SIGN]] as [string, Uint8Array, string][]) {
      const cp = await copyFor([expect]);
      const gF = { ...g4, a: fb };
      const AF = (await execute(cp.Contract, AU, ISSUE, issueArgsOf(gF, sc, await issueAuth(AU, gF), { ...k4, pk_bytes: big(fb) }))).after;
      cp.resetFired();
      const idF = cp.pureCircuits.derive_grant_id_with_sol_ed25519({ bytes: AF.addressBytes }, G4.device.pk, big(fb), k4.pk_x, G4.device.blind, grantOriginHash(label), 0n);
      cp.resetFired();
      if (!ledgerOf(AF).grants.member(idF)) throw new Error('setup: the planted grant');
      const m = sol.solGranteeMessageCircuit(fb, gctxOf(AF, idF), SITE, o200 as any);
      const sg = signClaimed(secretOf(gSeed), fb, m.bytes);
      const forged = lastArg(gArgs({ arm: 'sol_ed25519', pk: G4.device.pk, blind: G4.device.blind, label, offchain: false, sig: sg.sig, showArgs: m.showArgs, message: msg.solSignedMessage('raw', fb, m.bytes) }, saltAt(AU, device)),
        { pk_bytes: big(fb), r_bytes: sg.r_bytes, r_x: sg.r_x });
      await negative('hints', `withdraw_unshielded_with_grant: the grantee's ${what} (a grant planted for them, the message and the signature over them): refused only by ${expect === Y ? 'the y check' : 'the parity check'}`,
        AF, GWU, forged, expect, [expect], { a: AF, args: await honestG(AF) });
    }
  }

  // the boot key (activation, no signature): a boot commitment derived from
  // the forged bytes committed at deployment
  {
    const { d: dB } = await solDevice(rnd());
    const saltB = rnd();
    const rpk = JubjubDevice.generate().pk;
    const atB = await dormant(dB.bootCommitment(saltB), rpk);
    const [pkB, bytesB, xB, , blindB] = dB.activationArgs(saltB);
    const ctlB = { a: atB, args: dB.activationArgs(saltB) };
    await negative('hints', 'activation: the boot key\'s x bytes with one byte flipped (the parity kept; the commitment binds the bytes, unchanged): refused only by the x check', atB, ACTIVATE,
      [pkB, bytesB, flipX(xB), saltB, blindB], X, [X], ctlB);
    for (const [what, fb, expect] of [['key bytes with one byte flipped', flipY(dB.key), Y], ['key bytes with the sign bit flipped', flipSign(dB.key), SIGN]] as [string, Uint8Array, string][]) {
      const cp = await copyFor([expect]);
      const commit = cp.pureCircuits.derive_boot_commitment_with_sol_ed25519(saltB, pkB, big(fb), xB, blindB);
      cp.resetFired();
      const atF = await dormant(commit, rpk);
      await negative('hints', `activation: the boot key's ${what} (the boot commitment of those bytes committed): refused only by ${expect === Y ? 'the y check' : 'the parity check'}`, atF, ACTIVATE,
        [pkB, big(fb), xB, saltB, blindB], expect, [expect], ctlB);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// arm-asserts: the arm's own asserts the sections above do not refuse
// ═════════════════════════════════════════════════════════════════════════════
const ALREADY = 'already activated';
const READ_KEY = 'sol_ed25519: read without a read key';
const LABEL = 'display: not a zero-padded label';
const CHARS = 'display: characters do not match the value';
const ORIGIN_VISIBLE = 'display: passkey origin not visible ASCII';
const UNUSED_SECOND = 'descriptor: unused second field must be zero';
const UNUSED_RP = 'descriptor: unused rp hash must be zero';
const UNUSED_ORIGIN = 'descriptor: unused origin must be zero';
const UNUSED_LABEL = 'descriptor: unused label must be zero';
const READABLE_OH = "descriptor: a readable grantee's origin hash is derived";
const PASSKEY_OH = "descriptor: a passkey grantee's origin hash is derived";
const LITERAL_SHOW = "display: a literal removal's display inputs are not those of an empty target";

/** A label's characters: the text's bytes, then zero bytes (no grammar check). */
const chars32 = (t: string) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(t)); return [...b].map(BigInt); };
/** 21 origin characters from bytes. */
const chars21 = (b: Uint8Array) => [...b].map(BigInt);
/** A decimal or label field of `width` bytes: the text, then spaces. */
const spaced = (t: string, width: number) => Array.from({ length: width }, (_, i) => BigInt(i < t.length ? t.charCodeAt(i) : 32));

/** The device-role helpers of a section: the wallet's authorisation, the
 *  contract's display inputs, a valid signature over given bytes, and the
 *  message as a module's pure circuits render it from explicit inputs. */
function deviceKit(S: Dev, site: string) {
  const authFor = (a: LocalAccount, o: any) => sol.authoriseSolDevice(S, ctxOf(a), site, o, counterIn(a, S));
  const shownFor = (a: LocalAccount, o: any) => sol.solDeviceMessageCircuit(S.key, ctxOf(a), site, o).showArgs as any[];
  const signedOver = async (a: LocalAccount, bytes: Uint8Array, showArgs: unknown[]) =>
    ({ ...(await authFor(a, { op: 'revoke_all_grants' })), ...(await signRawOver(S, bytes)), showArgs });
  /** a valid signature over the contract's own bytes for `o` */
  const circuitAuth = async (a: LocalAccount, o: any) => { const m = sol.solDeviceMessageCircuit(S.key, ctxOf(a), site, o); return signedOver(a, m.bytes, m.showArgs); };
  const head = (a: LocalAccount) => [{ bytes: a.addressBytes }, S.key, ledgerOf(a).auth_nonce];
  const issueBytes = (pc: any, a: LocalAccount, garg: unknown, sc: any, sh: unknown[]): Uint8Array => pc.sol_message_issue_grant(...head(a), garg,
    sc.opWithdrawUnshielded, sc.opWithdrawShielded, sc.opWithdrawShieldedToContract, sc.read, sc.color, sc.recipientKind, sc.recipient,
    sc.maxCoinValue, sc.perCallCap, sc.cap, sc.expiresAt, sc.rpIdHash, sc.readPk, sc.windowLen, sc.windowCap,
    { is_some: sc.caller !== null, value: { bytes: sc.caller ?? Z32 } }, ...sh);
  const addBytes = (pc: any, a: LocalAccount, targ: unknown, sh: unknown[]): Uint8Array => pc.sol_message_add_device(...head(a), targ, ...sh);
  return { authFor, shownFor, signedOver, circuitAuth, head, issueBytes, addBytes };
}
/** issue_grant's arguments from a grantee argument (raw) and a key argument. */
const issueArgsRaw = (garg: unknown, pk: unknown, sc: any, au: any) => [garg, pk, sc.opWithdrawUnshielded, sc.opWithdrawShielded,
  sc.opWithdrawShieldedToContract, sc.read, sc.color, sc.recipientKind, sc.recipient, sc.maxCoinValue, sc.perCallCap, sc.cap, sc.expiresAt, sc.rpIdHash, sc.readPk,
  sc.windowLen, sc.windowCap, { is_some: sc.caller !== null, value: { bytes: sc.caller ?? Z32 } }, ...authArgs(au)];

async function sectionArmAsserts() {
  const rnd = rng('arm-asserts');
  const SITE = 'Arm asserts prover test';
  const { d: S } = await solDevice(rnd());
  const salt = rnd();
  const at = await dormant(S.bootCommitment(salt), JubjubDevice.generate().pk);
  const A0 = (await execute(Original.Contract, at, ACTIVATE, S.activationArgs(salt))).after;
  const K = deviceKit(S, SITE);

  // activation: a second activation of an activated account with the
  // device's own honest arguments; activation also clears the boot
  // commitment, so the boot check fires too and is bypassed with it
  await negative('arm-asserts', 'activation: the activated account activated again with its own honest arguments', A0, ACTIVATE, S.activationArgs(salt),
    ALREADY, [ALREADY, BOOT], { a: at, args: S.activationArgs(salt) });

  // the site label's grammar: two spaces between its words, signed over that text
  {
    const k = rnd();
    const au = await K.authFor(A0, { op: 'rotate_enc_key', newKey: k });
    const sh = au.showArgs as any[];
    const m = await copyFor([LABEL]);
    const show = { ...sh[0], site: chars32('Two  spaces') };
    const bytes: Uint8Array = m.pureCircuits.sol_message_rotate_enc_key(...K.head(A0), k, show, sh[1], sh[2]);
    await negative('arm-asserts', 'rotate_enc_key: a site label with two spaces between its words, signed over that text: refused by the label grammar', A0, ROTATE,
      [k, ...authArgs(await K.signedOver(A0, bytes, [show, sh[1], sh[2]]))], LABEL, [LABEL], { a: A0, args: [k, ...authArgs(au)] });
  }

  // issue_grant: a sol_ed25519 grantee and a spending scope
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const gG = G.grantee(0n);
  const sU = scopeOf({ opWithdrawUnshielded: true, color: fill(32, 0xc1), maxCoinValue: 600n, perCallCap: 600n, cap: 1000n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: fill(32, 0x77) });
  const ctlIssue = { a: A0, args: issueArgsOf(gG, sU, await K.authFor(A0, { op: 'issue_grant', grantee: gG, ...sU })) };
  // the read flag with a zero read key (the record would store the hash of
  // zero, which the shared chip's own key check accepts)
  {
    const sR = { ...sU, read: true, readPk: Z32 };
    await negative('arm-asserts', 'issue_grant: the read flag set with a zero read key, under a valid signature over the contract\'s bytes', A0, ISSUE,
      issueArgsOf(gG, sR, await K.circuitAuth(A0, { op: 'issue_grant', grantee: gG, ...sR })), READ_KEY, [READ_KEY], ctlIssue);
  }
  // the grantee label: two spaces (its characters equal its bytes), and
  // characters that differ from its bytes, each signed over the text shown
  {
    const sh = K.shownFor(A0, { op: 'issue_grant', grantee: gG, ...sU });
    const mL = await copyFor([LABEL]);
    const gargL = { ...msg.solGranteeArg(gG), label: Uint8Array.from(chars32('Example  dApp'), Number) };
    const shL = [{ ...sh[0], label: chars32('Example  dApp') }, ...sh.slice(1)];
    await negative('arm-asserts', 'issue_grant: a sol_ed25519 grantee whose label has two spaces between its words, signed over that text: refused by the label grammar', A0, ISSUE,
      issueArgsRaw(gargL, msg.solTargetPointArg(gG), sU, await K.signedOver(A0, K.issueBytes(mL.pureCircuits, A0, gargL, sU, shL), shL)), LABEL, [LABEL], ctlIssue);
    const mC = await copyFor([CHARS]);
    const shC = [{ ...sh[0], label: chars32('Example dApq') }, ...sh.slice(1)];
    await negative('arm-asserts', "issue_grant: a grantee label shown as other characters than its bytes, signed over the text shown: refused by the character check", A0, ISSUE,
      issueArgsOf(gG, sU, await K.signedOver(A0, K.issueBytes(mC.pureCircuits, A0, msg.solGranteeArg(gG), sU, shC), shC)), CHARS, [CHARS], ctlIssue);
  }

  // add_device: a passkey target and the unused fields of other classes
  const pass = softwarePasskey();
  const tP = sol.solTargetOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } } as any);
  const addArgs = (t: any, au: any, targ: unknown = msg.solTargetArg(t)) => [targ, msg.solTargetPointArg(t), ...authArgs(au)];
  const ctlP = { a: A0, args: addArgs(tP, await K.authFor(A0, { op: 'add_device', target: tP })) };
  {
    const sh = K.shownFor(A0, { op: 'add_device', target: tP });
    const mC = await copyFor([CHARS]);
    const shC = [{ ...sh[0], origin: chars21(new TextEncoder().encode('https://b.example.com')) }, ...sh.slice(1)];
    await negative('arm-asserts', "add_device: a passkey target's origin shown as another origin's characters, signed over the text shown: refused by the character check", A0, ADD,
      addArgs(tP, await K.signedOver(A0, K.addBytes(mC.pureCircuits, A0, msg.solTargetArg(tP), shC), shC)), CHARS, [CHARS], ctlP);
    // an origin whose last byte is not visible ASCII (its characters equal
    // its bytes; the entry derives from them)
    const origin = new Uint8Array(tP.origin!); origin[20] = 1;
    const tV = { ...tP, origin };
    const mV = await copyFor([ORIGIN_VISIBLE]);
    const shV = [{ ...sh[0], origin: chars21(origin) }, ...sh.slice(1)];
    await negative('arm-asserts', 'add_device: a passkey target whose origin ends in a control byte, signed over the text shown: refused by the origin visibility check', A0, ADD,
      addArgs(tV, await K.signedOver(A0, K.addBytes(mV.pureCircuits, A0, msg.solTargetArg(tV), shV), shV)), ORIGIN_VISIBLE, [ORIGIN_VISIBLE], ctlP);
  }
  {
    // fields a class does not show, non-zero, under a valid signature over the
    // contract's own bytes (the same bytes as with the fields zero)
    const jub = JubjubDevice.generate();
    const tJ = sol.solTargetOf({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y } as any);
    const tE = sol.solTargetOf({ scheme: 'evm_k256', address: rnd(20), blind: rnd() } as any);
    const ctlJ = { a: A0, args: addArgs(tJ, await K.authFor(A0, { op: 'add_device', target: tJ })) };
    const ctlE = { a: A0, args: addArgs(tE, await K.authFor(A0, { op: 'add_device', target: tE })) };
    const D: [string, any, string, typeof ctlJ][] = [
      ['an evm_k256 target with a non-zero second field', { ...tE, b: rnd() }, UNUSED_SECOND, ctlE],
      ['a jubjub target with a non-zero RP hash', { ...tJ, c: rnd() }, UNUSED_RP, ctlJ],
      ['a jubjub target with a non-zero origin (its characters equal its bytes)', { ...tJ, origin: rnd(21) }, UNUSED_ORIGIN, ctlJ],
    ];
    for (const [name, t, expect, ctl] of D) {
      await negative('arm-asserts', `add_device: ${name}, not shown, under a valid signature over the contract's bytes`, A0, ADD,
        addArgs(t, await K.circuitAuth(A0, { op: 'add_device', target: t })), expect, [expect], ctl);
    }
  }
  {
    // grantees: fields a class does not use, non-zero, under a valid
    // signature over the contract's own bytes
    const k1 = K256Device.generate();
    const jub = JubjubDevice.generate();
    const gK = sol.solGranteeOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) } as any, { originHash: rnd() }, 1n);
    const gJ = sol.solGranteeOf({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y } as any, { originHash: rnd() }, 2n);
    const gE = sol.solGranteeOf({ scheme: 'evm_k256', address: rnd(20), blind: rnd() } as any, { label: 'Example dApp' }, 3n);
    const gP = sol.solGranteeOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y } as any, { origin: pass.policy.origin }, 4n);
    const sRO = scopeOf({ read: true, readPk: rnd() });
    const ctlOf = async (g: any, sc: any) => ({ a: A0, args: issueArgsOf(g, sc, await K.authFor(A0, { op: 'issue_grant', grantee: g, ...sc })) });
    const C: [string, any, any, string, any][] = [
      ['an evm_k256 grantee with a non-zero second field', { ...gE, b: rnd() }, sU, UNUSED_SECOND, await ctlOf(gE, sU)],
      ['a k256 grantee carrying a label', { ...gK, label: 'Example dApp' }, sU, UNUSED_LABEL, await ctlOf(gK, sU)],
      ['a jubjub grantee with a non-zero origin (its characters equal its bytes)', { ...gJ, origin: rnd(21) }, sU, UNUSED_ORIGIN, await ctlOf(gJ, sU)],
      ['a sol_ed25519 grantee carrying an origin hash (a readable grantee\'s is derived from its label)', { ...gG, originHash: rnd() }, sU, READABLE_OH, ctlIssue],
      ["a passkey grantee carrying an origin hash (a passkey grantee's is derived from its origin)", { ...gP, originHash: rnd() }, sRO, PASSKEY_OH, await ctlOf(gP, sRO)],
    ];
    for (const [name, g, sc, expect, ctl] of C) {
      await negative('arm-asserts', `issue_grant: ${name}, not shown, under a valid signature over the contract's bytes`, A0, ISSUE,
        issueArgsOf(g, sc, await K.circuitAuth(A0, { op: 'issue_grant', grantee: g, ...sc })), expect, [expect], ctl);
    }
  }

  // the literal removal: its display inputs must be an empty target's; the
  // message is the same bytes whatever they are, so the wallet's signature
  // over the honest message stands
  {
    const k1 = K256Device.generate();
    const tK = sol.solTargetOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) } as any);
    const A1 = (await execute(Original.Contract, A0, ADD, addArgs(tK, await K.authFor(A0, { op: 'add_device', target: tK })))).after;
    const eK = k1.entryAt(A1.addressBytes, ledgerOf(A1).device_epoch as bigint, 0n);
    const oL = { op: 'remove_device', literal: true, entry: eK };
    const au = await K.authFor(A1, oL);
    const remL = (x: any) => [true, msg.solTargetArg({ tag: '' } as any), msg.solUnusedKey(), 0n, 0n, eK, ...authArgs(x)];
    const ctlL = { a: A1, args: remL(au) };
    await positive('arm-asserts', 'remove_device by the literal form with the empty target\'s display inputs: proved (original module)', undefined, A1, REMOVE, ctlL.args,
      (after) => !ledgerOf(after).devices.member(eK));
    const sh = au.showArgs as any[];
    const ts0 = sh[0];
    const forged: [string, any][] = [
      ['use counter digits 7 and epoch digits 9', { ...ts0, counter: spaced('7', 20), epoch: spaced('9', 10) }],
      ['an origin of 21 non-zero bytes', { ...ts0, origin: chars21(fill(21, 0x41)) }],
      ['base58 digits 57 with arbitrary read-back hints', { ...ts0, key: { digits: new Array<bigint>(44).fill(57n), carry: 5n, low: 6n, top: 7n } }],
    ];
    for (const [name, ts] of forged) {
      await negative('arm-asserts', `remove_device by the literal form with display inputs other than the empty target's (${name}; the message is unchanged, the wallet's signature over it stands)`, A1, REMOVE,
        remL(withShow(au, [ts, ...sh.slice(1)])), LITERAL_SHOW, [LITERAL_SHOW], ctlL);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// display-module: the base rendering module's asserts through this arm's exports
// ═════════════════════════════════════════════════════════════════════════════
const UTC_SHAPE = 'display: not a UTC date and time';
const UTC_MONTH = 'display: month out of range';
const UTC_DAY = 'display: day out of range';
const UTC_TIME = 'display: time of day out of range';
const UTC_WORDS = 'display: not the words for a time after 9999-12-31 23:59:59 UTC';
const LABEL_SHAPE = 'display: not a site amount label';
const LABEL_LETTER = 'display: the symbol does not start with a letter';
const LABEL_DECIMALS = 'display: more than 18 decimals';
const LABEL_SYMBOL = 'display: symbol longer than 8';
const LABEL_LEADING = 'display: leading zero in the site amount label';
const LIMB128 = 1n << 128n;

/** The read-back hints of base58 digits (58 at a padding position), as the
 *  base computes them: three groups 0..20, 21..41, 42..43. */
const base58Hints = (digits: bigint[]) => {
  const group = (g: bigint[]) => g.reduce(([v, m], d) => (d === 58n ? [v, m] : [v * 58n + d, m * 58n]), [0n, 1n]);
  const [v1] = group(digits.slice(0, 21));
  const [v2, m2] = group(digits.slice(21, 42));
  const [v3, m3] = group(digits.slice(42, 44));
  const l2 = m2 * v1 + v2;
  const low = l2 % LIMB128;
  return { digits, carry: l2 / LIMB128, low, top: (m3 * low + v3) / LIMB128 };
};
const beBytes32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const beValue = (b: Uint8Array) => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);

async function sectionDisplayModule() {
  const rnd = rng('display-module');
  const SITE = 'Display module prover test';
  const { d: S } = await solDevice(rnd());
  const A0 = await activated(S, rnd());
  const K = deviceKit(S, SITE);

  // the UTC expiry line of issue_grant: each text equal to the expiry in
  // seconds by the date arithmetic, refused only by its own shape or range check
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(rnd()), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const gG = G.grantee(0n);
  const scopeAt = (expiresAt: bigint) => scopeOf({ opWithdrawUnshielded: true, color: fill(32, 0xc1), maxCoinValue: 600n, perCallCap: 600n, cap: 1000n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: fill(32, 0x77), expiresAt });
  const sec = (y: number, mo: number, d: number, h = 0) => BigInt(Date.UTC(y, mo - 1, d, h) / 1000);
  const textOf = (t: string) => [...t].map((c) => BigInt(c.charCodeAt(0)));
  const D: [string, bigint, (t: string) => string, string][] = [
    ['the date separator "-" shown as "/"', 1794840710n, (t) => `${t.slice(0, 4)}/${t.slice(5)}`, UTC_SHAPE],
    ['month 13 (the seconds of 15 December)', sec(2026, 12, 15), (t) => `${t.slice(0, 5)}13${t.slice(7)}`, UTC_MONTH],
    ['day 32 of January (the seconds of 1 February)', sec(2026, 2, 1), (t) => `2026-01-32${t.slice(10)}`, UTC_DAY],
    ['hour 24 of 1 January (the seconds of 2 January)', sec(2026, 1, 2), (t) => `2026-01-01 24${t.slice(13)}`, UTC_TIME],
    ['a time after 9999-12-31 23:59:59 shown with other words', 253402300800n, (t) => `later${t.slice(5)}`, UTC_WORDS],
  ];
  for (const [name, expiresAt, forge, expect] of D) {
    const sc = scopeAt(expiresAt);
    const ctl = { a: A0, args: issueArgsOf(gG, sc, await K.authFor(A0, { op: 'issue_grant', grantee: gG, ...sc })) };
    const sh = K.shownFor(A0, { op: 'issue_grant', grantee: gG, ...sc });
    const honest = String.fromCharCode(...(sh[1].expires_utc as bigint[]).map(Number));
    const forged = forge(honest);
    if (forged.length !== 29 || forged === honest) throw new Error(`setup: the forged UTC text for ${name}`);
    const shF = [sh[0], { ...sh[1], expires_utc: textOf(forged) }, ...sh.slice(2)];
    const m = await copyFor([expect]);
    await negative('display-module', `issue_grant: the UTC expiry line with ${name} ("${forged.trimEnd()}"), signed over that text`, A0, ISSUE,
      issueArgsOf(gG, sc, await K.signedOver(A0, K.issueBytes(m.pureCircuits, A0, msg.solGranteeArg(gG), sc, shF), shF)), expect, [expect], ctl);
  }

  // the year split on its own: a non-canonical split (s[2] - 1, s[3] + 4,
  // the same year) counts one leap day fewer, so the text one day later has
  // the expiry's own seconds; shape, month, day, time and the read-back all
  // hold, and only the split's canonical form refuses it
  {
    const expiresAt = 1794840710n; // 2026-11-16 14:51:50 UTC
    const sc = scopeAt(expiresAt);
    const ctl = { a: A0, args: issueArgsOf(gG, sc, await K.authFor(A0, { op: 'issue_grant', grantee: gG, ...sc })) };
    const sh = K.shownFor(A0, { op: 'issue_grant', grantee: gG, ...sc });
    const honest = String.fromCharCode(...(sh[1].expires_utc as bigint[]).map(Number));
    const split = (sh[1].expires_split as bigint[]).map(BigInt);
    if (honest.slice(0, 19) !== '2026-11-16 14:51:50' || JSON.stringify(split.map(String)) !== JSON.stringify(['5', '0', '6', '1'])) throw new Error('setup: the honest UTC text or year split');
    const forgedText = `2026-11-17${honest.slice(10)}`;
    const forgedSplit = [split[0], split[1], split[2] - 1n, split[3] + 4n];
    const shF = [sh[0], { ...sh[1], expires_utc: textOf(forgedText), expires_split: forgedSplit }, ...sh.slice(2)];
    const m = await copyFor([SPLIT]);
    await negative('display-module', `issue_grant: the year split 5, 0, 5, 5 with the date one day later ("${forgedText.trimEnd()}", the expiry's own seconds), signed over that text: refused only by the split's canonical form`,
      A0, ISSUE, issueArgsOf(gG, sc, await K.signedOver(A0, K.issueBytes(m.pureCircuits, A0, msg.solGranteeArg(gG), sc, shF), shF)), SPLIT, [SPLIT], ctl);
  }

  // the window digits: the line shows the word "no window" whatever they are,
  // so the wallet's signature over the honest message stands
  {
    const sc = scopeAt(0n);
    const au = await K.authFor(A0, { op: 'issue_grant', grantee: gG, ...sc });
    const ctl = { a: A0, args: issueArgsOf(gG, sc, au) };
    const sh = au.showArgs as any[];
    const W: [string, string, string, string][] = [
      ['window', '1', 'the window length 0 with digits 1', DIGITS],
      ['window', '00', 'the window length 0 with digits 00', LEADING],
      ['window', '', 'the window length 0 with no digits', EMPTY_DECIMAL],
      ['window', '0 1', 'the window length 0 with a digit after the padding', ALIGN],
      ['window_cap', '1', 'the window cap 0 with digits 1', DIGITS],
    ];
    for (const [field, t, name, expect] of W) {
      const width = field === 'window' ? 20 : 39;
      const shW = [sh[0], { ...sh[1], [field]: spaced(t, width) }, ...sh.slice(2)];
      await negative('display-module', `issue_grant: ${name} (the line shows the word either way; the wallet's signature over the message stands)`, A0, ISSUE,
        issueArgsOf(gG, sc, withShow(au, shW)), expect, [expect], ctl);
    }
  }

  // base58: a Solana target whose key has exactly one leading zero byte and a
  // 43-character base58 text (one padding digit); each forged digit vector
  // fails one check of the read-back, the text signed as shown
  let tX: any;
  for (let i = 0; i < 20000 && !tX; i++) {
    const seed = rnd();
    const key = sol.solSoftwareSigner(seed).publicKey;
    if (key[0] === 0 && key[1] !== 0 && base58Text32(key).length === 43) tX = sol.solTargetOf({ scheme: 'sol_ed25519', key, blind: rnd() } as any);
  }
  if (!tX) throw new Error('setup: no key with one leading zero byte and a 43-digit base58 text');
  const addArgs = (t: any, au: any) => [msg.solTargetArg(t), msg.solTargetPointArg(t), ...authArgs(au)];
  const ctlX = { a: A0, args: addArgs(tX, await K.authFor(A0, { op: 'add_device', target: tX })) };
  await positive('display-module', 'add_device: a sol_ed25519 target with one leading zero byte (its base58 text starts with one "1"): proved (original module)', undefined, A0, ADD, ctlX.args);
  const shX = K.shownFor(A0, { op: 'add_device', target: tX });
  const honest = shX[0].key as { digits: bigint[]; carry: bigint; low: bigint; top: bigint };
  const d = honest.digits;
  if (d[0] !== 0n || d[43] !== 58n || d[42] === 58n) throw new Error('setup: the honest digits');
  const value = beValue(tX.a);
  const i = (() => { for (let j = 21; j < 40; j++) if (d[j] >= 1n && d[j + 1] >= 1n) return j; throw new Error('setup: no digit pair to re-split'); })();
  const swapLast = [...d.slice(0, 42), 58n, d[42]];
  const resplit = [...d]; resplit[i] = d[i] - 1n; resplit[i + 1] = d[i + 1] + 58n;
  const noLead = [...d.slice(1, 43), 58n, 58n];
  const carry41 = [...d]; carry41[41] = d[41] === 57n ? 56n : d[41] + 1n;
  const highKey = beBytes32(value + LIMB128);
  const lowKey = beBytes32(value + 1n);
  if (highKey[0] !== 0 || lowKey[0] !== 0 || (value & (LIMB128 - 1n)) === LIMB128 - 1n) throw new Error('setup: the shifted values');
  const B: [string, any, string][] = [
    ['the padding digit moved before the last character', { ...honest, digits: swapLast }, B58ALIGN],
    [`two digits re-split as ${d[i] - 1n} and ${d[i + 1] + 58n} (the same value, a digit above 57)`, { ...honest, digits: resplit }, B58ALIGN],
    ['the leading "1" dropped (the same value; hints recomputed)', base58Hints(noLead), B58LEAD],
    ['the 42nd digit changed (the first read-back equation fails)', { ...honest, digits: carry41 }, B58CARRY],
    ["the digits of the value plus 2^128 (the low bytes match, the high bytes do not)", msg.solBase58(highKey), B58HI],
    ['the digits of the value plus 1 (the high bytes match, the low bytes do not)', msg.solBase58(lowKey), B58LO],
  ];
  for (const [name, key, expect] of B) {
    const shF = [{ ...shX[0], key }, ...shX.slice(1)];
    const m = await copyFor([expect]);
    await negative('display-module', `add_device: a sol_ed25519 target's base58 text with ${name}, signed over that text`, A0, ADD,
      addArgs(tX, await K.signedOver(A0, K.addBytes(m.pureCircuits, A0, msg.solTargetArg(tX), shF), shF)), expect, [expect], ctlX);
  }

  // the site's amount label on withdraw_unshielded of 1 base unit
  {
    const COL = fill(32, 0xc1), RCP = fill(32, 0x77);
    const AU = (await execute(Original.Contract, A0, 'deposit_unshielded', [COL, 1000n])).after;
    const o = { op: 'withdraw_unshielded', amount: { color: COL, amount: 1n, decimals: 0, symbol: 'X' }, recipient: RCP };
    const au = await K.authFor(AU, o);
    const ctl = { a: AU, args: [COL, 1n, { bytes: RCP }, ...authArgs(au)] };
    const sh = au.showArgs as any[];
    const L: [string, string, string][] = [
      ['"1 X Y" (a character after the padding)', '1 X Y', LABEL_SHAPE],
      ['"1 9X" (a symbol starting with a digit)', '1 9X', LABEL_LETTER],
      ['"0.0000000000000000001 X" (19 decimals)', '0.0000000000000000001 X', LABEL_DECIMALS],
      ['"1 ABCDEFGHI" (a 9-character symbol)', '1 ABCDEFGHI', LABEL_SYMBOL],
      ['"01 X" (a leading zero)', '01 X', LABEL_LEADING],
      ['"2 X" (another value)', '2 X', CLAIM],
    ];
    for (const [name, t, expect] of L) {
      const shL = [{ ...sh[0], claim: spaced(t, 49) }, ...sh.slice(1)];
      const m = await copyFor([expect]);
      const bytes: Uint8Array = m.pureCircuits.sol_message_withdraw_unshielded(...K.head(AU), COL, 1n, { bytes: RCP }, ...shL);
      await negative('display-module', `withdraw_unshielded of 1: the site's amount label ${name}, signed over that text`, AU, WU,
        [COL, 1n, { bytes: RCP }, ...authArgs(await K.signedOver(AU, bytes, shL))], expect, [expect], ctl);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// formats: the two signing formats at every circuit that verifies a signature
// ═════════════════════════════════════════════════════════════════════════════

/** What a verifier and the chain see of a call, without its proof: the public
 *  transcript as executed and as partitioned, each contract call of the
 *  transaction with its address, entry point and guaranteed and fallible
 *  transcripts (operations, effects, gas), and the contract state after the
 *  call. The communications commitment is a hiding commitment with fresh
 *  randomness per call; it is returned apart and never compared for
 *  equality. A transcript's effects are sets and maps (the claimed
 *  nullifiers, spends, receives and calls as arrays, the mints and the
 *  unshielded inputs and outputs as maps), which the bindings return in no
 *  fixed order, so they are compared sorted. */
function publicParts(x: { call: any; after: LocalAccount; proven?: any }) {
  const canon = (y: unknown): unknown => (typeof y === 'bigint' ? `${y}n` : y instanceof Uint8Array ? hex(y) : y);
  const sorted = (a: unknown[]) => a.map((e) => JSON.stringify(e, (_k, y) => canon(y))).sort();
  const ser = (v: unknown) => JSON.stringify(v, (k, y) => {
    if (y instanceof Map) return sorted([...y.entries()]);
    if (y instanceof Set) return sorted([...y]);
    if (Array.isArray(y) && /^claimed/.test(k)) return sorted(y);
    return canon(y);
  });
  // a proved transaction comes back as { version: 'v9', tx }
  const tx = x.proven ? (x.proven.version === 'v9' ? x.proven.tx : undefined) : x.call.private.unprovenTx;
  if (!tx) throw new Error(`formats: a proved transaction of version ${String(x.proven?.version)}, not v9`);
  const calls = [...(tx.intents?.values() ?? [])].flatMap((i: any) => i.actions).filter((c: any) => c && 'entryPoint' in c);
  return {
    parts: {
      publicTranscript: ser(x.call.public.publicTranscript),
      partitionedTranscript: ser(x.call.public.partitionedTranscript),
      contractCalls: ser(calls.map((c: any) => ({ address: String(c.address), entryPoint: c.entryPoint instanceof Uint8Array ? hex(c.entryPoint) : String(c.entryPoint),
        guaranteed: ser(c.guaranteedTranscript), fallible: ser(c.fallibleTranscript) }))),
      stateAfter: hex(x.after.state.serialize()),
    },
    contractCalls: calls.length,
    commitments: calls.map((c: any) => String(c.communicationCommitment)),
  };
}

async function sectionFormats() {
  const rnd = rng('formats');
  const SITE = 'Formats prover test';
  const { seed, d: S } = await solDevice(rnd());
  // the same key and blind, signing as an off-chain message v1: one device
  const SO = new sol.SolEd25519Device({ publicKey: S.key, blind: S.blind, signer: sol.solSoftwareSigner(seed), format: 'offchain' });
  interface FCase { circuit: string; seam: 'device' | 'grant'; a: LocalAccount; raw: unknown[]; off: unknown[]; rawAsOff: unknown[]; offAsRaw: unknown[]; note: string; shown?: Uint8Array }
  const cases: FCase[] = [];
  const device = async (circuit: string, a: LocalAccount, o: any, argsOf: (au: any) => unknown[], note: string, shown?: Uint8Array) => {
    const counter = counterIn(a, S);
    const auR = await sol.authoriseSolDevice(S, ctxOf(a), SITE, o, counter);
    const auO = await sol.authoriseSolDevice(SO, ctxOf(a), SITE, o, counter);
    if (auR.text !== auO.text || auR.offchain || !auO.offchain) throw new Error(`formats: ${circuit}: the two authorisations differ in more than the format`);
    cases.push({ circuit, seam: 'device', a, raw: argsOf(auR), off: argsOf(auO), rawAsOff: argsOf({ ...auR, offchain: true }), offAsRaw: argsOf({ ...auO, offchain: false }), note, shown });
  };
  const A0 = await activated(S, rnd(), 0x0b1a5en);
  { const k = rnd(); await device(ROTATE, A0, { op: 'rotate_enc_key', newKey: k }, (au) => [k, ...authArgs(au)], 'activated account', k); }
  { const e = rnd(192); await device(APPEND, A0, { op: 'append_inbox', entry: e }, (au) => [e, ...authArgs(au)], 'activated account'); }
  {
    const field = (n: number) => BigInt('0x' + hex(rnd(31))) + BigInt(n);
    const X = sol.solRecoverySession({ recoveryPk: recoveryKey(0x5e55n).pk, sessionNonce: rnd(32), phi: [field(1), field(2)], wrap: rnd(64) });
    await device(PUBLISH, A0, X, (au) => [X.recoveryPk, X.sessionNonce, ...X.phi, X.phiLen, X.wrap, ...authArgs(au)], 'activated account, a two-value backup vector');
  }
  {
    const COL = fill(32, 0xc1), RCPT = fill(32, 0x77);
    const AU = (await execute(Original.Contract, A0, 'deposit_unshielded', [COL, 1000n])).after;
    await device(WU, AU, { op: 'withdraw_unshielded', amount: { color: COL, amount: 400n, decimals: 2, symbol: 'tTOK' }, recipient: RCPT },
      (au) => [COL, 400n, { bytes: RCPT }, ...authArgs(au)], '400 of a 1000 mirror');
  }
  for (const circuit of [WS, WSC]) {
    const COL = fill(32, 0xa1);
    const { account, coins } = withLocalCoins(A0, [{ nonce: fill(32, 0xf0), color: COL, value: 5n }, { nonce: fill(32, 0x11), color: COL, value: 1000n }]);
    const H = { ...account, privateState: coinStoreAnswering([{ key: COL, coin: coins[1] }]) } as LocalAccount;
    const recipient = circuit === WS ? localCoinPublicKeyBytes() : fill(32, 0x3c);
    const o = { op: circuit === WS ? 'withdraw_shielded' : 'withdraw_shielded_to_contract', amount: { color: COL, amount: 300n, decimals: 0, symbol: 'tA' },
      recipient, coin: { nonce: coins[1].nonce, color: coins[1].color, value: coins[1].value, mt_index: coins[1].mtIndex } };
    await device(circuit, H, o, (au) => [{ bytes: recipient }, COL, 300n, ...authArgs(au)], '300 of a 1000 coin at index 1');
  }
  const jub = JubjubDevice.generate();
  const tJ = sol.solTargetOf({ scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y });
  const addArgs = (au: any) => [msg.solTargetArg(tJ), msg.solTargetPointArg(tJ), ...authArgs(au)];
  await device(ADD, A0, { op: 'add_device', target: tJ }, addArgs, 'a jubjub target');
  const A1 = (await execute(Original.Contract, A0, ADD, addArgs(await sol.authoriseSolDevice(S, ctxOf(A0), SITE, { op: 'add_device', target: tJ }, counterIn(A0, S))))).after;
  {
    const ep = ledgerOf(A1).device_epoch as bigint;
    await device(REMOVE, A1, { op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep },
      (au) => [false, msg.solTargetArg(tJ), msg.solTargetPointArg(tJ), 0n, ep, new Uint8Array(32), ...authArgs(au)], 'the jubjub target by descriptor');
  }
  const gSeed = rnd();
  const G = await sol.SolEd25519Grantee.enrol(sol.solSoftwareSigner(gSeed), { network: 'undeployed', issuingAccount: A0.addressBytes }, 'Example dApp');
  const GO = new sol.SolEd25519Grantee(new sol.SolEd25519Device({ publicKey: G.key, blind: G.blind, signer: sol.solSoftwareSigner(gSeed), format: 'offchain' }), G.label);
  const COLS = fill(32, 0xa1), COLU = fill(32, 0xc7), RCPTU = fill(32, 0x7e);
  const scS = scopeOf({ opWithdrawShielded: true, opWithdrawShieldedToContract: true, read: true, readPk: fill(32, 0x77), color: COLS, maxCoinValue: 1000n, perCallCap: 600n, cap: 1200n });
  const scU = scopeOf({ opWithdrawUnshielded: true, color: COLU, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPTU, maxCoinValue: 300n, perCallCap: 300n, cap: 450n });
  const g0 = G.grantee(0n), g1 = G.grantee(1n);
  await device(ISSUE, A0, { op: 'issue_grant', grantee: g0, ...scS }, (au) => issueArgsOf(g0, scS, au), 'a sol grantee, shielded scope');
  const salt0 = saltAt(A0, S);
  const AG0 = (await execute(Original.Contract, A0, ISSUE, issueArgsOf(g0, scS, await sol.authoriseSolDevice(S, ctxOf(A0), SITE, { op: 'issue_grant', grantee: g0, ...scS }, counterIn(A0, S))))).after;
  const salt1 = saltAt(AG0, S);
  const AG = (await execute(Original.Contract, AG0, ISSUE, issueArgsOf(g1, scU, await sol.authoriseSolDevice(S, ctxOf(AG0), SITE, { op: 'issue_grant', grantee: g1, ...scU }, counterIn(AG0, S))))).after;
  await device(REVOKE, AG, { op: 'revoke_grant', grantee: g0 }, (au) => [msg.solGranteeArg(g0), msg.solTargetPointArg(g0), ...authArgs(au)], 'the slot-0 grant');
  await device(REVOKE_ALL, AG, { op: 'revoke_all_grants' }, (au) => authArgs(au), 'two live grants');
  {
    const l = ledgerOf(A0);
    const Q = JubjubDevice.generate();
    const succPk = recoveryKey(0x9e11n).pk;
    const nowUpper = BigInt(Math.floor(Date.now() / 1000)) + 2n;
    const sub = signRecoverSubmit(recoveryKey(0x0b1a5en), Q,
      recoverSubmitChallenge({ contractAddress: A0.addressBytes, authNonce: l.auth_nonce }, l.recovery_pk, Q.pk, succPk, l.device_epoch + 1n, nowUpper),
      { successorRecoveryPk: succPk, expectedEpoch: l.device_epoch, expectedNonce: l.auth_nonce, nowUpper });
    const AP = (await execute(Original.Contract, A0, 'recover_submit', recoverSubmitArgs(sub))).after;
    if (!ledgerOf(AP).pending_recovery) throw new Error('formats: setup: no pending recovery');
    await device(CANCEL, AP, { op: 'recover_cancel' }, (au) => authArgs(au), 'a recovery pending');
  }
  const grant = async (circuit: string, a: LocalAccount, slot: bigint, o: any, scope: any, salt: Uint8Array, argsOf: (op: any, au: any) => unknown[], note: string) => {
    const r = ledgerOf(a).grants.lookup(G.grantId(a.addressBytes, slot));
    const ctx = { contractAddress: a.addressBytes, label: G.label, slot, issuedAt: r.issued_at as bigint, grantNonce: r.nonce as bigint };
    const gR = await sol.authoriseSolGrantee(G.device, ctx, SITE, o);
    const gO = await sol.authoriseSolGrantee(GO.device, ctx, SITE, o);
    if (gR.text !== gO.text || gR.offchain || !gO.offchain) throw new Error(`formats: ${circuit}: the two grantee authorisations differ in more than the format`);
    const op = { originHash: grantOriginHash(msg.labelBytes(G.label)), slot, scopeSalt: salt, recipientKind: scope.recipientKind, pinnedRecipient: scope.recipient, maxCoinValue: scope.maxCoinValue, spentPrev: 0n };
    cases.push({ circuit, seam: 'grant', a, raw: argsOf(op, gR), off: argsOf(op, gO), rawAsOff: argsOf(op, { ...gR, offchain: true }), offAsRaw: argsOf(op, { ...gO, offchain: false }), note });
  };
  {
    const AU = (await execute(Original.Contract, AG, 'deposit_unshielded', [COLU, 1000n])).after;
    await grant(GWU, AU, 1n, { op: 'withdraw_unshielded_with_grant', amount: { color: COLU, amount: 200n, decimals: 0, symbol: 'tG' }, recipient: RCPTU },
      scU, salt1, (op, au) => [COLU, 200n, { bytes: RCPTU }, ...grantAuthArgs(op, au)], 'slot 1, 200 to the pinned user address');
    const { account, coins } = withLocalCoins(AG, [{ nonce: fill(32, 0xf0), color: COLS, value: 5n }, { nonce: fill(32, 0x11), color: COLS, value: 1000n }]);
    const AS = { ...account, privateState: coinStoreAnswering([{ key: COLS, coin: coins[1] }]) } as LocalAccount;
    const enc = ledgerOf(AS).enc_key, chg = fill(192, 0x2c);
    for (const [circuit, recipient, opName] of [[GWS, localCoinPublicKeyBytes(), 'withdraw_shielded_with_grant'],
      [GWSC, fill(32, 0x3c), 'withdraw_shielded_to_contract_with_grant']] as [string, Uint8Array, string][]) {
      const o = { op: opName, amount: { color: COLS, amount: 300n, decimals: 0, symbol: 'tA' }, recipient, changeEntry: chg, encPk: enc,
        coin: { nonce: coins[1].nonce, color: COLS, value: 1000n, mt_index: coins[1].mtIndex } };
      await grant(circuit, AS, 0n, o, scS, salt0, (op, au) => [{ bytes: recipient }, COLS, 300n, chg, enc, ...grantAuthArgs(op, au)], 'slot 0, 300 of a 1000 coin at index 1');
    }
  }
  const VERIFYING = [ROTATE, APPEND, WU, WS, WSC, ADD, REMOVE, ISSUE, REVOKE, REVOKE_ALL, PUBLISH, CANCEL, GWU, GWS, GWSC];
  if (JSON.stringify(cases.map((c) => c.circuit).sort()) !== JSON.stringify([...VERIFYING].sort())) throw new Error('formats: the cases do not cover the verifying circuits');

  // SOL_ED25519_FORMATS_CIRCUITS=<circuit,...> runs the cases of the named
  // circuits only (every case is still built), so that one proof server
  // need not hold the keys of all fifteen circuits at once
  const only = process.env.SOL_ED25519_FORMATS_CIRCUITS?.split(',').filter(Boolean);
  if (only) for (const c of only) if (!VERIFYING.includes(c)) throw new Error(`formats: ${c} is not a circuit that verifies a signature`);
  for (const c of cases.filter((x) => !only || only.includes(x.circuit))) {
    const short = c.circuit.replace('_sol_ed25519', '').replace('_with', '');
    const expect = c.seam === 'device' ? INVALID : GINVALID;
    const copy = await copyFor([expect]);
    const got: Record<'raw' | 'off', { call: any; after: LocalAccount; proven?: any } | undefined> = { raw: undefined, off: undefined };
    await positive('formats', `${short}: raw approval (${c.note}), proved through the copy`, copy, c.a, c.circuit, c.raw, undefined, undefined, (x) => { got.raw = x; });
    await positive('formats', `${short}: the same approval as an off-chain message v1 (same key, blind, counters and operands, same state), proved through the copy`,
      copy, c.a, c.circuit, c.off, undefined, undefined, (x) => { got.off = x; });
    {
      const r: Result = { section: 'formats', circuit: c.circuit, case: `${short}: the two formats' public parts are equal (proof bytes and the communications commitment excluded)`, kind: 'state' };
      if (!got.raw || !got.off) r.positive = { verdict: 'FAIL', reason: 'a positive did not complete, nothing to compare' };
      else {
        const pr = publicParts(got.raw), po = publicParts(got.off);
        const differing = Object.keys(pr.parts).filter((k) => (pr.parts as any)[k] !== (po.parts as any)[k]);
        const where = Object.fromEntries(differing.map((k) => { const a = (pr.parts as any)[k] as string, b = (po.parts as any)[k] as string; let i = 0; while (a[i] === b[i]) i++;
          return [k, { at: i, raw: a.slice(Math.max(0, i - 120), i + 80), offchain: b.slice(Math.max(0, i - 120), i + 80) }]; }));
        // the comparison reads values: the rotated key is in both transcripts
        const reads = !c.shown || [pr.parts.publicTranscript, pr.parts.contractCalls].every((t) => t.includes(hex(c.shown!)));
        const okc = differing.length === 0 && pr.contractCalls === 1 && reads;
        r.positive = { verdict: okc ? 'PASS' : 'FAIL', reason: okc ? `equal: ${Object.keys(pr.parts).join(', ')}${DRY ? ' (executed, not proved: DRY)' : ' (from the proved transactions)'}` : `differ: ${differing.join(', ')}${reads ? '' : '; the serialised transcript lacks a public value'}`,
          detail: JSON.stringify({ sha256: Object.fromEntries(Object.entries(pr.parts).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')])),
            commitmentsDiffer: pr.commitments.join() !== po.commitments.join(), contractCalls: pr.contractCalls, ...(differing.length ? { where } : {}) }) };
      }
      tally(r.positive); results.push(r); line(r);
    }
    await negative('formats', `${short}: the raw signature presented as an off-chain message (same key, validly enrolled device)`, c.a, c.circuit, c.rawAsOff, expect, [expect], { a: c.a, args: c.raw });
    await negative('formats', `${short}: the off-chain signature presented as raw (same key, validly enrolled device)`, c.a, c.circuit, c.offAsRaw, expect, [expect], { a: c.a, args: c.off });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Run
// ═════════════════════════════════════════════════════════════════════════════
const startedAt = new Date().toISOString();
let fatal: string | undefined;
try {
  console.log(`sol_ed25519 prover suite: ${SECTIONS.join(', ')}${DRY ? ' (DRY: the JavaScript layer only)' : ''}; proof server ${CONFIG.proofServer}`);
  if (SECTIONS.includes('activation')) await sectionActivation();
  if (SECTIONS.includes('seam')) await sectionSeam();
  if (['replay', 'frame', 'custody', 'witness'].some((s) => SECTIONS.includes(s))) await sectionCustody();
  if (SECTIONS.includes('devices')) await sectionDevices();
  if (SECTIONS.includes('grants')) await sectionGrants();
  if (SECTIONS.includes('grantee-scope')) await sectionGranteeScope();
  if (SECTIONS.includes('frame-lifecycle')) await sectionFrameLifecycle();
  if (SECTIONS.includes('recovery') || SECTIONS.includes('field-rendering')) await sectionRecovery(SECTIONS.includes('recovery'), SECTIONS.includes('field-rendering'));
  if (SECTIONS.includes('readability')) await sectionReadability();
  if (SECTIONS.includes('rules')) await sectionRules();
  if (SECTIONS.includes('module')) await sectionModule();
  if (SECTIONS.includes('hints')) await sectionHints();
  if (SECTIONS.includes('arm-asserts')) await sectionArmAsserts();
  if (SECTIONS.includes('formats')) await sectionFormats();
  if (SECTIONS.includes('display-module')) await sectionDisplayModule();
} catch (e: any) {
  fatal = String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 14).join('\n');
  errors++;
  console.error('ERROR', e);
}
// the counts by refusing layer
const totals: Record<string, number> = {};
const add = (k: string) => { totals[k] = (totals[k] ?? 0) + 1; };
for (const r of results) {
  if (r.kind === 'positive') add(DRY ? 'positive: executed (DRY)' : 'positive: proved');
  else if (r.kind === 'text') add('message text check');
  else if (r.kind === 'state') add('state check (simulator)');
  else if (r.kind === 'not applicable') add('not applicable (reason recorded)');
  else if (r.proverLevel) add('negative: refused by the generated JavaScript only (prover level unreachable, reason recorded)');
  else if (DRY) add('negative: refused by the generated JavaScript (prover not run: DRY)');
  else add(`negative: refused at the proof server, ${r.refusal?.kind}${r.enforcement ? ` (${r.enforcement})` : ''}${r.prover?.verdict !== 'PASS' ? ` [verdict ${r.prover?.verdict}]` : ''}`);
  if (r.prover?.positiveControl) add("positive control proved through a negative's copy");
}
const verdict = errors ? 'ERROR' : failures ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  const file = path.join(process.env.EVIDENCE_DIR, `sol-ed25519-prover${SECTIONS === ALL ? '' : `-${SECTIONS.join('-')}`}${DRY ? '-dry' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(J({ suite: 'sol-ed25519-prover', sections: SECTIONS, dry: DRY, proofServer: CONFIG.proofServer, startedAt, finishedAt: new Date().toISOString(),
    verdict, failures, errors, fatal, totalsByLayer: totals, requests: proofLog.length, zswapRequests: zswapLog.length, transportRetries, cases: results }), null, 2) + '\n');
  console.log(`evidence → ${file}`);
}
console.log(JSON.stringify(totals, null, 1));
console.log(`\n◆ sol-ed25519-prover [${SECTIONS.join(', ')}]: ${verdict} (${results.length} cases, ${failures} failed, ${errors} errors, ${proofLog.length} proof-server requests)${DRY ? ' — DRY' : ''}`);
process.exit(verdict === 'PASS' ? 0 : 1);
