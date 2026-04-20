{
  description = "Markdown slide experiments: Marp, Pandoc, and Reveal.js";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {

      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # Reveal.js distribution fetched from GitHub as a fixed-output
          # derivation so the build is reproducible and sandbox-safe.
          revealjs-src = pkgs.fetchFromGitHub {
            owner = "hakimel";
            repo  = "reveal.js";
            rev   = "5.1.0";
            hash  = "sha256-L6KVBw20K67lHT07Ws+ZC2DwdURahqyuyjAaK0kTgN0=";
          };

          # Marp: produces self-contained HTML (no Chromium required).
          # For PDF/PPTX output, marp requires a Chromium binary; pass
          # --allow-local-files and set CHROME_PATH if you add
          # pkgs.chromium to nativeBuildInputs and want those formats.
          marp = pkgs.runCommand "marp-slides" {
            nativeBuildInputs = [ pkgs.marp-cli ];
          } ''
            mkdir -p $out
            marp ${./marp/nearfall-overview.md} \
              --html \
              --output $out/nearfall-overview.html
          '';

          # Pandoc → PPTX (no extra runtime dependencies).
          # For Beamer PDF, add pkgs.texlive.combined.scheme-medium to
          # nativeBuildInputs and change -t to beamer.
          pandoc = pkgs.runCommand "pandoc-slides" {
            nativeBuildInputs = [ pkgs.pandoc ];
          } ''
            mkdir -p $out
            pandoc ${./pandoc/nearfall-overview.md} \
              --standalone \
              -t pptx \
              -o $out/nearfall-overview.pptx
          '';

          # Reveal.js HTML via Pandoc.  Revealjs is copied into the output
          # directory alongside the HTML so the result is self-contained
          # (no CDN or network access needed at viewing time).
          reveal = pkgs.runCommand "reveal-slides" {
            nativeBuildInputs = [ pkgs.pandoc ];
          } ''
            mkdir -p $out
            cp -r ${revealjs-src} $out/revealjs
            pandoc ${./reveal/nearfall-overview.md} \
              --standalone \
              -t revealjs \
              --variable revealjs-url=revealjs \
              -o $out/nearfall-overview.html
          '';

        in {
          inherit marp pandoc reveal;
          default = pkgs.symlinkJoin {
            name = "md-slides";
            paths = [ marp pandoc reveal ];
          };
        });

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.marp-cli
              pkgs.pandoc
            ];
            shellHook = ''
              echo "marp-cli : $(marp --version)"
              echo "pandoc   : $(pandoc --version | head -1)"
              echo ""
              echo "Reveal.js rendering (requires network):"
              echo "  pandoc reveal/nearfall-overview.md --standalone -t revealjs \\"
              echo "    --variable revealjs-url=https://cdn.jsdelivr.net/npm/reveal.js@5.1.0 \\"
              echo "    -o nearfall-reveal.html"
            '';
          };
        });

    };
}
