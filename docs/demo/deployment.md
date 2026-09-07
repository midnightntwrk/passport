# Deploying the Passport demo

**The rule: only what is on `main` is deployed, and a deploy is a published
GitHub release.** Manual `vercel deploy` from a laptop is no longer the path.

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

The workflow refuses to run unless the commit being deployed is an **ancestor of
`origin/main`**, so a release tagged on a feature branch cannot ship. It also
refuses a ref that does not actually contain the demo, rather than uploading an
empty build over the live site.

## Cutting a release

1. Merge to `main` and let [`verify-demo.yml`](../../.github/workflows/verify-demo.yml)
   go green on the pull request.
2. Pack the ZK artefacts from a tree that has them (see below):

   ```sh
   tar --zstd -cf passport-zk-artefacts.tar.zst \
     examples/passport-balancer/contracts-stagenet/managed/account/keys \
     examples/passport-balancer/contracts-stagenet/managed/account/zkir \
     examples/passport-balancer/contracts-stagenet/managed/midnames/keys \
     examples/passport-balancer/contracts-stagenet/managed/midnames/zkir
   ```

3. Cut the release from `main` and attach that file:

   ```sh
   gh release create v2026.08.26 --target main \
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
Production**. Then fix forward on `main` and cut a new release; a promotion is
not a state `main` knows about.

## The break-glass path

`npm run deploy:passport:manual` still exists, and still does what
`deploy:passport` used to. It is for the case where GitHub Actions itself is
unavailable. It runs **no gates** — no typecheck, no tests, no PWA check — and
it ships whatever is in the working tree, including uncommitted changes. That is
precisely the incoherence between `main` and production this page exists to end.

If you use it, say so in the pull request or the channel, and cut a release from
`main` afterwards so the two agree again.

## Every deploy is backed by a release

Every production deploy must be backed by a GitHub release (Hector, 2026/09/03: "nothing fancy, just the release tag"). `deploy:passport:manual` ends by running `scripts/tag-release.mjs`, which reads the service-worker build id from `examples/passport-demo/dist/sw.js`, refuses a dirty tree, and creates a release on `midnightntwrk/passport` targeting the deployed commit.

The release is tagged `v<N>`, where N is one past the highest `v<N>` that already exists — counted from both the tag refs (`git ls-remote --tags`) and the releases (`gh release list`), so a tag pushed without a release, or a release whose tag was deleted, still counts. A repository holding only the older `demo-YYYY.MM.DD-<build id>` tags therefore starts at `v1`. The title is `v<N> - YYYY/MM/DD` (UTC). The body opens with the build id, the commit, and the production URL, then carries the "## Fixed" section of `RELEASE-NOTES.md` (`PASSPORT_RELEASE_NOTES` appends a gate summary).

**It is not a pre-release** (changed 2026/09/07). It used to be, and that was the bug: GitHub never shows a pre-release as "Latest", so a reviewer reading the repository front page saw a three-day-old release and concluded nothing had shipped since. The naming rule — `v<N> - <date>` — is Hector's, from the same review.

It is idempotent: a build that already has a release, under a `v<N>` tag or a legacy `demo-…` one, is reported and left alone. `--dry-run` prints the `gh` command without creating anything. The derivation of the number and the title is unit-tested — `npm run test:release-naming`.

Options, for releasing something other than "what was just built here":

| Option | What it is for |
| --- | --- |
| `--repo <owner/name>` | The repository to release in. Default `midnightntwrk/passport` (or `PASSPORT_RELEASE_REPO`). The carry into `midnightntwrk/passport-demo` passes that repository, so the same deploy is released the same way in both places. |
| `--commit <sha>` | The commit the release points at. Default HEAD. The carried commit has a different sha in `passport-demo`, and an older deploy is no longer at HEAD. Naming it also makes the notes come from THAT commit's `RELEASE-NOTES.md`, so the release says what that build shipped rather than what has been fixed since. |
| `--build-id <id>` | The service-worker build id, when `dist/` has moved on — mirroring into `passport-demo`, or filling in a release after the fact. Default: read from the stamped `dist/sw.js`. |

The mirror of a deploy into `passport-demo` is run from a **checkout of `passport-demo`**, after the carry — the carried commit only exists there, and the script resolves `--commit` against the repository it is run in (which is also where it reads that commit's `RELEASE-NOTES.md`). The carry brings the script itself along, so it is already present:

```sh
cd <a clean checkout of midnightntwrk/passport-demo, at the carried branch>
node scripts/tag-release.mjs --repo midnightntwrk/passport-demo \
  --commit <the carried commit> --build-id <the deployed build id>
```

Only deploys get releases. A build that was never uploaded does not get one, however tempting the round number.
