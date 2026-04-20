{
  description = "Nix Flake for NEAR protocol exploration in Rust";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, fenix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        
        # Use stable rust toolchain from fenix
        toolchain = fenix.packages.${system}.stable.withComponents [
          "cargo"
          "rustc"
          "rust-src"
          "rustfmt"
          "clippy"
        ];

        # Common native build inputs
        nativeBuildInputs = with pkgs; [
          pkg-config
          toolchain
        ];

        # Common build inputs
        buildInputs = with pkgs; [
          openssl
          udev
        ] ++ lib.optionals stdenv.isDarwin [
          darwin.apple_sdk.frameworks.Security
          darwin.apple_sdk.frameworks.SystemConfiguration
        ];

      in
      {
        # `nix develop`
        devShells.default = pkgs.mkShell {
          inherit nativeBuildInputs buildInputs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
          PATH="$HOME/.cargo/bin:$PATH";

          packages = with pkgs; [
            rust-analyzer
            cargo-edit
            cargo-watch
            rustup
          ];

          shellHook = ''
            echo "NEAR Exploration Rust Environment"
            cargo --version
            rustc --version

            SANDBOX=$(find target/debug/build -name "near-sandbox" -type f 2>/dev/null | head -1)
            if [ -n "$SANDBOX" ]; then
              patchelf \
                --set-interpreter ${pkgs.glibc}/lib64/ld-linux-x86-64.so.2 \
                --set-rpath ${pkgs.xz.out}/lib:${pkgs.stdenv.cc.cc.lib}/lib \
                "$SANDBOX"
            fi
          '';
        };
      }
    );
}
