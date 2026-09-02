/**
 * The first-paint guard: what may be STATICALLY imported on the path to
 * `createRoot`, and what may not.
 *
 * THE DEFECT THIS EXISTS TO STOP RECURRING (2026/09/01)
 * ----------------------------------------------------
 * `@midnightntwrk/ledger-v9` initialises by TOP-LEVEL AWAITING a 9.84 MB WASM
 * binary. Any module that reaches it through a static `import` puts that fetch
 * and that instantiation in front of React's mount: the browser cannot evaluate
 * the entry chunk until the ledger is live, so nothing is on screen until it is.
 *
 * On 2026/09/01 two screens on the first render path — `screens/AliasClaim.tsx`
 * and `screens/AliasReclaimModal.tsx` — imported a handful of pure string
 * functions from `identity/midnames.ts`, which statically imports
 * `identity/contractRuntime.ts`, which statically imports the ledger. Measured
 * against a production build over loopback: 10.07 MB transferred before the
 * onboarding screen's "Continue with Passport" button existed. Cutting that one
 * chain to a leaf (`identity/midnamesText.ts`) costs nothing and is invisible —
 * which is exactly why it needs a test rather than a comment.
 *
 * WHAT THIS CHECKS
 * ----------------
 * It walks the same graph the bundler walks: from `src/main.tsx`, over STATIC
 * value imports only, following relative specifiers. `import type` and
 * all-`type` clauses are erased by the build and are erased here too. A
 * `import()` is a chunk boundary and is deliberately NOT followed — deferring
 * to the moment of use is the fix, not the fault.
 *
 * Anything that graph reaches is then held to two rules:
 *
 *   1. no app module in {@link LEDGER_BEARING} may be statically imported —
 *      those are the modules that own a chain client, and every one of them
 *      already has a dynamic-import call site in `App.tsx`;
 *   2. no Midnight package may be statically imported unless it is in
 *      {@link DECLARED_MIDNIGHT_IMPORTS}, which is an explicit list with a
 *      reason per entry rather than a pattern.
 *
 * A failure names the offending edge and the trail that reached it, because
 * "the bundle got bigger" is not a diagnosis anybody can act on.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'src', 'main.tsx');

/**
 * App modules that reach a chain client, and therefore the ledger WASM, and
 * therefore must never be on the static path to `createRoot`. Every one of them
 * is reached today through `await import(…)` at the point of use.
 */
const LEDGER_BEARING = [
  'src/identity/accountCustody.ts',
  'src/identity/contractRuntime.ts',
  'src/identity/midnames.ts',
  'src/identity/passportContract.ts',
  'src/identity/sponsoredAlias.ts',
  'src/lib/localWallet.ts',
  'src/lib/wasmProver.ts',
];

/**
 * The Midnight packages the first render path is allowed to pull in, each with
 * the reason it is not a defect. Everything else under `@midnight-ntwrk/` and
 * `@midnightntwrk/` fails.
 *
 * `@midnight-ntwrk/wallet-sdk/address-format` is a KNOWN AND UNRESOLVED cost,
 * recorded here rather than quietly tolerated. The wallet SDK's own copy of
 * `wallet-sdk-address-format` statically imports `@midnightntwrk/ledger-v9` for
 * one class (`EncryptionSecretKey`, used by a codec neither call site touches),
 * so importing the bech32m address codec drags the whole ledger in. It is
 * reached twice — `lib/txApproval.ts` (through `txConsent.tsx`) and
 * `screens/SendSheet.tsx` (through `screens/Home.tsx`) — and both call sites are
 * SYNCHRONOUS validators, one of them inside a `useMemo`, so it cannot be
 * deferred without changing when a person sees a verdict about what they typed.
 *
 * Measured on 2026/09/01, on a production build over loopback: with this edge
 * present, first paint costs 10.07 MB and the ledger WASM sits in the entry
 * chunk; with it stubbed out, 0.19 MB, no WASM fetched at all, and the entry
 * chunk falls from 786 kB to 585 kB. Cutting it is worth roughly 9.9 MB and
 * needs a decision about the Send sheet's recipient validation, or an upstream
 * fix to the SDK — not a bundler setting.
 */
const DECLARED_MIDNIGHT_IMPORTS = ['@midnight-ntwrk/wallet-sdk/address-format'];

interface Edge {
  readonly from: string;
  readonly line: number;
  readonly spec: string;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    ...(base.endsWith('.js') ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []),
    ...(base.endsWith('.jsx') ? [base.replace(/\.jsx$/, '.tsx')] : []),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one. CSS and asset imports fall through and are ignored.
    }
  }
  return null;
}

/**
 * Static import edges out of one file, with the type-only ones dropped — both
 * `import type { … }` and a clause whose every binding is `type X`, which the
 * build erases just the same. Comments are blanked rather than deleted so the
 * reported line numbers are the real ones.
 */
