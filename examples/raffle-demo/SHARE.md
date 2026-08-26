# Handing this to hackathon participants

The 2026/08/06 decision was that the raffle becomes open source and ships
alongside the beta SDK for developer feedback. This note says exactly what to
hand over, and what must not go with it.

## What to hand over

1. **This folder, copied whole.** `examples/raffle-demo/` is self-contained:
   the bridge protocols and the design tokens are vendored (see the provenance
   headers), so `npm install && npm run build` works in a fresh directory with
   no monorepo around it. Verify that before every hand-off — it is one
   command, and a broken first five minutes costs more than the check.
2. **The beta SDK,** with the feedback channel named. Participants should know
   where to send what they find; an example dApp with nowhere to report a
   problem produces no feedback.
3. **A pointer to a running Passport instance** (or instructions to run one
   locally on `http://localhost:5175`). The raffle is one half of a handshake
   and demonstrates nothing on its own.

## What must NOT go with it

- **`.env.local`, or any real environment values.** Ship `.env.example` only.
  `VITE_RAFFLE_COLLECTION_ADDRESS` in particular is an address that collects
  real preview NIGHT.
- **`.vercel/`**, `dist/`, and `node_modules/`. Deployment linkage,
  build output, and dependencies are not part of the example.
- **Anything from `.planning/`**, and any internal or stakeholder framing. The
  README is written for someone outside the project and should stay that way.

## Before you publish

- [ ] `.env.local` is absent from the copy.
- [ ] `.vercel/`, `dist/`, and `node_modules/` are absent from the copy.
- [ ] `LICENCE` (Apache-2.0) is present, and `package.json` says
      `"license": "Apache-2.0"` with no `"private"` flag.
- [ ] `npm install && npm run build` succeeds in a temporary directory outside
      the repository.
- [ ] The README's caveats still match reality — especially whether fee
      sponsorship is live. If the sponsor is not reachable or not authorised,
      the demo must show real fees or an honest blocked state, never a
      fabricated "free".
