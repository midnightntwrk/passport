# Temporary Jubjub approval for the first passkey

This implements the local [MIP-0013 amendment](../docs/mps-mip/mips/mip-0013-temporary-jubjub-bootstrap-amendment.md)
for [Passport #213](https://github.com/midnightntwrk/passport/issues/213).
The amendment is still being reviewed in [#215](https://github.com/midnightntwrk/passport/pull/215).
Production SDK integration belongs to
[midnight-passport-sdk #140](https://github.com/midnightntwrk/midnight-passport-sdk/issues/140).

The constructor needs the temporary public key's commitment, network domain,
WebAuthn policy, independent viewing key, and birth-recovery configuration.
It does not need the final passkey. After deployment, registration uses the
raw 32-byte contract address as WebAuthn `user.id`. Both signing operations
happen locally: first a supported WebAuthn assertion, then a temporary Jubjub
signature approving that exact installation. Proving receives those approvals.

## Contract and compatibility

The schema-4 constructor appends `initial_bootstrap_mode: Uint<8>` and
`initial_bootstrap_network: Bytes<32>` to the existing five arguments. Both
values are sealed. Mode 0 requires a zero network domain and retains the
legacy per-arm commitment recipes. Mode 1 requires a nonzero commitment and
network domain, and uses `activate_initial_passkey`. Unknown modes and
cross-mode activation fail. Existing schema-3 deployments require their old
ABI and artefacts; this change provides no in-place migration or mode reset.

[`account-bootstrap.compact`](contracts/account-bootstrap.compact) fixes format
1, P-256 scheme 2, and WebAuthn profile 1. Its exact-length MIP-0021 tags and typed
hashes bind the network, account address, constructor commitment, temporary
public key, final passkey, RP/origin policy, epoch, and authorisation nonce.
The passkey challenge and Jubjub signature challenge have separate tags.
The circuit recomputes the intent and final device entry; callers cannot
substitute an opaque digest or entry.

The circuit requires a pristine device set/count/epoch/nonce, checks nonidentity
Jubjub points and canonical response/challenge scalars before reducing casts,
and verifies both signatures. WebAuthn enforces the existing bounded
`wa-json134-or-chrome243` profile, including UP+UV. Success atomically installs
one epoch-0/counter-0 entry, clears `boot`, sets `booted`, and increments `round`
once. It leaves `auth_nonce`, viewing state, balances, inbox, grants, and recovery
state unchanged. `round` is deliberately absent from the intent, so deposits
do not invalidate retained approvals.

Recovery finalisation consumes bootstrap authority in either mode. Activation
during pending recovery preserves the recovery record and deadline, allowing
the new device to use ordinary veto. Without veto, finalisation can still
replace the new device. Neither path resets bootstrap.

## Reference client and interrupted onboarding

[`signed-bootstrap.ts`](src/wallet/signed-bootstrap.ts) separates temporary
signing material from the serialisable onboarding record. The record retains
the deployment context, credential metadata, and complete validated approvals.
`CustodyAccount.deployPasskeyDormant` deploys mode 1 without a passkey; the
resulting session exposes `userId` and a browser-registration helper. The
caller supplies trusted chain observation, deployment verification, and durable
storage callbacks. Deployment verification must check the intended verifier
roster and maintenance authority before signing.

The reference mode-1 client accepts an RP ID equal to the origin hostname,
with HTTPS or `http://localhost`, within the fixed 21-byte origin profile.
It does not support parent-domain RP IDs: a suffix-only check would wrongly
accept public suffixes and could seal an unusable policy before registration.
Browser calls also require the configured origin to match the current secure
context. Broader RP-domain support requires a proper registrable-domain check.

The deployment checkpoint is persisted before first submission. It retains
the serialised deployment intent, including its randomised identity; rebuilding
`ContractDeploy` from the same state would produce another address. The
maintenance signing key and private viewing state stay in the protected
`privateStateProvider`, which must be durable for recovery across processes.
`CustodyAccount.resumePasskeyDeployment` compares installed verifiers with the
trusted artefacts, completes missing waves, and checks the retirement policy.

The browser adapter persists the created credential before its trial assertion.
Known credential IDs can be passed through `excludeCredentials`; that safeguard
only applies to the authenticator holding them. The onboarding record also
blocks a second registration, including on another authenticator. Explicit
discard of an unsupported unsigned candidate is separate from automatic retry.
The full assertion is checked locally before temporary approval is produced.
After approval, retries must retain the same target and complete signature
tuple; they do not need the temporary secret. Signing again samples a fresh
nonce instead of reusing a nonce with a different challenge.

Sessions sharing one in-memory record share a registration reservation and
recheck the record immediately before contacting the authenticator. Integrators
must also atomically reserve onboarding per account in durable storage when
multiple tabs, processes, or separately deserialised records can operate on it.

Completion can be recovered after another session has used the account. Once
the bootstrap commitment is consumed, the client verifies the original
epoch-0/counter-0 installation from contract-action history when the live
roster has advanced. It does not require current counters or device counts to
remain at their activation values. Missing history leaves completion
unconfirmed and can be retried. Recovery replacement raises the distinct
`BootstrapRecoveryReplacedError`; registering restored credential metadata
does not bypass ordinary checks of current device membership.

Erasure removes the in-memory reference only; the caller must also remove its
protected durable copy after confirming intended activation or recovery
consumption. JavaScript does not guarantee zeroisation of prior copies. Loss
of both temporary key and retained approval requires independently usable
recovery or abandonment. The reference default discards its birth-recovery
secret, so it does not establish usable recovery. Keep viewing and recovery
material independent of the not-yet-created credential.

## Security boundaries

- A prover receives authority for one fixed installation, not either signing
  key. Exposure of the temporary secret before consumption permits approval
  of a different passkey, so protected local storage remains necessary.
- An observer can relay the exact approved activation. That installs the same
  device and cannot grant the relayer device authority. Atomic one-time
  consumption prevents a competing approval from installing a second device.
- The network domain commits to configured CAIP-2 identity, genesis, and a fixed
  instance anchor. The client must compare these with a trusted chain adapter.
  Compact has no authenticated chain-identity primitive; an identical-state
  clone using the same configured domain is outside that guarantee.
- The temporary key and signature point must be prime-subgroup points. The
  explicit identity and `[8]P` checks are insufficient by themselves to prove
  subgroup membership; exact operand binding and the pinned backend's native
  point constraints matter. Evidence below identifies the tested boundary.
- A live maintenance authority can replace verifier keys and bypass account
  authorisation. Finish and verify the deployment waves, and apply the stated
  retirement policy before approval. Neither a valid commitment nor a valid
  user handle authenticates an untrusted deployment.
- Address-bearing user handles expose an account association to the RP and
  authenticator. `user.id` is discovery metadata, not attestation or on-chain
  authorisation. Hardware/browser coverage remains limited to the explicitly
  recorded evidence; the bounded profile does not accept arbitrary WebAuthn
  JSON, extensions, or origins.

## Reproduction and evidence

Use the pinned dependencies and Compact 0.35.0 / ZKIR 3.1.0-rc.1 toolchain.
For offline checks, generate runtime outputs with `npm run ci:compile`, then
run `npm run build` and `npm run test:signed-bootstrap-offline`.
`npm run ci:reference` includes the new offline suite and existing regressions.

For proving, compile real keys with `npm run compile`, start the local stack
described in the [reference README](README.md), and run
`npm run test:signed-bootstrap-keyed` and `npm run test:signed-bootstrap`.
The keyed test uses real verifier decoding with mocked provider reads; the
conformance test submits transactions. Set `EVIDENCE_DIR=evidence/signed-bootstrap`
to keep this run separate from earlier evidence. `npm run measure:signed-bootstrap`
checks every compiler-manifest artefact and runtime verifier-key hash before
recording circuit sizes and key identities. `ZKIR_BIN` selects the pinned
native binary. Shape measurement uses `mock-compile`; it is distinct from
the real proving and node verification recorded by the conformance runner.

The [evidence directory](evidence/signed-bootstrap/) records the actual run
and requirement coverage. Successful simulations, proofs, and node transactions
provide bounded validation, not a formal proof of cryptographic soundness.
