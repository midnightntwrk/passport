#!/usr/bin/env julia
# render.jl — render passport wiring diagrams from generated Julia source to SVG (or DOT).
#
# Usage:
#   julia render.jl <input.jl> [output_dir]          # render every diagram
#   julia render.jl <input.jl> [output_dir] --dot    # emit DOT instead of SVG
#
# <input.jl> is produced by the Agda compiler (./passport-compiler). It binds
# a `DIAGRAMS` vector of `"name" => WiringDiagram` pairs by reconstructing each
# diagram through Catlab's symmetric-monoidal combinators (compose/otimes/id).
# Each diagram is written to <output_dir>/<name>.svg (or .dot), defaulting to
# the current directory when no output arg is given.
#
# Run `julia -e 'import Pkg; Pkg.instantiate()'` once inside formal-spec/render/
# to fetch Catlab and Graphviz_jll from the General registry. Graphviz_jll
# bundles the `dot` binary, so no system Graphviz install is required.

using Catlab
using Catlab.WiringDiagrams
using Catlab.Theories
using Catlab.Graphics
using Catlab.Graphics.Graphviz: run_graphviz, pprint, Graph, Node
# Loading Graphviz_jll activates Catlab's CatlabGraphvizExt, so run_graphviz
# uses the bundled `dot` binary — no system Graphviz install or PATH needed.
using Graphviz_jll

# ── Generated source is evaluated in its own module ──────────────────────────
# Base.include(mod, path) runs the file's `using`/`gen`/`DIAGRAMS` bindings
# inside `Generated`, keeping them out of Main.
module Generated end

# ── Fix rounded style after to_graphviz ──────────────────────────────────────
# to_graphviz's cell_attrs removes the inner TD border, but graphviz_box
# hardcodes style="solid" per node, overriding the global node_attrs default.
# There is no public API parameter to change this; post-process here.
function set_rounded_style!(g::Graph)
    for stmt in g.stmts
        if stmt isa Node
            stmt.attrs[:style] = "rounded,filled"
        end
    end
    return g
end

# Catlab defaults to the "Serif" font, for which Graphviz has no built-in
# metrics; without a working pango plugin it warns and falls back to Times.
# Pin Times-Roman directly (graph, node, and edge) — a font Graphviz has
# metrics for — so layout is deterministic and the warnings disappear.
const FONT = "Times-Roman"

# ── Render a single WiringDiagram ─────────────────────────────────────────────
function render_one(d, want_dot::Bool, out_path::Union{String,Nothing})
    g = to_graphviz(d;
        orientation = BottomToTop,
        labels      = true,
        graph_attrs = Dict(:fontname => FONT),
        node_attrs  = Dict(:shape => "rectangle", :fontcolor => "black",
                           :fillcolor => "white", :fontname => FONT),
        edge_attrs  = Dict(:fontname => FONT),
        cell_attrs  = Dict(:border => "0"),
    )
    set_rounded_style!(g)

    if want_dot
        if out_path === nothing
            pprint(stdout, g)
        else
            open(out_path, "w") do io; pprint(io, g) end
            println(stderr, "Wrote DOT to: ", out_path)
        end
    else
        # Catlab runs the bundled `dot` as a bare path, so the subprocess does
        # not inherit Graphviz_jll's library path and fails to load its shared
        # libs (libexpat, pango, …). Prepend LIBPATH on the platform's dynamic
        # loader variable so they resolve.
        var = Sys.iswindows() ? "PATH" :
              Sys.isapple()   ? "DYLD_FALLBACK_LIBRARY_PATH" :
                                "LD_LIBRARY_PATH"
        sep = Sys.iswindows() ? ";" : ":"
        withenv(var => string(Graphviz_jll.LIBPATH[], sep, get(ENV, var, ""))) do
            if out_path === nothing
                run_graphviz(stdout, g; format="svg")
            else
                open(out_path, "w") do io; run_graphviz(io, g; format="svg") end
                println(stderr, "Wrote SVG to: ", out_path)
            end
        end
    end
end

# ── Entry point ───────────────────────────────────────────────────────────────
# These run as separate top-level statements (not wrapped in a function) so the
# world age advances between Base.include — which creates Generated.DIAGRAMS —
# and the loop that reads it.
if isempty(ARGS)
    println(stderr, "Usage: julia render.jl <input.jl> [output_dir] [--dot]")
    exit(1)
end

const INPUT_PATH = ARGS[1]
const WANT_DOT   = "--dot" in ARGS
const OUT_DIR    = let candidates = filter(a -> a != "--dot" && a != INPUT_PATH, ARGS)
    isempty(candidates) ? "." : candidates[1]
end

# Evaluate the generated source; it binds `Generated.DIAGRAMS`.
Base.include(Generated, abspath(INPUT_PATH))

# Separate top-level statement: world age has advanced past the include above.
mkpath(OUT_DIR)
for (name, d) in Generated.DIAGRAMS
    render_one(d, WANT_DOT, joinpath(OUT_DIR, name * (WANT_DOT ? ".dot" : ".svg")))
end
