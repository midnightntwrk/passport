**What this is.** The Midnight Passport demo is a working prototype running on
preview/testnet. It is real — the flows execute against real infrastructure, nothing is
mocked. It exists to show that this can be done, and to show the functionality we are
building towards.

**What this is not.** It is not going to mainnet. It is not the final product. It has not
been audited: audits and security hardening happen before anything moves onto a production
path. Productising Passport is a separate stream of work running in parallel with this
demo, not a phase that starts when the demo ends.

**What we call things.** The demo engine is a demo backend with connectors. Integrations
with partner applications are *connectors*, built case by case. Nothing in this demo is an
SDK.

Status: draft, 2026/07/29 — wording pending ratification (proposal: Karmel).

---

The rest of this page is orientation rather than agreed wording, and is
maintained against the tree: last checked 2026/08/22.

## What runs where

Everything below is in this repository. Ports are pinned, not incidental —
Passport frames apps by URL, and a handshake against a moving origin fails
silently.

| Directory | What it is | Port |
|---|---|---|
| `examples/passport-demo/` | Passport itself: the installable PWA, the wallet, the whole user-facing flow. | 5175 |
| `demo-backend/` | The demo backend with connectors — encrypted private-state store, WebAuthn PRF key provider, and the profile and transaction wire protocols. File-linked, not published. | — |
| `examples/passport-funder/` | Self-hosted onboarding service. Registers `.night` names for new Passports and drips activation-sized NIGHT. Node service, needs a funded faucet seed. | 8799 |
| `examples/raffle-demo/` | Example dApp: profile handshake plus a payment Passport signs. In the Apps grid by default. | 5177 |
| `examples/passport-app-template/` | The starter a third-party developer copies. Self-contained. | 5178 |
| `examples/clubcoin-mock/` | The URL-callback (redirect) connector example, for phones. Named after a partner that is no longer in the demo. | 5181 |
| `examples/passport-profile-client/` | The original separate-origin consent client, "Atlas". Superseded in the grid by the raffle. | 5176 |
| `examples/passport-app-hub/` | Public listing site for apps that integrate the bridge. | 5179 |
| `examples/passport-docs/` | The documentation site. | 5180 |
| `experiments/` | Cryptographic and feasibility experiments, including the account-custody contract source. Not production dependencies. | — |
| `docs/`, `research/`, `site/` | The plan, the research behind it, and the published artefacts. | — |

The demo runs against **Preview**. Mainnet is hard-blocked in code, and preprod
is reachable but unusable in a browser: a cold wallet cannot walk its ~1.98M
blocks without exhausting the tab's heap, so a depth guard refuses the attempt
rather than starting it.

## Real, mocked, and untested

**Real — executes against the chain.** Passkey enrolment and unlock; the wallet
derived from the passkey in the browser; balances and transaction history from
the indexer; the account-custody contract deployment; `.night` availability,
pricing, and registration against the deployed Midnames registry; sponsored
fees; funder-sponsored registration; sending NIGHT. A balance, a transaction
hash, or a resolved name is either read from the chain or absent — never
substituted, and a queued name is never shown as registered.

**Real but standing in for something else.** The funder pays for names the way
a Midnames-side sponsorship service would, and the registry cannot tell the
difference. It exists because that service does not yet, and Passport points at
theirs when it ships. The fee sponsor is likewise an external service the demo
consumes rather than a protocol guarantee.

**Examples, not partners.** The raffle, the app template, and the URL-callback
example are apps we wrote to exercise the connectors from the other side. They
are real applications making real requests; they are not third-party
integrations in production.

**Not built.** The Otrix totem flow — a totem showing a QR code with a shielded
deposit address, paid from Passport — has no code in this tree. ClubCoin is out
of the demo; only the directory name survives.

**Untested rather than working.** Nothing in the current passkey-only flow has
been recorded in [`docs/demo/validation-log.md`](docs/demo/validation-log.md)
since the wallet vendor was removed on 2026/08/20. Treat any claim about the
current flow as untested until a run is logged there with its transaction
hashes.
