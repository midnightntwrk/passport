import { createHash } from 'node:crypto';
import type { Ledger, JubjubPoint } from './contract.js';
import { deriveEncPublicKey } from './inbox.js';
import { bytesToHex, hexToBytes } from './hex.js';
import { FQ, fieldFromBytes, fieldToBytes, openWrap, reconstruct, split, type IndexedShare } from './recovery.js';
import { matchesRecoveryPk, recoveryKey } from './recovery-gate.js';

export interface ViewingKeyScope { networkId: string; address: string }
export interface PersistedViewingKey extends ViewingKeyScope {
  version: 1;
  encSecretKeyHex: string;
  encPublicKeyHex: string;
}
/** An acknowledged set must satisfy the store's documented durability contract. */
export interface ViewingKeyStore {
  get(scope: ViewingKeyScope): Promise<PersistedViewingKey | null>;
  set(record: PersistedViewingKey): Promise<void>;
}
export interface ViewingRecoveryOptions { networkId: string; store: ViewingKeyStore }
export interface GuardianRecoveryInput { n: number; t: number; shares: readonly IndexedShare[] }
export interface PublishViewingRecoveryOptions extends GuardianRecoveryInput {
  recoverySecret: Uint8Array;
  sessionNonce: Uint8Array;
}
export interface ViewingRecoverySnapshot {
  address: string;
  encKey: Uint8Array;
  recoveryPk: JubjubPoint;
  recoverySession: Uint8Array;
  recoveryWrap: Uint8Array;
  recoveryVersion: bigint;
  phi: readonly bigint[];
  deviceEpoch: bigint;
  pendingRecovery: boolean;
  pendingEntry: Uint8Array;
  pendingRecoveryPk: JubjubPoint;
  pendingNotBefore: bigint;
}
/** Trusted local history only, never a proof against edits to the private profile. */
export interface ViewingWrapVerification {
  version: 1;
  address: string;
  artefactHash: string;
  encPublicKeyHex: string;
  state: 'verified' | 'invalidated';
}
export interface ViewingRecoveryStatus {
  version: 1;
  address: string;
  encPublicKeyHex: string;
  localKey: 'current' | 'missing' | 'stale';
  wrap: 'verified-current' | 'known-stale' | 'unknown' | 'absent';
  pendingRecovery: boolean;
}
export interface ViewingKeyPersistenceResult extends ViewingRecoveryStatus {
  networkId: string;
  persisted: true;
}
export type ViewingRecoveryErrorCode = 'invalid-input' | 'unsupported-version' | 'invalid-wrap'
  | 'recovery-key-mismatch' | 'stale-wrap' | 'chain-changed' | 'persistence-unconfirmed'
  | 'viewing-key-mismatch' | 'guardians-unavailable' | 'pending-recovery';
export class ViewingRecoveryError extends Error {
  constructor(readonly code: ViewingRecoveryErrorCode, message: string) { super(message); this.name = 'ViewingRecoveryError'; }
}

const fail = (message: string): never => { throw new ViewingRecoveryError('invalid-input', message); };
const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function bytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) fail(`invalid ${name}`);
  return (value as Uint8Array).slice();
}
function field(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= FQ) fail(`invalid ${name}`);
  return value as bigint;
}
function uint64(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 64n)) fail(`invalid ${name}`);
  return value as bigint;
}
function point(value: JubjubPoint, name: string): JubjubPoint {
  if (!value) fail(`invalid ${name}`);
  return { x: field(value.x, name), y: field(value.y, name) };
}
export function validateViewingKeyScope(scope: ViewingKeyScope): ViewingKeyScope {
  if (!scope || typeof scope.networkId !== 'string' || !scope.networkId || scope.networkId !== scope.networkId.trim()
    || scope.networkId.length > 512 || !hex32(scope.address)) fail('invalid viewing key scope');
  return { networkId: scope.networkId, address: scope.address };
}
export function validatePersistedViewingKey(record: PersistedViewingKey, expected?: ViewingKeyScope): PersistedViewingKey {
  const scope = validateViewingKeyScope(record);
  if (record.version !== 1 || !hex32(record.encSecretKeyHex) || !hex32(record.encPublicKeyHex)
    || (expected && (scope.networkId !== expected.networkId || scope.address !== expected.address))) fail('invalid persisted viewing key');
  if (bytesToHex(deriveEncPublicKey(hexToBytes(record.encSecretKeyHex))) !== record.encPublicKeyHex) fail('persisted viewing key pair mismatch');
  return { version: 1, ...scope, encSecretKeyHex: record.encSecretKeyHex, encPublicKeyHex: record.encPublicKeyHex };
}
export function persistedViewingKey(scope: ViewingKeyScope, key: Uint8Array): PersistedViewingKey {
  const copy = bytes(key, 32, 'viewing key');
  try { return { version: 1, ...validateViewingKeyScope(scope), encSecretKeyHex: bytesToHex(copy), encPublicKeyHex: bytesToHex(deriveEncPublicKey(copy)) }; }
  finally { copy.fill(0); }
}

