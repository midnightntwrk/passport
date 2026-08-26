/**
 * Assembles a Vercel Build Output API v3 directory for one of the demo apps,
 * from a `dist/` that was produced LOCALLY.
 *
 * WHY THIS EXISTS — the demos cannot be built on a Vercel builder
 * ---------------------------------------------------------------
 * Verified on 2026/08/05 in a clean `git worktree` + `npm ci` of this branch:
 * `tsc --noEmit` and `vite build` both fail outright, because two generated
 * Compact contract modules are gitignored and absent from a fresh checkout —
 *
 *   experiments/account-custody-prototype/contracts/managed/account/…
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
 * The Passport demo is deployed by .github/workflows/deploy-demo.yml, from a
 * published GitHub release, which sets the VITE_* values, calls this, and
 * uploads. `npm run deploy:passport:manual` does the same from a laptop and is
 * break-glass only — see docs/demo/deployment.md. `npm run deploy:raffle` and
 * the other deploy:* scripts are still the normal path for their apps.
 *
 * One of those values reads like a special case and is not. The Passport
 * deployment sets `VITE_RAFFLE_URL` — not `VITE_LOCAL_APP_URL`, the variable third-party
 * developers are handed for the same grid slot. The two are deliberately
 * separate entries in `examples/passport-demo/src/lib/registry.ts`: the raffle
 * one carries the id `raffle-demo`, its own description, and the illustrated
 * card the Apps grid keys off that id, none of which the generic local slot
 * has. Moving the deployed raffle onto `VITE_LOCAL_APP_URL` would therefore
 * change what ships, so the two variables stay distinct and this script's
 * callers keep naming the raffle one. Nothing here reads either variable —
 * both are consumed by `vite build` before this script runs.
 *
 * Each app directory must be linked to its Vercel project once, first:
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
