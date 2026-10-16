// Synthetic test accounts only. Run with npm run fixtures.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Contract, ledger, pureCircuits as pure } from '../reference/src/wallet/contract.js';
import { JubjubDevice, K256Device, JubjubGrantee, K256Grantee, SECP256K1_N, JUBJUB_R, bytesToBigIntLE, originHash, authArgs, scopeArgs } from '../reference/src/wallet/signer.js';
import { softwarePasskey, TEST_ORIGIN, TEST_RP, sha256 } from '../reference/src/tests/p256-fixtures.js';
import { P256Device, P256Grantee } from '../reference/src/wallet/signer-p256.js';
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
// Cycle every accepted flag combination, and include a nonzero authenticator counter.
function variedPasskey() {
  const p = softwarePasskey();
  let count = 0;
  const assertion = (challenge: Uint8Array) => p.assertion(challenge, { authenticatorData: new Uint8Array([...sha256(Buffer.from(TEST_RP)), [5, 13, 29][count++ % 3], 0, 0, 0, 7]) });
  return { device: new P256Device(p.pk, TEST_RP, TEST_ORIGIN, assertion), grantee: new P256Grantee(p.pk, TEST_RP, TEST_ORIGIN, assertion) };
}
const require = createRequire(new URL('../package.json', import.meta.url));
const { createCircuitContext, createConstructorContext, createCallContext } = await import(require.resolve('@midnight-ntwrk/compact-runtime'));
const dir = fileURLToPath(new URL('../fixtures/private/', import.meta.url));
mkdirSync(dir, { recursive: true });
const b = (n: number, width = 32) => new Uint8Array(width).fill(n);
const clean = (x: any): any => x instanceof Uint8Array ? [...x] : typeof x === 'bigint' ? x.toString() : Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v)])) : x;
function state(s: any): any {
  if (typeof s.type !== 'function' && s.state) return state(s.state);
  const tag = s.type();
  if (tag === 'null') return { tag };
  if (tag === 'cell') return { tag, value: clean(s.asCell()) };
  if (tag === 'array') return { tag, value: s.asArray().map(state) };
  if (tag === 'map') {
    const m = s.asMap();
    return { tag, value: m.keys().map((k: any) => [clean(k), state(m.get(k))]) };
  }
  throw new Error(`unsupported state ${tag}`);
}
let seq = 0;
const fixtureFiles: string[] = [];
for (const [arm, envelope] of [['k256', 1n], ['jubjub', 0n], ['k256', 0n], ['p256', 0n]] as const) {
for (const grantArm of ['jubjub', 'k256', 'p256'] as const) {
  const owner = arm === 'jubjub' ? new JubjubDevice(17n) : arm === 'k256' ? new K256Device(17n, envelope) : variedPasskey().device;
  const grantee = grantArm === 'jubjub' ? new JubjubGrantee(23n) : grantArm === 'k256' ? new K256Grantee(23n) : variedPasskey().grantee;
  let recovery = new JubjubDevice(37n);
  const address = b(11), addressHex = Buffer.from(address).toString('hex');
  const coinPk = { bytes: b(12) }, salt = b(13), color = b(14), recipient = { bytes: b(15) };
  let coin = { nonce: b(16), color, value: 1000n, mt_index: 0n };
  const contract = new Contract({ held_coin: (ctx: any) => [ctx.privateState, coin] });
  const init = await contract.initialState(createConstructorContext({}, coinPk), owner.bootCommitment(salt), b(18), recovery.pk, b(40,64), 60n);
  let current = init.currentContractState;
  let counter = 0n;
  let now = 1_800_000_000;
  let caller: any = undefined;
  let restricted = false;
  async function call(name: string, args: any[], label = name) {
    const ctx = createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk, contractState: current, privateState: {}, time: now });
    ctx.callContext = createCallContext(name, addressHex, coinPk, current, {}, now, undefined, caller);
    ctx.queryContexts[addressHex] = ctx.callContext.currentQueryContext;
    const res = await (contract.provableCircuits as any)[name](ctx, ...args);
    const trace = res.context.callProofDataTrace;
    const data = trace[trace.length - 1];
    const fixture = {
      name, label: `${arm}-e${envelope}-${grantArm}-${label}`, address: [...address], time: now, caller: caller ?? null, restricted,
      expires_at: name.includes('_with_grant_') && envelope === 1n ? 1_800_000_060 : null,
      before: state(data.initialQueryContext.state), after: state(data.finalQueryContext.state),
      input: clean(data.input), output: clean(data.output),
      witnesses: clean(data.privateTranscriptOutputs),
    };
    const filename = `${String(seq++).padStart(3, '0')}-${label}.json`;
    writeFileSync(`${dir}/${filename}`, JSON.stringify(fixture));
    fixtureFiles.push(filename);
    current = res.context.callContext.currentQueryContext.state;
    return res.result;
  }
  async function device(op: string, args: any[], challengeArgs = args) {
    const challenge = (pure as any)[`challenge_${op}_with_${arm}`];
    const nonce = ledger(current).auth_nonce;
    const a = arm === 'jubjub'
      ? (owner as JubjubDevice).sign((r, grind) => challenge({ bytes: address }, r, owner.pk, ...challengeArgs, nonce, grind), counter)
      : arm === 'p256' ? await (owner as any).sign(challenge({ bytes: address }, owner.pk, ...challengeArgs, nonce), counter)
      : (owner as K256Device).sign(challenge({ bytes: address }, owner.pk, ...challengeArgs, nonce), counter);
    // The reference deliberately accepts both ECDSA S forms.
    if (a.arm === 'k256' && envelope === 1n && counter % 2n === 0n) a.sig.s = SECP256K1_N - a.sig.s;
    if (a.arm === 'p256') a.sig.s = counter % 2n === 0n ? (a.sig.s > P256_N / 2n ? a.sig.s : P256_N - a.sig.s) : (a.sig.s < P256_N / 2n ? a.sig.s : P256_N - a.sig.s);
    const selfSend = op === 'withdraw_shielded_to_contract' && Buffer.from(args[0].bytes).equals(Buffer.from(address));
    const result = await call(`${op}_with_${arm}`, [...args, ...(arm === 'p256' ? [a] : authArgs(a))], `${op}_with_${arm}${selfSend ? '-self' : ''}`);
    counter++;
    return result;
  }
  await call(`activate_initial_device_with_${arm}`, arm === 'jubjub' ? [owner.pk, salt] : arm === 'p256' ? [owner.pk, salt, (owner as any).policy] : [owner.pk, salt, envelope]);
  await call('deposit_unshielded', [color, 10000n], `${arm}-deposit-new`);
  await call('deposit_unshielded', [color, 100n], `${arm}-deposit-existing`);
  await call('deposit_shielded', [{ nonce: coin.nonce, color, value: coin.value }, b(19, 192)], `${arm}-deposit-shielded`);
  await device('append_inbox', [b(20, 192)]);
  await device('rotate_enc_key', [b(21)]);
  const other = arm === 'jubjub' ? new K256Device(29n) : new JubjubDevice(29n);
  const entry = other.entryAt(address, 0n, 0n);
  await device('add_device', [entry]);
  await device('remove_device', [entry]);
  await device('withdraw_unshielded', [color, 10n, recipient]);
  for (const amount of [100n, 1000n]) {
    for (const op of ['withdraw_shielded', 'withdraw_shielded_to_contract']) {
      if (op === 'withdraw_shielded_to_contract') {
        const self = { bytes: address };
        await device(op, [self, color, amount], [self, color, amount, coin]);
      }
      await device(op, [recipient, color, amount], [recipient, color, amount, coin]);
    }
  }
  for (const restrictCaller of [false, true]) {
  restricted = restrictCaller;
  caller = restrictCaller ? { tag: 'contract', address: Buffer.from(b(45)).toString('hex') } : undefined;
  const scopeSalt = b(30), origin = grantArm === 'p256' ? originHash(TEST_ORIGIN) : b(31), slot = 0n;
  const id = grantee.grantId(address, origin, slot);
  const scope = {
    opWithdrawUnshielded: true, opWithdrawShielded: true, opWithdrawShieldedToContract: true,
    read: true, color, recipientKind: 0n, recipient: b(0), maxCoinValue: 1000n,
    perCallCap: 1000n, cap: 10000n, expiresAt: envelope === 1n ? 1_800_000_060n : 0n, rpIdHash: grantArm === 'p256' ? (grantee as any).policy.rp_id_hash : b(0), readPkHash: b(32),
    windowLen: 0n, windowCap: 0n, caller: restrictCaller ? b(45) : undefined,
  };
  const scopeList = scopeArgs(scope);
  const digest = (pure as any).derive_grant_scope_digest(scopeSalt, ...scopeList);
  await device('issue_grant', [id, ...scopeList, scopeSalt], [id, digest]);
  let spent = 0n;
  for (const op of ['withdraw_unshielded', 'withdraw_shielded', 'withdraw_shielded_to_contract']) {
    const amounts = op === 'withdraw_unshielded' ? [10n] : [100n, 1000n];
    for (const amount of amounts) {
      for (const destination of op === 'withdraw_shielded_to_contract' ? [{ bytes: address }, recipient] : [recipient]) {
        const g = ledger(current).grants.lookup(id);
        const entry = b(33, 192), enc = b(21);
        const args = op === 'withdraw_unshielded' ? [color, amount, destination] : [destination, color, amount, entry, enc];
        const challengeArgs = [id, g.issued_at, ...args, ...(op === 'withdraw_unshielded' ? [] : [coin]), g.nonce];
        const challenge = (pure as any)[`challenge_${op}_with_grant_${grantArm}`];
        const a: any = grantArm === 'jubjub'
          ? (grantee as JubjubGrantee).sign((r, grind) => challenge({ bytes: address }, r, grantee.pk, ...challengeArgs, grind))
          : grantArm === 'p256' ? await (grantee as any).sign(challenge({ bytes: address }, grantee.pk, ...challengeArgs))
          : (grantee as K256Grantee).sign(challenge({ bytes: address }, grantee.pk, ...challengeArgs));
        if (grantArm === 'k256' && envelope === 1n) a.sig.s = SECP256K1_N - a.sig.s;
        if (a.arm === 'p256') a.sig.s = restrictCaller ? (a.sig.s > P256_N / 2n ? a.sig.s : P256_N - a.sig.s) : (a.sig.s < P256_N / 2n ? a.sig.s : P256_N - a.sig.s);
        const tail = grantArm === 'p256' ? [origin, slot, scopeSalt, 0n, b(0), 1000n, spent, a] : [grantee.pk, ...(grantArm === 'k256' ? [0n] : []), origin, slot, scopeSalt, 0n, b(0), 1000n, spent,
          ...(grantArm === 'jubjub' ? [a.sig_r, a.sig_s, a.grind_nonce] : [a.sig])];
        await call(`${op}_with_grant_${grantArm}`, [...args, ...tail], `${op}_with_grant_${grantArm}${destination.bytes === address ? '-self' : ''}`);
        spent += amount;
      }
    }
  }
  await device('revoke_grant', [id]);
  await device('revoke_all_grants', []);
  }
  restricted = false; caller = undefined;
  // Publish several vector lengths, including clearing a formerly used slot.
  for (const len of [1n,4n,2n]) {
    const next = new JubjubDevice(recovery.sk + 2n);
    await device('publish_recovery_session', [next.pk, b(Number(next.sk)), 11n, len >= 2n ? 12n : 0n, len >= 3n ? 13n : 0n, len >= 4n ? 14n : 0n, len, b(44,64)]);
    recovery = next;
  }
  const successor = new JubjubDevice(59n), successorRecovery = new JubjubDevice(61n);
  async function submit() {
    const l = ledger(current), upper = BigInt(now + 1);
    const r1 = 41n, r2 = 43n;
    const R1 = pure.compute_public_point_with_jubjub(r1), R2 = pure.compute_public_point_with_jubjub(r2);
    let grind = 0n, challenge: bigint;
    for (;;) {
      challenge = bytesToBigIntLE(pure.challenge_recover_submit({bytes:address}, recovery.pk, R1, successor.pk, R2, successorRecovery.pk, l.device_epoch+1n, l.auth_nonce, upper, grind));
      if (challenge < JUBJUB_R) break;
      grind++;
    }
    await call('recover_submit', [successor.pk, successorRecovery.pk, l.device_epoch, l.auth_nonce, upper,
      R1, (r1 + challenge * recovery.sk) % JUBJUB_R, R2, (r2 + challenge * successor.sk) % JUBJUB_R, grind]);
  }
  await submit();
  await device('recover_cancel', []);
  await submit();
  now += 61;
  await call('recover_finalise', []);
}
}
console.log(`Captured ${seq} synthetic reference executions in ${dir}`);

writeFileSync(`${dir}/index.json`, JSON.stringify(fixtureFiles));
