# MIP-0030 · ECDSA Authorisation for Custody Accounts

The [upstream MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md) is canonical. This former
working-draft path is retained so existing links continue to resolve.

Last reconciled: **17 October 2026**.

Published as **Draft**, merged on 16 October through [upstream #374](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/374).
The canonical text replaces the earlier general scheme-registry draft. It
specifies k1 signing envelopes and r1 bounded WebAuthn verification, preserves
existing commitment bytes, and sets **no k1 sunset policy**.

Open work: complete typed signing recipes and independent vectors, common
UV policy and protection across all accepting verifiers, key/scalar enforcement
mapping, cryptographic review, and compatibility with MIP-0021. Compact 0.35
already provides native P-256; `wa-json134` and the single live Safari rotation
are bounded reference evidence. Track acceptance work in [Passport #51](https://github.com/midnightntwrk/passport/issues/51).

See the [standards pipeline](../../plans/MIPS.md) and
[development status](../../plans/STATUS.md) for remaining work.
