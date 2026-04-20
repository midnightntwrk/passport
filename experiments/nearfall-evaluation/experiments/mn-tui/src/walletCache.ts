import {readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, renameSync} from 'fs';
import {homedir} from 'os';
import {join}    from 'path';

// XDG-compliant cache directory: $XDG_CACHE_HOME/mn-tui or ~/.cache/mn-tui
export const CACHE_DIR = join(
  process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
  'mn-tui',
);

// ---------------------------------------------------------------------------
// One-time migration: move old flat layout (~/.cache/mn-tui/{network}/*.state)
// to the new sync-state sub-tree (~/.cache/mn-tui/sync-state/{network}/*.state).
// Safe to run multiple times — skipped if the destination already exists.
// ---------------------------------------------------------------------------
const KNOWN_NETWORKS = ['mainnet', 'preprod', 'preview', 'undeployed'];
for (const net of KNOWN_NETWORKS) {
  const oldDir = join(CACHE_DIR, net);
  const newDir = join(CACHE_DIR, 'sync-state', net);
  try {
    if (existsSync(oldDir) && !existsSync(newDir)) {
      mkdirSync(join(CACHE_DIR, 'sync-state'), {recursive: true});
      renameSync(oldDir, newDir);
    }
  } catch { /* non-fatal */ }
}

type WalletType = 'shielded' | 'unshielded' | 'dust';

function statePath(network: string, address: string, type: WalletType): string {
  return join(CACHE_DIR, 'sync-state', network, `${address}-${type}.state`);
}

/**
 * Load a previously serialised wallet state from disk.
 * Returns null on any error (file missing, unreadable, etc.).
 */
export function loadState(network: string, address: string, type: WalletType): string | null {
  try {
    return readFileSync(statePath(network, address, type), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Delete a single cached wallet state file.
 * Swallows errors (e.g. file already absent).
 */
export function deleteState(network: string, address: string, type: WalletType): void {
  try { unlinkSync(statePath(network, address, type)); } catch { }
}

/**
 * Delete all three cached state files for a wallet.
 * Useful for manual cache eviction (e.g. after a testnet genesis reset).
 */
export function clearWalletCache(network: string, address: string): void {
  for (const type of ['shielded', 'unshielded', 'dust'] as WalletType[]) {
    deleteState(network, address, type);
  }
}

/**
 * Persist a serialised wallet state to disk.
 * Creates the network subdirectory if needed; swallows all errors (non-fatal).
 */
export function saveState(network: string, address: string, type: WalletType, state: string): void {
  try {
    mkdirSync(join(CACHE_DIR, 'sync-state', network), {recursive: true});
    writeFileSync(statePath(network, address, type), state, 'utf8');
  } catch {
    // swallow — cache write failure is non-fatal
  }
}
