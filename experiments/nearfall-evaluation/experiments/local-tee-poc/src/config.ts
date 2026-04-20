import {existsSync, readFileSync, writeFileSync} from 'fs';
import {homedir}                                  from 'os';
import {join}                                     from 'path';
import type {NetworkName, NetworkConfig}           from './types.js';
import {DEFAULT_NETWORK_CONFIG, NETWORK_DEFAULTS}  from './types.js';

// Persisted config lives in ~/.local-tee-poc-config.json
const CONFIG_PATH = join(homedir(), '.local-tee-poc-config.json');

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  /** The network name that was active when the app was last closed. */
  lastNetwork:      NetworkName;
  /**
   * Per-network URL overrides.  When a network entry is present the stored
   * URLs are used instead of NETWORK_DEFAULTS so the user's custom servers
   * persist across sessions.
   */
  networkOverrides: Partial<Record<NetworkName, Partial<Omit<NetworkConfig, 'name'>>>>;
  /**
   * Last contract address used per network — so the app can reconnect to an
   * existing deployment without the user re-entering it.
   */
  contractAddresses: Partial<Record<NetworkName, string>>;
  /**
   * ASCII-armored OpenPGP ciphertext of the mnemonic (symmetric, gpg -c
   * compatible).  Absent when the user has not saved a mnemonic.
   * The plaintext is never written to disk; only this encrypted form is
   * persisted.  Decrypt with the user's passphrase on startup (Keys screen).
   */
  encryptedMnemonic?: string;
}

const DEFAULTS: PersistedConfig = {
  lastNetwork:       DEFAULT_NETWORK_CONFIG.name,
  networkOverrides:  {},
  contractAddresses: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildNetworkConfig(
  name:      NetworkName,
  overrides: Partial<Record<NetworkName, Partial<Omit<NetworkConfig, 'name'>>>> = {},
): NetworkConfig {
  return {name, ...NETWORK_DEFAULTS[name], ...(overrides[name] ?? {})};
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function loadConfig(): PersistedConfig {
  try {
    const raw    = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    let lastNetwork: NetworkName = DEFAULTS.lastNetwork;
    if (typeof parsed.lastNetwork === 'string') {
      lastNetwork = parsed.lastNetwork as NetworkName;
    }

    let networkOverrides: PersistedConfig['networkOverrides'] = {};
    if (parsed.networkOverrides && typeof parsed.networkOverrides === 'object') {
      networkOverrides = parsed.networkOverrides as PersistedConfig['networkOverrides'];
    }

    let contractAddresses: PersistedConfig['contractAddresses'] = {};
    if (parsed.contractAddresses && typeof parsed.contractAddresses === 'object') {
      contractAddresses = parsed.contractAddresses as PersistedConfig['contractAddresses'];
    }

    const encryptedMnemonic = typeof parsed.encryptedMnemonic === 'string'
      ? parsed.encryptedMnemonic : undefined;

    return {lastNetwork, networkOverrides, contractAddresses, encryptedMnemonic};
  } catch {
    return {...DEFAULTS};
  }
}

export function configFileExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function saveConfig(cfg: PersistedConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    // swallow — non-fatal
  }
}
