// Wallet-local qualified coin descriptions enter the circuit only through
// held_coin. The store is JSON-safe; coin identity excludes the mutable
// Merkle-tree position used to qualify a particular spend.
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, QualifiedCoin } from './contract.js';
import { hexToBytes, bytesToHex } from './hex.js';

export interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string;
  mtIndex: string;
}
export interface CoinIdentity { nonce: Uint8Array; color: Uint8Array; value: bigint }
export interface CoinStorePrivateState {
  encSecretKeyHex: string | null;
  /** Absent in the legacy colour-keyed store. */
  version?: 2;
  /** Stable coin identity -> live qualified description in version 2. */
  coins: Record<string, StoredCoin>;
  coinsByColour?: Record<string, string[]>;
  /** Local spend knowledge, not a chain-validated nullifier index. */
  spentCoins?: Record<string, true>;
  /** Transient exact input pinned by a single guarded account operation. */
  selectedCoin?: StoredCoin;
}
export interface MultiCoinStore extends CoinStorePrivateState {
  version: 2;
  coinsByColour: Record<string, string[]>;
  spentCoins: Record<string, true>;
}

function canonical(stored: StoredCoin): StoredCoin {
  const hex = (value: string, name: string) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`invalid coin ${name}`);
    return value.toLowerCase();
  };
  const uint = (value: string, bits: bigint, name: string) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`invalid coin ${name}`);
    const n = BigInt(value);
    if (n >= (1n << bits)) throw new Error(`coin ${name} is out of range`);
    return n.toString();
  };
  return { nonceHex: hex(stored.nonceHex, 'nonce'), colorHex: hex(stored.colorHex, 'colour'),
    value: uint(stored.value, 128n, 'value'), mtIndex: uint(stored.mtIndex, 64n, 'mt_index') };
}
function storedId(coin: StoredCoin): string { return `${coin.nonceHex}:${coin.colorHex}:${coin.value}`; }
function storedCoin(coin: QualifiedCoin): StoredCoin {
  return canonical({ nonceHex: bytesToHex(coin.nonce), colorHex: bytesToHex(coin.color),
    value: coin.value.toString(), mtIndex: coin.mt_index.toString() });
}
function qualified(coin: StoredCoin): QualifiedCoin {
  return { nonce: hexToBytes(coin.nonceHex), color: hexToBytes(coin.colorHex),
    value: BigInt(coin.value), mt_index: BigInt(coin.mtIndex) };
}
export function coinId(coin: CoinIdentity): string {
  return storedId(storedCoin({ ...coin, mt_index: 0n }));
}

/** Lossless migration of every retained legacy description. Stale transient
 * selections are deliberately discarded when a new operation begins. */
export function migrateCoinStore(state: CoinStorePrivateState): MultiCoinStore {
  if (state.version !== undefined && state.version !== 2) throw new Error('unsupported coin store version');
  const coins: Record<string, StoredCoin> = {};
  const spentCoins = { ...(state.spentCoins ?? {}) };
  for (const [id, spent] of Object.entries(spentCoins)) {
    if (spent !== true || !/^[0-9a-f]{64}:[0-9a-f]{64}:(0|[1-9]\d*)$/.test(id)
      || BigInt(id.split(':')[2]) >= (1n << 128n)) throw new Error('invalid spent coin identity');
  }
  for (const [key, record] of Object.entries(state.coins)) {
    const coin = canonical(record), id = storedId(coin);
    if (state.version === 2 && key !== id) throw new Error('coin identity does not match its stored description');
    if (state.version === undefined && key.toLowerCase() !== coin.colorHex) throw new Error('legacy coin colour does not match its key');
    if (!spentCoins[id]) coins[id] = coin;
  }
  const coinsByColour: Record<string, string[]> = {};
  for (const id of Object.keys(coins).sort()) (coinsByColour[coins[id].colorHex] ??= []).push(id);
  const { selectedCoin: _selection, ...rest } = state;
  return { ...rest, version: 2, coins, coinsByColour, spentCoins };
}
export function emptyCoinStore(encSecretKey?: Uint8Array): MultiCoinStore {
  return { version: 2, encSecretKeyHex: encSecretKey ? bytesToHex(encSecretKey) : null,
    coins: {}, coinsByColour: {}, spentCoins: {} };
}
export function withCoin(state: CoinStorePrivateState,
  coin: CoinIdentity & { mtIndex: bigint }): MultiCoinStore {
  const next = migrateCoinStore(state), stored = storedCoin({ ...coin, mt_index: coin.mtIndex });
  const id = storedId(stored);
  // Repeated inbox recovery cannot resurrect an input already spent locally.
  if (!next.spentCoins[id]) next.coins[id] = stored;
  return migrateCoinStore(next);
}
export function withoutCoin(state: CoinStorePrivateState, coin: CoinIdentity | string): MultiCoinStore {
  const next = migrateCoinStore(state), id = typeof coin === 'string' ? coin : coinId(coin);
  if (!next.coins[id] && !next.spentCoins[id]) throw new Error('cannot remove an unknown coin identity');
  delete next.coins[id];
  next.spentCoins[id] = true;
  return migrateCoinStore(next);
}
export function coinsForColour(state: CoinStorePrivateState, color: Uint8Array): QualifiedCoin[] {
  const next = migrateCoinStore(state);
  return (next.coinsByColour[bytesToHex(color)] ?? []).map(id => qualified(next.coins[id]));
}
export function selectCoin(state: CoinStorePrivateState, color: Uint8Array, id?: string): QualifiedCoin {
  const next = migrateCoinStore(state), colour = bytesToHex(color);
  const ids = next.coinsByColour[colour] ?? [];
  if (id === undefined && ids.length > 1) throw new Error('multiple held coins for colour; specify a coinId');
  const selected = id ?? ids[0];
  if (!selected || !ids.includes(selected)) throw new Error(`no held coin for colour ${colour} with that identity`);
  return qualified(next.coins[selected]);
}
export function withSelectedCoin(state: CoinStorePrivateState, coin: QualifiedCoin): MultiCoinStore {
  const next = migrateCoinStore(state), selected = storedCoin(coin);
  const actual = next.coins[storedId(selected)];
  if (!actual || actual.mtIndex !== selected.mtIndex) throw new Error('selected coin changed or is no longer live');
  return { ...next, selectedCoin: selected };
}

export function makeWitnesses() {
  return {
    held_coin(ctx: WitnessContext<Ledger, CoinStorePrivateState>, color: Uint8Array): [CoinStorePrivateState, QualifiedCoin] {
      const pin = ctx.privateState.selectedCoin;
      const coin = pin ? qualified(canonical(pin)) : selectCoin(ctx.privateState, color);
      if (bytesToHex(coin.color) !== bytesToHex(color)) throw new Error('selected coin colour mismatch');
      // Recheck the full qualified snapshot, including its mutable mt_index.
      const checked = withSelectedCoin(ctx.privateState, coin);
      return [withoutCoin(checked, coin), coin];
    },
  };
}
