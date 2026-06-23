#!/usr/bin/env julia
# render.jl — render a passport wiring diagram from JSON to SVG (or DOT).
#
# Usage:
#   julia render.jl <input.json> [output.svg]
#   julia render.jl <input.json> [output.dot] --dot
#
# If the output path is omitted the SVG is written to stdout.
# Pass --dot to emit Graphviz DOT source instead of SVG.
#
# Run `julia -e 'import Pkg; Pkg.instantiate()'` once inside formal-spec/render/
# to fetch Catlab, Graphviz_jll, and JSON from the General registry.

using Catlab
using Catlab.WiringDiagrams
using Catlab.Graphics
using Catlab.Graphics.Graphviz: run_graphviz, pprint
using JSON

# ── JSON interchange schema ───────────────────────────────────────────────────
#
# {
#   "inputs":  ["ChannelName", ...],   -- outer input port names
#   "outputs": ["ChannelName", ...],   -- outer output port names
#   "boxes": [
#     { "id": 1, "name": "ComponentName",
#       "inputs": ["ChannelName", ...],
#       "outputs": ["ChannelName", ...] }
#   ],
#   "wires": [
#     { "fromBox": 0,  "fromPort": 0, "toBox": 1,  "toPort": 0 },
#     { "fromBox": 1,  "fromPort": 0, "toBox": -1, "toPort": 0 }
#     -- fromBox 0  = outer input boundary
#     -- toBox  -1  = outer output boundary
#     -- ports are 0-indexed
#   ]
# }

# ── Build a WiringDiagram from the parsed JSON dict ───────────────────────────
function build_diagram(spec::Dict)::WiringDiagram
    d = WiringDiagram(
        spec["inputs"]::Vector,
        spec["outputs"]::Vector,
    )

    # Map from JSON box id → Catlab vertex id.
    # JSON box 0  → input_id(d)   (outer input boundary)
    # JSON box -1 → output_id(d)  (outer output boundary)
    id_map = Dict{Int,Int}(
        0  => input_id(d),
        -1 => output_id(d),
    )

    for box_spec in spec["boxes"]
        v = add_box!(d, Box(
            box_spec["name"]::String,
            box_spec["inputs"]::Vector,
            box_spec["outputs"]::Vector,
        ))
        id_map[box_spec["id"]::Int] = v
    end

    for wire_spec in spec["wires"]
        src_box  = id_map[wire_spec["fromBox"]::Int]
        src_port = wire_spec["fromPort"]::Int + 1   # JSON 0-indexed → Julia 1-indexed
        tgt_box  = id_map[wire_spec["toBox"]::Int]
        tgt_port = wire_spec["toPort"]::Int + 1

        add_wire!(d, Wire(
            Port(src_box, OutputPort, src_port),
            Port(tgt_box, InputPort,  tgt_port),
        ))
    end

    return d
end

# ── Entry point ───────────────────────────────────────────────────────────────
function main(args::Vector{String})
    if isempty(args)
        println(stderr, "Usage: julia render.jl <input.json> [output.svg] [--dot]")
        exit(1)
    end

    input_path  = args[1]
    want_dot    = "--dot" in args
    out_path    = let candidates = filter(a -> a != "--dot" && a != input_path, args)
        isempty(candidates) ? nothing : candidates[1]
    end

    spec = open(JSON.parse, input_path)
    d    = build_diagram(spec)
    g    = to_graphviz(d; orientation=LeftToRight, labels=true)

    if want_dot
        if out_path === nothing
            pprint(stdout, g)
        else
            open(out_path, "w") do io; pprint(io, g) end
            println(stderr, "Wrote DOT to: ", out_path)
        end
    else
        if out_path === nothing
            run_graphviz(stdout, g; format="svg")
        else
            open(out_path, "w") do io; run_graphviz(io, g; format="svg") end
            println(stderr, "Wrote SVG to: ", out_path)
        end
    end
end

main(ARGS)
