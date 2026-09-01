# passport-buss

Maintained fork of [arc-pleiades](https://github.com/input-output-hk/arc-pleiades)
at commit `885254fe`, serving as the reference component of the scheme
layer for the Passport account-recovery MIP (Recovery Paths for Custody
Accounts). The recovery specification is implementable from its own
text and does not normatively depend on this crate; the ANARKey and
traceable-BUSS papers are the normative basis for the scheme, and this
code is evidence that the construction works.

## Delta against upstream

- **Licence field corrected**: upstream's README and LICENSE declare
  Apache-2.0 while its `Cargo.toml` still said MIT; this fork says
  Apache-2.0 everywhere.
- **`v1` module added** (`src/v1.rs`): the recovery MIP's normative
  profile on top of the upstream primitives — a typed 32-byte session
  identifier, the tagged and length-prefixed share derivation
  (`midnight:account:recovery:share:v1`), the Profile A guardian-secret
  derivation from an authenticator PRF output, a zeroising guardian
  secret wrapper, and canonical 32-byte share and phi codecs. The
  TypeScript twin lives in `../src/wallet/recovery.ts`; the
  cross-implementation vectors in `tests/v1_vectors.rs` and the
  `recovery-offline` suite hold the two bit-exact.
- **Benchmarks dropped** from the build (upstream keeps them; they pull
  criterion and are not needed by the reference component).

Everything under `src/bottom_up`, `src/math`, and `src/secret_sharing`
is upstream code, kept diffable against `885254fe`.

## Known limitations, inherited and otherwise

- Field elements (`midnight_curves::Fq`) are `Copy`, so intermediate
  share and secret values cannot be reliably zeroised; the `v1` module
  zeroises the byte forms it owns, and deeper coverage needs upstream
  `zeroize` support in `midnight-curves`.
- The upstream WASM crate is not vendored; the reference contract's
  test client uses the TypeScript implementation instead.
- Unaudited, like its upstream. The recovery MIP's Path to Active gates
  the standard on a commissioned cryptographic review, not on this
  code.

## Provenance

Upstream authors: the arc-pleiades contributors. Fork point
`885254fe`; upstream has been dormant since shortly after that commit.
Licence: Apache-2.0 (see LICENSE).
