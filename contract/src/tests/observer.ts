// Observer surfaces and the coin-artefact scanner (MIP-0012 testing 1 and
// 5). An observer can fetch raw transactions from the indexer and the
// contract's public state; the scanner looks for a coin's nonce bytes,
// color bytes, and value bytes (16-byte u128 windows, both endiannesses)
// in everything so fetched.

import { Buffer } from 'node:buffer';

import { indexerUrl } from '../wallet/capture.js';
import { bytesToHex } from '../wallet/hex.js';
import type { PlainCoin } from '../wallet/inbox.js';

/** Fetch every observer-readable representation of a transaction. */
export async function fetchTxArtefacts(
  txId: string,
): Promise<{ surfaces: Record<string, string>; probes: string[] }> {
  const probes: string[] = [];
  const surfaces: Record<string, string> = {};
  const fieldSets = [
    ['raw', '{ raw }'],
    ['contractActions', '{ contractActions { __typename ... on ContractCall { state } ... on ContractDeploy { state } } }'],
    ['identifiers', '{ identifiers }'],
  ] as const;
  for (const [name, selection] of fieldSets) {
    const query = `
      query($offset: TransactionOffset!) {
        transactions(offset: $offset) ${selection.replace('{', '{ id ')}
      }`.trim();
    try {
      const res = await fetch(indexerUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { offset: { identifier: txId.replace(/^0x/, '') } } }),
      });
      const body: any = await res.json();
      if (body?.errors?.length) {
        probes.push(`${name}: GraphQL error ${JSON.stringify(body.errors[0]?.message ?? '').slice(0, 120)}`);
        continue;
      }
      const t = (body?.data?.transactions ?? [])[0];
      if (!t) { probes.push(`${name}: no tx`); continue; }
      surfaces[name] = JSON.stringify(t);
      probes.push(`${name}: ok (${surfaces[name].length} chars)`);
    } catch (e: any) {
      probes.push(`${name}: fetch failed ${e?.message}`);
    }
  }
  return { surfaces, probes };
}

/** The contract's public state as one observer-visible hex string. */
export async function fetchContractStateHex(providers: any, address: string): Promise<string> {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (!state) return '';
  const data: any = state.data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('hex');
  if (typeof data?.serialize === 'function') return Buffer.from(data.serialize()).toString('hex');
  return Buffer.from(JSON.stringify(data)).toString('hex');
}

export interface Needles {
  label: string;
  nonceHex: string;
  colorHex: string;
  valueHexBE: string;
  valueHexLE: string;
}

export function needlesFor(label: string, coin: PlainCoin): Needles {
  const be = Buffer.alloc(16);
  let v = coin.value;
  for (let i = 15; i >= 0; i--) { be[i] = Number(v & 0xffn); v >>= 8n; }
  const le = Buffer.from(be).reverse();
  return {
    label,
    nonceHex: bytesToHex(coin.nonce),
    colorHex: bytesToHex(coin.color),
    valueHexBE: be.toString('hex'),
    valueHexLE: le.toString('hex'),
  };
}

export function scan(haystackHexOrJson: string, needles: Needles): Record<string, boolean> {
  const h = haystackHexOrJson.toLowerCase();
  return {
    nonce: h.includes(needles.nonceHex.toLowerCase()),
    color: h.includes(needles.colorHex.toLowerCase()),
    valueBE: h.includes(needles.valueHexBE.toLowerCase()),
    valueLE: h.includes(needles.valueHexLE.toLowerCase()),
  };
}

export function anyHit(hits: Record<string, boolean>): boolean {
  return Object.values(hits).some(Boolean);
}

/** Does any observer surface of `txIds` + the contract state leak `coin`? */
export async function auditSurfaces(
  providers: any,
  contractAddress: string,
  txIds: string[],
  needles: Needles,
): Promise<{ leaks: Record<string, Record<string, boolean>>; leaked: boolean; probes: string[] }> {
  const leaks: Record<string, Record<string, boolean>> = {};
  const probes: string[] = [];
  for (const txId of txIds) {
    const { surfaces, probes: p } = await fetchTxArtefacts(txId);
    probes.push(...p.map((x) => `${txId.slice(0, 10)}…: ${x}`));
    for (const [surface, content] of Object.entries(surfaces)) {
      leaks[`tx:${txId.slice(0, 10)}…:${surface}`] = scan(content, needles);
    }
  }
  const stateHex = await fetchContractStateHex(providers, contractAddress);
  leaks['contractState'] = scan(stateHex, needles);
  const leaked = Object.values(leaks).some(anyHit);
  return { leaks, leaked, probes };
}
