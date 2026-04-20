import {existsSync, readFileSync, writeFileSync} from 'fs';
import {homedir}                     from 'os';
import {join}                        from 'path';
import type {NetworkName, NetworkConfig} from './types.js';
import {DEFAULT_NETWORK_CONFIG, NETWORK_DEFAULTS} from './types.js';

// Persisted config lives in ~/.mn-tui-config.json
const CONFIG_PATH = join(homedir(), '.mn-tui-config.json');

// ---------------------------------------------------------------------------
// Wallet persistence
//
// Addresses are stored per-network-name because the Bech32 encoding includes
// the network ID.  Entries are populated lazily: the first time a wallet is
// used on a given network its addresses are derived from the mnemonic and
// stored.  encryptedMnemonic holds the ASCII-armored OpenPGP ciphertext (gpg
// -c --armor compatible) so addresses can be re-derived on a new network
// after the passphrase is entered.
// ---------------------------------------------------------------------------

export interface WalletAddresses {
  unshielded: string;
  shielded:   string;
  dust:       string;
}

export interface PersistedWallet {
  name:               string;
  /** Bech32 addresses keyed by network name — populated lazily. */
  addresses:          Partial<Record<NetworkName, WalletAddresses>>;
  /** ASCII-armored OpenPGP ciphertext of the mnemonic (symmetric, gpg -c). */
  encryptedMnemonic?: string;
}

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  /** The network name that was active when the app was last closed. */
  lastNetwork:      NetworkName;
  /**
   * Per-network URL overrides.  When a network entry is present the stored
   * URLs are used instead of NETWORK_DEFAULTS so the user's custom servers
   * persist across sessions.  Populated lazily when the user explicitly
   * saves a network configuration.
   */
  networkOverrides: Partial<Record<NetworkName, Partial<Omit<NetworkConfig, 'name'>>>>;
  wallets:          PersistedWallet[];
  activeWallet:     number;
}

const DEFAULTS: PersistedConfig = {
  lastNetwork:      DEFAULT_NETWORK_CONFIG.name,
  networkOverrides: {},
  wallets:          [],
  activeWallet:     0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a full NetworkConfig by merging NETWORK_DEFAULTS with any stored
 * per-network overrides.
 */
export function buildNetworkConfig(
  name:      NetworkName,
  overrides: Partial<Record<NetworkName, Partial<Omit<NetworkConfig, 'name'>>>> = {},
): NetworkConfig {
  return {name, ...NETWORK_DEFAULTS[name], ...(overrides[name] ?? {})};
}

// ---------------------------------------------------------------------------
// Validation / migration
// ---------------------------------------------------------------------------

/** Accept both the new (addresses map) and old (flat string) wallet shapes. */
function isValidWallet(w: unknown): w is Record<string, unknown> {
  if (!w || typeof w !== 'object') return false;
  const obj = w as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  // New format: addresses object
  if (obj.addresses && typeof obj.addresses === 'object') return true;
  // Old flat format: at least unshielded must be a string
  if (typeof obj.unshielded === 'string') return true;
  return false;
}

/**
 * Normalise a raw wallet entry to PersistedWallet.
 * If the entry uses the old flat-address format, the three address fields are
 * migrated into the addresses map under `migrateToNetwork`.
 */
function normaliseWallet(
  raw:               Record<string, unknown>,
  migrateToNetwork:  NetworkName,
): PersistedWallet {
  const name              = String(raw.name ?? '');
  const encryptedMnemonic = typeof raw.encryptedMnemonic === 'string'
    ? raw.encryptedMnemonic : undefined;

  // Already in new format
  if (raw.addresses && typeof raw.addresses === 'object') {
    return {name, addresses: raw.addresses as PersistedWallet['addresses'], encryptedMnemonic};
  }

  // Old flat format — migrate under the last-used network name
  return {
    name,
    addresses: {
      [migrateToNetwork]: {
        unshielded: String(raw.unshielded ?? ''),
        shielded:   String(raw.shielded   ?? ''),
        dust:       String(raw.dust        ?? ''),
      },
    },
    encryptedMnemonic,
  };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function loadConfig(): PersistedConfig {
  try {
    const raw    = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // ── lastNetwork ──────────────────────────────────────────────────────────
    let lastNetwork: NetworkName = DEFAULTS.lastNetwork;
    if (typeof parsed.lastNetwork === 'string') {
      lastNetwork = parsed.lastNetwork as NetworkName;
    } else if (parsed.network && typeof (parsed.network as Record<string, unknown>).name === 'string') {
      // Migrate from old format where the full NetworkConfig was stored.
      lastNetwork = (parsed.network as NetworkConfig).name;
    }

    // ── networkOverrides ─────────────────────────────────────────────────────
    let networkOverrides: PersistedConfig['networkOverrides'] = {};
    if (parsed.networkOverrides && typeof parsed.networkOverrides === 'object') {
      networkOverrides = parsed.networkOverrides as PersistedConfig['networkOverrides'];
    } else if (parsed.network && typeof (parsed.network as Record<string, unknown>).name === 'string') {
      // Migrate: store the old flat NetworkConfig as an override for its network.
      const net = parsed.network as NetworkConfig;
      networkOverrides = {
        [net.name]: {
          nodeUrl:        net.nodeUrl,
          indexerUrl:     net.indexerUrl,
          proofServerUrl: net.proofServerUrl,
        },
      };
    }

    // ── wallets ──────────────────────────────────────────────────────────────
    const rawWallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
    const wallets = rawWallets
      .filter(isValidWallet)
      .map(w => normaliseWallet(w, lastNetwork));

    // ── activeWallet ─────────────────────────────────────────────────────────
    let activeWallet = typeof parsed.activeWallet === 'number' ? parsed.activeWallet : 0;
    if (wallets.length === 0) activeWallet = 0;
    else activeWallet = Math.min(activeWallet, wallets.length - 1);

    return {lastNetwork, networkOverrides, wallets, activeWallet};
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
