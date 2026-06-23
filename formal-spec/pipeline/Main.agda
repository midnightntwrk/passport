------------------------------------------------------------------------
-- Midnight.Passport pipeline entry point
--
-- Compiles the full passport architecture to the flat wiring-diagram JSON
-- expected by the Catlab renderer and prints it to stdout.
--
-- Compile with the GHC backend (from formal-spec/):
--
--   agda --compile --ghc-flag=-O0 --ghc-flag=-o --ghc-flag=./passport-compiler \
--     pipeline/Main.agda
--   ./passport-compiler > /tmp/passport.json
--
-- The outer input/output port lists below enumerate every channel that
-- enters or leaves the full `passport` term when flattened left-to-right.
------------------------------------------------------------------------

{-# OPTIONS --guardedness #-}

module pipeline.Main where

open import IO
open import Data.List   using (List; _∷_; [])
open import Data.String using (String)

open import Midnight.Passport.Architecture
open import Midnight.Passport.Compiler

-- Channels consumed before being produced in the full `passport` term.
-- "User-C9" appears in both authPath (C9-DeviceAuth) and recoveryPath
-- (C14-TotalLossRecovery); both fan out from outer input port 0.
passportIns : List String
passportIns =
  "User-C9"  ∷  -- auth and recovery entry point
  "C7-C6"    ∷  -- C7-WitnessHandling (consumed before C7 produces it)
  "dApp-C10" ∷  -- grant path entry
  "C18-C20"  ∷  -- C18-AttestationTree input
  "C21-env"  ∷  -- C21-Nullifier environment
  []

passportOuts : List String
passportOuts = "C1-Chain" ∷ []

main : Main
main = run (putStrLn (compileToWiringDiagramJSON passportIns passportOuts passport))
