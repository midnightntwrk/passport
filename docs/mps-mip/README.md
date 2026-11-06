# Local MPS and MIP documents

The [standards register](../plans/MIPS.md) owns the publication/status inventory
and canonical links. This directory preserves working drafts, pointers and
historical copies; it does not maintain a second lifecycle register.

## File roles

| Local file | Role and canonical destination |
|---|---|
| [Asset custody MPS](mps/mps-asset-custody-model.md) | Historical copy; upstream MPS-0018. |
| [Domain separation MPS](mps/mps-domain-separation.md) | Historical copy; upstream MPS-0027 / MIP-0021. |
| [Call provenance MPS](mps/mps-call-provenance.md) | Canonical pointer; upstream MPS-0040. |
| [Native asset custody MIP](mips/mip-xxxx-native-asset-custody.md) | Historical copy; upstream MIP-0012. |
| [Account authorisation](mips/mip-xxxx-account-authorisation.md) | Canonical pointer; upstream MIP-0013. |
| [Account recovery](mips/mip-xxxx-account-recovery.md) | Canonical pointer; upstream MIP-0022. |
| [Signature schemes](mips/mip-xxxx-signature-schemes.md) | Canonical pointer; upstream MIP-0030 supersedes the former general registry draft. |
| [Prover-key regeneration](mips/mip-xxxx-prover-key-regeneration.md) | Canonical pointer; upstream MIP-0020 under MPS-0039. |
| [Scoped grants](mips/mip-xxxx-scoped-grants.md) | Local draft; spend scope, lifecycle, connection ceremony and CAIP-25/OWS mapping. |

The broader [circuit-artefact reproducibility draft (PR #172)](https://github.com/midnightntwrk/passport/pull/172)
is reviewed separately and is not included here. It extends beyond published
MIP-0020; historical measurements retain their original scope.

## Working rules

Numbered upstream documents are canonical even where a historical local copy
has an unnumbered Draft header. Preserve those copies and anchors for
provenance; use the visible upstream pointer for normative interpretation.
Pointers retain former filenames to keep incoming links valid. They are not
full snapshots and must not be cited for sections they no longer contain.

Unnumbered drafts remain editable. Preserve explicit open questions and
evidence limits. A draft header does not establish publication, acceptance,
implementation or deployment. New normative changes to numbered standards
belong upstream; record local implementation differences in the reference
README and arc42. Consult the standards register and MIP-0001 before submission.
