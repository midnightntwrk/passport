-- Midnight.Passport.Architecture
--
-- The Midnight Passport architecture expressed as string diagrams.

module Midnight.Passport.Architecture where

open import Midnight.Passport.FMTerm
open import Midnight.Passport.Channels

opaque
  unfolding _⊗₀_

  ------------------------------------------------------------------------
  -- Authentication path
  --
  -- (User-C9, C7-C6) → C9-DeviceAuth ⊗ id[C7-C6]
  --                  → C5-Signing ⊗ C7-WitnessHandling
  --                  → C6-ProofGeneration
  --                  → C1-AccountCustody
  --                  → C1-Chain

  authPath : HomTerm (Var "User-C9" ⊗₀ Var "C7-C6") (Var "C1-Chain")
  authPath =
    -- Step 1: authenticate the user; pass witness channel through
    ( gen "C9-DeviceAuth"    (Var "User-C9") (Var "C9-C5")
    ⊗ idm                    (Var "C7-C6")
    )
    >>
    -- Step 2a: Schnorr signing  /  Step 2b: witness preparation
    ( gen "C5-Signing"       (Var "C9-C5")  (Var "C5-C6")
    ⊗ gen "C7-WitnessHandling" (Var "C7-C6")  (Var "C7-C6")
    )
    >>
    -- Step 3: generate the ZK proof from signature and witness
    gen "C6-ProofGeneration" (Var "C5-C6" ⊗₀ Var "C7-C6") (Var "C6-C1")
    >>
    -- Step 4: submit proof to on-chain account contract
    gen "C1-AccountCustody"  (Var "C6-C1")  (Var "C1-Chain")

  ------------------------------------------------------------------------
  -- Grant path
  --
  -- dApp-C10 → C10-ScopedGrant → C12-ChainEnforcement
  --          → C1-AccountCustody → C1-Chain

  grantPath : HomTerm (Var "dApp-C10") (Var "C1-Chain")
  grantPath =
    gen "C10-ScopedGrant"     (Var "dApp-C10")  (Var "C6-C1")
    >>
    gen "C12-ChainEnforcement" (Var "C6-C1")    (Var "C1-Chain")
    >>
    gen "C1-AccountCustody"   (Var "C1-Chain")  (Var "C1-Chain")

  ------------------------------------------------------------------------
  -- Recovery path
  --
  -- User-C9 → C14-TotalLossRecovery
  --         → C15-HelperProtocol
  --         → C14-TotalLossRecovery   (linearised; trace deferred)
  --         → C1-AccountCustody
  --         → C1-Chain

  recoveryPath : HomTerm (Var "User-C9") (Var "C1-Chain")
  recoveryPath =
    gen "C14-TotalLossRecovery" (Var "User-C9")  (Var "C14-C15")
    >>
    gen "C15-HelperProtocol"    (Var "C14-C15")  (Var "C14-C15")
    >>
    gen "C14-TotalLossRecovery" (Var "C14-C15")  (Var "C6-C1")
    >>
    gen "C1-AccountCustody"     (Var "C6-C1")    (Var "C1-Chain")

  ------------------------------------------------------------------------
  -- Credential path
  --
  -- (C18-C20¹, C18-C20², C21-env)
  --   → C18-AttestationTree ⊗ C19-CredentialIssuance ⊗ id[C21-env]
  --   → C20-SelectiveDisclosure ⊗ id[C6-C1] ⊗ C21-Nullifier
  --   → C1-AccountCustody
  --   → C1-Chain
  --
  -- Fan-out is explicit: C18 and C19 each receive their own C18-C20 lane.

  credentialPath : HomTerm
    (Var "C18-C20" ⊗₀ Var "C18-C20" ⊗₀ Var "C21-env")
    (Var "C1-Chain")
  credentialPath =
    -- Step 1: issuance
    ( gen "C18-AttestationTree"   (Var "C18-C20")  (Var "C18-C20")
    ⊗ gen "C19-CredentialIssuance" (Var "C18-C20") (Var "C6-C1")
    ⊗ idm                          (Var "C21-env")
    )
    >>
    -- Step 2: disclosure
    ( gen "C20-SelectiveDisclosure" (Var "C18-C20") (Var "C6-C1")
    ⊗ idm                           (Var "C6-C1")
    ⊗ gen "C21-Nullifier"           (Var "C21-env") (Var "C21-env")
    )
    >>
    -- Step 3: submit credential proof on-chain
    gen "C1-AccountCustody"
        (Var "C6-C1" ⊗₀ Var "C6-C1" ⊗₀ Var "C21-env")
        (Var "C1-Chain")

  ------------------------------------------------------------------------
  -- Full passport architecture
  --
  -- All four paths run in parallel (⊗, right-associative).

  passport : HomTerm
    ( Var "User-C9"  ⊗₀ Var "C7-C6"   ⊗₀ Var "dApp-C10" ⊗₀
      Var "User-C9"  ⊗₀ Var "C18-C20" ⊗₀ Var "C18-C20"  ⊗₀ Var "C21-env")
    ( Var "C1-Chain" ⊗₀ Var "C1-Chain" ⊗₀ Var "C1-Chain" ⊗₀ Var "C1-Chain")
  passport = authPath ⊗ grantPath ⊗ recoveryPath ⊗ credentialPath

  ------------------------------------------------------------------------
  -- Identity / signing / custody runtime diagram
  --
  -- Five parallel entry lanes converge through signing and proof
  -- generation into account custody, which fans out to the name service,
  -- DID surface, and the chain boundary.

  identitySigningCustody : HomTerm
    (Var "C16-in"  ⊗₀ Var "User-C9" ⊗₀ Var "C7-C6"  ⊗₀ Var "C17-in"  ⊗₀ Var "C14-in")
    (Var "C2-Chain" ⊗₀ Var "C3-Chain" ⊗₀ Var "C1-Chain")
  identitySigningCustody =
    -- Step 1: five parallel entry components
    ( gen "C16-LocalStorage"        (Var "C16-in")  (Var "C16-keys")
    ⊗ gen "C9-DeviceAuth"           (Var "User-C9") (Var "C9-C5")
    ⊗ gen "C7-WitnessHandling"      (Var "C7-C6")   (Var "C7-C6")
    ⊗ gen "C17-Indexer"             (Var "C17-in")  (Var "C17-state")
    ⊗ ( gen "C14-TotalLossRecovery" (Var "C14-in")  (Var "C14-C15")
        >> gen "C15-HelperProtocol" (Var "C14-C15") (Var "C15-out") )
    )
    >>
    -- Step 2: signing (lanes 1–2) with pass-through (lanes 3–5)
    ( gen "C5-Signing"
          (Var "C16-keys" ⊗₀ Var "C9-C5")
          (Var "C5-C6")
    ⊗ idm (Var "C7-C6" ⊗₀ Var "C17-state" ⊗₀ Var "C15-out")
    )
    >>
    -- Step 3: proof generation (lanes 1–2) with pass-through (lanes 3–4)
    ( gen "C6-ProofGeneration"
          (Var "C5-C6" ⊗₀ Var "C7-C6")
          (Var "C6-C1")
    ⊗ idm (Var "C17-state" ⊗₀ Var "C15-out")
    )
    >>
    -- Step 4: account custody aggregates all remaining channels
    gen "C1-AccountCustody"
        (Var "C6-C1" ⊗₀ Var "C17-state" ⊗₀ Var "C15-out")
        (Var "C1-C2" ⊗₀ Var "C1-C3"    ⊗₀ Var "C1-Chain")
    >>
    -- Step 5: downstream name service, DID surface, and chain pass-through
    ( gen "C2-NameService" (Var "C1-C2") (Var "C2-Chain")
    ⊗ gen "C3-DIDSurface"  (Var "C1-C3") (Var "C3-Chain")
    ⊗ idm                  (Var "C1-Chain")
    )

  ------------------------------------------------------------------------
  -- Full architecture overview

  architecture : HomTerm unit (Var "User")
  architecture =
    ( gen "Midnight DID contract"  unit (Var "TBD")
    ⊗ gen "Name Service"           unit (Var "TBD")
    ⊗ gen "+ peer devices"         unit (Var "TBD SYNC")
    )
    >>
    ( gen "Recovery helpers"       unit (Var "RECOVERY-P5")
    ⊗ gen "Indexer"                unit (Var "READ STATE")
    ⊗ gen "Account custody contract" (Var "TBD" ⊗₀ Var "TBD") (Var "JUBJUB SCHNORR")
    ⊗ gen "Local wallet storage"   (Var "TBD SYNC") (Var "STATE")
    ⊗ gen "Proof server"           unit (Var "WITNESS-IPC")
    )
    >>
    gen "Passport Key"
        ( Var "RECOVERY-P5" ⊗₀ Var "READ STATE" ⊗₀ Var "JUBJUB SCHNORR" ⊗₀ Var "STATE" ⊗₀ Var "WITNESS-IPC" )
        ( Var "User" )
