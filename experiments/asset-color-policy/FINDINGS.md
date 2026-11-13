# Asset policy experiment findings

Measured on 2026-10-22 with Compact 0.35.0, ZKIR v3 and runtime 0.20.0.
The ACC is the pinned source snapshot at `f519ff078ad461783baaacd513c1ad7eb6b4555a`,
included in `contracts/reference/account.compact`. Results cover that snapshot's
12 release entry points, not later additions to the production ACC.
**92/92 ACC probes and 10/10 registry probes pass.**
[ACC results](evidence/probes.json), [registry results](evidence/registry.json)
and [source provenance](evidence/provenance.json) accompany the results.

## Feasibility

An ACC can call a separate policy contract before releasing a native shielded
coin. The external call produces a separate `Policy.check` call-proof entry,
followed by the ACC withdrawal entry. The original device/grant authorization
still runs. The policy does not take custody of the coin and needs neither
its nonce nor its balance for this simple color-wide freeze rule.

The full pinned ACC is instrumented at its three shared release helpers, including
both signature schemes and delegated grants. Frozen spends fail through all
12 release entry points. Both grant schemes also have positive controls for
all three release operations. A caller-supplied unrestricted color cannot
bypass the rule for the actual held coin. Rejected construction does not
commit account nonces or grant budgets in the harness.

This is a per-asset pause in participating ACCs, not a native ledger policy.
Its configuration is chosen at ACC deployment, not certified by an issuer.
The external ACC references identify fixed policy addresses. With Compact
0.35/runtime 0.20, the implementation is resolved at runtime and checked
against the declared interface and deployed verifier keys. Selecting different
implementations through a registry is tested separately below.

## Registry and different policy implementations

A separate coinless caller holds only a registry reference. It calls
`Registry.resolve(key)`, receives a typed `Policy` reference, then calls its
`check(key)` circuit. The registry stores `Map<Bytes<32>, Policy>`.

The probe first selects the per-color freeze-map policy, then an authorized
registry update selects a different compiled implementation using an exact-key
eligibility check and a global enabled flag. Both succeed, their verifier keys
are different, and the caller's keys do not change. A disabled instance of the
second implementation correctly denies the request.

Ten checks cover dispatch, reconfiguration, unauthorized updates, denial,
unregistered colors, missing module/state, module/deployed-key disagreement,
interface mismatch and stale registry state. A registry transcript captured
before a mapping update passes VM replay against its original state and fails
against the updated mapping.

The module provider is application-supplied executable discovery, not an
authority to change the registry's on-chain mapping. Supplying code for the
wrong implementation is rejected against deployed verifier keys. Code
distribution and provider availability still need an application design.

This corrects the earlier 0.34 limitation: **0.35 supports different policy
implementations, not just different instances of one compiled implementation.**
The registry probe has no assets or ACC authorization. Integration into the
full ACC and end-to-end proving/submission remain untested.

## Privacy observations

The measured observer view includes contract addresses, circuit identifiers,
public transcripts, before/after public ledger state, and communication
commitments. It excludes private circuit inputs, outputs, witness outputs,
commitment randomness and complete wallet-local coin data. Positive controls
confirm that the synthetic coin color and nonce actually appear in the
private proving data.

For `withdraw_shielded_with_jubjub` to a user key:

| Variant | Raw color observed | Salted tag observed | Additional policy call | Public transcript operations |
|---|---|---|---|---|
| Baseline | No | No | No | 71 |
| Inline | Yes | No | No | 87 |
| ExternalRaw | Yes | No | Yes | 96 ACC + 9 policy |
| ExternalTagged | No | Yes | Yes | 99 ACC + 9 policy |

The coin nonce, coin value, withdrawal amount, recipient user key and secret
salt are absent as literal markers from these views in all four variants.
These are observations for the tested public surfaces, not a cryptographic
proof of anonymity or resistance to inference. See
[privacy.json](evidence/privacy.json) and the `public-*.json` snapshots.

The raw-color map leaks the asset association in ACC state and the selected
asset on each lookup. Even a successful **absent-key/default-allow** lookup
exposes its key: skipping the external contract does not remove the local
map access's leakage. The corresponding tagged lookup exposes its tag.

The salted variant hides the literal color from an observer without the
salt, but exposes a **stable identifier**. Repeated transfers can be linked
to it, and raw and tagged external variants both expose the policy contract
address and invocation. A dedicated policy contract can identify the asset
by context regardless of hashing. Shared salts permit tag correlation across
accounts; per-account salts complicate issuer-wide rules. The ACC's salt
commitment is itself public, and the issuer, holder and proving service may
know the tag-to-color mapping. A known mapping defeats the intended asset
label hiding. No anonymity-set size is claimed.

The freeze operation exposes the policy key and its Boolean state change.
An unsalted hash would not hide a color from an observer with a dictionary
of candidate colors; the private salt is material here.

The native Zswap output is another observer surface. The local construction
probes confirm contract-recipient outputs contain the recipient contract
address, even though that address need not occur literally in the Compact
transcript. Zswap's `output.contract` is public. The saved
`native-output-owners-*.json` records are explicitly **local construction
observations**, not serialized transaction audits. Direct C2C payments retain
their existing account-linkage tradeoff. Call timing, transaction structure,
change/no-change branches and pre-existing ACC public metadata also remain.

