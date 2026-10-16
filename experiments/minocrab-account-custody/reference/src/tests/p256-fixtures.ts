// Test-only software authenticator using Node/OpenSSL, independent of the
// Compact verifier and noble's P-256 implementation. Never a wallet signer.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { P256Device, P256Grantee } from '../wallet/signer-p256.js';
import { webauthnPolicy, type WebAuthnAssertion } from '../wallet/webauthn.js';

export const TEST_RP = 'localhost';
export const TEST_ORIGIN = 'http://localhost:8973';
export const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());

export function softwarePasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pk = {
    x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')),
    y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')), identity: false,
  };
  const policy = webauthnPolicy(TEST_RP, TEST_ORIGIN);
  const assertion = async (challenge: Uint8Array, overrides: Partial<WebAuthnAssertion> = {}): Promise<WebAuthnAssertion> => {
    const authenticatorData = overrides.authenticatorData ?? new Uint8Array([
      ...sha256(Buffer.from(TEST_RP)), 5, 0, 0, 0, 0,
    ]);
    // Build independently, not with the production adapter or Compact helper.
    const clientDataJSON = overrides.clientDataJSON ?? new Uint8Array(Buffer.from(
      `{"type":"webauthn.get","challenge":"${Buffer.from(challenge).toString('base64url')}","origin":"${TEST_ORIGIN}","crossOrigin":false}`,
    ));
    const message = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    return { authenticatorData, clientDataJSON,
      signature: overrides.signature ?? new Uint8Array(sign('sha256', message, privateKey)) };
  };
  return {
    pk, policy, assertion,
    device: new P256Device(pk, TEST_RP, TEST_ORIGIN, assertion),
    grantee: new P256Grantee(pk, TEST_RP, TEST_ORIGIN, assertion),
  };
}
