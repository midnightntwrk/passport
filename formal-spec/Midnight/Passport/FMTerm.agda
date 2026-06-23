------------------------------------------------------------------------
-- Midnight.Passport.FMTerm
--
-- A purely syntactic representation of terms in the free symmetric
-- monoidal category over named string generators.  This type is the
-- export boundary between the architecture layer and the compiler/
-- renderer: it carries enough structure for the Compiler module to
-- serialise and for the Julia renderer to consume, without imposing
-- the full categorical-crypto proof obligations on callers.
--
-- Constructors mirror the generators of a symmetric strict monoidal
-- category (no coherence isomorphisms — strictness is assumed for the
-- rendering target):
--
--   gen  — a named box with typed input/output channel lists
--   idm  — identity on a list of channels
--   _>>_ — sequential composition  (f ; g)
--   _⊗_  — parallel (tensor) composition
--   swap — the symmetry σ_{A,B} exchanging two adjacent channels
------------------------------------------------------------------------

module Midnight.Passport.FMTerm where

open import Data.String using (String)
open import Data.List   using (List)

infixr 9 _>>_
infixr 8 _⊗_

data FMTerm : Set where
  -- Named generator: machine name, input channel names, output channel names.
  gen  : String → List String → List String → FMTerm
  -- Identity morphism on a sequence of channels.
  idm  : List String → FMTerm
  -- Sequential composition: left's outputs must match right's inputs.
  -- (Enforced by well-formedness in the Architecture layer, not here.)
  _>>_ : FMTerm → FMTerm → FMTerm
  -- Parallel (tensor) composition: left and right run side-by-side.
  _⊗_  : FMTerm → FMTerm → FMTerm
  -- Symmetry: swap two adjacent channels a and b  (σ_{a,b}).
  swap : String → String → FMTerm
