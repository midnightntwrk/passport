// Reference signed-bootstrap client. Hashes use the generated Compact types;
// private signing material never enters the activation argument tuple.
import { jubjub } from '@noble/curves/misc.js';
import { pureCircuits, type JubjubPoint } from './contract.js';
import {
  assertionMaterial, equalBytes, validateP256Key, webauthnPolicy,
  type AssertionProvider, type P256PublicKey, type WebAuthnAssertion, type WebAuthnPolicy,
} from './webauthn.js';
import { bytesToHex, hexToBytes } from './hex.js';
import type { WaveDeploymentCheckpoint } from './wave-deploy.js';

const ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const MAX_U64 = (1n << 64n) - 1n;
const le = (bytes: Uint8Array): bigint => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const copyPolicy = (p: WebAuthnPolicy): WebAuthnPolicy => ({ rp_id_hash: new Uint8Array(p.rp_id_hash), origin: new Uint8Array(p.origin) });
const copyPoint = (p: JubjubPoint): JubjubPoint => ({ x: p.x, y: p.y });
const copyP256 = (p: P256PublicKey): P256PublicKey => ({ x: p.x, y: p.y, identity: p.identity });
const approving = new WeakSet<SignedBootstrapRecord>();
function bytes(value: Uint8Array, size: number, name: string): void {
  if (!(value instanceof Uint8Array) || value.length !== size) throw new Error(`${name} must contain ${size} bytes`);
}
function uint64(n: bigint, name: string): void {
  if (typeof n !== 'bigint' || n < 0n || n > MAX_U64) throw new Error(`${name} is outside Uint64`);
}
function point(p: JubjubPoint) {
  if (typeof p?.x !== 'bigint' || typeof p?.y !== 'bigint' ||
      p.x < 0n || p.y < 0n || p.x >= jubjub.Point.Fp.ORDER || p.y >= jubjub.Point.Fp.ORDER) {
    throw new Error('noncanonical temporary Jubjub point');
  }
  const result = jubjub.Point.fromAffine(p);
  result.assertValidity();
  if (result.is0() || !result.isTorsionFree()) throw new Error('temporary Jubjub point must be nonidentity prime subgroup');
  return result;
}
function scalar(): bigint {
  for (;;) {
    const n = le(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    if (n > 0n && n < ORDER) return n;
  }
}

export interface BootstrapNetworkConfig {
  caip2Id: string;
  genesisHash: Uint8Array;
  /** A fixed configured checkpoint; use 0 and genesisHash for the default. */
  anchorHeight: bigint;
  anchorHash: Uint8Array;
}

/** Bounded reference RP policy: require the exact origin hostname instead of
 * parent-domain RP IDs, which need public-suffix-list validation. The generic
 * WebAuthn adapter remains available for separately validated legacy policies.
 * Origins must be HTTPS or http://localhost (the supported loopback origin),
 * canonical ASCII and exactly 21 bytes for the current circuit profile. */
export function signedBootstrapPolicy(rpId: string, origin: string): WebAuthnPolicy {
  const policy = webauthnPolicy(rpId, origin);
  if (rpId !== new URL(origin).hostname) throw new Error('signed bootstrap requires the exact origin hostname as RP ID; parent-domain RP IDs are unsupported');
  if (typeof isSecureContext === 'boolean' && !isSecureContext) throw new Error('signed bootstrap requires a secure browser context');
  if (typeof location !== 'undefined' && location.origin !== origin) throw new Error('signed bootstrap registration origin mismatch');
  return policy;
}

export function deriveBootstrapNetwork(config: BootstrapNetworkConfig): Uint8Array {
  // MIP-0008 uses the lowercase Midnight namespace and CAIP-2 reference.
  if (!/^midnight:[a-z0-9_-]{1,32}$/.test(config.caip2Id)) throw new Error('invalid canonical lowercase Midnight CAIP-2 identifier');
  bytes(config.genesisHash, 32, 'genesis hash');
  bytes(config.anchorHash, 32, 'anchor hash');
  if (config.genesisHash.every(b => b === 0) || config.anchorHash.every(b => b === 0)) throw new Error('genesis/checkpoint hash cannot be all zero');
  uint64(config.anchorHeight, 'anchor height');
  if (config.anchorHeight === 0n && !equalBytes(config.genesisHash, config.anchorHash)) throw new Error('height-zero anchor must equal genesis');
  const id = new TextEncoder().encode(config.caip2Id), padded = new Uint8Array(41);
  padded.set(id);
  return pureCircuits.derive_bootstrap_network(BigInt(id.length), padded, config.genesisHash, config.anchorHeight, config.anchorHash);
}

/** observed must come from the caller's trusted chain adapter, including the
 * configured checkpoint. A sealed hash alone cannot identify a physical chain. */
export function assertBootstrapNetwork(expected: BootstrapNetworkConfig, observed: BootstrapNetworkConfig): Uint8Array {
  const network = deriveBootstrapNetwork(expected);
  if (!equalBytes(network, deriveBootstrapNetwork(observed))) throw new Error('bootstrap chain/configuration mismatch');
  return network;
}

/** Separate from device, recovery and maintenance signers. Store an exported
 * scalar only in protected local storage, never in a record/prover request. */
export class TemporaryBootstrapKey {
  #secret: bigint | undefined;
  readonly #Q: JubjubPoint;
  constructor(secret: bigint) {
    if (typeof secret !== 'bigint' || secret <= 0n || secret >= ORDER) throw new Error('invalid temporary signing scalar');
    this.#secret = secret;
    this.#Q = pureCircuits.compute_public_point_with_jubjub(secret);
  }
  get Q(): JubjubPoint { return copyPoint(this.#Q); }
  static generate(): TemporaryBootstrapKey { return new TemporaryBootstrapKey(scalar()); }
  exportSecret(): bigint {
    if (this.#secret === undefined) throw new Error('temporary key has been erased');
    return this.#secret;
  }
  /** Best-effort removal of the JS reference; callers must also erase storage. */
  erase(): void { this.#secret = undefined; }

  approve(intent: Uint8Array, pk: P256PublicKey, policy: WebAuthnPolicy, assertion: WebAuthnAssertion) {
    // This MUST happen before even sampling the temporary signing nonce.
    const material = assertionMaterial(pureCircuits.challenge_signed_boot_passkey(intent), policy, pk, assertion);
    const secret = this.exportSecret(), r = scalar();
    const R = pureCircuits.compute_public_point_with_jubjub(r);
    for (let grind_nonce = 0n; grind_nonce <= MAX_U64; grind_nonce++) {
      const c = le(pureCircuits.challenge_signed_boot_jubjub(R, this.Q, intent, grind_nonce));
      if (c < ORDER) return { R, s: (r + c * secret) % ORDER, grind_nonce, material };
    }
    throw new Error('temporary signature grinding counter exhausted');
  }
}

export interface BootstrapCredential { credentialId: Uint8Array; pk: P256PublicKey }
export interface RetainedSignedBootstrapApproval {
  intent: Uint8Array;
  network: Uint8Array;
  address: Uint8Array;
  boot: Uint8Array;
  Q: JubjubPoint;
  pk: P256PublicKey;
  policy: WebAuthnPolicy;
  R: JubjubPoint;
  s: bigint;
  grind_nonce: bigint;
  assertion: WebAuthnAssertion;
}
export interface SignedBootstrapRecord {
  version: 1;
  network: Uint8Array;
  address: Uint8Array;
  boot: Uint8Array;
  Q: JubjubPoint;
  policy: WebAuthnPolicy;
  credential?: BootstrapCredential;
  approval?: RetainedSignedBootstrapApproval;
  /** Retain before waiting for finality when the transaction adapter provides it. */
  transactionId?: string;
  retired?: boolean;
  /** Public deployment identity; the maintenance key stays in protected storage. */
  deployment?: WaveDeploymentCheckpoint;
}

export function createSignedBootstrapRecord(network: Uint8Array, address: Uint8Array, boot: Uint8Array,
  Q: JubjubPoint, policy: WebAuthnPolicy): SignedBootstrapRecord {
  bytes(network, 32, 'network'); bytes(address, 32, 'account address'); bytes(boot, 32, 'boot');
  bytes(policy.rp_id_hash, 32, 'RP hash'); bytes(policy.origin, 21, 'origin'); point(Q);
  if (network.every(b => b === 0) || boot.every(b => b === 0)) throw new Error('signed bootstrap requires nonzero network and boot');
  if (!equalBytes(pureCircuits.derive_signed_boot_commitment(network, Q, policy), boot)) throw new Error('bootstrap commitment mismatch');
  return { version: 1, network: new Uint8Array(network), address: new Uint8Array(address), boot: new Uint8Array(boot), Q: copyPoint(Q), policy: copyPolicy(policy) };
}

/** Check before calling an authenticator, including a different authenticator.
 * excludeCredentials is only a second, authenticator-local safeguard. */
export function assertBootstrapRegistrationAllowed(record: SignedBootstrapRecord): void {
  if (record.retired || record.credential || record.approval) throw new Error('bootstrap credential already retained or onboarding retired; resume instead of registering again');
}
export function retainBootstrapCredential(record: SignedBootstrapRecord, credential: BootstrapCredential): void {
  assertBootstrapRegistrationAllowed(record);
  if (!(credential.credentialId instanceof Uint8Array) || credential.credentialId.length === 0) throw new Error('empty credential ID');
  validateP256Key(credential.pk);
  record.credential = { credentialId: new Uint8Array(credential.credentialId), pk: copyP256(credential.pk) };
}
/** Explicit replacement is possible only before any approval exists. Callers
 * must first discard the failed credential on its authenticator as appropriate. */
export function discardUnapprovedBootstrapCredential(record: SignedBootstrapRecord): void {
  if (record.approval || record.retired) throw new Error('cannot replace an approved or retired bootstrap target');
  delete record.credential;
}

export function signedBootstrapIntent(record: SignedBootstrapRecord): Uint8Array {
  if (!record.credential) throw new Error('bootstrap credential has not been retained');
  return pureCircuits.derive_signed_boot_intent(record.network, { bytes: record.address }, record.boot,
    record.credential.pk, record.policy, 0n, 0n);
}

export async function prepareSignedBootstrapActivation(record: SignedBootstrapRecord, key: TemporaryBootstrapKey,
  provider: AssertionProvider): Promise<RetainedSignedBootstrapApproval> {
  if (record.retired) throw new Error('bootstrap has been retired');
  if (record.approval) { validateRetainedApproval(record); return record.approval; }
  if (approving.has(record)) throw new Error('bootstrap approval already in progress');
  approving.add(record);
  try {
  createSignedBootstrapRecord(record.network, record.address, record.boot, record.Q, record.policy);
  if (key.Q.x !== record.Q.x || key.Q.y !== record.Q.y) throw new Error('temporary key does not match deployment');
  const intent = signedBootstrapIntent(record);
  const before = serializeSignedBootstrapRecord(record);
  const received = await provider(new Uint8Array(pureCircuits.challenge_signed_boot_passkey(intent)));
  if (serializeSignedBootstrapRecord(record) !== before) throw new Error('bootstrap context changed during passkey assertion');
  const assertion = { authenticatorData: new Uint8Array(received.authenticatorData), clientDataJSON: new Uint8Array(received.clientDataJSON), signature: new Uint8Array(received.signature) };
  const { R, s, grind_nonce } = key.approve(intent, record.credential!.pk, record.policy, assertion);
  const approval = { intent, network: new Uint8Array(record.network), address: new Uint8Array(record.address), boot: new Uint8Array(record.boot),
    Q: copyPoint(record.Q), pk: copyP256(record.credential!.pk), policy: copyPolicy(record.policy), R, s, grind_nonce, assertion };
  record.approval = approval;
  return approval;
  } finally { approving.delete(record); }
}

/** Revalidate imported records and retained signatures before any retry. */
export function validateRetainedApproval(record: SignedBootstrapRecord): void {
  const a = record.approval;
  if (!a) throw new Error('no retained activation approval');
  createSignedBootstrapRecord(record.network, record.address, record.boot, record.Q, record.policy);
  if (!equalBytes(a.intent, signedBootstrapIntent(record)) || !equalBytes(a.network, record.network) ||
      !equalBytes(a.address, record.address) || !equalBytes(a.boot, record.boot) ||
      a.Q.x !== record.Q.x || a.Q.y !== record.Q.y || a.pk.x !== record.credential!.pk.x || a.pk.y !== record.credential!.pk.y ||
      a.pk.identity !== record.credential!.pk.identity || !equalBytes(a.policy.rp_id_hash, record.policy.rp_id_hash) || !equalBytes(a.policy.origin, record.policy.origin)) {
    throw new Error('retained activation target/context mismatch');
  }
  uint64(a.grind_nonce, 'grinding nonce');
  if (typeof a.s !== 'bigint' || a.s < 0n || a.s >= ORDER) throw new Error('noncanonical temporary signature scalar');
  const c = le(pureCircuits.challenge_signed_boot_jubjub(a.R, a.Q, a.intent, a.grind_nonce));
  if (c >= ORDER) throw new Error('temporary signature challenge outside subgroup order');
  const expected = point(a.R).add(point(a.Q).multiplyUnsafe(c));
  const G = point(pureCircuits.compute_public_point_with_jubjub(1n));
  if (!G.multiplyUnsafe(a.s).equals(expected)) throw new Error('invalid retained temporary signature');
  assertionMaterial(pureCircuits.challenge_signed_boot_passkey(a.intent), a.policy, a.pk, a.assertion);
}

export function signedBootstrapActivationArgs(a: RetainedSignedBootstrapApproval) {
  const material = assertionMaterial(pureCircuits.challenge_signed_boot_passkey(a.intent), a.policy, a.pk, a.assertion);
  return [copyPoint(a.Q), copyP256(a.pk), copyPolicy(a.policy), copyPoint(a.R), a.s, a.grind_nonce, material.authenticator_data, material.sig, material.chrome_grease] as const;
}

// Explicit public-data schema, not JSON.stringify(key/objects). The retained
// approval is authority for exactly one target: protect it with onboarding data.
function copyApproval(a: RetainedSignedBootstrapApproval): RetainedSignedBootstrapApproval {
  return {
    intent: new Uint8Array(a.intent), network: new Uint8Array(a.network), address: new Uint8Array(a.address), boot: new Uint8Array(a.boot),
    Q: copyPoint(a.Q), pk: copyP256(a.pk), policy: copyPolicy(a.policy), R: copyPoint(a.R), s: a.s, grind_nonce: a.grind_nonce,
    assertion: { authenticatorData: new Uint8Array(a.assertion.authenticatorData), clientDataJSON: new Uint8Array(a.assertion.clientDataJSON), signature: new Uint8Array(a.assertion.signature) },
  };
}
function copyDeployment(d: WaveDeploymentCheckpoint, address: Uint8Array): WaveDeploymentCheckpoint {
  if (d.version !== 1 || !['jubjub', 'k256', 'p256'].includes(d.firstArm) || typeof d.retireAuthority !== 'boolean' ||
      typeof d.privateStateId !== 'string' || !d.privateStateId || !(d.initialState instanceof Uint8Array) || !(d.deploymentIntent instanceof Uint8Array) ||
      !equalBytes(hexToBytes(d.address), address)) throw new Error('invalid bootstrap deployment checkpoint');
  return { version: 1, address: d.address, initialState: new Uint8Array(d.initialState), deploymentIntent: new Uint8Array(d.deploymentIntent), privateStateId: d.privateStateId,
    firstArm: d.firstArm, retireAuthority: d.retireAuthority };
}
export function serializeSignedBootstrapRecord(record: SignedBootstrapRecord): string {
  const clean = createSignedBootstrapRecord(record.network, record.address, record.boot, record.Q, record.policy);
  if (record.credential) retainBootstrapCredential(clean, record.credential);
  if (record.approval) { validateRetainedApproval(record); clean.approval = copyApproval(record.approval); }
  if (record.transactionId !== undefined) clean.transactionId = record.transactionId;
  if (record.retired) clean.retired = true;
  if (record.deployment) clean.deployment = copyDeployment(record.deployment, record.address);
  return JSON.stringify(clean, (_name, value) => typeof value === 'bigint' ? { bigint: value.toString() } :
    value instanceof Uint8Array ? { bytes: bytesToHex(value) } : value);
}
export function deserializeSignedBootstrapRecord(json: string): SignedBootstrapRecord {
  const record = JSON.parse(json, (_name, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1) {
      if (typeof value.bigint === 'string' && /^(0|[1-9][0-9]*)$/.test(value.bigint)) return BigInt(value.bigint);
      if (typeof value.bytes === 'string' && /^(?:[0-9a-f]{2})*$/.test(value.bytes)) return hexToBytes(value.bytes);
    }
    return value;
  }) as SignedBootstrapRecord;
  if (record.version !== 1 || (record.retired !== undefined && typeof record.retired !== 'boolean') ||
      (record.transactionId !== undefined && typeof record.transactionId !== 'string')) throw new Error('invalid bootstrap record version/metadata');
  // Reconstruct the allowlisted schema, rejecting malformed imported material.
  const clean = createSignedBootstrapRecord(record.network, record.address, record.boot, record.Q, record.policy);
  if (record.credential) retainBootstrapCredential(clean, record.credential);
  if (record.approval) { clean.approval = record.approval; validateRetainedApproval(clean); clean.approval = copyApproval(record.approval); }
  clean.transactionId = record.transactionId; clean.retired = record.retired;
  if (record.deployment) clean.deployment = copyDeployment(record.deployment, record.address);
  return clean;
}
