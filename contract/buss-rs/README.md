# passport-buss

The Passport account-recovery v1 profile over
[arc-pleiades](https://github.com/input-output-hk/arc-pleiades), the
upstream BUSS / ANARKey secret-sharing library over BLS12-381. The
upstream crate is a git dependency pinned to commit `ae179e7e`: the
revision the recovery MIP (Recovery Paths for Custody Accounts) was
validated against (`885254fe`) plus the manifest licence fix we
contributed upstream. It is not forked or vendored here.

The recovery specification is implementable from its own text and does
not normatively depend on this crate or on upstream; the ANARKey and
traceable-BUSS papers are the normative basis for the scheme, and this
code is evidence that the construction works.

## What this crate adds

- **`v1` module** (`src/v1.rs`): the recovery MIP's normative profile on
  top of the upstream primitives, namely a typed 32-byte session
  identifier, the tagged and length-prefixed share derivation
  (`midnight:account:recovery:share:v1`), the Profile A guardian-secret
  derivation from an authenticator PRF output, a zeroising guardian
  secret wrapper, and canonical 32-byte share and phi codecs. The
  TypeScript twin lives in `../src/wallet/recovery.ts`.
- **Cross-implementation vectors** (`tests/v1_vectors.rs`): the Rust and
  TypeScript implementations must derive identical bytes for identical
  inputs; the `recovery-offline` suite asserts the same constants on the
  other side, and one test runs v1-derived shares through the upstream
  split and reconstruct.
- **Re-export** of the pinned upstream crate as `passport_buss::arc_pleiades`,
  so a consumer gets the scheme at the validated revision.

## Running

```sh
cargo test
```

## Known limitations

- Field elements (`midnight_curves::Fq`) are `Copy`, so intermediate
  share and secret values cannot be reliably zeroised; the `v1` module
  zeroises the byte forms it owns, and deeper coverage needs `zeroize`
  support in `midnight-curves`.
- Upstream is unaudited and has been dormant since shortly after the
  pinned commit. The recovery MIP's Path to Active gates the standard on
  a commissioned cryptographic review, not on this code.