export function viewingSnapshot(address: string, ledger: Ledger): ViewingRecoverySnapshot {
  if (!hex32(address)) fail('invalid recovery account address');
  if (ledger.recovery_version !== 1n) throw new ViewingRecoveryError('unsupported-version', 'unsupported recovery artefact version');
  const count = ledger.recovery_phi_len;
  if (typeof count !== 'bigint' || count < 0n || count > 4n) fail('invalid recovery public vector');
  const phi: bigint[] = [];
  for (let i = 1n; i <= count; i++) phi.push(field(ledger.recovery_phi.lookup(i), 'recovery public share'));
  if (typeof ledger.pending_recovery !== 'boolean') fail('invalid pending recovery flag');
  return { address, encKey: bytes(ledger.enc_key, 32, 'encryption public key'),
    recoveryPk: point(ledger.recovery_pk, 'recovery public key'), recoverySession: bytes(ledger.recovery_session, 32, 'recovery session'),
    recoveryWrap: bytes(ledger.recovery_wrap, 64, 'recovery wrap'), recoveryVersion: ledger.recovery_version, phi,
    deviceEpoch: uint64(ledger.device_epoch, 'device epoch'), pendingRecovery: ledger.pending_recovery,
    pendingEntry: bytes(ledger.pending_entry, 32, 'pending recovery entry'),
    pendingRecoveryPk: point(ledger.pending_recovery_pk, 'pending recovery public key'),
    pendingNotBefore: uint64(ledger.pending_not_before, 'pending recovery deadline') };
}

function artefactHash(snapshot: ViewingRecoverySnapshot): string {
  return createHash('sha256').update(JSON.stringify([snapshot.address, snapshot.recoveryVersion.toString(),
    snapshot.recoveryPk.x.toString(), snapshot.recoveryPk.y.toString(), bytesToHex(snapshot.recoverySession),
    snapshot.phi.map(String), bytesToHex(snapshot.recoveryWrap)])).digest('hex');
}
export function sameViewingSnapshot(left: ViewingRecoverySnapshot, right: ViewingRecoverySnapshot): boolean {
  return artefactHash(left) === artefactHash(right) && bytesToHex(left.encKey) === bytesToHex(right.encKey)
    && left.deviceEpoch === right.deviceEpoch && left.pendingRecovery === right.pendingRecovery
    && bytesToHex(left.pendingEntry) === bytesToHex(right.pendingEntry)
    && left.pendingRecoveryPk.x === right.pendingRecoveryPk.x && left.pendingRecoveryPk.y === right.pendingRecoveryPk.y
    && left.pendingNotBefore === right.pendingNotBefore;
}
export function assertViewingSnapshot(left: ViewingRecoverySnapshot, right: ViewingRecoverySnapshot): void {
  if (!sameViewingSnapshot(left, right)) throw new ViewingRecoveryError('chain-changed', 'viewing recovery state changed; retry from a fresh snapshot');
}
export function viewingWrapVerification(snapshot: ViewingRecoverySnapshot, state: ViewingWrapVerification['state'] = 'verified'): ViewingWrapVerification {
  return { version: 1, address: snapshot.address, artefactHash: artefactHash(snapshot), encPublicKeyHex: bytesToHex(snapshot.encKey), state };
}
export function viewingRecoveryStatus(snapshot: ViewingRecoverySnapshot, localSecretHex: string | null | undefined,
  marker?: unknown): ViewingRecoveryStatus {
  let localKey: ViewingRecoveryStatus['localKey'] = localSecretHex == null ? 'missing' : 'stale';
  if (hex32(localSecretHex) && bytesToHex(deriveEncPublicKey(hexToBytes(localSecretHex))) === bytesToHex(snapshot.encKey)) localKey = 'current';
  let wrap: ViewingRecoveryStatus['wrap'] = snapshot.phi.length === 0 || snapshot.recoveryWrap.every(byte => byte === 0) ? 'absent' : 'unknown';
  const value = marker as Partial<ViewingWrapVerification> | undefined;
  if (wrap !== 'absent' && value && value.version === 1 && value.address === snapshot.address
    && hex32(value.artefactHash) && hex32(value.encPublicKeyHex) && ['verified', 'invalidated'].includes(value.state ?? '')
    && value.artefactHash === artefactHash(snapshot)) {
    wrap = value.state === 'invalidated' || value.encPublicKeyHex !== bytesToHex(snapshot.encKey) ? 'known-stale' : 'verified-current';
  }
  return { version: 1, address: snapshot.address, encPublicKeyHex: bytesToHex(snapshot.encKey), localKey, wrap, pendingRecovery: snapshot.pendingRecovery };
}

