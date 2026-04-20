{
  description = "Nix Flake for building midnight-node from bwbush/midnight-node";

  # ---------------------------------------------------------------------------
  # Inputs
  # ---------------------------------------------------------------------------
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-utils.url = "github:numtide/flake-utils";

    # crane — ergonomic Rust builds in Nix
    crane.url = "github:ipetkov/crane";

    # fenix — nightly Rust toolchains (Substrate / midnight-node requires
    # nightly features such as `build-std`)
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # The upstream source.  Pin the revision you want to build; update the
    # hash after running `nix flake update` or by substituting the real hash.
    midnight-node-src = {
      url   = "github:midnightntwrk/midnight-node?ref=node-0.20.2";
      flake = false;
    };
  };

  # ---------------------------------------------------------------------------
  # Outputs
  # ---------------------------------------------------------------------------
  outputs = { self, nixpkgs, flake-utils, crane, fenix, midnight-node-src }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # Substrate links against RocksDB which carries an unfree licence.
          config.allowUnfree = true;
        };

        # ------------------------------------------------------------------
        # Rust toolchain
        # Substrate / Polkadot-SDK projects typically require a specific
        # nightly channel.  Adjust `channel` / `date` to match the
        # `rust-toolchain.toml` found in the upstream repo.
        # ------------------------------------------------------------------
        toolchain = fenix.packages.${system}.fromToolchainFile {
          # Point at the rust-toolchain.toml shipped in the source tree so
          # Nix honours exactly the same channel the project specifies.
          file = "${midnight-node-src}/rust-toolchain.toml";
          sha256 = "sha256-SJwZ8g0zF2WrKDVmHrVG3pD2RGoQeo24MEXnNx5FyuI=";
        };

        craneLib = (crane.mkLib pkgs).overrideToolchain toolchain;

        # ------------------------------------------------------------------
        # Native build inputs common to Substrate-based nodes
        # ------------------------------------------------------------------
        nativeBuildInputs = with pkgs; [
          pkg-config
          clang          # needed by librocksdb-sys / bindgen
          llvmPackages.libclang
          protobuf       # parity-scale-codec and others use protoc
        ];

        buildInputs = with pkgs; [
          openssl
          rocksdb
          zstd
        ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
          pkgs.darwin.apple_sdk.frameworks.Security
          pkgs.darwin.apple_sdk.frameworks.SystemConfiguration
        ];

        # Environment variables expected by Substrate build scripts
        commonEnv = {
          LIBCLANG_PATH     = "${pkgs.llvmPackages.libclang.lib}/lib";
          ROCKSDB_LIB_DIR   = "${pkgs.rocksdb}/lib";
          PROTOC            = "${pkgs.protobuf}/bin/protoc";
          PROTOC_INCLUDE    = "${pkgs.protobuf}/include";
          # Tells substrate-build-script-helper where to find the git info
          SUBSTRATE_CLI_GIT_COMMIT_HASH = "unknown";
        };

        # ------------------------------------------------------------------
        # Dependency-only build (cargo fetch cache)
        # Building deps separately gives faster incremental rebuilds.
        # ------------------------------------------------------------------
        # Patch the source tree to remove `readme = "README.md"` lines from
        # any Cargo.toml that references a non-existent README.  Crane's
        # vendoring step runs `cargo package` which validates these paths,
        # and several sub-crates under toolkit/block-producer-fees/ are
        # missing their README files.
        patchedSrc = pkgs.runCommand "midnight-node-src-patched" {} ''
          cp -r --no-preserve=mode ${midnight-node-src} $out
          find $out -name "Cargo.toml" | while read f; do
            dir=$(dirname "$f")
            # If the Cargo.toml mentions a readme that doesn't exist, strip the line
            if grep -q 'readme\s*=' "$f"; then
              readme=$(sed -n 's/^readme\s*=\s*"\(.*\)"/\1/p' "$f")
              if [ -n "$readme" ] && [ ! -f "$dir/$readme" ]; then
                sed -i '/^readme\s*=/d' "$f"
              fi
            fi
          done
        '';

        # Vendor all dependencies, then strip readme lines from every
        # Cargo.toml in the vendored tree as well.
        cargoVendorDir = pkgs.runCommand "midnight-node-vendor-patched" {} ''
          cp -r --no-preserve=mode \
            ${craneLib.vendorCargoDeps { src = patchedSrc; }} $out
          find $out -name "Cargo.toml" -exec sed -i '/^readme *=/d' {} +
        '';

        cargoArtifacts = craneLib.buildDepsOnly ({
          src = craneLib.cleanCargoSource patchedSrc;
          inherit cargoVendorDir nativeBuildInputs buildInputs;
        } // commonEnv);

        # ------------------------------------------------------------------
        # Final package — produces the `midnight-node` binary
        # ------------------------------------------------------------------
        midnight-node = craneLib.buildPackage ({
          inherit cargoArtifacts cargoVendorDir nativeBuildInputs buildInputs;
          src = patchedSrc;

          # Build only the node binary; skip tests during `nix build`
          cargoExtraArgs = "--bin midnight-node --locked";

          # Substrate's `build.rs` scripts need these at build time
          doCheck = false;
        } // commonEnv);

      in
      {
        # `nix build` → builds the midnight-node executable
        packages = {
          inherit midnight-node;
          default = midnight-node;
        };

        # `nix run` → runs midnight-node directly
        apps.default = flake-utils.lib.mkApp {
          drv  = midnight-node;
          name = "midnight-node";
        };

        # `nix develop` → drop into a shell that mirrors the build env
        devShells.default = craneLib.devShell ({
          inherit nativeBuildInputs;
          packages = buildInputs ++ (with pkgs; [
            rust-analyzer
            cargo-edit
            cargo-watch
          ]);
        } // commonEnv);
      }
    );
}
