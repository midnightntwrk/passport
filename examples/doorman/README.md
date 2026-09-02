# Doorman

A door that is not part of Passport.

Doorman is a small Vite app served on its **own origin** — it is never mounted
inside the Passport shell — and it is the reference integration for
`@midnight-passport/connect`. It does three things, in order:

1. **Detects** whether a Passport is there at all.
2. **Asks who is at the door** — `displayName` and the passport reference —
   which Passport answers only after the visitor has consented.
3. **Asks for one payment** — the entry fee, sent to Doorman's own account —
   which Passport answers from its own consent sheet.

Doorman never sees an approval, never holds anything of the visitor's, and
never learns anything the visitor did not agree to share. Everything it knows,
it was told across the wire protocol.

## Running it

```
npm install                # from the repository root, once
cd examples/doorman && npm run dev
```

Doorman is deliberately **not** a root workspace — the root `package.json`
belongs to the package, not to its examples — so it takes React, Vite, and
TypeScript from the root `node_modules` by ordinary upward resolution rather
than installing its own copies. Its `package.json` lists them so the versions
it was written against are on the record.

It comes up on `http://localhost:5180`, deliberately a different origin from
the Passport shell on `http://localhost:5173`. Point it elsewhere with a
`.env.local`:

```
VITE_PASSPORT_ORIGIN=http://localhost:5173
VITE_DOORMAN_ACCOUNT=…
```

Never point it at a live sponsor.

## How the package is resolved

Doorman imports `@midnight-passport/connect`, and nothing else from this
repository. The name resolves through the **workspace link** at
`node_modules/@midnight-passport/connect`, which points at `packages/connect`.

That package publishes `dist/`, and nothing in this tree builds it — the shared
`dist/` is off limits here — so both TypeScript (`tsconfig.json` `paths`) and
Vite (`vite.config.ts` `resolve.alias`) are pointed at the package's sources
instead. Doorman does not add itself to the root `package.json`; it reads the
link that is already there.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Serves Doorman on `localhost:5180`. |
| `npm run typecheck` | `tsc --noEmit` over `src/`. |

There is no build script. Doorman is a reference, not a deliverable.

## Where to read next

`docs/demo/integrating.md` is the written version of this app: the three entry
points, the three calls, the redirect channel, and the four things Passport
will refuse to do.
