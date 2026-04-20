import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Stub TEE — local proof of concept
//
// In production this module would be replaced by an SGX/TrustZone binding
// that:
//   1. Generates sk_device inside the enclave (never leaves secure world).
//   2. Runs KYC logic inside the enclave (e.g. document scan, liveness check).
//   3. For registration: returns only the ZK proof (sk_device goes to the
//      TEE-attested proof server, never to the host OS).
//   4. For updates: computes a Schnorr signature (R, s) inside the enclave
//      and returns only (R, s) — sk_device never leaves the enclave.
//
// For the local PoC we simulate the enclave by keeping sk_device in memory
// as a hex-encoded scalar in the Jubjub scalar field (required by ecMulGenerator).
// The "KYC logic" is a simple interactive form that the user fills in.
//
// sk_device is exposed via getSkDevice() ONLY for the one-time register_device
// ZK proof (where the proof server must receive it as a private witness).
// For all subsequent update_compliance calls, signUpdate() returns a Schnorr
// signature so sk_device never leaves the stub TEE.
//
// SECURITY NOTE: This stub offers NO security guarantees.  sk_device is in
// plaintext process memory and will be lost when the process exits unless
// explicitly persisted (which this stub does NOT do, to keep things simple).
// ---------------------------------------------------------------------------


// Jubjub scalar field order (the EmbeddedFr subfield used by ecMulGenerator).
// Compact's `Field` type is BLS12-381 Fr (~255 bits) and accepts any value below
// FIELD_MODULUS, but ecMulGenerator additionally requires the value to be a
// valid Jubjub scalar, i.e. < JUBJUB_R (~252 bits).  Passing a value in
// [JUBJUB_R, FIELD_MODULUS) passes Compact's type check but causes a runtime
// decode failure inside ecMulGenerator ("EmbeddedFr decode failure").
// ~94% of random 32-byte samples exceed JUBJUB_R, so the reduction is mandatory.
// Reference: journal/project-increment-1.md §"API impediments discovered".
const JUBJUB_R =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** Reduce a 32-byte buffer to a valid Jubjub scalar. */
function bufferToJubjubScalar(bytes: Buffer): string {
  // Clear top 4 bits → value < 2^252 ≈ JUBJUB_R, then reduce mod JUBJUB_R.
  bytes[0] &= 0x0f;
  const value = BigInt('0x' + bytes.toString('hex')) % JUBJUB_R;
  return value.toString(16).padStart(64, '0');
}

/**
 * Derive a deterministic Jubjub scalar from a BIP-39 wallet seed using
 * HKDF-SHA256.  The same seed always produces the same device key, so the
 * registered on-chain device_pk survives process restarts.
 */
function deriveJubjubScalar(seed: Buffer): string {
  const derived = crypto.hkdfSync(
    'sha256',
    seed,
    'local-tee-poc',        // salt  — fixed domain label
    'device-key-v1',        // info  — key-purpose label
    32,
  );
  return bufferToJubjubScalar(Buffer.from(derived));
}

/** Generate a random Jubjub scalar (fallback when no seed is available). */
function generateJubjubScalar(): string {
  return bufferToJubjubScalar(crypto.randomBytes(32));
}

// ---------------------------------------------------------------------------
// KYC input — the "data" the TEE would receive from a trusted KYC provider
// in production.  Here we simulate it with user-supplied strings.
// ---------------------------------------------------------------------------

export interface KycInput {
  fullName:         string;
  dateOfBirth:      string;   // ISO 8601 date: YYYY-MM-DD
  jurisdictionCode: string;   // ISO 3166-1 alpha-3, e.g. "GBR"
}

// ---------------------------------------------------------------------------
// DeviceKeyCircuits — the two pure circuit functions the stub TEE needs to
// produce a Schnorr signature.  Supplied by the caller (useCompliance) from
// the compiled contract's pureCircuits object so the stub TEE does not depend
// on any external Jubjub library.
// ---------------------------------------------------------------------------

export interface DeviceKeyCircuits {
  /** Compute R = r·G (Jubjub generator times nonce scalar). */
  compute_nonce_point: (r: bigint) => {x: bigint; y: bigint};
  /**
   * Compute the raw Schnorr challenge hash (must mirror the circuit's hash expression).
   * Returns Bytes<32> as a Uint8Array in little-endian order.
   * The caller checks that the integer value is < JUBJUB_R and retries with a
   * different nonce if not.
   */
  compute_schnorr_challenge: (
    sigR:                   {x: bigint; y: bigint},
    pk:                     {x: bigint; y: bigint},
    newTier:                bigint,
    newIdentityCommitment:  bigint,
    currentUpdateCount:     bigint,
    nonce:                  bigint,
  ) => Uint8Array;
}

/** Interpret a Uint8Array as a little-endian unsigned integer (bigint). */
function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// TeeSession — holds the in-memory device key for one run.
// ---------------------------------------------------------------------------

export class TeeSession {
  private readonly skDevice: string;

  /**
   * @param seed  BIP-39 wallet seed (64 bytes).  When provided, sk_device is
   *              derived deterministically via HKDF-SHA256 so the same wallet
   *              always produces the same device key across restarts.
   *              When omitted a random scalar is generated (for testing only).
   */
  constructor(seed?: Buffer) {
    this.skDevice = seed != null ? deriveJubjubScalar(seed) : generateJubjubScalar();
  }

  /**
   * The private device scalar, as a hex string.
   *
   * Used ONLY for the one-time register_device ZK proof, where the proof
   * server must receive sk_device as a private witness to compute pk = sk·G.
   *
   * In production this would never be exposed outside the enclave; the proof
   * server itself would be TEE-attested, so sk_device would be encrypted to
   * the server's attestation key and decrypted only inside the server enclave.
   *
   * For all subsequent update_compliance calls, use signUpdate() instead —
   * it returns a Schnorr signature (R, s) and sk_device never leaves the stub.
   */
  getSkDevice(): string {
    return this.skDevice;
  }

