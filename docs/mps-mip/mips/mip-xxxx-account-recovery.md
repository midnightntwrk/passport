# MIP-0022 · Recovery Paths for Custody Accounts

The [upstream MIP-0022](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md) is canonical. This former
working-draft path is retained so existing links continue to resolve.

Last reconciled: **17 October 2026**.

Published as **Proposed** through [upstream #339](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/339).
Authors: Nicolas Di Prima and Raphael Toledo. [Upstream #385](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/385)
amends finalisation and REC-8 to require atomic retirement of all prior device
entries, including entries enrolled during recovery's pending phase.

The signature-based two-phase reference is merged in [#165](https://github.com/midnightntwrk/passport/pull/165);
the device-set reset is merged in [#183](https://github.com/midnightntwrk/passport/pull/183). Earlier on-node
receipts predate the reset. The correction has compilation/simulation evidence;
regenerated keys, proof/node validation, deployment sizing and expanded
retirement cases remain. Multi-session cryptographic review, guardian transport,
interoperability and viewing-wrap freshness/rotation remain under [#62](https://github.com/midnightntwrk/passport/issues/62).

See the [standards pipeline](../../plans/MIPS.md) and
[development status](../../plans/STATUS.md) for remaining work.
