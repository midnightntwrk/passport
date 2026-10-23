// Test support: the checked byte hints of an `evm_eip712` call, recomputed
// from the values the call EXECUTES.
//
// The hints (src/wallet/evm-eip712-hints.ts) are exact bytes of values the
// circuit computes; a wrong hint only fails the call. The suites build many
// calls by hand, including tampered ones (a message signed over one value and
// executed with another, an approval replayed on another account), and each
// expects the refusal of the rule it targets ("invalid signature", a scope
// rule, ...). An honest client computes the hints from the values the circuit
// executes, so the simulators recompute them here the same way before every
// arm call, whatever hints the call carries; the refusal a case expects is
// then the one it gets. A case that tests the hint checks themselves marks its
// call with KEEP_HINTS, and its hints are passed through unchanged.
//
// `pc` is the pure-circuit object of the module that executes the call (a
// patched copy's own, when the call runs through one), so the frame, struct
// hash and digest are the ones that module computes.

import {
  evmEip712KeyHint, accountHashHint, bytesHint, leHint, evmEip712CoinHint, evmEip712Base58Hint,
} from '../wallet/evm-eip712-hints.js';
import { solanaKeyInputs } from '../wallet/descriptors.js';
import { siteAmountLabelBytes, utcDateTimeInputs } from '../wallet/rendering.js';
import type { SiteAmount } from '../wallet/evm-eip712-codec.js';

/** The site amount label the suites sign with unless a case says otherwise. */
export const TEST_SITE: SiteAmount = { decimals: 6, symbol: 'TOKEN' };

/** The site choices (decimal point and symbol) a 49-byte label carries; the
 *  test site when there is none or it does not parse. */
export function siteOf(label: unknown): SiteAmount {
  if (!Array.isArray(label) || label.length !== 49) return TEST_SITE;
  const text = String.fromCharCode(...label.map((x) => Number(x))).trimEnd();
  const m = /^([0-9]+)(?:\.([0-9]+))? (\S+)$/.exec(text);
  return m ? { decimals: m[2]?.length ?? 0, symbol: m[3] } : TEST_SITE;
}
/** The label of `amount` with the site's choices (49 spaces when the amount
 *  cannot be shown: a value the runtime's type check refuses first). */
export function labelHint(amount: unknown, site: SiteAmount): bigint[] {
  try { return bytesHint(siteAmountLabelBytes(amount as bigint, site.decimals, site.symbol)); } catch { return new Array(49).fill(32n); }
}

/** A call (its auth argument, or its trailing operation hint) carrying this
 *  symbol keeps the hints it was built with. */
export const KEEP_HINTS = Symbol.for('evm_eip712.test.keepHints');

export interface HintContext {
  /** The executing account's 32-byte address. */
  account: Uint8Array;
  /** The decoded ledger before the call. */
  ledger: any;
  /** The coin the held_coin witness returns for a colour (shielded spends). */
  coin(color: Uint8Array): { nonce: Uint8Array; value: bigint; mtIndex: bigint } | undefined;
  /** keccak256 of a key's big-endian x || y, when the executing module
   *  replaces it (the forged-address copy); default: the real hash. */
  keyHash?(pk: { x: bigint; y: bigint }): Uint8Array | undefined;
}

const fits = (v: unknown, n: number) => typeof v === 'bigint' && v >= 0n && v < 1n << BigInt(8 * n);
const u8s = (h: unknown) => Uint8Array.from(h as bigint[], (x) => Number(x));
const le = (v: unknown, n: number) => (fits(v, n) ? leHint(v as bigint, n) : leHint(0n, n));
const zero32 = () => bytesHint(new Uint8Array(32));
const attempt = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };

// circuit -> [index of the auth argument, the circuit's arity without its operation hint, takes an operation hint]
const DEVICE: Record<string, [number, number, boolean]> = {
  rotate_enc_key_with_evm_eip712: [1, 2, false],
  withdraw_unshielded_with_evm_eip712: [3, 4, true],
  withdraw_shielded_with_evm_eip712: [3, 4, true],
  withdraw_shielded_to_contract_with_evm_eip712: [3, 4, true],
  append_inbox_with_evm_eip712: [1, 2, false],
  add_device_with_evm_eip712: [4, 5, true],
  remove_device_with_evm_eip712: [7, 8, true],
  issue_grant_with_evm_eip712: [20, 21, true],
  revoke_grant_with_evm_eip712: [4, 5, true],
  revoke_all_grants_with_evm_eip712: [0, 1, false],
  recover_cancel_with_evm_eip712: [0, 1, false],
  publish_recovery_session_with_evm_eip712: [8, 9, false],
};
const GRANTEE: Record<string, [number, number]> = {
  withdraw_unshielded_with_grant_evm_eip712: [10, 11],
  withdraw_shielded_with_grant_evm_eip712: [12, 13],
  withdraw_shielded_to_contract_with_grant_evm_eip712: [12, 13],
};