  /**
   * Simulate KYC evaluation.
   *
   * Returns a `ComplianceTier` (0–3) based on which KYC fields are present,
   * and a `identityHash` (32 hex bytes) derived from the input fields.
   *
   * In production:
   *   - The TEE would receive documents from a KYC provider over an attested
   *     channel.
   *   - The compliance tier would be determined by the verification results.
   *   - The identityHash would be a Pedersen/Poseidon hash inside the enclave.
   */
  evaluateKyc(input: KycInput): {tier: number; identityHash: string} {
    const {fullName, dateOfBirth, jurisdictionCode} = input;

    // Determine tier from completeness of provided data.
    let tier = 0;
    if (fullName.trim().length > 0)                      tier = 1;  // Basic KYC
    if (dateOfBirth.match(/^\d{4}-\d{2}-\d{2}$/))        tier = 2;  // Enhanced KYC
    if (jurisdictionCode.match(/^[A-Z]{3}$/) && tier >= 2) tier = 3; // Institutional

    // Derive identity commitment = SHA-256(fullName ‖ dateOfBirth ‖ jurisdictionCode).
    // In production this would be a Poseidon hash inside the enclave so it is
    // compatible with the Compact circuit's field arithmetic.  For the PoC,
    // SHA-256 is sufficient to demonstrate that the private state round-trips
    // correctly through LevelDB.
    const hashInput = [fullName, dateOfBirth, jurisdictionCode].join('|');
    const identityHash = crypto
      .createHash('sha256')
      .update(hashInput, 'utf8')
      .digest('hex');

    return {tier, identityHash};
  }

  /** Convert a 64-char hex identity hash to a bigint Jubjub scalar. */
  static identityHashToField(hex: string): bigint {
    // Truncate to 31 bytes (248 bits) — well within JUBJUB_R (~252 bits) —
    // so the value is a valid ecMulGenerator input without further reduction.
    return BigInt('0x' + hex.slice(0, 62));
  }

  /**
   * Produce a Schnorr signature authorising a compliance update.
   *
   * This is the core improvement over the original sk_device-as-witness approach:
   * sk_device never leaves the stub TEE.  The caller receives only the signature
   * (sigR, sigS) and the evaluated KYC outputs (tier, identityCommitment).
   *
   * The nonce r is derived deterministically via HKDF from sk_device and the
   * message parameters so retries are safe without random state.
   *
   * The pure circuit helpers are supplied by the caller from the compiled
   * contract module so the TEE uses the same curve and hash as the ZK circuit.
   *
   * @param input              KYC form fields to evaluate
   * @param devicePk           On-chain device_pk (the registered public key)
   * @param currentUpdateCount Current on-chain update_count (replay protection)
   * @param circuits           Pure circuit helpers from contractMod.pureCircuits
   */
  signUpdate(
    input:              KycInput,
    devicePk:           {x: bigint; y: bigint},
    currentUpdateCount: bigint,
    circuits:           DeviceKeyCircuits,
  ): {sigR: {x: bigint; y: bigint}; sigS: bigint; tier: number; identityCommitment: bigint; nonce: bigint} {
    const {tier, identityHash} = this.evaluateKyc(input);
    const identityCommitment   = TeeSession.identityHashToField(identityHash);

    // Deterministic nonce: r = HKDF(sk_device, "schnorr-nonce-v1", message-info)
    // Binding the nonce to the full message ensures each distinct update gets a
    // fresh (R, s) pair while retries for the same parameters are idempotent.
    const nonceInfo = [
      this.skDevice,
      currentUpdateCount.toString(16).padStart(16, '0'),
      tier.toString(16).padStart(2, '0'),
      identityCommitment.toString(16).padStart(64, '0'),
    ].join(':');
    const nonceBuf = crypto.hkdfSync(
      'sha256',
      Buffer.from(this.skDevice, 'hex'),
      'schnorr-nonce-v1',
      Buffer.from(nonceInfo, 'utf8'),
      32,
    );
    const r   = bufferToJubjubScalar(Buffer.from(nonceBuf));
    const rBI = BigInt('0x' + r);

    // R = r·G — computed via the contract's own pure circuit so the point is
    // guaranteed to be on the same Jubjub curve with identical parameters.
    const sigR = circuits.compute_nonce_point(rBI);

    // c = intLE(Hash(R ‖ device_pk ‖ new_tier ‖ new_identity_commitment ‖ update_count ‖ nonce))
    // Must mirror the persistentHash expression in update_compliance exactly.
    // We iterate the nonce (0, 1, 2, …) until the hash, interpreted as a
    // little-endian integer, is < JUBJUB_R (~5.7% probability per try → ~17 expected iterations).
    let nonce = 0n;
    let c: bigint;
    for (;;) {
      const hBytes = circuits.compute_schnorr_challenge(
        sigR,
        devicePk,
        BigInt(tier),
        identityCommitment,
        currentUpdateCount,
        nonce,
      );
      const hInt = bytesToBigIntLE(hBytes);
      if (hInt < JUBJUB_R) {
        c = hInt;
        break;
      }
      nonce++;
    }

    // s = (r + c·sk_device) mod JUBJUB_R
    const skDeviceBI = BigInt('0x' + this.skDevice);
    const sigS       = (rBI + (c * skDeviceBI) % JUBJUB_R) % JUBJUB_R;

    return {sigR, sigS, tier, identityCommitment, nonce};
  }
}

// TeeSession is instantiated by useCompliance once the wallet seed is available,
// so sk_device is derived from the mnemonic and survives process restarts.
