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
