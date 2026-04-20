# Markdown Slide Experiments

Comparative experiment rendering the same content with **Marp**, **Pandoc (PPTX)**, and **Reveal.js** to evaluate which toolchain produces the best output for Google Slides import.

Source material: [`AGENTS.md`](../../AGENTS.md) condensed into a NEARFall project overview.

## Nix

A `flake.nix` provides a dev shell and three separate build targets.

```bash
# Development shell (marp-cli + pandoc on PATH)
nix develop

# Build Marp slides    → result/nearfall-overview.html
nix build .#marp

# Build Pandoc slides  → result/nearfall-overview.pptx
nix build .#pandoc

# Build Reveal slides  → result/nearfall-overview.html + result/revealjs/
nix build .#reveal

# Build all three (symlinked into result/)
nix build
```

> **Note:** The first time you run `nix build .#reveal`, the build will fail
> and print the correct hash for the Reveal.js source. Paste that hash into
> the `revealjs-src` derivation in `flake.nix` to fix it.

## Marp

Source: [`marp/nearfall-overview.md`](marp/nearfall-overview.md)

Slides are delimited by `---`. The YAML front matter sets `marp: true` and
selects a theme. `<!-- _class: lead -->` marks title/closing slides.

```bash
# Install
npm install -g @marp-team/marp-cli

# Render
marp marp/nearfall-overview.md --html    # → marp/nearfall-overview.html
marp marp/nearfall-overview.md --pdf     # → marp/nearfall-overview.pdf  (requires Chromium)
marp marp/nearfall-overview.md --pptx   # → marp/nearfall-overview.pptx (requires Chromium)
```

Import the `.pptx` into Google Slides via *File → Import slides*.

## Pandoc (PPTX)

Source: [`pandoc/nearfall-overview.md`](pandoc/nearfall-overview.md)

`#` headings produce section-divider slides; `##` headings produce content
slides. This mirrors normal document structure and gives less per-slide
control than Marp.

```bash
# Install: https://pandoc.org/installing.html

# Render
pandoc pandoc/nearfall-overview.md -t pptx   -o pandoc/nearfall-overview.pptx
pandoc pandoc/nearfall-overview.md -t beamer -o pandoc/nearfall-overview.pdf   # requires LaTeX
```

Import the `.pptx` into Google Slides via *File → Import slides*.

## Reveal.js

Source: [`reveal/nearfall-overview.md`](reveal/nearfall-overview.md)

Uses pandoc's `revealjs` output format. The source uses the same `#` / `##`
heading convention as the Pandoc PPTX version, plus Reveal.js-specific
features: `. . .` for fragment pauses, `{.fragment}` on list items for
incremental reveals, and `::: notes` blocks for speaker notes.

```bash
# Render against the Reveal.js CDN (requires network access)
pandoc reveal/nearfall-overview.md \
  --standalone \
  -t revealjs \
  --variable revealjs-url=https://cdn.jsdelivr.net/npm/reveal.js@5.1.0 \
  -o reveal/nearfall-overview.html
```

Open the resulting `.html` directly in a browser. There is no native Google
Slides import path for Reveal.js; the PPTX formats above are better suited
for that workflow.

## Alternative Workflows

Beyond the PPTX-import methods above, several "API-native" or modern alternatives offer higher efficiency:

1.  **`md2gslides` (API-Native)**: Uses the Google Slides API to push content directly to a deck. It allows for "Live Updates" to existing slides without losing the document ID, making it the most efficient choice for CI/CD or automated status reports.
2.  **Slidev**: A modern developer-first presentation tool using Vite and Vue. While it still relies on PPTX/PDF for Google Slides integration, it provides superior layout control (Grid/Flexbox) and interactive features (Mermaid diagrams) compared to Marp.
3.  **Google Apps Script**: A custom script can be written to fetch Markdown from a Git repository (via raw URL) and generate/update slides within the Google Workspace environment, bypassing local CLI tools entirely.
