/**
 * Verifies the staged ZK artefacts against the manifests that ARE in git.
 *
 * `examples/passport-balancer/contracts-stagenet/managed/<contract>/` is split
 * down the middle by `.gitignore`: `contract/` and `compiler/` are tracked,
 * `keys/` and `zkir/` are ~97 MB of prover material that is not. CI gets the
 * untracked half from a release asset or the Actions cache, and this script is
 * what makes that safe — `compiler/contract-manifest.json` carries a SHA-256
 * and a byte length for every one of those files, so a bundle from a different
 * build of the same contracts is caught here rather than in a browser.
 *
 * That distinction is the whole risk. Two builds of one contract are two
 * verifier keys, and the contract deployed on stagenet knows only the one it
 * was deployed with; a PWA shipping the other proves circuits that
 * `findDeployedContract` then rejects. `prepare-zk-assets.mjs` makes the same
 * point at length, and refuses to compile anything for the same reason.
 *
 * Recompiling instead of verifying is not an option: the manifests name
 * compiler 0.33.0 (0.33.0-rc.2), and `compact list` offers 0.31.1 then 0.34.0.
 * The compiler that produced what is deployed cannot be installed any more.
 *
 * Exits non-zero, loudly, on the first sign of a missing or altered file.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANAGED_ROOT =
  process.env.MANAGED_ROOT ?? 'examples/passport-balancer/contracts-stagenet/managed';

/** The contracts the PWA proves circuits for, as named by prepare-zk-assets.mjs. */
const CONTRACTS = ['account', 'midnames'];

/** The two untracked directories. `contract/` and `compiler/` come from git. */
const DIRECTORIES = ['keys', 'zkir'];

let checked = 0;
const failures = [];

for (const contract of CONTRACTS) {
  const base = resolve(MANAGED_ROOT, contract);
  const manifestPath = resolve(base, 'compiler', 'contract-manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    failures.push(`${contract}: cannot read ${manifestPath} — ${error.message}`);
    continue;
  }

  for (const directory of DIRECTORIES) {
    const entries = manifest[directory];
    if (!entries) {
      failures.push(`${contract}: the manifest has no ${directory} section.`);
      continue;
    }

    for (const [name, meta] of Object.entries(entries)) {
      // The section carries its own `"type": "directory"` marker alongside the
      // file entries; skip it and anything else that is not a file.
      if (name === 'type' || meta?.type !== 'file') continue;

      const file = resolve(base, directory, name);
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch {
        failures.push(`missing  ${contract}/${directory}/${name}`);
        continue;
      }

      checked += 1;

      if (bytes.length !== meta.size) {
        failures.push(
          `size     ${contract}/${directory}/${name}: ${bytes.length} bytes, manifest says ${meta.size}`,
        );
        continue;
      }

      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== meta.hash) {
        failures.push(`hash     ${contract}/${directory}/${name}: ${digest} != ${meta.hash}`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error('');
  console.error(
    `ZK artefact verification FAILED: ${failures.length} of ${checked + failures.length} files.`,
  );
  console.error(
    'The staged prover keys are not the build these manifests describe, which is the',
  );
  console.error(
    'build deployed on stagenet. Do not ship this — republish the bundle from the tree',
  );
  console.error('the deployment harness produced. See docs/demo/deployment.md.');
  process.exit(1);
}

if (checked === 0) {
  console.error('ZK artefact verification FAILED: the manifests named no files to check.');
  process.exit(1);
}

console.log(`ZK artefacts verified against the committed manifests: ${checked} files.`);