function staticEdges(file: string): Edge[] {
  const raw = readFileSync(file, 'utf8');
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, '$1');
  const from = path.relative(ROOT, file);
  const edges: Edge[] = [];
  const lineOf = (index: number) => source.slice(0, index + 1).split('\n').length;

  const withClause =
    /(?:^|\n)[ \t]*(?:import|export)[ \t]+((?:type[ \t]+)?)([\s\S]*?)?from[ \t]*['"]([^'"]+)['"]/g;
  for (let m = withClause.exec(source); m; m = withClause.exec(source)) {
    const [, typeKeyword, clause = '', spec] = m;
    if (typeKeyword.trim() === 'type') continue;
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      const bindings = named[1]
        .split(',')
        .map((binding) => binding.trim())
        .filter(Boolean);
      const beforeBrace = clause.slice(0, clause.indexOf('{')).replace(/,\s*$/, '').trim();
      if (!beforeBrace && bindings.length > 0 && bindings.every((b) => /^type[\s]/.test(b))) {
        continue;
      }
    }
    edges.push({ from, line: lineOf(m.index), spec });
  }

  const sideEffectOnly = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g;
  for (let m = sideEffectOnly.exec(source); m; m = sideEffectOnly.exec(source)) {
    edges.push({ from, line: lineOf(m.index), spec: m[1] });
  }
  return edges;
}

/** Every static edge reachable from the entry, with the trail that reached it. */
function walkEntryGraph(): { edges: Edge[]; trailTo: Map<string, string[]> } {
  const edges: Edge[] = [];
  const trailTo = new Map<string, string[]>([[ENTRY, [path.relative(ROOT, ENTRY)]]]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const trail = trailTo.get(file) as string[];
    for (const edge of staticEdges(file)) {
      edges.push(edge);
      const next = resolveRelative(file, edge.spec);
      if (!next || trailTo.has(next)) continue;
      trailTo.set(next, [...trail, `${edge.from}:${edge.line} → ${edge.spec}`]);
      queue.push(next);
    }
  }
  return { edges, trailTo };
}

const { edges, trailTo } = walkEntryGraph();
const reached = new Set([...trailTo.keys()].map((file) => path.relative(ROOT, file)));

/** `src/screens/X.tsx:12 → ../identity/midnames.js`, plus how it was reached. */
function describeEdge(edge: Edge): string {
  const trail = trailTo.get(path.join(ROOT, edge.from)) ?? [];
  return `${edge.from}:${edge.line} → ${edge.spec}\n    reached by: ${trail.join('\n                ')}`;
}

describe('the static path to createRoot', () => {
  it('reaches no module that carries a chain client', () => {
    const offending = edges.filter((edge) => {
      const target = resolveRelative(path.join(ROOT, edge.from), edge.spec);
      if (!target) return false;
      return LEDGER_BEARING.includes(path.relative(ROOT, target));
    });
    expect(
      offending.map(describeEdge),
      'A module on the first render path statically imports a chain client, so the ' +
        "9.84 MB ledger WASM is fetched and instantiated before React mounts. Import what's " +
        'needed from a leaf (see src/identity/midnamesText.ts), or defer the module with ' +
        'await import(…) at the point of use, the way App.tsx already does.',
    ).toEqual([]);
  });

  it('imports no Midnight package that has not been declared', () => {
    const offending = edges.filter(
      (edge) =>
        /^@midnight-?ntwrk\//.test(edge.spec) && !DECLARED_MIDNIGHT_IMPORTS.includes(edge.spec),
    );
    expect(
      offending.map(describeEdge),
      'A Midnight package is being statically imported on the first render path. Every ' +
        'one of them carries, or transitively pulls, a WASM runtime that is initialised with ' +
        "a top-level await — which holds React's mount behind it. Defer it, or add it to " +
        'DECLARED_MIDNIGHT_IMPORTS with the reason and the measured cost.',
    ).toEqual([]);
  });

  it('keeps the two name screens on the naming-rules leaf', () => {
    /* The 2026/09/01 regression, named directly: these are the files that had
       it, and a re-import would otherwise only show up as a slow first paint
       nobody attributes to a one-line import. */
    expect(reached).toContain('src/identity/midnamesText.ts');
    for (const screen of ['src/screens/AliasClaim.tsx', 'src/screens/AliasReclaimModal.tsx']) {
      expect(reached, `${screen} should still be on the first render path`).toContain(screen);
      const toMidnames = staticEdges(path.join(ROOT, screen)).filter((edge) =>
        edge.spec.endsWith('/midnames.js'),
      );
      expect(toMidnames.map(describeEdge)).toEqual([]);
    }
  });

  it('walked a graph rather than nothing at all', () => {
    /* Cheap insurance: a resolver that silently stopped resolving would make
       every assertion above pass by finding no edges to judge. */
    expect(reached.size).toBeGreaterThan(50);
    expect(reached).toContain('src/App.tsx');
    expect(reached).toContain('src/screens/Onboarding.tsx');
  });
});
