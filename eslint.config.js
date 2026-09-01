// The workspace lint rules.
//
// WHY THIS EXISTS
// ---------------
// Until this file there was no linter in the repository at all: no config, no
// `lint` script, no CI step. The audit called that the cheapest structural fix
// available, because the failures it found are the failures a linter reports
// for free — a promise dropped on the floor in a signing path reads exactly
// like a promise that was awaited, and nothing but a type-aware rule tells the
// two apart.
//
// It is deliberately small. Every rule below is either in
// `recommended-type-checked` or was named for a specific defect class that has
// already cost this repository time. Nothing here is stylistic: formatting,
// import order, and British-English spelling are house conventions and are not
// enforced by a machine.
//
// TWO TIERS, BECAUSE THE TSCONFIGS DECIDE
// ---------------------------------------
// `recommended-type-checked` needs a TypeScript program, so it can only apply
// to files some tsconfig actually includes. Most of them are: every workspace
// includes `src`. A handful are not — the `vite.config.ts` files (each app's
// tsconfig deliberately omits its own bundler config), and the `test`
// directories of `demo-backend` and `packages/connect`, whose tsconfigs include
// `src` alone so that the emitted `dist` stays free of test files.
//
// Those get the syntax-only tier instead of being dropped: a rule that does not
// need types still runs on them. The alternative — widening the tsconfigs so
// the parser can see them — changes what `tsc` builds, and this change is not
// allowed to touch a build.
//
// WHAT IS NOT LINTED
// ------------------
// Generated code, vendored code, and upstream subtrees. A compiled Compact
// contract module is machine output that happens to have a `.ts` extension;
// reporting on it says nothing about anyone's work and would guarantee the
// count never reaches zero.
//
// NOT WIRED INTO CI YET
// ---------------------
// On purpose. `.github/workflows/verify-demo.yml` is untouched. A gate that
// goes red on day one blocks work that has nothing to do with linting, so the
// order is: land the config, drive the count to zero, then add the step. See
// the `lint` script in the root `package.json`.

import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Machine output, vendored copies, and trees maintained somewhere else.
 */
const NOT_OURS = [
  // Build output.
  '**/node_modules/**',
  '**/dist/**',
  '**/.vercel/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  'examples/passport-demo/.generated/**',
  'examples/passport-demo/public/zk/**',

  // Compiled Compact contracts. `contracts/` under any workspace is staged by
  // a script from a contract build (see `prepare-zk-assets.mjs`), and
  // `managed/` is the compiler's own output directory.
  '**/contracts/**',
  '**/contracts-stagenet/**',
  '**/managed/**',

  // Ad-hoc scripts run by hand against a live network. Not part of any build,
  // not covered by a tsconfig, and paired with a committed `.mjs` transpile.
  '**/.live-drill/**',

  // Vendored preview of a third-party SDK.
  '**/.cache/**',

  // THE EXPERIMENTS ARE OUT OF SCOPE, AND THIS IS THE ONE JUDGEMENT CALL IN
  // THIS FILE. Measured on the first full run, 2026/09/01: 2387 of the 3279
  // findings in the tree — 73% — came from `experiments/`, and 78% of those
  // were `no-unsafe-*` or `no-explicit-any`. They are not real. Four of the
  // five spikes have no `node_modules` installed, so every import resolves to
  // `any` and the type-aware rules report on types that were never computed.
  // `nearfall-evaluation` is a git subtree maintained upstream at
  // github.com/input-output-hk/arc-nearfall-evaluation and is not ours to fix
  // at all.
  //
  // A linter that can never go green is a linter that gets switched off, and
  // the point of this file is a gate that eventually goes into CI. Deleting
  // this one line brings the spikes back if that is ever wanted — install
  // their dependencies first, or the number it prints is fiction.
  'experiments/**',
];

/**
 * The files no tsconfig includes, and which therefore cannot be type-checked.
 * Kept as one list so that the reason for each is visible in one place; see
 * the header for why widening the tsconfigs was not the answer.
 */
const OUTSIDE_A_TSCONFIG = [
  // Every app's tsconfig includes `src` (and, for the demo, `e2e` plus its two
  // test-runner configs) but not the Vite config that builds it. The second
  // pattern catches the alternate builds — `vite.graph.config.ts` and any
  // sibling — without catching `vitest.config.ts`, which the demo's tsconfig
  // does include.
  '**/vite.config.ts',
  '**/vite.*.config.ts',
  'packages/connect/vitest.config.ts',

  // `demo-backend` and `packages/connect` both compile to a published `dist`,
  // so their tsconfigs include `src` alone and their tests sit outside it.
  'demo-backend/test/**',
  'packages/connect/test/**',
];

export default tseslint.config(
  { ignores: NOT_OURS },

  // ---------------------------------------------------------------------------
  // Tier 1: every TypeScript file, whether or not a tsconfig can see it.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommended],
  },

  // ---------------------------------------------------------------------------
  // Tier 2: the files a tsconfig includes get the type-aware rules as well.
  // `projectService` resolves each file against the nearest tsconfig, which is
  // what makes one root config work across seventeen of them.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    ignores: OUTSIDE_A_TSCONFIG,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in a signing or balancing path is a transaction that
      // silently did not happen, and an `await` that was never written looks
      // identical to one that was. This is the single most valuable rule here
      // and the reason the type-aware tier exists at all. It lives in this
      // block rather than the next one because it needs the program: asked for
      // on a file no tsconfig includes, it fails the whole run.
      //
      // `node:test`'s `describe` and `it` return a promise that the runner
      // itself awaits, and `examples/passport-balancer` is built on them —
      // without this allowance the rule reported 51 test declarations and
      // exactly one real defect, which is the ratio at which people stop
      // reading the output. Vitest needs no equivalent: its `it` returns void.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it'] },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // The rest of the rules that were asked for by name. None of these need a
  // program, so they run on every TypeScript file in the tree.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // `_`-prefixed bindings are the agreed way to say "required by the
      // signature, deliberately unused" — destructured rest siblings included,
      // which is how a field gets dropped from an object without a helper.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // Hooks called conditionally are a correctness bug, not a style one, and
      // a stale dependency array is how a screen ends up rendering a wallet
      // balance from before the last transaction. Applied to `.ts` as well as
      // `.tsx` because custom hooks live in plain modules; the rules only fire
      // on hook-shaped code, so this costs nothing elsewhere.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // The audit found zero `console.log` in the tree. This is what keeps it
      // that way. A warning, not an error, because the honest fix is sometimes
      // a real logger rather than deleting the line.
      'no-console': 'warn',

      // `==` against a Midnight address, a bigint balance, or a nullable
      // config value is a coercion nobody intended. `null` is exempt: `x ==
      // null` is the idiomatic "null or undefined" test.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
