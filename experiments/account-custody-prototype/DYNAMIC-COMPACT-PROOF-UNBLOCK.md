# Dynamic Compact proof unblock

Status: **externally blocked** on `@dynamic-labs/midnight@4.93.1`
Audited: 2026-07-23

## Finding

The latest stable Dynamic Midnight package does not expose a public API that
can balance and finalize an arbitrary Compact contract transaction.

The two transaction contracts currently do not line up:

| Boundary | Input | Output |
| --- | --- | --- |
| Midnight.js `ProofProvider.proveTx` | `UnprovenTransaction` | call-proved, unbalanced `UnboundTransaction` |
| Midnight.js `WalletProvider.balanceTx` | `UnboundTransaction` | `FinalizedTransaction` |
| Dynamic 4.93.1 `signTransaction` | transfer-built `UnprovenTransaction` | `FinalizedTransaction` |

Dynamic's public `createTransferTransaction` builds the input accepted by its
`signTransaction`. Passport instead receives an `UnboundTransaction` after the
C1 call proof has been generated. Treating these as interchangeable is
undocumented and fails closed in the demo.

The audit covered:

- `@dynamic-labs/midnight@4.93.1` public types and connector source.
- `@dynamic-labs/waas@4.93.1`.
- `@dynamic-labs-wallet/browser-wallet-client@1.0.70`.
- `@dynamic-labs-wallet/core@1.0.70`.
- `@dynamic-labs/midnight@5.0.0-rc.4`.
- The official [Midnight wallet documentation](https://www.dynamic.xyz/docs/react/wallets/using-wallets/midnight/using-midnight-wallets).

No balanced/unbalanced Compact proof method, capability response, or arbitrary
`UnboundTransaction` input contract exists in those surfaces. The documentation
currently describes the injected 1am path and links to an embedded-wallet page
that is not published. The release candidate retains the same documented
transfer-only transaction shape.

## Demo behavior

The demo probes for a versioned capability before any Compact action begins.
Dynamic 4.93.1 returns:

```text
status: externally_blocked
code: DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_UNAVAILABLE
missingMethods:
  - getMidnightProofCapabilities
  - proveMidnightTransaction
```

The existing transfer-only `signTransaction` is never used as a fallback. When
the capability is unavailable:

- no C1 witness or Compact proof work starts;
- no readable approval is requested;
- no transaction is broadcast;
- the UI receives the explicit blocked error.

The complete real path remains implemented and tested behind the capability:

1. Passport produces the call-proved `UnboundTransaction`.
2. Dynamic returns a balanced `FinalizedTransaction`.
3. Passport validates and hashes the exact returned bytes.
4. Dynamic signs a readable approval containing both transaction hashes.
5. The broadcaster receives exactly the approved finalized bytes.

## Required integration contract

Passport uses the following internal provider contract so the rest of the demo
does not depend on an undocumented Dynamic method. Once Dynamic publishes its
API, a small adapter can map the official method names and response fields onto
this contract:

```ts
const protocol = "dynamic-midnight-compact-proof-v1";

interface DynamicMidnightCompactProofApi {
  getMidnightProofCapabilities(): Promise<{
    protocol: typeof protocol;
    operations: ["balance-and-finalize"];
    inputTransaction: "unbound";
    outputTransaction: "finalized";
    callerBroadcasts: true;
  }>;

  proveMidnightTransaction(request: {
    protocol: typeof protocol;
    operation: "balance-and-finalize";
    network: string;
    walletAddress: string;
    serializedTransaction: string;
    inputTransactionDigest: string;
    intent: {
      network: string;
      contractAddress: string;
      circuit: string;
      summary: string;
      arguments: Record<string, string>;
    };
  }): Promise<{
    protocol: typeof protocol;
    operation: "balance-and-finalize";
    inputTransactionDigest: string;
    finalizedTransaction: string;
  }>;
}
```

Dynamic does not need to use these exact public method names. It does need to
publish equivalent, versioned semantics: accept the call-proved
`UnboundTransaction`, produce a balanced `FinalizedTransaction` without
returning wallet secrets, and document who broadcasts and how pending
reservations are recovered.

`serializedTransaction` is the base64 serialization of Midnight.js'
`UnboundTransaction`. `finalizedTransaction` is a base64
`FinalizedTransaction` containing the balance proofs and binding data, ready for
submission through the caller's backend or transaction adapter.

## Security requirements

- Wallet secret keys and raw key material remain inside Dynamic custody.
- Neither request nor response contains a secret key, key share, seed, or
  private witness.
- Dynamic authenticates the wallet, session, network, and input digest before
  proving.
- The returned input digest must equal the caller-computed SHA-256 digest.
- Proving failures release reservations atomically or return a reversible
  transaction reference.
- Finalized bytes are deterministic for the response and are not mutated
  between approval and broadcast.
- The API documents timeout, retry, idempotency, and pending-transaction
  recovery behavior.

## Completion checks

- [x] Versioned typed provider boundary.
- [x] Runtime capability probe.
- [x] Transfer-only API rejected without fallback.
- [x] Proof response validated against the input digest.
- [x] Exact finalized bytes bound to the readable approval.
- [x] Exact approved bytes passed to the broadcaster.
- [x] Unit contract for the expected Dynamic response.
- [x] Failure tests for missing, incompatible, and failed capability probes.
- [ ] Dynamic publishes and implements the capability.
- [ ] Authenticated localnet proof and broadcast.
- [ ] Authenticated Preview/preprod proof and broadcast.
