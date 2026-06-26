-- Midnight.Passport.Core
--
-- Abstract types and domain-separation primitives for the Midnight Passport
-- formal specification.
--
-- Design notes:
--
--   (1) Everything in this module is postulated.  The layer is deliberately
--       abstract so that cryptographic assumptions can be discharged
--       independently — by an Agda proof, a Lean extraction, or a
--       cryptographer's pen-and-paper reduction — without reworking the
--       architecture model.
--
--   (2) Poseidon-as-H₂ (the in-circuit hash used for commitments and the
--       nullifier tree) is the Priority 1 formal verification target.  The
--       concrete goal is a machine-checked proof of Fiat-Shamir soundness
--       for the Schnorr-in-ZK construction: if the Poseidon permutation
--       behaves as a random oracle then the ZK proof is knowledge-sound.
--       Until that proof exists, Poseidon is kept here as an opaque
--       postulate.
--
--   (3) Domain tags declared below will be registered in the C8 Domain-Tag
--       Registry once the MIP standardisation process begins.  Each tag
--       occupies a distinct byte prefix so that the same hash function
--       cannot be collided across protocol contexts.

module Midnight.Passport.Core where

open import Data.Nat   using (ℕ)
open import Data.Vec   using (Vec)

------------------------------------------------------------------------
-- Byte arrays

-- A fixed-length byte array.  Used as the carrier for colours,
-- challenge bytes, and raw key material.
postulate
  Bytes : ℕ → Set

------------------------------------------------------------------------
-- Field element

-- Scalar field element for the Jubjub curve (Baby Jubjub embedded in
-- BLS12-381).  All arithmetic inside Compact circuits operates over
-- this type.
postulate
  𝔽 : Set

------------------------------------------------------------------------
-- Hash functions

-- Off-circuit hash: SHA-256 over arbitrary-length byte strings.
-- Used for passkey challenges and WebAuthn client-data hashing.
postulate
  sha256 : {n : ℕ} → Bytes n → Bytes 32

-- In-circuit hash: Poseidon over field elements.
-- This is H₂ in the protocol — the Priority 1 verification target.
-- See note (2) above.
postulate
  poseidon : {n : ℕ} → Vec 𝔽 n → 𝔽

------------------------------------------------------------------------
-- Domain tags  (C8 Domain-Tag Registry)

-- Each DomainTag is a distinct constant used to prefix hash inputs so
-- that the same Poseidon call cannot be repurposed across protocol
-- contexts.  Tags will receive registered byte values when C8 is
-- finalised.
postulate
  DomainTag : Set

  -- Commitment tag (C10 ScopedGrant, C21 Nullifier seed)
  tagCommit  : DomainTag
  -- Nullifier derivation tag (C21)
  tagNullify : DomainTag
  -- Recovery epoch bump tag (C14)
  tagEpoch   : DomainTag
  -- Grant scope binding tag (C10/C12)
  tagGrant   : DomainTag
  -- Attestation leaf tag (C18)
  tagAttest  : DomainTag

------------------------------------------------------------------------
-- Commitment

-- Domain-separated commitment: hash of (tag, secret).
-- Used throughout: grant commitments (C10), nullifier seeds (C21),
-- and recovery epoch commitments (C14).
postulate
  Commitment : Set
  commit     : DomainTag → 𝔽 → Commitment

------------------------------------------------------------------------
-- Secret types

-- Device-level secret derived from a WebAuthn PRF extension output.
-- Never leaves the device; feeds the Schnorr signing key (C5).
postulate
  DeviceSecret : Set

-- Recovery secret stored out-of-band (e.g. printed or in a hardware
-- token).  Used by C14 TotalLossRecovery to register a new device key
-- after total device loss.
postulate
  RecoverySecret : Set

-- Grant secret shared between an account holder and a dApp.
-- Bound to a scope (C10 ScopedGrant) to limit on-chain capabilities.
postulate
  GrantSecret : Set

------------------------------------------------------------------------
-- Protocol state types

-- Epoch counter.  Incremented by C14 on each recovery event.  Tracked
-- on-chain so that stale device registrations are rejected.
Epoch : Set
Epoch = ℕ

-- A 32-byte colour value.  Used in the Midnight UTXO model to tag
-- protocol-specific coin classes.
Color : Set
Color = Bytes 32

-- Token amount.  Kept as ℕ for now; a bounded-integer type may be
-- substituted when the on-chain value model is formalised.
Amount : Set
Amount = ℕ

------------------------------------------------------------------------
-- Schnorr signature (Jubjub)

-- A Schnorr signature over the Baby Jubjub curve as produced by the
-- Compact Schnorr gadget (C5 Signing).  The concrete encoding follows
-- the RedJubJub draft.
postulate
  SchnorrSig : Set

-- Schnorr public key corresponding to a DeviceSecret.
postulate
  PubKey : Set

  -- Derive the public key from a device secret.
  devicePubKey : DeviceSecret → PubKey

  -- Sign a 32-byte message with a device secret.
  schnorrSign : DeviceSecret → Bytes 32 → SchnorrSig

  -- Verify a signature.
  schnorrVerify : PubKey → Bytes 32 → SchnorrSig → Set

------------------------------------------------------------------------
-- ZK proof

-- An opaque ZK proof as produced by the Midnight Compact prover (C6
-- ProofGeneration).  The proof system is a Plonk variant; the exact
-- verifier equation is part of the on-chain contract (C1
-- AccountCustody).
postulate
  ZKProof : Set

-- The circuit statement / public inputs against which a ZKProof is
-- verified.  Kept abstract here; concrete statement types are defined
-- per-component.
postulate
  Statement : Set

  -- Verify a ZK proof against a public statement.
  zkVerify : Statement → ZKProof → Set
