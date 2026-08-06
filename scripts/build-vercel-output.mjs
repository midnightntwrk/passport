/**
 * Assembles a Vercel Build Output API v3 directory for one of the demo apps,
 * from a `dist/` that was produced LOCALLY.
 *
 * WHY THIS EXISTS — the demos cannot be built on a Vercel builder
 * ---------------------------------------------------------------
 * Verified on 2026/08/05 in a clean `git worktree` + `npm ci` of this branch:
 * `tsc --noEmit` and `vite build` both fail outright, because five generated
 * Compact contract modules are gitignored and absent from a fresh checkout —
 *
 *   examples/passport-demo/.generated/passport-c1/contract/index.js
 *   experiments/account-custody-prototype/contracts/managed/account/…
 *   experiments/account-custody-prototype/contracts/managed/faucet/…
 *   experiments/account-custody-prototype/contracts/managed/identity_registry/…
 *   experiments/account-custody-prototype/contracts/managed/midnames/…
 *
 * Producing them needs the `compact` compiler, which does not exist on a
 * Vercel builder. The Midnames one cannot be produced there at any price: its
 * `.compact` source is not in this repository at all — it is fetched from a
 * pinned upstream revision by the prototype's `npm run midnames:prepare`.
 * The proving keys under `public/zk/**` have the same provenance, and the SRS
 * slices under `public/zk-params/**` are ~45 MB of upstream binaries.
 *
 * So the honest shape is: build where the artefacts already are (here), and
 * upload the finished output with `vercel deploy --prebuilt`. Nothing is
 * recompiled in the cloud and no generated artefact is committed.
 *
 * WHAT IT DOES
 * ------------
 *   node scripts/build-vercel-output.mjs <app-directory>
 *
 * Use `npm run deploy:passport` / `npm run deploy:raffle` from the repository
 * root, which build with the right VITE_* values, call this, and upload. Each
 * app directory must be linked to its Vercel project once, first:
 *
 *   cd examples/passport-demo && vercel link --scope utkarsh232s-projects \
 *     --project midnight-passport-app --yes
 *   cd examples/raffle-demo   && vercel link --scope utkarsh232s-projects \
 *     --project midnight-raffle-demo --yes
 *
 * `vercel link` appends a VERCEL_OIDC_TOKEN to the app's `.env.local` and
 * writes an `examples/<app>/.gitignore`. Delete both afterwards — the token is
 * a credential nothing here needs, and `.vercel/` is already ignored at the
 * repository root.
 *
 * 1. Copies `<app>/dist` to `<app>/.vercel/output/static`, minus any path
 *    listed in the optional `<app>/.vercel-output-exclude` (one dist-relative
 *    path per line, `#` comments). It exists so the Passport demo can drop the
 *    ~64 MB of local-devnet proving keys no public visitor can ever use. It is
 *    a separate file because Vercel's vercel.json schema rejects unknown keys.
 * 2. Translates `<app>/vercel.json` into `<app>/.vercel/output/config.json`:
 *    `headers[]` become `continue: true` routes, then the filesystem handler,
 *    then `rewrites[]`. That is Vercel's own ordering — redirects, filesystem,
 *    rewrites — so the committed `vercel.json` stays the single description of
 *    the routing, readable by anyone who has never run this script.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appArgument = process.argv[2];

if (!appArgument) {
  console.error('usage: node scripts/build-vercel-output.mjs <app-directory>');
  process.exit(1);
}

const appDirectory = resolve(repositoryRoot, appArgument);
const distDirectory = join(appDirectory, 'dist');
const vercelConfigPath = join(appDirectory, 'vercel.json');
const outputDirectory = join(appDirectory, '.vercel', 'output');
const staticDirectory = join(outputDirectory, 'static');

if (!existsSync(distDirectory)) {
  console.error(
    `build-vercel-output: ${relative(repositoryRoot, distDirectory)} is missing.\n` +
      '  Build the app first — this script never builds, it only packages.',
  );
  process.exit(1);
}

if (!existsSync(vercelConfigPath)) {
  console.error(`build-vercel-output: ${relative(repositoryRoot, vercelConfigPath)} is missing.`);
  process.exit(1);
}

const vercelConfig = JSON.parse(readFileSync(vercelConfigPath, 'utf8'));
const excludePath = join(appDirectory, '.vercel-output-exclude');
const excluded = (existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((entry) => resolve(distDirectory, entry));

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

cpSync(distDirectory, staticDirectory, {
  recursive: true,
  filter: (source) =>
    !excluded.some((entry) => source === entry || source.startsWith(`${entry}${sep}`)),
});

const routes = [];

for (const rule of vercelConfig.headers ?? []) {
  routes.push({
    src: rule.source,
    headers: Object.fromEntries(rule.headers.map(({ key, value }) => [key, value])),
    continue: true,
  });
}

routes.push({ handle: 'filesystem' });

for (const rule of vercelConfig.rewrites ?? []) {
  routes.push({ src: rule.source, dest: rule.destination });
}

writeFileSync(
  join(outputDirectory, 'config.json'),
  `${JSON.stringify({ version: 3, routes }, null, 2)}\n`,
);

for (const entry of excluded) {
  console.log(`excluded ${relative(distDirectory, entry)}`);
}
console.log(`Build Output written to ${relative(repositoryRoot, outputDirectory)}`);
