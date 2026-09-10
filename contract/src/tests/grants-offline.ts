// Off-node execution of the scoped-grants seam (`spec_version = 2`) through
// the compact-runtime local simulator: no node, no docker, no proof, no
// zswap. Block time is the simulator's `time` parameter, which is what
// makes the `expires_at` items expressible here at all.
//
// This is the suite the stage-one harness became (GRANTS-E1.md section 10,
// "move local-exec.ts into a suite"). Every check of that harness survives,
// with the same abort-message needles, and every one of them now runs on
// both authorisation arms:
//
//   - the lifecycle (issue rules, issue, re-issue refusal, revoke,
//     tombstone, re-issue over a tombstone, revoke_all reset and
//     generation) once behind a k256 device and once behind a jubjub
//     device;
//   - the unshielded grant twin and its rejection matrix once for a k256
//     grantee and once for a jubjub grantee.
//
// Three things the harness could not reach are added: the arm-specific
// weak-key and cross-arm negatives, and a shape assertion for the four
// twins that cannot execute off-node.
//
// Two carried-forward expectations changed, both recorded where they are
// asserted:
//
//   - the k256 wrong-envelope item. Stage one expected "unknown grant" (the
//     envelope enters `grant_id`, so a mismatched envelope names a record
//     that does not exist); review finding F1 then moved the
//     `envelope == 0` assert to the head of
//     `authenticate_grant_with_k256`, so the seam now refuses the call
//     before it derives an identity at all (GRANTS-E1.md section 8
//     item 15). The item moved to the arm-specific negatives, needle
//     "envelope not admitted for a spend grant".
//   - the stale-nonce item on the jubjub arm, which has two refusal paths
//     rather than one: see `badSignatureNeedles`.
//
// Everything is driven through the wallet surface of `src/wallet/signer.ts`
// (the grantee signers, the grant challenge builders, `scopeArgs`,
// `grantAuthArgs`) rather than hand-rolled argument arrays, so a change to
// the argument order of a circuit breaks this suite in the same place it
// breaks the wallet. The exceptions are the weak-key negatives, whose whole
// point is a public key no signer will construct.

import { randomBytes } from 'node:crypto';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import type { JubjubPoint, Ledger, QualifiedCoin, Secp256k1Point } from '../wallet/contract.js';
import { hexToBytes } from '../wallet/hex.js';
import {
  assertIssueRules,
  authArgs,
  grantAuthArgs,
  jubjubChallenges,
  jubjubGrantChallenges,
  JubjubDevice,
  JubjubGrantee,
  k256Challenges,
  k256GrantChallenges,
  K256Device,
  K256Grantee,
  K256_ENVELOPE_CONNECTOR,
  K256_ENVELOPE_NONE,
  openingOf,
  originHash,
  readOnlyScope,
  RECIPIENT_USER_ADDRESS,
  RECIPIENT_ZSWAP_COIN_PUBLIC_KEY,
  scopeArgs,
  scopeDigest,
  spendScope,
  type AnyDevice,
  type AnyGrantee,
  type Arm,
  type Authorisation,
  type CallContext,
  type ChallengeBuilder,
  type GrantAuthorisation,
  type GrantContext,
  type GrantOpening,
  type PlainScope,
} from '../wallet/signer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

const rnd = (n: number): Uint8Array => new Uint8Array(randomBytes(n));
const ZERO32 = new Uint8Array(32);
const eq = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

let pass = 0;
let fail = 0;

