// Raw BIP-340 signatures over the ACC's 32-byte grant challenge.
// This signer has no device entry, bootstrap or recovery authorisation API.
import { schnorr } from '@noble/curves/secp256k1.js';
import { pureCircuits, type QualifiedCoin } from './contract.js';
import { randomSecp256k1Scalar, scalarToBytesBE, SECP256K1_N, type GrantContext } from './signer.js';

export interface Bip340GrantAuthorisation {
  arm: 'bip340';
  /** BIP-340 x-only, big-endian public key. */
  pk: Uint8Array;
  /** BIP-340 r || s, both big-endian. */
  sig: Uint8Array;
}

export class Bip340Grantee {
  readonly arm = 'bip340' as const;
  readonly pk: Uint8Array;

  constructor(readonly sk: bigint) {
    if (sk <= 0n || sk >= SECP256K1_N) throw new Error('BIP-340 secret scalar must be in [1, n)');
    this.pk = schnorr.getPublicKey(scalarToBytesBE(sk));
  }

  static generate(): Bip340Grantee {
    return new Bip340Grantee(randomSecp256k1Scalar());
  }

  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    return pureCircuits.derive_grant_id_with_bip340({ bytes: contractAddress }, this.pk, originHash, slot);
  }

  sign(challenge: Uint8Array): Bip340GrantAuthorisation {
    if (challenge.length !== 32) throw new Error('BIP-340 grant challenge must be 32 bytes');
    return { arm: 'bip340', pk: this.pk, sig: schnorr.sign(challenge, scalarToBytesBE(this.sk)) };
  }
}

const address = (g: GrantContext) => ({ bytes: g.contractAddress });

export const bip340GrantChallenges = {
  withdrawUnshielded: (
    g: GrantContext, pk: Uint8Array, color: Uint8Array, amount: bigint, recipient: Uint8Array,
  ): Uint8Array => pureCircuits.challenge_withdraw_unshielded_with_grant_bip340(
    address(g), pk, g.grantId, g.issuedAt, color, amount, { bytes: recipient }, g.grantNonce,
  ),

  withdrawShielded: (
    g: GrantContext, pk: Uint8Array, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
  ): Uint8Array => pureCircuits.challenge_withdraw_shielded_with_grant_bip340(
    address(g), pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce,
  ),

  withdrawShieldedToContract: (
    g: GrantContext, pk: Uint8Array, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
  ): Uint8Array => pureCircuits.challenge_withdraw_shielded_to_contract_with_grant_bip340(
    address(g), pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce,
  ),
};