const kept = (x: unknown) => !!x && typeof x === 'object' && (x as any)[KEEP_HINTS] === true;
// the circuits whose arguments 1..3 are a Solana key's point and its two byte inputs
const SOL_ARGS = new Set(['add_device_with_evm_eip712', 'remove_device_with_evm_eip712', 'issue_grant_with_evm_eip712', 'revoke_grant_with_evm_eip712']);

/** `args` with every hint of an `evm_eip712` circuit recomputed from the
 *  executed values (other circuits: unchanged). */
export function withExecutedHints(pc: any, ctx: HintContext, circuit: string, args: unknown[]): unknown[] {
  if (circuit === 'activate_initial_device_with_evm_eip712') {
    if (args.length > 3 && kept(args[3])) return args;
    const pk = args[0] as any;
    return [args[0], args[1], args[2], keyHintOf(ctx, pk)];
  }
  const dev = DEVICE[circuit];
  const gr = GRANTEE[circuit];
  if (!dev && !gr) return args;
  const [ai, arity] = dev ?? gr;
  const auth: any = args[ai];
  if (args.some(kept)) return args;
  const out = args.slice(0, arity);
  // the site choices of the label the call carries (its operation hint), else the test site
  const passed: any = args.length > arity ? args[arity] : undefined;
  const site = siteOf(passed?.label);
  if (SOL_ARGS.has(circuit)) {
    // the byte inputs of the point the call executes (a point the client
    // check refuses keeps the inputs it was passed)
    const k = attempt(() => solanaKeyInputs(args[1] as { x: bigint; y: bigint }));
    if (k) { out[2] = k.pkBytes; out[3] = k.pkX; }
  }
  const keyHint = keyHintOf(ctx, auth.pk);
  const address = attempt(() => pc.evm_eip712_address(auth.pk, keyHint)) as Uint8Array | undefined;
  const ah = accountHashHint(ctx.account);
  const self = { bytes: ctx.account };
  const a = args;
  let op: unknown;
  let structHash: Uint8Array | undefined;
  if (dev) {
    const nonce: bigint = ctx.ledger.auth_nonce;
    const nh = leHint(nonce, 8);
    const f = [ctx.account, address, nonce, nh];
    const coinFor = (color: Uint8Array) => ctx.coin(color);
    switch (circuit) {
      case 'rotate_enc_key_with_evm_eip712': structHash = attempt(() => pc.evm_eip712_struct_rotate_enc_key(...f, a[0])); break;
      case 'withdraw_unshielded_with_evm_eip712':
        op = { amount: le(a[1], 16), label: labelHint(a[1], site) };
        structHash = attempt(() => pc.evm_eip712_struct_withdraw_unshielded(...f, a[0], a[1], (a[2] as any).bytes, op)); break;
      case 'withdraw_shielded_with_evm_eip712':
      case 'withdraw_shielded_to_contract_with_evm_eip712': {
        const c = coinFor(a[1] as Uint8Array);
        op = c && fits(a[2], 16) && c.value >= (a[2] as bigint) ? evmEip712CoinHint(a[2] as bigint, c.value, c.mtIndex, site)
          : { amount: le(a[2], 16), value: le(c?.value, 16), mt_index: le(c?.mtIndex, 8), change: leHint(0n, 16), label: labelHint(a[2], site) };
        const oracle = circuit === 'withdraw_shielded_with_evm_eip712' ? pc.evm_eip712_struct_withdraw_shielded : pc.evm_eip712_struct_withdraw_shielded_to_contract;
        structHash = c && attempt(() => oracle(...f, a[1], a[2], (a[0] as any).bytes, c.nonce, c.value, c.mtIndex, op));
        break;
      }
      case 'append_inbox_with_evm_eip712': structHash = attempt(() => pc.evm_eip712_struct_append_inbox(...f, a[0])); break;
      case 'add_device_with_evm_eip712': {
        op = descriptorHintFor(a[0], out[2]);
        structHash = attempt(() => pc.evm_eip712_struct_add_device(...f, a[0], out[2], op));
        break;
      }
      case 'remove_device_with_evm_eip712': {
        op = { target: descriptorHintFor(a[0], out[2]), epoch: le(a[4], 4), counter: le(a[5], 8) };
        const unknown: any = a[6];
        if (unknown?.is_some) structHash = attempt(() => pc.evm_eip712_struct_remove_unknown_device(...f, unknown.value));
        else structHash = attempt(() => pc.evm_eip712_struct_remove_device(...f, a[0], out[2], a[4], a[5], op));
        break;
      }
      case 'issue_grant_with_evm_eip712': {
        const g: any = a[0];
        const scope = { maxCoinValue: a[11], perCallCap: a[12], cap: a[13], expiresAt: a[14], windowLen: a[17], windowCap: a[18] } as any;
        const e = fits(scope.expiresAt, 8) ? utcDateTimeInputs(scope.expiresAt) : { text: new Array(29).fill(32n), yearSplit: [0n, 0n, 0n, 0n] };
        op = {
          grantee: granteeHintFor(g, out[2]), max_coin_value: le(scope.maxCoinValue, 16), per_call_cap: le(scope.perCallCap, 16), cap: le(scope.cap, 16),
          expires_at: le(scope.expiresAt, 8), window_len: le(scope.windowLen, 8), window_cap: le(scope.windowCap, 16),
          expiry_text: e.text, year_split: e.yearSplit,
        };
        structHash = attempt(() => pc.evm_eip712_struct_issue_grant(...f, g, out[2], ...a.slice(4, 20), op));
        break;
      }
      case 'revoke_grant_with_evm_eip712': {
        const g: any = a[0];
        op = granteeHintFor(g, out[2]);
        structHash = attempt(() => pc.evm_eip712_struct_revoke_grant(...f, g, out[2], op));
        break;
      }
      case 'revoke_all_grants_with_evm_eip712': structHash = attempt(() => pc.evm_eip712_struct_revoke_all_grants(...f)); break;
      case 'recover_cancel_with_evm_eip712': structHash = attempt(() => pc.evm_eip712_struct_cancel_recovery(...f)); break;
      case 'publish_recovery_session_with_evm_eip712': structHash = attempt(() => pc.evm_eip712_struct_publish_recovery_session(...f, ...a.slice(0, 8))); break;
    }
    const digest = structHash && attempt(() => pc.evm_eip712_digest(ctx.account, structHash, ah)) as Uint8Array | undefined;
    out[ai] = { ...auth, hint: { key: keyHint, account_hash: ah, digest: digest ? bytesHint(digest) : zero32(), nonce: nh } };
    if (dev[2]) out.push(op);
    return out;
  }
  // the grantee role: the frame from the grant record the circuit reads
  const label = a[gr[0] === 10 ? 3 : 5] as Uint8Array;
  const slot = a[gr[0] === 10 ? 4 : 6] as bigint;
  const id = address && attempt(() => pc.derive_grant_id_with_evm_eip712(self, address, auth.blind, pc.derive_grant_origin_hash_label(label), slot));
  const rec = id && attempt(() => (ctx.ledger.grants.member(id) ? ctx.ledger.grants.lookup(id) : undefined));
  const issuedAt: bigint = rec?.issued_at ?? 0n;
  const grantNonce: bigint = rec?.nonce ?? 0n;
  const lh = bytesHint(label);
  const ih = leHint(issuedAt, 8);
  const gh = leHint(grantNonce, 8);
  const gf = [ctx.account, address, label, lh, slot, issuedAt, ih, grantNonce, gh];
  if (circuit === 'withdraw_unshielded_with_grant_evm_eip712') {
    op = { amount: le(a[1], 16), label: labelHint(a[1], site) };
    structHash = attempt(() => pc.evm_eip712_struct_withdraw_unshielded_as_grantee(...gf, a[0], a[1], (a[2] as any).bytes, op));
  } else {
    const c = ctx.coin(a[1] as Uint8Array);
    op = c && fits(a[2], 16) && c.value >= (a[2] as bigint) ? evmEip712CoinHint(a[2] as bigint, c.value, c.mtIndex, site)
      : { amount: le(a[2], 16), value: le(c?.value, 16), mt_index: le(c?.mtIndex, 8), change: leHint(0n, 16), label: labelHint(a[2], site) };
    const oracle = circuit === 'withdraw_shielded_with_grant_evm_eip712'
      ? pc.evm_eip712_struct_withdraw_shielded_as_grantee : pc.evm_eip712_struct_withdraw_shielded_to_contract_as_grantee;
    structHash = c && attempt(() => oracle(...gf, a[1], a[2], (a[0] as any).bytes, a[3], a[4], c.nonce, c.value, c.mtIndex, op));
  }
  const digest = structHash && attempt(() => pc.evm_eip712_digest(ctx.account, structHash, ah)) as Uint8Array | undefined;
  out[ai] = { ...auth, hint: { key: keyHint, account_hash: ah, digest: digest ? bytesHint(digest) : zero32(), label: lh, issued_at: ih, grant_nonce: gh } };
  out.push(op);
  return out;
}

