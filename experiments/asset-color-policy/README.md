# Asset-color policies in Passport ACC — experiment only

Can the existing Passport account custody contract require an asset policy
before releasing a native shielded coin? What becomes public, what does the
check cost in `k`, and what happens without a policy contract?

This directory generates four isolated variants of a **pinned ACC source snapshot**, executes
its signature and delegated-grant paths, inspects public contract transcripts,
and measures the generated ZK circuits. Production contracts are not modified.
The current result is **92 ACC probes plus 10 registry-dispatch probes passing**;
see [FINDINGS.md](FINDINGS.md).

For the proposed user experience, three-contract architecture and artifact
distribution design, see [ARCHITECTURE.md](ARCHITECTURE.md). The
[interactive infographic](policy-user-flow-standalone.html) can be downloaded
and opened in a browser. The architecture is a proposal; implemented checks
and remaining integration work are distinguished explicitly.

These are local compiled-contract and VM experiments. Coins, addresses, keys,
and deposits are synthetic. No Zswap membership/spend proof or transaction is
submitted. The small policy, registry and dispatch contracts get real
proving/verifying keys, to make implementation-substitution tests meaningful. ACC variants emit
ZKIR without generating their keys. `k` and row counts come from the ZKIR
compiler's circuit model, not from JS timing or source-code estimates.

## Run

Requires Node.js 22+, npm, and an installed Compact **0.35.0** toolchain.

```sh
cd experiments/asset-color-policy
npm ci --ignore-scripts
npm run experiment
```

Individual stages are `npm run compile`, `npm test`, and `npm run cost`.
The cost stage locates `zkir-v3` in the standard Compact installation; set
`ZKIR_V3=/path/to/0.35.0/zkir-v3` if yours differs. No Docker, network accounts,
wallet seeds, or funded wallets are used. After dependency installation,
the experiment runs offline with the installed toolchain.

## Variants

| Variant | Policy decision | Public lookup identifier |
|---|---|---|
| Baseline | Original ACC authorization only | None added |
| Inline | ACC-local freeze flag after asset-rule lookup | Raw color |
| ExternalRaw | In-circuit call to `Policy.check` | Raw color |
| ExternalTagged | Same call, keyed by a salted color hash | Stable salted tag |

Each instrumented ACC contains a deployment-fixed rule map:

```text
key -> true       policy required
key -> false      explicitly unrestricted
key absent        allow or deny, selected at deployment
```

The external ACC variants use one fixed `Policy` address per ACC. The policy
itself has a per-key freeze map. On Compact 0.35 the compiler specifies the
required interface; runtime 0.20 resolves the deployed implementation through
an application-supplied module provider, checks interface conformance, and
checks the supplied module's verifier keys against deployed state. The inline
control has one local freeze flag for its one configured required asset.

A separate coinless dispatch probe tests the proposed registry architecture:

```text
Dispatch.check(key) -> Registry.resolve(key) -> returned Policy.check(key)
```

It switches between two different compiled policy implementations by updating
the registry, without recompiling the caller. It also tests missing modules,
missing state, incompatible interfaces, verifier-key disagreement, unauthorized
updates, policy denial and stale registry transcript rejection. This probe
establishes dispatch feasibility; it does not add registry routing to the four
full ACC variants or submit a transaction.

The generator adds checks to all three shared release helpers: unshielded
withdrawal, shielded withdrawal to a user, and shielded withdrawal to a
contract. These helpers serve both device arms and both grant arms. For
shielded assets the lookup uses **`coin.color` from the held-coin witness**,
so a caller cannot select an unrestricted color while spending a frozen one.
Original signature, grant-budget, and change-handling code remains in place.

For the tagged variant:

```text
tag = SHA256(pad32("passport:policy-tag:v1") || salt || actual_coin_color)
SHA256(salt) must equal the ACC's deployment-fixed salt commitment
```

The salt enters through a private witness. Its commitment prevents a spender
from choosing another salt to get an unrestricted lookup. This experiment
does not design salt distribution, recovery, or rotation.

## Files and provenance

- [scripts/compile.mjs](scripts/compile.mjs) contains the complete, checked
  ACC patch and pins the source hash. It refuses to run if the reference ACC
  changes, so an upstream edit cannot silently change the baseline.
- [contracts/policy.compact](contracts/policy.compact) is the external policy.
  Its private-preimage admin gate is synthetic experiment scaffolding.
- [scripts/probe.mjs](scripts/probe.mjs) executes the real generated circuits
  and records the behavioral and privacy probes.
- [scripts/registry-probe.mjs](scripts/registry-probe.mjs) tests dynamic
  selection of different policy implementations; its contracts are
  `registry.compact`, `policy-dispatch.compact` and `policy-alternate.compact`.
- [scripts/cost.mjs](scripts/cost.mjs) measures all 12 release entry points in
  each ACC variant, plus six policy/registry/dispatch circuits (54 total).
- `contracts/generated/` and `contracts/managed/` are disposable generated
  sources and compiler artifacts, ignored by Git.
- [evidence/provenance.json](evidence/provenance.json) records reference and
  variant hashes; [evidence/probes.json](evidence/probes.json),
  [evidence/privacy.json](evidence/privacy.json), and
  [evidence/cost.json](evidence/cost.json) record ACC results;
  [evidence/registry.json](evidence/registry.json) records registry checks. Public transcript
  snapshots allow the privacy findings to be inspected independently.

The baseline is generated from `contracts/reference/account.compact`, an exact
copy of `contract/contracts/account.compact` at revision
`f519ff078ad461783baaacd513c1ad7eb6b4555a`,
SHA-256 `1064b1998a71b5ade418f136428d82721e6021d6d939ff2f12797383bb3f8d50`.
The snapshot keeps this experiment reproducible as production evolves. Its
12 release entry points cover the JubJub and k256 device/grant paths; these
results do not establish coverage or costs for newer production paths such
as P-256. The snapshot is experimental input, not a second production contract.
All variants use Compact 0.35.0, ZKIR v3 and Compact runtime 0.20.0. The npm
lockfile also pins the resolved onchain runtime and signing dependencies.
The C2C execution/state-provider pattern follows the existing
[`cross-contract-calls`](../cross-contract-calls/README.md) experiment, migrated
to runtime 0.20's options-object API and explicit module provider;
the Schnorr challenge/grinding scheme follows the ACC's existing signer.

## Scope boundaries

This demonstrates ACC-enforced custody policy. Users can still deploy an
unrestricted ACC or withdraw an allowed coin to an ordinary Zswap key. The
policy does not follow that coin outside participating custody contracts.
No issuer-authenticated mandatory registry, seizure path, individual-holder
freeze, upgrade mechanism, or privacy-preserving eligibility proof is added.

Failures leave the harness's committed ACC state unchanged because it only
commits successful executions. That is not a live-chain atomicity result.
Stale-policy tests additionally replay the actual public policy transcript in
the onchain-runtime VM's verifying mode. Full transaction assembly, proof
verification, fees, chain ordering and indexer visibility remain separate
follow-up work.
