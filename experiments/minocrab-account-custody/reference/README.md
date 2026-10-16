# Pinned comparison oracle

The Compact contracts, wallet ABI/signers, and software-authenticator fixture
listed in `provenance.json` are byte-for-byte copies from passport commit
`0d7bb0bc834f2d45d9fe2d84c4d022a30d648423` (the current main reference when this
experiment was updated). This is the 52-entrypoint, `spec_version = 3` account,
including caller-bound grants, recovery, and P256 WebAuthn alongside JubJub/k256.

This snapshot is test input. Do not optimise it alongside the native port:
the unchanged oracle allows an independent differential comparison.

From the experiment directory, `npm run compile:reference` uses Compact 0.35.0
to generate the ignored `contracts/managed/account` tree and checks all 52 ZKIR
hashes against `provenance.json`. The npm lockfile pins Compact runtime 0.20.0.
The Rust harness loads these original ZKIR 3.1 artifacts with `midnight-zkir`
3.1.0-rc.1 at `e82d81d25aabcc5f5092e2bd559083487f577914`, the backend revision
bundled with Compact 0.35.0. No localnet is needed for this offline comparison.