// A descriptor's hints with the base58 inputs of the key bytes the call
// executes (its `sol_bytes` argument, whatever key the descriptor names).
const b58Of = (solBytes: unknown) => attempt(() => evmEip712Base58Hint(u8s(solBytes))) ?? evmEip712Base58Hint(new Uint8Array(32));
const descriptorHintFor = (d: any, solBytes: unknown) =>
  ({ key: bytesHint(d.key), key2: bytesHint(d.key2), origin: bytesHint(d.origin), b58: b58Of(solBytes) });
const granteeHintFor = (g: any, solBytes: unknown) =>
  ({ key: bytesHint(g.key), key2: bytesHint(g.key2), origin: bytesHint(g.origin), label: bytesHint(g.label), b58: b58Of(solBytes) });

function keyHintOf(ctx: HintContext, pk: { x: bigint; y: bigint }) {
  const h = evmEip712KeyHint(pk);
  const forged = ctx.keyHash?.(pk);
  return forged ? { ...h, key_hash: bytesHint(forged) } : h;
}

/** The coin a coin store's held_coin answers for `color`. */
export function storeCoin(ps: { coins: Record<string, { nonceHex: string; value: string; mtIndex: string }> } | undefined, color: Uint8Array) {
  const s = ps?.coins?.[Buffer.from(color).toString('hex')];
  return s ? { nonce: new Uint8Array(Buffer.from(s.nonceHex, 'hex')), value: BigInt(s.value), mtIndex: BigInt(s.mtIndex) } : undefined;
}

