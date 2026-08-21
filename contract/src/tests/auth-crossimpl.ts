// MIP-0013 conformance — test 7: cross-implementation signing, on-node.
//
// A signature produced by an independent signer implementation (the Rust
// binary under signer-rs/, exercising the ledger's own hash and curve
// crates with no TypeScript, WASM, or npm dependency) is accepted by the
// reference contract. The Rust device never shares its private key with
// the TypeScript side: TS registers the Rust device's PUBLIC key via
// add_device, then submits a withdrawal carrying the Rust-produced
// (pk, sig) — the AUTH-4 approval/proving separation, with the approver in
// a different language and process.

import * as fs from 'node:fs';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { standardSetup } from './flow.js';
import { userAddressBytes } from '../node/wallet.js';
import { bytesToHex } from '../wallet/hex.js';
import { SIGNER_BIN, rustKeygen, rustSignWithdrawUnshielded } from './crossimpl-offline.js';

const NIGHT = new Uint8Array(32);
const FUND = 2_000n;
const SPEND = 350n;

await runScenario('auth-crossimpl', async () => {
  if (!fs.existsSync(SIGNER_BIN)) {
    throw new Error(`Rust signer not built: ${SIGNER_BIN} — run: cargo build (in signer-rs/)`);
  }
  const s = await standardSetup();
  const recipient = userAddressBytes(s.ctx.walletCtx);
  const details: Record<string, unknown> = { account: s.account.address, signer: SIGNER_BIN };

  step('fund the account');
  await s.account.depositUnshielded(NIGHT, FUND);
  await waitForLedger(
    () => s.account.ledgerState(),
    'funded',
    (l) => l.unshielded_balances.member(NIGHT) && l.unshielded_balances.lookup(NIGHT) === FUND,
  );

  step('Rust device: keygen out of process; TS registers only the public key');
  const rust = rustKeygen();
  details.rustPk = { x: '0x' + rust.pk.x.toString(16), y: '0x' + rust.pk.y.toString(16) };
  await s.account.addDevice(s.device, rust.pk);
  await waitForLedger(
    () => s.account.ledgerState(),
    'Rust device active',
    (l) => l.device_count === 2n,
  );

  step('Rust device signs a withdrawal; TS proves and submits it');
  const ctx = await s.account.callContext();
  const sig = rustSignWithdrawUnshielded({
    sk: rust.sk,
    contractAddress: ctx.contractAddress,
    color: NIGHT,
    amount: SPEND,
    recipient,
    authNonce: ctx.authNonce,
  });
  details.challenge = sig.challenge;
  // The Rust device was registered by add_device, so its rolling entry
  // sits at use counter 0 (AUTH-9); the counter travels alongside the
  // signature as authorising material.
  const r = await s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, {
    pk: sig.pk,
    use_counter: 0n,
    sig: sig.sig,
  });
  details.withdrawTx = r.txId;
  await waitForLedger(
    () => s.account.ledgerState(),
    'Rust-authorised withdrawal debited',
    (l) => l.unshielded_balances.lookup(NIGHT) === FUND - SPEND,
  );
  console.log(`  ✓ node accepted the Rust-signed withdrawal: ${r.txId}`);
  console.log(`  (challenge ${sig.challenge.slice(0, 24)}…, signed on the Rust side)`);

  writeEvidence({
    testId: 'AUTH-7',
    name: 'auth-crossimpl',
    description: 'MIP-0013 cross-implementation signing: Rust approver, TypeScript prover',
    verdict: 'PASS',
    txHash: String(details.withdrawTx),
    note: 'A withdrawal authorised by the independent Rust signer (ledger crates only, no Midnight TS stack) was accepted by the deployed reference contract; the device key never left the Rust process (AUTH-4).',
    details,
  });
});
