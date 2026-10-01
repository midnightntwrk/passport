import { pureCircuits } from './contract.js';
import {
  assertionMaterial, webauthnPolicy, validateP256Key,
  type AssertionProvider, type P256PublicKey, type WebAuthnPolicy,
} from './webauthn.js';
import type { CallContext, GrantContext } from './signer.js';
import type { JubjubPoint, QualifiedCoin } from './contract.js';

export interface P256GrantAuthorisation {
  arm: 'p256'; pk: P256PublicKey; policy: WebAuthnPolicy;
  authenticator_data: Uint8Array; sig: { r: bigint; s: bigint };
}
export interface P256Authorisation extends P256GrantAuthorisation { use_counter: bigint }

export class P256Grantee {
  readonly arm = 'p256' as const;
  readonly policy: WebAuthnPolicy;
  constructor(readonly pk: P256PublicKey, rpId: string, origin: string, private readonly assertion: AssertionProvider) {
    validateP256Key(pk);
    this.policy = webauthnPolicy(rpId, origin);
  }
  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    return pureCircuits.derive_grant_id_with_p256({ bytes: contractAddress }, this.pk, originHash, slot);
  }
  async sign(challenge: Uint8Array): Promise<P256GrantAuthorisation> {
    const expected = new Uint8Array(challenge);
    const assertion = await this.assertion(new Uint8Array(expected));
    return { arm: 'p256', ...assertionMaterial(expected, this.policy, this.pk, assertion) };
  }
}

export class P256Device {
  readonly arm = 'p256' as const;
  private readonly credential: P256Grantee;
  readonly policy: WebAuthnPolicy;
  constructor(readonly pk: P256PublicKey, rpId: string, origin: string, assertion: AssertionProvider) {
    this.credential = new P256Grantee(pk, rpId, origin, assertion);
    this.policy = this.credential.policy;
  }
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry_with_p256({ bytes: contractAddress }, this.pk, this.policy, epoch, counter);
  }
  bootCommitment(salt: Uint8Array): Uint8Array {
    return pureCircuits.derive_boot_commitment_with_p256(salt, this.pk, this.policy);
  }
  async sign(challenge: Uint8Array, useCounter: bigint): Promise<P256Authorisation> {
    return { ...await this.credential.sign(challenge), use_counter: useCounter };
  }
}

const addr = (c: CallContext | GrantContext) => ({ bytes: c.contractAddress });
export const p256Challenges = {
  withdrawUnshielded: (c: CallContext, pk: P256PublicKey, color: Uint8Array, amount: bigint, recipient: Uint8Array) =>
    pureCircuits.challenge_withdraw_unshielded_with_p256(addr(c), pk, color, amount, { bytes: recipient }, c.authNonce),
  withdrawShielded: (c: CallContext, pk: P256PublicKey, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin) =>
    pureCircuits.challenge_withdraw_shielded_with_p256(addr(c), pk, { bytes: recipient }, color, amount, coin, c.authNonce),
  withdrawShieldedToContract: (c: CallContext, pk: P256PublicKey, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin) =>
    pureCircuits.challenge_withdraw_shielded_to_contract_with_p256(addr(c), pk, { bytes: recipient }, color, amount, coin, c.authNonce),
  appendInbox: (c: CallContext, pk: P256PublicKey, entry: Uint8Array) =>
    pureCircuits.challenge_append_inbox_with_p256(addr(c), pk, entry, c.authNonce),
  rotateEncKey: (c: CallContext, pk: P256PublicKey, key: Uint8Array) =>
    pureCircuits.challenge_rotate_enc_key_with_p256(addr(c), pk, key, c.authNonce),
  addDevice: (c: CallContext, pk: P256PublicKey, entry: Uint8Array) =>
    pureCircuits.challenge_add_device_with_p256(addr(c), pk, entry, c.authNonce),
  removeDevice: (c: CallContext, pk: P256PublicKey, entry: Uint8Array) =>
    pureCircuits.challenge_remove_device_with_p256(addr(c), pk, entry, c.authNonce),
  issueGrant: (c: CallContext, pk: P256PublicKey, id: Uint8Array, digest: Uint8Array) =>
    pureCircuits.challenge_issue_grant_with_p256(addr(c), pk, id, digest, c.authNonce),
  revokeGrant: (c: CallContext, pk: P256PublicKey, id: Uint8Array) =>
    pureCircuits.challenge_revoke_grant_with_p256(addr(c), pk, id, c.authNonce),
  revokeAllGrants: (c: CallContext, pk: P256PublicKey) =>
    pureCircuits.challenge_revoke_all_grants_with_p256(addr(c), pk, c.authNonce),
  publishRecoverySession: (c: CallContext, pk: P256PublicKey, recoveryPk: JubjubPoint, session: Uint8Array,
    phi: readonly [bigint, bigint, bigint, bigint], phiLen: bigint, wrap: Uint8Array) =>
    pureCircuits.challenge_publish_recovery_session_with_p256(addr(c), pk, recoveryPk, session, ...phi, phiLen, wrap, c.authNonce),
  recoverCancel: (c: CallContext, pk: P256PublicKey) =>
    pureCircuits.challenge_recover_cancel_with_p256(addr(c), pk, c.authNonce),
};

export const p256GrantChallenges = {
  withdrawUnshielded: (g: GrantContext, pk: P256PublicKey, color: Uint8Array, amount: bigint, recipient: Uint8Array) =>
    pureCircuits.challenge_withdraw_unshielded_with_grant_p256(addr(g), pk, g.grantId, g.issuedAt,
      color, amount, { bytes: recipient }, g.grantNonce),
  withdrawShielded: (g: GrantContext, pk: P256PublicKey, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin) =>
    pureCircuits.challenge_withdraw_shielded_with_grant_p256(addr(g), pk, g.grantId, g.issuedAt,
      { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce),
  withdrawShieldedToContract: (g: GrantContext, pk: P256PublicKey, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin) =>
    pureCircuits.challenge_withdraw_shielded_to_contract_with_grant_p256(addr(g), pk, g.grantId, g.issuedAt,
      { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce),
};
