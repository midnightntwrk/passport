# MIP-0013 · Multi-key Account Authorisation for Custody Contracts

The [upstream MIP-0013](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) is canonical. This former
working-draft path is retained so existing links continue to resolve.

Last reconciled: **17 October 2026**.

Status: **Proposed**. [Upstream #385](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/385), merged 15 October,
amends section 8 and AUTH-6 alongside MIP-0022: recovery finalisation must
atomically retire all prior device entries and install only the authorised
successor. Opaque entries with unchecked epochs must be cleared or subject to
an equivalent contract-assigned registration-epoch check. An epoch bump alone
is insufficient; entries enrolled during the pending phase are included.

[Passport #183](https://github.com/midnightntwrk/passport/pull/183) implements the reset. Its evidence is Compact
0.35 compilation with key generation skipped and simulation. Regenerated keys,
proof/node validation, deployment-wave sizing and the expanded retirement
matrix remain outstanding. Existing deployments need a corrected verifier or
migration; the specification merge does not update them. Individual-device
revocation (erratum 8) and key-admissibility review remain separate.

See the [standards pipeline](../../plans/MIPS.md) and
[development status](../../plans/STATUS.md) for remaining work.
