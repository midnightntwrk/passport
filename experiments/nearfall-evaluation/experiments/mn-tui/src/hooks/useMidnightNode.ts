import {useState, useEffect, useRef} from 'react';
import type {NodeState} from '../types.js';
import {logger} from '../logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a ws(s):// URL to http(s):// for JSON-RPC over HTTP POST. */
function toHttpUrl(url: string): string {
  return url.replace(/^wss?:\/\//, m => m === 'wss://' ? 'https://' : 'http://');
}

/** Send a single JSON-RPC 2.0 request and return the result. */
async function rpc<T>(httpUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(httpUrl, {
    method:  'POST',
    headers: {'Content-Type': 'application/json'},
    body:    JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {result?: T; error?: {message: string}};
  if (json.error) throw new Error(json.error.message);
  if (json.result === undefined) throw new Error(`No result for ${method}`);
  return json.result;
}

// ---------------------------------------------------------------------------
// Epoch / session constants
//
// Verify these against the target chain's runtime config:
//   SLOT_DURATION_MS   — ms per slot (Midnight: 6 000)
//   EPOCH_LENGTH_SLOTS — slots per Midnight epoch (300 = 30 min at 6 s/slot)
//
// Note: pallet_session::CurrentIndex increments every 600 slots (one Substrate
// session = two Midnight epochs), so epoch index is derived from slot arithmetic
// rather than the session storage key.
// ---------------------------------------------------------------------------

const SLOT_DURATION_MS   = 6_000;
const EPOCH_LENGTH_SLOTS = 300;

// ---------------------------------------------------------------------------
// AURA slot parsing
//
// DigestItem::PreRuntime is SCALE-encoded as:
//   variant(1) = 0x06
//   ConsensusEngineId(4) = "aura" = 0x61757261
//   Vec<u8> compact length: compact(8) = 0x20
//   slot: u64 little-endian (8 bytes)
//
// We read only the lower 6 bytes to stay within JS safe-integer range,
// which covers slots up to ~281 trillion — effectively infinite for our use.
// ---------------------------------------------------------------------------

function parseAuraSlot(logs: string[]): number {
  const AURA_PREFIX = '0661757261'; // variant 06 + "aura"
  for (const log of logs) {
    const hex = log.startsWith('0x') ? log.slice(2) : log;
    if (!hex.startsWith(AURA_PREFIX)) continue;
    // Skip 5-byte prefix (10 hex chars); next byte is compact(8) = '20'
    const afterPrefix = hex.slice(10);
    const slotHex = afterPrefix.startsWith('20') ? afterPrefix.slice(2) : afterPrefix;
    if (slotHex.length < 16) continue;
    // Parse 6 bytes little-endian (bytes 0–5)
    let slot = 0;
    for (let i = 5; i >= 0; i--) {
      slot = slot * 256 + parseInt(slotHex.slice(i * 2, i * 2 + 2), 16);
    }
    return slot;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// RPC response shapes
// ---------------------------------------------------------------------------

interface RpcHeader {
  number:  string;          // hex block number, e.g. "0x1a2b"
  digest:  {logs: string[]};
}

interface RpcSyncState {
  currentBlock: number;
  highestBlock: number;
}

interface RpcHealth {
  peers:     number;
  isSyncing: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY: NodeState = {
  blockHeight:  0,
  blockHash:    '—',
  currentSlot:  0,
  epochIndex:   0,
  msUntilEpoch: 0,
  synced:       false,
  peers:        0,
  rpcUrl:       '',
};

export function useMidnightNode(rpcUrl = 'ws://localhost:9944', intervalMs = 6_000, paused = false) {
  const [node,  setNode]  = useState<NodeState>({...EMPTY, rpcUrl});
  const [error, setError] = useState<string | null>(null);
  const lastHeightRef     = useRef<number>(-1);

  useEffect(() => {
    let cancelled = false;
    const httpUrl = toHttpUrl(rpcUrl);

    async function poll() {
      try {
        const [header, blockHash, syncState, health] = await Promise.all([
          rpc<RpcHeader>    (httpUrl, 'chain_getHeader',   []),
          rpc<string>       (httpUrl, 'chain_getBlockHash', []),
          rpc<RpcSyncState> (httpUrl, 'system_syncState',   []),
          rpc<RpcHealth>    (httpUrl, 'system_health',      []),
        ]);

        if (cancelled) return;

        const newHeight = parseInt(header.number, 16);
        if (newHeight === lastHeightRef.current) return; // block unchanged — skip re-render
        lastHeightRef.current = newHeight;

        const currentSlot  = parseAuraSlot(header.digest.logs);
        const epochIndex   = Math.floor(currentSlot / EPOCH_LENGTH_SLOTS);
        const slotInEpoch  = currentSlot % EPOCH_LENGTH_SLOTS;
        const msUntilEpoch = (EPOCH_LENGTH_SLOTS - slotInEpoch) * SLOT_DURATION_MS;

        setNode({
          rpcUrl,
          blockHeight: parseInt(header.number, 16),
          blockHash,
          currentSlot,
          epochIndex,
          msUntilEpoch,
          synced:  syncState.currentBlock >= syncState.highestBlock,
          peers:   health.peers,
        });
        setError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setError(msg);
          logger.error(`useMidnightNode [${rpcUrl}]: ${msg}`);
        }
      }
    }

    if (!paused) {
      poll();
      const id = setInterval(() => { if (!cancelled) poll(); }, intervalMs);
      return () => { cancelled = true; clearInterval(id); };
    }
    return () => { cancelled = true; };
  }, [rpcUrl, intervalMs, paused]);

  return {node, error};
}
