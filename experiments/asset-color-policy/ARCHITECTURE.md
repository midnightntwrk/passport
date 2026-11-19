# Proposed spend policies and artifact discovery

This experiment explores an optional custody rule: a participating Passport
ACC checks an asset policy before releasing a coin. Deposits do not consult
the policy. It does not attach issuer-enforced logic to every native Zswap
coin, and it does not implement seizure. After an allowed withdrawal into
unrestricted custody, this ACC's policy no longer controls that coin.

The proposal uses Compact 0.35.0 and runtime 0.20.0. The
[interactive infographic](policy-user-flow-standalone.html) shows the builder
flow and failure cases; download it and open it in a browser. Its editable
inline source is [policy-user-flow.html](policy-user-flow.html).

## Three contracts

```mermaid
sequenceDiagram
    actor User
    participant Builder as Passport transaction builder
    participant Artifacts as Artifact resolver / cache
    participant Indexer as On-chain state provider
    participant Prover
    participant Network
    User->>Builder: Choose asset, amount, recipient; authorize
    Builder->>Artifacts: Load ACC and registry modules
    Builder->>Indexer: Read ACC and registry state at a block snapshot
    Note over Builder: Execute ACC authorization and Registry.resolve(held coin key)
    Note over Builder: Registry returns a typed policy contract address
    Builder->>Artifacts: Resolve selected policy implementation and load module
    Builder->>Indexer: Read policy state at the same snapshot
    Note over Builder: Check interface / deployed keys; execute Policy.check(key)
    alt Required policy allows
        Artifacts-->>Prover: Matching ZKIR and proving material
        Builder->>Prover: Call trace and private proving inputs
        Prover-->>Builder: Linked call proofs
        Builder->>Network: Balanced transaction with proofs and release
        Network-->>User: Accepted or rejected after validation
    else Policy rejects or required artifacts/state unavailable
        Builder-->>User: Cannot construct authorized spend
    end
```

This is proposed end-to-end wiring, not a trace of a submitted transaction.
The three contract roles are:

| Contract | Responsibility |
|---|---|
| ACC | Retain custody, check device/grant authorization, derive the key from the actual held coin, require the policy before release. |
| Registry | Resolve the asset key to a typed policy reference. Authorized updates may select another implementation. |
| Selected policy | Apply its rule, such as a per-color freeze. It receives the arguments it needs and does not take custody. |

There can be many policy contracts. A single policy can cover several colors;
several addresses can also use one compiled implementation. The ACC knows the
registry address and required policy interface. The builder resolves the
implementation selected by the registry at execution time.

These calls execute in the transaction-building runtime against on-chain
state. They are not requests for an issuer's server to approve each send.
Cross-contract callees cannot invoke witnesses; any private inputs they need
must arrive as caller arguments. The simple freeze policy needs only the key.

## What the transaction builder needs

The end user chooses a payment and authorizes it. The wallet/dApp handles
contract discovery. In this document, the builder is the software executing
the generated circuits; a remote prover is a separate, optional component.

| Input | Consumer | Source |
|---|---|---|
| Generated JavaScript modules, interfaces and version metadata | Builder | Published compiled bundles or local cache |
| ACC, registry and selected policy public state | Builder | Indexer/state provider at a shared block snapshot |
| ZKIR, proving keys and verifier-key metadata | Proving infrastructure and SDK configuration | The matching compiled bundles |
| Authorization and private circuit inputs | Builder/prover as required | User's wallet/private state |

The builder needs access to the selected policy's artifacts, not a copy of
every policy. With remote proving, proving artifacts may be cached by the
service; private proving inputs sent there become visible to that service.
No issuer administrator secret is required to invoke the policy check.

## Two different lookups

```text
On-chain policy registry:
    asset key -> policy contract address

Off-chain artifact resolver:
    network + contract address + deployed circuit identity
        -> immutable manifest
        -> generated module + ZKIR + keys
```

