/**
 * The operator's and the watchdog's handle on {@link rollbackDustSnapshot}.
 *
 *   node dist/dust-rollback.mjs --check     # say what is wrong, write nothing
 *   node dist/dust-rollback.mjs             # repair the snapshot in place
 *
 * It exists as a separate entry point rather than a flag on the server because
 * the repair is only meaningful while the service is STOPPED: the running
 * process rewrites the snapshot every minute, so a repair applied under it
 * would be overwritten by the wedged state within sixty seconds. The external
 * watchdog therefore stops the unit, runs this, and starts it again — and an
 * operator can run `--check` at any time, because reading is safe.
 *
 * EXIT CODES, WHICH ARE AN INTERFACE
 * ----------------------------------
 *   0  repaired (or, under `--check`, a repair is available and was described)
 *   3  nothing to repair — the stored state is not wedged
 *   1  the snapshot could not be read, parsed, or written
 *
 * Three is separate from one on purpose. `deploy/passport-balancer-watchdog.sh`
 * falls back to moving the snapshot aside and cold-walking the chain — ninety
 * seconds of no service — and that is the right answer to a snapshot it could
 * not repair and the WRONG answer to a snapshot that needed no repair.
 */

import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NothingToRepair, rollbackDustSnapshot } from './dustRollback.js';

const DEFAULT_STATE_DIR = '/var/lib/passport-balancer';
const DEFAULT_NETWORK = 'stagenet';

const argument = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
};

const snapshotPath = (): string => {
  const explicit = argument('--path');
  if (explicit) return explicit;
  const stateDir = process.env.BALANCER_STATE_DIR ?? DEFAULT_STATE_DIR;
  const network = process.env.BALANCER_NETWORK ?? DEFAULT_NETWORK;
  return join(stateDir, `sync-snapshot-${network}.json`);
};

const specks = (value: bigint): string => `${value} Specks (${(Number(value) / 1e18).toFixed(3)}e18)`;

async function main(): Promise<number> {
  const check = process.argv.includes('--check');
  const path = snapshotPath();

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    console.error(
      `[dust-rollback] could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }

  let result;
  try {
    result = rollbackDustSnapshot(raw, Date.now());
  } catch (cause) {
    if (cause instanceof NothingToRepair) {
      console.log(`[dust-rollback] ${cause.message} — ${path}`);
      return 3;
    }
    console.error(
      `[dust-rollback] could not repair ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }

  const verdict =
    `${result.utxosBefore} → ${result.utxosAfter} spendable DUST UTxO(s), ${specks(result.balanceAfter)}` +
    `${result.savedAt ? `, from the snapshot saved at ${result.savedAt}` : ''}`;

  if (check) {
    console.log(`[dust-rollback] a repair IS available for ${path}: ${verdict}`);
    console.log('[dust-rollback] --check writes nothing; run without it, with the service stopped, to apply it');
    return 0;
  }

  /* Kept, not overwritten. A repair that turns out to have been the wrong
     diagnosis leaves the operator the exact bytes it was made from, and the
     forensics on 2026/09/02 were only possible because the wedged snapshot had
     been moved aside rather than deleted. */
  const backup = `${path}.pre-rollback-${Date.now()}`;
  try {
    await copyFile(path, backup);
  } catch (cause) {
    console.error(
      `[dust-rollback] could not keep a copy at ${backup}: ${cause instanceof Error ? cause.message : String(cause)} — refusing to rewrite`,
    );
    return 1;
  }

  /* Written to a temporary name and renamed, so a process killed mid-write
     leaves the ORIGINAL snapshot intact rather than half of a new one. The
     service treats an unparseable snapshot as a cold start, which would cost
     the ninety seconds this repair exists to save. */
  const temp = `${path}.rollback.tmp`;
  try {
    await writeFile(temp, result.snapshot, 'utf8');
    await rename(temp, path);
  } catch (cause) {
    console.error(
      `[dust-rollback] could not write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }

  console.log(`[dust-rollback] repaired ${path}: ${verdict}`);
  console.log(`[dust-rollback] the snapshot it was made from is at ${backup}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    console.error(`[dust-rollback] ${cause instanceof Error ? cause.stack : String(cause)}`);
    process.exitCode = 1;
  },
);
