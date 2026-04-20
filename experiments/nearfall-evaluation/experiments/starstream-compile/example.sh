#!/usr/bin/env bash

set -veo pipefail

STARSTREAM=../../../Starstream/target/debug/starstream

$STARSTREAM wasm -c example.star -o example.wasm

wasm-dis example.wasm > example.txt

wasm2wat example.wasm > example.wat

ls -lhrt
