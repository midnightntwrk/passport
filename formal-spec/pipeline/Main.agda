------------------------------------------------------------------------
-- Midnight.Passport pipeline entry point
--
-- Compiles the architecture diagrams to Julia source that rebuilds each
-- diagram via Catlab's symmetric-monoidal combinators, binding a
-- `DIAGRAMS` vector of "name" => WiringDiagram pairs.  The outer
-- interface is derived from each term's FreeSMC type indices.
--
-- Compile with the GHC backend (from formal-spec/):
--
--   agda --compile --ghc-flag=-O0 --ghc-flag=-o --ghc-flag=./passport-compiler \
--     pipeline/Main.agda
--   ./passport-compiler > /tmp/diagrams.jl
------------------------------------------------------------------------

{-# OPTIONS --guardedness #-}

module pipeline.Main where

open import IO
open import Data.String using (String; _++_)

open import Midnight.Passport.Architecture
open import Midnight.Passport.Compiler

main : Main
main = run (putStrLn (wrapJuliaDiagrams (
  compileNamedDiagram "architecture" architecture
  -- ++ ",\n" ++ compileNamedDiagram "passport" passport
  -- ++ ",\n" ++ compileNamedDiagram "identity-signing-custody" identitySigningCustody
  )))
