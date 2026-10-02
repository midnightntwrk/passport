{
  description = "Midnight Passport — string-diagram renderer (Catlab.jl)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems      = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # ── nix develop ─────────────────────────────────────────────────────────
      # Drops into a Julia shell with JULIA_PROJECT pointed at this directory.
      # Run `julia -e 'import Pkg; Pkg.instantiate()'` once on first use.
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in
        {
          default = pkgs.mkShell {
            name     = "passport-renderer";
            packages = [ pkgs.julia pkgs.graphviz ];
            shellHook = ''
              export JULIA_PROJECT="${self}"
              if [ ! -f "$JULIA_PROJECT/Manifest.toml" ]; then
                echo "First use: run 'julia -e \"import Pkg; Pkg.instantiate()\"' to fetch packages."
              fi
            '';
          };
        });

      # ── nix run ─────────────────────────────────────────────────────────────
      # Runs the renderer directly:
      #
      #   nix run formal-spec/render -- input.jl [output_dir] [--dot]
      #
      # input.jl is the generated Julia source from ./passport-compiler.
      # Julia packages (including Graphviz_jll, which bundles `dot`) are fetched
      # into ~/.julia on first run (needs network). Subsequent runs are instant
      # since the depot is cached.
      apps = forAllSystems (system:
        let
          pkgs     = nixpkgs.legacyPackages.${system};
          julia    = pkgs.julia;
          graphviz = pkgs.graphviz;
          script = pkgs.writeShellScript "passport-render" ''
            # Julia tries to write-lock Manifest.toml on every run, so we
            # copy the project spec to a writable temp directory.
            JULIA_DIR=$(mktemp -d)
            trap 'rm -rf "$JULIA_DIR"' EXIT
            cp "${self}/Project.toml" "$JULIA_DIR/"
            cp "${self}/Manifest.toml" "$JULIA_DIR/"
            export JULIA_PROJECT="$JULIA_DIR"
            export PATH="${graphviz}/bin:$PATH"

            # Fetch packages into ~/.julia on first use (idempotent).
            ${julia}/bin/julia --startup-file=no \
              -e 'import Pkg; Pkg.instantiate()'

            exec ${julia}/bin/julia --startup-file=no \
              "${self}/render.jl" "$@"
          '';
        in
        {
          default = { type = "app"; program = "${script}"; };
        });
    };
}
