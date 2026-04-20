---
name: Transaction submission findings
description: Key findings about Midnight transaction submission from Rust — ongoing investigation
type: project
---

## Status: Custom error 1 (Deserialization) from node

The node rejects our proven transaction with `Custom error: 1` = `Deserialization`.
Both tagged and untagged serialization formats fail with the same error.

### What Works
- Proof server `/prove-tx` accepts our transaction and returns a 7301-byte proven tx
- The tag is `midnight:transaction[v9](signature[v1],proof,embedded-fr[v1]):` — correct
- The Substrate extrinsic encoding is correct (pallet=5, call=0)
- The node parses the extrinsic (no more WASM traps)

### What Fails
- The node can't deserialize the Midnight transaction bytes
- Error: `Custom error: 1` = `Deserialization` in pallet_midnight

### Hypotheses (in order of likelihood)
1. **Initial state format mismatch** — our `stval!([null, null, null])` doesn't match
   what the Compact compiler generates (the constructor runs a circuit that writes
   `registered=false` and `tx_count=0` into the transcript, which modifies the state)
2. **Missing constructor transcript** — the Compact deploy runs the constructor circuit
   which produces a transcript. Our deploy has no transcript/proof for the constructor.
3. **Binding type mismatch** — the node expects a different binding type than `embedded-fr`
4. **Version mismatch** — the midnight-ledger crate (v8.1.0-rc.1) doesn't match
   the proof server (v8.0.2) or node (ledger v=8.0.2)

### Next Steps
- Capture actual TS SDK extrinsic bytes and compare
- Check if the constructor circuit needs to be proved and included in the deploy
- Verify midnight-ledger version matches the devnet

**Why:** Midnight transaction validation is strict about format. Without access to
the pallet source code, we need to compare against known-good transactions.

**How to apply:** Try capturing the TS deploy bytes by adding logging to the
wallet-sdk-node-client, or use the indexer to fetch a known deploy transaction's
raw bytes and compare format.
