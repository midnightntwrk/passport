{
  description = "Midnight Passport pipeline: Agda → JSON → SVG";

  # `spec`   — the formal-spec flake; exports packages.${system}.agda
  #            (agdaWithPackages-2.8.0 with all IOG libraries) and
  #            packages.${system}.default (type-checked arc-passport library).
  # `render` — the standalone Julia/Catlab renderer flake.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    spec = {
      url   = "path:..";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    render = {
      url   = "path:../render";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, spec, render }:
    let
      systems       = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # ── nix build ./formal-spec/pipeline ────────────────────────────────
      # Compiles Main.agda via the GHC backend and runs it once to produce
      # $out/passport.json.  All deps are in the nix store; no network access
      # needed at build time.
      packages = forAllSystems (system:
        let
          pkgs       = nixpkgs.legacyPackages.${system};
          agdaFull   = spec.packages.${system}.agda;
          arcLib     = spec.packages.${system}.default;
          # GHC with the Agda Haskell package — provides MAlonzo.RTE for
          # the generated code.
          ghcWithRTS = pkgs.haskellPackages.ghcWithPackages (p: [ p.Agda ]);
        in
        {
          default = pkgs.stdenv.mkDerivation {
            pname      = "passport-json";
            version    = "0.1";
            dontUnpack = true;

            nativeBuildInputs = [ agdaFull ghcWithRTS ];

            buildPhase = ''
              # Agda writes interface caches to ~/.agda; point HOME somewhere
              # writable inside the sandbox.
              export HOME=$(mktemp -d)

              # Copy the pre-typechecked arc-passport library (*.agda + *.agdai)
              # to a writable working directory so Agda can write MAlonzo/ alongside.
              # pipeline/Main.agda (module pipeline.Main) is included in arcLib.
              cp -r ${arcLib}/. .
              chmod -R u+w .

              # Compile pipeline/Main.agda via the MAlonzo / GHC backend.
              # -O0 skips Haskell optimisations — this binary runs exactly once.
              # -o names the binary explicitly so we know where to find it.
              ${agdaFull}/bin/agda --compile \
                --ghc-flag=-O0 \
                --ghc-flag=-o --ghc-flag=./passport-compiler \
                pipeline/Main.agda
            '';

            installPhase = ''
              mkdir -p $out
              ./passport-compiler > $out/passport.json
            '';
          };
        });

      # ── nix run ./formal-spec/pipeline -- [output.svg] ──────────────────
      # Builds passport.json (above), then renders it to SVG via the Catlab
      # renderer.  Output defaults to ./passport.svg.
      apps = forAllSystems (system:
        let
          pkgs         = nixpkgs.legacyPackages.${system};
          passportJSON = self.packages.${system}.default;
          renderProg   = render.apps.${system}.default.program;
          script = pkgs.writeShellScript "passport-pipeline" ''
            exec ${renderProg} ${passportJSON}/passport.json "''${1:-passport.svg}"
          '';
        in
        {
          default = { type = "app"; program = "${script}"; };
        });

      # ── nix develop ./formal-spec/pipeline ──────────────────────────────
      # Interactive shell: Agda (with all IOG libraries), GHC, and Graphviz.
      # Useful for iterating on pipeline/Main.agda or Architecture.agda.
      #
      # To manually compile and run:
      #   cd formal-spec
      #   agda --compile --ghc-flag=-O0 --ghc-flag=-o --ghc-flag=./passport-compiler \
      #     pipeline/Main.agda
      #   ./passport-compiler | nix run ./formal-spec/render -- /dev/stdin /tmp/passport.svg
      devShells = forAllSystems (system:
        let
          pkgs       = nixpkgs.legacyPackages.${system};
          agdaFull   = spec.packages.${system}.agda;
          ghcWithRTS = pkgs.haskellPackages.ghcWithPackages (p: [ p.Agda ]);
        in
        {
          default = pkgs.mkShell {
            name     = "passport-pipeline";
            packages = [ agdaFull ghcWithRTS pkgs.graphviz ];
          };
        });
    };
}
