import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The entry chunk must not contain `@dynamic-labs`. This is the test that says
 * so, and it is a test rather than a convention because the convention already
 * failed once.
 *
 * `e1593bb` removed Dynamic from this demo. Its message measured what the
 * mistake had cost: "entry chunk 6,378 kB to 717 kB (gzip 1,709 to 198)",
 * because the SDK had been imported statically from `main.tsx`. Nothing about
 * that was a bad decision at the time — a static import is what you write
 * unless something stops you — which is exactly why bringing the SDK back
 * needs a thing that stops you.
 *
 * WHY IT READS SOURCE RATHER THAN `dist/`
 * ---------------------------------------
 * A test that inspected the built chunk graph would be the more direct
 * measurement and a far worse gate: it would pass vacuously whenever `dist/`
 * were stale or absent, which under `npx vitest run` is most of the time, and
 * it would tie a unit suite to a six-minute build. The property that actually
 * matters is a property of the SOURCE graph — "no module reachable from
 * `main.tsx` through static imports names `@dynamic-labs`" — and Rollup's
 * code-splitting follows exactly that graph. So the graph is what is walked.
 *
 * The chunk sizes themselves are measured against a real build and reported
 * with the change; see `docs/demo/dynamic-integration.md`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '..')
const entry = resolve(sourceRoot, 'main.tsx')

/** Extensions tried, in order, for a specifier written the TypeScript-ESM way. */
const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/**
 * Every STATIC import specifier in a file, split by whether it survives to
 * runtime.
 *
 * `import type` / `export type` are erased by the compiler and cannot put a
 * byte in any chunk, so they are collected separately rather than counted
 * against the rule — a type-only reference to a vendor's types is free.
 * `import('…')` is deliberately not matched at all: that is the escape hatch
 * this whole file exists to force people through.
 */
function staticSpecifiers(source: string): { value: string[]; typeOnly: string[] } {
  const value: string[] = []
  const typeOnly: string[] = []

  /* `import …  from 'x'`, `export … from 'x'`, and bare `import 'x'`. The
     leading (^|\n) keeps it to statements rather than the word "import"
     inside a comment or a string. */
  const pattern = /(?:^|\n)\s*(import|export)(\s+type\b)?([\s\S]*?)from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const isTypeOnly = Boolean(match[2]) || /^\s*\{\s*type\s/.test(match[3] ?? '')
    ;(isTypeOnly ? typeOnly : value).push(match[4])
  }

  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(bare)) value.push(match[1])

  return { value, typeOnly }
}

/** Resolves a relative specifier onto a file in this workspace, or null. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  /* `./x.js` in source is `./x.ts` or `./x.tsx` on disk — the TypeScript ESM
     convention this workspace is written in. */
  const withoutJs = specifier.replace(/\.js$/, '')
  for (const candidate of CANDIDATES) {
    const path = resolve(dirname(fromFile), withoutJs + candidate)
    if (existsSync(path) && !path.endsWith('/')) return path
  }
  return null
}

/** Every module the entry can reach WITHOUT going through an `import()`. */
function staticGraphFrom(root: string): Map<string, { value: string[]; typeOnly: string[] }> {
  const seen = new Map<string, { value: string[]; typeOnly: string[] }>()
  const queue = [root]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    const specifiers = staticSpecifiers(readFileSync(file, 'utf8'))
    seen.set(file, specifiers)

    for (const specifier of specifiers.value) {
      if (specifier.endsWith('.css')) continue
      const resolved = resolveLocal(file, specifier)
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }

  return seen
}

describe('the flag-off bundle', () => {
  const graph = staticGraphFrom(entry)

  it('walks a graph big enough for the result to mean something', () => {
    /* A resolver that silently matched nothing would make every assertion
       below pass. This is the canary for that. */
    expect(graph.size).toBeGreaterThan(20)
    expect([...graph.keys()]).toContain(resolve(sourceRoot, 'App.tsx'))
    expect([...graph.keys()]).toContain(resolve(sourceRoot, 'screens/Home.tsx'))
    expect([...graph.keys()]).toContain(resolve(sourceRoot, 'screens/Onboarding.tsx'))
  })

  it('reaches no module that statically imports @dynamic-labs', () => {
    const offenders: string[] = []
    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers.value) {
        if (specifier.startsWith('@dynamic-labs')) {
          offenders.push(`${relative(sourceRoot, file)} → ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('does reach lib/dynamic.tsx, and that is correct rather than a leak', () => {
    /* Two screens import `useDynamicSession` from it, so of course it is on
       the static graph, and its own bytes — a hook and a mount function — are
       in the entry chunk. That is not what `e1593bb` was about. What must stay
       out is the SDK those few hundred bytes can go and fetch, and the
       assertion above is what holds that: this module may be reachable
       precisely because nothing it imports statically is a vendor. */
    expect([...graph.keys()]).toContain(resolve(sourceRoot, 'lib/dynamic.tsx'))
    const module = graph.get(resolve(sourceRoot, 'lib/dynamic.tsx'))
    expect(module?.value).toEqual(['react', './dynamicSession.js'])
  })

  it('reaches the gate, which the screens read to decide whether to render anything', () => {
    expect([...graph.keys()]).toContain(resolve(sourceRoot, 'lib/dynamicSession.ts'))
  })

  it('keeps the gate itself free of any vendor import', () => {
    const gate = graph.get(resolve(sourceRoot, 'lib/dynamicSession.ts'))
    expect(gate).toBeDefined()
    expect([...(gate?.value ?? []), ...(gate?.typeOnly ?? [])]).toEqual([])
  })
})

describe('the flag-on path', () => {
  const dynamicModule = readFileSync(resolve(sourceRoot, 'lib/dynamic.tsx'), 'utf8')

  it('names the SDK only inside import(), never in a static statement', () => {
    expect(dynamicModule).toContain("import('@dynamic-labs/sdk-react-core')")
    expect(dynamicModule).toContain("import('@dynamic-labs/ethereum')")
    expect(staticSpecifiers(dynamicModule).value.filter((s) => s.startsWith('@dynamic-labs'))).toEqual(
      [],
    )
  })

  it('is itself reached from main.tsx only through an import()', () => {
    const main = readFileSync(entry, 'utf8')
    expect(main).toContain("import('./lib/dynamic.js')")
    expect(staticSpecifiers(main).value).not.toContain('./lib/dynamic.js')
  })

  it('gates on the raw literal, so the bundler can delete the branch entirely', () => {
    /* The regression this holds shut, measured on 2026/09/14: written as
       `if (isDynamicEnabled())`, a flag-off build still EMITTED the SDK —
       118 chunks and 10,169,722 bytes of JavaScript against 44 and 3,219,674.
       A function call is opaque to Rollup, so the `import()` inside the branch
       stayed reachable and every chunk behind it was written to `dist/`.
       Nothing would ever have fetched them; they would just have been
       deployed. Vite substitutes `import.meta.env.VITE_…` with a literal, and
       `if (undefined)` is what makes the branch collapse.

       `isDynamicEnabled()` is still the gate everywhere else. It is only HERE,
       in the one place whose answer has to be known at build time rather than
       at run time, that the variable is read directly. */
    const main = readFileSync(entry, 'utf8')
    const gate = main.indexOf('if (import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID)')
    const load = main.indexOf("import('./lib/dynamic.js')")
    expect(gate).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(gate)
    /* And not through the function, which would put the call back. */
    expect(main).not.toContain('if (isDynamicEnabled())')
  })
})