The first lookup chooses which policy has authority over the spend. The
second supplies the code and proving material for that already selected
policy. An artifact directory must not be allowed to substitute its own
policy choice. The deployed verifier keys must be checked against the
selected implementation, including after contract updates; an address-only
cache can become stale.

A minimal follow-up experiment could publish a manifest containing compiler
and runtime versions, circuit identifiers, file sizes and hashes, verifier-key
identities, and locations for the generated module, ZKIR and keys. Builders
would locate the manifest, obtain the bundle from a cache or mirror, verify it
against an authenticated manifest and deployed circuit identity, and register
it with their module and proving-artifact providers. Compact already emits
a compiler manifest with file hashes; deployment-to-bundle discovery remains
application work.

The manifest's identity could be committed by registry metadata or supplied
through a separately authenticated directory. This experiment does not choose
or implement that trust/distribution mechanism. A hash supplied by the same
untrusted download endpoint is not an authenticity guarantee. Generated
JavaScript is executable code: matching a module's declared verifier keys
alone does not make arbitrary downloaded JavaScript safe to execute. Bundle
provenance and execution isolation need an explicit design.

## Failures, privacy and cost

| Situation | Intended behavior / observed boundary |
|---|---|
| Required policy freezes the asset | Reject the spend; existing device/grant authorization cannot bypass it. |
| Required policy code or state cannot be obtained | Stop construction or retry another provider; do not silently allow. |
| No registry entry | The separate registry probe rejects. An unrestricted/default-allow mode would need explicit semantics in an integrated design. |
| Issuer goes offline | Existing policy state remains on-chain; published artifacts can be cached or mirrored. |
| Policy or registry changes after construction | Local VM replay rejects tested stale reads; chain ordering and end-to-end retry behavior remain untested. |

The four ACC variants separately test explicitly unrestricted keys and
unknown-key default allow/deny. These settings never override failure of a
required policy. The registry proposal must preserve that distinction.

Public raw-color lookups reveal the selected asset. A salted key hides the
literal color in the inspected surfaces but remains linkable, and policy
addresses can identify an asset by context. A remote artifact service can
also observe which implementation a builder requests; caching and shared
bundles reduce requests but do not establish anonymity. The registry adds
public routing information; we have not audited an integrated registry-routed
ACC transaction for privacy.

For the measured JubJub shielded-user withdrawal, the direct external raw
policy adds 240 ACC rows with ACC `k=16` unchanged, plus a separate 147-row
policy circuit at `k=8`. Registry resolution independently measures 168 rows
at `k=8`. These are circuit-size measurements, not fees or timings, and the
`k` values must not be added. The integrated ACC/registry cost is unmeasured.
See [FINDINGS.md](FINDINGS.md) for the complete observations and caveats.

## What this PR establishes

| Implemented and locally checked | Still proposed / untested |
|---|---|
| Four variants of the pinned real ACC, all 12 release entry points | Porting the guards to newer production entry points |
| Direct ACC-to-policy calls and failure semantics | Full ACC-to-registry-to-policy integration |
| Registry selects different compiled policy implementations without caller recompilation | Automatic artifact discovery, download, authentication and caching |
| 92 ACC probes and 10 registry probes; VM stale-read rejection | Full withdrawal proofs, transaction assembly and chain submission |
| Public transcript observations and 54 circuit models | Complete transaction privacy audit, fees and proof latency |

The next experiment would connect the two existing probes, supply the
artifact providers from a published manifest, then prove and submit on a
local network. Registry administration, update/revocation rules and whether
custody policies should be issuer-mandatory remain product/protocol decisions.

## Runtime references

- [Compact cross-contract calls](https://docs.midnight.network/compact/reference/compact-reference#cross-contract-calls): module resolution, interfaces, deployed verifier-key checks and witness restrictions.
- [Midnight transaction providers](https://docs.midnight.network/guides/deploy-and-operate#the-transaction-pipeline-and-its-providers): public state, proving artifacts and proof providers.

The local probes and dependency pins are the evidence for this experiment's
specific 0.35.0/0.20.0 behavior; online documentation may evolve.
