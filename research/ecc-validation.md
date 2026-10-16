# Elliptic-curve point and cryptographic key validation in Midnight

## 1. Executive summary

The findings below explain where point and key validation affects correctness or secrecy. Each finding links to the detailed code evidence and distinguishes tested behavior from unresolved integration questions.

This review follows elliptic-curve data through **Compact** (the contract language
and its runtime), **ZKIR** (the intermediate representation that evaluates and
compiles contract operations), **Midnight ZK** (the underlying circuit and proof
libraries), and **Ledger** (including signature verification and coin encryption).
The exact versions and dependency relationships are recorded in [§2.1](#21-which-dependency-versions-were-actually-analysed).
Midnight ZK has separate package versions: the independent backend checks use
circuits **7.2.4**, curves **0.3.1**, proofs **0.8.3**, and stdlib **2.3.5**;
Compact's v3 ZKIR is **3.1.0-rc.1** and uses proofs **0.8.2**. Both proof-library
versions were tested with the same coordinate-validation circuit.

The main findings are:

1. **Midnight ZK can interpret an incorrectly written Jubjub point as a valid
   point, but its coordinate-construction circuit rejects that input.** A point
   is supplied as two numbers, `x` and `y`. The shared reconstruction helper checks
   only whether `x` is even or odd, so changing `x` by two can leave the interpreted
   point unchanged. This concerns generic point representations used by ZKIR,
   rather than one particular signature or encryption key. Tests confirm the
   discrepancy, and also confirm that a proof made with the altered coordinates
   fails verification. See [§3.2](#32-jubjub-points)
   for the distinct evaluator and circuit paths and [§7.1](#71-completed-executable-checks)
   for the tests.
2. **Ledger's coin-encryption API accepts a recipient public key that provides
   no secrecy.** The identity point is the curve's neutral element. Importing a
   zero encryption secret key produces that public key, and encrypting to it makes
   the masking value publicly computable. A test recovers the plaintext without
   using a secret. Ledger 9's WASM output-construction source also forwards an
   imported recipient encryption key to this API. This does not establish that
   a wallet normally generates such a key or that a deployed wallet accepts it.
   See [§5](#5-encryption-schemes), especially
   [§5.1.3](#513-wasm-and-transaction-construction-entry-points), and [§7.1](#71-completed-executable-checks).
3. **Compact and Ledger apply different rules to Jubjub signature announcements.**
   An announcement is the point carried inside a signature, distinct from the
   signer's public key. Compact's displayed verification relation rejects an
   identity signer public key but has no explicit identity-announcement rejection;
   Ledger 9's native signature verifier rejects both. Tests demonstrate the
   algebraic relation and the native rejection; a compiled Compact signature test
   remains outstanding. See [§4](#4-signature-schemes).
4. **Proof verification keys have a separate, delayed validation boundary.** These
   keys tell the proof system how to check a proof; they are not signer or encryption
   public keys. Ledger 8.1.2 and Ledger 9 rc.5 initially retain their bytes and reject
   trailing bytes only when the key is initialized. The pinned Ledger `main`
   snapshot lacks that rejection. The released Midnight ZK reader itself accepts a
   valid key prefix and leaves trailing bytes to its caller. See
   [§6.4](#64-proof-system-keys-and-kzg-commitments-on-bls12-381).
5. **Compact's runtime checks depend on the curve type.** Its Jubjub representation
   checks number ranges without establishing curve membership. Its foreign-curve
   validators check the curve equation, and Curve25519 additionally checks subgroup
   membership. Generic point APIs permit the identity point; whether it is safe as
   a key requires a separate check for that use. See [§3](#3-elliptic-curve-point-declaration-deserialization-and-encoding)
   and the terminology in [§2.2](#22-what-validation-means).

The priorities are to check both coordinates in the shared Jubjub helper, reject
zero/identity encryption keys at import and encryption boundaries, and define a
consistent signature-announcement policy. [§7](#7-validation-results-and-remaining-work)
separates completed tests from the remaining integration checks. These findings
do not demonstrate a successful proof forgery or establish deployment severity.

Document navigation:

- [2. Scope, versions, and evidence method](#2-scope-versions-and-evidence-method)
- [3. Elliptic curve point declaration, de/serialization and encoding](#3-elliptic-curve-point-declaration-deserialization-and-encoding)
- [4. Signature schemes](#4-signature-schemes)
- [5. Encryption schemes](#5-encryption-schemes)
- [6. Other cryptographic schemes](#6-other-cryptographic-schemes)
- [7. Validation results and remaining work](#7-validation-results-and-remaining-work)

## 2. Scope, versions, and evidence method

This section fixes the repositories, releases, and evidence used throughout the review. It also defines the different kinds of validation, so a successful point decoder is not mistaken for a safe signature or encryption key importer.

Reviewed on **7 October 2026**. Repository revisions were inspected through
isolated source snapshots; the user's working branches were not changed.
Release tags and Compact's locked dependencies were resolved before pinning.
Ledger “main” below means the fixed snapshot, not a promise about future code.
Standalone ZKIR is pinned to Compact's **zkir-3.1.0-rc.1** dependency. The independent Midnight ZK review uses the latest
stable component releases, not Midnight ZK `main`.

| Component | Immutable revision |
|---|---|
| Compact | [`0e7a4b677d0b0aa0b03727604d4f5e80e765d588`](https://github.com/LFDT-Minokawa/compact/commit/0e7a4b677d0b0aa0b03727604d4f5e80e765d588) |
| Ledger 8.1.2 | [`36d7442172136758e33009f75ff4aa56616cff40`](https://github.com/midnightntwrk/midnight-ledger/commit/36d7442172136758e33009f75ff4aa56616cff40) |
| Ledger 9 rc.5 | [`67f9f97246339539af0091c4d8c6bc5ab236a191`](https://github.com/midnightntwrk/midnight-ledger/commit/67f9f97246339539af0091c4d8c6bc5ab236a191) |
| Ledger main | [`730dba0875e75bb317e3ac81200326ef634249be`](https://github.com/midnightntwrk/midnight-ledger/commit/730dba0875e75bb317e3ac81200326ef634249be) |
| standalone ZKIR **3.1.0-rc.1** (`zkir-3.1.0-rc.1`, Compact v3 dependency) | [`e82d81d25aabcc5f5092e2bd559083487f577914`](https://github.com/midnightntwrk/midnight-zkir/commit/e82d81d25aabcc5f5092e2bd559083487f577914) |
| Midnight ZK: **circuits 7.2.4 / stdlib 2.3.5** (latest stable) | [`cfa6250fda094bc62ddd2050c001024052624173`](https://github.com/midnightntwrk/midnight-zk/commit/cfa6250fda094bc62ddd2050c001024052624173) |
| Midnight ZK: **curves 0.3.1** (latest stable) | [`64f5d8b7099079ac6c7f8d53723e559cdf9f56d3`](https://github.com/midnightntwrk/midnight-zk/commit/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3) |
| Midnight ZK: **proofs 0.8.3** (latest stable; released 1 October 2026) | [`98d1e96444b0392beb7b50b514efb8f87ae6d265`](https://github.com/midnightntwrk/midnight-zk/commit/98d1e96444b0392beb7b50b514efb8f87ae6d265) |

This combines source review, backend constraint/proof tests, and Ledger native
API tests. It does not exercise a compiled Compact contract or a deployed wallet. Implementation claims below have immutable file/line links; security-sensitive
claims also retain literal code excerpts. Routine API and version details are summarized in tables with source links.
Code for unsafe behavior, missing checks, and the decisive validation guards
remains visible; longer supporting version and encoding evidence is expandable.
Shortened excerpts have links to their exact lines and to the full source.
Interpretation and recommendations are stated separately. Mathematical requirements are not presented as observed
implementation behavior.

### 2.1. Which dependency versions were actually analysed?

This dependency trace identifies the actual ZKIR and Midnight ZK packages used by each consumer. It separates the independent backend assessment from comparisons that depend on a particular Ledger release.

Midnight ZK is a repository of **independently versioned crates**; consumers do
not select a single umbrella `midnight-zk` version. This review therefore records
circuits, curves, proofs, and stdlib separately. The latest stable versions were
checked against the official registry on **7 October 2026**:
[circuits 7.2.4](https://crates.io/crates/midnight-circuits/7.2.4),
[curves 0.3.1](https://crates.io/crates/midnight-curves/0.3.1),
[proofs 0.8.3](https://crates.io/crates/midnight-proofs/0.8.3), and
[stdlib 2.3.5](https://crates.io/crates/midnight-zk-stdlib/2.3.5).
“Latest” here means highest stable, non-yanked version, including the current
0.3 curve generation rather than the separately maintained 0.2 line.

**The versions differ across consumers.** Following the requested fallback,
the independent Midnight ZK assessment uses those latest stable releases. The
historical Ledger comparisons retain their exact locked versions so release
findings are not attributed to a different backend. The Jubjub reproduction
uses circuits 7.2.4 / curves 0.3.1, which are both the latest stable releases and
the exact Compact-v3 / Ledger-9-v3 / standalone-ZKIR dependencies. The backend test suite was run with both proofs 0.8.3 and 0.8.2; those consumers
actually lock proofs 0.8.2. No claim is made that they already use 0.8.3.

| Consumer / source snapshot | ZKIR source version | Circuits | Curves | Proofs | ZK stdlib |
|---|---|---|---|---|---|
| Compact v3: standalone ZKIR release | [`3.1.0-rc.1`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/Cargo.toml#L1-L3) | [`7.2.4`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1692-L1693) | [`0.3.1`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1717-L1718) | [`0.8.2`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1747-L1748) | [`2.3.5`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1869-L1870) |
| Compact v2: Ledger 9 rc.3 package | [`2.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/zkir/Cargo.toml#L1-L3) | [`7.2.1`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/Cargo.lock#L3038-L3039) | [`0.3.1`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/Cargo.lock#L3109-L3110) | [`0.8.1`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/Cargo.lock#L3382-L3383) | [`2.3.1`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/Cargo.lock#L3660-L3661) |
| Ledger 8.1.2: v2 crate | [`2.1.1`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir/Cargo.toml#L1-L3) | [`6.1.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2834-L2835) | [`0.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2876-L2877) | [`0.7.1`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L3121-L3122) | [`1.1.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L3290-L3291) |
| Ledger 8.1.2: v3 crate | [`3.0.0-rc.1`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir-v3/Cargo.toml#L1-L3) | [`6.1.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2834-L2835) | [`0.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2876-L2877) | [`0.7.1`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L3121-L3122) | [`1.1.0`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L3290-L3291) |
| Ledger 9 rc.5: v2 crate | [`2.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir/Cargo.toml#L1-L3) | [`7.2.4`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3015-L3016) | [`0.3.1`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3086-L3087) | [`0.8.2`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3360-L3361) | [`2.3.5`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3638-L3639) |
| Ledger 9 rc.5: v3 crate | [`3.0.0`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/Cargo.toml#L1-L3) | [`7.2.4`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3015-L3016) | [`0.3.1`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3086-L3087) | [`0.8.2`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3360-L3361) | [`2.3.5`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3638-L3639) |
| Ledger main: v2 crate | [`2.1.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir/Cargo.toml#L1-L3) | [`6.0.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2705-L2706) | [`0.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2747-L2748) | [`0.7.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2989-L2990) | [`1.0.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L3158-L3159) |
| Ledger main: v3 crate | [`3.0.0-rc.1`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir-v3/Cargo.toml#L1-L3) | [`6.0.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2705-L2706) | [`0.2.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2747-L2748) | [`0.7.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2989-L2990) | [`1.0.0`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L3158-L3159) |

Ledger 9's v1 compatibility dependencies are additional to its v2/v3 rows:
circuits **6.3.0**, curves **0.2.1**, proofs **0.7.3**, stdlib **1.3.0**, as shown
in its dependency declarations and lockfile sources below. Compact's v2 rc.3
row is a dependency trace, not an additional claim that its entire older
implementation received the same security review as rc.5.

Compact's declared ZKIR inputs are explicit:

<details>
<summary>Dependency-resolution sources and manifest excerpts</summary>

Full source: [Compact input declarations: `flake.nix:26–47`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/flake.nix#L26-L47).

Source: [relevant lines 26–30](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/flake.nix#L26-L30).

```nix
    zkir = {
      # zkir key-generation binary for ZKIR 2
      url = "github:midnightntwrk/midnight-ledger/ledger-9.1.0.0-rc.3"; # zkir-v2
      inputs.nixpkgs.follows = "nixpkgs-zkir";
    };
```

Source: [relevant lines 39–43](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/flake.nix#L39-L43).

```nix
    zkir-v3 = {
      # zkir-v3 key-generation binary for v3 IR format
      url = "github:midnightntwrk/midnight-zkir/zkir-3.1.0-rc.1"; # zkir-v3
      inputs.nixpkgs.follows = "nixpkgs-zkir";
    };
```

Source: [Compact resolved dependency: `flake.lock:1391–1415`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/flake.lock#L1391-L1415).

Source: [Compact resolved dependency: `flake.lock:1322–1345`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/flake.lock#L1322-L1345).

The v2 binary exported by the rc.3 Ledger flake is built from that Ledger
snapshot's local workspace and Cargo.lock. Its nested `zkir` input for Ledger's
own precompile build is not a replacement for this exported binary:

Full source: [Compact v2 exported package: `flake.nix:412–423`](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/flake.nix#L412-L423).

Source: [relevant lines 412–416](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/flake.nix#L412-L416).

```nix
              pname = "zkir";
              version = (builtins.fromTOML (builtins.readFile ./zkir/Cargo.toml)).package.version;
              src = rustWorkspaceSrc;
              cargoLock.lockFile = ./Cargo.lock;
              cargoLock.allowBuiltinFetchGit = true;
```

Source: [relevant lines 423–423](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/flake.nix#L423-L423).

```nix
              cargoBuildFlags = "--package midnight-zkir --features binary";
```

The source manifest establishes standalone ZKIR **3.1.0-rc.1**. Its committed
Cargo.lock still labels the local workspace package `3.1.0` (and the wasm
workspace package `3.0.0-rc.2`); those stale workspace labels do not change the
checked source/tag or the locked external Midnight ZK dependencies. ZKIR
language generation “v3” is also distinct from package release “3.1.0-rc.1”.

Source: [ZKIR lockfile workspace label: `Cargo.lock:1893–1894`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1893-L1894).

Source: [ZKIR lockfile workspace label: `Cargo.lock:1934–1935`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1934-L1935).

Source: [zkir/Cargo.toml: `zkir/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/Cargo.toml#L1-L3).

Source: [zkir/Cargo.toml: `zkir/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir/Cargo.toml#L1-L3).

Source: [zkir-v3/Cargo.toml: `zkir-v3/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir-v3/Cargo.toml#L1-L3).

Source: [zkir/Cargo.toml: `zkir/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir/Cargo.toml#L1-L3).

Source: [zkir-v3/Cargo.toml: `zkir-v3/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/Cargo.toml#L1-L3).

Source: [zkir/Cargo.toml: `zkir/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir/Cargo.toml#L1-L3).

Source: [zkir-v3/Cargo.toml: `zkir-v3/Cargo.toml:1–3`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir-v3/Cargo.toml#L1-L3).

</details>

Latest Midnight ZK component versions and package-recorded source commits are
listed in the revision table above. Circuits 7.2.4 and curves 0.3.1 are the
published sources used by the excerpts and executable checks. Stdlib 2.3.5
returns the native ECC chip through its `jubjub()` accessor:

Full source: [src/lib.rs: `src/lib.rs:751–754`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/zk_stdlib/src/lib.rs#L751-L754).

Source: [relevant lines 752–754](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/zk_stdlib/src/lib.rs#L752-L754).

```rust
    pub fn jubjub(&self) -> &EccChip<C> {
        self.jubjub_chip.as_ref().expect("ZkStdLibArch must enable jubjub")
    }
```

For the latest proofs release, the verification-key reader delegates commitment
parsing to `CS::Commitment::read`; the group reader's `Processed` branch invokes
checked `from_bytes`. Its `RawBytesUnchecked` branch deliberately bypasses
checks. These released-source observations do not replace the Ledger wrapper's
lazy-initialization/trailing-byte findings or constitute a complete audit of
all outer-curve proof elements.

Source: [src/plonk/mod.rs: `src/plonk/mod.rs:178–186`](https://github.com/midnightntwrk/midnight-zk/blob/98d1e96444b0392beb7b50b514efb8f87ae6d265/proofs/src/plonk/mod.rs#L178-L186).

```rust
        let mut num_fixed_columns = [0u8; 4];
        reader.read_exact(&mut num_fixed_columns)?;
        let num_fixed_columns = u32::from_le_bytes(num_fixed_columns);

        let fixed_commitments: Vec<_> = (0..num_fixed_columns)
            .map(|_| CS::Commitment::read(reader, format))
            .collect::<Result<_, _>>()?;

        let permutation = permutation::VerifyingKey::read(reader, &cs.permutation, format)?;
```

Source: [src/utils/helpers.rs: `src/utils/helpers.rs:81–98`](https://github.com/midnightntwrk/midnight-zk/blob/98d1e96444b0392beb7b50b514efb8f87ae6d265/proofs/src/utils/helpers.rs#L81-L98).

```rust
    fn read<R: Read>(reader: &mut R, format: SerdeFormat) -> io::Result<Self> {
        {
            match format {
                SerdeFormat::Processed => {
                    let mut compressed = <Self as GroupEncoding>::Repr::default();
                    reader.read_exact(compressed.as_mut())?;
                    Option::from(Self::from_bytes(&compressed))
                        .ok_or_else(|| io::Error::other("Invalid point encoding in proof"))
                }
                SerdeFormat::RawBytes => {
                    <Self as Curve>::AffineRepr::read_raw(reader).map(|p| p.into())
                }
                SerdeFormat::RawBytesUnchecked => {
                    Ok(<Self as Curve>::AffineRepr::read_raw_unchecked(reader).into())
                }
            }
        }
    }
```

A Ledger release must be checked against **its locked dependencies**, rather
than assuming Midnight ZK `main` is the backend it uses. The relevant lockfile
entries are:

<details>
<summary>Historical backend lockfile sources</summary>

These entries resolve packages through the [crates.io registry index](https://github.com/rust-lang/crates.io-index).

Source: [Ledger 8.1.2: `Cargo.lock:2834–2837`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2834-L2837).

Source: [Ledger 8.1.2: `Cargo.lock:2876–2879`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/Cargo.lock#L2876-L2879).

Source: [Ledger 9 rc.5: `Cargo.lock:2992–2995`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L2992-L2995).

Source: [Ledger 9 rc.5: `Cargo.lock:3015–3018`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3015-L3018).

Source: [Ledger 9 rc.5: `Cargo.lock:3059–3062`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3059-L3062).

Source: [Ledger 9 rc.5: `Cargo.lock:3086–3089`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3086-L3089).

Source: [Ledger main: `Cargo.lock:2705–2708`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2705-L2708).

Source: [Ledger main: `Cargo.lock:2747–2750`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2747-L2750).

Source: [standalone ZKIR: `Cargo.lock:1692–1695`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1692-L1695).

Source: [standalone ZKIR: `Cargo.lock:1717–1720`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/Cargo.lock#L1717-L1720).

Ledger 9 retains two backend generations: the v1 compatibility backend uses
`midnight-circuits` 6.3.0 / `midnight-curves` 0.2.1; the current v2
evaluator and ZKIR v3 use 7.2.4 / 0.3.1. The lockfile package entries alone
do not establish which component uses which version; the dependency lists below do.

Source: [Ledger 9 rc.5: `zkir/Cargo.toml:27–40`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir/Cargo.toml#L27-L40).

```toml
base-crypto = { version = "1.1.0", path = "../base-crypto", package = "midnight-base-crypto" }
serialize = { version = "1.0.0", path = "../serialize", package = "midnight-serialize" }
transient-crypto = { version = "3.0.0", path = "../transient-crypto", package = "midnight-transient-crypto", features = ["cli"] }

midnight-proofs = { version = "^0.8.1" }
midnight-circuits = { version = "^7.2.2" }
midnight-zk-stdlib = { version = "^2.3.3" }

# Pinned pre-zk-stdlib-v2 versions for backwards-compatible v1 proving.
transient-crypto-old = { package = "midnight-transient-crypto", version = "^2.2.0" }
midnight-zk-stdlib-v1 = { package = "midnight-zk-stdlib", version = "^1.2.1" }
midnight-proofs-v1 = { package = "midnight-proofs", version = "^0.7.2" }
midnight-circuits-v1 = { package = "midnight-circuits", version = "^6.2.1" }

```

Source: [Ledger 9 rc.5: `Cargo.lock:3705–3726`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/Cargo.lock#L3705-L3726).

</details>

The downloaded 6.1.0, 6.3.0, 7.2.4 circuit crates and 0.2.0 curve crate were
SHA-256 checked against these lockfiles. Package source links use the commit
recorded in each crate's `.cargo_vcs_info.json`, with a versioned published-source
link alongside. The local 0.3.1 curve source was also read. The reproduction
uses circuit **7.2.4** and curve **0.3.1** exactly; it is not a test of all Ledger
integration code.

### 2.2. What validation means

Validation is a collection of checks, each protecting a different property. The definitions below explain which checks establish a valid point, which establish a suitable key, and how the assessment labels should be read.

For a supplied point, distinguish:

| Property | Meaning | Role-dependent requirement |
|---|---|---|
| Field/range validity | Coordinates represent elements of the base field | Required before curve arithmetic |
| Curve membership | Full supplied coordinates satisfy the curve equation | Required for an actual curve point |
| Subgroup membership | Point belongs to the intended prime-order subgroup | Separate check for cofactor curves |
| Non-identity | Point is not the group identity | Required by the reviewed signature PK policies; essential for ordinary DH recipient keys |
| Encoding canonicality | Accepted representations have the intended uniqueness | Must be checked per format, including identity flags and unused limbs |

Identity belongs to the prime-order subgroup. Subgroup validation cannot replace
non-identity validation. Conversely, identity is a valid generic group element
and can be a valid arithmetic result or a Pedersen commitment, for example
`0·G + 0·H`. It should not be rejected globally.

Jubjub and the Edwards curve exposed as `Curve25519Point` have cofactor eight;
secp256k1 and P-256 have cofactor one. On a cofactor-one group, valid curve
membership suffices for subgroup membership. “Curve25519” in this Compact API
uses Edwards coordinates and Ed25519 operations; it must not be conflated with
a Montgomery X25519 u-coordinate API. The implementation evidence for the
Edwards representation is the `ed25519.Point` validator below and the foreign
Edwards chip in the backend section.

Inventory labels describe the **specific boundary**, not the security of an
entire implementation:

| Label | Interpretation |
|---|---|
| Checked | The stated property is enforced at this boundary; see the exact checks listed |
| Role-limited | Suitable for generic arithmetic/encoding, but does not enforce the extra invariants of a signature or encryption key |
| Unchecked | Bypasses a stated curve, subgroup, or representation check; trusted inputs or independent validation are required |
| Hazardous | A concrete mismatch, panic, or confidentiality failure is identified for the specified input/use |
| Not exposed | No dedicated operation in the inventoried scheme API; generic operations or an external library may still be used |
| Not assessed | The method is identified, but its full acceptance policy or downstream behavior remains unverified |

“Public” includes exported Compact circuits/runtime functions and public Rust
methods/traits on the listed types. Some exported runtime helpers are marked
`@internal`; they are included because direct JavaScript callers can invoke them.
The inventories distinguish point objects, circuit field vectors, compressed
bytes, and tagged Ledger encodings. A serializer is not automatically a validator.
The API scope is production curve/key/signature/commitment types in the pinned
packages and their directly used adapters; unrelated application wrappers and
development curves are not claimed to be fully audited.

## 3. Elliptic curve point declaration, de/serialization and encoding

This section follows curve points from declaration and coordinate construction through runtime, byte encoding, ZKIR evaluation, and circuit assignment. The inventories identify what each boundary checks before a point is used by the schemes in [§4](#4-signature-schemes)–[§6](#6-other-cryptographic-schemes).

> **Unsafe boundaries to watch:** the Jubjub coordinate helper can ignore changes to the supplied `x` coordinate ([§3.2.2](#322-coordinate-reconstruction-and-evaluator-boundaries)), and unchecked point imports require trusted input ([§3.2.3](#323-compressed-legacy-and-unchecked-construction), [§3.5](#35-bls12-381-proof-system-points)). The coordinate-construction circuit rejects the altered-coordinate test; the evaluator mismatch is not a demonstrated proof forgery.

### 3.1. Curve availability and common encoding boundaries

The inventory first establishes which curves each repository and API layer exposes. It then compares their common point representations before the curve-specific checks are examined.

Availability is recorded by **API layer**: a curve present in a Rust dependency
is not necessarily available as a Compact or ZKIR point type.

| Repository / snapshot and layer | Point curves exposed in the reviewed interface |
|---|---|
| Compact, v2 contract backend | Jubjub point builtins |
| Compact, v3 contract/runtime interface | Jubjub, secp256k1, P-256 (`Secp256r1`), Edwards Curve25519 |
| Ledger 8.1.2 and pinned main, legacy/v3 ZKIR | Jubjub; native field is BLS12-381's scalar field, not a BLS point type |
| Ledger 9 rc.5, v3 ZKIR | Jubjub, secp256k1, P-256, Edwards Curve25519 |
| Standalone ZKIR 3.1.0-rc.1 | The same four v3 point families as Ledger 9; [type enum](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/src/ir_types.rs#L29-L89) |
| Ledger native crypto, all three snapshots | Jubjub points for transient crypto; secp256k1 for base Schnorr; BLS12-381 for the proof system |
| Midnight ZK curves 0.3.1 | Jubjub, secp256k1, P-256, Curve25519, BLS12-381 G1/G2; feature-gated development BN256 is outside this production inventory |

Ledger 8.1.2 and the pinned Ledger `main` contain a v3 crate, but its value enum
has only native field values and Jubjub points. They must not be described as
having Ledger 9's foreign-curve v3 interface.

<details>
<summary>Curve-availability source files</summary>

Source: [Ledger 8.1.2: `zkir-v3/src/ir_types.rs:29–38`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir-v3/src/ir_types.rs#L29-L38), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir-v3/src/ir_types.rs#L29-L38).

Ledger 9's v3 type enum includes Jubjub scalar and secp256k1, P-256, and
Curve25519 point/base/scalar types. The variants are listed in the linked type enum:

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_types.rs:50–89`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_types.rs#L50-L89).

Source: [curves 0.3.1 production exports](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/lib.rs#L28-L57).

</details>

The generic Compact point checks are summarized here; scheme-specific identity
policies are in [§4](#4-signature-schemes), [§5](#5-encryption-schemes), and [§6](#6-other-cryptographic-schemes).

| Generic Compact TS point | Coordinate bounds | Full curve check | Separate subgroup check | Identity accepted |
|---|---|---|---|---|
| Jubjub | Generated check only | No | No | Yes, including `(0,1)` |
| secp256k1 | Yes | For non-identity | Not needed for cofactor one | Yes, via flag |
| P-256 | Yes | For non-identity | Not needed for cofactor one | Yes, via flag |
| Curve25519 / Edwards | Yes | Yes | Yes, `isTorsionFree` | Yes, `(0,1)` |

These results describe the shown runtime/type-check paths, not every possible
consumer of manually forged TS objects.

#### 3.1.1. Common Compact declaration and encoding adapters

These adapters translate between JavaScript point objects and Compact field values. This subsection distinguishes formatting checks from the curve and subgroup validation performed elsewhere.

> **Unsafe if treated as validation:** declaring a point object or passing it through a type adapter does not establish curve or subgroup membership. Validate at the appropriate boundary before relying on those properties.

Direct TypeScript object literals can instantiate the point interfaces without
running a validator. `CompactType*.fromValue` and `toValue` are serialization
adapters, not substitutes for the generated argument validator or a circuit.
They consume/emit a point prefix; `fromValue` may leave later values for the next
typed component rather than requiring whole-stream exhaustion.

| Type / public entry points | Encoding and checks | Assessment |
|---|---|---|
| `JubjubPoint {x,y}`; `CompactTypeJubjubPoint.fromValue/toValue` | Two native field elements; adapter itself does not check the curve or subgroup | Role-limited |
| `Secp256k1Point`, `Secp256r1Point {x,y,identity}`; corresponding `CompactType*.fromValue/toValue` | Five native field elements: two limbs per coordinate and a Boolean flag; checks field-format/flag, not the curve equation | Role-limited; flagged-coordinate canonicality differs in current-main comparison below |
| `Curve25519Point {x,y}`; `CompactTypeCurve25519Point.fromValue/toValue` | Four native field elements; no curve/subgroup check in adapter | Role-limited |
| `toBinaryRepr(rtType,value)` | Calls `rtType.toValue` and uses its alignment; output bytes are the typed binary representation, not necessarily a standard compressed point encoding | Role-limited |

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L54-L85).

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L91-L112).

```typescript
export const CompactTypeJubjubPoint: CompactType<JubjubPoint> = {
  alignment(): ocrt.Alignment {
    return [
      { tag: 'atom', value: { tag: 'field' } },
      { tag: 'atom', value: { tag: 'field' } },
    ];
  },
  fromValue(value: ocrt.Value): JubjubPoint {
    if (value.length < 2 || value[0] == undefined || value[1] == undefined) {
      throw new CompactError('expected JubjubPoint');
    }
    const coordinates = value.splice(0, 2);
    return {
      x: ocrt.valueToBigInt([coordinates[0]]),
      y: ocrt.valueToBigInt([coordinates[1]]),
    };
  },
  toValue(value: JubjubPoint): ocrt.Value {
    return ocrt.bigIntToValue(value.x).concat(ocrt.bigIntToValue(value.y));
  },
};

```

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L125-L147).

```typescript
  fromValue(value: ocrt.Value): Secp256k1Point {
    if (value.length < 5) {
      throw new CompactError('expected Secp256k1Point');
    }
    // This might throw CompactError('expected Secp256k1Base').
    const x = CompactTypeSecp256k1Base.fromValue(value);
    const y = CompactTypeSecp256k1Base.fromValue(value);
    const identity = value.shift();
    if (identity == undefined) {
      throw new CompactError('expected Secp256k1Point');
    }
    const flag = ocrt.valueToBigInt([identity]);
    if (flag != 0n && flag != 1n) {
      throw new CompactError('expected Secp256k1Point');
    }
    return { x: x, y: y, identity: flag === 1n };
  },
  toValue(value: Secp256k1Point): ocrt.Value {
    return CompactTypeSecp256k1Base.toValue(value.x)
      .concat(CompactTypeSecp256k1Base.toValue(value.y))
      .concat(ocrt.bigIntToValue(value.identity ? 1n : 0n));
  },
};
```

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L161-L183).

```typescript
  fromValue(value: ocrt.Value): Secp256r1Point {
    if (value.length < 5) {
      throw new CompactError('expected Secp256r1Point');
    }
    // This might throw CompactError('expected Secp256r1Base').
    const x = CompactTypeSecp256r1Base.fromValue(value);
    const y = CompactTypeSecp256r1Base.fromValue(value);
    const identity = value.shift();
    if (identity == undefined) {
      throw new CompactError('expected Secp256r1Point');
    }
    const flag = ocrt.valueToBigInt([identity]);
    if (flag != 0n && flag != 1n) {
      throw new CompactError('expected Secp256r1Point');
    }
    return { x: x, y: y, identity: flag === 1n };
  },
  toValue(value: Secp256r1Point): ocrt.Value {
    return CompactTypeSecp256r1Base.toValue(value.x)
      .concat(CompactTypeSecp256r1Base.toValue(value.y))
      .concat(ocrt.bigIntToValue(value.identity ? 1n : 0n));
  },
};
```

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L195-L208).

```typescript
  fromValue(value: ocrt.Value): Curve25519Point {
    if (value.length < 4) {
      throw new CompactError('expected Curve25519Point');
    }
    // This might throw CompactError('expected Curve25519Base').
    const x = CompactTypeCurve25519Base.fromValue(value);
    const y = CompactTypeCurve25519Base.fromValue(value);
    return { x: x, y: y };
  },
  toValue(value: Curve25519Point): ocrt.Value {
    return CompactTypeCurve25519Base.toValue(value.x)
      .concat(CompactTypeCurve25519Base.toValue(value.y));
  },
};
```

Source: [c: runtime/src/compact-types.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/compact-types.ts#L677-L680).

### 3.2. Jubjub points

Jubjub is used for native contract arithmetic, Ledger transient cryptography, and several commitments. The subsections compare coordinate constructors, compressed imports, evaluator reconstruction, and circuit enforcement.

> **Hazardous coordinate construction:** some helpers reconstruct from `y` and only the parity of `x`, so different coordinate pairs can be interpreted as the same point; some invalid inputs also panic. See [§3.2.2](#322-coordinate-reconstruction-and-evaluator-boundaries) for the code and [§3.2.4](#324-circuit-assignment-and-executable-evidence) for the circuit checks that reject the tested mismatch.

| Layer / public entry points | Checks and timing | Assessment |
|---|---|---|
| Compact `constructJubjubPoint`, direct `{x,y}`, coordinate getters | Runtime constructor/getters simply package/read coordinates; generated arguments only bound the fields | Role-limited |
| Compact `ecAdd/ecNeg/ecMul/ecMulGenerator`, `hashToCurve` | Arithmetic delegates to Ledger runtime; generator/hash construction produces typed points; supplying coordinates reaches Ledger's reconstruction | Generic identity results are allowed; coordinate helper mismatch remains hazardous |
| Ledger `EmbeddedGroupAffine::new(x,y)` | Reconstructs from `y` and parity of `x`, then subgroup conversion | Hazardous: missing full-x equality; some invalid inputs panic |
| ZKIR v3 `from_coordinates_offcircuit`, `decode_offcircuit` | Subgroup check after reconstruction; standalone decoder also checks encode/decode round-trip | Coordinate construction hazardous; canonical decoder adds a separate guard |
| ZKIR / chip `from_coordinates_incircuit`, `point_from_coordinates`, `assign/assign_many` | Coordinate equality and subgroup constraints during circuit synthesis | Checked constraints; torsion construction can panic |
| `AssignedNativePoint::from_public_input/as_public_input` | Raw two-field decoder uses shared reconstruction; encoder returns reconstructed coordinates | Hazardous if decoder alone is treated as validating the supplied representation |
| Ledger `EmbeddedGroupAffine::serialize/deserialize` and Serde adapters | Compressed subgroup-point encoding; import checks curve/subgroup, allows identity | Checked generic subgroup import; role-limited as a public-key importer |
| Midnight ZK `JubjubAffine::from_bytes/batch_from_bytes`, `JubjubExtended::from_bytes`, corresponding `to_bytes` | Compressed y/sign decoding; affine/extended types do not require prime subgroup | Checked curve decoding; role-limited |
| `JubjubSubgroup::from_bytes`, `into_subgroup/try_into_subgroup` | Checks torsion freedom; identity accepted | Checked generic subgroup |
| `JubjubAffine::from_bytes_pre_zip216_compatibility` | Legacy sign-encoding rules | Unchecked canonicality relative to strict ZIP216 decoding |
| `JubjubAffine::from_raw_unchecked`, `JubjubSubgroup::from_raw_unchecked` | Raw coordinates wrapped without stated invariants | Unchecked; never use as validation of untrusted coordinates |
| `JubjubSubgroup::from_bytes_unchecked` | Curve decompression remains, subgroup conversion is bypassed | Unchecked subgroup |

#### 3.2.1. Compact and generation-specific construction

This subsection traces how Compact constructs a Jubjub point and checks supplied arguments in each backend generation. It identifies the properties established before the coordinates reach Ledger or the circuit backend.

> **Unchecked constructor:** `constructJubjubPoint` only packages coordinates. Its return type must not be taken as evidence that the coordinates form a valid subgroup point.

The runtime constructor performs no range, curve, or subgroup validation itself.

Source: [Compact: `runtime/src/built-ins.ts:232–241`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L232-L241).

```typescript
/**
 * The Compact builtin `constructJubjubPoint` function
 *
 * This function constructs a Compact `JubjubPoint` from the x- and
 * y-coordinates.  NOTE that it does not check that the coordinates represent a
 * valid point on the Jubjub curve.
 */
export function constructJubjubPoint(x: bigint, y: bigint): JubjubPoint {
  return { x, y };
}
```

Generated point checks bound Jubjub coordinates, while delegating foreign
points to their runtime validators. This establishes only a field-valid pair
for Jubjub at the generated TS check, not a validated subgroup point.

Source: [Compact: `compiler/typescript-passes/print-typescript.ss:1110–1129`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/typescript-passes/print-typescript.ss#L1110-L1129).

```scheme
                   ;; The tfield case above bounds a bare field element and an
                   ;; unbounded check here would let the same bigint through as
                   ;; a coordinate. Points on the other curves - expect JubjubPoint
                   ;; are checked in full, including curve membership, by one runtime call.
                   ;; Jubjub coordinates are bounded.
                   (let ([coordinate
                           (lambda (field bound)
                             (format "typeof(~a.~a) === 'bigint' && ~a.~a >= 0n && ~a.~a <= __compactRuntime.~a"
                               var field var field var field bound))])
                     (strict-nanopass-case (Ltypescript Curve-Type) ctype
                       [(curve-curve25519)
                        (format "__compactRuntime.isValidCurve25519Point(~a)" var)]
                       [(curve-jubjub)
                        (format "~a && ~a"
                          (coordinate "x" "MAX_FIELD")
                          (coordinate "y" "MAX_FIELD"))]
                       [(curve-secp256k1)
                        (format "__compactRuntime.isValidSecp256k1Point(~a)" var)]
                       [(curve-secp256r1)
                        (format "__compactRuntime.isValidSecp256r1Point(~a)" var)]))]
```

Compact's v2 constructor lowers to two coordinate bindings; no point-validation
instruction is emitted by that handler. V3 emits `from_coordinates`. This
explains why merely constructing or extracting a v2 Jubjub coordinate pair is
not equivalent to consuming it as an EC arithmetic operand.

Source: [Compact: `compiler/zkir-passes/print-zkir.ss:197–200`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-passes/print-zkir.ss#L197-L200).

```scheme
            (register-handler! 'constructJubjubPoint
              (lambda (src align res* a1 a2)
                (bind-var! (car res*) a1)
                (bind-var! (cadr res*) a2)))
```

Source: [Compact: `compiler/zkir-v3-passes/reduce-to-zkir.ss:151–153`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-passes/reduce-to-zkir.ss#L151-L153).

```scheme
            [(constructJubjubPoint)
             (assert (= (length var-name*) 1))
             (cons `(from_coordinates ,(car var-name*) ,(car triv*) ,(cadr triv*)) instr*)]
```

#### 3.2.2. Coordinate reconstruction and evaluator boundaries

This subsection compares the coordinate reconstruction helpers and the evaluator paths that call them. The key question is whether the returned point actually has both coordinates supplied by the caller.

> **Confirmed mismatch:** full equality of the supplied `x` coordinate is missing on the reconstruction paths described below. Subgroup validation of the reconstructed point does not repair that mismatch.

In the locked Ledger-8 backend, `from_xy` serializes `y`, uses the low bit of
`x` as the compressed-point sign, decompresses, and compares only `get_v()`
with `y`. It does not compare `get_u()` with the supplied `x`. This version can
also panic during decompression because it uses `expect`.

Source: [midnight-circuits 6.1.0: `circuits/src/ecc/curves.rs:95–113`](https://github.com/midnightntwrk/midnight-zk/blob/0e3ebfa5039e3addbc2a7db662879863f8e25227/circuits/src/ecc/curves.rs#L95-L113); [published crate source](https://docs.rs/crate/midnight-circuits/6.1.0/source/src/ecc/curves.rs).

```rust
    fn from_xy(x: Self::Base, y: Self::Base) -> Option<Self> {
        // The only way to check that the coordinates are in the curve is via
        // the `from_bytes` interface
        // FIXME: change JubJub implementation to get a `frocm_coords_checked`
        // https://github.com/davidnevadoc/blstrs/issues/13c
        let mut bytes = y.to_bytes_le();
        let x_sign = x.to_bytes_le()[0] << 7;

        // Encode the sign of the u-coordinate in the most
        // significant bit.
        bytes[31] |= x_sign;

        let point = JubjubAffine::from_bytes(bytes).into_option().expect("Failed here");
        if point.get_v() == y {
            Some(point.into())
        } else {
            None
        }
    }
```

The locked Ledger-9 v3 helper has the same missing full-`x` comparison, although
invalid decompression now returns `None` via `?`.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/curves.rs:120–138`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/curves.rs#L120-L138); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/curves.rs).

```rust
    fn from_xy(x: Self::Base, y: Self::Base) -> Option<Self> {
        // The only way to check that the coordinates are in the curve is via
        // the `from_bytes` interface
        // FIXME: change JubJub implementation to get a `from_coords_checked`
        // https://github.com/davidnevadoc/blstrs/issues/13c
        let mut bytes = y.to_bytes_le();
        let x_sign = x.to_bytes_le()[0] << 7;

        // Encode the sign of the u-coordinate in the most
        // significant bit.
        bytes[31] |= x_sign;

        let point = JubjubAffine::from_bytes(bytes).into_option()?;
        if point.get_v() == y {
            Some(point.into())
        } else {
            None
        }
    }
```

The same parity-only reconstruction is present in the legacy 6.3.0 dependency,
Ledger-main's 6.0.0 dependency, and the latest stable Midnight ZK circuit release, 7.2.4 (shown above). These are
checked implementations, not extrapolations from release history.

Source: [midnight-circuits 6.3.0: `circuits/src/ecc/curves.rs:100–113`](https://github.com/midnightntwrk/midnight-zk/blob/369fa9d0553280daee9016b86004caea80ee6259/circuits/src/ecc/curves.rs#L100-L113); [published crate source](https://docs.rs/crate/midnight-circuits/6.3.0/source/src/ecc/curves.rs).

```rust
        let mut bytes = y.to_bytes_le();
        let x_sign = x.to_bytes_le()[0] << 7;

        // Encode the sign of the u-coordinate in the most
        // significant bit.
        bytes[31] |= x_sign;

        let point = JubjubAffine::from_bytes(bytes).into_option().expect("Failed here");
        if point.get_v() == y {
            Some(point.into())
        } else {
            None
        }
    }
```

Source: [midnight-circuits 6.0.0: `circuits/src/ecc/curves.rs:100–113`](https://github.com/midnightntwrk/midnight-zk/blob/250b1f16b88c4fb0428ec1f8f79da5b72ad1bcb3/circuits/src/ecc/curves.rs#L100-L113); [published crate source](https://docs.rs/crate/midnight-circuits/6.0.0/source/src/ecc/curves.rs).

```rust
        let mut bytes = y.to_bytes_le();
        let x_sign = x.to_bytes_le()[0] << 7;

        // Encode the sign of the u-coordinate in the most
        // significant bit.
        bytes[31] |= x_sign;

        let point = JubjubAffine::from_bytes(bytes).into_option().expect("Failed here");
        if point.get_v() == y {
            Some(point.into())
        } else {
            None
        }
    }
```

Subgroup validation on the reconstructed point does not repair a missing
coordinate equality check. The subgroup helper checks torsion freedom of that
reconstructed point, independently of the originally supplied full `x`.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/curves.rs:140–142`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/curves.rs#L140-L142); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/curves.rs).

```rust
    fn try_into_subgroup(self) -> Option<Self::CryptographicGroup> {
        <JubjubExtended as CofactorGroup>::into_subgroup(self).into_option()
    }
```

All three Ledger snapshots construct arithmetic operands through
`EmbeddedGroupAffine::new`, which calls the helper and then the circuit trait's
subgroup conversion. This conversion can panic for a non-subgroup point; an
`Option` return type on `new` does not guarantee that every malformed input
becomes `None`. The 6.1.0 trait implementation shows the `expect` explicitly.

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:482–487`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L482-L487), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L495-L500), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L482-L487).

```rust
impl EmbeddedGroupAffine {
    /// Creates a new elliptic curve element from it's affine coordinates. It *is*
    /// checked for validity.
    pub fn new(x: Fr, y: Fr) -> Option<Self> {
        embedded::AffineExtended::from_xy(x.0, y.0).map(|p| EmbeddedGroupAffine(p.into_subgroup()))
    }
```

Source: [midnight-circuits 6.1.0: `circuits/src/ecc/curves.rs:115–118`](https://github.com/midnightntwrk/midnight-zk/blob/0e3ebfa5039e3addbc2a7db662879863f8e25227/circuits/src/ecc/curves.rs#L115-L118); [published crate source](https://docs.rs/crate/midnight-circuits/6.1.0/source/src/ecc/curves.rs).

```rust
    fn into_subgroup(self) -> Self::CryptographicGroup {
        <JubjubExtended as CofactorGroup>::into_subgroup(self)
            .expect("Point should be part of the subgroup")
    }
```

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/curves.rs:69–71`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/curves.rs#L69-L71); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/curves.rs).

```rust
    fn into_subgroup(self) -> Self::CryptographicGroup {
        self.try_into_subgroup().expect("point must be in the prime-order subgroup")
    }
```

The legacy preprocessor reads `x,y` and calls that constructor. With an altered
`x` of the same parity and a valid subgroup `y`, it operates on a reconstructed
point instead of rejecting the coordinate pair.

Source: [Ledger 8.1.2: `zkir/src/ir_vm.rs:258–263`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir/src/ir_vm.rs#L258-L263), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir/src/ir_vm.rs#L262-L267), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir/src/ir_vm.rs#L258-L263).

```rust
        let idx_point = |memory: &[Fr], x: u32, y: u32| {
            let x = idx(memory, x)?;
            let y = idx(memory, y)?;
            EmbeddedGroupAffine::new(x, y)
                .ok_or(anyhow!("Elliptic curve point not on curve: ({x:?}, {y:?})"))
        };
```

The compiled legacy `ecc_from_parts` path instead assigns the reconstructed
subgroup point and constrains **both** coordinates equal to the original field
inputs. For the altered-`x` case, the `x` equality cannot hold.

Source: [Ledger 8.1.2: `zkir/src/ir_vm.rs:190–208`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/zkir/src/ir_vm.rs#L190-L208), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir/src/ir_vm.rs#L190-L208).

```rust
fn ecc_from_parts(
    std: &ZkStdLib,
    layouter: &mut impl Layouter<outer::Scalar>,
    x: &AssignedNative<outer::Scalar>,
    y: &AssignedNative<outer::Scalar>,
) -> Result<AssignedNativePoint<embedded::AffineExtended>, Error> {
    let point = x
        .value()
        .zip(y.value())
        .map(|(x, y)| EmbeddedGroupAffine::new(Fr(*x), Fr(*y)));
    point.as_ref().error_if_known_and(|p| p.is_none())?;
    let point = point.map(|p| p.expect("After is_none check, point should exist").0);
    let point_var: AssignedNativePoint<embedded::AffineExtended> =
        std.jubjub().assign(layouter, point)?;

    std.assert_equal(layouter, x, &std.jubjub().x_coordinate(&point_var))?;
    std.assert_equal(layouter, y, &std.jubjub().y_coordinate(&point_var))?;
    Ok(point_var)
}
```

Source: [Ledger 9 rc.5: `zkir/src/ir_vm.rs:194–212`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir/src/ir_vm.rs#L194-L212).

```rust
fn ecc_from_parts(
    std: &ZkStdLib,
    layouter: &mut impl Layouter<outer::Scalar>,
    x: &AssignedNative<outer::Scalar>,
    y: &AssignedNative<outer::Scalar>,
) -> Result<AssignedNativePoint<embedded::AffineExtended>, Error> {
    let point = x
        .value()
        .zip(y.value())
        .map(|(x, y)| EmbeddedGroupAffine::new(Fr(*x), Fr(*y)));
    point.as_ref().error_if_known_and(|p| p.is_none())?;
    let point = point.map(|p| p.expect("After is_none check, point should exist").0);
    let point_var: AssignedNativePoint<embedded::AffineExtended> =
        std.jubjub().assign(layouter, point)?;

    std.assert_equal(layouter, x, &std.jubjub().x_coordinate(&point_var))?;
    std.assert_equal(layouter, y, &std.jubjub().y_coordinate(&point_var))?;
    Ok(point_var)
}
```

Ledger 9's `from_coordinates_offcircuit` performs a fallible subgroup check,
but still uses the parity-only reconstruction. Standalone ZKIR has the same
Jubjub sequence.

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/from_coordinates.rs:39–48`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/from_coordinates.rs#L39-L48).

```rust
pub fn from_coordinates_offcircuit(x: &IrValue, y: &IrValue) -> Result<IrValue, anyhow::Error> {
    use IrValue::*;
    match (x, y) {
        (Native(x), Native(y)) => JubjubExtended::from_xy(x.0, y.0)
            .map(<JubjubExtended as CofactorGroup>::into_subgroup)
            .and_then(Into::<Option<JubjubSubgroup>>::into)
            .map(JubjubPoint)
            .ok_or(anyhow::anyhow!(
                "Cannot build a Jubjub point from ({x}, {y})",
            )),
```

Source: [standalone ZKIR: `zkir/src/ir_instructions/from_coordinates.rs:39–48`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/src/ir_instructions/from_coordinates.rs#L39-L48).

```rust
pub fn from_coordinates_offcircuit(x: &IrValue, y: &IrValue) -> Result<IrValue, anyhow::Error> {
    use IrValue::*;
    match (x, y) {
        (Native(x), Native(y)) => JubjubExtended::from_xy(x.0, y.0)
            .map(<JubjubExtended as CofactorGroup>::into_subgroup)
            .and_then(Into::<Option<JubjubSubgroup>>::into)
            .map(JubjubPoint)
            .ok_or(anyhow::anyhow!(
                "Cannot build a Jubjub point from ({x}, {y})",
            )),
```

For the other Ledger-9 v3 curves, off-circuit construction checks the curve
through `from_xy`. Curve25519 additionally converts to its subgroup type;
secp256k1 and P-256 have cofactor one, so their on-curve points already lie in
the relevant subgroup. These statements concern the returned point. For Jubjub,
subgroup membership of that point does not establish that the full supplied
`x,y` were correct, as explained in [§3.2.2](#322-coordinate-reconstruction-and-evaluator-boundaries).

Source: [Ledger 9 foreign-curve off-circuit construction](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/from_coordinates.rs#L50-L69).

The Jubjub in-circuit branch delegates to the native chip's `point_from_coordinates`,
which assigns the subgroup point and asserts both full-coordinate equalities.

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/from_coordinates.rs:92–103`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/from_coordinates.rs#L92-L103).

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/native/edwards_chip.rs:786–801`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/native/edwards_chip.rs#L786-L801); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/native/edwards_chip.rs).

```rust
    fn point_from_coordinates(
        &self,
        layouter: &mut impl Layouter<C::Base>,
        x: &Self::Coordinate,
        y: &Self::Coordinate,
    ) -> Result<Self::Point, Error> {
        let point_val = x.value().zip(y.value()).map(|(x, y)| {
            C::from_xy(*x, *y)
                .expect("Affine coordinates must satisfy Jubjub equation.")
                .into_subgroup()
        });
        let point: Self::Point = self.assign(layouter, point_val)?;
        self.native_gadget.assert_equal(layouter, x, &point.x)?;
        self.native_gadget.assert_equal(layouter, y, &point.y)?;
        Ok(point)
    }
```

Raw point decoding is a different path: the backend's `from_public_input`
also uses `from_xy`, so by itself it accepts the same altered-`x` representation.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/native/edwards_chip.rs:99–104`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/native/edwards_chip.rs#L99-L104); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/native/edwards_chip.rs).

```rust
    fn from_public_input(fields: &[C::Base]) -> Option<C::CryptographicGroup> {
        if fields.len() != 2 {
            return None;
        }
        C::from_xy(fields[0], fields[1])?.try_into_subgroup()
    }
```

Ledger 9's v3 decoder delegates to that backend method and returns the decoded
value without a full re-encoding comparison. The relevant dispatch and return
are shown separately.

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/encode.rs:167–168`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/encode.rs#L167-L168).

```rust
        IrType::JubjubPoint => AssignedNativePoint::<JubjubExtended>::from_public_input(&encoded)
            .map(IrValue::JubjubPoint),
```

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/encode.rs:213–215`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/encode.rs#L213-L215).

```rust
    }
    .ok_or_else(|| anyhow!("Failed to decode {encoded:?} as {val_t:?}"))
}
```

Standalone ZKIR **does** add a re-encoding equality check, rejecting altered
raw point encodings even though its `from_coordinates_offcircuit` remains
permissive. Its regression specifically tests the parity-preserving `x + 2`
case. This fix must not be attributed to every Ledger version.

Source: [standalone ZKIR: `zkir/src/ir_instructions/encode.rs:237–254`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/src/ir_instructions/encode.rs#L237-L254).

```rust
    .ok_or_else(|| anyhow!("Failed to decode {encoded:?} as {val_t:?}"))?;

    // We make sure that the encoded value was in canonical form by re-encoding
    // it and comparing it with the given input.
    let re_encoded: Vec<F> = encode_offcircuit(&decoded)
        .into_iter()
        .map(|x| x.try_into().unwrap())
        .map(|x: Fr| x.0)
        .collect();

    if re_encoded != encoded {
        return Err(anyhow!(
            "The encoded value of type {val_t:?} is not in canonical form: {encoded:?}"
        ));
    }

    Ok(decoded)
}
```

Source: [standalone ZKIR: `zkir/src/ir_instructions/encode.rs:427–437`](https://github.com/midnightntwrk/midnight-zkir/blob/e82d81d25aabcc5f5092e2bd559083487f577914/zkir/src/ir_instructions/encode.rs#L427-L437).

```rust
    // `JubjubExtended::from_xy` recovers the point from `y` and the parity bit of
    // `x`, so tampering with the rest of `x` used to decode to the same point.
    #[test]
    fn decode_rejects_non_canonical_jubjub_point() {
        let value = IrValue::JubjubPoint(JubjubSubgroup::generator());
        let encoded = raw(&value);
        // `+ 2` leaves the parity of `x` (and hence the decoded point) untouched.
        let tampered = vec![Fr(encoded[0].0 + F::from(2u64)), encoded[1]];
        assert_ne!(tampered, encoded);
        assert!(decode_offcircuit(&tampered, &IrType::JubjubPoint).is_err());
    }
```

#### 3.2.3. Compressed, legacy, and unchecked construction

Compressed point imports, compatibility conversions, and unchecked constructors establish different invariants. The evidence below separates checked subgroup decoding from APIs that rely on trusted or independently validated input.

> **Unsafe for untrusted input without independent checks:** unchecked constructors and raw decoders can bypass membership validation. Checked compressed subgroup decoding is a separate path and still permits the identity as a generic point.

`EmbeddedGroupAffine` is a wrapper of `JubjubSubgroup`, not the entire cofactor
group. The deserializer calls its checked `from_bytes`. This path is different
from the parity-only affine constructor discussed above.

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:67–73`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L67-L73), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L67-L73), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L67-L73).

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:457–471`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L457-L471), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L470-L484), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L457-L471).

```rust
impl Deserializable for EmbeddedGroupAffine {
    fn deserialize(reader: &mut impl Read, _recursion_depth: u32) -> std::io::Result<Self> {
        let mut data = <<embedded::AffineExtended as GroupEncoding>::Repr>::default();
        reader.read_exact(data.as_mut())?;
        <Option<_>>::from(embedded::Affine::from_bytes(&data).map(EmbeddedGroupAffine)).ok_or_else(
            || {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid group element encoding",
                )
            },
        )
    }
}

```

The subgroup decoder calls the ordinary point decoder and then checks
`is_torsion_free`. It contains no independent non-identity check. Consequently,
generic subgroup-point decoding must not be described as a validated public-key
import.

Source: [midnight-curves 0.3.1: `curves/src/jubjub/curve.rs:1337–1347`](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L1337-L1347); [published crate source](https://docs.rs/crate/midnight-curves/0.3.1/source/src/jubjub/curve.rs).

Source: [midnight-curves 0.3.1: `curves/src/jubjub/curve.rs:1418–1423`](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L1418-L1423); [published crate source](https://docs.rs/crate/midnight-curves/0.3.1/source/src/jubjub/curve.rs).

```rust
impl GroupEncoding for JubjubSubgroup {
    type Repr = [u8; 32];

    fn from_bytes(bytes: &Self::Repr) -> CtOption<Self> {
        JubjubExtended::from_bytes(bytes).and_then(|p| p.into_subgroup())
    }
```

Source: [midnight-curves 0.2.0: `curves/src/jubjub/curve.rs:1422–1427`](https://github.com/midnightntwrk/midnight-zk/blob/a39f81d591ce59d20c0ff434b116728458c85304/curves/src/jubjub/curve.rs#L1422-L1427); [published crate source](https://docs.rs/crate/midnight-curves/0.2.0/source/src/jubjub/curve.rs).

```rust
impl GroupEncoding for JubjubSubgroup {
    type Repr = [u8; 32];

    fn from_bytes(bytes: &Self::Repr) -> CtOption<Self> {
        JubjubExtended::from_bytes(bytes).and_then(|p| p.into_subgroup())
    }
```

Full source: [c: runtime/src/built-ins.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L256-L297).

Source: [relevant lines 256–258](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L256-L258).

```typescript
export function hashToCurve<A>(rtType: CompactType<A>, x: A): JubjubPoint {
  return CompactTypeJubjubPoint.fromValue(ocrt.hashToCurve(rtType.alignment(), rtType.toValue(x)));
}
```

Source: [relevant lines 265–267](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L265-L267).

```typescript
export function ecAdd(a: JubjubPoint, b: JubjubPoint): JubjubPoint {
  return CompactTypeJubjubPoint.fromValue(ocrt.ecAdd(CompactTypeJubjubPoint.toValue(a), CompactTypeJubjubPoint.toValue(b)));
}
```

Source: [relevant lines 275–277](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L275-L277).

```typescript
export function ecNeg(a: JubjubPoint): JubjubPoint {
  return constructJubjubPoint(a.x === 0n ? 0n : FIELD_MODULUS - a.x, a.y);
}
```

Source: [relevant lines 285–287](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L285-L287).

```typescript
export function ecMul(a: JubjubPoint, b: bigint): JubjubPoint {
  return CompactTypeJubjubPoint.fromValue(ocrt.ecMul(CompactTypeJubjubPoint.toValue(a), ocrt.bigIntToValue(b)));
}
```

Source: [relevant lines 295–297](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L295-L297).

```typescript
export function ecMulGenerator(b: bigint): JubjubPoint {
  return CompactTypeJubjubPoint.fromValue(ocrt.ecMulGenerator(ocrt.bigIntToValue(b)));
}
```

Source: [cv: src/jubjub/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L452-L475).

```rust
    /// affine point, failing if the element is not on
    /// the curve or non-canonical.
    pub fn from_bytes(b: [u8; 32]) -> CtOption<Self> {
        Self::from_bytes_inner(b, 1.into())
    }

    /// Attempts to interpret a byte representation of an affine point, failing
    /// if the element is not on the curve.
    ///
    /// Most non-canonical encodings will also cause a failure. However, this
    /// API preserves (for use in consensus-critical protocols) a bug in the
    /// parsing code that caused two non-canonical encodings to be
    /// **silently** accepted:
    ///
    /// - (0, 1), which is the identity;
    /// - (0, -1), which is a point of order two.
    ///
    /// Each of these has a single non-canonical encoding in which the value of
    /// the sign bit is 1.
    ///
    /// See [ZIP 216](https://zips.z.cash/zip-0216) for a more detailed description of the
    /// bug, as well as its fix.
    pub fn from_bytes_pre_zip216_compatibility(b: [u8; 32]) -> CtOption<Self> {
        Self::from_bytes_inner(b, 0.into())
```

Source: [cv: src/jubjub/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L645-L649).

```rust
    /// Constructs an AffinePoint given `u` and `v` without checking
    /// that the point is on the curve.
    pub fn from_raw_unchecked(u: Base, v: Base) -> JubjubAffine {
        JubjubAffine { u, v }
    }
```

Source: [cv: src/jubjub/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L1163-L1174).

```rust
impl JubjubSubgroup {
    /// Constructs an AffinePoint given `u` and `v` without checking that the
    /// point is on the curve or in the prime-order subgroup.
    ///
    /// This should only be used for hard-coding constants (e.g. fixed
    /// generators); in all other cases, use [`JubjubSubgroup::from_bytes`]
    /// instead.
    ///
    /// [`JubjubSubgroup::from_bytes`]: JubjubSubgroup#impl-GroupEncoding
    pub fn from_raw_unchecked(u: Base, v: Base) -> Self {
        JubjubSubgroup(JubjubAffine::from_raw_unchecked(u, v).to_extended())
    }
```

Source: [cv: src/jubjub/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L1401-L1432).

```rust
impl GroupEncoding for JubjubExtended {
    type Repr = [u8; 32];

    fn from_bytes(bytes: &Self::Repr) -> CtOption<Self> {
        JubjubAffine::from_bytes(*bytes).map(Self::from)
    }

    fn from_bytes_unchecked(bytes: &Self::Repr) -> CtOption<Self> {
        // We can't avoid curve checks when parsing a compressed encoding.
        JubjubAffine::from_bytes(*bytes).map(Self::from)
    }

    fn to_bytes(&self) -> Self::Repr {
        JubjubAffine::from(self).to_bytes()
    }
}

impl GroupEncoding for JubjubSubgroup {
    type Repr = [u8; 32];

    fn from_bytes(bytes: &Self::Repr) -> CtOption<Self> {
        JubjubExtended::from_bytes(bytes).and_then(|p| p.into_subgroup())
    }

    fn from_bytes_unchecked(bytes: &Self::Repr) -> CtOption<Self> {
        JubjubExtended::from_bytes_unchecked(bytes).map(JubjubSubgroup)
    }

    fn to_bytes(&self) -> Self::Repr {
        self.0.to_bytes()
    }
}
```

`batch_from_bytes` is also public: it applies the affine compressed-decoding
rules to each input. It returns affine points, not subgroup-validated public keys.

Source: [cv: src/jubjub/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/curve.rs#L519-L536).

#### 3.2.4. Circuit assignment and executable evidence

Circuit assignment must constrain the point represented by the witness, rather than merely reconstruct a point during evaluation. This subsection connects the assignment gates to the executable coordinate and subgroup tests.

Ledger-9 v3 private inputs dispatch to the curve chips' assignment functions;
Jubjub and Curve25519 values carry subgroup types. The representative branches
are:

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/assign.rs:79–82`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/assign.rs#L79-L82).

Source: [Ledger 9 rc.5: `zkir-v3/src/ir_instructions/assign.rs:123–129`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/assign.rs#L123-L129).

Native Jubjub assignment constrains an on-curve cofactor root and returns its
cofactor multiple. The root membership selector is enabled even in the method
named `assign_without_subgroup_check`; the name does not mean “no curve check”.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/native/edwards_chip.rs:810–826`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/native/edwards_chip.rs#L810-L826); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/native/edwards_chip.rs).

```rust
            .map(|p| p.into().coordinates().expect("assign_without_subgroup_check: invalid point"))
            .unzip();

        layouter.assign_region(
            || "assign point without subgroup check",
            |mut region: Region<'_, C::Base>| {
                config.q_mem.enable(&mut region, 0)?;
                let x = region.assign_advice(|| "x", config.advice_cols[0], 0, || x_val)?;
                let y = region.assign_advice(|| "y", config.advice_cols[1], 0, || y_val)?;
                Ok(AssignedNativePoint {
                    x,
                    y,
                    checked_in_subgroup: false,
                })
            },
        )
    }
```

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/native/edwards_chip.rs:842–856`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/native/edwards_chip.rs#L842-L856); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/native/edwards_chip.rs).

```rust
    fn assign(
        &self,
        layouter: &mut impl Layouter<C::Base>,
        value: Value<C::CryptographicGroup>,
    ) -> Result<AssignedNativePoint<C>, Error> {
        // Ensure the point lies in the correct subgroup.
        // To achieve this, we first assign the point multiplied by the inverse of the
        // cofactor. Then, we return the assigned point after multiplying it by
        // the cofactor.
        let cofactor = C::ScalarField::from_u128(C::COFACTOR);
        let cf_root_val = value.map(|p| p * cofactor.invert().expect("Cofactor must not be 0"));
        let cf_root = self.assign_without_subgroup_check(layouter, cf_root_val)?;

        self.clear_cofactor(layouter, &cf_root)
    }
```

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/native/edwards_chip.rs:406–418`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/native/edwards_chip.rs#L406-L418); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/native/edwards_chip.rs).

```rust
        meta.create_gate("witness point", |meta| {
            let x = meta.query_advice(self.advice_cols[0], Rotation::cur());
            let y = meta.query_advice(self.advice_cols[1], Rotation::cur());

            let one = Expression::from(1);
            let edwards_d = Expression::Constant(C::D);

            let x_sq = x.square();
            let y_sq = y.square();

            let id = y_sq.clone() - x_sq.clone() - (one + edwards_d * x_sq * y_sq);

            Constraints::with_selector(*q_point, vec![("curve equation", id)])
```

The runnable [backend tests](ecc-validation-checks/src/lib.rs) use circuits
**7.2.4**, curves **0.3.1**, and stdlib **2.3.5**, with both proofs **0.8.3**
(the independent released-backend assessment) and **0.8.2** (the Compact-v3 /
Ledger-9 dependency). [§7.1](#71-completed-executable-checks) records the commands,
controls, and results.

For a generator point `(x,y)`, the raw public-input decoder accepts `(x+2,y)`
and returns that same generator. In contrast, MockProver rejects the
coordinate-construction relation with this altered pair. Full proof generation
produced bytes for the altered witness, but verification rejected those bytes;
a proof for the genuine coordinates verified successfully in the same test.
Producing proof bytes therefore does not establish that the constraints were
satisfied.

Small-order and mixed-torsion inputs also fail subgroup-assignment constraints,
even when a test deliberately forges the Rust subgroup wrapper using
`from_raw_unchecked`. Passing those inputs through coordinate construction
panics during synthesis instead of returning a clean validation error. This
is evidence for both subgroup enforcement and a separate error-handling problem.

These are direct backend tests, not compiled Compact-contract tests. Recommended
fix: compare **both** reconstructed coordinates with the supplied coordinates in
`from_xy`, retain the ZKIR decoder's re-encoding check, and return a validation
error for points outside the subgroup. See [§3.2.2](#322-coordinate-reconstruction-and-evaluator-boundaries)
for why raw decoding and coordinate construction must be considered separately.

### 3.3. secp256k1 and P-256 points

secp256k1 and P-256 share the foreign-curve point machinery but have distinct parameters and encodings. This subsection compares coordinate validation, identity flags, raw field decoding, and SEC1 imports.

> **Representation concern:** identity flags can cause coordinates to be ignored, and exported conversion helpers assume validated inputs. Do not treat a raw decoder or helper as a canonical, role-specific key importer; the remaining cross-layer canonicality tests are listed in [§7.2](#72-remaining-validation-work).

| Layer / public entry points | Checks and timing | Assessment |
|---|---|---|
| Compact object declarations and type adapters | Shape/range/flag encoding; curve validator is separate | Role-limited |
| `isValidSecp256k1Point/isValidSecp256r1Point` | Coordinate bounds; full curve equation for nonidentity; identity flag skips equation | Checked generic point; unused identity coordinates need separate canonical policy |
| `*ToProjective/*FromProjective`, `secp256k1Add/Mul/MulGenerator` and `secp256r1Add/Mul/MulGenerator`, coordinate getters | Conversions/arithmetic assume validated points; flagged identity maps to group zero; getters reject flagged identity | Role-limited; exported helpers are not validation boundaries |
| ZKIR `from_coordinates_offcircuit`, chips `point_from_coordinates` | Checks supplied full affine coordinates; affine construction cannot represent infinity | Checked curve; cofactor one gives subgroup membership |
| ZKIR `assign/encode/decode`, raw `AssignedForeignPoint` public-input adapters | Assignment enforces curve unless identity; decoder's identity flag can bypass coordinate decoding | Raw decoder role-limited; standalone ZKIR's round-trip guard checks canonicality |
| Midnight ZK `K256Affine::from_xy`, P-256 `affine_from_xy`, RustCrypto `FromEncodedPoint` | Uncompressed SEC1 coordinate parser validates curve membership | Checked; identity policy depends on generic point versus key wrapper |
| K256 `GroupEncoding::from_bytes/to_bytes`, P-256 re-exported SEC1/group encoders | Standard curve bytes through dependency adapters | Delegated curve parsing; not interchangeable with five-field ZKIR encoding |

Both secp validators require an object with bigint coordinates and a boolean
identity flag, bound both coordinates, and call `assertValidity()` only when
`identity` is false. Below are the complete secp256k1 check and the corresponding
P-256 curve-check branch.

Source: [Compact: `runtime/src/utils.ts:68–89`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L68-L89).

```typescript
export function isValidSecp256k1Point(p: unknown): p is Secp256k1Point {
  if (typeof p !== 'object' || p === null) {
    return false;
  }
  const { x, y, identity } = p as { x: unknown; y: unknown; identity: unknown };
  if (typeof x !== 'bigint' || typeof y !== 'bigint' || typeof identity !== 'boolean') {
    return false;
  }
  // The identity's coordinates never reach `fromAffine`, so the field range is checked here.
  if (x < 0n || x >= SECP256K1_BASE_MODULUS || y < 0n || y >= SECP256K1_BASE_MODULUS) {
    return false;
  }
  if (!identity) {
    try {
      // `fromAffine` only range-checks the coordinates, so the curve equation is checked separately.
      secp256k1.Point.fromAffine({ x, y }).assertValidity();
    } catch {
      return false;
    }
  }
  return true;
}
```

Source: [Compact: `runtime/src/utils.ts:123–144`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L123-L144).

```typescript
export function isValidSecp256r1Point(p: unknown): p is Secp256r1Point {
  if (typeof p !== 'object' || p === null) {
    return false;
  }
  const { x, y, identity } = p as { x: unknown; y: unknown; identity: unknown };
  if (typeof x !== 'bigint' || typeof y !== 'bigint' || typeof identity !== 'boolean') {
    return false;
  }
  // The identity's coordinates never reach `fromAffine`, so the field range is checked here.
  if (x < 0n || x >= SECP256R1_BASE_MODULUS || y < 0n || y >= SECP256R1_BASE_MODULUS) {
    return false;
  }
  if (!identity) {
    try {
      // `fromAffine` only range-checks the coordinates, so the curve equation is checked separately.
      p256.Point.fromAffine({ x, y }).assertValidity();
    } catch {
      return false;
    }
  }
  return true;
}
```

**Encoding nuance:** a flagged identity can carry any in-range `x,y` at this
validator boundary; it is not restricted to the usual `{x:0,y:0,identity:true}`.
The runtime converter maps any such flagged value to `Point.ZERO`. Thus
“range-valid coordinates” must not be described as a unique identity encoding
or curve membership of those unused coordinates.

Source: [Compact: `runtime/src/utils.ts:97–102`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L97-L102).

```typescript
export function secp256k1ToProjective(p: Secp256k1Point): ReturnType<typeof secp256k1.Point.fromAffine> {
  if (p.identity) {
    return secp256k1.Point.ZERO;
  }
  return secp256k1.Point.fromAffine({ x: p.x, y: p.y });
}
```

Source: [Compact: `runtime/src/utils.ts:152–157`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L152-L157).

```typescript
export function secp256r1ToProjective(p: Secp256r1Point): ReturnType<typeof p256.Point.fromAffine> {
  if (p.identity) {
    return p256.Point.ZERO;
  }
  return p256.Point.fromAffine({ x: p.x, y: p.y });
}
```

A focused comparison with Compact `main` on **7 October 2026**, commit
[`66d355efffe9e77b3814cebc0d50a28c95494420`](https://github.com/LFDT-Minokawa/compact/commit/66d355efffe9e77b3814cebc0d50a28c95494420),
confirms that the signature verifier and `utils.ts` validators quoted here are
unchanged from the pinned Compact snapshot. However, `toValue` now normalizes
a flagged secp identity's unused coordinates to zero. Validator acceptance and
serialization canonicalization remain distinct boundaries:

Source: [Compact main secp256k1 identity normalization](https://github.com/LFDT-Minokawa/compact/blob/66d355efffe9e77b3814cebc0d50a28c95494420/runtime/src/compact-types.ts#L144-L149).

```typescript
  toValue(value: Secp256k1Point): ocrt.Value {
    const [x, y] = value.identity ? [0n, 0n] : [value.x, value.y];
    return CompactTypeSecp256k1Base.toValue(x)
      .concat(CompactTypeSecp256k1Base.toValue(y))
      .concat(ocrt.bigIntToValue(value.identity ? 1n : 0n));
  },
```

The [P-256 counterpart](https://github.com/LFDT-Minokawa/compact/blob/66d355efffe9e77b3814cebc0d50a28c95494420/runtime/src/compact-types.ts#L181-L186) uses the same normalization.
This comparison covers those files; the dependency analysis in
[§2.1](#21-which-dependency-versions-were-actually-analysed) remains pinned to its
listed Compact revision.

For the foreign Weierstrass chip, coordinate construction fixes `is_id=false`
and asserts the curve equation; the generic assignment path allows identity,
and otherwise constrains curve membership. For secp256k1 and P-256, cofactor
one removes the need for an additional subgroup constraint.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/foreign/weierstrass_chip.rs:921–930`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/foreign/weierstrass_chip.rs#L921-L930); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/foreign/weierstrass_chip.rs).

```rust
        let cond = self.native_gadget.assign_fixed(layouter, true)?;
        on_curve::assert_is_on_curve::<F, C, B, N>(
            layouter,
            &cond,
            x,
            y,
            self.base_field_chip(),
            &self.config.on_curve_config,
        )?;
        // If from_xy fails, we give the identity as a default value, but note that
```

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/foreign/weierstrass_chip.rs:945–961`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/foreign/weierstrass_chip.rs#L945-L961); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/foreign/weierstrass_chip.rs).

```rust
    fn assign_without_subgroup_check(
        &self,
        layouter: &mut impl Layouter<F>,
        value: Value<C::CryptographicGroup>,
    ) -> Result<Self::Point, Error> {
        let p = self.assign_point_unchecked(layouter, value)?;
        let is_not_id = self.native_gadget.not(layouter, &p.is_id)?;
        on_curve::assert_is_on_curve::<F, C, B, N>(
            layouter,
            &is_not_id,
            &p.x,
            &p.y,
            self.base_field_chip(),
            &self.config.on_curve_config,
        )?;
        Ok(p)
    }
```

These are the reviewed circuit paths, not a claim that every internal helper
validates independently. Unsafe or unchecked helpers must be assessed at their
call sites.

Source: [c: runtime/src/built-ins.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L683-L709).

```typescript
export function secp256k1Add(a: Secp256k1Point, b: Secp256k1Point): Secp256k1Point {
  return secp256k1FromProjective(secp256k1ToProjective(a).add(secp256k1ToProjective(b)));
}

/**
 * The Compact builtin `ecMul` function for secp256k1 points.
 *
 * The point is assumed to be valid, points passed from compiler-generated code
 * are always valid ones.
 * @internal
 */
export function secp256k1Mul(a: Secp256k1Point, b: bigint): Secp256k1Point {
  // `multiplyUnsafe` is used, instead of `multiply`, because the latter rejects
  // a zero scalar; the "unsafe" (variable-time) is due to non-constant time
  // operations, which we don't guarantee anyways.
  return secp256k1FromProjective(secp256k1ToProjective(a).multiplyUnsafe(b));
}

/**
 * The Compact builtin `ecMulGenerator` function for secp256k1 points.
 */
export function secp256k1MulGenerator(b: bigint): Secp256k1Point {
  // `multiplyUnsafe` is used, instead of `multiply`, because the latter rejects
  // a zero scalar; the "unsafe" (variable-time) is due to non-constant time
  // operations, which we don't guarantee anyways.
  return secp256k1FromProjective(secp256k1.Point.BASE.multiplyUnsafe(b));
}
```

Full source: [cv: src/k256/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/k256/curve.rs#L104-L117).

Source: [relevant lines 105–116](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/k256/curve.rs#L105-L116).

```rust
    pub fn from_xy(x: Fp, y: Fp) -> Option<Self> {
        // Use uncompressed SEC1 encoding to avoid sqrt during decompression.
        // EncodedPoint::from_affine_coordinates takes big-endian x and y bytes.
        let encoded = k256::EncodedPoint::from_affine_coordinates(
            &x.to_bytes(),
            &y.to_bytes(),
            false, // Don't compress - we have both coordinates.
        );

        // from_encoded_point validates the point is on the curve.
        AffinePoint::from_encoded_point(&encoded).into_option().map(Self)
    }
```

Source: [cv: src/k256/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/k256/curve.rs#L213-L248).

Source: [cv: src/p256/mod.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/p256/mod.rs#L24-L54).

Source: [circuits 7.2.4 raw foreign public-input decoder](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/foreign/weierstrass_chip.rs#L249-L267).

```rust
    fn from_public_input(fields: &[F]) -> Option<C::CryptographicGroup> {
        if *fields.last()? == F::ONE {
            return Some(C::CryptographicGroup::identity());
        }
        let nb_limbs_per_batch = (F::CAPACITY / B::LOG2_BASE) as usize;
        if nb_limbs_per_batch == 0 {
            return None;
        }
        let nb_pi_per_coord = B::NB_LIMBS.div_ceil(nb_limbs_per_batch as u32) as usize;
        if fields.len() != 2 * nb_pi_per_coord + 1 {
            return None;
        }
        let x = AssignedField::<F, C::Base, B>::from_public_input(&fields[..nb_pi_per_coord])?;
        let y = AssignedField::<F, C::Base, B>::from_public_input(
            &fields[nb_pi_per_coord..nb_pi_per_coord * 2],
        )?;
        C::from_xy(x, y)?.try_into_subgroup()
    }
}
```

### 3.4. Edwards Curve25519 points

The Curve25519 interface reviewed here uses Edwards points and supports Compact Ed25519 verification. This subsection follows curve and subgroup checks across runtime validation, ZKIR decoding, and circuit assignment.

| Layer / public entry points | Checks and timing | Assessment |
|---|---|---|
| Compact `Curve25519Point`, type adapters, coordinate getters | Packaging/encoding without curve membership | Role-limited |
| `isValidCurve25519Point` | Field bounds, curve validity (except known identity), torsion freedom | Checked generic subgroup point; identity accepted |
| `curve25519ToProjective/FromProjective`, `curve25519Add/Mul/MulGenerator` | Arithmetic/conversion assumes point validation; multiplication permits zero scalars | Role-limited; `multiplyUnsafe` concerns timing, not a declaration that every point is invalid |
| ZKIR `from_coordinates_offcircuit`, raw point decoder | Curve construction then checked subgroup conversion | Checked subgroup on those paths |
| Chips `point_from_coordinates/assign/assign_many` | Curve equation and cofactor-root/multiple constraints in circuit | Checked subgroup constraints |
| Midnight ZK `Curve25519Affine::from_xy/from_edwards`, `Curve25519(pub EdwardsPoint)` | Affine constructor checks equation; Edwards conversion/wrapper alone does not require subgroup | Checked curve, role-limited |
| `Curve25519[Affine]::from_bytes/to_bytes`, `from_bytes_unchecked` | Compressed EdwardsY decompression; unchecked alias has same body; no subgroup conversion | Role-limited as subgroup/key decoding |
| `Curve25519Subgroup::from_edwards`, `into_subgroup` | Explicit `is_torsion_free()` | Checked generic subgroup; identity accepted |

Curve25519 uses Edwards `(x,y)`, explicitly permits identity `(0,1)`, checks
field bounds, validates other points, and requires `isTorsionFree()`.

Source: [Compact: `runtime/src/utils.ts:178–204`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L178-L204).

```typescript
export function isValidCurve25519Point(p: unknown): p is Curve25519Point {
  if (typeof p !== 'object' || p === null) {
    return false;
  }

  const { x, y } = p as { x: unknown; y: unknown };
  if (typeof x !== 'bigint' || typeof y !== 'bigint') {
    return false;
  }
  // `fromAffine` only checks the coordinates fit in 256 bits, so the field range is checked here.
  if (x < 0n || x >= CURVE25519_BASE_MODULUS || y < 0n || y >= CURVE25519_BASE_MODULUS) {
    return false;
  }
  // `assertValidity` rejects the identity, so it is only called for other points.
  if (x !== 0n || y !== 1n) {
    try {
      const pt = ed25519.Point.fromAffine({ x, y });
      pt.assertValidity();
      if (!pt.isTorsionFree()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
```

The foreign Edwards assignment explicitly constrains the cofactor root on the
curve and multiplies by the cofactor. This is the circuit-side subgroup argument
for Curve25519; accepting only a subgroup-typed Rust witness would not, by
itself, constrain an adversarial prover.

Source: [midnight-circuits 7.2.4: `circuits/src/ecc/foreign/edwards_chip.rs:562–578`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/circuits/src/ecc/foreign/edwards_chip.rs#L562-L578); [published crate source](https://docs.rs/crate/midnight-circuits/7.2.4/source/src/ecc/foreign/edwards_chip.rs).

```rust
    fn assign(
        &self,
        layouter: &mut impl Layouter<F>,
        p_value: Value<C::CryptographicGroup>,
    ) -> Result<AssignedForeignEdwardsPoint<F, C, B>, Error> {
        // Let h be the cofactor of the subgroup.
        //
        // Instead of witnessing P, we witness an h-root Q, and return h * Q.
        // This guarantess that the returned point is in the desired subgroup.
        let cofactor = C::ScalarField::from_u128(C::COFACTOR);
        let q =
            self.assign_point_unchecked(layouter, p_value.map(|p| p * cofactor.invert().unwrap()))?;

        self.assert_on_curve(layouter, &q.x, &q.y)?;
        self.mul_by_constant(layouter, cofactor, &q)
    }

```

Full source: [cv: src/curve25519/affine.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/curve25519/affine.rs#L86-L110).

Source: [relevant lines 91–99](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/curve25519/affine.rs#L91-L99).

```rust
        let x2 = x.square();
        let y2 = y.square();
        let lhs = CURVE_A * x2 + y2;
        let rhs = Fp::ONE + CURVE_D * x2 * y2;

        if lhs != rhs {
            return None;
        }

```

Source: [relevant lines 102–109](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/curve25519/affine.rs#L102-L109).

```rust
        let x_sign = x.to_bytes()[0] & 1;
        bytes[31] |= x_sign << 7;

        let compressed = CompressedEdwardsY(bytes);
        let point = compressed.decompress()?;

        Some(Self { x, y, point })
    }
```

Source: [cv: src/curve25519/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/curve25519/curve.rs#L210-L232).

Source: [cv: src/curve25519/curve.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/curve25519/curve.rs#L372-L391).

```rust
impl GroupEncoding for Curve25519 {
    type Repr = [u8; 32];

    fn from_bytes(bytes: &Self::Repr) -> CtOption<Self> {
        let compressed = CompressedEdwardsY(*bytes);
        match compressed.decompress() {
            Some(point) => CtOption::new(Curve25519(point), Choice::from(1u8)),
            None => CtOption::new(Curve25519(EdwardsPoint::identity()), Choice::from(0u8)),
        }
    }

    fn from_bytes_unchecked(bytes: &Self::Repr) -> CtOption<Self> {
        Self::from_bytes(bytes)
    }

    fn to_bytes(&self) -> Self::Repr {
        self.0.compress().to_bytes()
    }
}

```

Source: [c: runtime/src/built-ins.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L797-L823).

```typescript
export function curve25519Add(a: Curve25519Point, b: Curve25519Point): Curve25519Point {
  return curve25519FromProjective(curve25519ToProjective(a).add(curve25519ToProjective(b)));
}

/**
 * The Compact builtin `ecMul` function for Curve25519 points.
 *
 * The points are assumed to be valid, points passed from
 * compiler-generated code are always valid ones.
 * @internal
 */
export function curve25519Mul(a: Curve25519Point, b: bigint): Curve25519Point {
  // `multiplyUnsafe` is used, instead of `multiply`, because the latter rejects
  // a zero scalar; the "unsafe" is due to non-constant time operations, which
  // we don't guarantee anyways.
  return curve25519FromProjective(curve25519ToProjective(a).multiplyUnsafe(b));
}

/**
 * The Compact builtin `ecMulGenerator` function for Curve25519 points.
 */
export function curve25519MulGenerator(b: bigint): Curve25519Point {
  // `multiplyUnsafe` is used, instead of `multiply`, because the latter rejects
  // a zero scalar; the "unsafe" is due to non-constant time operations, which
  // we don't guarantee anyways.
  return curve25519FromProjective(ed25519.Point.BASE.multiplyUnsafe(b));
}
```

### 3.5. BLS12-381 proof-system points

This subsection inventories BLS12-381 point construction and decoding underneath the proof system. It distinguishes checked subgroup imports from raw formats and constructors whose callers must establish the required invariants.

> **Unchecked imports require trust:** the unchecked point decoders and raw formats shown below bypass checks performed by their checked counterparts. They must not be used as validation of attacker-controlled proof or key material.

BLS12-381 G1/G2 points belong to the proof system, not the four contract point
types. Curve declarations, compressed decoding, raw object deserialization,
and proof-key parsing must be distinguished.

| Public methods / traits | Checks and format | Assessment |
|---|---|---|
| `G1Affine/G2Affine`, projective types; `Group::identity/generator/random`, arithmetic and affine/projective conversions | Typed group construction/results; generic identity permitted | Generic operations, not a key-role check |
| `GroupEncoding::from_bytes/to_bytes`, affine `from_compressed/to_compressed` | Compressed encoding; checked decoder calls torsion-freedom check after decompression | Checked subgroup import |
| `UncompressedEncoding::from_uncompressed/to_uncompressed` | Checked import calls torsion-freedom check after underlying decode | Checked subgroup import |
| `from_compressed_unchecked`, `from_uncompressed_unchecked`, `from_bytes_unchecked` | Underlying blst parsing, without the extra torsion check in the checked wrapper | Unchecked subgroup; trust/invariant assumptions required |
| `CurveAffine::from_xy` | Constructs raw coordinates, then calls `is_torsion_free`; excerpt does not separately call `is_on_curve` | Not assessed beyond the displayed check; do not equate it with an explicit coordinate-equation validation audit |
| `from_raw_unchecked`, `SerdeObject::from_raw_bytes_unchecked/read_raw_unchecked` | Raw wrapping/unchecked deserialization; some malformed lengths can panic | Unchecked; not an untrusted-byte validation boundary |
| `SerdeObject::from_raw_bytes/read_raw`, `to_raw_bytes/write_raw` | Uncompressed checked import versus output-only encoding | Checked import; exact stream exhaustion is caller's responsibility |
| Proof `Processed`, `RawBytes`, `RawBytesUnchecked` formats | Different decoding checks; wrapper initialization also matters | See [§6.4](#64-proof-system-keys-and-kzg-commitments-on-bls12-381) |

Source: [cv: src/bls12_381/g1.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/bls12_381/g1.rs#L350-L386).

```rust
    fn from_uncompressed(bytes: &[u8; UNCOMPRESSED_SIZE]) -> CtOption<Self> {
        G1Affine::from_uncompressed_unchecked(bytes)
            .and_then(|p| CtOption::new(p, p.is_torsion_free()))
    }

    /// Attempts to deserialize an uncompressed element, not checking if the
    /// element is on the curve and not checking if it is in the correct
    /// subgroup.
    ///
    /// **This is dangerous to call unless you trust the bytes you are reading;
    /// otherwise, API invariants may be broken.** Please consider using
    /// `from_uncompressed()` instead.
    fn from_uncompressed_unchecked(bytes: &[u8; UNCOMPRESSED_SIZE]) -> CtOption<Self> {
        let mut raw = blst_p1_affine::default();
        let success =
            unsafe { blst_p1_deserialize(&mut raw, bytes.as_ptr()) == BLST_ERROR::BLST_SUCCESS };
        CtOption::new(G1Affine(raw), Choice::from(success as u8))
    }

    /// Attempts to deserialize a compressed element.
    fn from_compressed(bytes: &[u8; COMPRESSED_SIZE]) -> CtOption<Self> {
        G1Affine::from_compressed_unchecked(bytes)
            .and_then(|p| CtOption::new(p, p.is_torsion_free()))
    }

    /// Attempts to deserialize an uncompressed element, not checking if the
    /// element is in the correct subgroup.
    ///
    /// **This is dangerous to call unless you trust the bytes you are reading;
    /// otherwise, API invariants may be broken.** Please consider using
    /// `from_compressed()` instead.
    fn from_compressed_unchecked(bytes: &[u8; COMPRESSED_SIZE]) -> CtOption<Self> {
        let mut raw = blst_p1_affine::default();
        let success =
            unsafe { blst_p1_uncompress(&mut raw, bytes.as_ptr()) == BLST_ERROR::BLST_SUCCESS };
        CtOption::new(G1Affine(raw), Choice::from(success as u8))
    }
```

Source: [cv: src/bls12_381/g2.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/bls12_381/g2.rs#L360-L397).

```rust
    /// Attempts to deserialize an uncompressed element.
    fn from_uncompressed(bytes: &[u8; UNCOMPRESSED_SIZE]) -> CtOption<Self> {
        G2Affine::from_uncompressed_unchecked(bytes)
            .and_then(|p| CtOption::new(p, p.is_torsion_free()))
    }

    /// Attempts to deserialize an uncompressed element, not checking if the
    /// element is on the curve and not checking if it is in the correct
    /// subgroup.
    ///
    /// **This is dangerous to call unless you trust the bytes you are reading;
    /// otherwise, API invariants may be broken.** Please consider using
    /// `from_uncompressed()` instead.
    fn from_uncompressed_unchecked(bytes: &[u8; UNCOMPRESSED_SIZE]) -> CtOption<Self> {
        let mut raw = blst_p2_affine::default();
        let success =
            unsafe { blst_p2_deserialize(&mut raw, bytes.as_ptr()) == BLST_ERROR::BLST_SUCCESS };
        CtOption::new(G2Affine(raw), Choice::from(success as u8))
    }

    /// Attempts to deserialize a compressed element.
    fn from_compressed(bytes: &[u8; COMPRESSED_SIZE]) -> CtOption<Self> {
        G2Affine::from_compressed_unchecked(bytes)
            .and_then(|p| CtOption::new(p, p.is_torsion_free()))
    }

    /// Attempts to deserialize an uncompressed element, not checking if the
    /// element is in the correct subgroup.
    ///
    /// **This is dangerous to call unless you trust the bytes you are reading;
    /// otherwise, API invariants may be broken.** Please consider using
    /// `from_compressed()` instead.
    fn from_compressed_unchecked(bytes: &[u8; COMPRESSED_SIZE]) -> CtOption<Self> {
        let mut raw = blst_p2_affine::default();
        let success =
            unsafe { blst_p2_uncompress(&mut raw, bytes.as_ptr()) == BLST_ERROR::BLST_SUCCESS };
        CtOption::new(G2Affine(raw), Choice::from(success as u8))
    }
```

Source: [cv: src/bls12_381/g1.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/bls12_381/g1.rs#L416-L440).

```rust
    fn from_raw_unchecked(x: Fp, y: Fp, _infinity: bool) -> Self {
        // FIXME: what about infinity?
        let raw = blst_p1_affine { x: x.0, y: y.0 };
        G1Affine(raw)
    }
}

impl SerdeObject for G1Affine {
    fn from_raw_bytes_unchecked(bytes: &[u8]) -> Self {
        debug_assert_eq!(bytes.len(), UNCOMPRESSED_SIZE);
        let input: [u8; UNCOMPRESSED_SIZE] = bytes.try_into().unwrap();
        Self::from_uncompressed_unchecked(&input).unwrap()
    }

    fn from_raw_bytes(bytes: &[u8]) -> Option<Self> {
        debug_assert_eq!(bytes.len(), UNCOMPRESSED_SIZE);
        let input: [u8; UNCOMPRESSED_SIZE] = bytes.try_into().unwrap();
        Self::from_uncompressed(&input).into()
    }

    fn to_raw_bytes(&self) -> Vec<u8> {
        self.to_uncompressed().into()
    }

    fn read_raw_unchecked<R: Read>(reader: &mut R) -> Self {
```

Source: [cv: src/bls12_381/g1.rs](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/bls12_381/g1.rs#L973-L980).

```rust
    fn from_xy(x: Self::Base, y: Self::Base) -> CtOption<Self> {
        let p = Self::from_raw_unchecked(x, y, false);
        CtOption::new(p, p.is_torsion_free())
    }

    fn is_on_curve(&self) -> Choice {
        unsafe { Choice::from(blst_p1_affine_on_curve(&self.0) as u8) }
    }
```

### 3.6. Scalar declarations and integer encoding

Scalars are the numbers used for secret keys, nonces, and point multiplication. This subsection distinguishes canonical integer decoding from modular reduction and explains why field validity alone does not establish a usable secret key.

> **Unsafe key-policy assumption:** accepting a scalar as a field element does not establish that it is nonzero. The concrete zero-encryption-key hazard is traced in [§5.1.1](#511-secret-keys-and-public-key-derivation).

Ledger scalar wrappers decode a SCALE integer and reject high nonzero bytes or
failure of the field's `from_repr`. The representative range check is identical
in all three snapshots. It does not exclude zero.

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:116–134`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L116-L134), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L116-L134), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L116-L134).

```rust
            fn try_from(val: ScaleBigInt) -> std::io::Result<$name> {
                if val.0[FR_BYTES..].iter().any(|b| *b != 0) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        concat!("out of range for ", stringify!($ty)),
                    ));
                }
                let cont_buf: [u8; FR_BYTES] = val.0[..FR_BYTES]
                    .try_into()
                    .expect("slice of known size must coerce to array");
                Ok($name(
                    <Option<_>>::from(<$wrapped>::from_repr(cont_buf.into())).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            concat!("out of range for ", stringify!($name)),
                        )
                    })?,
                ))
            }
```

Ledger 8.1.2 and Ledger 9 rc.5 also reject non-minimal SCALE integer encodings.
The relevant branches enforce shortest-form representation. This is a specific
verified primitive, not evidence that all deserializers reject every type
invariant violation.

<details>
<summary>SCALE integer canonicality checks</summary>

Source: [Ledger 8.1.2: `serialize/src/util.rs:271–312`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/serialize/src/util.rs#L271-L312), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/serialize/src/util.rs#L271-L312).

```rust
            SCALE_ONE_BYTE_MARKER => res.0[0] = top6bits(first),
            SCALE_TWO_BYTE_MARKER => {
                let second = u8::deserialize(reader, recursion_depth)?;
                if second == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "non-canonical scale encoding",
                    ));
                }
                res.0[0] = top6bits(first) | bot2bits(second);
                res.0[1] = top6bits(second);
            }
            SCALE_FOUR_BYTE_MARKER => {
                let second = u8::deserialize(reader, recursion_depth)?;
                let third = u8::deserialize(reader, recursion_depth)?;
                let fourth = u8::deserialize(reader, recursion_depth)?;
                if third == 0 && fourth == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "non-canonical scale encoding",
                    ));
                }
                res.0[0] = top6bits(first) | bot2bits(second);
                res.0[1] = top6bits(second) | bot2bits(third);
                res.0[2] = top6bits(third) | bot2bits(fourth);
                res.0[3] = top6bits(fourth);
            }
            SCALE_N_BYTE_MARKER => {
                let n = top6bits(first) as usize + 4;
                reader.read_exact(&mut res.0[..n])?;
                // Trailing zeros imply this encoding isn't sufficiently compact.
                // If n == 4, this integer should be *outside* the legal encoding for the 4-byte
                // limit.
                if res.0[n - 1] == 0 || (n == 4 && res.0[3] < 64) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "non-canonical scale encoding",
                    ));
                }
            }
            _ => unreachable!(),
        }
```

</details>

The encoding distinction also applies to nonce/secret scalars. Canonical scalar
parsing can accept zero; modular reduction is not canonical decoding of a
byte representation. Ledger's short-byte scalar importers accept at most 32
little-endian bytes and zero-pad them. Its wide importer reduces instead of
rejecting values at or above the modulus:

Source: [l9: transient-crypto/src/curve.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L375-L403).

```rust
impl EmbeddedFr {
    /// Interpret a little-endiang byte-string as an [`EmbeddedFr`].
    pub fn from_le_bytes(bytes: &[u8]) -> Option<Self> {
        let mut repr = [0u8; FR_BYTES];
        if bytes.len() <= repr.len() {
            repr[..bytes.len()].copy_from_slice(bytes)
        } else {
            return None;
        }
        embedded::Scalar::from_repr(repr).map(EmbeddedFr).into()
    }

    /// Interpret a little-endian byte-string of at most 32 bytes as an [`EmbeddedFr`],
    /// reducing modulo the embedded scalar field order via wide reduction.
    ///
    /// Returns `None` if `bytes.len() > FR_BYTES`.
    pub fn from_le_bytes_wide(bytes: &[u8]) -> Option<Self> {
        if bytes.len() > FR_BYTES {
            return None;
        }
        let mut wide = [0u8; 64];
        wide[..bytes.len()].copy_from_slice(bytes);
        Some(EmbeddedFr(embedded::Scalar::from_bytes_wide(&wide)))
    }

    /// Output an [`EmbeddedFr`] as a little-endian bytes-string
    pub fn as_le_bytes(&self) -> Vec<u8> {
        self.0.to_bytes().to_vec()
    }
```

## 4. Signature schemes

This section compares each exposed signature scheme and curve, including key generation and import, signature encoding, nonce handling, and verification. Generic point checks from [§3](#3-elliptic-curve-point-declaration-deserialization-and-encoding) are considered separately from the additional rules needed for signature keys and announcements.

> **Signature hazards and policy differences:** Ledger 9’s Jubjub signer can sample a zero nonce that its verifier rejects ([§4.2](#42-schnorr-with-poseidon-challenge-on-jubjub)). Compact and native Ledger also differ on announcement and ECDSA normalization policies; these are acceptance differences, not demonstrated signature forgeries. Public-key recovery requires application identity binding ([§4.4](#44-ecdsa-on-secp256k1)).

### 4.1. Scheme and curve availability

The table identifies dedicated signature interfaces in each reviewed snapshot. It distinguishes complete scheme entry points from the generic arithmetic used to implement a scheme.

| Scheme / curve | Compact contract circuits | Ledger 8.1.2 | Ledger 9 rc.5 | Pinned Ledger main | ZKIR / Midnight ZK role |
|---|---|---|---|---|---|
| Poseidon-challenge Schnorr / Jubjub | `jubjubSchnorrVerify` | No native module | Native `sign/vk/verify` | No native module | Generic Jubjub, hash, scalar and equality operations |
| BIP340 Schnorr / secp256k1 | No dedicated verifier in the listed standard libraries | `base-crypto::signatures` | `base-crypto::schnorr` | `base-crypto::signatures` | Point library support is not an exposed BIP340 opcode |
| ECDSA / secp256k1 | v3 `secp256k1EcdsaVerify`; runtime recovery | No dedicated base ECDSA module | `base-crypto::ecdsa` | No dedicated base ECDSA module | v3 secp arithmetic |
| ECDSA / P-256 | v3 `secp256r1EcdsaVerify` | No dedicated module in the inventoried Ledger crypto exports | Same | Same | v3 P-256 arithmetic |
| Ed25519 / Edwards25519 | v3 `ed25519Verify` | No dedicated module in the inventoried Ledger crypto exports | Same | Same | v3 subgroup arithmetic and SHA-512 in Compact verification |

The table inventories dedicated scheme entry points, not every signature scheme
that can be constructed from generic arithmetic or accessed through a third-party
crate. Native Ledger `verify(msg,signature)` and Compact's hash-input verifier
can also use different message hashing conventions; do not assume byte-for-byte
interoperability from a shared curve name.

#### 4.1.1. JavaScript runtime and WASM signing versus contract circuits

Compact contracts and JavaScript/WASM callers reach different signing and verification interfaces. This subsection traces the runtime exports to Ledger key parsing and explains their tagged and hexadecimal encodings.

Compact additionally re-exports `sampleSigningKey`, `signingKeyFromBip340`,
`signData`, `signatureVerifyingKey`, and `verifySignature` from the Ledger
onchain runtime. These are JavaScript/WASM APIs, not signature-verification
circuits compiled inside a Compact contract.

| Entry point | Ledger 8 / main interface | Ledger 9 interface | Validation boundary |
|---|---|---|---|
| `sampleSigningKey` | Schnorr key exported as hex | Optional `schnorr`/`ecdsa` selector, kind-tagged result | Native signing-key sampler |
| `signingKeyFromBip340` | Raw secret bytes to hex | Raw secret bytes to Schnorr-tagged result | Native Schnorr key import; rejects zero via dependency |
| `signData`, `signatureVerifyingKey` | Import secret-key hex, sign/derive, export hex | Kind-tagged Schnorr/ECDSA keys | Native parser before operation; no raw nonce input |
| `verifySignature` | Key/signature hex and message bytes | Matching kind-tagged key/signature; kind mismatch gives false | Native key/signature parsing and verification |
| Hex encoding/decoding | Native `Serializable` payload represented as hex | Same inside kind-tagged object | `from_value_hex_ser` also enforces stream exhaustion |

Compact's actual dependency versions are those in [§2.1](#21-which-dependency-versions-were-actually-analysed). Its Ledger 9 rc.3
dependency has the same kind-tagged methods as Ledger 9 rc.5;
both immutable sources are linked below. The Compact export list establishes the public names;
Ledger snapshot code below establishes branch-specific behavior.

Source: [c: runtime/src/index.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/index.ts#L75-L79).

Source: [lm: onchain-runtime-wasm/src/primitives.rs](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/onchain-runtime-wasm/src/primitives.rs#L65-L95).

Source: [l9: onchain-runtime-wasm/src/primitives.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/onchain-runtime-wasm/src/primitives.rs#L69-L140), [Compact's Ledger 9 rc.3 dependency](https://github.com/midnightntwrk/midnight-ledger/blob/4823b5351b17cc49e30f19760dbd30a73cf95e22/onchain-runtime-wasm/src/primitives.rs#L69-L140).

Source: [l9: onchain-runtime-wasm/src/lib.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/onchain-runtime-wasm/src/lib.rs#L74-L94).

```rust
pub fn from_value_hex_ser<T: Deserializable>(data: &str) -> Result<T, wasm_bindgen::JsError> {
    from_hex_ser_checked(&mut &<Vec<u8>>::from_hex(data.as_bytes())?[..]).map_err(Into::into)
}

fn from_hex_ser_checked<T: Deserializable, R: Read>(mut bytes: R) -> Result<T, std::io::Error> {
    let value = T::deserialize(&mut bytes, 0)?;

    #[allow(clippy::unbuffered_bytes)]
    let count = bytes.bytes().count();

    if count == 0 {
        return Ok(value);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("Not all bytes read, {} bytes remaining", count),
    ))
}

pub(crate) fn to_value_ser<T: Serializable + Tagged>(
```

Source: [Ledger 9 kind-tagged signing material](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/onchain-runtime-wasm/src/conversions.rs#L26-L37).

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "tag", content = "value")]
#[serde(rename_all = "kebab-case")]
// Common container type for signatures, signature verifying keys, and signing keys.
// This is largely a serialization intermediary for the
// `{ tag: 'schnorr' | 'ecdsa, value: string }` TS type, shared for these types, with the value
// string being a hex-encoding of the raw underlying data.
pub enum PreSignature {
    Schnorr(String),
    #[serde(rename = "ecdsa")]
    ECDSA(String),
}
```

The high-level signature verifiers quoted here are **Compact circuits** built
from arithmetic, hashing, and point operations. The reviewed ZKIR instruction
sets do not contain a dedicated signature-verification opcode; that does not
mean contracts compiled to ZKIR cannot verify signatures. See the complete
[Ledger-main legacy instruction enum](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/zkir/src/ir.rs#L114-L354)
and [Ledger-9 v3 instruction enum](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir.rs#L360-L919).
The v3 instruction implementation modules expose these lower-level operations:

Source: [Ledger 9 v3 instruction modules](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zkir-v3/src/ir_instructions/mod.rs#L18-L31).

```rust
pub mod add;
pub mod assign;
pub mod constrain_eq;
pub mod ec_mul;
pub mod encode;
pub mod eq;
pub mod from_bytes32;
pub mod from_coordinates;
pub mod into_bytes32;
pub mod into_coordinates;
pub mod inv;
pub mod mul;
pub mod neg;
pub mod select;
```

Source: [Ledger 8.1.2: `transient-crypto/src/lib.rs:26–36`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/lib.rs#L26-L36).

```rust
pub mod commitment;
pub mod curve;
pub mod encryption;
pub mod fab;
pub mod hash;
mod macros;
pub mod merkle_tree;
#[cfg(feature = "mock-verify")]
pub mod mock_verify;
pub mod proofs;
pub mod repr;
```

Source: [Ledger 9 rc.5: `transient-crypto/src/lib.rs:26–37`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/lib.rs#L26-L37).

```rust
pub mod commitment;
pub mod curve;
pub mod encryption;
pub mod fab;
pub mod hash;
mod macros;
pub mod merkle_tree;
#[cfg(feature = "mock-verify")]
pub mod mock_verify;
pub mod proofs;
pub mod repr;
pub mod schnorr;
```

Source: [Ledger main: `transient-crypto/src/lib.rs:26–36`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/lib.rs#L26-L36).

```rust
pub mod commitment;
pub mod curve;
pub mod encryption;
pub mod fab;
pub mod hash;
mod macros;
pub mod merkle_tree;
#[cfg(feature = "mock-verify")]
pub mod mock_verify;
pub mod proofs;
pub mod repr;
```

Source: [Ledger 8.1.2: `base-crypto/src/lib.rs:25–32`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/base-crypto/src/lib.rs#L25-L32).

```rust
pub mod cost_model;
pub mod data_provider;
pub mod fab;
pub mod hash;
pub mod repr;
pub mod rng;
pub mod signatures;
pub mod time;
```

Source: [Ledger 9 rc.5: `base-crypto/src/lib.rs:25–34`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/lib.rs#L25-L34).

```rust
pub mod cost_model;
pub mod data_provider;
pub mod ecdsa;
pub mod envelope;
pub mod fab;
pub mod hash;
pub mod repr;
pub mod rng;
pub mod schnorr;
pub mod time;
```

Source: [Ledger main: `base-crypto/src/lib.rs:25–32`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/base-crypto/src/lib.rs#L25-L32).

```rust
pub mod cost_model;
pub mod data_provider;
pub mod fab;
pub mod hash;
pub mod repr;
pub mod rng;
pub mod signatures;
pub mod time;
```

### 4.2. Schnorr with Poseidon challenge on Jubjub

This scheme signs native-field messages using Jubjub points and a Poseidon-derived challenge. The comparison follows the secret key, public key, nonce, announcement, and response through Compact and Ledger 9.

> **Nonce hazard:** the displayed signer does not retry a zero nonce, while its verifier rejects the resulting identity announcement. Compact has no explicit identity-announcement rejection in the displayed relation; its compiled acceptance remains to be tested.

An **announcement** is the signature point `R = nonce·G`, not the signer's
public key `P = secret·G`. An identity announcement means `R` is group zero.
The verification relation is `s·G = R + c·P`.

| Material / operation | Compact | Native Ledger 9 | Checks and assessment |
|---|---|---|---|
| Secret-key declaration/import/export | No dedicated signer/key importer in this verifier API; user can supply generic scalar witnesses | `EmbeddedFr`, `from_le_bytes/from_le_bytes_wide/as_le_bytes`, scalar serialization | Scalar range/reduction as in [§3.6](#36-scalar-declarations-and-integer-encoding); zero is possible; role-limited |
| Public-key generation | Generic `ecMulGenerator` | `vk(sk)` | Multiplication only; identity possible for zero secret |
| Public-key import/export | Point objects / Compact type encoding | `EmbeddedGroupAffine` compressed serialization | Generic subgroup import allows identity; identity is rejected at verification |
| Nonce generation/import | No dedicated signing nonce API | `sign` samples `EmbeddedFr` from caller RNG | `Rng + CryptoRng`; no zero retry in the displayed signer; hazardous edge case because its verifier rejects identity announcement |
| Signature declaration/import/export | `JubjubSchnorrSignature {announcement,response:Field}` | Public `SchnorrSignature {announcement,response:EmbeddedFr}` | Native struct has no derived `Serializable` here; fields can be encoded individually; no dedicated composite wire decoder shown |
| Verification | Identity-PK assertion; scalar casts and equation | Rejects identity PK and announcement, then equation | Different announcement policy; subgroup and representation validation come from [§3.2](#32-jubjub-points) |

Source: [l9: transient-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/schnorr.rs#L24-L31).

```rust
/// A Schnorr signature over the embedded curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchnorrSignature {
    /// The announcement point, `R = k * G`.
    pub announcement: EmbeddedGroupAffine,
    /// The response scalar, `s = k + c * sk`.
    pub response: EmbeddedFr,
}
```

Source: [l9: transient-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/schnorr.rs#L52-L72).

```rust
/// Produces a Schnorr signature over the Jubjub curve.
pub fn sign<R: Rng + CryptoRng>(rng: &mut R, sk: EmbeddedFr, msg: &[Fr]) -> SchnorrSignature {
    let pk = EmbeddedGroupAffine::generator() * sk;
    // Unwraps cannot fail as the inner curve is an edwards curve, and the
    // identity is part of the curve (i.e., identity also has coordinates).
    let pk_x = pk.x().unwrap();
    let pk_y = pk.y().unwrap();

    let nonce: EmbeddedFr = rng.r#gen();
    let announcement = EmbeddedGroupAffine::generator() * nonce;
    let ann_x = announcement.x().unwrap();
    let ann_y = announcement.y().unwrap();

    let challenge = compute_challenge(ann_x, ann_y, pk_x, pk_y, msg);
    let response = nonce + challenge * sk;

    SchnorrSignature {
        announcement,
        response,
    }
}
```

Source: [l9: transient-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/schnorr.rs#L94-L97).

```rust
/// Computes the verifying key from a secret key.
pub fn vk(sk: EmbeddedFr) -> EmbeddedGroupAffine {
    EmbeddedGroupAffine::generator() * sk
}
```

All four Compact verifiers explicitly reject the identity public key. The
Jubjub verifier then checks its Schnorr relation; it contains **no explicit
identity-announcement rejection**. Its response is a `Field` cast to
`JubjubScalar`, so it should not be described as a canonically imported
Jubjub-scalar signature encoding.

Source: [Compact: `compiler/standard-library.compact:353–357`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/standard-library.compact#L353-L357).

```compact
// Schnorr signature
export struct JubjubSchnorrSignature {
  announcement: JubjubPoint,
  response: Field,
}
```

Source: [Compact: `compiler/standard-library.compact:369–389`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/standard-library.compact#L369-L389).

```compact
export circuit jubjubSchnorrVerify<#N>(
                 msg: Vector<N, Field>,
                 signature: JubjubSchnorrSignature,
                 pk: JubjubPoint
                 ): Boolean {
  assert(pk != default<JubjubPoint>, "JubjubPoint identity is not a permitted jubjubSchnorrVerify verification key");
  const {announcement, response} = signature;
  const cNative = transientHash<JubjubSchnorrHashInput<N>>(
                    JubjubSchnorrHashInput<N> { annX: jubjubPointX(announcement),
                                                annY: jubjubPointY(announcement),
                                                pkX: jubjubPointX(pk),
                                                pkY: jubjubPointY(pk),
                                                msg: msg }
                    );
  const c = cNative as JubjubScalar;

  const lhs = ecMulGenerator(response as JubjubScalar);
  const rhs = ecAdd(announcement, ecMul(pk, c));

  return lhs == rhs;
}
```

Ledger 9 rejects both `pk` and `sig.announcement` when identity. This differs
from Compact's explicit policy. Identity announcements are not intrinsically
invalid subgroup points; the protocol must choose and consistently enforce
its policy. The source difference alone is not a signature forgery.

Source: [Ledger 9 rc.5: `transient-crypto/src/schnorr.rs:74–93`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/schnorr.rs#L74-L93).

```rust
/// Verifies a Schnorr signature over the Jubjub curve.
pub fn verify(pk: EmbeddedGroupAffine, msg: &[Fr], sig: &SchnorrSignature) -> bool {
    // A valid public key and announcement must not be the identity element.
    if pk.is_identity() || sig.announcement.is_identity() {
        return false;
    }
    let pk_x = pk.x().unwrap();
    let pk_y = pk.y().unwrap();

    let ann_x = sig.announcement.x().unwrap();
    let ann_y = sig.announcement.y().unwrap();

    let challenge = compute_challenge(ann_x, ann_y, pk_x, pk_y, msg);

    let lhs = EmbeddedGroupAffine::generator() * sig.response;
    let rhs = sig.announcement + pk * challenge;

    lhs == rhs
}

```

| Verifier | Explicit identity PK rejection | Explicit identity announcement rejection |
|---|---|---|
| Compact Jubjub Schnorr | Yes, assertion | No |
| Ledger 9 native Jubjub Schnorr | Yes, returns false | Yes, returns false |
| Compact Ed25519 | Yes, zero-`x` assertion | No |
| Compact secp256k1 / P-256 ECDSA | Yes, assertion | Signature contains scalar `r,s`, not a supplied nonce point |

The generic subgroup invariant for announcements must come from point
construction/assignment and decoding, not from the public-key identity check.

### 4.3. BIP340 Schnorr on secp256k1

Ledger exposes BIP340 Schnorr signing and verification on secp256k1 through its native and WASM APIs. This subsection traces the fixed-size key and signature encodings to the underlying dependency checks.

| Material / public operation | Format and checks | Assessment |
|---|---|---|
| Ledger `SigningKey::sample` | Delegates cryptographic randomness to k256's nonzero scalar sampler | Checked nonzero signing key |
| `SigningKey::from_bytes`, `deserialize` | Big-endian secret bytes through k256 `NonZeroScalar` parser; rejects zero/out-of-range | Checked key import; wrapper deserialize reads a 32-byte prefix |
| `SigningKey::serialize`, `verifying_key` | 32-byte secret export; derives x-only verification key | Output-only; exporting the secret requires appropriate handling |
| `VerifyingKey::deserialize/serialize` | 32-byte x-only key; delegated affine nonidentity guard at import | Checked public-key import; whole-input exhaustion is caller-dependent |
| `SigningKey::sign(rng,msg)` | Delegates randomized signing; randomness is auxiliary input to nonce derivation, not a directly imported nonce scalar | No public Ledger nonce export/import method in this wrapper |
| `Signature::serialize/deserialize` | Fixed 64-byte signature; parser delegates to `schnorr::Signature::try_from` | Syntax/scalar checks at import; equation checked at verification |
| `VerifyingKey::verify` | Calls dependency verifier | Delegated verification; not the Jubjub announcement policy |

These entry points are named `signatures` in Ledger 8/main and `schnorr` in
Ledger 9. The pinned files expose the same corresponding key lifecycle; the
[8.1.2 implementation](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/base-crypto/src/signatures.rs#L167-L218)
and [main implementation](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/base-crypto/src/signatures.rs#L167-L218)
are the counterparts of the code below. No dedicated **contract-circuit** BIP340 verifier is established by the
inventoried Compact signature libraries; Compact runtime signing is listed in §4.1.

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L163-L185).

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L192-L215).

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L262-L282).

Source: [k: src/schnorr/signing.rs](https://github.com/RustCrypto/elliptic-curves/blob/5ac8f5d77f11399ff48d87b0554935f6eddda342/k256/src/schnorr/signing.rs#L37-L57).

```rust
impl SigningKey {
    /// Generate a cryptographically random [`SigningKey`].
    pub fn random(rng: &mut impl CryptoRngCore) -> Self {
        NonZeroScalar::random(rng).into()
    }

    /// Parse signing key from big endian-encoded bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        NonZeroScalar::try_from(bytes)
            .map(Into::into)
            .map_err(|_| Error::new())
    }

    /// Serialize as bytes.
    pub fn to_bytes(&self) -> FieldBytes {
        self.secret_key.to_bytes()
    }

    /// Get the [`VerifyingKey`] that corresponds to this signing key.
    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
```

Source: [k: src/schnorr/signing.rs](https://github.com/RustCrypto/elliptic-curves/blob/5ac8f5d77f11399ff48d87b0554935f6eddda342/k256/src/schnorr/signing.rs#L95-L133).

```rust
    ///
    /// The preferred interfaces are the [`Signer`] or [`RandomizedSigner`] traits.
    pub fn sign_raw(&self, msg: &[u8], aux_rand: &[u8; 32]) -> Result<Signature> {
        let mut t = tagged_hash(AUX_TAG).chain_update(aux_rand).finalize();

        for (a, b) in t.iter_mut().zip(self.secret_key.to_bytes().iter()) {
            *a ^= b
        }

        let rand = tagged_hash(NONCE_TAG)
            .chain_update(t)
            .chain_update(self.verifying_key.as_affine().x.to_bytes())
            .chain_update(msg)
            .finalize();

        let k = NonZeroScalar::try_from(&*rand)
            .map(Self::from)
            .map_err(|_| Error::new())?;

        let secret_key = k.secret_key;
        let verifying_point = AffinePoint::from(k.verifying_key);
        let r = verifying_point.x.normalize();

        let e = <Scalar as Reduce<U256>>::reduce_bytes(
            &tagged_hash(CHALLENGE_TAG)
                .chain_update(r.to_bytes())
                .chain_update(self.verifying_key.to_bytes())
                .chain_update(msg)
                .finalize(),
        );

        let s = *secret_key + e * *self.secret_key;
        let s = Option::from(NonZeroScalar::new(s)).ok_or_else(Error::new)?;
        let sig = Signature { r, s };

        #[cfg(debug_assertions)]
        self.verifying_key.verify_prehash(msg, &sig)?;

        Ok(sig)
```

The last excerpt shows nonce derivation and nonzero checks in the dependency.
It is not a direct API for importing an arbitrary raw nonce. The Ledger wrapper
uses `sign_with_rng`; its full transcript/interop policy is outside the tests in
[§7.1](#71-completed-executable-checks). Public signing keys, signature bytes and identity checks must not be
conflated with generic secp point decoding in §3.3.

The Ledger wrappers read fixed-size representations and delegate validation:
32-byte x-only Schnorr keys to `schnorr::VerifyingKey::from_bytes` in all three
snapshots, and 33-byte ECDSA keys to `ecdsa::VerifyingKey::from_sec1_bytes` in
Ledger 9. The ECDSA wrapper is absent from the other two reviewed snapshots. There is no wrapper-level `is_identity()` call
in these parsers. An x-only affine-key encoding and an explicit identity test
are different validation mechanisms; the linked wrapper sources establish delegation,
and the dependency excerpts below locate its explicit identity rejection.

Source: [Ledger 9 rc.5: `base-crypto/src/schnorr.rs:128–142`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L128-L142).

Source: [Ledger 8.1.2: `base-crypto/src/signatures.rs:130–144`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/base-crypto/src/signatures.rs#L130-L144), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/base-crypto/src/signatures.rs#L130-L144).

Following that delegation establishes a non-identity invariant for the imported
**secp256k1 Schnorr signature public key**. Ledger main locks k256 **0.13.4**
and elliptic-curve **0.13.8**:
[k256 lock entry](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L2472-L2475),
[elliptic-curve lock entry](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/Cargo.lock#L1441-L1444).
The k256 parser decompresses the x-only representation and calls
`PublicKey::from_affine`, whose identity check is explicit. The code below is
from the published package sources; immutable commits are recorded in their
`.cargo_vcs_info.json` metadata.

Source: [k256 0.13.4 Schnorr key parser](https://github.com/RustCrypto/elliptic-curves/blob/5ac8f5d77f11399ff48d87b0554935f6eddda342/k256/src/schnorr/verifying.rs#L78-L86).

```rust
    /// Parse verifying key from big endian-encoded x-coordinate.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let maybe_affine_point = AffinePoint::decompact(FieldBytes::from_slice(bytes));
        let affine_point = Option::from(maybe_affine_point).ok_or_else(Error::new)?;
        PublicKey::from_affine(affine_point)
            .map_err(|_| Error::new())?
            .try_into()
    }
}
```

Source: [elliptic-curve 0.13.8 identity rejection](https://github.com/RustCrypto/traits/blob/5ddf0f52f07f65f319ffd423c52e696406924d90/elliptic-curve/src/public_key.rs#L102-L108).

```rust
    pub fn from_affine(point: AffinePoint<C>) -> Result<Self> {
        if ProjectivePoint::<C>::from(point).is_identity().into() {
            Err(Error)
        } else {
            Ok(Self { point })
        }
    }
```

Thus “identity keys are rejected during Schnorr public-key deserialization” is
correct for this dependency chain. The guard is in the delegated dependency,
not in the Ledger wrapper. This establishes this parser's identity policy;
it is not a complete audit of every downstream signature-parser invariant.

#### 4.3.1. Public-key export, defaults, and adapter entry points

This subsection covers additional public declaration and export paths beyond signing and verification. It distinguishes serialized keys and signatures from fixed defaults and randomly generated sample material.

> **Unsafe use of placeholders:** a default key or signature must not be treated as application key generation or authentication. Verification against the intended public key and message remains necessary.

`VerifyingKey::serialize` exports x-only bytes. Its separate Serde implementation
is derived from the inner dependency type; it should not be assumed to be the
same envelope as Ledger `Serializable` without specifying the serializer.
`Default` constructs fixed placeholder public keys/signatures, while their
`Distribution<Standard>` implementations generate unrelated test/sample
material. Those constructors do not sign an application-provided message.

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L59-L76).

```rust
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
/// A verifying public key
pub struct VerifyingKey(schnorr::VerifyingKey);
derive_via_to_bytes!(VerifyingKey);

impl Default for VerifyingKey {
    fn default() -> Self {
        // Manually sampled, we want a stand-in without an rng sometimes.
        VerifyingKey(
            schnorr::VerifyingKey::from_bytes(&[
                43, 59, 242, 191, 89, 80, 243, 46, 116, 47, 12, 103, 140, 35, 90, 207, 180, 68,
                188, 10, 108, 126, 200, 195, 239, 14, 120, 114, 89, 188, 199, 38,
            ])
            .expect("static verifier key should be valid"),
        )
    }
}

```

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L98-L102).

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L114-L125).

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L218-L249).

```rust
pub struct Signature(schnorr::Signature);
derive_via_to_bytes!(Signature);

impl Default for Signature {
    fn default() -> Signature {
        // Manually sampled, we want a stand-in without an rng sometimes.
        Signature(
            schnorr::Signature::try_from(
                &[
                    20, 137, 89, 240, 159, 41, 72, 199, 212, 53, 117, 4, 235, 179, 101, 207, 210,
                    224, 132, 10, 131, 224, 89, 19, 152, 194, 235, 130, 162, 57, 186, 40, 103, 85,
                    94, 192, 157, 17, 70, 102, 209, 27, 62, 153, 67, 246, 158, 17, 124, 18, 63,
                    245, 208, 254, 72, 95, 157, 235, 180, 156, 164, 66, 143, 251,
                ][..],
            )
            .expect("static signature should be valid"),
        )
    }
}

#[cfg(feature = "proptest")]
simple_arbitrary!(Signature);
#[cfg(feature = "proptest")]
serialize::randomised_serialization_test!(Signature);

impl Distribution<Signature> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Signature {
        let signing_key = SigningKey::sample(OsRng);
        let mut message = Vec::with_bounded_capacity(32);
        rng.fill_bytes(&mut message);
        signing_key.sign(&mut OsRng, &message)
    }
```

Source: [l9: base-crypto/src/schnorr.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/schnorr.rs#L144-L147).

### 4.4. ECDSA on secp256k1

This comparison follows ECDSA on secp256k1 through Compact verification and recovery, and Ledger 9 signing, parsing, and verification. It focuses on secret-key ranges, signature scalar checks, normalization, and binding a recovered key to an application identity.

> **Unsafe application assumptions:** recovered public keys must be bound to the intended signer. Compact also lacks a low-`s` requirement, so applications must not assume unique signature bytes without a normalization policy; this is not evidence of signature forgery.

| Material / operation | Compact v3 / runtime | Native Ledger 9 | Checks and assessment |
|---|---|---|---|
| Secret key generation/import/export | No dedicated signer in this verifier API | `SigningKey::sample/from_bytes/deserialize/serialize` | Key parsing delegated to k256; checked key policy differs from generic scalar import |
| Public key generation/import/export | Generic secp generator multiplication; point/type adapters | `verifying_key`; 33-byte compressed SEC1 serialization/deserialization | Compact rejects identity during verify; Ledger delegates to a key parser at import |
| Nonce generation/import/export | No dedicated signing nonce API | Deterministic `Signer::sign` (RFC6979 per wrapper comment) | Ledger wrapper exposes no raw nonce import/export |
| Signature declaration/import/export | Struct of `r,s:Secp256k1Scalar`; no built-in DER parser in this function | Fixed 64-byte `r\|\|s` encoding via `Signature::serialize/deserialize` | Compact typed scalar encoding versus delegated native signature parser |
| Verification | Prehashed 32-byte input; identity assertion; `inv(s)`; no low-s assertion | Byte-message verification delegated to k256 | k256 rejects high-s during verification; Compact does not impose that normalization |
| Public-key recovery / address binding | Runtime `secp256k1EcdsaRecover`; address derivation | Not a public method of this Ledger key wrapper | Recovery does not authenticate a supplied identity/address; caller must bind recovered key |

Source: [c: compiler/zkir-v3-library.compact](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L17-L20).

```compact
export struct Secp256k1EcdsaSignature {
  r: Secp256k1Scalar,
  s: Secp256k1Scalar,
}
```

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L171-L192).

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L200-L220).

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L283-L305).

Source: [k: src/ecdsa.rs](https://github.com/RustCrypto/elliptic-curves/blob/5ac8f5d77f11399ff48d87b0554935f6eddda342/k256/src/ecdsa.rs#L200-L209).

```rust
#[cfg(feature = "ecdsa")]
impl VerifyPrimitive<Secp256k1> for AffinePoint {
    fn verify_prehashed(&self, z: &FieldBytes, sig: &Signature) -> Result<(), Error> {
        if sig.s().is_high().into() {
            return Err(Error::new());
        }

        hazmat::verify_prehashed(&self.into(), z, sig)
    }
}
```

The ECDSA implementations reject the default public key and compute the
verification relation with `inv(s)`. They do not impose a low-`s` condition;
there is no `s <= order/2` assertion in either function. These verifiers return
a Boolean on their final equation, but the identity check is an assertion,
so callers must not assume every invalid input simply returns `false`.

Source: [Compact: `compiler/zkir-v3-library.compact:68–81`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L68-L81).

```compact
export circuit secp256k1EcdsaVerify(
                 msgHash: Bytes<32>,
                 sig: Secp256k1EcdsaSignature,
                 pk: Secp256k1Point
                 ): Boolean {
  assert(pk != default<Secp256k1Point>, "Secp256k1Point identity is not a permitted secp256k1EcdsaVerify verification key");
  const z: Secp256k1Scalar = reverseBytes32(msgHash) as Secp256k1Scalar;
  const {r, s} = sig;
  const w: Secp256k1Scalar = inv(s);
  const u1: Secp256k1Scalar = z * w;
  const u2: Secp256k1Scalar = r * w;
  const point: Secp256k1Point = ecAdd(ecMulGenerator(u1), ecMul(pk, u2));
  return (secp256k1PointX(point) as Bytes<32>) as Secp256k1Scalar == r;
}
```

Source: [Ledger 9 rc.5: `base-crypto/src/ecdsa.rs:138–149`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L138-L149).

```rust
impl Deserializable for VerifyingKey {
    fn deserialize(reader: &mut impl Read, _recursion_depth: u32) -> io::Result<Self> {
        let mut bytes = [0u8; 33];
        reader.read_exact(&mut bytes)?;
        Ok(VerifyingKey(
            ecdsa::VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "Malformed ECDSA verifying key")
            })?,
        ))
    }
}

```

ECDSA signing-key deserialization likewise delegates to k256 rather than
using the transient-encryption scalar importer. Their invariants should not
be conflated.

Source: [Ledger 9 rc.5: `base-crypto/src/ecdsa.rs:211–220`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L211-L220).

Compact's runtime provides off-circuit ECDSA recovery. The standard-library
comment prescribes supplying the recovered key as a witness/argument,
verifying the signature in-circuit, and then computing the Ethereum address.
Applications also need to bind the resulting key/address to the expected
signer; a valid relation for an arbitrary supplied key is not authorization.

Source: [Compact: `runtime/src/utils.ts:241–254`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/utils.ts#L241-L254).

```typescript
export function secp256k1EcdsaRecover(
  msgHash: Uint8Array,
  sig: { readonly r: bigint; readonly s: bigint },
  recoveryId: number,
): Secp256k1Point {
  if (msgHash.length !== 32) {
    throw new CompactError('expected a 32-byte message hash');
  }
  if (!Number.isInteger(recoveryId) || recoveryId < 0 || recoveryId > 3) {
    throw new CompactError('expected a recovery id in the range [0, 3]');
  }
  const nobleSig = new secp256k1.Signature(sig.r, sig.s, recoveryId);
  return secp256k1FromProjective(nobleSig.recoverPublicKey(msgHash));
}
```

Source: [Compact: `compiler/zkir-v3-library.compact:62–67`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L62-L67).

The source comment refers to [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271).

Raw signature bytes should not be assumed to be a unique signature identifier:
both Compact ECDSA functions allow high- and low-`s`. An application requiring
that property should enforce its chosen normalization rule.

The native dependency chain makes the scalar policies explicit. ECDSA's
`SigningKey::from_slice` delegates to elliptic-curve's `SecretKey`; that parser
rejects zero. Its direct slice API accepts 24–32 bytes for secp256k1, padding
shorter inputs on the left, whereas Ledger's `Deserializable` wrapper reads
exactly 32 bytes. The native signature parser requires `1 <= r,s < n` at import;
high-s is separately rejected during verification, as shown above.

Source: [ecdsa 0.16.9 secret-key generation/import](https://github.com/RustCrypto/signatures/blob/abd0175f3ae2dc4b118fa914e94c1fc4b0182ba9/ecdsa/src/signing.rs#L86-L103).

Source: [elliptic-curve nonzero and slice-length policy](https://github.com/RustCrypto/traits/blob/5ddf0f52f07f65f319ffd423c52e696406924d90/elliptic-curve/src/secret_key.rs#L143-L172).

```rust
    /// Deserialize secret key from an encoded secret scalar.
    pub fn from_bytes(bytes: &FieldBytes<C>) -> Result<Self> {
        let inner: ScalarPrimitive<C> =
            Option::from(ScalarPrimitive::from_bytes(bytes)).ok_or(Error)?;

        if inner.is_zero().into() {
            return Err(Error);
        }

        Ok(Self { inner })
    }

    /// Deserialize secret key from an encoded secret scalar passed as a byte slice.
    ///
    /// The slice is expected to be a minimum of 24-bytes (192-byts) and at most `C::FieldBytesSize`
    /// bytes in length.
    ///
    /// Byte slices shorter than the field size are handled by zero padding the input.
    pub fn from_slice(slice: &[u8]) -> Result<Self> {
        if slice.len() == C::FieldBytesSize::USIZE {
            Self::from_bytes(FieldBytes::<C>::from_slice(slice))
        } else if (Self::MIN_SIZE..C::FieldBytesSize::USIZE).contains(&slice.len()) {
            let mut bytes = Zeroizing::new(FieldBytes::<C>::default());
            let offset = C::FieldBytesSize::USIZE.saturating_sub(slice.len());
            bytes[offset..].copy_from_slice(slice);
            Self::from_bytes(&bytes)
        } else {
            Err(Error)
        }
    }
```

Source: [ECDSA r/s nonzero and range parsing](https://github.com/RustCrypto/signatures/blob/abd0175f3ae2dc4b118fa914e94c1fc4b0182ba9/ecdsa/src/lib.rs#L250-L259).

```rust
    pub fn from_scalars(r: impl Into<FieldBytes<C>>, s: impl Into<FieldBytes<C>>) -> Result<Self> {
        let r = ScalarPrimitive::from_slice(&r.into()).map_err(|_| Error::new())?;
        let s = ScalarPrimitive::from_slice(&s.into()).map_err(|_| Error::new())?;

        if r.is_zero().into() || s.is_zero().into() {
            return Err(Error::new());
        }

        Ok(Self { r, s })
    }
```

#### 4.4.1. Public-key export, Serde, and placeholder signatures

This subsection compares the native public-key serialization paths and the additional signature constructors. It explains what successful parsing establishes before a signature is checked against a message and public key.

> **Unsafe use of parsed placeholders:** the default `(r,s)=(1,1)` signature is syntactically valid input, not evidence of authentication for an application message.

The native public-key `Serializable` exporter emits compressed SEC1 bytes;
its Serde implementation also routes byte input through the SEC1 key parser.
`Default` and random-distribution constructors are additional declaration paths,
not key generation tied to an application identity or signing of its chosen
message. The default signature is syntactically parsed `(r,s)=(1,1)`; successful
parsing does not establish a valid signature for a supplied public key/message.

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L40-L54).

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L127-L136).

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L248-L273).

```rust
        Signature(
            ecdsa::Signature::from_slice(&[
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 1,
            ])
            .expect("static signature should be valid"),
        )
    }
}

#[cfg(feature = "proptest")]
simple_arbitrary!(Signature);
#[cfg(feature = "proptest")]
serialize::randomised_serialization_test!(Signature);

impl Distribution<Signature> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Signature {
        let signing_key = SigningKey::sample(OsRng);
        let mut message = Vec::with_bounded_capacity(32);
        rng.fill_bytes(&mut message);
        signing_key.sign(&message)
    }
}

impl Tagged for Signature {
```

Source: [l9: base-crypto/src/ecdsa.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/ecdsa.rs#L151-L155).

### 4.5. ECDSA on P-256

Compact exposes a P-256 ECDSA verifier built from generic foreign-curve operations. The inventory separates its typed key and signature inputs from signing, import, and encoding APIs that this verifier does not provide.

| Material / public operation | Availability and checks | Assessment |
|---|---|---|
| Secret key / nonce generation, import and export | Not exposed by this Compact verification circuit or the inventoried native Ledger scheme modules | Generic scalar operations are not a dedicated P-256 signing API |
| Public key declaration / generation | `Secp256r1Point`; generic `ecMulGenerator` / runtime `secp256r1MulGenerator` | Generic point construction and key-role checks are separate |
| Public key import/export | Compact point/type adapters; backend SEC1/group adapters in [§3.3](#33-secp256k1-and-p-256-points) | Identity rejected at verification; adapter alone is role-limited |
| Signature declaration/import/export | `Secp256r1EcdsaSignature {r,s}` as typed scalars; generated struct encoding uses field adapters | No dedicated DER decoder in this verifier |
| Verification | Prehashed 32-byte input; identity assertion; inverse of s; no low-s assertion | Relation check; application canonicality still needs an explicit policy |

Source: [c: compiler/zkir-v3-library.compact](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L133-L136).

```compact
export struct Secp256r1EcdsaSignature {
  r: Secp256r1Scalar,
  s: Secp256r1Scalar,
}
```

The ECDSA implementations reject the default public key and compute the
verification relation with `inv(s)`. They do not impose a low-`s` condition;
there is no `s <= order/2` assertion in either function. These verifiers return
a Boolean on their final equation, but the identity check is an assertion,
so callers must not assume every invalid input simply returns `false`.

Source: [Compact: `compiler/zkir-v3-library.compact:157–170`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L157-L170).

```compact
export circuit secp256r1EcdsaVerify(
                 msgHash: Bytes<32>,
                 sig: Secp256r1EcdsaSignature,
                 pk: Secp256r1Point
                 ): Boolean {
  assert(pk != default<Secp256r1Point>, "Secp256r1Point identity is not a permitted secp256r1EcdsaVerify verification key");
  const z: Secp256r1Scalar = reverseBytes32(msgHash) as Secp256r1Scalar;
  const {r, s} = sig;
  const w: Secp256r1Scalar = inv(s);
  const u1: Secp256r1Scalar = z * w;
  const u2: Secp256r1Scalar = r * w;
  const point: Secp256r1Point = ecAdd(ecMulGenerator(u1), ecMul(pk, u2));
  return (secp256r1PointX(point) as Bytes<32>) as Secp256r1Scalar == r;
}
```

### 4.6. Ed25519 on Edwards Curve25519

Compact verifies Ed25519 signatures using Edwards Curve25519 points and a SHA-512 challenge. This subsection describes the typed inputs and point encoding, then identifies acceptance rules that still need interoperability tests.

| Material / public operation | Availability and checks | Assessment |
|---|---|---|
| Secret key / seed and nonce generation/import/export | Not exposed by the reviewed Compact verification circuit; no dedicated native Ledger Ed25519 module in the quoted exports | Do not confuse a generic Curve25519 scalar with an RFC8032 seed/signing-key importer |
| Public-key declaration/import/export | `Curve25519Point`; generic adapters/constructors in [§3.4](#34-edwards-curve25519-points) | Prime-subgroup point invariant; verify separately rejects identity via zero x |
| Signature declaration/import/export | `Ed25519Signature {r:Curve25519Point,s:Curve25519Scalar}` | Typed point/scalar representation, not a direct 64-byte signature parser |
| Compressed point encoding used for challenge | Internal `ed25519Encode` encodes y and sign of x as 32 bytes | Encoding only, relying on already validated points; not an exported point decoder |
| Verification | SHA512 challenge; uncofactored subgroup relation; no explicit identity-R rejection | Different acceptance policies require interop tests; no signing API established |

Source: [c: compiler/zkir-v3-library.compact](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L198-L212).

The encoding follows the [RFC 8032 point-encoding definition](https://www.rfc-editor.org/rfc/rfc8032#section-5.1.2).

Compact Ed25519 rejects a zero `x` public key, relying on the prime-subgroup
invariant to identify identity that way. Its signature response is explicitly
`Curve25519Scalar`; its announcement `r` has no separate non-identity assertion.
The equation is the uncofactored relation over the subgroup point types.
Interoperability with other Ed25519 acceptance policies therefore needs explicit
tests, rather than assuming every library accepts the same point/signature set.

Source: [Compact: `compiler/zkir-v3-library.compact:175–178`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L175-L178).

```compact
export struct Ed25519Signature {
  r: Curve25519Point,
  s: Curve25519Scalar,
}
```

Source: [Compact: `compiler/zkir-v3-library.compact:225–236`](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/compiler/zkir-v3-library.compact#L225-L236).

```compact
export circuit ed25519Verify<#n>(
                 msg: Bytes<n>,
                 sig: Ed25519Signature,
                 pk: Curve25519Point
                 ): Boolean {
  assert((curve25519PointX(pk) as Bytes<32>) != pad(32, ""), "Curve25519Point identity is not a permitted ed25519Verify verification key");
  const {r, s} = sig;
  const k = sha512<[Bytes<32>, Bytes<32>, Bytes<n>]>(
              [ed25519Encode(r), ed25519Encode(pk), msg]
              ) as Curve25519Scalar;
  return ecMulGenerator(s) == ecAdd(r, ecMul(pk, k));
}
```

## 5. Encryption schemes

This section follows Ledger coin encryption from secret-key creation to recipient-key import, encryption, ciphertext parsing, and decryption. It distinguishes the recipient’s long-term public key from the sender’s ephemeral point carried in the ciphertext.

> **Confirmed confidentiality failure for an identity recipient:** Ledger’s native API can encrypt to a public key for which the masking value is publicly computable. A test recovers the plaintext without a secret ([§5.1.2](#512-recipient-public-key-encoding-and-encryption), [§7.1](#71-completed-executable-checks)). The WASM call chain is source-backed; deployed wallet acceptance has not been established.

| Repository / snapshot | Dedicated scheme in the reviewed crypto API | Other-layer role |
|---|---|---|
| Ledger 8.1.2, 9 rc.5, pinned main | Jubjub ephemeral-static Diffie–Hellman with transient-hash-derived masking | Same transient-crypto encryption implementation |
| Compact | No dedicated encryption/decryption circuit in the inventoried standard-library exports | Shielded-coin APIs reach Ledger encryption through transaction construction |
| ZKIR / Midnight ZK | Generic Jubjub/scalar/hash operations | Supporting primitives, not the native `PublicKey::encrypt` key-policy boundary |

The scheme's documentation describes the Diffie–Hellman shared key and
counter-based transient-hash masking:

Source: [l9: transient-crypto/src/encryption.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L14-L23).

### 5.1. Jubjub Diffie–Hellman and transient-hash masking

The sender multiplies the recipient’s Jubjub public key by an ephemeral scalar and derives a masking value from the shared point. The subsections identify which key and ciphertext checks protect this exchange at each API boundary.

> **Unsafe recipient key:** subgroup membership alone does not make a recipient public key suitable for Diffie–Hellman encryption. The identity recipient is accepted by the reviewed encryption method and removes secrecy.

| Material / public operation | Format / checks and timing | Assessment |
|---|---|---|
| `SecretKey::new`, `from_uniform_bytes` | Random scalar or modular reduction; neither rejects zero | Hazardous edge case for encryption keys |
| `SecretKey::from_repr/repr` | Canonical fixed 32-byte scalar import/export; zero accepted | Checked range; hazardous zero-key admission |
| `SecretKey::deserialize/serialize` (derived), tagged wrappers | `EmbeddedFr` scalar encoding; distinct from fixed-size `repr` | Role-limited; no nonzero-key invariant |
| `SecretKey::public_key` | Generator multiplication | Can produce identity |
| `PublicKey` random sampling, derived serialization/deserialization, Serde bytes | Generic subgroup-point import and identity acceptance | Hazardous if accepted as recipient without a separate guard |
| `PublicKey::encrypt` | Ephemeral scalar sampling and Diffie–Hellman; no recipient-identity rejection | Hazardous: identity recipient gives public masking value |
| `Ciphertext {c,ciph}`, `serialize/deserialize` | Point plus field-vector wire representation; `deserialize` rejects identity c | Checked ephemeral-point identity at decoding, not recipient-key validation |
| `SecretKey::decrypt` | Rejects identity c again; checks encrypted-zero marker and message reconstruction | Separate decryption checks; not a general authenticated-encryption security audit |
| `Seed::derive_encryption_secret_key` | Domain-separated seed expansion then `from_uniform_bytes` | No extra zero retry in shown derivation; does not imply wallets usually derive zero |
| WASM `EncryptionSecretKey::public_key`, `serialize/tagged_serialize`, `deserialize/tagged_deserialize` | Wrap/unwrap native key; byte/hex export and native import | Wrapper lifetime checks, not an added nonzero invariant |
| WASM `ZswapOutput::new`, native output / coin ciphertext construction | Imported recipient epk reaches `encrypt` | Source-traced hazardous acceptance; browser/submission not executed |

#### 5.1.1. Secret keys and public-key derivation

This subsection examines how random bytes or encoded scalars become encryption secret keys, and how those keys produce public points. It focuses on whether a syntactically valid scalar is also a suitable encryption key.

> **Hazardous zero-key import:** the displayed scalar constructors accept zero, and public-key derivation then returns the identity. A canonical encoding check does not prevent this.

The encryption implementation is identical in the three reviewed Ledger
snapshots. `from_repr` calls the canonical scalar decoder and wraps its result
without a zero check; `from_uniform_bytes` reduces arbitrary input without a
zero check. `public_key` multiplies the generator by that scalar.

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:171–192`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L171-L192), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L171-L192), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L171-L192).

```rust
    /// Initialize a key-pair from arbitrary 64 bytes (little-endian) ensuring the result falls into the space by taking modulo
    pub fn from_uniform_bytes(bytes: &[u8; 64]) -> Self {
        let value = embedded::Scalar::from_bytes_wide(bytes);
        SecretKey(EmbeddedFr(value))
    }

    /// Initialize a key-pair from repr bytes
    pub fn from_repr(bytes: &[u8; Self::BYTES]) -> CtOption<Self> {
        let val = embedded::Scalar::from_bytes(bytes);
        val.map(|scalar| SecretKey(EmbeddedFr(scalar)))
    }

    /// Converts a `SecretKey` into a raw bytes representation
    pub fn repr(&self) -> [u8; Self::BYTES] {
        self.0.0.to_bytes()
    }

    /// Derives the public key from the secret key.
    pub fn public_key(&self) -> PublicKey {
        PublicKey(EmbeddedGroupAffine::generator() * self.0)
    }

```

The underlying scalar decoder enforces `sk < r`, rather than `1 <= sk < r`.
Its validity bit comes solely from subtraction of the modulus. Zero is
canonical and passes; the native Ledger test in
[§7.1](#71-completed-executable-checks) verifies zero-key import.
The reviewed 0.2.0 and released 0.3.1 implementations have the same body:

Source: [midnight-curves 0.3.1: `curves/src/jubjub/fr.rs:250–274`](https://github.com/midnightntwrk/midnight-zk/blob/64f5d8b7099079ac6c7f8d53723e559cdf9f56d3/curves/src/jubjub/fr.rs#L250-L274), [midnight-curves 0.2.0: `curves/src/jubjub/fr.rs:253–277`](https://github.com/midnightntwrk/midnight-zk/blob/a39f81d591ce59d20c0ff434b116728458c85304/curves/src/jubjub/fr.rs#L253-L277); [published crate source](https://docs.rs/crate/midnight-curves/0.2.0/source/src/jubjub/fr.rs).

```rust
    pub fn from_bytes(bytes: &[u8; 32]) -> CtOption<Fr> {
        let mut tmp = Fr([0, 0, 0, 0]);

        tmp.0[0] = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        tmp.0[1] = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        tmp.0[2] = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        tmp.0[3] = u64::from_le_bytes(bytes[24..32].try_into().unwrap());

        // Try to subtract the modulus
        let (_, borrow) = sbb(tmp.0[0], MODULUS.0[0], 0);
        let (_, borrow) = sbb(tmp.0[1], MODULUS.0[1], borrow);
        let (_, borrow) = sbb(tmp.0[2], MODULUS.0[2], borrow);
        let (_, borrow) = sbb(tmp.0[3], MODULUS.0[3], borrow);

        // If the element is smaller than MODULUS then the
        // subtraction will underflow, producing a borrow value
        // of 0xffff...ffff. Otherwise, it'll be zero.
        let is_some = (borrow as u8) & 1;

        // Convert to Montgomery form by computing
        // (a.R^0 * R^2) / R = a.R
        tmp *= &R2;

        CtOption::new(tmp, Choice::from(is_some))
    }
```

**Consequence:** `SecretKey::from_repr(&[0;32])` accepts a zero key, and
`public_key()` produces identity. This is a source-level consequence of the
shown importer and group multiplication, not a claim that a wallet normally
generates that key. Random scalar sampling can also produce zero unless a
caller retries; the key constructor contains no retry.

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:166–169`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L166-L169), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L166-L169), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L166-L169).

```rust
    /// Initializes a key-pair.
    pub fn new<R: Rng + CryptoRng + ?Sized>(rng: &mut R) -> Self {
        SecretKey(rng.r#gen())
    }
```

#### 5.1.2. Recipient public-key encoding and encryption

This subsection follows recipient public-key declaration and import into the encryption operation. It connects the missing key-role check to the plaintext-recovery test in [§7.1](#71-completed-executable-checks).

> **Confirmed unsafe encryption:** `PublicKey::encrypt` has no recipient-identity rejection. Encrypting to the identity makes the shared point and derived masking value public, allowing plaintext recovery.

The public-key wrapper has no non-identity invariant in its declaration;
serialization/deserialization is derived by `Serializable`. Its encrypt method
multiplies the recipient point by an ephemeral scalar without a prior identity
check.

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:44–49`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L44-L49), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L44-L49), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L44-L49).

```rust

/// A public key, consisting of a group element `g^x`
#[derive(Copy, Clone, Debug, Eq, Serializable)]
#[tag = "encryption-public-key[v1]"]
#[cfg_attr(feature = "proptest", derive(Arbitrary))]
pub struct PublicKey(EmbeddedGroupAffine);
```

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:137–159`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L137-L159), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L137-L159), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L137-L159).

```rust
impl PublicKey {
    /// Encrypts a message that can be represented as field elements to a public key.
    pub fn encrypt<R: Rng + CryptoRng + ?Sized, T: FieldRepr>(
        &self,
        rng: &mut R,
        msg: &T,
    ) -> Ciphertext {
        let y: EmbeddedFr = rng.r#gen();
        let c = EmbeddedGroupAffine::generator() * y;
        let k_star = self.0 * y;
        let coords = if k_star.is_infinity() {
            (0.into(), 0.into())
        } else {
            (k_star.x().unwrap(), k_star.y().unwrap())
        };
        let k = transient_hash(&[coords.0, coords.1]);
        let ciph = once(0.into())
            .chain(msg.field_vec())
            .enumerate()
            .map(|(ctr, msg)| transient_hash(&[k, (ctr as u64).into()]) + msg)
            .collect();
        Ciphertext { c, ciph }
    }
```

For an identity recipient, `k_star = identity` independently of the random
scalar. In this Edwards representation `is_infinity()` is always false, and
coordinates are obtained from the point, so the derived key is the public value
`transient_hash([0,1])`, not `transient_hash([0,0])`. A reader can recompute the
keystream and subtract it from the field-element ciphertext. This is a concrete
API-level confidentiality hazard when an identity recipient is accepted.

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:489–505`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L489-L505), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L502-L518), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L489-L505).

```rust
    /// Retrieves the curve point's affine `x` coordinate.
    /// Or `None` if this is the identity
    pub fn x(&self) -> Option<Fr> {
        Into::<embedded::AffineExtended>::into(self.0)
            .coordinates()
            .map(|c| Fr(c.0))
    }

    /// Retrieves the curve point's affine `y` coordinate.
    /// Or `None` if this is the identity
    pub fn y(&self) -> Option<Fr> {
        Into::<embedded::AffineExtended>::into(self.0)
            .coordinates()
            .map(|c| Fr(c.1))
    }

    /// Returns the primary generator of the embedded curve.
```

Source: [Ledger 8.1.2: `transient-crypto/src/curve.rs:510–526`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/curve.rs#L510-L526), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/curve.rs#L523-L539), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/curve.rs#L510-L526).

```rust
    /// Returns the identity element for curve addition.
    pub fn identity() -> Self {
        EmbeddedGroupAffine(embedded::Affine::identity())
    }

    /// Returns if the curve point is the additive identity.
    pub fn is_identity(&self) -> bool {
        self.0.is_identity().into()
    }

    /// Returns if the curve point is the point at infinity.
    pub fn is_infinity(&self) -> bool {
        false
    }

    /// Whether or not this embedded curve has an infinity point in affine representation.
    pub const HAS_INFINITY: bool = false;
```

#### 5.1.3. WASM and transaction construction entry points

This source trace follows an externally supplied recipient encryption key through Ledger’s WASM output-construction API. It identifies the native encryption call reached by that path while leaving wallet and transaction-submission behavior for integration testing.

> **Exposed native hazard:** the displayed WASM path forwards the imported recipient key to encryption without adding an identity check. This establishes the source-level path, not successful submission through a deployed wallet.

The following is a source-level trace of a recipient **encryption** public key,
not a signature key or the separate coin-ownership key `target_cpk`.
`ZswapOutput::new` accepts `target_epk` as a string, parses it, and passes it to
`zswap::Output::new`:

Source: [WASM recipient input](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/ledger-wasm/src/zswap_wasm.rs#L254-L267).

```rust
            "ZswapOutput cannot be constructed directly through the WASM API.",
        ))
    }

    pub fn new(
        coin: JsValue,
        segment: Option<u16>,
        target_cpk: &str,
        target_epk: &str,
    ) -> Result<ZswapOutput, JsError> {
        let coin = value_to_shielded_coininfo(coin)?;
        let target_cpk = from_hex_ser(target_cpk)?;
        let target_epk = from_hex_ser(target_epk)?;
        Ok(ZswapOutput(ZswapOutputTypes::UnprovenOutput(
```

The generic hexadecimal parser requires the deserializer to consume all bytes.
It adds no identity rejection to the underlying public-key deserializer:

Source: [hexadecimal deserialization](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/ledger-wasm/src/conversions.rs#L124-L142).

```rust
fn from_hex_ser_checked<T: Deserializable, R: Read>(mut bytes: R) -> Result<T, std::io::Error> {
    let value = T::deserialize(&mut bytes, 0)?;

    let count = BufReader::new(bytes).bytes().count();

    if count == 0 {
        return Ok(value);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("Not all bytes read, {} bytes remaining", count),
    ))
}

pub fn from_hex_ser<T: Deserializable>(data: &str) -> Result<T, JsError> {
    from_hex_ser_checked(&mut &<Vec<u8>>::from_hex(data.as_bytes())?[..]).map_err(Into::into)
}

```

Output construction maps the supplied key directly into coin encryption:

Source: [output ciphertext construction](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zswap/src/construct.rs#L230-L241).

```rust
impl<D: DB> Output<ProofPreimage, D> {
    #[instrument(skip(rng))]
    pub fn new<R: Rng + CryptoRng + ?Sized>(
        rng: &mut R,
        coin: &CoinInfo,
        segment: Option<u16>,
        target_cpk: &coin::PublicKey,
        target_epk: Option<encryption::PublicKey>,
    ) -> Result<Self, OfferCreationFailed> {
        let ciphertext = target_epk.map(|epk| CoinCiphertext::new(rng, coin, epk));
        Self::new_with_ciphertext::<R>(rng, coin, segment, target_cpk, ciphertext)
    }
```

Source: [coin encryption call](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zswap/src/structure.rs#L153-L163).

```rust
impl CoinCiphertext {
    pub fn new<R: Rng + CryptoRng + ?Sized>(
        rng: &mut R,
        coin: &CoinInfo,
        pk: encryption::PublicKey,
    ) -> CoinCiphertext {
        pk.encrypt(rng, coin)
            .try_into()
            .expect("ciphertext should have ciphertext length")
    }
}
```

Combined with the public-key deserializer and `PublicKey::encrypt` in
[§5.1.2](#512-recipient-public-key-encoding-and-encryption), these excerpts
identify an externally supplied WASM argument that reaches the encryption API
without a recipient-identity guard on this path. The native API test in
[§7.1](#71-completed-executable-checks) confirms identity-key import and plaintext
recovery. The WASM function, browser wallet, and transaction submission were not
executed; their end-to-end acceptance remains a separate integration question.

#### 5.1.4. Ephemeral ciphertext points and decryption

This subsection covers the ephemeral public point stored in a ciphertext and the checks applied when importing or decrypting it. Those checks protect a different input from the recipient key checked by the sender.

There are two different public points in this exchange: the recipient's
long-term encryption public key, passed to `encrypt`, and the sender's ephemeral
Diffie–Hellman public point `c`, carried in the ciphertext and consumed by
`decrypt`. The latter is the “other party's public key” from the receiver's
perspective. Checking it does not validate the recipient key from the sender's
perspective. This distinction explains why the checks below coexist with the
identity-recipient hazard in [§5.1.2](#512-recipient-public-key-encoding-and-encryption).

Ciphertext deserialization rejects identity challenge `c`; `decrypt` checks
again to cover an in-memory ciphertext. These checks do not reject an identity
**recipient** public key. Zero ephemeral sampling in `encrypt` would also
produce an identity challenge that these receiver paths reject.

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:122–133`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L122-L133), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L122-L133), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L122-L133).

```rust
        Ciphertext::check_rec(&mut recursion_depth)?;
        let c = EmbeddedGroupAffine::deserialize(reader, recursion_depth)?;
        let ciph = <Vec<Fr> as Deserializable>::deserialize(reader, recursion_depth)?;
        // See note in `decrypt` for why the identity element is excluded.
        if c.is_identity() {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ciphertext challenge may not be the identity element",
            ))
        } else {
            Ok(Ciphertext { c, ciph })
        }
```

Source: [Ledger 8.1.2: `transient-crypto/src/encryption.rs:193–202`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/encryption.rs#L193-L202), [Ledger 9 rc.5](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L193-L202), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/encryption.rs#L193-L202).

```rust
    /// Attempts decryption of a given ciphertext.
    pub fn decrypt<T: FromFieldRepr>(&self, ciph: &Ciphertext) -> Option<T> {
        // NOTE: Allowing c to be the identity element would allow any key to potentially decrypt
        // this, because k_star would always be the identity element for every secret key
        // Effectively, this is because this is the only point that *is not* a group generator.
        // Therefore, we exclude it.
        if ciph.c.is_identity() {
            return None;
        }
        let k_star = ciph.c * self.0;
```

Recommended follow-up: reject zero imported/generated encryption secret keys,
reject identity recipient keys before encryption, ensure ephemeral sampling
excludes zero, and trace every external recipient-key entry point. Any API
change should distinguish import (reject invalid keys) from uniform derivation
(which needs a specified nonzero derivation procedure, not silent arbitrary
rewriting). A caller-level review is needed before assigning a deployment
severity.

#### 5.1.5. Seed derivation and WASM key import/export

This subsection traces seed-derived encryption keys and their JavaScript/WASM import and export formats. It distinguishes scalar and byte-format checks from enforcing a nonzero secret or nonidentity public key.

> **Missing key-role checks:** seed derivation has no zero retry, and the displayed key import paths do not add a nonzero-secret or nonidentity-recipient invariant. The zero-key consequence is demonstrated for direct native import in [§7.1](#71-completed-executable-checks).

Source: [l9: transient-crypto/src/encryption.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/encryption.rs#L51-L82).

```rust
impl Distribution<PublicKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PublicKey {
        PublicKey(rng.r#gen())
    }
}

#[cfg(feature = "proptest")]
randomised_serialization_test!(PublicKey);
tag_enforcement_test!(PublicKey);

impl PartialEq for PublicKey {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Serialize for PublicKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut vec = Vec::new();
        <PublicKey as Serializable>::serialize(self, &mut vec).map_err(S::Error::custom)?;
        serializer.serialize_bytes(&vec)
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bytes = serde_bytes::ByteBuf::deserialize(deserializer)?;
        <PublicKey as Deserializable>::deserialize(&mut &bytes[..], 0)
            .map_err(serde::de::Error::custom)
    }
}

```

Source: [l9: zswap/src/keys.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/zswap/src/keys.rs#L69-L80).

```rust
        const DOMAIN_SEPARATOR: &[u8; 12] = b"midnight:esk";
        const NUMBER_OF_BYTES: usize = 64;
        let mut raw_bytes = self.sample_bytes(NUMBER_OF_BYTES, DOMAIN_SEPARATOR);
        let mut raw_bytes_arr: [u8; 64] = raw_bytes.clone().try_into().unwrap();

        raw_bytes.zeroize();
        let res = encryption::SecretKey::from_uniform_bytes(&raw_bytes_arr);
        raw_bytes_arr.zeroize();
        res
    }

    pub fn sample_bytes(&self, no_of_bytes: usize, domain_separator: &[u8]) -> Vec<u8> {
```

Source: [l9: ledger-wasm/src/zswap_keys.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/ledger-wasm/src/zswap_keys.rs#L339-L385).

```rust
    #[wasm_bindgen(js_name = "yesIKnowTheSecurityImplicationsOfThis_taggedSerialize")]
    pub fn tagged_serialize(&self) -> Result<Uint8Array, JsError> {
        let mut res = Vec::new();
        tagged_serialize(
            self.0
                .borrow()
                .as_ref()
                .ok_or(JsError::new(ESK_CLEAR_MSG))?,
            &mut res,
        )?;
        Ok(Uint8Array::from(&res[..]))
    }

    #[wasm_bindgen(js_name = "yesIKnowTheSecurityImplicationsOfThis_serialize")]
    pub fn serialize(&self) -> Result<Uint8Array, JsError> {
        let mut res = Vec::new();
        Serializable::serialize(
            self.0
                .borrow()
                .as_ref()
                .ok_or(JsError::new(ESK_CLEAR_MSG))?,
            &mut res,
        )?;
        Ok(Uint8Array::from(&res[..]))
    }

    #[wasm_bindgen(js_name = "taggedDeserialize")]
    pub fn tagged_deserialize(raw: Uint8Array) -> Result<EncryptionSecretKey, JsError> {
        Ok(EncryptionSecretKey::wrap(from_value_ser(
            raw,
            "EncryptionSecretKey",
        )?))
    }

    pub fn deserialize(raw: Uint8Array) -> Result<EncryptionSecretKey, JsError> {
        use std::io::{Error, ErrorKind};
        let deserialized: transient_crypto::encryption::SecretKey =
            Deserializable::deserialize(&mut raw.to_vec().as_slice(), 0).map_err(|e| {
                Error::new(
                    ErrorKind::InvalidData,
                    format!(
                        "Unable to deserialize {}. Error: {}",
                        "EncryptionSecretKey", e
                    ),
                )
            })?;
        Ok(EncryptionSecretKey::wrap(deserialized))
```

## 6. Other cryptographic schemes

This section reviews commitments, commitment-opening proofs, hash-to-curve, and proof-system keys. Their validation requirements depend on their role: a legitimate commitment identity is different from an unsafe encryption recipient.

> **Unsafe assumptions to avoid:** converting an opening proof to a commitment does not verify its evidence ([§6.2](#62-proof-of-a-generator-only-pedersen-opening-on-jubjub)); accepting serialized proof-key bytes does not establish complete parsing ([§6.4](#64-proof-system-keys-and-kzg-commitments-on-bls12-381)). Unchecked proving-key formats explicitly require trusted input ([§6.4.1](#641-proving-key-importexport)).

The primitives here have different roles from public-key encryption and
signatures. Commitment identity can be a legitimate arithmetic result. Proof
verification keys describe a circuit, rather than an individual signer.

| Primitive / curve or output | Ledger 8.1.2 / 9 rc.5 / main | Compact / ZKIR / Midnight ZK |
|---|---|---|
| Pedersen / Jubjub | `transient-crypto::commitment::Pedersen` | Built from generic hash-to-curve, scalar multiplication and addition; no dedicated Pedersen opcode needed |
| Proof of knowledge of a generator-only Pedersen opening / Jubjub | `PureGeneratorPedersen` | Generic Schnorr-like equation; distinct from the signature policy in [§4.2](#42-schnorr-with-poseidon-challenge-on-jubjub) |
| Hash-based commitments | Persistent SHA256 bytes; transient Poseidon field output | `persistentCommit/transientCommit` adapters; these are not Pedersen points |
| Hash-to-curve / Jubjub | `hash_to_curve` | Compact `hashToCurve`, ZKIR hash-to-curve operation, Midnight ZK gadget |
| KZG / BLS12-381 and proof verification keys | Proof setup/verification wrappers | Midnight ZK proof/stdlib APIs; lazy Ledger parsing is separately reviewed |

### 6.1. Pedersen commitments on Jubjub

A Pedersen commitment combines a value-dependent point with a scalar blinding component. This subsection inventories construction, opening randomness, arithmetic, and serialization, including when the identity is a legitimate result.

| Material / public operation | Checks / encoding | Assessment |
|---|---|---|
| `Pedersen(pub EmbeddedGroupAffine)`, `Default`, derived serialization/deserialization | Uses generic Jubjub subgroup-point encoding; identity accepted | Correct generic commitment behavior; not a signature/encryption key |
| `PedersenRandomness = EmbeddedFr`, scalar import/export | Generic scalar range/reduction checks, including zero | Zero can be meaningful, but secrecy/hiding requires the intended randomness policy |
| `From<PedersenRandomness>`, `blinding_component(rng)` | `r·G`, or random scalar plus that point | Samples with `Rng + CryptoRng`; no nonzero requirement imposed |
| `Pedersen::commit(type,v,r)` | `r·G + v·hash_to_curve(type)` | Arithmetic on typed points; no identity rejection needed |
| `Add/Neg/Sub`, `FieldRepr` | Arithmetic and coordinate representation | Identity and cancellation are legitimate; encoding does not establish knowledge of an opening |

The scheme is present in each Ledger snapshot's quoted module exports ([§4.1](#41-scheme-and-curve-availability)).
The defining implementation is:

Full source: [l9: transient-crypto/src/commitment.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L38-L72), [Ledger 8.1.2](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/commitment.rs#L38-L72), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/commitment.rs#L38-L72).

Source: [relevant lines 41–48](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L41-L48).

```rust
#[derive(
    Default, Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serializable, Serialize, Storable,
)]
#[storable(base)]
#[tag = "pedersen[v1]"]
#[serde(transparent)]
#[cfg_attr(feature = "proptest", derive(Arbitrary))]
pub struct Pedersen(pub EmbeddedGroupAffine);
```

Source: [relevant lines 54–60](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L54-L60).

```rust
pub type PedersenRandomness = EmbeddedFr;

impl From<PedersenRandomness> for Pedersen {
    fn from(rand: PedersenRandomness) -> Pedersen {
        Pedersen(EmbeddedGroupAffine::generator() * rand)
    }
}
```

Full source: [l9: transient-crypto/src/commitment.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L75-L103).

Source: [relevant lines 79–84](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L79-L84).

```rust
    pub fn blinding_component<R: Rng + CryptoRng + ?Sized>(
        rng: &mut R,
    ) -> (Self, PedersenRandomness) {
        let rand: PedersenRandomness = rng.r#gen();
        (rand.into(), rand)
    }
```

Source: [l9: transient-crypto/src/commitment.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L112-L125), [Ledger 8.1.2](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/commitment.rs#L112-L125), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/commitment.rs#L112-L125).

```rust
impl Pedersen {
    /// Homomorphically commits to a value of a type.
    ///
    /// Produces: `H(type_)^v g^r`, where `H` is [`hash_to_curve`] over a
    /// [`crate::hash::transient_hash`]-reduced `type_`.
    pub fn commit<T: FieldRepr + ?Sized>(type_: &T, v: &EmbeddedFr, r: &EmbeddedFr) -> Self {
        // What we want: Given a hash-to-curve H:
        // Commit(type, v, r) = g^r H(type)^v
        let h = hash_to_curve(type_);
        let g = EmbeddedGroupAffine::generator();
        let com = g * *r + h * *v;
        Pedersen(com)
    }
}
```

**Identity policy:** zero value and zero blinding give group identity. A zero
value with nonzero blinding generally does not. Identity alone does not establish
that an input was empty or authenticate any public key. No dedicated secret-key,
nonce, or signature wire type belongs to plain Pedersen commitments.

### 6.2. Proof of a generator-only Pedersen opening on Jubjub

This primitive proves knowledge of a scalar opening to a generator-only commitment. The review separates proof construction, nonce requirements, equation verification, and conversion to an ordinary commitment.

> **Unsafe without caller discipline:** `new_from` requires only `Rng`, so the caller must supply cryptographically suitable nonce randomness. Conversion to `Pedersen` does not call `valid`; relying on the claimed opening requires verification first.

| Material / public operation | Checks and timing | Assessment |
|---|---|---|
| `PureGeneratorPedersen` declaration / derived serialization | Public commitment plus private target and reply fields; derived field decoding | Parsing generic point/scalar syntax does not run the proof equation |
| `new_from(rng,wit,challenge_pre)` | Builds commitment, sampled target, challenge and reply | **Role-limited:** bound is only `Rng`, not `CryptoRng`; caller must supply cryptographically suitable nonce randomness |
| `valid(challenge_pre)` | Checks `reply·G = target + challenge·commitment` | Explicit equation check at this call; no explicit identity rejection |
| `From<PureGeneratorPedersen> for Pedersen` | Drops evidence fields, returns commitment | Does not call `valid`; caller must verify evidence before relying on it |
| `largest_representable` | Constructs a size-estimation specimen | Not a constructor of authenticated evidence; must not be treated as a successful proof |

The nonce and witness are scalars, but this is a commitment-opening proof,
not the public-key signature scheme in §4.2. Identity policy therefore cannot be
copied between the two without analysing their roles.

Source: [l9: transient-crypto/src/commitment.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L127-L173), [Ledger 8.1.2](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/commitment.rs#L127-L173), [Ledger main](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/commitment.rs#L127-L173).

```rust
/// A commitment of type `PedersenCom`, with only the randomization part (of base `g`),
/// and *not* the value part (of base `H(ty)`). To ensure this, a Fiat-Shamir proof of knowledge of
/// exponent is used, guaranteeing that only an exponent of `g` is known.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serializable, Serialize, Storable)]
#[storable(base)]
#[tag = "pedersen-schnorr[v1]"]
#[cfg_attr(feature = "proptest", derive(Arbitrary))]
pub struct PureGeneratorPedersen {
    /// The underlying Pedersen commitment.
    pub commitment: Pedersen,
    target: EmbeddedGroupAffine,
    reply: EmbeddedFr,
}
tag_enforcement_test!(PureGeneratorPedersen);

impl From<PureGeneratorPedersen> for Pedersen {
    fn from(com: PureGeneratorPedersen) -> Pedersen {
        com.commitment
    }
}

impl PureGeneratorPedersen {
    /// Returns an instance of the largest representable instance of this type, for use in
    /// estimating fee computations down the line.
    pub fn largest_representable() -> Self {
        let m1 = EmbeddedFr::from(0) - 1.into();
        let p = EmbeddedGroupAffine::generator();
        PureGeneratorPedersen {
            commitment: Pedersen(p),
            target: p,
            reply: m1,
        }
    }

    /// Creates a new, Fiat-Shamir evidenced Pedersen commitment with no second bases.
    /// Takes `wit`, the preimage of the commitment, and `challenge_pre`,
    /// arbitrary data that is bound in the Fiat-Shamir.
    pub fn new_from<R: Rng>(rng: &mut R, wit: &PedersenRandomness, challenge_pre: &[u8]) -> Self {
        let commitment = (*wit).into();
        let rand: EmbeddedFr = rng.r#gen();
        let target = EmbeddedGroupAffine::generator() * rand;
        let reply = rand + Self::challenge(&commitment, &target, challenge_pre) * *wit;
        PureGeneratorPedersen {
            commitment,
            target,
            reply,
        }
```

Source: [l9: transient-crypto/src/commitment.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/commitment.rs#L175-L200).

```rust

    fn challenge(
        commitment: &Pedersen,
        target: &EmbeddedGroupAffine,
        challenge_pre: &[u8],
    ) -> EmbeddedFr {
        let mut data = Vec::<u8>::new();
        data.extend(commitment.0.0.to_bytes().as_ref());
        data.extend(target.0.to_bytes().as_ref());
        data.extend(challenge_pre);
        const DOMAIN_SEP: HashOutput = HashOutput(*b"midnight:schnorr_challenge\0\0\0\0\0\0");
        let hash_bytes: HashOutput = persistent_commit(&data[..], DOMAIN_SEP);
        let mut raw_le = [0u8; 64];
        raw_le[..32].copy_from_slice(&hash_bytes.0);
        // Yes, I know it's not uniform, but this is essentially a modular from_bytes_le
        EmbeddedFr(embedded::Scalar::from_bytes_wide(&raw_le))
    }

    /// Checks if the Fiat-Shamir proof is valid against arbitrary challenge data.
    pub fn valid(&self, challenge_pre: &[u8]) -> bool {
        let test_left = EmbeddedGroupAffine::generator() * self.reply;
        let test_right = self.target
            + self.commitment.0 * Self::challenge(&self.commitment, &self.target, challenge_pre);
        test_left == test_right
    }
}
```

### 6.3. Hash-based commitments and Jubjub hash-to-curve

These APIs produce field or byte commitments and map inputs to Jubjub points. This subsection identifies their input and output domains and explains which checks concern encoding rather than imported public-key validity.

| Primitive / public operation | Input, output, import/export and checks | Assessment |
|---|---|---|
| `transient_commit(value,opening)` / Compact `transientCommit` | Opening plus field representation, Poseidon field output; scalar encoding in [§3.6](#36-scalar-declarations-and-integer-encoding) | No public key/nonidentity policy; verify commitment by recomputation |
| `persistent_commit(value,opening)` / Compact `persistentCommit` | Opening plus binary representation, SHA256 output; fixed-byte hash wrapper | Bytes, not an EC point; not a subgroup-validation API |
| `hash_to_curve` / Compact `hashToCurve` | Field representation to typed Jubjub point; point export/import in [§3.2](#32-jubjub-points) | No imported external public key; a hash output is not a key-ownership proof |
| Direct hash/opening wrappers and serialization | Preserve their field/byte domains | Range/length checks and application domain separation, not identity/subgroup checks |

Ledger's implementations and Compact adapters show the representation boundaries:

Full source: [l9: transient-crypto/src/hash.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/hash.rs#L75-L107).

Source: [relevant lines 84–88](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/hash.rs#L84-L88).

```rust
pub fn transient_commit<T: FieldRepr + ?Sized>(value: &T, opening: Fr) -> Fr {
    let mut preimage = vec![opening];
    value.field_repr(&mut preimage);
    transient_hash(&preimage)
}
```

Full source: [l9: base-crypto/src/hash.rs](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/hash.rs#L92-L103).

Source: [relevant lines 93–95](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/hash.rs#L93-L95).

```rust
pub fn persistent_hash(a: &[u8]) -> HashOutput {
    HashOutput(Sha256::digest(a).into())
}
```

Source: [relevant lines 98–103](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/base-crypto/src/hash.rs#L98-L103).

```rust
pub fn persistent_commit<T: BinaryHashRepr + ?Sized>(value: &T, opening: HashOutput) -> HashOutput {
    let mut writer = PersistentHashWriter::new();
    opening.binary_repr(&mut writer);
    value.binary_repr(&mut writer);
    writer.finalize()
}
```

Source: [c: runtime/src/built-ins.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L111-L116).

```typescript
export function transientCommit<A>(rtType: CompactType<A>, value: A, opening: bigint): bigint {
  return ocrt.valueToBigInt(ocrt.transientCommit(rtType.alignment(), rtType.toValue(value), ocrt.bigIntToValue(opening)));
}

/**
 * The Compact builtin `persistentHash` function
```

Source: [c: runtime/src/built-ins.ts](https://github.com/LFDT-Minokawa/compact/blob/0e7a4b677d0b0aa0b03727604d4f5e80e765d588/runtime/src/built-ins.ts#L150-L160).

```typescript
export function persistentCommit<A>(rtType: CompactType<A>, value: A, opening: Uint8Array): Uint8Array {
  if (opening.length != 32) {
    throw new CompactError('Expected 32-byte string');
  }
  const wrapped = ocrt.persistentCommit(rtType.alignment(), rtType.toValue(value), [opening])[0];
  const res = new Uint8Array(32);
  res.set(wrapped, 0);
  return res;
}

/**
```

### 6.4. Proof-system keys and KZG commitments on BLS12-381

Proof-system keys describe how to prove or verify a circuit, and use BLS12-381 points internally. This subsection follows setup, key parsing, delayed initialization, and caller responsibilities for encoding and trusted parameters.

> **Delayed and incomplete parsing boundaries:** Ledger wrappers initially retain bytes rather than validating a key. The released wrappers reject leftovers during initialization, the pinned Ledger `main` lacks that guard, and the core reader leaves trailing bytes to its caller. These findings do not establish acceptance of a forged proof.

| Material / public operation | Checks and timing | Assessment |
|---|---|---|
| stdlib `setup_vk/setup_pk`, `prove/verify` | Circuit-specific keys and proof equation; caller provides KZG parameters | Setup/parameter policy is independent of parsing |
| `MidnightVK::write/read` | Architecture, constraint-system/key format; core read does not require stream exhaustion | Caller-dependent canonicality; trailing-byte test in [§7.1](#71-completed-executable-checks) |
| Ledger verifier-key wrapper `deserialize`, `init/force_init`, `serialize` | Defers key parsing; releases reject leftovers at initialization and preserve byte representation | Lazy validation; pinned main lacks that exhaustion guard |
| Group encodings and raw proof formats | Checked versus unchecked underlying point import in [§3.5](#35-bls12-381-proof-system-points) | `RawBytesUnchecked` assumes trusted material; no complete outer-proof parsing audit claimed |
| Committed public-input point | BLS12-381 G1; optional committed instance defaults to identity in stdlib verify | Role-specific identity acceptance; not the encryption-key rule |

Ledger 8.1.2's wrapper deserializer reads a length-bounded byte vector and stores
it as `Uninitialized`. It does not immediately parse the proof-system key.
Ledger 9 has the same deferred parsing behavior.

Source: [Ledger 8.1.2: `transient-crypto/src/proofs.rs:422–442`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/proofs.rs#L422-L442).

```rust
    fn deserialize(
        reader: &mut impl std::io::Read,
        recursion_depth: u32,
    ) -> Result<Self, std::io::Error> {
        const MAX_EXPECTED_SIZE: usize = 50_000;
        let buf = <Vec<u8> as Deserializable>::deserialize(reader, recursion_depth)?;
        if buf.len() > MAX_EXPECTED_SIZE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Declared vk size {} exceeded permitted limit of {MAX_EXPECTED_SIZE}",
                    buf.len()
                ),
            ));
        }
        Ok(Self(Arc::new(Mutex::new(InnerVerifierKey::Uninitialized(
            buf,
        )))))
    }
}

```

Source: [Ledger 9 rc.5: `transient-crypto/src/proofs.rs:418–438`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/proofs.rs#L418-L438).

```rust
    fn deserialize(
        reader: &mut impl std::io::Read,
        recursion_depth: u32,
    ) -> Result<Self, std::io::Error> {
        const MAX_EXPECTED_SIZE: usize = 50_000;
        let buf = <Vec<u8> as Deserializable>::deserialize(reader, recursion_depth)?;
        if buf.len() > MAX_EXPECTED_SIZE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Declared vk size {} exceeded permitted limit of {MAX_EXPECTED_SIZE}",
                    buf.len()
                ),
            ));
        }
        Ok(Self(Arc::new(Mutex::new(InnerVerifierKey::Uninitialized(
            buf,
        )))))
    }
}

```

During `force_init`, both release snapshots read the proof-system key and
reject leftover bytes. They retain the original bytes alongside the parsed key;
serialization writes those preserved bytes even after initialization. This
supports the precise claim “trailing bytes are rejected on initialization”;
“initial deserialization always rejects them” would be incorrect.

Source: [Ledger 8.1.2: `transient-crypto/src/proofs.rs:535–555`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/transient-crypto/src/proofs.rs#L535-L555).

```rust
        let mut slice: &[u8] = &data;
        let vk = MidnightVK::read(&mut slice, SerdeFormat::Processed)
            .map_err(|_| anyhow::anyhow!("problem reading the verifier key"))?;
        // Reject keys with unconsumed trailing bytes: two encodings must not map
        // to the same key, and the trailing bytes would otherwise survive in the
        // preserved-original serialization.
        if !slice.is_empty() {
            return Err(anyhow::anyhow!("trailing bytes after verifier key"));
        }
        *mutex = InnerVerifierKey::Initialized(vk.clone(), data);
        Ok(vk)
    }

    fn inner_serialize<W: std::io::Write>(&self, mut writer: W) -> std::io::Result<()> {
        match &*self.0.lock().expect("mutex is not poisoned") {
            InnerVerifierKey::Uninitialized(data) | InnerVerifierKey::Invalid(data) => {
                writer.write_all(data)
            }
            InnerVerifierKey::Initialized(_, original) => writer.write_all(original),
        }
    }
```

Source: [Ledger 9 rc.5: `transient-crypto/src/proofs.rs:531–552`](https://github.com/midnightntwrk/midnight-ledger/blob/67f9f97246339539af0091c4d8c6bc5ab236a191/transient-crypto/src/proofs.rs#L531-L552).

```rust
        };
        let mut slice: &[u8] = &data;
        let vk = MidnightVK::read(&mut slice, SerdeFormat::Processed)
            .map_err(|_| anyhow::anyhow!("problem reading the verifier key"))?;
        // Reject keys with unconsumed trailing bytes: two encodings must not map
        // to the same key, and the trailing bytes would otherwise survive in the
        // preserved-original serialization.
        if !slice.is_empty() {
            return Err(anyhow::anyhow!("trailing bytes after verifier key"));
        }
        *mutex = InnerVerifierKey::Initialized(vk.clone(), data);
        Ok(vk)
    }

    fn inner_serialize<W: std::io::Write>(&self, mut writer: W) -> std::io::Result<()> {
        match &*self.0.lock().expect("mutex is not poisoned") {
            InnerVerifierKey::Uninitialized(data) | InnerVerifierKey::Invalid(data) => {
                writer.write_all(data)
            }
            InnerVerifierKey::Initialized(_, original) => writer.write_all(original),
        }
    }
```

The pinned `main` differs: it reads from the buffer, stores only the parsed key,
and returns without checking that the reader was exhausted. Serialization of
an initialized key reserializes that parsed key. Hence the release hardening
must not be attributed to this `main` snapshot.

Source: [Ledger main: `transient-crypto/src/proofs.rs:528–542`](https://github.com/midnightntwrk/midnight-ledger/blob/730dba0875e75bb317e3ac81200326ef634249be/transient-crypto/src/proofs.rs#L528-L542).

```rust
        let reader = &mut &data[..];
        let vk = MidnightVK::read(reader, SerdeFormat::Processed)
            .map_err(|_| anyhow::anyhow!("problem reading the verifier key"))?;
        *mutex = InnerVerifierKey::Initialized(vk.clone());
        Ok(vk)
    }

    fn inner_serialize<W: std::io::Write>(&self, mut writer: W) -> std::io::Result<()> {
        match &*self.0.lock().expect("mutex is not poisoned") {
            InnerVerifierKey::Uninitialized(data) | InnerVerifierKey::Invalid(data) => {
                writer.write_all(data)
            }
            InnerVerifierKey::Initialized(key) => key.write(&mut writer, SerdeFormat::Processed),
        }
    }
```

Verifier keys here are **proof-system verification keys**, not signature public
keys. Their lazy parsing and byte-preservation policy must be tracked separately
from EC public-key identity/subgroup policies.

The released Midnight ZK stdlib reader consumes the fields and returns the key;
it does not require the caller's stream to be exhausted:

Source: [stdlib 2.3.5 `MidnightVK::read`](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/zk_stdlib/src/lib.rs#L1581-L1602).

```rust
    pub fn read<R: io::Read>(reader: &mut R, format: SerdeFormat) -> io::Result<Self> {
        let architecture = ZkStdLibArch::read(reader)?;

        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)?;
        let k = byte[0];

        let mut bytes = [0u8; 4];
        reader.read_exact(&mut bytes)?;
        let nb_public_inputs = u32::from_le_bytes(bytes) as usize;

        let mut cs = ConstraintSystem::default();
        let _config = ZkStdLib::configure(&mut cs, (architecture, k - 1));

        let vk = VerifyingKey::read_from_cs::<R>(reader, format, cs)?;

        Ok(MidnightVK {
            architecture,
            k,
            nb_public_inputs,
            vk,
        })
```

The executable key-reader check appends `0x42` to a valid processed verification
key, successfully reads the key, and finds that byte still unread. It confirms the
core reader boundary, not the behavior of the complete Ledger lazy wrapper;
release-wrapper rejection remains supported by the excerpts above. See
[§7.1](#71-completed-executable-checks).

Source: [stdlib verify and optional committed-instance identity](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/zk_stdlib/src/lib.rs#L2017-L2037).

#### 6.4.1. Proving-key import/export

Proving keys have their own read/write lifecycle and format choices. This subsection identifies the trust requirements of their point decoder and the distinction between parsing one key and consuming an entire input buffer.

> **Unsafe format for untrusted input:** `RawBytesUnchecked` is explicitly intended for trusted proving-key material. The displayed reader also leaves whole-buffer exhaustion to its caller; adversarial parser testing remains outstanding.

`MidnightPK::write/read` is a separate public lifecycle from `MidnightVK`.
It writes/reads the circuit size, relation, and proving key. Its raw unchecked
format explicitly assumes trusted input; the displayed `read` returns after
parsing without a whole-stream exhaustion check. This source check does not
replace an adversarial proving-key parser test.

Source: [stdlib 2.3.5 proving-key write/read](https://github.com/midnightntwrk/midnight-zk/blob/cfa6250fda094bc62ddd2050c001024052624173/zk_stdlib/src/lib.rs#L1635-L1674).

```rust
    pub fn write<W: io::Write>(&self, writer: &mut W, format: SerdeFormat) -> io::Result<()> {
        writer.write_all(&[self.k])?;

        Rel::write_relation(&self.relation, writer)?;

        self.pk.write(writer, format)
    }

    /// Reads a proving key from a buffer.
    ///
    /// The `format` must match the one that was used when writing the key.
    /// If the key was written with `RawBytes`, it can be read with `RawBytes`
    /// or `RawBytesUnchecked` (which is faster).
    ///
    /// # WARNING
    /// Use `RawBytesUnchecked` only if you trust the party who wrote the key.
    pub fn read<R: io::Read>(reader: &mut R, format: SerdeFormat) -> io::Result<Self> {
        let mut byte = [0u8; 1];

        reader.read_exact(&mut byte)?;
        let k = byte[0];

        let relation = Rel::read_relation(reader)?;

        let pk = ProvingKey::read::<R, MidnightCircuit<Rel>>(
            reader,
            format,
            MidnightCircuit::new(
                &relation,
                Value::unknown(),
                Value::unknown(),
                Some(k as u32),
            )
            .params(),
        )?;

        Ok(MidnightPK { k, relation, pk })
    }

    /// The size of the domain associated to this proving key.
```

## 7. Validation results and remaining work

This section records what the executable checks establish and what still requires testing through higher-level APIs. It links each result or remaining task back to the relevant scheme and source discussion.

> **Evidence limit:** plaintext recovery for an identity encryption recipient is demonstrated, while the altered-coordinate proof is rejected. Wallet submission and compiled Compact signature acceptance remain open tests; see [§7.2](#72-remaining-validation-work).

### 7.1. Completed executable checks

The checks below reproduce selected coordinate, subgroup, encryption, signature, and key-parsing behaviors. They record the tested package versions and separate native or backend results from claims about compiled contracts or deployed wallets.

The [reproduction directory](ecc-validation-checks/README.md) contains the backend
suite, Ledger API tests, pinned dependency lockfiles, and a runner. All tests passed:
**five backend tests with proofs 0.8.3, the same five with proofs 0.8.2, and three
Ledger 9 native API tests**. The other backend versions remain circuits 7.2.4,
curves 0.3.1, and stdlib 2.3.5. Ledger source is pinned to rc.5 commit `67f9f97…`;
the native harness pins its direct backend dependencies and records the resolved
transitive dependencies in its own lockfile. It does not rebuild every package
using the complete Ledger workspace lockfile.

| Check | Observed result | Interpretation and source discussion |
|---|---|---|
| Valid Jubjub coordinates versus `x+2,y` | Raw decoder returns the same point; valid coordinates pass MockProver; altered coordinates fail | Representation mismatch, with coordinate constraints enforced; [§3.2](#32-jubjub-points) |
| Full proof, valid control and altered witness | Valid proof verifies; altered witness produces proof bytes that verification rejects | No proof forgery demonstrated; direct backend circuit only |
| Generic identity point `(0,1)` | Coordinate circuit passes | Identity is valid generic group data; key use needs its own policy; [§2.2](#22-what-validation-means) |
| Order-two point `(0,-1)` and generator plus that point | Forged subgroup wrappers fail MockProver; coordinate synthesis panics (caught by the test) | Subgroup enforcement holds for these cases; clean error handling is absent; [§3.2.4](#324-circuit-assignment-and-executable-evidence) |
| Processed proof verification key plus one trailing byte | Backend reader succeeds and leaves the byte unread | Caller must enforce exhaustion; [§6.4](#64-proof-system-keys-and-kzg-commitments-on-bls12-381) |
| Zero encryption secret key and identity recipient public key | Import and serialization round-trip succeed; plaintext recovered using public data alone | Hazardous encryption-key acceptance reproduced; [§5](#5-encryption-schemes) |
| Identity ciphertext challenge | Deserialization fails and direct decrypt returns `None` | Separate challenge check works; [§5.1.4](#514-ephemeral-ciphertext-points-and-decryption) |
| Identity Jubjub signature announcement with nonidentity public key | Signature equation holds; Ledger native verifier returns false | Native policy reproduced; compiled Compact verifier remains untested; [§4.2](#42-schnorr-with-poseidon-challenge-on-jubjub) |

The decisive checks are explicit in [the backend suite](ecc-validation-checks/src/lib.rs)
and [the Ledger suite](ecc-validation-checks/ledger-api.rs). For example, the
Ledger recovery check uses only the public identity coordinates to recover `42`:

```rust
let public_key=transient_hash(&[Fr::from(0u64),Fr::from(1u64)]);
assert_eq!(cipher.ciph[1]-transient_hash(&[public_key,Fr::from(1u64)]),Fr::from(42u64));
```

Run the latest released backend suite from the repository root:

```sh
cargo test --locked --manifest-path research/ecc-validation-checks/Cargo.toml -- --nocapture
```

Run the same backend suite with the consumer's proofs 0.8.2, or the Ledger native
API suite with an isolated checkout of the pinned Ledger commit:

```sh
python3 research/ecc-validation-checks/run.py consumer -- --nocapture
python3 research/ecc-validation-checks/run.py ledger /path/to/pinned-ledger -- --nocapture
```

The proof tests use local test-only KZG parameters. They test the actual released
circuit libraries, not production parameters or a compiled Compact program.
The small-order/mixed-torsion test intentionally catches panics, so those panic
messages in `--nocapture` output accompany a passing assertion, not a failed test.

### 7.2. Remaining validation work

The remaining tasks target integration boundaries and acceptance policies not covered by the completed tests. Their priorities reflect the unresolved evidence needed to assess the findings, rather than a claim that every listed concern is exploitable.

| Priority | Test or review | Remaining evidence needed |
|---|---|---|
| High | Supply `x+2,y` through compiled Compact arguments, witnesses, v2 arithmetic, v3 construction, and raw decoding | Cross-layer acceptance/rejection; backend coordinate constraints have already been tested |
| High | Identity encryption recipient through a wallet and transaction submission | Execute the WASM call chain in [§5.1.3](#513-wasm-and-transaction-construction-entry-points) and determine which downstream callers reject hazardous keys |
| High | Additional torsion representatives and malformed compressed encodings across evaluators | Broader rejection and clean error behavior; the order-two/mixed-torsion backend cases are complete |
| Medium | Compile and prove Compact signatures with identity announcements | Compare actual Compact acceptance with the native policy; algebra alone is insufficient |
| Medium | Noncanonical flagged secp identities and unused encoded limbs | Canonical representation checks at runtime, raw decoder, ZKIR re-encoding, and circuit boundaries |
| Medium | Full Ledger lazy verification-key wrapper with trailing bytes before and after `init` | Execute delayed rejection and preserved-byte serialization; core-reader behavior is already tested |
| Medium | High/low-`s` ECDSA variants and Ed25519 identity/torsion edge cases | Application canonicality and cross-library acceptance |
| Medium | Zero secret/nonce behavior in native Jubjub signing and caller RNG policy for `PureGeneratorPedersen` | Execute signer edge cases and confirm every application supplies suitable randomness; source bounds alone do not establish caller behavior |
| Medium | Outer-curve proof commitments and every proof-system deserializer | Complete the proof-system parsing audit beyond the quoted helper paths |

**Limits:** results establish the specific decoder, circuit, proof-verification,
and native API behaviors above. Source traces identify the Ledger WASM encryption
call chain, but no browser wallet or deployed transaction path was executed.
Coverage does not extend to every downstream k256/noble parser or proof-system
deserializer. No successful proof forgery, production exploit, or deployment
severity is claimed.

