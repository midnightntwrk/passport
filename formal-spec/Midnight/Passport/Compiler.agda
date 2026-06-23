------------------------------------------------------------------------
-- Midnight.Passport.Compiler
--
-- Serialises an FMTerm to the JSON schema expected by the Julia
-- Catlab/WiringDiagrams renderer, and provides a `flatten` pass that
-- normalises a term into a flat box-and-wire record before rendering.
--
-- JSON serialisation strategy
-- ───────────────────────────
-- We construct JSON strings directly using Data.String.  Agda has no
-- built-in pretty-printer, so every `renderXxx` function is a plain
-- string concatenation.  The operator `_⟨++⟩_` is our local alias for
-- Data.String._++_ to avoid ambiguity with Data.List._++_.
--
-- Flat normalisation (`flatten`)
-- ──────────────────────────────
-- The `flatten` function walks an FMTerm and assigns each `gen` node a
-- fresh box-id, then threads wires between boxes.  The implementation
-- uses a simple state-like pattern via a `FlatState` accumulator passed
-- explicitly.
------------------------------------------------------------------------

module Midnight.Passport.Compiler where

open import Data.String  as S using (String; _≟_)
open import Data.List    as L using (List; []; _∷_; map; foldr; _++_)
open import Data.Nat     as ℕ using (ℕ; zero; suc)
open import Data.Integer        using (ℤ; +_; -[1+_])
open import Data.Product        using (_×_; _,_)
open import Function            using (case_of_)
open import Relation.Nullary    using (yes; no)

open import Midnight.Passport.FMTerm

-- String concatenation alias (avoids ambiguity with L._++_).
infixr 5 _⟨++⟩_
_⟨++⟩_ : String → String → String
_⟨++⟩_ = S._++_

------------------------------------------------------------------------
-- 0.  Small string utilities
------------------------------------------------------------------------

-- Wrap a string in JSON double-quotes.
quoted : String → String
quoted s = "\"" ⟨++⟩ s ⟨++⟩ "\""

-- Separate a list of already-rendered strings with ", ".
commas : List String → String
commas []            = ""
commas (x ∷ [])     = x
commas (x ∷ y ∷ zs) = x ⟨++⟩ ", " ⟨++⟩ commas (y ∷ zs)

-- Render a list of strings as a JSON array  ["a", "b", ...].
jsonStringArray : List String → String
jsonStringArray xs = "[" ⟨++⟩ commas (map quoted xs) ⟨++⟩ "]"

