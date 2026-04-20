{
  description = "Nix Flake for Paima";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        buildInputs = with pkgs; [
          stdenv.cc.cc.lib
        ];
      in
      {
        # `nix develop`
        devShells.default = pkgs.mkShell {
          inherit buildInputs;
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
          packages = with pkgs; [
            nodejs_20
          ];
          shellHook = ''
            if [ -f ./paima-engine-linux ]; then
              patchelf \
                --set-interpreter ${pkgs.glibc}/lib64/ld-linux-x86-64.so.2 \
                --set-rpath ${pkgs.lib.makeLibraryPath buildInputs} \
                ./paima-engine-linux
            fi
          '';
        };
      }
    );
}
