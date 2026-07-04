// Shared plumbing for the CLI demo scripts (C14 BUSS recovery demo).
//
// Terminal-only: identities are JSON files in the experiment root so the
// demo survives across invocations. Secrets in plaintext files are demo
// scaffolding, not a custody design.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { bytesToHex, hexToBytes, randomBytes32 } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

export const OWNER_IDENTITY_FILE = path.join(ROOT, 'owner-identity.json');
export const GUARDIAN_IDENTITY_FILE = path.join(ROOT, 'guardian-identity.json');

/** Load WALLET_SEED and friends from infra/.env when not already exported. */
export function loadEnv(): void {
  if (process.env.WALLET_SEED) return;
  const envFile = path.join(ROOT, 'infra', '.env');
  if (!fs.existsSync(envFile)) {
    throw new Error('WALLET_SEED not set and infra/.env not found — run ./run-all.sh once first');
  }
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  process.env.MIDNIGHT_NETWORK ??= 'local';
}

export interface OwnerIdentity {
  address: string;
  deviceSecretHex: string;
}

export function saveOwnerIdentity(identity: OwnerIdentity): void {
  fs.writeFileSync(OWNER_IDENTITY_FILE, JSON.stringify(identity, null, 2));
}

export function loadOwnerIdentity(): OwnerIdentity {
  if (!fs.existsSync(OWNER_IDENTITY_FILE)) {
    throw new Error(`no ${OWNER_IDENTITY_FILE} — run demo:onboard first`);
  }
  return JSON.parse(fs.readFileSync(OWNER_IDENTITY_FILE, 'utf-8'));
}

/** The guardian passport's identity: just its own device secret. Created on
 *  first use — the guardian never stores anything else for anyone. */
export function loadOrCreateGuardianDeviceSecret(): Uint8Array {
  if (fs.existsSync(GUARDIAN_IDENTITY_FILE)) {
    const { deviceSecretHex } = JSON.parse(fs.readFileSync(GUARDIAN_IDENTITY_FILE, 'utf-8'));
    return hexToBytes(deviceSecretHex);
  }
  const secret = randomBytes32();
  fs.writeFileSync(
    GUARDIAN_IDENTITY_FILE,
    JSON.stringify({ deviceSecretHex: bytesToHex(secret) }, null, 2),
  );
  console.log(`(new guardian passport identity created in ${GUARDIAN_IDENTITY_FILE})`);
  return secret;
}

export async function withPrompt<T>(
  fn: (ask: (q: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn((q) => rl.question(q));
  } finally {
    rl.close();
  }
}

export function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function done(code = 0): void {
  setTimeout(() => process.exit(code), 100).unref();
}
