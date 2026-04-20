/**
 * TEMPORARY EXPERIMENT — stealth-wallet key derivation hypothesis
 *
 * Tests two hypotheses about whether ZswapSecretKeys.fromSeed can be used to
 * construct a wallet that automatically detects a ZSwap coin sent to a stealth
 * address P.
 *
 * Hypothesis A — sk-as-seed:
 *   fromSeed(sk_bytes) where sk = (k_spend + h) % JUBJUB_R
 *   Expected FALSE: fromSeed applies hash("midnight:csk" || seed), so the
 *   coin public key will be hash(sk_bytes)*G, not sk*G = P.
 *
 * Hypothesis B — shared-secret-as-seed:
 *   fromSeed(persistentHash(S)) where S = k_scan * R (the ECDH shared secret)
 *   If TRUE: both Bob (computing r*K_scan) and Alice (computing k_scan*R) arrive
 *   at the same 32-byte seed, so fromSeed gives the same coin public key on
 *   both sides — a complete, wallet-native stealth derivation with no scalar
 *   addition required.
 *
 * Prerequisites: deployment.json and ${name}.json must exist.
 * Run: npx tsx src/experiment-stealth-wallet.ts
 */

import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v7';
import { ecMul, ecMulGenerator, ecAdd, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';
import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { SingleNamed, CONFIG } from './utils.js';

const JUBJUB_R = BigInt('0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7');

function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Experiment: Stealth Wallet Key Derivation Hypotheses       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Load inputs ──────────────────────────────────────────────────────────

    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found.'); process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));

    const name = (await rl.question('Registered name (e.g. alice.midnight): ')).trim();
    const keysFile = `${name}.json`;
    if (!fs.existsSync(keysFile)) {
      console.error(`No keys file: ${keysFile}`); process.exit(1);
    }
    const stored = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
    const kScanSc  = BigInt(stored.kScanScalar);
    const kSpendSc = BigInt(stored.kSpendScalar);
    console.log('');

    // ── Read contract state ───────────────────────────────────────────────────

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    const kSpendPt  = ls.k_spend;
    const pendingR  = ls.pending_R;
    const pendingPx = ls.pending_P.x;
    const pendingPy = ls.pending_P.y;

    if (!ls.pending_amount || ls.pending_amount === 0n) {
      console.log('No pending output in contract — run send first.');
      return;
    }
    console.log(`Pending amount : ${ls.pending_amount} tDUST`);
    console.log(`pending_P.x    : 0x${pendingPx.toString(16)}`);
    console.log('');

    // ── Derive stealth values (same as scan.ts) ───────────────────────────────

    const S      = ecMul(pendingR, kScanSc);
    const hBytes = persistentHash(CompactTypeNativePoint, S);
    const h      = BigInt('0x' + Buffer.from(hBytes).toString('hex')) % JUBJUB_R;
    const hG     = ecMulGenerator(h);
    const P      = ecAdd(kSpendPt, hG);
    const sk     = (kSpendSc + h) % JUBJUB_R;

    console.log(`Derived stealth point P.x : 0x${P.x.toString(16)}`);
    console.log(`Matches pending_P?         : ${P.x === pendingPx && P.y === pendingPy}`);
    console.log('');

    // ── Hypothesis A: fromSeed(sk_bytes) ─────────────────────────────────────

    console.log('─── Hypothesis A: fromSeed(sk as bytes) ────────────────────────');
    console.log('');

    const skBytes   = bigintToBytes32(sk);
    const keysA     = ZswapSecretKeys.fromSeed(skBytes);
    const coinKeyA  = keysA.coinPublicKey;
    const P_hex     = P.x.toString(16).padStart(64, '0');

    console.log(`sk (hex)              : 0x${sk.toString(16)}`);
    console.log(`fromSeed coinPublicKey: ${coinKeyA}`);
    console.log(`P.x (expected prefix) : ${P_hex}`);
    console.log(`Hypothesis A TRUE?    : ${coinKeyA.includes(P_hex)}`);
    console.log('');
    console.log('(A TRUE means fromSeed(sk_bytes).coinPublicKey encodes P — wallet detects coin directly.)');
    console.log('');

    // ── Hypothesis B: fromSeed(persistentHash(S)) ────────────────────────────

    console.log('─── Hypothesis B: fromSeed(persistentHash(shared_secret)) ─────');
    console.log('');

    // stealthSeed = persistentHash(S) where S = k_scan * R
    // Bob computes the same via: persistentHash(r * K_scan) using CompactTypeNativePoint
    const stealthSeed = hBytes;  // already computed above: persistentHash(S)
    const keysB       = ZswapSecretKeys.fromSeed(stealthSeed);
    const coinKeyB    = keysB.coinPublicKey;
    const encKeyB     = keysB.encryptionPublicKey;

    console.log(`stealthSeed (hex)     : ${Buffer.from(stealthSeed).toString('hex')}`);
    console.log(`fromSeed coinPublicKey: ${coinKeyB}`);
    console.log(`fromSeed encPublicKey : ${encKeyB}`);
    console.log('');
    console.log('If Hypothesis B is TRUE, the coin public key above is the stealth');
    console.log('address P that Bob should target, and Alice can build a temporary');
    console.log('wallet from stealthSeed to detect and sweep the coin.');
    console.log('');
    console.log('Note: for B to be useful, BOTH sides must derive the same stealthSeed:');
    console.log('  Alice: persistentHash(k_scan_scalar * R)  [uses private k_scan]');
    console.log('  Bob:   persistentHash(r * K_scan)          [uses private r]');
    console.log('These are equal by ECDH: k_scan*r*G = r*k_scan*G.');

  } finally {
    rl.close();
  }
}

main().catch(console.error);
