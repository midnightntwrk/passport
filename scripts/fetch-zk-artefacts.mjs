/**
 * Puts the untracked half of the stagenet contract build on disk, from the
 * pinned release asset, so that a build with no local artefacts can run.
 *
 * WHY A DOWNLOAD RATHER THAN A COMPILE
 * ------------------------------------
 * `examples/passport-balancer/contracts-stagenet/managed/<contract>/` is split
 * down the middle by .gitignore: `contract/` and `compiler/` are tracked,
 * `keys/` and `zkir/` are ~97 MB of prover material that is not.
 *
 * It is downloaded because a BUILDER cannot compile, not because the build
 * cannot be reproduced. That distinction was the wrong way round here until
 * 2026/09/10. This file used to say that the artefacts could not be rebuilt on
 * any machine — `compiler/contract-manifest.json` named compactc 0.33.0-rc.2,
 * no such release exists in `midnightntwrk/compact` (the published set goes
 * 0.31.1 then 0.34.0), and a different compiler was assumed to mean a different
 * verifier key and so a PWA whose proofs `findDeployedContract` rejects.
 *
 * The assumption was tested on 2026/09/10 and is false. compactc 0.34.0 rebuilds
 * every one of these keys BIT-IDENTICALLY to the 0.33.0-rc.2 keys the stagenet
 * contracts were deployed with — `cmp` clean on all 11 account circuits, the
 * faucet circuit, and all 11 midnames circuits, across a language-version bump
 * from 0.25 to 0.26 (which 0.34.0 requires) and a runtime bump from 0.18.0-rc.1
 * to 0.19.0. The build is reproducible with a compiler anyone can install.
 *
 * The download stays, because none of the places that need these artefacts
 * installs a compiler: neither the Vercel builder nor
 * `.github/workflows/verify-demo.yml` has `compact` on PATH, and putting a
 * ~50 s, 97 MB compile in front of every build to reproduce bytes we can pin by
 * sha256 would buy nothing. A developer with the toolchain can rebuild instead
 * — `compact compile +0.34.0` into the same `managed/` directories — and this
 * script will then find the artefacts already on disk and download nothing.
 *
 * INTEGRITY IS TWO CHECKS, AND BOTH ARE MANDATORY
 * -----------------------------------------------
 * 1. `scripts/zk-artefacts.lock.json` pins the release tag, the asset name, the
 *    sha256, and the byte length. The download is hashed in full before a
 *    single byte is extracted; a mismatch is fatal and nothing is written.
 * 2. `.github/workflows/scripts/verify-zk-artefacts.mjs` then checks every
 *    extracted file against the tracked `compiler/contract-manifest.json`,
 *    which carries a sha256 and a size per file. That is what catches a bundle
 *    from a DIFFERENT, honestly-published build of the same contracts — the
 *    failure mode a hash of the tarball cannot see.
 *
 * The same manifest is the app's own run-time guard: midnight-js 5 verifies
 * every artefact it fetches against `compiler/contract-manifest.json` and its
 * integrity mode defaults to `require`, so a PWA that shipped an unverified
 * tree would throw `ZkArtifactIntegrityError` on the first prove rather than
 * quietly proving with the wrong key.
 *
 * IT IS IDEMPOTENT. If the artefacts already on disk pass the manifest check —
 * a developer's own build tree, a warm Vercel build cache, a re-run — nothing
 * is downloaded. So this is safe to put in front of every build.
 *
 *   node scripts/fetch-zk-artefacts.mjs
 *
 *   PASSPORT_ZK_BUNDLE_REPO     owner/name to download the asset from.
 *   PASSPORT_ZK_BUNDLE_TAG      release tag, for a one-off.
 *   PASSPORT_ZK_BUNDLE_SHA256   expected digest, when the tag is overridden.
 *   PASSPORT_ZK_BUNDLE_FILE     a local .tar.zst to use instead of downloading.
 *   PASSPORT_SKIP_ZK_FETCH=1    verify what is on disk and never download.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(repositoryRoot, '.github', 'workflows', 'scripts', 'verify-zk-artefacts.mjs');
const lockPath = resolve(repositoryRoot, 'scripts', 'zk-artefacts.lock.json');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const repository = process.env.PASSPORT_ZK_BUNDLE_REPO?.trim() || lock.repository;
const tag = process.env.PASSPORT_ZK_BUNDLE_TAG?.trim() || lock.tag;
const asset = lock.asset;
const expectedDigest = (process.env.PASSPORT_ZK_BUNDLE_SHA256?.trim() || lock.sha256).toLowerCase();
const expectedBytes = process.env.PASSPORT_ZK_BUNDLE_SHA256?.trim() ? null : lock.bytes;

function fail(message) {
  console.error(`fetch-zk-artefacts: ${message}`);
  process.exit(1);
}

/** The manifest check, as its own process, so its output reads unchanged. */
function artefactsVerify({ quiet } = {}) {
  const result = spawnSync(process.execPath, [verifier], {
    cwd: repositoryRoot,
    stdio: quiet ? 'ignore' : 'inherit',
  });
  return result.status === 0;
}

