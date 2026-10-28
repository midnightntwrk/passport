// Offline checks of the EVM arm's per-kind Ed25519 key text.
//
// An enrolment kind whose key is an Ed25519 point chooses how an approval
// shows that key: `base58` (the default, space-padded to 44 bytes),
// `prefixed_base58` (the same text after "ed25519:") or `hex` (64 lowercase
// characters). The choice changes only the shown text, never the checked
// derivation of the target.
//
//   text     ed25519DisplayText against an independent base58 and hex
//            encoder; the default form is byte-identical to ed25519Base58Text
//   frozen   every vector of vectors/evm-k256-v1.json keeps its frozen
//            digest, in the client codec and in the contract
//   kinds    for every registered Ed25519 kind, an add-device and a
//            revoke-grant approval show the key in the kind's form and the
//            client digest equals the contract's; the same approval with the
//            key in any other form gives a different digest
//   direct   evm_k256_key_text_hash, from the account or from the test probe
//            contract probe-evm-k256-key-text: each form's hash equals
//            keccak256 of the expected text (the forms no registered kind
//            uses are proved here)
//
// Exit 0: every check passed and every form went through a contract.
// Exit 2: every check passed, but some form never reached a contract.
// Exit 1: a check failed, or the selector is missing.
// Needs the compiled account contract and, for the direct check, the
// compiled probe (a --skip-zk build is enough). No node, no proof server,
// no network.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pureCircuits } from '../wallet/contract.js';
import * as codecModule from '../wallet/evm-k256-codec.js';
import { padTag, DESCRIPTOR_TAGS } from '../wallet/descriptors.js';
import { evmK256Base58Hint } from '../wallet/evm-k256-hints.js';
import { typedDataOf, contractDigest, VECTOR_FILE } from './evm-k256-vectors.js';

// The forms in the order of the contract's EvmK256KeyText enum.
const FORMS = ['base58', 'prefixed_base58', 'hex'] as const;
type Form = (typeof FORMS)[number];
const ED25519_PAYLOAD = 'ed25519';
const PROBE = '../../contracts/managed/probe-evm-k256-key-text/contract/index.js';
const codec: any = codecModule;
const pc: any = pureCircuits;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b: Uint8Array): string {
  let n = BigInt('0x' + hex(b));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
}

/** The text a form shows for a key, built without the codec. */
function expectedText(key: Uint8Array, form: Form): string {
  const b58 = base58(key).padEnd(44, ' ');
  return form === 'hex' ? hex(key) : form === 'prefixed_base58' ? `ed25519:${b58}` : b58;
}

let checks = 0;
const check = (ok: boolean, what: string): void => { checks++; assert.ok(ok, what); };
const circuitForms = new Set<Form>();

