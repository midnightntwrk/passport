------------------------------------------------------------------------
-- Midnight.Passport.FMTerm
--
-- The free strict symmetric monoidal category over named channel
-- generators, backed by categorical-crypto's
-- Categories.FreeStrictMonoidal library.
--
-- Objects (ObjTerm) are an opaque wrapper around List String
-- (channel names).  Tensoring (_⊗₀_) equals list concatenation.
-- Client modules that need access to the underlying List String —
-- e.g. the Compiler — should open an
--   opaque unfolding ObjTerm _⊗₀_ unit Var
-- block.  Architecture modules build terms using Var and _⊗₀_ for
-- objects; the opaque wrapping prevents external breakage.
--
-- Public interface
-- ────────────────
--   ObjTerm, _⊗₀_, unit, Var   — object language (from library)
--   Label                       — generator record { name : String }
--   HomTerm                     — morphism type (library's)
--   var, id, _∘_, _⊗₁_, σ      — raw library constructors
--   λ⇒, λ⇐, ρ⇒, ρ⇐, α⇒, α⇐   — coherence constructors
--   gen, idm, _>>_, _⊗_, swap  — convenience constructors
------------------------------------------------------------------------

module Midnight.Passport.FMTerm where

open import Categories.FreeStrictMonoidal using (module FreeMonoidalHelper)
open import Categories.FreeMonoidal       using (Symm; _≤_; v≤v)
open import Data.String using (String)
open import Data.List   using (List)

------------------------------------------------------------------------
-- Instantiate the library at (Symm, String)

-- Exposed (not private) so sibling modules can instantiate `H.Mor` at a
-- different morphism-generator type while sharing this exact object language.
module H = FreeMonoidalHelper Symm String

open H public using (ObjTerm; _⊗₀_; unit; Var)

------------------------------------------------------------------------
-- Generator type
--
-- A named morphism generator.  The domain A and codomain B are carried
-- entirely as type indices; only the human-readable name is stored.

record Label (A B : ObjTerm) : Set where
  constructor mkLabel
  field name : String

------------------------------------------------------------------------
-- HomTerm and all its constructors

open H.Mor Label public
  using (HomTerm; var; id; _∘_; _⊗₁_; σ; λ⇒; λ⇐; ρ⇒; ρ⇐; α⇒; α⇐)

------------------------------------------------------------------------
-- Symmetry instance — resolves the ⦃ Symm ≤ Symm ⦄ constraint on σ

instance
  symm-inst : Symm ≤ Symm
  symm-inst = v≤v

------------------------------------------------------------------------
-- Convenience aliases preserving the old FMTerm calling conventions

-- Left-to-right sequential composition.
-- The library uses right-to-left order (_∘_), so _>>_ = flip _∘_.
infixr 9 _>>_
_>>_ : ∀ {A B C : ObjTerm} → HomTerm A B → HomTerm B C → HomTerm A C
f >> g = g ∘ f

-- Tensor product (alias for _⊗₁_).
infixr 8 _⊗_
_⊗_ : ∀ {A B C D : ObjTerm}
    → HomTerm A B → HomTerm C D → HomTerm (A ⊗₀ C) (B ⊗₀ D)
_⊗_ = _⊗₁_

-- Identity on an explicit object.
idm : (a : ObjTerm) → HomTerm a a
idm _ = id

-- Symmetry with explicit objects.
swap : (a b : ObjTerm) → HomTerm (a ⊗₀ b) (b ⊗₀ a)
swap _ _ = σ

------------------------------------------------------------------------
-- gen — lift a named component into a morphism
--
-- ins and outs are ObjTerm values; callers build them with Var / _⊗₀_.

gen : (n : String) (ins outs : ObjTerm) → HomTerm ins outs
gen n ins outs = var (mkLabel n)
