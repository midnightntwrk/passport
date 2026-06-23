-- Midnight.Passport.Architecture
--
-- The Midnight Passport architecture expressed as FMTerm string diagrams.
--
-- Each architectural path is built from `gen` (component box), `_>>_`
-- (sequential composition — "wire output of left into input of right"),
-- and `_⊗_` (parallel composition — "run both paths side by side").
-- The `gen` arguments are:
--
--   gen componentName inputChannels outputChannels
--
-- where componentName matches the canonical C-numbers in the planning
-- documents and the channel-name strings match those declared in
-- Channels.agda.
--
-- List syntax note: Agda does not have Haskell-style list literals for
-- multiple elements.  Multi-element lists use `_∷_` and `[]`; single-
-- element lists use the `[_]` sugar from Data.List.
--
-- Deferred constructs:
--
--   Traces (looping sub-protocols) are NOT represented here.  The three
--   principal traces in the architecture are:
--
--     * C7 witness loop — C7 may re-request signing from C5 if the
--       first witness attempt fails a range-check.
--     * C14 ↔ C15 round-trip — recovery share distribution involves
--       multiple rounds of acknowledge/retry.
--     * C21 nullifier check — the nullifier is checked and then
--       consumed atomically; the consumption feeds back into the
--       contract state.
--
--   When traces are added they will use the `tr` constructor which is
--   not yet part of FMTerm.  Two approaches are under consideration:
--
--     Option A — extend the Catlab renderer for
--       FreeTracedMonoidalCategory; add a `tr : String → FMTerm →
--       FMTerm` constructor and thread the traced wire as a dashed
--       feedback arc in the SVG output.
--
--     Option B — annotate DAG edges with a "feedback" flag and render
--       the trace as a dashed wire looping back in the existing DAG
--       renderer, without changing the FMTerm grammar.  Lower effort
--       but less categorically precise.

module Midnight.Passport.Architecture where

open import Data.List using (List; _∷_; [])
open import Data.String using (String)

open import Midnight.Passport.FMTerm
open import Midnight.Passport.Channels

------------------------------------------------------------------------
-- Authentication path
--
-- User → C9-DeviceAuth → C5-Signing ⊗ C7-WitnessHandling → C6-ProofGeneration → C1-AccountCustody → Chain
--
-- Wires threaded (left to right):
--   User-C9
--   >> (C9-C5 out)
--   >> C5-C6 ⊗ C7-C6   [signing and witness preparation in parallel]
--   >> C6-C1            [proof generation consumes both]
--   >> C1-Chain

authPath : FMTerm
authPath =
  -- Step 1: authenticate the user via WebAuthn and derive the device key
  -- in : [ User-C9 ]   out : [ C9-C5 ]
  gen "C9-DeviceAuth"
      ("User-C9" ∷ [])
      ("C9-C5"   ∷ [])
  >>
  -- Step 2a (left lane): Schnorr signing
  -- in : [ C9-C5 ]   out : [ C5-C6 ]
  ( gen "C5-Signing"
        ("C9-C5" ∷ [])
        ("C5-C6" ∷ [])
  ⊗
  -- Step 2b (right lane): witness preparation (feeds C6 from the prover side)
  -- in : [ C7-C6 ]   out : [ C7-C6 ]
    gen "C7-WitnessHandling"
        ("C7-C6" ∷ [])
        ("C7-C6" ∷ [])
  )
  >>
  -- Step 3: generate the ZK proof from the Schnorr signature and the witness
  -- in : [ C5-C6, C7-C6 ]   out : [ C6-C1 ]
  gen "C6-ProofGeneration"
      ("C5-C6" ∷ "C7-C6" ∷ [])
      ("C6-C1" ∷ [])
  >>
  -- Step 4: submit the ZK proof to the on-chain account contract
  -- in : [ C6-C1 ]   out : [ C1-Chain ]
  gen "C1-AccountCustody"
      ("C6-C1"    ∷ [])
      ("C1-Chain" ∷ [])

------------------------------------------------------------------------
-- Grant path
--
-- dApp → C10-ScopedGrant → C12-ChainEnforcement → C1-AccountCustody → Chain
--
-- C1-AccountCustody is shared with the authentication path at the
-- physical level.  At the architecture level it is represented as a
-- separate gen node so that the ⊗-composition in `passport` makes the
-- parallelism explicit.  A future refinement will fold the duplicate
-- C1 nodes using the `idm` combinator once the channel-merger algebra
-- is available.
--
-- Wires threaded:
--   dApp-C10
--   >> C6-C1   [grant commitment flows directly into proof submission]
--   >> C1-Chain