async function main(): Promise<number> {
  if (typeof codec.ed25519DisplayText !== 'function') {
    console.error('FAIL: evm-k256-codec.ts exports no ed25519DisplayText; the key-text selector is missing');
    return 1;
  }
  const frozen = JSON.parse(fs.readFileSync(new URL(`./vectors/${VECTOR_FILE}`, import.meta.url), 'utf8'));
  const ed25519Target = (v: any) => v.args?.descriptor ?? v.args?.grantee;

  // Seeded keys plus every Solana key of the frozen file; some of those start
  // with zero bytes, so their base58 text is shorter and padded.
  const keys: Uint8Array[] = Array.from({ length: 16 }, (_, i) =>
    ed25519.getPublicKey(createHash('sha256').update(`key-text-offline/${i}`).digest()));
  keys.push(new Uint8Array(32), new Uint8Array(32).fill(255));
  for (const v of frozen.vectors) if (ed25519Target(v)?.scheme === 'sol_ed25519') keys.push(unhex(ed25519Target(v).key));

  // text
  for (const k of keys) {
    check(codec.ed25519DisplayText(k) === codec.ed25519Base58Text(k), `default form of ${hex(k)} is the base58 text`);
    for (const f of FORMS) check(codec.ed25519DisplayText(k, f) === expectedText(k, f), `${f} text of ${hex(k)}`);
  }
  assert.throws(() => codec.ed25519DisplayText(new Uint8Array(31), 'hex'), /32 bytes/); checks++;

  // frozen
  for (const v of frozen.vectors) {
    const want = String(v.digest).replace(/^0x/, '');
    check(hex(codec.typedDataDigest(typedDataOf(v))) === want, `client digest of ${v.name}`);
    check(hex(contractDigest(pc, v)) === want, `contract digest of ${v.name}`);
  }

  // kinds
  const template = (op: string) => frozen.vectors.find((v: any) => v.op === op && ed25519Target(v)?.scheme === 'sol_ed25519');
  const shapes = [
    { t: template('addDevice'), field: 'descriptor', member: 'newDevice', recipe: 'device' },
    { t: template('revokeGrant'), field: 'grantee', member: 'grantee', recipe: 'grant-id' },
  ] as const;
  assert.ok(shapes.every((s) => s.t), 'the frozen file has a Solana-key add-device and revoke-grant vector');
  check((codec.EVM_K256_PAYLOADS as string[]).includes(ED25519_PAYLOAD), `the payload form is named ${ED25519_PAYLOAD}`);
  const kinds: string[] = codec.EVM_K256_KIND_SCHEMES.filter((s: string) => codec.EVM_K256_KINDS[s].payload === ED25519_PAYLOAD);
  check(kinds.includes('sol_ed25519'), 'sol_ed25519 is an Ed25519 kind');
  check((codec.EVM_K256_KINDS.sol_ed25519.keyText ?? 'base58') === 'base58', 'Solana keys stay base58');
  const seen: string[] = [];
  for (const scheme of kinds) {
    const form: Form = codec.EVM_K256_KINDS[scheme].keyText ?? 'base58';
    check((FORMS as readonly string[]).includes(form), `${scheme}: a known key-text form`);
    seen.push(`${scheme}=${form}`);
    for (const [i, k] of keys.slice(0, 4).entries()) {
      for (const s of shapes) {
        const v = structuredClone(s.t);
        v.name = `${v.op}/${scheme}#${i}`;
        v.args[s.field].scheme = scheme;
        v.args[s.field].tag = hex(padTag((DESCRIPTOR_TAGS as any)[s.recipe][scheme]));
        v.args[s.field].key = hex(k);
        const td: any = typedDataOf(v);
        check(td.message[s.member].publicKey === expectedText(k, form), `${v.name} shows the key as ${form}`);
        const want = hex(contractDigest(pc, v));
        check(hex(codec.typedDataDigest(td)) === want, `${v.name}: the client digest equals the contract's`);
        for (const other of FORMS.filter((f) => f !== form)) {
          const alt = structuredClone(td);
          alt.message[s.member].publicKey = expectedText(k, other);
          check(hex(codec.typedDataDigest(alt)) !== want, `${v.name}: the ${other} text is not what the contract hashes`);
        }
      }
    }
    circuitForms.add(form);
  }

  // direct
  let direct: any = typeof pc.evm_k256_key_text_hash === 'function' ? pc : undefined;
  if (!direct) {
    try { direct = (await import(PROBE)).pureCircuits; } catch { direct = undefined; }
  }
  if (typeof direct?.evm_k256_key_text_hash === 'function') {
    for (const k of keys) {
      FORMS.forEach((f, n) => {
        const got = hex(direct.evm_k256_key_text_hash(Array.from(k, BigInt), evmK256Base58Hint(k), n));
        check(got === hex(codec.keccak(new TextEncoder().encode(expectedText(k, f)))), `evm_k256_key_text_hash ${f} of ${hex(k)}`);
        // The hint is checked even when hex is selected. Mutate each field
        // independently; a selector that skips the base58 check must fail.
        for (const field of ['digits', 'carry', 'low', 'top'] as const) {
          const bad = structuredClone(evmK256Base58Hint(k));
          if (field === 'digits') bad.digits[5] = (bad.digits[5] + 1n) % 58n;
          else bad[field] ^= 1n;
          assert.throws(() => direct.evm_k256_key_text_hash(Array.from(k, BigInt), bad, n),
            /failed assert: display:/, `${f}: invalid ${field} must be refused`);
          checks++;
        }
        for (const other of FORMS.filter((other) => other !== f)) {
          check(got !== hex(codec.keccak(new TextEncoder().encode(expectedText(k, other)))),
            `${f}: the ${other} hash is not accepted`);
        }
        circuitForms.add(f);
      });
    }
  } else {
    console.log('direct check skipped: neither the account nor the probe contract exports evm_k256_key_text_hash');
  }

  const missing = FORMS.filter((f) => !circuitForms.has(f));
  console.log(`checks: ${checks}`);
  console.log(`Ed25519 kinds: ${seen.join(', ')}`);
  console.log(`forms through the contract: ${[...circuitForms].join(', ')}`);
  if (missing.length) {
    console.log(`VERDICT: INCOMPLETE (never reached the contract: ${missing.join(', ')})`);
    return 2;
  }
  console.log('VERDICT: PASS');
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`FAIL after ${checks} checks: ${(e as Error).message}`);
  process.exitCode = 1;
}