/** A deep copy keeping Uint8Array and bigint values. */
const clone = (v: any): any => (v instanceof Uint8Array ? new Uint8Array(v) : Array.isArray(v) ? v.map(clone)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);

/** The call with its exact hints (from the executed values), then one hint
 *  changed and the call marked KEEP_HINTS. `where` is 'auth' (the auth
 *  argument's `hint`), 'op' (the trailing operation hint) or an argument
 *  index; `path` names the field (empty: the argument itself). 'flip' flips
 *  the low bit of byte `at`;
 *  'carry' adds 256 to one byte and subtracts 1 from the next (the same
 *  number, a byte above 8 bits).
 *  A flipped Solana key encoding (argument 2 of the descriptor circuits) also
 *  carries the base58 inputs of the flipped bytes, as a forger would supply
 *  them: the base58 text then reads back to the bytes the call executes, and
 *  only the encoder's comparison with the point refuses them. */
export function forgeHints(pc: any, ctx: HintContext, circuit: string, args: unknown[], authIndex: number,
  where: 'auth' | 'op' | number, path: string[], mode: 'flip' | 'carry', at = 0): unknown[] {
  const exact = clone(withExecutedHints(pc, ctx, circuit, args));
  let root: any = where === 'auth' ? exact[authIndex].hint : where === 'op' ? exact[exact.length - 1] : exact[where];
  for (const k of path.slice(0, -1)) root = root[k];
  const h: bigint[] = path.length ? root[path.at(-1)!] : root;
  if (mode === 'flip') {
    h[Math.min(at, h.length - 1)] ^= 1n;
    if (where === 2 && SOL_ARGS.has(circuit) && path.length === 0) {
      const op: any = exact[exact.length - 1];
      const d: any = op.b58 ? op : op.target ?? op.grantee;
      d.b58 = b58Of(h);
    }
  } else {
    const i = Math.max(0, h.findIndex((_, j) => j + 1 < h.length && h[j + 1] > 0n));
    if (h[i + 1] === 0n) h[i + 1] = 1n; // no carry pair in an all-zero value: the byte still exceeds 8 bits
    h[i] += 256n; h[i + 1] -= 1n;
  }
  (where === 'op' ? exact[exact.length - 1] : exact[where === 'auth' ? authIndex : where])[KEEP_HINTS] = true;
  return exact;
}
