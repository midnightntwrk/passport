------------------------------------------------------------------------
-- Midnight.Passport pipeline entry point
--
-- Compiles the full passport architecture and the identity/signing/
-- custody runtime diagram to flat wiring-diagram JSON, emitting a
-- JSON array to stdout.  Each element carries a "name" field so the
-- renderer can write one SVG per diagram.
--
-- Compile with the GHC backend (from formal-spec/):
--
--   agda --compile --ghc-flag=-O0 --ghc-flag=-o --ghc-flag=./passport-compiler \
--     pipeline/Main.agda
--   ./passport-compiler > /tmp/diagrams.json
------------------------------------------------------------------------

{-# OPTIONS --guardedness #-}

module pipeline.Main where

open import IO
open import Data.List   using (List; _∷_; [])
open import Data.String using (String; _++_)

open import Midnight.Passport.Architecture
open import Midnight.Passport.Compiler

-- ── Passport (four-path architecture diagram) ────────────────────────

passportIns : List String
passportIns =
  "User-C9"  ∷  -- auth and recovery entry point
  "C7-C6"    ∷  -- C7-WitnessHandling input
  "dApp-C10" ∷  -- grant path entry
  "C18-C20"  ∷  -- C18-AttestationTree input
  "C21-env"  ∷  -- C21-Nullifier environment
  []

passportOuts : List String
passportOuts = "C1-Chain" ∷ []

-- ── Identity / signing / custody (runtime diagram) ───────────────────

identityIns : List String
identityIns =
  "C16-in"  ∷  -- C16-LocalStorage input
  "User-C9" ∷  -- C9-DeviceAuth input
  "C7-C6"   ∷  -- C7-WitnessHandling input
  "C17-in"  ∷  -- C17-Indexer input
  "C14-in"  ∷  -- C14-TotalLossRecovery input
  []

identityOuts : List String
identityOuts = "C2-Chain" ∷ "C3-Chain" ∷ "C1-Chain" ∷ []

-- ── Main: emit a JSON array of both diagrams ─────────────────────────

main : Main
main = run (putStrLn (
  "[ " ++ compileNamedDiagram "passport" passportIns passportOuts passport
  ++ ", " ++ compileNamedDiagram "identity-signing-custody" identityIns identityOuts identitySigningCustody
  ++ " ]"))
