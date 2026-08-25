# End-to-end tests

Two tiers, and the split between them is about what can be established without
a chain rather than about speed.

| | `onboarding.spec.ts` | `stagenet.live.spec.ts` |
|---|---|---|
| Runs against | a production build on `vite preview` | https://midnightpassport.com |
| Network | every call intercepted; nothing leaves the machine | real stagenet |
| Costs | nothing | a real name, a real account contract, real test NIGHT |
| Runs by default | yes | no — needs `RUN_LIVE=1` |
| Wall clock | seconds | 3–10 minutes, mostly proving |

```sh
npm run test:e2e         # tier 1
npm run test:e2e:live    # tier 2 — claims a real name on stagenet
```

Both need a browser binary once: `npx playwright install chromium`.

## The passkey

Neither tier can run without one: the passkey **is** the Passport. Its WebAuthn
PRF output is where the wallet seed and the private-state key come from, so
there is no "skip the ceremony" path to test around. Both specs install a CDP
virtual authenticator (`WebAuthn.addVirtualAuthenticator`) with `ctap2_1`,
`hasPrf`, a resident key, user verification, and automatic presence — see
`passkey.ts`, which explains why each of those is required rather than default.
That fixes the browser to Chromium; Firefox and WebKit have no equivalent.

## Tier 1 — `onboarding.spec.ts`

Holds the shipped bundle to the account model:

- the landing screen offers exactly one way in;
- a passkey lands on the name step, and the name step has **no** control that
  leaves it — Home without an account is not a state onboarding may end in;
- the availability line quotes no price, no balance, and no faucet, because the
  service pays the registry and the user holds nothing;
- with the sponsor stood down the screen promises a **queue** and never a
  payment;
- a reload mid-onboarding returns to the name step, never to Home;
- Home names the account contract the name resolves to, and offers exactly one
  address — never a wallet address, never DUST;
- the Send sheet is a withdrawal from the account, and never mentions DUST.

`mocks.ts` is the whole network boundary and says where each answer came from.
Two details worth knowing:

- **Availability is decoded for real.** `fixtures/stagenet-night-registry.json`
  is the stagenet `.night` TLD's own contract state, recorded from the indexer
  on 2026/08/25. `domains.member(paddedKey)` runs through the real Midnames
  contract module over real ledger bytes; nothing about the registry is
  invented. Re-record it if the registry moves — a passing test against a stale
  snapshot is still a test against real bytes, just old ones.
- **The chain height is the one fabricated value.** `localWallet.ts` refuses a
  from-genesis walk above a million blocks, and stagenet is far past that, so a
  mocked run answers `BlockHeight` with 120 to let the wallet open at all.

What tier 1 deliberately does **not** do is run a claim. Claiming deploys the
account contract, which is a proved transaction — ~32 MB of circuit keys, a
prover, and a chain to submit to. A mocked "claim succeeded" would assert that
the mock returned, and the two things worth knowing (that the name resolves to
the contract, and that the contract holds the balances) would both be assumed.

## Tier 2 — `stagenet.live.spec.ts`

Does the thing. Creates a passkey, claims a fresh name, waits for the sponsor's
activation grant, and spends from the account:

- the claim runs the real ceremony — the account-custody deploy (the one
  transaction this passkey wallet originates in its life), the resolver deploy,
  and the registration;
- the identity card's "resolves to your Passport account contract (…)" and the
  receive row's address are compared, so the name is shown to point at the
  account rather than anywhere else;
- activation asserts **exactly** 0.002 NIGHT, which is what the balancer really
  deposits, and asserts the stablecoin as *present or pending* rather than at a
  fixed figure — its leg has been failing on stagenet, and a hard 100 would
  make a red test mean "the sponsor is behaving as documented";
- the send asserts the **account's** balance drops. Nothing else proves a
  withdrawal happened.

### It can fail for a reason that is not a bug

One service covers both the activation grant and the send's fee, and it
serialises balancing: it reserves its DUST for a balanced transaction the
moment it finalises one. So a claim — or a send issued straight after the
activation deposit — is genuinely refused while that reservation stands, the
card says so in the service's own words, and nothing is lost. Measured twice on
2026/08/25 before the spec accounted for it.

The spec therefore does two things a user would do, and neither is papering
over a flake:

- it retries a refused claim once, ninety seconds later; and
- it waits on `GET /balancer/wallet-status` for `available > 0` before sending
  — the same gate `src/lib/sponsor.ts` applies — and retries the send once if
  the sponsor is taken in between.

If either fails twice the message carries the service's own sentence. Check
`GET https://funder.midnightpassport.com/balancer/wallet-status` before
concluding the app is broken.

A clean run is about four and a half minutes; a run that has to wait out a
reservation is longer. Do not run the two tiers concurrently, and leave a few
minutes between live runs.
