# C4 · Asset custody model

> **Workstream — resolved.** The upstream design question for the
> cryptographic stack is answered: stateless contract custody (A″),
> normative in the custody MIP, published upstream as **MIP-0012 —
> Contract Custody of Midnight-Native Assets** and implemented by the
> reference implementation at `contract/`.

**Serves:** P3 · P4 · P5 · P6.

## Outcome

A ratified choice of how user assets are held, authorised, and recovered —
satisfying P3 (multi-device), P4 (lost-device recovery), P5 (total-loss
recovery), and P6 (key non-exfiltration) simultaneously, integrating
cleanly with C1 (account-custody contract), C5 (signing primitive), C14
(total-loss recovery flow), and C16 (wallet local storage).

**Status 2026/07:** the choice is made and standardised. The custody
MIP (upstream MIP-0012) specifies contract custody with the stateless
shielded pattern (no coin material in public ledger state,
encrypted-inbox discovery, witness-supplied spends), a normative
surviving-coin change rule (the defect it prevents is fixed upstream:
OpenZeppelin/compact-contracts#656 → #661), an explicit per-color
unshielded mirror, and authorisation abstracted to a single seam that
the account-authorisation MIP (upstream MIP-0013) instantiates (C5).
Two findings ride along: the account encryption secret is a pure
*viewing capability* — delegable to an accountant or auditor without
ceding custody — and the residual metadata profile is documented and
accepted in the MIP's security considerations rather than left open.
The reference implementation (`contract/`) realises both MIPs in one
deployment with their conformance suites passing, and the errata it
surfaced are folded back into the upstream texts.

**Exclusivity (decided 2026/07):** the user holds assets no other way
than through the account custody contract. Assets at rest are always
in the contract; the user-held coins that the one-hop payment rule
(MIP-0012 §6.6) necessarily creates are in-flight plumbing that the
client sweeps into the account, never a holding location. This is a
Passport client policy layered on the standard — the MIP permits
user-held coins, Passport's wallet does not park value in them. The
one exception is forced by the ledger: the contract holds no Dust, so
the fee path (C24) lives outside the account by necessity, not by
choice.

## Feasibility map

Established by `experiments/contract-custody-feasibility/` (S1 – S6,
evaluated against `midnight-node:0.22.5`) and extended by
`experiments/stateless-shielded-custody/` (W1 – W6, evaluated against
`midnight-node:1.0.0`).

| Asset class · direction | Status |
|---|---|
| Night · user ↔ contract | **Feasible** (U1, U3 PASS) |
| Night · contract ↔ contract | **Protocol-feasible; SDK-blocked, half-unblocked.** The wallet fee-balancing side (`midnight-wallet#293`) is resolved upstream — deterministic segment placement merged in [midnight-wallet#334](https://github.com/midnightntwrk/midnight-wallet/pull/334) (2026/04/21). Remaining gap: the `midnight-js` multi-contract-call composition utility. U2 / U4 re-probe against a post-#334 wallet release pending. Workaround meanwhile: route through user → user. |
| Shielded · user → contract deposit | **Feasible** (S4 PASS, via `rawTokenType` recipe). |
| Shielded · contract → user / cross-block | **Feasible by two patterns.** Public-state (S6 PASS, OZ `Map<color, QualifiedShieldedCoinInfo>` + `Map.insertCoin`: publishes holdings), and stateless witness-supplied QSCI (W3 PASS: no coin material in public ledger state). |
| Shielded · third-party deposit + owner discovery | **Feasible** (W5 PASS, encrypted on-contract inbox + indexer lookup). The enumeration gap W5 recorded is closed: the indexer's `contractActions` subscription replays the complete per-address action history, verified end-to-end by the reference implementation's discovery suite (C17 finding). |
| Shielded · contract ↔ contract | **Feasible — validated** (`experiments/contract-to-contract-transfer/` P1 – P3 PASS, run 2026/07). One client-composed transaction pairs A's `sendShielded`-to-ContractAddress with B's `receiveShielded` claim: compose by grafting B's call intent onto A's transaction (`Transaction.addIntent`; a plain `Transaction.merge` duplicates the claimed output and fails balancing), prove both circuits in one `submitTx`. The received coin is first-class (decryptable inbox blob, onward spend accepted). Cost measured, accepted by decision of 2026/07/16: the transaction exposes both contract addresses together; value, color, and nonce stay hidden. The one-hop user-key routing rule remains the counterparty-private mode; direct transfer is the linking-accepted mode (the two modes are normative in MIP-0012 §6.6, restated upstream after this validation). |
| Dust · contract pays user fee | **Not feasible on v1** — *contract-attached* paymaster only. Does not preclude wallet-level sponsorship; see C24. |
| Foreign-chain assets (cross-chain) | **Out of C4's scope** — handled by upstream cross-chain vaults via C25 (Cross-chain integration interface). Passport's account-custody contract custodies Midnight-native assets only. |

## Dependencies

- **C1** — implementation vessel. C4 determines what C1 holds.
- **C5** — signing surface constrained by custody choice.
- **C16** — the stateless shielded pattern makes the wallet-local coin
  store load-bearing: coin info exists only there and in the encrypted
  inbox backup on the contract.
- **C17** — third-party deposit discovery needs an indexer surface;
  the `contractActions` subscription provides the required per-address
  enumeration (verified by the reference implementation).
- **Upstream** — `midnight-js` multi-contract-call utility (the one
  remaining gate on contract ↔ contract Night; the wallet fee-balancing
  side, `midnight-wallet#293`, was resolved by
  [midnight-wallet#334](https://github.com/midnightntwrk/midnight-wallet/pull/334),
  merged 2026/04/21).

## Open questions

**QSCI privacy trade-off (resolved).** The leak is a consequence of the
storage pattern, not of the ledger. Contract-owned inputs and outputs
publish no cleartext value or color, and the node accepts spends whose
`QualifiedShieldedCoinInfo` is supplied as a witness rather than read
from public ledger state (`experiments/stateless-shielded-custody/`,
W1 – W6). Contract custody therefore does not require publishing
holdings, and the accept-or-mitigate question falls away. What remained
was narrower — is the residual metadata profile of stateless contract
custody acceptable? — and is now settled by the custody MIP: the
residue (contract-address activity on every deposit and spend,
depositor first-hop traceability, single comparison bits on the change
branch) is documented and accepted in the MIP's security
considerations, with a witness-private shared-custody profile deferred
to a successor proposal for applications needing a wider anonymity
set.

**Indexer discovery surface (resolved).** The indexer's
`contractActions` subscription replays the complete per-address action
history, so a wallet discovers third-party deposits from the contract
address alone — verified end-to-end by the reference implementation's
discovery suite. The remaining client guidance (subscription vs point
query, identifier matching, `mt_index` candidates) lives in C17; C4's
requirement that discovery work from public chain data alone is
satisfied.

**Compliance posture for inbound shielded transfers.** The shielded
asset model reveals amount to the receiver but not the sender. Any
KYC/AML regime applied at the receiver (source-of-funds attestation,
sanctions-list screening) cannot be satisfied by receiver-side data
alone. Plausible mitigation: sender-side selective-disclosure
credential attached to the transfer — cross-link to **C20**. Open:
which regimes Passport accommodates for v1.0, and whether the
mitigation lives in C4 (custody-side acceptance policy), C20 (proof
shape), or both.

**Asset-class boundary (resolved).** Uniform, exclusive contract
custody for Night and Shielded — the user holds assets no other way
than through the account contract, with in-flight one-hop coins swept
in rather than held. Dust stays outside as the fee path (C24), forced
by the ledger's no-contract-Dust rule, and is not treated as a custody
class. What remains is client guidance: the sweep policy for in-flight
coins and its interaction with the depositor first-hop mitigations.

**Per-device vs. derivation (resolved).** Per-device JubJub keys
directly, mutually independent, no HD tree — set in stone by the
account-authorisation MIP (its seedlessness invariant). Deriving
device keys from a common root would reintroduce the seed-shaped
single point of failure and make one device's compromise a fleet
event.

**Recovery semantics (resolved by construction).** Under contract
custody, assets sit in the contract and never move during recovery: a
recovery bumps the device epoch and changes who satisfies the seam,
and the encrypted inbox lets the recovered client rebuild the coin
store from chain data alone. "Recovered account ↔ recovered assets"
holds structurally; the recovery *mechanism* is the recovery-paths
MIP's subject (C14).

**Cross-contract calls (upcoming toolchain wave).** The ledger-v9
toolchain line introduces Compact-level cross-contract calls. Two
consequences to track: shielded operations in called contracts are
merged upstream but unreleased, so the client-composed direct-transfer
graft gains a principled successor; and called contracts must not
invoke witnesses, which fences the stateless witness-QSCI pattern to
root circuits. Neither affects the standard on the current (v8)
stack; both shape how MIP-0012 composes once the hardfork wave lands.

**OAuth façade compatibility.** Does the chosen custody pattern work
cleanly behind an OAuth-shaped façade (P8 rationale), or does the façade
need a custody-specific adapter?

**Dust fee path.** Delegated to C24 (Fee model). C4 owns the
*custody-side* question (where Dust balances live, if anywhere); the
*fee-payment* question lives in C24.

**Shielded contract ↔ contract feasibility (resolved).** Validated by
`experiments/contract-to-contract-transfer/` (P1 – P3 PASS): one
client-composed transaction pairs the sender's witness-QSCI spend with
the recipient's claim, with no Compact cross-contract calls. The
technical leg of the one-hop rule falls; the privacy leg stands and is
measured — the composed transaction links the two contract addresses
while value, color, and nonce stay hidden. Direct transfer is the
linking-accepted mode; the one-hop route remains the
counterparty-private mode. See the feasibility map above.

## Failure modes

**Residual custody metadata is unacceptable.** Even stateless contract
custody labels every deposit and spend with the contract address, and a
direct contract → contract payment links the two accounts in one
transaction. *Detection:* on-chain analysis correlates account activity
(counts, timing, counterparties) even though values and colors stay
hidden. *Mitigation:* the one-hop user-key routing rule for payments
between custody accounts.

**Change handling persists the wrong coin.** The coin recorded as held
after a partial spend must be live at the end of the transaction; a
coin whose nullifier the transaction revealed is never what survives.
The reference pattern in circulation got this wrong, and
simulator-only tests cannot catch it. *Detection:* the next spend from
change proves successfully and is then rejected by the node with
`NullifierAlreadyPresent`. *Status:* defect reported and fixed
upstream (OpenZeppelin/compact-contracts#656 → #661); the
surviving-coin rule is normative in the custody MIP and its
conformance test 3 is the standing regression gate.

**Inter-contract Night unblock stalls.** The wallet half is resolved
(midnight-wallet#334, merged 2026/04/21), but the `midnight-js`
multi-contract-call utility never ships, or the U2 / U4 re-probe against
a post-fix release still fails. Designs that depend on
contract ↔ contract Night flows remain stuck on user → user routing.
*Detection:* candidate designs fail U2 / U4-shaped probes.

**Address-custody re-introduces seed dependency.** Architecture requires
the user (or a process the user must trust) to reconstruct a seed for
asset operations. *Detection:* P1 violated — seed surfaces in any
user-required flow.

**Hybrid creates cross-class friction.** Mixed-pattern custody requires
multi-step orchestration for common operations. *Detection:* user-facing
flows decompose into multiple proof flows the wallet UI cannot collapse.

**Recovery does not follow assets.** Recovery restores account identity but
not asset access. *Detection:* C14 end-to-end test fails to restore
visible balances.

## Alternatives

**A — Contract-custody (Night + Shielded via OZ pattern).** All non-Dust
assets in C1; per-device Jubjub keys authorise contract calls. Trade-off:
QSCI publicity for contract-held shielded coins. Dust takes a separate
path (see C24).

**A′ — Contract-custody with QSCI mitigations.** Same as A, with privacy
mitigations layered on (padding, dummy entries, value-bucketing, salted
commitments). Cost:
additional contract complexity and on-chain state. Open question: are the
mitigations sufficient, or do they only narrow the leak?

**A″ — Stateless contract-custody (witness-supplied QSCI + encrypted
inbox).** Coin info never enters public ledger state: it lives in the
wallet-local store (C16) and enters the spend circuit as a witness.
Deposits pair `receiveShielded` with an inbox blob encrypted to the
account's advertised encryption key; change is re-owned to the contract
in-transaction, and the re-owned coin is re-captured client-side and
backed up to the inbox. Validated end-to-end
(`experiments/stateless-shielded-custody/`, W1 – W6): observer surfaces
carry zero coin artefacts where the public-state control leaks nonce
and color verbatim. Cost: the wallet coin store becomes mandatory, and
third-party deposit discovery depends on the inbox plus indexer
lookups. Residue: contract-address activity metadata, depositor
first-hop traceability, and single-bit change disclosures.

**B — Address-custody.** Assets at chain-native addresses derived from a
seed-shaped root. C1 holds only devices, grants, and names. Inherits
CIP-1852 or equivalent HD derivation. P1 tension: I-1.1 says "user never
*required* to see or hold seed" — a seed wrapped in C16 and used only by
signing satisfies P1 even if a seed exists.

**C — Hybrid by asset class.** Night + Shielded in contract-custody (per
A); Dust at addresses (or vice versa). May be forced by the Dust gap
regardless of preference for A.

**D — Wait-and-transition.** Hold off until the inter-contract Night fix
and a Dust paymaster API are available. Risk: indefinite — Dust paymaster
has no announced timeline; inter-contract Night fix has PRs but no merge
date.

## Readings

- **MVP (October demo):** B (address-custody) — fastest to ship; sidesteps the
  QSCI publicity question; takes the seed-existing-but-wrapped reading of
  P1.
- **v1.0 deliverable:** A″ (stateless contract-custody) — normative in
  the custody MIP, published upstream as MIP-0012 and realised by the
  reference implementation, and **exclusive**: assets at rest live only in
  the account contract (B and C are rejected as policy, not merely
  deprioritised; Dust remains the ledger-forced fee-path exception).
  QSCI publicity is avoided rather than accepted or mitigated, which
  retires A and A′ as privacy-regressive variants; the residual
  metadata profile is documented and accepted in the MIP's security
  considerations. The cryptographic-stack design downstream of this
  canvas is calibrated to A″ as the v1.0 destination, and the
  authorisation seam it exposes is instantiated by the
  account-authorisation MIP (C5). Note the tension with the MVP
  reading above: the demo's address-custody pick predates the
  exclusivity decision and the prototype's contract-custody
  validation; its migration narrative should land on A″.