if (artefactsVerify({ quiet: true })) {
  console.log('fetch-zk-artefacts: the staged ZK artefacts already match the committed manifests.');
  artefactsVerify();
  process.exit(0);
}

if (process.env.PASSPORT_SKIP_ZK_FETCH === '1') {
  artefactsVerify();
  fail('PASSPORT_SKIP_ZK_FETCH=1 and what is on disk does not match the manifests.');
}

const workspace = mkdtempSync(join(tmpdir(), 'passport-zk-'));
const bundlePath = join(workspace, asset);
const tarPath = join(workspace, 'passport-zk-artefacts.tar');

try {
  const local = process.env.PASSPORT_ZK_BUNDLE_FILE?.trim();
  if (local) {
    if (!existsSync(local)) fail(`PASSPORT_ZK_BUNDLE_FILE names ${local}, which does not exist.`);
    console.log(`fetch-zk-artefacts: using the local bundle ${local}.`);
    await pipeline(createReadStream(local), createWriteStream(bundlePath));
  } else {
    // The repository is public, so this is an unauthenticated download and
    // needs no token on a builder. `redirect: follow` matters: the
    // /releases/download/ URL is a 302 to the objects host.
    const url = `https://github.com/${repository}/releases/download/${tag}/${asset}`;
    console.log(`fetch-zk-artefacts: downloading ${url}`);
    const started = Date.now();
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      fail(
        `HTTP ${response.status} for ${url}.\n` +
          '  The pinned release must exist and must carry this asset. Cutting a\n' +
          '  release without it is what docs/demo/deployment.md warns about.',
      );
    }
    await pipeline(response.body, createWriteStream(bundlePath));
    console.log(`fetch-zk-artefacts: downloaded in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  }

  const size = statSync(bundlePath).size;
  if (expectedBytes !== null && size !== expectedBytes) {
    fail(`${asset} is ${size} bytes; ${lockPath} pins ${expectedBytes}. Refusing to extract it.`);
  }

  const digest = createHash('sha256');
  await pipeline(createReadStream(bundlePath), digest);
  const actualDigest = digest.digest('hex');
  if (actualDigest !== expectedDigest) {
    fail(
      `${asset} hashes to ${actualDigest}, and the pin is ${expectedDigest}.\n` +
        '  Refusing to extract it. Either the release asset was replaced, or\n' +
        '  scripts/zk-artefacts.lock.json is stale — see its own header.',
    );
  }
  console.log(`fetch-zk-artefacts: sha256 ${actualDigest} matches the pin (${size} bytes).`);

  // Decompressed with node:zlib rather than `tar --zstd`, because GNU tar only
  // grows that flag when a `zstd` binary is on PATH and a Vercel builder image
  // is not promised to carry one. Node has had zstd since 22.15 and the
  // builder runs 24.x. Plain `tar -xf` is then all that is asked of tar.
  if (typeof createZstdDecompress !== 'function') {
    fail(`this Node (${process.version}) has no zstd in node:zlib. Node 22.15 or newer is required.`);
  }
  await pipeline(createReadStream(bundlePath), createZstdDecompress(), createWriteStream(tarPath));

  // The bundle's members are repository-relative
  // (examples/passport-balancer/contracts-stagenet/managed/…), which is why
  // this extracts at the repository root whatever the caller's cwd is.
  mkdirSync(resolve(repositoryRoot, 'examples', 'passport-balancer', 'contracts-stagenet', 'managed'), {
    recursive: true,
  });
  const extraction = spawnSync('tar', ['-xf', tarPath, '-C', repositoryRoot], { stdio: 'inherit' });
  if (extraction.status !== 0) fail(`tar exited ${extraction.status ?? 'on a signal'}.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (!artefactsVerify()) {
  fail(
    'the extracted artefacts do not match the committed manifests.\n' +
      '  The bundle is the one the pin names, so this is a bundle from a\n' +
      '  DIFFERENT build of these contracts, or the manifests moved without the\n' +
      '  pin. Do not ship it: the deployed contract knows only its own keys.',
  );
}
