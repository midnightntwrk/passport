# Sig.Network Integration Boundary

## Status

Passport exposes a typed Sig.Network settlement adapter, but the current C1
prototype and the public Sig release cannot execute in one Midnight runtime.
The boundary is deliberate: no UI or SDK method reports a bridge operation as
complete without evidence from every protocol stage.

## Required settlement stages

`SigNetworkProtocolAdapter` requires one driver to complete all five stages:

1. submit the Midnight deposit/signature request;
2. wait for the MPC-verified foreign-chain signature;
3. broadcast the signed EVM transaction;
4. wait for the signed execution attestation;
5. submit the Midnight claim and return its transaction hash.

The adapter rejects missing request IDs, serialized transactions, EVM hashes,
attestations, or Midnight claim hashes. It stops immediately when a stage
fails.

## Current compatibility gate

| Surface | Passport C1 prototype | Sig.Network release |
| --- | --- | --- |
| Ledger | v8 | v9 |
| Compact language | 0.23 | 0.25+ |
| Compact runtime | 0.16 | 0.18.0-rc.1 |
| Midnight.js | 4.0.x | 5.0.0 beta |
| ZKIR | v2 | v3 |

The Sig release also requires its Signet singleton, ERC20 vault deployment,
MPC service/root public key, Midnight node/indexer/proof server, EVM RPC, and
ERC20 contract configuration. The published local stack uses a fake MPC and
requires roughly 16 GB of Docker memory.

This is a contract and provider migration, not an npm-only upgrade. Passport
must not import the Sig package into the v8 C1 bundle or present a simulated
route while those runtimes differ.

## Smallest real composition

After the C1 runtime migration, the smallest path composed from currently
proven primitives is:

1. run the official Sig ERC20 vault deposit round trip;
2. claim to the Passport user's shielded Midnight wallet;
3. submit a second real Midnight transaction that deposits the resulting
   shielded coin into the Passport custody contract.

Directly minting to the C1 contract is not yet sufficient. The current vault
claim authenticates the original depositor, and the Passport contract must
record the received coin before its witness-based withdrawal path can use it.

## Inputs required to enable the driver

- Ledger-v9 Passport C1 contract and compatible proof providers;
- deployed ERC20 vault and Signet singleton addresses;
- MPC endpoint and root public key;
- Midnight node, indexer, proof-server URLs, and ZK configuration;
- EVM RPC, chain ID, depositor key, and ERC20 address;
- a tested claim-to-wallet followed by shielded-deposit handoff.

Until these inputs exist, instantiate `BlockedSigNetworkAdapter`. Once they
exist, implement `SigNetworkDepositDriver` with the official Sig reader and
vault flows and keep the five-stage evidence checks unchanged.

## Public references

- [Sig.Network Midnight examples](https://github.com/sig-net/midnight-examples)
- [Sig.Network Midnight integration](https://github.com/sig-net/midnight-integration)
