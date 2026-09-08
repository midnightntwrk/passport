# Deploying the Passport demo

**The rule: only what is on `demo/pwa-demo` is deployed, and a deploy is a
published GitHub release.** `main` is the planning branch and does not contain
the PWA. Deploying by hand is possible and is documented below, but it is not
the normal path and it runs none of the gates.

## What deploys, and from where

| | |
|---|---|
| Site | <https://midnightpassport.com> |
| App | [`examples/passport-demo/`](../../examples/passport-demo/) |
| Vercel project | `midnight-passport-app` |
| Workflow | [`.github/workflows/deploy-demo.yml`](../../.github/workflows/deploy-demo.yml) |
| Triggers | a published GitHub release, or a manual `workflow_dispatch` |

The sibling services under `examples/` — `passport-balancer` and
`passport-funder` — are **not** part of this. They run on the droplet and are
shipped by rsync, as described in `examples/passport-balancer/README.md`. This
page is about the PWA on Vercel only.

## The deploy command

```sh
vercel --prod          # from the REPOSITORY ROOT, not from examples/passport-demo
```

That is the whole command, and it works from a fresh clone with nothing built.
The builder produces the ZK artefacts itself; see [Deploying by
hand](#deploying-by-hand) below for how, and for the one-off `vercel link` a new
working copy needs. It is still not the *sanctioned* path — it runs no gates and
uploads whatever is on disk, uncommitted changes included — so the rest of this
page, about releases, remains the procedure.

The workflow refuses to run unless the release commit is an **ancestor of
`origin/demo/pwa-demo`**, then checks out that immutable tag before building.
This makes the release body, the checked-out code, and the production upload the
same revision. It also refuses a ref that does not actually contain the demo,
rather than uploading an empty build over the live site.

## Cutting a release

1. Land the change on `demo/pwa-demo` and let
   [`verify-demo.yml`](../../.github/workflows/verify-demo.yml) go green on the
   pull request.
2. Pack the ZK artefacts from a tree that has them (see below). The
   break-glass `scripts/tag-release.mjs` command does this automatically; use
   the following when creating the release directly:

   ```sh
   tar --zstd -cf passport-zk-artefacts.tar.zst \
     examples/passport-balancer/contracts-stagenet/managed/account/keys \
     examples/passport-balancer/contracts-stagenet/managed/account/zkir \
     examples/passport-balancer/contracts-stagenet/managed/midnames/keys \
     examples/passport-balancer/contracts-stagenet/managed/midnames/zkir
   ```

3. Cut the release from `demo/pwa-demo` and attach that file:

   ```sh
   gh release create v2026.08.26 --target demo/pwa-demo \
     --title 'Passport demo 2026/08/26' \
     --notes 'What changed.' \
     passport-zk-artefacts.tar.zst
   ```

Publishing the release runs the gates and deploys. The run summary carries the
deployment URL.

### Why the release carries a 97 MB attachment

`vite build` stages prover keys and ZKIR from
`examples/passport-balancer/contracts-stagenet/managed/*/{keys,zkir}`. Those two
directories are gitignored; the `contract/` and `compiler/` halves beside them
are tracked. A fresh checkout therefore stops at `prepare:zk` with
"the account build is incomplete — keys/ is missing".

They cannot be rebuilt in CI. The manifests name compiler **0.33.0-rc.2**, and
`compact list` offers 0.31.1 then 0.34.0 — the compiler that produced what is
deployed on stagenet is not installable any more. Recompiling with a different
one would produce different verifier keys, and the deployed contract knows only
the keys it was deployed with.

So the bundle travels with the release, and every file in it is checked against
the tracked `contract-manifest.json` by
[`verify-zk-artefacts.mjs`](../../.github/workflows/scripts/verify-zk-artefacts.mjs)
before anything is built. Bundles are cached by manifest hash, so only the first
run after a contract rebuild pays the download.

The attachment is no longer only CI's. A remote build downloads the same asset,
pinned by sha256 in [`scripts/zk-artefacts.lock.json`](../../scripts/zk-artefacts.lock.json)
— see [How the builder gets artefacts it cannot compile](#how-the-builder-gets-artefacts-it-cannot-compile).
So a release without the bundle now breaks both paths, and the lock file has to
be moved forward in the same commit that lands new manifests.

## Secrets

Three repository secrets, set by whoever administers `midnightntwrk/passport`
(**Settings → Secrets and variables → Actions**):

| Secret | Value | Where it comes from |
|---|---|---|
| `VERCEL_TOKEN` | a Vercel access token | Vercel → Account Settings → Tokens, scoped to the team that owns `midnight-passport-app`. Not in this repository, and never printed by the workflow. |
| `VERCEL_ORG_ID` | `team_hVVRen2qWHNNHCLPg6LcMIH8` | `orgId` in `examples/passport-demo/.vercel/project.json` on a linked working copy. |
| `VERCEL_PROJECT_ID` | `prj_1t0WkAkp0oiPWEHVrdehKInWj8p0` | `projectId` in the same file. |

The two ids are not sensitive — `.vercel/` is gitignored, so the CLI is told
which project this is through the environment instead. They are secrets only so
that all three deploy inputs are managed in one place. The workflow fails with a
named error if any is unset.

To require a human approval before each production deploy, add a `production`
environment under **Settings → Environments** with required reviewers and a
`environment: production` line to the deploy job.

## Endpoint lists, and the one that is not like the others

Four of the app's endpoint variables take a **comma-separated, ordered list**
rather than a single URL. A single URL is a list of one and behaves exactly as
it always did, so nothing has to change to keep a deployment as it is. The
values the workflow passes in live in
[`deploy-demo.yml`](../../.github/workflows/deploy-demo.yml); the full reasoning
for each is in [`examples/passport-demo/.env.example`](../../examples/passport-demo/.env.example).

| Variable | What a second entry buys | When the next entry is tried |
|---|---|---|
| `VITE_MIDNIGHT_PROVING_URL` | a second prover | any refusal or failure, per request |
| `VITE_SPONSOR_URL` | a second fee sponsor | any refusal or failure, per request |
| `VITE_INDEXER_URL` | a second indexer | at wallet open, and on a stall |
| `VITE_FUNDER_URL` | a standby Passport service | **only** when the first did not answer |

The order is the operator's. Nothing reorders the list, load-balances across it,
or remembers a winner between calls, so failover can be proved by writing the
list the other way round. A failover writes one `console.info` line naming the
endpoint index it moved to; no wording the reader sees changes, and no endpoint
name reaches a screen.

### `VITE_FUNDER_URL` — a refusal is an answer

`/register-alias` and `/fund-account` **spend**, and a standby Passport service
is a different wallet: its own NIGHT, its own DUST, and its own once-per-account
record of who it has funded. So this list is fallen through **only when the
service did not answer at all** — no socket, a timed-out round trip, or a
`502`/`503`/`504` whose body carries no service JSON, which is the page a
reverse proxy sends when the process behind it is down.

Everything else stops the walk, because it is the service speaking for itself: a
`2xx`, any `4xx` including `429`, a `500` (that came out of the service's own
process, which may therefore have acted before it fell over), and a `503`
carrying a JSON code such as `wallet-syncing`, `INSUFFICIENT_DUST`, or `PAUSED`.
The reader is shown that refusal exactly as they are shown one service's refusal
today. A standby asked behind a refusal would register the same name from a
second wallet — surfacing as `name-taken` for a name that is in fact theirs — or
grant the activation a second time.

**One double grant remains possible and cannot be closed from the browser:** the
first service acted and its answer was lost coming back. That is bounded rather
than prevented, by checks that were already in place — the per-contract funding
marker read before every attempt and after every backoff wait, the service's own
`already-funded` answer counting as a success, the hold that stops a grant while
a name is unclaimed, and the account contract's own balance mirror, which makes
a second grant visible and spendable rather than lost. Two services can over-fund
one demo account; they cannot under-fund one or leave a Passport without a name.

`GET /status` is a read, so the sponsorship probe and the stablecoin colour
simply take the first service that answers.

### `VITE_INDEXER_URL` — chosen at open, replaced on a stall

The indexer is not chosen per request. The wallet SDK is handed one indexer
connection when a wallet is opened and holds it for that wallet's life, so:

- **at open**, each endpoint is asked a one-block-height query with a
  four-second ceiling and the wallet is built against the first that answers. A
  list of one skips the probe.
- **on a stall** — a dropped connection, or a sync percentage that has not moved
  for ninety seconds — the wallet is **rebuilt** against the next endpoint from
  the seed already stored, which is the same rebuild a silent session restore
  performs. It resumes from the saved sync snapshot rather than walking the chain
  again. The list is rotated rather than truncated, so a restarted primary is
  picked up again without a redeploy, and rebuilds in one session are capped at
  the length of the list.

`VITE_INDEXER_WS_URL`, where it is set, follows the HTTP list position by
position rather than being a list in its own right — an indexer is one host
reached two ways. An override shorter than the HTTP list covers the endpoints it
reaches and the rest derive theirs, so adding a second indexer is a one-variable
change.

## Rolling back

Roll back in Vercel; do not deploy an older commit.

```sh
cd examples/passport-demo
vercel ls midnight-passport-app          # find the last good deployment URL
vercel promote <deployment-url>          # make it production again
```

Or in the dashboard: **midnight-passport-app → Deployments → … → Promote to
Production**. Then fix forward on `demo/pwa-demo` and cut a new release; a
promotion is not a state that branch knows about.

## Deploying by hand

Two commands reach production without GitHub Actions. Both run **no gates** — no
typecheck, no tests, no PWA check, no end-to-end run — and both ship whatever is
in the working tree, including uncommitted changes. That is precisely the
incoherence between the release branch and production this page exists to end,
so if you use either, say so in the pull request or the channel and cut a
release from `demo/pwa-demo` afterwards so the two agree again.

### `vercel --prod` — the deploy command

```sh
vercel --prod        # from the repository root
```

Run once per working copy first, to write the gitignored root
`.vercel/project.json`:

```sh
vercel link --scope dominion-webisoft --project midnight-passport-app --yes
rm -f .env.local     # link leaves a VERCEL_OIDC_TOKEN behind; nothing here needs it
```

Everything else is committed. The Vercel project carries two settings that make
it work, both already applied:

| Setting | Value | Why |
|---|---|---|
| Root Directory | `examples/passport-demo` | Where the app and its `vercel.json` live. |
| Include source files outside of the Root Directory | on | The build reaches `examples/passport-balancer`, `demo-backend`, `packages/connect`, and the root lockfile — none of which are under the app. |
| Automatically expose System Environment Variables | **off** | See below. It has to be off, and the reason is the service worker. |

**Why system environment variables are off.** With it on, Vercel injects
`VITE_VERCEL_DEPLOYMENT_ID`, `VITE_VERCEL_URL`, and a dozen more into the build,
and because this app reads `import.meta.env` as an object in several places,
Vite inlines the whole record into the main chunk. Two of those values are
unique per deployment, so `main-*.js` — a content hash — changed on every build,
and with it the service-worker `BUILD_ID`, which is a digest of the emitted
asset filenames. That is exactly the "a rebuild with no source change stamps the
same id" property `stampServiceWorkerBuildId` in
[`vite.config.ts`](../../examples/passport-demo/vite.config.ts) exists to hold:
without it every deploy installs a new worker on every client whether or not the
client changed. Nothing in the app reads a `VITE_VERCEL_*` value, and turning
the setting off also stops the project and deployment ids being compiled into a
public bundle. Measured both ways on 2026/09/08: with it on, two consecutive
builds of one tree gave `187b9233…` and `9103d568…`; with it off, both gave
`bfad1f8e87ebcfb2` and identical asset hashes.

`examples/passport-demo/vercel.json` names the rest: `installCommand`
(`cd ../.. && npm ci`), `buildCommand` (`npm run vercel-build`, which hands back
to the root's `build:passport:remote`), and `outputDirectory` (`dist`). The
root `.vercelignore` decides what is uploaded — a deny list, so a new workspace
is included by default, and it deliberately withholds every generated ZK tree so
that what ships does not depend on what a laptop happens to have built.

The `VITE_*` values a remote build compiles in come from the **project's
Environment Variables**, not from this repository — a builder cannot see
`package.json`'s script line or `deploy-demo.yml`'s `env:` block. `vercel env ls`
reads them back; they are the same five values as those two copies, and all
three change together.

Measured on a first, cold build (no build cache), 2026/09/08:

| Step | |
|---|---|
| `npm ci` at the root | 27 s |
| ZK bundle: download, sha256, manifest check | 2.5 s |
| `zk-params` from the upstream bucket | 7 s |
| `prepare:zk`, `tsc --noEmit`, `vite build` | 40 s |
| **Total, queued to READY** | **91 s** |

With a warm build cache it is 61–63 s. The prebuilt fallback's upload, for
comparison, is 7 s — but it is preceded by the full build on the laptop.

#### How the builder gets artefacts it cannot compile

`node scripts/fetch-zk-artefacts.mjs` runs first. It downloads the
`passport-zk-artefacts.tar.zst` asset named by
[`scripts/zk-artefacts.lock.json`](../../scripts/zk-artefacts.lock.json), which
pins the release tag, the sha256, and the byte length; the repository is public,
so the download needs no token. Nothing is extracted until the digest matches.
It then runs the same
[`verify-zk-artefacts.mjs`](../../.github/workflows/scripts/verify-zk-artefacts.mjs)
the workflow does, so every file is checked against the tracked
`compiler/contract-manifest.json` before a build starts. It is idempotent: a
tree that already matches the manifests is left alone and nothing is downloaded.

**Compiling instead was ruled out, and not because a builder is limited.** The
manifests name compactc **0.33.0-rc.2**, and no such release exists in
`midnightntwrk/compact` — the published set goes 0.31.1 then 0.34.0, and the
`compact` CLI's own artefact list offers no 0.33.x for any of `x86_macos`,
`aarch64_macos`, `x86_linux`, or `aarch64_linux` (re-checked against the GitHub
releases API on 2026/09/08). A different compiler is a different verifier key,
and the contract deployed on stagenet knows only the key it was deployed with.

**The integrity check is not optional and does not stop at the build.**
midnight-js 5 verifies every artefact the PWA fetches against
`compiler/contract-manifest.json`, and its integrity mode defaults to `require`
— fail-closed. A PWA that shipped an unverified tree would throw
`ZkArtifactIntegrityError` on the first prove rather than quietly proving with
the wrong key. So the pin is the supply chain, the manifests are the
correctness, and the browser checks the same manifests again at run time.

**When the contracts are rebuilt**, attach the new bundle to the release and
update `tag`, `sha256`, and `bytes` in `scripts/zk-artefacts.lock.json` in the
same commit that lands the new manifests. A stale pin fails at the manifest
check, loudly, before anything is built.

### `npm run deploy:passport:manual` — the fallback

Builds locally and uploads the finished output with `vercel deploy --prebuilt`,
which is how this repository deployed before the remote build existed. Use it
when the builder cannot get the artefacts — the pinned release asset is gone,
the upstream parameter bucket is down — or when what you are shipping is not a
tree any release describes.

```sh
npm run deploy:passport:manual
```

It fetches and verifies the pinned artefacts first (so it works on a fresh
clone), builds, assembles a Build Output API directory with
`scripts/build-vercel-output.mjs`, uploads it from `examples/passport-demo`, and
ends by cutting the release tag. That directory needs its own one-off link:

```sh
cd examples/passport-demo
vercel link --scope dominion-webisoft --project midnight-passport-app --yes
rm -f .env.local .gitignore     # both written by `link`; neither is wanted here
```

The prebuilt upload is unaffected by the Root Directory setting — there is no
build step for it to apply to — and `scripts/build-vercel-output.mjs` reads only
`headers` and `rewrites` out of `vercel.json`, so the build settings added there
change nothing about what it emits. Both were confirmed by preview deployment on
2026/09/08.

## Every deploy is backed by a release

Every production deploy must be backed by a GitHub release (Hector, 2026/09/03: "nothing fancy, just the release tag"). `deploy:passport:manual` ends by running `scripts/tag-release.mjs`, which reads the service-worker build id from `examples/passport-demo/dist/sw.js`, refuses a dirty tree, verifies and packages the pinned ZK artefacts, and creates a release on `midnightntwrk/passport` targeting the deployed commit. A published release without that bundle is invalid: GitHub makes published releases immutable, so it must be superseded by a new release that includes the artefact.

The release is tagged `v<N>`, where N is one past the highest `v<N>` that already exists — counted from both the tag refs (`git ls-remote --tags`) and the releases (`gh release list`), so a tag pushed without a release, or a release whose tag was deleted, still counts. A repository holding only the older `demo-YYYY.MM.DD-<build id>` tags therefore starts at `v1`. The title is `v<N> - YYYY/MM/DD` (UTC).

### The body is the delta, not the whole changelog

`RELEASE-NOTES.md` is **cumulative**: every "## Fixed" entry written since 2026/09/03 is still in it, because it is the changelog. Its header line used to say the file was rewritten before every deploy, and it never was — so publishing the whole section made v10 a 51,000-character page listing forty-two fixes, the same text v1 to v8 had carried, and the reviewer could not tell from it what that deploy had changed (Hector, 2026/09/08).

So the file stays cumulative and the release page carries only what is new. The body is:

```
Build <first 8 of the build id> · commit <sha7> · https://midnightpassport.com

## Fixed in this release
- **<bold title>.** <first sentence of the entry>
```

The previous release is the highest `v<N>` below the one being created; its `RELEASE-NOTES.md` is read with `git show v<N>:RELEASE-NOTES.md`, and an entry counts as new when its **bold title** is not in that file. The title is therefore the identity of a fix — do not reword one after it has shipped, or it will be published twice. Each entry becomes one line: the provenance parenthetical it opens with ("(found by the production release gate, 2026/09/08)") is dropped, and the first sentence is capped at about 220 characters. If nothing is new — a redeploy of the same notes, or a tooling-only change — the body says `## This release` / `- Release tooling only; no user-facing change.` instead.

If the tag of the previous release is not in the local checkout (`git fetch --tags`) or has no `RELEASE-NOTES.md`, the run says so and treats every entry as new rather than guessing.

The whole body is capped at **4,000 characters**. Over that, the script refuses: a release that long means one deploy carried several deploys' worth of change, which is the thing worth noticing. `--allow-long` publishes it anyway. `PASSPORT_RELEASE_NOTES` still appends a gate summary, and counts towards the cap.

**It is not a pre-release** (changed 2026/09/07). It used to be, and that was the bug: GitHub never shows a pre-release as "Latest", so a reviewer reading the repository front page saw a three-day-old release and concluded nothing had shipped since. The naming rule — `v<N> - <date>` — is Hector's, from the same review.

It is idempotent for a **commit and build**: re-running the same release is reported rather than released twice. A later gate-only commit may carry identical PWA bytes after an immutable release failed before deployment, and it receives a replacement release instead of being trapped behind the old build id. It verifies that a same-commit release has the ZK bundle; if it does not, it stops rather than claiming the immutable release was repaired. `--dry-run` prints the `gh` command and the body without creating anything — and on a build that is already released it says so and still prints the body that release's delta comes to, because seeing the body is the point of a dry run. The derivation of the number, the title, the delta, and the body is unit-tested — `npm run test:release-naming`.

Options, for releasing something other than "what was just built here":

| Option | What it is for |
| --- | --- |
| `--repo <owner/name>` | The repository to release in. Default `midnightntwrk/passport` (or `PASSPORT_RELEASE_REPO`). The carry into `midnightntwrk/passport-demo` passes that repository, so the same deploy is released the same way in both places. |
| `--commit <sha>` | The commit the release points at. Default HEAD. The carried commit has a different sha in `passport-demo`, and an older deploy is no longer at HEAD. Naming it also makes the notes come from THAT commit's `RELEASE-NOTES.md`, so the release says what that build shipped rather than what has been fixed since. |
| `--build-id <id>` | The service-worker build id, when `dist/` has moved on — mirroring into `passport-demo`, or filling in a release after the fact. Default: read from the stamped `dist/sw.js`. |
| `--allow-long` | Publish a body over 4,000 characters. Only when the long body really is one release; otherwise the refusal is telling you the deploy was too big. |

The mirror of a deploy into `passport-demo` is run from a **checkout of `passport-demo`**, after the carry — the carried commit only exists there, and the script resolves `--commit` against the repository it is run in (which is also where it reads that commit's `RELEASE-NOTES.md`). The carry brings the script itself along, so it is already present:

```sh
cd <a clean checkout of midnightntwrk/passport-demo, at the carried branch>
node scripts/tag-release.mjs --repo midnightntwrk/passport-demo \
  --commit <the carried commit> --build-id <the deployed build id>
```

Only deploys get releases. A build that was never uploaded does not get one, however tempting the round number.
