// EIP-712 domains other than the arm's fixed V1 domain, for negative tests.
// The arm's circuits compute the digest under the V1 domain only (the
// contract's modules/Eip712V1), so a signature over the same message under
// any of these domains must be refused:
//
//   per-account   EIP712Domain(string name,string version,address verifyingContract)
//                 with name "Midnight Passport Account", version "1" and
//                 verifyingContract the low 20 bytes of keccak256(account);
//   chain id      EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//                 with the V1 name, version and verifyingContract and a chain
//                 id, as a wallet's active network would carry it;
//   one field     the V1 domain with its name, its version or its
//                 verifyingContract changed.
//
// The digests are computed here from the EIP (the client codec's hashStruct
// for the message, keccak256 for the domain), independently of the
// contract's oracles.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { evmChecksumAddress } from '../wallet/descriptors.js';
import {
  hashStruct, eip712V1Domain, domainSeparator, EIP712_V1_DOMAIN_VERSION, EIP712_V1_VERIFYING_CONTRACT,
  type Eip712Domain, type Eip712TypedData,
} from '../wallet/evm-k256-codec.js';

const utf8 = (t: string) => new TextEncoder().encode(t);
const unhex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const word = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const addressWord = (a: string) => cat(new Uint8Array(12), unhex(a));

/** The name of the per-account domain. */
export const PER_ACCOUNT_DOMAIN_NAME = 'Midnight Passport Account';
/** The chain id of the chain-id domain (non-zero, fits a uint64). */
export const CHAIN_ID_DOMAIN_CHAIN_ID = 3791715944n;

/** The per-account domain of `account` (32 bytes). */
export const perAccountDomain = (account: Uint8Array): Eip712Domain => ({
  name: PER_ACCOUNT_DOMAIN_NAME, version: EIP712_V1_DOMAIN_VERSION, verifyingContract: evmChecksumAddress(keccak_256(account).subarray(12)),
});

/** hashStruct of the chain-id domain. */
export function chainIdDomainSeparator(chainId: bigint, d: Eip712Domain = eip712V1Domain()): Uint8Array {
  const type = keccak_256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  return keccak_256(cat(type, keccak_256(utf8(d.name)), keccak_256(utf8(d.version)), word(chainId), addressWord(d.verifyingContract)));
}

/** keccak256(0x19 0x01 || separator || hashStruct(message)) of `t`'s message
 *  under another separator. */
export function digestUnder(separator: Uint8Array, t: Eip712TypedData): Uint8Array {
  const { EIP712Domain: _domain, ...types } = t.types;
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), separator, hashStruct(t.primaryType, t.message, types)));
}

/** The domains a negative case signs under, with the digest of `t` for the
 *  account `account`. */
export interface ForeignDomain { name: string; digest: (t: Eip712TypedData, account: Uint8Array) => Uint8Array }
export const FOREIGN_DOMAINS: Record<'perAccount' | 'chainId' | 'name' | 'version' | 'verifyingContract', ForeignDomain> = {
  perAccount: { name: 'the per-account domain (name "Midnight Passport Account", verifyingContract from the account)',
    digest: (t, account) => digestUnder(domainSeparator(perAccountDomain(account)), t) },
  chainId: { name: `the V1 domain with a chainId (${CHAIN_ID_DOMAIN_CHAIN_ID})`,
    digest: (t) => digestUnder(chainIdDomainSeparator(CHAIN_ID_DOMAIN_CHAIN_ID), t) },
  name: { name: `the V1 domain named "${PER_ACCOUNT_DOMAIN_NAME}"`,
    digest: (t) => digestUnder(domainSeparator({ ...eip712V1Domain(), name: PER_ACCOUNT_DOMAIN_NAME }), t) },
  version: { name: 'the V1 domain with version "2"',
    digest: (t) => digestUnder(domainSeparator({ ...eip712V1Domain(), version: '2' }), t) },
  verifyingContract: { name: 'the V1 domain with the last byte of verifyingContract changed',
    digest: (t) => {
      const p = unhex(EIP712_V1_VERIFYING_CONTRACT); p[19] ^= 0x01;
      return digestUnder(domainSeparator({ ...eip712V1Domain(), verifyingContract: evmChecksumAddress(p) }), t);
    } },
};