grantPath : FMTerm
grantPath =
  -- Step 1: bind the grant secret to a scope; produce a commitment
  -- in : [ dApp-C10 ]   out : [ C6-C1 ]
  gen "C10-ScopedGrant"
      ("dApp-C10" ∷ [])
      ("C6-C1"    ∷ [])
  >>
  -- Step 2: enforce the scoped grant predicate on-chain
  -- in : [ C6-C1 ]   out : [ C1-Chain ]
  gen "C12-ChainEnforcement"
      ("C6-C1"    ∷ [])
      ("C1-Chain" ∷ [])
  >>
  -- Step 3: account custody (grant branch)
  -- in : [ C1-Chain ]   out : [ C1-Chain ]
  gen "C1-AccountCustody"
      ("C1-Chain" ∷ [])
      ("C1-Chain" ∷ [])

------------------------------------------------------------------------
-- Recovery path
--
-- User (recovery secret) → C14-TotalLossRecovery ↔ C15-HelperProtocol → C1-AccountCustody → Chain
--
-- The C14 ↔ C15 bidirectional exchange is a trace (see module comment
-- above).  Here it is linearised as C14 >> C15 >> C14 to preserve
-- sequential structure; the feedback arc will be restored when the
-- `tr` constructor is added to FMTerm.
--
-- Wires threaded:
--   User-C9 [recovery entry point]
--   >> C14-C15
--   >> C14-C15   [share acknowledgement, currently linearised]
--   >> C6-C1
--   >> C1-Chain

recoveryPath : FMTerm
recoveryPath =
  -- Step 1: initiate recovery — derive epoch bump from recovery secret
  -- in : [ User-C9 ]   out : [ C14-C15 ]
  gen "C14-TotalLossRecovery"
      ("User-C9"  ∷ [])
      ("C14-C15"  ∷ [])
  >>
  -- Step 2: distribute / reconstruct shares via helper nodes
  --   (the C14 ↔ C15 round-trip is a trace; linearised here pending `tr`)
  -- in : [ C14-C15 ]   out : [ C14-C15 ]
  gen "C15-HelperProtocol"
      ("C14-C15" ∷ [])
      ("C14-C15" ∷ [])
  >>
  -- Step 3: register the new device key on-chain after share reconstruction
  -- in : [ C14-C15 ]   out : [ C6-C1 ]
  gen "C14-TotalLossRecovery"
      ("C14-C15" ∷ [])
      ("C6-C1"   ∷ [])
  >>
  -- Step 4: account custody (recovery branch)
  -- in : [ C6-C1 ]   out : [ C1-Chain ]
  gen "C1-AccountCustody"
      ("C6-C1"    ∷ [])
      ("C1-Chain" ∷ [])

------------------------------------------------------------------------
-- Credential path
--
-- Issuer → C18-AttestationTree ⊗ C19-CredentialIssuance
--        → C20-SelectiveDisclosure ⊗ C21-Nullifier → C1-AccountCustody → Chain
--
-- C18 and C19 run in parallel on the issuance side (build the Merkle
-- tree and issue the credential simultaneously).  C20 and C21 run in
-- parallel on the disclosure side (generate the membership proof while
-- checking nullifier freshness).
--
-- Wires threaded:
--   C18-C20
--   >> (C18-AttestationTree ⊗ C19-CredentialIssuance)
--   >> (C20-SelectiveDisclosure ⊗ C21-env)
--   >> C6-C1
--   >> C1-Chain

credentialPath : FMTerm
credentialPath =
  -- Step 1 (issuance): build attestation tree ⊗ issue credential
  -- left:  in : [ C18-C20 ]   out : [ C18-C20 ]   (Merkle path to C20)
  -- right: in : [ C18-C20 ]   out : [ C6-C1   ]   (credential feeds proof)
  ( gen "C18-AttestationTree"
        ("C18-C20" ∷ [])
        ("C18-C20" ∷ [])
  ⊗
    gen "C19-CredentialIssuance"
        ("C18-C20" ∷ [])
        ("C6-C1"   ∷ [])
  )
  >>
  -- Step 2 (disclosure): selective disclosure ⊗ nullifier check
  -- left:  in : [ C18-C20 ]   out : [ C6-C1  ]   (membership proof)
  -- right: in : [ C21-env ]   out : [ C21-env ]   (replay-prevention; trace deferred)
  ( gen "C20-SelectiveDisclosure"
        ("C18-C20" ∷ [])
        ("C6-C1"   ∷ [])
  ⊗
    gen "C21-Nullifier"
        ("C21-env" ∷ [])
        ("C21-env" ∷ [])
  )
  >>
  -- Step 3: submit credential ZK proof on-chain
  -- in : [ C6-C1 ]   out : [ C1-Chain ]
  gen "C1-AccountCustody"
      ("C6-C1"    ∷ [])
      ("C1-Chain" ∷ [])

------------------------------------------------------------------------
-- Full passport architecture
--
-- All four paths run in parallel (⊗).  They share C1-AccountCustody
-- and the chain boundary; that sharing is currently modelled by
-- replication of the C1 and C1-Chain nodes across paths.  A subsequent
-- refinement will introduce `swap` / `idm` normalisation to collapse
-- the four C1 copies into one, but doing so requires the channel-merger
-- algebra which is not yet available.

passport : FMTerm
passport = authPath ⊗ grantPath ⊗ recoveryPath ⊗ credentialPath
