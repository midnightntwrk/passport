{
  description = "Development environment for MidnightOS / NEAR Evaluation with Gemini CLI (Sandboxed)";

  inputs = {
    nixpkgs.url = "github:Nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
          };
        };

        mn-tui = pkgs.buildNpmPackage {
          pname    = "mn-tui";
          version  = "0.1.0";
          src      = ./experiments/mn-tui;

          # Recompute with: nix run nixpkgs#prefetch-npm-deps -- experiments/mn-tui/package-lock.json
          npmDepsHash = "sha256-njYjBIRzA/6E7luQArKpswHVPmu1wHUUs0PK/bnNG6M=";

          # The lock file has an unresolvable smoldot peer-dep conflict inherited
          # from @substrate/connect (a transitive dep of the Midnight SDK).
          # --legacy-peer-deps suppresses the ERESOLVE error without changing
          # which packages are actually installed.
          npmFlags = [ "--legacy-peer-deps" ];

          nativeBuildInputs = [ pkgs.makeWrapper ];

          # No tsc build step: we run the TypeScript source directly via tsx
          # (same as `npm start`).  tsc with moduleResolution=Bundler does not
          # emit `with { type: "json" }` import attributes, which Node 22+ requires
          # for JSON imports in ESM; tsx's loader handles them transparently.
          dontNpmBuild = true;

          # Install layout:
          #   $out/lib/mn-tui/src/          TypeScript source (tsx entry: src/index.tsx)
          #   $out/lib/mn-tui/contracts/    built-in fungible-token contract (import.meta.url-relative)
          #   $out/lib/mn-tui/node_modules/ runtime + tsx from devDependencies
          #   $out/lib/mn-tui/package.json  needed by Node ESM resolution
          #   $out/lib/mn-tui/tsconfig.json needed by tsx
          #   $out/bin/mn-tui               wrapper → tsx src/index.tsx
          installPhase = ''
            runHook preInstall

            local libdir="$out/lib/mn-tui"
            mkdir -p "$libdir"
            cp -r src          "$libdir/"
            cp -r contracts    "$libdir/"
            cp -r node_modules "$libdir/"
            cp    package.json "$libdir/"
            cp    tsconfig.json "$libdir/"

            mkdir -p "$out/bin"
            makeWrapper "$libdir/node_modules/.bin/tsx" "$out/bin/mn-tui" \
              --add-flags "$libdir/src/index.tsx"

            runHook postInstall
          '';
        };

      in
      {
        packages.mn-tui  = mn-tui;
        packages.default = mn-tui;

        apps.mn-tui  = flake-utils.lib.mkApp { drv = mn-tui; };
        apps.default = flake-utils.lib.mkApp { drv = mn-tui; };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            altair
            binaryen
            bubblewrap
          # calibre
            cargo
            claude-code
            gh
            mdbook
            mdbook-epub
            nodejs_24
            pandoc
            python3
            rustup
            vscode
            wabt
          ];

          shellHook = ''
            # Local npm prefix to avoid sudo
            export NPM_CONFIG_PREFIX="$PWD/.npm-global"
            export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

            # Check if gemini-cli is installed
            if ! command -v gemini &> /dev/null; then
              echo "Installing Gemini CLI into local prefix..."
              npm install -g @google/gemini-cli
            fi

            echo "🚀 Sandboxed Environment Active"
            echo "Use './gemini-sandbox.sh' to run Gemini with restricted filesystem access."
          '';
        };
      }
    );
}
