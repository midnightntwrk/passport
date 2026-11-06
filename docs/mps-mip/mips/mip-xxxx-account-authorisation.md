# MIP-0013 · Multi-key Account Authorisation for Custody Contracts

The [upstream MIP-0013](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) is canonical. This former
working-draft path is retained so existing links continue to resolve.

Last reconciled: **2026/11/06**.

Status: **Proposed**. [Upstream #385](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/385), merged 15 October,
amends section 8 and AUTH-6 alongside MIP-0022: recovery finalisation must
atomically retire all prior device entries and install only the authorised
successor. Opaque entries with unchecked epochs must be cleared or subject to
an equivalent contract-assigned registration-epoch check. An epoch bump alone
is insufficient; entries enrolled during the pending phase are included.

[Passport #183](https://github.com/midnightntwrk/passport/pull/183) implements the reset.
The [23 October combined-account record](../../../contract/GRANTS-COMPLETION.md)
includes two corrected recoveries on-node, with source matching main `fc19e47`.
It reused matching cached keys after textual ZKIR comparison. Clean key
regeneration and the expanded adversarial retirement matrix remain separate.
Existing deployments need the corrected verifier or migration; publication
changes no deployed state. Individual-device revocation (erratum 8) remains
open and was not fixed by either grant schema version.

The boot-commitment activation design (erratum 2, upstream #250) is now in
canonical §3. See the [standards register](../../plans/MIPS.md) for the pinned
upstream revision and remaining compatibility/review work.

See the [standards pipeline](../../plans/MIPS.md) and
[development status](../../plans/STATUS.md) for remaining work.
