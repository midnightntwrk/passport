// Offline unit checks — no localnet required.
//
// Exercises the client-side halves of both standards against the compiled
// contract module: the §5 signing pipeline (grinding, scalar arithmetic,
// the Schnorr equation via the runtime's own curve built-ins), the
// InboxEntry v1 codec (§6.4), and the challenge domain separation (AUTH-3
// at the hash level). The rejection matrix proper runs against a node
// (auth-conformance.ts); this file guards the vacuous-verifier hazard
// (MIP-0013 S10) cheaply on every change.

import { randomBytes } from 'node:crypto';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { Device, challenges, JUBJUB_R, bytesToBigIntLE, type CallContext } from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry, ENTRY_SIZE } from '../wallet/inbox.js';
import { pureCircuits } from '../wallet/contract.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

// S10: JubjubPoint equality must be structural, never object identity.
const pointsEqual = (a: { x: bigint; y: bigint }, b: { x: bigint; y: bigint }) =>
  a.x === b.x && a.y === b.y;

await runScenario('unit-offline', async () => {
  step('device keys and rolling entries (MIP-0013 §1, §3, AUTH-9)');
  const device = Device.generate();
  assert(device.sk > 0n && device.sk < JUBJUB_R, 'sk in [1, r_J)');
  const accountAddr = new Uint8Array(randomBytes(32));
  const e0 = device.entryAt(accountAddr, 0n, 0n);
  assert(e0.length === 32, 'device entry is 32 bytes');
  assert(
    Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 0n))),
    'entry deterministic',
  );
  const other = Device.generate();
  assert(
    !Buffer.from(e0).equals(Buffer.from(other.entryAt(accountAddr, 0n, 0n))),
    'distinct keys give distinct entries',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 1n))),
    'the use counter rolls the entry (single-use, AUTH-9)',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 1n, 0n))),
    'an epoch bump invalidates every prior entry (AUTH-6)',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(new Uint8Array(randomBytes(32)), 0n, 0n))),
    'entries for one key are unequal across accounts',
  );

  step('signing pipeline: grinding and the Schnorr equation (§5)');
  const ctx: CallContext = { contractAddress: new Uint8Array(randomBytes(32)), authNonce: 0n };
  const color = new Uint8Array(32);
  const recipient = new Uint8Array(randomBytes(32));
  const builder = challenges.withdrawUnshielded(ctx, device.pk, color, 100n, recipient);
  const auth = device.sign(builder, 0n);
  const h = builder(auth.sig_r, auth.grind_nonce);
  const c = bytesToBigIntLE(h);
  assert(c < JUBJUB_R, 'ground challenge below r_J (§5.2)');
  assert(auth.sig_s < JUBJUB_R, 's in scalar domain');
  assert(
    Buffer.from(h).equals(Buffer.from(builder(auth.sig_r, auth.grind_nonce))),
    'challenge deterministic',
  );
  const lhs = ecMulGenerator(auth.sig_s);
  const rhs = ecAdd(auth.sig_r, ecMul(device.pk, c));
  assert(pointsEqual(lhs, rhs), 's·G == R + c·pk (the §4 equation, off-circuit)');
  assert(
    !pointsEqual(lhs, ecAdd(auth.sig_r, ecMul(other.pk, c))),
    'equation fails for a different pk (non-vacuous verifier, S10)',
  );
  const cBad = (c + 1n) % JUBJUB_R;
  assert(
    !pointsEqual(lhs, ecAdd(auth.sig_r, ecMul(device.pk, cBad))),
    'equation fails for a tampered challenge',
  );

  step('challenge domain separation (AUTH-3) and witness binding (AUTH-10)');
  const witnessCoin = { nonce: new Uint8Array(randomBytes(32)), color, value: 100n, mt_index: 7n };
  const shieldedBuilder = challenges.withdrawShielded(ctx, device.pk, recipient, color, 100n, witnessCoin);
  const toContractBuilder = challenges.withdrawShieldedToContract(ctx, device.pk, recipient, color, 100n, witnessCoin);
  assert(
    !Buffer.from(shieldedBuilder(auth.sig_r, auth.grind_nonce)).equals(
      Buffer.from(toContractBuilder(auth.sig_r, auth.grind_nonce)),
    ),
    'per-circuit tags separate identical argument lists',
  );
  const otherCoin = { ...witnessCoin, mt_index: 8n };
  assert(
    !Buffer.from(shieldedBuilder(auth.sig_r, auth.grind_nonce)).equals(
      Buffer.from(
        challenges.withdrawShielded(ctx, device.pk, recipient, color, 100n, otherCoin)(
          auth.sig_r,
          auth.grind_nonce,
        ),
      ),
    ),
    'the witness values pin the private state (AUTH-10): a different coin, a different challenge',
  );
  const otherAccount: CallContext = { ...ctx, contractAddress: new Uint8Array(randomBytes(32)) };
  assert(
    !Buffer.from(builder(auth.sig_r, auth.grind_nonce)).equals(
      Buffer.from(
        challenges.withdrawUnshielded(otherAccount, device.pk, color, 100n, recipient)(
          auth.sig_r,
          auth.grind_nonce,
        ),
      ),
    ),
    'account address separates challenges across accounts',
  );
  const laterNonce: CallContext = { ...ctx, authNonce: 1n };
  assert(
    !Buffer.from(builder(auth.sig_r, auth.grind_nonce)).equals(
      Buffer.from(
        challenges.withdrawUnshielded(laterNonce, device.pk, color, 100n, recipient)(
          auth.sig_r,
          auth.grind_nonce,
        ),
      ),
    ),
    'auth_nonce separates challenges across calls (AUTH-2)',
  );

  step('InboxEntry v1 codec (MIP-0012 §6.4)');
  const keys = generateEncKeyPair();
  const coin = {
    nonce: new Uint8Array(randomBytes(32)),
    color: new Uint8Array(randomBytes(32)),
    value: (1n << 100n) + 12345n,
  };
  const entry = sealInboxEntry(keys.publicKey, coin);
  assert(entry.length === ENTRY_SIZE, 'container is 192 bytes');
  assert(entry[0] === 0x01 && entry[1] === 0x01, 'version and suite bytes');
  assert(entry.subarray(142).every((b) => b === 0), 'padding zeroed');
  const opened = openInboxEntry(keys.secretKey, entry);
  assert(opened !== null, 'entry opens with the account secret');
  assert(opened!.value === coin.value, 'value roundtrips (u128 BE)');
  assert(Buffer.from(opened!.nonce).equals(Buffer.from(coin.nonce)), 'nonce roundtrips');
  assert(Buffer.from(opened!.color).equals(Buffer.from(coin.color)), 'color roundtrips');
  assert(openInboxEntry(generateEncKeyPair().secretKey, entry) === null, 'wrong key is skipped');
  const unknownVersion = new Uint8Array(entry);
  unknownVersion[0] = 0x02;
  assert(openInboxEntry(keys.secretKey, unknownVersion) === null, 'unknown version is skipped');
  const unknownSuite = new Uint8Array(entry);
  unknownSuite[1] = 0x02;
  assert(openInboxEntry(keys.secretKey, unknownSuite) === null, 'unknown suite is skipped');
  const tamperedAd = new Uint8Array(entry);
  tamperedAd[142] = 0xff; // padding is not covered by the AEAD; ciphertext is
  const tamperedCt = new Uint8Array(entry);
  tamperedCt[70] ^= 0x01;
  assert(openInboxEntry(keys.secretKey, tamperedCt) === null, 'tampered ciphertext is skipped');

  step('grinding statistics sanity (§5.2)');
  let attempts = 0;
  for (let i = 0; i < 20; i++) {
    const d = Device.generate();
    const b = challenges.appendInbox(ctx, d.pk, entry);
    const a = d.sign(b, 0n);
    attempts += Number(a.grind_nonce) + 1;
  }
  console.log(`  grinding: ${(attempts / 20).toFixed(1)} attempts/signature (expect ≈17.5)`);
});
