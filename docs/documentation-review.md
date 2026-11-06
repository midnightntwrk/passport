# Documentation reconciliation — 2026/11/06

## Review basis and provenance

The earlier documentation review described the old branch at `f519ff0`, forked
from `55aa287`. Its local-code checks did not establish that it reflected main;
its “reviewed against” wording also failed to distinguish committed source
from uncommitted documentation. That review is superseded by this record.

The documentation changes were replayed and reconciled in an isolated worktree
on **freshly fetched Passport main
[`fc19e471536febb2133f20e817847251622dcdf5`](https://github.com/midnightntwrk/passport/tree/fc19e471536febb2133f20e817847251622dcdf5)**.
The original branch and its uncommitted/untracked work were preserved. These
revised documents are subsequent changes, not content in the cited baseline.

Canonical MIPs/MPSs were separately cloned and inspected at
[`02fce36cfa44541305310dc25fd38f399dbe8d92`](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/02fce36cfa44541305310dc25fd38f399dbe8d92).
The [standards register](plans/MIPS.md) records the lifecycle observations and
links current upstream documents. This was not a fresh audit of all open PRs,
issue discussions, deployed accounts or product releases.

Implementation claims were checked against source, the main
[contract guide](../contract/README.md), and committed dated evidence,
particularly [the 23 October combined-account record](../contract/GRANTS-COMPLETION.md).
No contract tests or localnet deployments were rerun for this documentation
change. Prior results retain their own dates, source hashes and limitations.

## arc42 assessment

[arc42](arc42.md) follows the
[official twelve-section structure](https://arc42.org/overview/), in order,
and supplies the intended kinds of information. It is an architecture reference,
not a certification of standards conformance or production readiness.

| Sections | Assessment / change |
|---|---|
| 1–2: goals, stakeholders and constraints | Distinguishes target requirements from implementation; includes P5′ and P11–P16, toolchain/profile and deployment constraints. |
| 3: context and scope | Defines the boundary, communication partners and technical interfaces; adds a context diagram. |
| 4: strategy | Connects quality drivers to mechanisms, trade-offs and known limits. |
| 5: building blocks | Adds hierarchical reference-source decomposition, interfaces and a Level 2 account diagram. Product canvases remain a separate functional inventory. |
| 6: runtime | Includes creation, spend, removal, grants, recovery and failure/startup scenarios; adds a sequence diagram and links the corrected creation flow. |
| 7: deployment | Maps software to client, chain, services and reference-localnet infrastructure; identifies open production decisions. |
| 8: crosscutting concepts | Fixes heading/paragraph spacing and wrapping; covers secrets, viewing state, domains, freshness, providers and artefacts. |
| 9: decisions | Adds C9, C13, C23 and C24; preserves the owning canvases/ADR and their decision status. |
| 10: quality | Scenario table states stimulus, response/measure and evidence limits; prioritised quality goals group these scenarios. Measurable operational SLOs remain open. |
| 11–12: risks and glossary | Distinguishes current defects from evidence gaps and historical issues; corrects scheme and CAKE terminology. |

Missing diagrams were presentation gaps, not automatic template violations:
arc42 permits a [context table](https://docs.arc42.org/section-3/) and
[textual runtime scenarios](https://docs.arc42.org/section-6/).
The [building-block guidance](https://docs.arc42.org/section-5/) calls for a
hierarchical decomposition, which is now explicit. Production topology, SLOs
and assigned operational ownership remain content to develop, not facts to invent.

## Reconciliation of the reported findings

| Finding | Resolution |
|---|---|
| Obsolete implementation baseline | Main has schema v3, 52 circuits, JubJub/k256/p256 arms, caller pins and two-phase recovery. Architecture, runtime flow, affected canvases and current site summaries now reflect that baseline. |
| Recovery absent / epoch bump sufficient | The absent gate was a historical MIP-0013 §8 MUST gap. Main clears the device set before successor insertion. Q4/R2 explain erratum 7, I-5.4 and pending/future-epoch entries, plus bounded node evidence. Individual-device erratum 8 remains separate. |
| Funded unshielded grants “off-node only” | E4 records JubJub/k256 node spends; the 23 October combined-account record adds P-256 unshielded spends. Successful P-256 shielded/forwarded grants are not established by that run. |
| Q2 custody privacy | Narrowed to the schema-level requirement and inspection support. The leak audit's aggregate control does not validate every account-state surface or value encoding; no blanket all-surface privacy conclusion. Uses the exact protocol term `color`. |
| Q6 signer interoperability | Links offline JubJub/k256 coverage and the k256-only node suite separately. Identifies the missing committed raw receipt; source code is not proof of a run. |
| Device removal / grants | States grant draft §7.3's client obligation to call `revoke_all_grants` on suspected compromise. Entry removal does not automatically revoke grants or all entries of the key. |
| Bootstrap deviation | Records erratum 2 / upstream #250. Current canonical MIP-0013 §3 now specifies the boot-commitment activation design, so it is no longer an outstanding deviation. Flow uses all five constructor arguments and warns that the default discarded birth secret does not provide usable recovery. |
| Signature tags and terminology | Links the former draft's canonical MIP-0030 pointer. Maps code k256/p256 to k1/r1; current upstream agrees on v2 boot/device commitments versus v1 operation tags. No invented k1 sunset policy. |
| CAKE expansion | Confirmed **Chain Abstraction Key Elements** from [Frontier Research](https://frontier.tech/the-cake-framework). Applications, Permission, Solver and Settlement are its layers. Corrected glossary and component index. |
| Missing standards | Register and architecture now cover MPS-0018/0027/0039/0040, MIP-0003/0008/0020/0021/0022/0030, plus adjacent MIP-0025. MIP-0021 is freshly verified Proposed; recovery includes C13. |
| Naming status | “Passport adopts MIP-0007 (Proposed upstream)” distinguishes local adoption from upstream lifecycle. |
| Device-identity remedy misattribution | Corrected register, C1/C13 and site summaries. It is MIP-0013 review work; neither grant schema v2 nor v3 implements it. |
| OWS mapping listed as undrafted | Register/site now acknowledge grant §§11.1–11.2's CAIP-25/OWS mapping. Transport/discovery integration, interoperability and acceptance remain separate. |
| Expired milestone and requirements count | Plans index labels October as historical delivery framing, not a live hard date; includes security promises. Site labels its P1–P10 cards as the original subset and links the full requirements. |
| Duplicate canonical banners | Kept main's single banners in the custody/domain MPS copies. Canonical pointers and historical snapshots have distinct roles in the local index. |
| Missing committed documentation targets | The documentation map and this review accompany arc42; the broader artefact MPS is linked through its separate PR #172. No new reference depends on private/untracked files. |
| Uncommitted evidence and failed determinism log | Old deploy-activate/device-secret probes are not promoted to evidence for main. The error-only determinism output is not cited or carried into this worktree. Original untracked material remains preserved with the original checkout. |

## Consolidation and preservation

[The documentation map](README.md) assigns one owner per information type:
architecture, requirements, decisions, standards, implementation and evidence.
The root README routes readers there. Local standards files retain their roles
and incoming filenames; numbered proposals remain canonical upstream. The
broader [circuit-artefact MPS remains in PR #172](https://github.com/midnightntwrk/passport/pull/172).
This change does not absorb that PR or include a competing copy of its draft;
its older 30-circuit measurements remain distinct from the current account.

Research and inherited principles remain historical material with notices.
Upstream-owned subtrees, archived plans, demo/experiment evidence and human-only
`RESEARCH.md` were not rewritten to resemble the current implementation.
In particular, earlier DeRec/threshold-service/single-seed designs are lineage,
not current architectural authority. Dated status/timeline entries remain
historical; current summaries point to later evidence.

## Validation and remaining limits

Completed checks:

- **388 relative links across 70 active Markdown documents:** paths, anchors,
  and tracked file targets resolve (excluding upstream-owned subtrees,
  archived plans, and the ADR template).
- **Six Mermaid diagrams parse**, and all twelve numbered arc42 sections
  appear in the official order.
- **15 canonical standards paths resolve** in the pinned upstream checkout;
  all tabulated lifecycle statuses match those document headers.
- **Site integrity checker passes** (`node site/check.js`).
- Source spot-check confirms **52 distinct non-pure circuits, schema v3, the
  five-argument constructor, and device reset before successor insertion**.
- Whitespace and conflict-marker checks pass. Changes are documentation and
  site presentation only; there are no contract or test-code changes.

These checks do not imply fresh runtime tests, independent cryptographic
review, or visual rendering of the diagrams in every Markdown viewer.

Remaining substantive work includes per-surface leak controls, the missing
signer receipt, broader recovery/P-256 evidence, identity-wide device revocation,
MIP-0021 byte compatibility, cryptographic review, and usable recovery/viewing
material lifecycle. Existing deployments do not change when documentation or
source changes. I-8.1's literal “chain state alone” still needs reconciliation
with required private signing/viewing material. Production SLOs, ownership and
operating procedures remain unassigned.