function ok(condition: boolean, label: string): void {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

/**
 * Assert that a call aborts, optionally with a given message needle. A list
 * of needles means any one of them satisfies the check: the jubjub arm has
 * two refusal paths for a signature presented over the wrong challenge, and
 * which one fires is decided by the challenge bytes (see the note on the
 * stale-nonce item).
 */
async function expectAbort(
  label: string,
  f: () => Promise<unknown>,
  needle?: string | string[],
): Promise<void> {
  const needles = needle === undefined ? [] : Array.isArray(needle) ? needle : [needle];
  try {
    await f();
    ok(false, `${label} (did not abort)`);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    const hit = needles.length === 0 || needles.some((n) => message.includes(n));
    const wanted = needles.map((n) => `"${n}"`).join(' or ');
    ok(
      hit,
      `${label} aborts${needles.length === 0 ? `: ${message.slice(0, 80)}` : ` with ${wanted}`}` +
        `${hit ? '' : `: got ${message.slice(0, 120)}`}`,
    );
  }
}

/**
 * The refusals a grant twin may give when a signature is presented over a
 * challenge other than the one it was made for.
 *
 * On the k256 arm the challenge is a message, so the ECDSA verify fails and
 * the seam says so. On the jubjub arm the challenge is cast to `Field`
 * before the Schnorr equation is evaluated (`settle_grant_with_jubjub`), and
 * a challenge the signer did not grind below the JubJub subgroup order is
 * only about 45 per cent likely to be a canonical field element at all, so
 * about half of these calls are refused by the cast's range check rather
 * than by the assert. Both are refusals of the same replay; which one fires
 * is a property of the challenge bytes, not of the seam, so the item admits
 * either.
 */
const badSignatureNeedles = (arm: Arm): string[] =>
  arm === 'jubjub' ? ['invalid grant signature', 'range error'] : ['invalid grant signature'];

/** Assert that a client-side helper refuses a scope before a device signs. */
function expectRefusal(label: string, f: () => unknown, needle: string): void {
  try {
    f();
    ok(false, `${label} (accepted)`);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    ok(message.includes(needle), `${label} refused client-side with "${needle}"`);
  }
}

interface Mark {
  label: string;
  pass: number;
  fail: number;
}

const tally: Array<{ label: string; passed: number; failed: number }> = [];

function section(label: string): Mark {
  console.log(`\n── ${label}`);
  return { label, pass, fail };
}

function endSection(m: Mark): void {
  tally.push({ label: m.label, passed: pass - m.pass, failed: fail - m.fail });
}

// ─────────────────────────────────────────────────────────────────────────────
// The simulated account
// ─────────────────────────────────────────────────────────────────────────────

type PrivateState = Record<string, never>;

/** The circuits this suite executes never consume a coin, so `held_coin`
 *  is a stub. The twins that would consume its result cannot run off-node
 *  at all: see the module-shape section. */
function stubWitnesses() {
  return {
    held_coin: (ctx: { privateState: PrivateState }, _color: Uint8Array): [PrivateState, QualifiedCoin] => [
      ctx.privateState,
      { nonce: ZERO32, color: ZERO32, value: 0n, mt_index: 0n },
    ],
  };
}

interface Snapshot {
  state: unknown;
  useCounter: bigint;
}

interface Account {
  /** The account's contract address, raw bytes. */
  address: Uint8Array;
  owner: AnyDevice;
  /** The live ledger view. */
  L(): Ledger;
  /** Invoke an impure circuit at the current simulated block time. */
  call(name: string, ...args: unknown[]): Promise<any>;
  /** Device-signed `issue_grant_with_<arm>` over the current auth_nonce. */
  issue(scope: PlainScope, grantId: Uint8Array, scopeSalt: Uint8Array): Promise<void>;
  revoke(grantId: Uint8Array): Promise<void>;
  revokeAll(): Promise<void>;
  /** Sign a device-arm challenge as the owner, without calling. */
  deviceAuth(jubjub: () => ChallengeBuilder, k256: () => Uint8Array): Authorisation;
  callContext(): CallContext;
  snapshot(): Snapshot;
  restore(s: Snapshot): void;
  setTime(t: number): void;
  time(): number;
}

/** Deploy an account into the simulator and activate its initial device. */
async function openAccount(deviceArm: Arm): Promise<Account> {
  const contract = new Contract<PrivateState>(stubWitnesses());
  const impure = contract.impureCircuits as unknown as Record<string, (...a: any[]) => Promise<any>>;
  const coinPk = { bytes: rnd(32) };
  const addressHex: string = sampleContractAddress();
  const address = hexToBytes(addressHex);

  const owner: AnyDevice = deviceArm === 'jubjub' ? JubjubDevice.generate() : K256Device.generate();
  const salt = rnd(32);
  const init = await contract.initialState(
    createConstructorContext<PrivateState>({} as PrivateState, coinPk),
    owner.bootCommitment(salt),
    rnd(32),
  );

  let state: any = init.currentContractState;
  let useCounter = 0n;
  let time = 1_800_000_000; // simulated block time, whole seconds

  const L = (): Ledger => ledger(state);

  async function call(name: string, ...args: unknown[]): Promise<any> {
    const ctx = createCircuitContext<PrivateState>(
      name,
      addressHex,
      coinPk,
      state,
      {} as PrivateState,
      undefined,
      undefined,
      undefined,
      time,
    );
    const res = await impure[name](ctx, ...args);
    state = res.context.callContext.currentQueryContext.state;
    return res.result;
  }

  const callContext = (): CallContext => ({ contractAddress: address, authNonce: L().auth_nonce });

  // The owner's arm decides which challenge is built; both are thunks so
  // the wrong arm's builder is never evaluated with the wrong key type.
  const deviceAuth = (jubjub: () => ChallengeBuilder, k256: () => Uint8Array): Authorisation =>
    owner.arm === 'jubjub'
      ? (owner as JubjubDevice).sign(jubjub(), useCounter)
      : (owner as K256Device).sign(k256(), useCounter);

  await call(
    `activate_initial_device_with_${owner.arm}`,
    ...(owner.arm === 'jubjub'
      ? [(owner as JubjubDevice).pk, salt]
      : [(owner as K256Device).pk, salt, (owner as K256Device).envelope]),
  );

  async function issue(scope: PlainScope, grantId: Uint8Array, scopeSalt: Uint8Array): Promise<void> {
    const digest = scopeDigest(scopeSalt, scope);
    const ctx = callContext();
    const a = deviceAuth(
      () => jubjubChallenges.issueGrant(ctx, owner.pk as JubjubPoint, grantId, digest),
      () => k256Challenges.issueGrant(ctx, owner.pk as Secp256k1Point, grantId, digest),
    );
    await call(`issue_grant_with_${owner.arm}`, grantId, ...scopeArgs(scope), scopeSalt, ...authArgs(a));
    useCounter += 1n;
  }

  async function revoke(grantId: Uint8Array): Promise<void> {
    const ctx = callContext();
    const a = deviceAuth(
      () => jubjubChallenges.revokeGrant(ctx, owner.pk as JubjubPoint, grantId),
      () => k256Challenges.revokeGrant(ctx, owner.pk as Secp256k1Point, grantId),
    );
    await call(`revoke_grant_with_${owner.arm}`, grantId, ...authArgs(a));
    useCounter += 1n;
  }

  async function revokeAll(): Promise<void> {
    const ctx = callContext();
    const a = deviceAuth(
      () => jubjubChallenges.revokeAllGrants(ctx, owner.pk as JubjubPoint),
      () => k256Challenges.revokeAllGrants(ctx, owner.pk as Secp256k1Point),
    );
    await call(`revoke_all_grants_with_${owner.arm}`, ...authArgs(a));
    useCounter += 1n;
  }

  return {
    address,
    owner,
    L,
    call,
    issue,
    revoke,
    revokeAll,
    deviceAuth,
    callContext,
    snapshot: () => ({ state, useCounter }),
    restore: (s: Snapshot) => {
      state = s.state;
      useCounter = s.useCounter;
    },
    setTime: (t: number) => {
      time = t;
    },
    time: () => time,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The unshielded grant twin
// ─────────────────────────────────────────────────────────────────────────────

interface SpendOptions {
  /** The signing grantee. Omitted only when `auth` is supplied by hand. */
  grantee?: AnyGrantee;
  /** The record the challenge names. */
  grantId: Uint8Array;
  color: Uint8Array;
  amount: bigint;
  recipient: Uint8Array;
  /** The opening presented to the seam; `spentPrev` is caller-advanced. */
  opening: GrantOpening;
  /** Override the record nonce the challenge binds (the stale-nonce item). */
  nonce?: bigint;
  /** k256 only: the envelope presented in the trailer, signature aside. */
  envelope?: bigint;
  /** jubjub only: the grind nonce presented in the trailer, signature aside. */
  grindNonce?: bigint;
  /** A prebuilt authorisation, for keys no signer will construct. */
  auth?: GrantAuthorisation;
}

/** Call `withdraw_unshielded_with_grant_<arm>` for the grantee's arm. */
async function grantSpend(acc: Account, o: SpendOptions): Promise<unknown> {
  const l = acc.L() as any;
  const live = l.grants.member(o.grantId) ? l.grants.lookup(o.grantId) : { issued_at: 0n, nonce: 0n };
  const g: GrantContext = {
    contractAddress: acc.address,
    grantId: o.grantId,
    issuedAt: live.issued_at,
    grantNonce: o.nonce ?? live.nonce,
  };

  let a: GrantAuthorisation;
  if (o.auth) {
    a = o.auth;
  } else if (o.grantee.arm === 'k256') {
    a = o.grantee.sign(
      k256GrantChallenges.withdrawUnshielded(g, o.grantee.pk, o.color, o.amount, o.recipient),
    );
  } else {
    a = o.grantee.sign(
      jubjubGrantChallenges.withdrawUnshielded(g, o.grantee.pk, o.color, o.amount, o.recipient),
    );
  }

  if (o.envelope !== undefined && a.arm === 'k256') a = { ...a, envelope: o.envelope as 0n | 1n };
  if (o.grindNonce !== undefined && a.arm === 'jubjub') a = { ...a, grind_nonce: o.grindNonce };

  return acc.call(
    `withdraw_unshielded_with_grant_${a.arm}`,
    o.color,
    o.amount,
    { bytes: o.recipient },
    ...grantAuthArgs(o.opening, a),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle and unshielded twin, once per arm pairing
// ─────────────────────────────────────────────────────────────────────────────

async function scenario(deviceArm: Arm, granteeArm: Arm): Promise<void> {
  const tag = `[dev ${deviceArm}/grantee ${granteeArm}]`;
  const acc = await openAccount(deviceArm);
  const L = () => acc.L() as any;

  ok(L().spec_version === 2n, `${tag} spec_version is 2`);
  ok(L().grant_generation === 0n && L().grants.isEmpty(), `${tag} grant state starts empty at generation 0`);

  const grantee: AnyGrantee = granteeArm === 'jubjub' ? JubjubGrantee.generate() : K256Grantee.generate();
  const origin = originHash('https://bank.example');
  const slot = 0n;
  const scopeSalt = rnd(32);
  const color = rnd(32);
  const recipient = rnd(32);

  // The stage-one fixture: unshielded spend, per-call 300, cap 450, coin
  // bound 300, pinned to one UserAddress.
  const scope = spendScope({
    withdrawUnshielded: true,
    color,
    cap: 450n,
    perCallCap: 300n,
    maxCoinValue: 300n,
    recipientKind: RECIPIENT_USER_ADDRESS,
    recipient,
  });
  const gid = grantee.grantId(acc.address, origin, slot);

  // ── Issue rules (section 5.1): each rejected before any write ────────────
  // Built as PlainScope literals, not through `spendScope`, because the
  // circuit is what is under test here; `assertIssueRules` refuses the same
  // scopes client-side and is checked separately at the end of the run.
  await expectAbort(
    `${tag} empty scope`,
    () =>
      acc.issue(
        { ...scope, opWithdrawUnshielded: false, cap: 0n, perCallCap: 0n, recipientKind: 0n, color: ZERO32, recipient: ZERO32 },
        gid,
        scopeSalt,
      ),
    'empty scope',
  );
  await expectAbort(
    `${tag} shielded without read`,
    () => acc.issue({ ...scope, opWithdrawShielded: true, maxCoinValue: 300n }, gid, scopeSalt),
    'shielded spend requires read',
  );
  await expectAbort(
    `${tag} per_call_cap > cap`,
    () => acc.issue({ ...scope, perCallCap: 501n }, gid, scopeSalt),
    'per-call cap above cap',
  );
  await expectAbort(
    `${tag} spend with max_coin_value < per_call_cap`,
    () =>
      acc.issue({ ...scope, opWithdrawShielded: true, read: true, readPkHash: rnd(32), maxCoinValue: 1n }, gid, scopeSalt),
    'coin bound below per-call cap',
  );
  await expectAbort(
    `${tag} read without delegate key`,
    () => acc.issue({ ...scope, read: true }, gid, scopeSalt),
    'read without delegate key',
  );
  await expectAbort(
    `${tag} window bounds reserved`,
    () => acc.issue({ ...scope, windowLen: 1n }, gid, scopeSalt),
    'window bounds reserved',
  );
  await expectAbort(
    `${tag} read-only grant with object fields`,
    () =>
      acc.issue(
        { ...scope, opWithdrawUnshielded: false, read: true, readPkHash: rnd(32), cap: 0n, perCallCap: 0n },
        gid,
        scopeSalt,
      ),
    'read-only grant carries object fields',
  );
  ok(
    L().grants.isEmpty() && L().auth_nonce === 0n,
    `${tag} no record written by a refused issue (local abort leaves state untouched)`,
  );

  // ── Issue over an absent id ──────────────────────────────────────────────
  await acc.issue(scope, gid, scopeSalt);
  const g0 = L().grants.lookup(gid);
  ok(L().grants.member(gid), `${tag} issue over an absent id writes the record`);
  ok(
    g0.epoch === 0n && g0.gen === 0n && g0.active === true && g0.nonce === 0n,
    `${tag} record epoch/gen/active/nonce as specified`,
  );
  ok(
    g0.issued_at === L().auth_nonce && g0.issued_at === 1n,
    `${tag} issued_at is auth_nonce as advanced by the device seam`,
  );
  ok(eq(g0.spent_commit, pureCircuits.derive_grant_spent_commit(scopeSalt, 0n)), `${tag} spent_commit commits to 0`);
  ok(
    eq(
      g0.scope.object_commit,
      pureCircuits.derive_grant_object_commit(scopeSalt, color, RECIPIENT_USER_ADDRESS, recipient, 300n),
    ),
    `${tag} object_commit as derived`,
  );
  ok(eq(g0.scope.rp_commit, pureCircuits.derive_grant_rp_commit(scopeSalt, ZERO32)), `${tag} rp_commit as derived`);
  ok(
    g0.scope.per_call_cap === 300n && g0.scope.cap === 450n && g0.scope.expires_at === 0n,
    `${tag} clear scope fields written`,
  );

  await expectAbort(`${tag} re-issue over a live id`, () => acc.issue(scope, gid, scopeSalt), 'grant already active');
  await expectAbort(`${tag} revoke of an absent id`, () => acc.revoke(rnd(32)), 'unknown grant');

  // A read-only grant under another slot: every object field zero (rule 7).
  const roScope = readOnlyScope({ readPkHash: rnd(32) });
  const gidRo = grantee.grantId(acc.address, origin, 1n);
  await acc.issue(roScope, gidRo, rnd(32));
  ok(
    L().grants.member(gidRo) && L().grants.lookup(gidRo).scope.read === true,
    `${tag} read-only grant under slot 1 issued`,
  );

  // ── The unshielded grant twin ────────────────────────────────────────────
  await acc.call('deposit_unshielded', color, 1_000n);
  ok(L().unshielded_balances.lookup(color) === 1_000n, `${tag} mirror funded off-node (receiveUnshielded simulated)`);

  const opening = openingOf(scope, scopeSalt, origin, slot);
  const spend = (amount: bigint, extra: Partial<SpendOptions> = {}) =>
    grantSpend(acc, {
      grantee,
      grantId: gid,
      color,
      amount,
      recipient,
      opening,
      ...extra,
    });

  const authBefore = L().auth_nonce;
  const roundBefore = L().round;
  const devicesBefore = L().device_count;

  await spend(200n);
  opening.spentPrev = 200n;
  const g1 = L().grants.lookup(gid);
  ok(g1.nonce === 1n, `${tag} grant call advances the record nonce`);
  ok(
    eq(g1.spent_commit, pureCircuits.derive_grant_spent_commit(scopeSalt, 200n)),
    `${tag} spent_commit re-commits to the cumulative spend`,
  );
  ok(L().auth_nonce === authBefore, `${tag} auth_nonce unchanged by a grant call (GR-5)`);
  ok(L().round === roundBefore + 1n, `${tag} round advanced exactly once (GR-13)`);
  ok(L().device_count === devicesBefore, `${tag} device_count untouched (GR-12)`);
  ok(L().unshielded_balances.lookup(color) === 800n, `${tag} mirror debited by the custody chip`);

  // ── Rejection matrix; each item leaves state unchanged ───────────────────
  const snapshot = acc.snapshot();

  await expectAbort(
    `${tag} identical resubmission (stale nonce)`,
    () => spend(200n, { nonce: 0n }),
    badSignatureNeedles(granteeArm),
  );
  await expectAbort(`${tag} over per_call_cap`, () => spend(301n), 'amount above per-call cap');
  await expectAbort(
    `${tag} over cumulative cap (200 + 300 > 450)`,
    () => spend(300n),
    'cumulative cap exceeded',
  );
  await expectAbort(
    `${tag} wrong spent_prev opening`,
    () => spend(100n, { opening: { ...opening, spentPrev: 0n } }),
    'spent opening mismatch',
  );
  await expectAbort(`${tag} wrong recipient under pin`, () => spend(100n, { recipient: rnd(32) }), 'recipient not admitted by pin');
  await expectAbort(
    `${tag} recipient-kind mismatch (opening 2 against committed 1)`,
    () => spend(100n, { opening: { ...opening, recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY } }),
    'scope object mismatch',
  );
  await expectAbort(
    `${tag} wrong scope_salt`,
    () => spend(100n, { opening: { ...opening, scopeSalt: rnd(32) } }),
    'scope object mismatch',
  );
  await expectAbort(
    `${tag} foreign key (no record)`,
    () =>
      spend(100n, {
        grantee: granteeArm === 'jubjub' ? JubjubGrantee.generate() : K256Grantee.generate(),
      }),
    'unknown grant',
  );
  await expectAbort(
    `${tag} out-of-scope operation`,
    async () => {
      // A second grant carrying only the shielded flag, exercised through
      // the unshielded twin.
      const shieldedOnly = spendScope({
        withdrawShielded: true,
        color,
        cap: 450n,
        perCallCap: 300n,
        maxCoinValue: 300n,
        recipientKind: RECIPIENT_USER_ADDRESS,
        recipient,
        readPkHash: rnd(32),
      });
      const gid2 = grantee.grantId(acc.address, origin, 2n);
      const salt2 = rnd(32);
      await acc.issue(shieldedOnly, gid2, salt2);
      await grantSpend(acc, {
        grantee,
        grantId: gid2,
        color,
        amount: 10n,
        recipient,
        opening: openingOf(shieldedOnly, salt2, origin, 2n),
      });
    },
    'operation not in scope',
  );

  acc.restore(snapshot);
  ok(
    L().grants.lookup(gid).nonce === 1n && L().unshielded_balances.lookup(color) === 800n,
    `${tag} state restored to the post-success snapshot for the next items`,
  );

  // A grantee key holds no device entry, so the device seam refuses it.
  await expectAbort(
    `${tag} grantee key against the device seam`,
    async () => {
      const newKey = rnd(32);
      const ctx = acc.callContext();
      if (grantee.arm === 'jubjub') {
        const a = grantee.sign(jubjubChallenges.rotateEncKey(ctx, grantee.pk, newKey));
        await acc.call(
          'rotate_enc_key_with_jubjub',
          newKey,
          ...authArgs({ arm: 'jubjub', pk: a.pk, use_counter: 0n, sig_r: a.sig_r, sig_s: a.sig_s, grind_nonce: a.grind_nonce }),
        );
      } else {
        const a = grantee.sign(k256Challenges.rotateEncKey(ctx, grantee.pk, newKey));
        await acc.call(
          'rotate_enc_key_with_k256',
          newKey,
          ...authArgs({ arm: 'k256', pk: a.pk, use_counter: 0n, sig: a.sig, envelope: a.envelope }),
        );
      }
    },
    'unknown device entry',
  );

  // ── Expiry, through the simulated block time ─────────────────────────────
  const expScope = spendScope({
    withdrawUnshielded: true,
    color,
    cap: 450n,
    perCallCap: 300n,
    maxCoinValue: 300n,
    recipientKind: RECIPIENT_USER_ADDRESS,
    recipient,
    expiresAt: BigInt(acc.time() + 100),
  });
  const gidExp = grantee.grantId(acc.address, origin, 3n);
  const saltExp = rnd(32);
  await acc.issue(expScope, gidExp, saltExp);
  const expOpening = openingOf(expScope, saltExp, origin, 3n);
  const spendExp = () =>
    grantSpend(acc, { grantee, grantId: gidExp, color, amount: 10n, recipient, opening: expOpening });

  await spendExp();
  ok(L().grants.lookup(gidExp).nonce === 1n, `${tag} grant call before expires_at executes (blockTimeLessThan true)`);
  expOpening.spentPrev = 10n;
  acc.setTime(acc.time() + 200);
  await expectAbort(`${tag} grant call after expires_at`, () => spendExp(), 'grant expired');
  acc.setTime(acc.time() - 200);

  await spend(10n);
  opening.spentPrev = 210n;
  ok(true, `${tag} expires_at = 0 never expires (second call on the open-ended grant)`);

  // ── Revoke, tombstone, re-issue ──────────────────────────────────────────
  await acc.revoke(gid);
  ok(
    L().grants.lookup(gid).active === false && L().grants.lookup(gid).nonce === 2n,
    `${tag} revoke writes a tombstone, other fields kept`,
  );
  await expectAbort(`${tag} grant call against a tombstone`, () => spend(10n), 'grant revoked');
  await expectAbort(`${tag} revoke of a tombstone`, () => acc.revoke(gid), 'grant not live');

  const saltNew = rnd(32);
  await acc.issue(scope, gid, saltNew);
  const gNew = L().grants.lookup(gid);
  ok(
    gNew.active && gNew.nonce === 0n && gNew.issued_at > g0.issued_at,
    `${tag} re-issue over a tombstone yields a fresh incarnation`,
  );
  await expectAbort(
    `${tag} prior-incarnation opening against the re-issue`,
    () => spend(10n, { opening: { ...opening, spentPrev: 0n } }),
    'scope object mismatch',
  );

  // ── Stale generation and the reset ───────────────────────────────────────
  const openingNew = openingOf(scope, saltNew, origin, slot);
  const liveBefore = [...(L().grants as any)].length;
  await acc.revokeAll();
  ok(L().grant_generation === 1n, `${tag} revoke_all bumps grant_generation`);
  ok(L().grants.isEmpty(), `${tag} revoke_all resets the map (${liveBefore} records cleared)`);
  await expectAbort(
    `${tag} grant call after revoke_all (record absent)`,
    () => spend(10n, { opening: openingNew }),
    'unknown grant',
  );
  await acc.issue(scope, gid, saltNew);
  ok(L().grants.lookup(gid).gen === 1n, `${tag} re-issue under the new generation records gen = 1`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Arm-specific negatives
// ─────────────────────────────────────────────────────────────────────────────

/** The JubJub base field modulus, the BLS12-381 scalar field. */
const JUBJUB_Q = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001');

async function armNegatives(): Promise<void> {
  const acc = await openAccount('k256');
  const L = () => acc.L() as any;
  const origin = originHash('https://weak.example');
  const color = rnd(32);
  const recipient = rnd(32);
  const scope = spendScope({
    withdrawUnshielded: true,
    color,
    cap: 450n,
    perCallCap: 300n,
    maxCoinValue: 300n,
    recipientKind: RECIPIENT_USER_ADDRESS,
    recipient,
  });
  await acc.call('deposit_unshielded', color, 1_000n);

  // A dummy signature: every item below aborts before verification.
  const dummyEcdsa = { r: 1n, s: 1n };
  const dummySigR = pureCircuits.compute_public_point_with_jubjub(1n);

  // ── k256: the point at infinity ──────────────────────────────────────────
  // `authenticate_grant_with_k256` calls the device seam's own weak-key
  // guard (GR-14) before it derives an identity, so a record issued at the
  // identity point's id is unreachable by construction.
  {
    const idPk: Secp256k1Point = { x: 0n, y: 0n, identity: true };
    const salt = rnd(32);
    const id = pureCircuits.derive_grant_id_with_k256({ bytes: acc.address }, idPk, K256_ENVELOPE_NONE, origin, 10n);
    await acc.issue(scope, id, salt);
    await expectAbort(
      '[k256] grantee at the point at infinity',
      () =>
        grantSpend(acc, {
                    grantId: id,
          color,
          amount: 10n,
          recipient,
          opening: openingOf(scope, salt, origin, 10n),
          auth: { arm: 'k256', pk: idPk, envelope: K256_ENVELOPE_NONE, sig: dummyEcdsa },
        }),
      'device key is the point at infinity',
    );
  }

  // ── k256: the envelope ───────────────────────────────────────────────────
  // A live envelope-0 grant, presented with envelope 1 in the trailer. In
  // stage one this named a record that does not exist ("unknown grant");
  // finding F1 moved the envelope assert to the head of the seam.
  const grantee = K256Grantee.generate();
  const salt0 = rnd(32);
  const gid0 = grantee.grantId(acc.address, origin, 0n);
  await acc.issue(scope, gid0, salt0);
  await expectAbort(
    '[k256] wrong envelope in the trailer (grant_id mismatch)',
    () =>
      grantSpend(acc, {
        grantee,
        grantId: gid0,
        color,
        amount: 10n,
        recipient,
        opening: openingOf(scope, salt0, origin, 0n),
        envelope: K256_ENVELOPE_CONNECTOR,
      }),
    'envelope not admitted for a spend grant',
  );

  // An envelope-1 grantee is a distinct identity, and its grant issues, but
  // the connector `signData` surface is a blind signing oracle, so the seam
  // admits no spend from it (MIP sections 3.2 and 6.2 step 1).
  {
    const connector = new K256Grantee(grantee.sk, K256_ENVELOPE_CONNECTOR);
    const salt = rnd(32);
    const id = connector.grantId(acc.address, origin, 11n);
    await acc.issue(scope, id, salt);
    ok(!eq(id, gid0), '[k256] an envelope-1 grantee is a different grant identity from the same key at envelope 0');
    await expectAbort(
      '[k256] envelope-1 grantee spending',
      () =>
        grantSpend(acc, {
          grantee: connector,
          grantId: id,
          color,
          amount: 10n,
          recipient,
          opening: openingOf(scope, salt, origin, 11n),
        }),
      'envelope not admitted for a spend grant',
    );
  }

  // ── jubjub: weak keys ────────────────────────────────────────────────────
  // The identity (0, 1) has coordinates and yields a well-formed grant_id
  // (GRANTS-E1.md section 8 item 3), so the cofactor-clearing guard of
  // `authenticate_grant_with_jubjub` is the only thing that rejects it.
  {
    const idPk = { x: 0n, y: 1n } as JubjubPoint;
    const salt = rnd(32);
    const id = pureCircuits.derive_grant_id_with_jubjub({ bytes: acc.address }, idPk, origin, 12n);
    await acc.issue(scope, id, salt);
    await expectAbort(
      '[jubjub] grantee at the identity (0, 1)',
      () =>
        grantSpend(acc, {
                    grantId: id,
          color,
          amount: 10n,
          recipient,
          opening: openingOf(scope, salt, origin, 12n),
          auth: { arm: 'jubjub', pk: idPk, sig_r: dummySigR, sig_s: 0n, grind_nonce: 0n },
        }),
      'grantee key has small order',
    );
  }

  // The order-2 point (0, -1) is on the curve and hashes to a well-formed
  // grant_id, but the runtime's curve built-ins refuse to operate on a
  // point outside the prime-order subgroup at all, so the call traps in
  // `ecMul` before the guard's comparison is reached. Off-node the
  // rejection is therefore the runtime's, not the assert's; the needle is
  // left open because the trap message is a runtime detail. On a node the
  // proof would not be produced for the same reason.
  {
    const smallOrder = { x: 0n, y: JUBJUB_Q - 1n } as JubjubPoint;
    const salt = rnd(32);
    const id = pureCircuits.derive_grant_id_with_jubjub({ bytes: acc.address }, smallOrder, origin, 13n);
    await acc.issue(scope, id, salt);
    await expectAbort(
      '[jubjub] grantee at the order-2 point (0, -1)',
      () =>
        grantSpend(acc, {
                    grantId: id,
          color,
          amount: 10n,
          recipient,
          opening: openingOf(scope, salt, origin, 13n),
          auth: { arm: 'jubjub', pk: smallOrder, sig_r: dummySigR, sig_s: 0n, grind_nonce: 0n },
        }),
    );
  }

  // ── jubjub: the grind nonce is bound by the challenge ────────────────────
  const jGrantee = JubjubGrantee.generate();
  const saltJ = rnd(32);
  const gidJ = jGrantee.grantId(acc.address, origin, 4n);
  await acc.issue(scope, gidJ, saltJ);
  const openingJ = openingOf(scope, saltJ, origin, 4n);
  await expectAbort(
    '[jubjub] signature presented under the wrong grind nonce',
    () =>
      grantSpend(acc, {
        grantee: jGrantee,
        grantId: gidJ,
        color,
        amount: 10n,
        recipient,
        opening: openingJ,
        grindNonce: 99n,
      }),
    badSignatureNeedles('jubjub'),
  );

  // ── Cross-arm: the two rosters never mix ─────────────────────────────────
  // A record issued on one grantee arm is invisible to the other arm's
  // twin, because each arm derives its own identity from its own key type.
  await expectAbort(
    '[cross-arm] a jubjub grantee against a k256 grant',
    () =>
      grantSpend(acc, {
        grantee: jGrantee,
        grantId: gid0,
        color,
        amount: 10n,
        recipient,
        opening: openingOf(scope, salt0, origin, 0n),
      }),
    'unknown grant',
  );
  await expectAbort(
    '[cross-arm] a k256 grantee against a jubjub grant',
    () =>
      grantSpend(acc, {
        grantee,
        grantId: gidJ,
        color,
        amount: 10n,
        recipient,
        opening: { ...openingJ, slot: 4n },
      }),
    'unknown grant',
  );

  ok(L().grant_generation === 0n, '[negatives] no negative disturbed the grant generation');
}

// ─────────────────────────────────────────────────────────────────────────────
// The twins that cannot run off-node
// ─────────────────────────────────────────────────────────────────────────────

/** The declared argument count of an impure circuit, less its context: the
 *  generated wrapper reports it when the arity is wrong, which is the only
 *  way to read a circuit's shape without executing it. */
async function declaredArity(impure: Record<string, (...a: any[]) => Promise<any>>, name: string): Promise<number> {
  try {
    await impure[name]();
    return -1;
  } catch (e: any) {
    const m = /expected (\d+) arguments/.exec(String(e?.message ?? e));
    return m ? Number(m[1]) - 1 : -1;
  }
}

async function shieldedTwinShape(): Promise<void> {
  // The four shielded grant twins consume a `QualifiedShieldedCoinInfo`
  // from the `held_coin` witness and pay a real zswap output, and the local
  // simulator has no zswap state, so they cannot execute here at all: their
  // rejection matrix (the coin bound, the stale enc_pk, the change append)
  // belongs to the on-node suites. What is asserted off-node is that each
  // one exists on the compiled module and declares the argument count the
  // MIP section 6.1 trailer implies: five operation arguments plus the
  // grantee trailer, ten members on the k256 arm and eleven on jubjub.
  const contract = new Contract<PrivateState>(stubWitnesses());
  const impure = contract.impureCircuits as unknown as Record<string, (...a: any[]) => Promise<any>>;
  const expected: Array<[string, number]> = [
    ['withdraw_shielded_with_grant_k256', 15],
    ['withdraw_shielded_to_contract_with_grant_k256', 15],
    ['withdraw_shielded_with_grant_jubjub', 16],
    ['withdraw_shielded_to_contract_with_grant_jubjub', 16],
  ];
  for (const [name, arity] of expected) {
    const seen = await declaredArity(impure, name);
    ok(seen === arity, `${name} exists and declares ${arity} arguments${seen === arity ? '' : ` (saw ${seen})`}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side issue rules
// ─────────────────────────────────────────────────────────────────────────────

function clientIssueRules(): void {
  const readPkHash = rnd(32);
  expectRefusal(
    'issue rule 3 (per_call_cap above cap)',
    () => spendScope({ withdrawUnshielded: true, color: ZERO32, cap: 10n, perCallCap: 11n }),
    'rule 3',
  );
  expectRefusal(
    'issue rule 4 (max_coin_value below per_call_cap)',
    () => spendScope({ withdrawShielded: true, color: ZERO32, cap: 10n, maxCoinValue: 1n, readPkHash }),
    'rule 4',
  );
  expectRefusal(
    'issue rule 5 (shielded without a delegate key hash)',
    () => spendScope({ withdrawShielded: true, color: ZERO32, cap: 10n }),
    'rule 5',
  );
  ok(
    spendScope({ withdrawShielded: true, color: ZERO32, cap: 10n, readPkHash }).read === true,
    'issue rule 2 (a shielded flag implies read)',
  );
  expectRefusal(
    'issue rule 1 (no operation flag and no read)',
    () => assertIssueRules({ ...readOnlyScope({ readPkHash }), read: false }),
    'rule 1',
  );
  expectRefusal(
    'issue rule 6 (window bounds are reserved)',
    () => assertIssueRules({ ...readOnlyScope({ readPkHash }), windowLen: 1n }),
    'rule 6',
  );
  expectRefusal(
    'issue rule 7 (a read-only grant carrying object fields)',
    () => assertIssueRules({ ...readOnlyScope({ readPkHash }), cap: 1n }),
    'rule 7',
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let m = section('[dev k256 / grantee k256] lifecycle and the unshielded grant twin');
  await scenario('k256', 'k256');
  endSection(m);

  m = section('[dev jubjub / grantee jubjub] lifecycle and the unshielded grant twin');
  await scenario('jubjub', 'jubjub');
  endSection(m);

  m = section('arm-specific negatives');
  await armNegatives();
  endSection(m);

  m = section('the shielded twins, which cannot execute off-node');
  await shieldedTwinShape();
  endSection(m);

  m = section('client-side issue rules');
  clientIssueRules();
  endSection(m);

  console.log('');
  for (const t of tally) console.log(`  ${String(t.passed).padStart(3)} passed, ${t.failed} failed  ${t.label}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