export function openCurrentViewingKey(recoverySecret: Uint8Array, snapshot: ViewingRecoverySnapshot): Uint8Array {
  const secret = bytes(recoverySecret, 32, 'recovery secret');
  try {
    let scalar: bigint;
    try { scalar = fieldFromBytes(secret); } catch { fail('invalid recovery secret encoding'); }
    if (!matchesRecoveryPk(scalar!, snapshot.recoveryPk)) throw new ViewingRecoveryError('recovery-key-mismatch', 'recovery secret does not match the current artefact set');
    const wrap = snapshot.recoveryWrap;
    if (snapshot.recoveryVersion !== 1n || !(wrap instanceof Uint8Array) || wrap.length !== 64
      || wrap[0] !== 1 || wrap[1] !== 1 || wrap[62] !== 0 || wrap[63] !== 0) throw new ViewingRecoveryError('invalid-wrap', 'unsupported or malformed recovery wrap');
    const key = openWrap(secret, hexToBytes(snapshot.address), wrap);
    if (!key) throw new ViewingRecoveryError('invalid-wrap', 'recovery wrap authentication failed');
    if (bytesToHex(deriveEncPublicKey(key)) !== bytesToHex(snapshot.encKey)) {
      key.fill(0);
      throw new ViewingRecoveryError('stale-wrap', 'recovery wrap does not contain the current viewing key');
    }
    return key;
  } finally { secret.fill(0); }
}

export function validateGuardianInput(input: GuardianRecoveryInput, all = false): GuardianRecoveryInput {
  if (!input || !Number.isInteger(input.n) || input.n < 1 || input.n > 32 || !Number.isInteger(input.t)
    || input.t < 0 || input.t >= input.n || input.n - input.t > 4 || !Array.isArray(input.shares)) fail('invalid supported guardian geometry');
  if (input.shares.length < (all ? input.n : input.t + 1)) throw new ViewingRecoveryError('guardians-unavailable', 'insufficient guardian shares for this operation');
  if (input.shares.length > input.n) fail('too many guardian shares');
  const seen = new Set<number>();
  const shares = input.shares.map(share => {
    if (!share || !Number.isInteger(share.index) || share.index < 1 || share.index > input.n || seen.has(share.index)) fail('invalid guardian share index');
    seen.add(share.index);
    return { index: share.index, sigma: field(share.sigma, 'guardian share') };
  });
  return { n: input.n, t: input.t, shares };
}
export function reconstructRecoverySecret(snapshot: ViewingRecoverySnapshot, input: GuardianRecoveryInput): Uint8Array {
  const checked = validateGuardianInput(input);
  if (snapshot.phi.length !== checked.n - checked.t || snapshot.recoveryVersion !== 1n) fail('guardian roster does not match the public vector');
  snapshot.phi.forEach(value => field(value, 'recovery public share'));
  const secret = reconstruct(snapshot.phi, checked.shares, checked.t);
  if (!matchesRecoveryPk(secret, snapshot.recoveryPk)) throw new ViewingRecoveryError('recovery-key-mismatch', 'guardian reconstruction does not match the current recovery key');
  return fieldToBytes(secret);
}
export function reconstructCurrentViewingKey(snapshot: ViewingRecoverySnapshot, input: GuardianRecoveryInput): Uint8Array {
  const secret = reconstructRecoverySecret(snapshot, input);
  try { return openCurrentViewingKey(secret, snapshot); } finally { secret.fill(0); }
}
export function prepareViewingRecoverySession(snapshot: ViewingRecoverySnapshot, options: PublishViewingRecoveryOptions): {
  recoveryPk: JubjubPoint; sessionNonce: Uint8Array; phi: bigint[];
} {
  const checked = validateGuardianInput(options, true);
  const secret = bytes(options.recoverySecret, 32, 'recovery secret');
  try {
    let scalar: bigint;
    try { scalar = fieldFromBytes(secret); } catch { fail('invalid recovery secret encoding'); }
    const recoveryPk = recoveryKey(scalar!).pk;
    const sessionNonce = bytes(options.sessionNonce, 32, 'recovery session');
    if (sessionNonce.every(byte => byte === 0) || bytesToHex(sessionNonce) === bytesToHex(snapshot.recoverySession)
      || (recoveryPk.x === snapshot.recoveryPk.x && recoveryPk.y === snapshot.recoveryPk.y)) fail('a fresh recovery key and session are required');
    if (snapshot.pendingRecovery) throw new ViewingRecoveryError('pending-recovery', 'cancel or finish pending recovery before publishing a fresh session');
    return { recoveryPk, sessionNonce, phi: split(scalar!, checked.shares, checked.t) };
  } finally { secret.fill(0); }
}
