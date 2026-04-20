/**
 * Patch compiled Compact contracts to fix JubjubPoint equality comparison.
 *
 * compact-runtime 0.15.0 compiles Compact `==` on JubjubPoint to JavaScript
 * `===`, which compares object references, not values. Two JubjubPoint objects
 * with identical (x, y) coordinates will never be `===`.
 *
 * This script replaces `A === B` with `((a,b)=>a.x===b.x&&a.y===b.y)(A, B)`
 * in the assert expression for Schnorr verification.
 *
 * Usage: node scripts/patch-point-eq.js <path-to-contract-index.js>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/patch-point-eq.js <path>');
  process.exit(1);
}

let src = readFileSync(file, 'utf-8');

const pattern = /(__compactRuntime\.assert\()(this\._ecMulGenerator_0\([^)]+\))\s*===\s*(this\._ecAdd_0\([\s\S]*?c_0\)\)),\s*('invalid signature[^']*')/g;

const patched = src.replace(
  pattern,
  '$1((a,b)=>a.x===b.x&&a.y===b.y)($2, $3), $4'
);

if (patched === src) {
  console.log(`${file}: no JubjubPoint === found (already patched or not applicable)`);
} else {
  writeFileSync(file, patched);
  console.log(`${file}: patched JubjubPoint === to structural equality`);
}