## Circuit cost

The following is the full ACC's JubJub device withdrawal to a shielded user
key, measured by `zkir-v3 mock-compile -v`:

| Variant | ACC rows | Added ACC rows | ACC k | Additional policy circuit |
|---|---:|---:|---:|---|
| Baseline | 50,055 | — | 16 | None |
| Inline | 50,165 | 110 | 16 | None |
| ExternalRaw | 50,295 | 240 | 16 | 147 rows, k=8 |
| ExternalTagged | 56,032 | 5,977 | 16 | 147 rows, k=8 |

The tag costs include verifying the salt commitment and deriving the tag.
The external policy proof is separate; **k values must not be added**.
The policy's synthetic administrator circuit is 2,138 rows at k=13.

All eight shielded entry points (two recipient types, four authorization
paths) retain their baseline k in these variants. On 0.35, the tagged variant
raises k only for the JubJub unshielded device path; the k256 path already
has k=17 in the baseline:

| Entry point | Baseline | ExternalTagged |
|---|---|---|
| `withdraw_unshielded_with_jubjub` | 28,877 rows, k=15 | 34,855 rows, k=16 |
| `withdraw_unshielded_with_k256` | 63,864 rows, k=17 | 69,850 rows, k=17 |

The k256 tagged circuit model has **123,155 lookup-table rows**. The proving domain
must accommodate the compiler's full circuit model. Packing/table choices
can change with source and toolchain changes. The complete 54-circuit measurement,
including table rows and ZKIR hashes, is in [cost.json](evidence/cost.json).

The separate registry dispatch probe measures `Registry.resolve` at 168 rows,
k=8, `Dispatch.check` at 475 rows, k=9, and the alternate policy's `check` at
140 rows, k=8. `Registry.rebind` is 2,224 rows, k=13. These are standalone
circuits; `Dispatch.check` is not the full ACC, so its size is not an ACC
overhead measurement. A registry-routed ACC still needs its own measurement.

No-policy branches still use the same compiled ACC circuit, so they do not
get a smaller root k. They do avoid executing the external call, as observed
by zero policy-state fetches and no callee trace entry. A separate baseline
ACC is the control for removing policy overhead entirely.

These figures are circuit-size measurements. They do not establish proving
latency, fee cost, proof size, throughput or end-to-end transaction cost.
The experiment generates real policy keys but does not prove ACC withdrawals.

## No policy and failure semantics

| Condition | Observed result |
|---|---|
| Explicitly unrestricted registered key | Allowed without resolving the policy |
| Unregistered key, default allow | Allowed without resolving the policy; lookup key still exposed |
| Unregistered key, default deny | Rejected by ACC |
| Registered required policy, no contract state | Rejected during call construction |
| Registered required policy, provider unavailable | Rejected during call construction |
| Registered required policy, different deployed verifier key | Rejected by runtime implementation-binding check |
| Policy exists but has no matching asset rule | Rejected by policy |
| Policy says frozen | Rejected by policy |
| Caller uses a different tag salt | Rejected by ACC's salt commitment check |
| Policy allows, device signature invalid | Rejected by ACC authorization |

All required-policy failure cases are tested with **default allow enabled**:
a failed required check never falls back to the unregistered-asset default.
The wrong-implementation probe installs a genuine verifier key for a different
policy circuit, so it is not a vacuous `--skip-zk` comparison.

The missing-state/provider cases model resolution failures locally. They do
not imply a deployed on-chain policy contract needs an online issuer server:
an issuer offline does not erase an existing contract's state. Indexer/provider
availability can prevent this client from constructing a call.

## Freeze freshness

Both external variants allow a spend, reject subsequent construction after a
freeze, and allow construction after unfreezing. An unauthorized administrative
secret cannot change the policy.

Additionally, each test captures an allowed `Policy.check` public transcript,
successfully replays it against unchanged state in the **onchain-runtime VM's
verifying mode**, then changes the freeze flag and replays the identical
transcript. Both reject with:

```text
mismatch between expected (<[-]: b1>) and actual (<[01]: b1>) read
```

This tests stale-read rejection at the VM boundary. It does not demonstrate
node admission, transaction-wide atomicity, or which of two concurrently
submitted transactions is ordered first. A spend ordered before a freeze is
not retroactively invalidated by this design.

## Assessment and next experiments

The raw external check is small relative to the ACC's existing shielded
authorization circuit, but it gives observers a direct asset label. The
salted version adds roughly 6,000 ACC rows on shielded paths and hides the
literal color in the inspected surfaces, while leaving substantial linkability.
For an exploratory custody feature, both are feasible starting points with
very different disclosure properties.

A useful next comparison would replace public per-color map access with a
private membership/non-membership proof against a policy root, including
explicit semantics for unregistered assets and root freshness. That would
need separate measurement; this experiment does not implement it. Full
localnet proving/submission and raw transaction inspection would then establish
fees, proof timings, transaction-wide failure behavior, and remaining leakage.
Any issuer-mandatory design also needs to prevent exits to unrestricted custody
and define who can configure or upgrade its policies.