-- Map a single decimal digit (0–9) to its one-character string.
private
  digitChar : ℕ → String
  digitChar 0 = "0"
  digitChar 1 = "1"
  digitChar 2 = "2"
  digitChar 3 = "3"
  digitChar 4 = "4"
  digitChar 5 = "5"
  digitChar 6 = "6"
  digitChar 7 = "7"
  digitChar 8 = "8"
  digitChar _ = "9"

  -- Decompose n into decimal digits, least-significant first.
  -- The TERMINATING pragma is needed because the termination checker
  -- cannot see that `m ℕ./ 10 < m` without a well-founded proof.
  -- HOLE 0 (optional cleanup): replace with well-founded recursion using
  -- Data.Nat.DivMod, or simply `open import Data.Nat.Show; use show`.
  {-# TERMINATING #-}
  digitsLSF : ℕ → List ℕ
  digitsLSF zero    = 0 ∷ []
  digitsLSF (suc m) =
    let n = suc m
        q = n ℕ./ 10
        r = n ℕ.% 10
    in  r ∷ (case q of λ { zero → [] ; _ → digitsLSF q })

  -- Reverse-concatenate a list of digit characters into a string.
  revJoin : List ℕ → String → String
  revJoin []       acc = acc
  revJoin (d ∷ ds) acc = revJoin ds (digitChar d ⟨++⟩ acc)

-- Render a natural number as a decimal string.
showNat : ℕ → String
showNat n = revJoin (digitsLSF n) ""

-- Render an integer as a decimal string (with leading "-" for negatives).
showInt : ℤ → String
showInt (+ n)      = showNat n
showInt (-[1+ n ]) = "-" ⟨++⟩ showNat (suc n)

------------------------------------------------------------------------
-- 1.  Direct JSON serialisation of FMTerm
------------------------------------------------------------------------

-- `compileFMTerm` maps an FMTerm to its JSON string representation.
-- Schema:
--
--   gen  → { "type": "gen",  "name": "…", "inputs": […], "outputs": […] }
--   idm  → { "type": "id",   "channels": […] }
--   _>>_ → { "type": "seq",  "left": <…>, "right": <…> }
--   _⊗_  → { "type": "par",  "left": <…>, "right": <…> }
--   swap → { "type": "swap", "first": "…", "second": "…" }

compileFMTerm : FMTerm → String
compileFMTerm (gen name ins outs) =
  "{ \"type\": \"gen\", \"name\": "  ⟨++⟩ quoted name         ⟨++⟩
  ", \"inputs\": "  ⟨++⟩ jsonStringArray ins                   ⟨++⟩
  ", \"outputs\": " ⟨++⟩ jsonStringArray outs                  ⟨++⟩
  " }"
compileFMTerm (idm chans) =
  "{ \"type\": \"id\", \"channels\": " ⟨++⟩ jsonStringArray chans ⟨++⟩ " }"
compileFMTerm (l >> r) =
  "{ \"type\": \"seq\", \"left\": "  ⟨++⟩ compileFMTerm l ⟨++⟩
  ", \"right\": " ⟨++⟩ compileFMTerm r ⟨++⟩ " }"
compileFMTerm (l ⊗ r) =
  "{ \"type\": \"par\", \"left\": "  ⟨++⟩ compileFMTerm l ⟨++⟩
  ", \"right\": " ⟨++⟩ compileFMTerm r ⟨++⟩ " }"
compileFMTerm (swap a b) =
  "{ \"type\": \"swap\", \"first\": " ⟨++⟩ quoted a ⟨++⟩
  ", \"second\": " ⟨++⟩ quoted b ⟨++⟩ " }"

------------------------------------------------------------------------
-- 2.  Flat wiring-diagram representation
------------------------------------------------------------------------

-- A single box in the wiring diagram.
record BoxJSON : Set where
  constructor mkBox
  field
    id      : ℕ       -- unique box identifier (1-based; 0 is reserved)
    name    : String
    inputs  : List String
    outputs : List String

-- A wire connecting two ports.
-- Port addressing convention (following Catlab/WiringDiagrams):
--   fromBox / toBox = + 0  → the diagram's outer input interface
--                   = -1   → the diagram's outer output interface
--                   = + k  → box with id k  (k ≥ 1)
record WireJSON : Set where
  constructor mkWire
  field
    fromBox  : ℤ
    fromPort : ℕ
    toBox    : ℤ
    toPort   : ℕ

-- The top-level wiring diagram record.
record WiringDiagramJSON : Set where
  constructor mkDiagram
  field
    inputs  : List String
    outputs : List String
    boxes   : List BoxJSON
    wires   : List WireJSON

------------------------------------------------------------------------
-- 3.  Flatten: FMTerm → WiringDiagramJSON
------------------------------------------------------------------------

-- Internal state threaded through the flattening pass.
-- `nextId`  — next available box identifier (starts at 1).
-- `boxes`   — accumulated boxes (cons-order; reverse before emitting).
-- `wires`   — accumulated wires (cons-order).
-- `portMap` — association list: channel name → (producing box-id, port-index).
--             Box-id + 0 means "outer input interface".
record FlatState : Set where
  constructor mkFlatState
  field
    nextId  : ℕ
    boxes   : List BoxJSON
    wires   : List WireJSON
    portMap : List (String × (ℤ × ℕ))

private

  -- Allocate a fresh box id, incrementing the counter.
  freshId : FlatState → ℕ × FlatState
  freshId (mkFlatState n bs ws pm) = n , mkFlatState (suc n) bs ws pm

  -- Pair each element of a list with its zero-based index.
  zipWithIndex : {A : Set} → List A → List (A × ℕ)
  zipWithIndex {A} = go 0
    where
    go : ℕ → List A → List (A × ℕ)
    go _ []       = []
    go i (x ∷ xs) = (x , i) ∷ go (suc i) xs

  -- Look up the producer of a named channel in the port map.
  -- Returns (outer-input-boundary, port 0) when the channel is not found,
  -- which makes unbound inputs appear to originate from the diagram boundary.
  lookupPort : String → List (String × (ℤ × ℕ)) → ℤ × ℕ
  lookupPort _ []              = + 0 , 0
  lookupPort c ((k , v) ∷ pm) with c ≟ k
  ... | yes _ = v
  ... | no  _ = lookupPort c pm

  -- Replace the entry for key k with a new value; append if absent.
  updatePM : String → (ℤ × ℕ) → List (String × (ℤ × ℕ)) → List (String × (ℤ × ℕ))
  updatePM k v [] = (k , v) ∷ []
  updatePM k v ((k' , v') ∷ pm) with k ≟ k'
  ... | yes _ = (k , v) ∷ pm
  ... | no  _ = (k' , v') ∷ updatePM k v pm

  -- Extend the port map with all outputs of a just-added box.
  bindOutputs : ℕ → List String → List (String × (ℤ × ℕ))
              → List (String × (ℤ × ℕ))
  bindOutputs boxId outs pm =
    map (λ { (ch , i) → ch , (+ boxId , i) }) (zipWithIndex outs) ++ pm

  -- Wire the input ports of box `boxId` to their producers.
  addInputWires : ℕ → List String → FlatState → FlatState
  addInputWires boxId ins s = foldr go s (zipWithIndex ins)
    where
      go : String × ℕ → FlatState → FlatState
      go (ch , i) s' =
        let (srcBox , srcPort) = lookupPort ch (FlatState.portMap s')
            w = mkWire srcBox srcPort (+ boxId) i
        in  mkFlatState (FlatState.nextId s') (FlatState.boxes s') (w ∷ FlatState.wires s') (FlatState.portMap s')

-- Populate the initial port map from the diagram's outer inputs.
outerInputPortMap : List String → List (String × (ℤ × ℕ))
outerInputPortMap ins = map (λ { (ch , i) → ch , (+ 0 , i) }) (zipWithIndex ins)

-- Wire the diagram's outer outputs back to their producers.
addOutputWires : List String → FlatState → FlatState
addOutputWires outs s = foldr go s (zipWithIndex outs)
  where
    go : String × ℕ → FlatState → FlatState
    go (ch , i) s' =
      let (srcBox , srcPort) = lookupPort ch (FlatState.portMap s')
          w = mkWire srcBox srcPort (-[1+ 0 ]) i
      in  mkFlatState (FlatState.nextId s') (FlatState.boxes s') (w ∷ FlatState.wires s') (FlatState.portMap s')

-- Walk an FMTerm, threading a FlatState.
-- Returns (updated-state, output-channel-names).
flattenTerm : FMTerm → FlatState → FlatState × List String

flattenTerm (gen name ins outs) s =
  let (bid , s₁) = freshId s
      b     = mkBox bid name ins outs
      -- Record the box, wire its inputs, bind its outputs in the port map.
      s₂    = mkFlatState (FlatState.nextId s₁)
                          (b ∷ FlatState.boxes s₁)
                          (FlatState.wires   s₁)
                          (FlatState.portMap s₁)
      s₃    = addInputWires bid ins s₂
      s₄    = mkFlatState (FlatState.nextId s₃)
                          (FlatState.boxes   s₃)
                          (FlatState.wires   s₃)
                          (bindOutputs bid outs (FlatState.portMap s₃))
  in  s₄ , outs

flattenTerm (idm chans) s =
  -- Identity: pass-through, no new box, outputs = inputs.
  s , chans

flattenTerm (l >> r) s =
  -- Sequential: flatten l, then r in l's resulting state.
  let (s₁ , _)     = flattenTerm l s
      (s₂ , rOuts) = flattenTerm r s₁
  in  s₂ , rOuts

flattenTerm (l ⊗ r) s =
  -- Parallel: flatten l then r (channel names must be disjoint).
  let (s₁ , lOuts) = flattenTerm l s
      (s₂ , rOuts) = flattenTerm r s₁
  in  s₂ , (lOuts L.++ rOuts)

flattenTerm (swap a b) s =
  let pm  = FlatState.portMap s
      va  = lookupPort a pm
      vb  = lookupPort b pm
      pm' = updatePM a vb (updatePM b va pm)
  in  mkFlatState (FlatState.nextId s) (FlatState.boxes s) (FlatState.wires s) pm' , (b ∷ a ∷ [])

-- Flatten with an explicit outer interface.  Preferred entry point.
flattenWithInterface : List String   -- outer input channels
                     → List String   -- outer output channels
                     → FMTerm
                     → WiringDiagramJSON
flattenWithInterface ins outs term =
  let s₀        = mkFlatState 1 [] [] (outerInputPortMap ins)
      (sf , _)  = flattenTerm term s₀
      sf'       = addOutputWires outs sf
  in  mkDiagram ins outs (FlatState.boxes sf') (FlatState.wires sf')

-- Convenience wrapper with empty outer interfaces.
-- Use `flattenWithInterface` when the diagram-level channels are known.
flatten : FMTerm → WiringDiagramJSON
flatten = flattenWithInterface [] []

------------------------------------------------------------------------
-- 4.  Render WiringDiagramJSON → String
------------------------------------------------------------------------

renderBoxJSON : BoxJSON → String
renderBoxJSON b =
  "{ \"id\": "      ⟨++⟩ showNat (BoxJSON.id b)              ⟨++⟩
  ", \"name\": "    ⟨++⟩ quoted  (BoxJSON.name b)             ⟨++⟩
  ", \"inputs\": "  ⟨++⟩ jsonStringArray (BoxJSON.inputs b)   ⟨++⟩
  ", \"outputs\": " ⟨++⟩ jsonStringArray (BoxJSON.outputs b)  ⟨++⟩
  " }"

renderWireJSON : WireJSON → String
renderWireJSON w =
  "{ \"fromBox\": "  ⟨++⟩ showInt (WireJSON.fromBox  w) ⟨++⟩
  ", \"fromPort\": " ⟨++⟩ showNat (WireJSON.fromPort w) ⟨++⟩
  ", \"toBox\": "    ⟨++⟩ showInt (WireJSON.toBox    w) ⟨++⟩
  ", \"toPort\": "   ⟨++⟩ showNat (WireJSON.toPort   w) ⟨++⟩
  " }"

renderWiringDiagram : WiringDiagramJSON → String
renderWiringDiagram d =
  "{ \"inputs\": "  ⟨++⟩ jsonStringArray (WiringDiagramJSON.inputs  d)         ⟨++⟩
  ", \"outputs\": " ⟨++⟩ jsonStringArray (WiringDiagramJSON.outputs d)         ⟨++⟩
  ", \"boxes\": ["  ⟨++⟩ commas (map renderBoxJSON  (WiringDiagramJSON.boxes d)) ⟨++⟩ "]" ⟨++⟩
  ", \"wires\": ["  ⟨++⟩ commas (map renderWireJSON (WiringDiagramJSON.wires d)) ⟨++⟩ "]" ⟨++⟩
  " }"

------------------------------------------------------------------------
-- 5.  Convenience entry points
------------------------------------------------------------------------

-- Emit the recursive term-tree JSON (for debugging / round-tripping).
compileToJSON : FMTerm → String
compileToJSON = compileFMTerm

-- Emit the flat wiring-diagram JSON expected by the Julia renderer.
compileToWiringDiagramJSON : List String → List String → FMTerm → String
compileToWiringDiagramJSON ins outs t =
  renderWiringDiagram (flattenWithInterface ins outs t)

-- Emit a flat wiring-diagram JSON object with a leading "name" field.
-- Use this when bundling multiple diagrams into a JSON array.
compileNamedDiagram : String → List String → List String → FMTerm → String
compileNamedDiagram n ins outs t =
  let d = flattenWithInterface ins outs t
  in  "{ \"name\": "    ⟨++⟩ quoted n                                                ⟨++⟩
      ", \"inputs\": "  ⟨++⟩ jsonStringArray (WiringDiagramJSON.inputs  d)            ⟨++⟩
      ", \"outputs\": " ⟨++⟩ jsonStringArray (WiringDiagramJSON.outputs d)            ⟨++⟩
      ", \"boxes\": ["  ⟨++⟩ commas (map renderBoxJSON  (WiringDiagramJSON.boxes d)) ⟨++⟩ "]" ⟨++⟩
      ", \"wires\": ["  ⟨++⟩ commas (map renderWireJSON (WiringDiagramJSON.wires d)) ⟨++⟩ "]" ⟨++⟩
      " }"
