# Why Passport cannot currently use only Dynamic

## Short answer

Dynamic can create the embedded Midnight wallet and exposes transaction signing
and submission methods. This demo has **not yet confirmed** that Dynamic can
prove and submit an arbitrary Passport C1 deployment on-chain. Dynamic also does
not provide Passport with documented secure storage for the private C1 witness.

The demo's Passport passkey does not replace Dynamic and does not sign the
Midnight transaction. It unlocks the encrypted private witness. The demo then
asks Dynamic to sign and submit; that custom-contract path remains a live test.

## The two separate authorities

| Responsibility | Current owner |
|---|---|
| Create the embedded Midnight wallet | Dynamic |
| Expose unshielded, shielded, and DUST addresses | Dynamic |
| Attempt custom C1 signing/proving/submission | Dynamic connector; live validation pending |
| Create the Passport C1 device witness | Passport |
| Encrypt and unlock that private witness | Passport passkey |
| Record device membership and permission state | Passport C1 pilot contract |

The C1 contract stores only a commitment to the device secret. Calls such as
`add_device`, `register_permission`, and `revoke_permission` require the private
`device_secret()` witness. The secret must remain available after deployment,
but it must never be written to plaintext browser storage.

## What happens during deployment

1. Dynamic authenticates the user and provisions the Midnight wallet.
2. Passport creates a random device secret.
3. A WebAuthn PRF passkey derives a non-exportable encryption key.
4. Passport encrypts the device secret in IndexedDB.
5. Passport builds the C1 deployment using the secret's public commitment.
6. The demo asks Dynamic to sign, prove, and submit that deployment transaction.
7. Later C1 operations unlock the encrypted witness with the Passport passkey.

The demo therefore needs a private-state key provider. WebAuthn PRF is the
current provider; it is an architectural choice, not a universal SDK requirement.

## Why Dynamic alone is insufficient today

The installed Dynamic Midnight connector exposes wallet addresses, balances,
message signing, transfer construction, `signTransaction`, and
`submitTransaction`. It does not expose a documented application API for:

- storing an arbitrary Passport witness securely;
- deriving an application encryption key without exporting wallet key material;
- restoring that witness across sessions or devices;
- injecting app-private witness state into later Compact contract calls; or
- authorizing C1 device and permission operations independently of wallet
  transfers.

Dynamic's `signTransaction` is also documented as the proving/signing step in
its transfer flow. Our custom C1 deployment uses the generic serialized
transaction method, but arbitrary Compact deployment support must still be
validated live before it can be called supported production behavior.

## Can we remove the passkey?

Yes, but one of these architectural changes is required:

1. **Dynamic adds a supported Passport private-state facility.** It would need
   app-scoped encryption or witness storage, recovery behavior, and a supported
   custom Compact transaction bridge.
2. **Redesign C1 around Dynamic wallet signatures.** The contract would verify
   wallet-controlled authorization instead of the private `device_secret`
   witness. This is a different account model and requires a Foundation-level
   contract and recovery review.
3. **Put the witness on a trusted backend or MPC service.** This removes the
   browser passkey but adds a server custody dependency and changes Passport's
   trust model.

Storing the witness in `localStorage`, bundling it with the application, or
deriving it from public wallet data is not an acceptable option.

## What Dynamic needs to provide

For Passport to work with only the Dynamic embedded wallet, Dynamic needs to
close these specific gaps:

1. **Official arbitrary Compact transaction support.** Document and support
   signing, proving, and submitting contract deployment and circuit-call
   transactions supplied by a dApp, not only transactions created by
   `createTransferTransaction`.
2. **App-scoped private-state protection.** Provide either a non-exportable,
   wallet-bound key-derivation API or encrypted blob storage for Passport's C1
   witness. It must be scoped by Dynamic user, Midnight wallet, application,
   and network.
3. **Private-state lifecycle.** Define creation, unlock, rotation, logout,
   account recovery, new-device enrollment, wallet replacement, and deletion.
   Public wallet addresses are not enough to recover a private witness.
4. **No private-key-export dependency.** Midnight address reads, signing,
   proving, and custom contract calls should work through Dynamic's secure
   wallet service without requiring the dApp to enable or handle wallet private
   key exports.
5. **Custom contract approval UI.** The user should see that they are deploying
   or calling a Passport contract, which network is targeted, the contract
   address or artifact, and the requested operation before approval.
6. **Failure and recovery APIs.** Return stable transaction identifiers and
   structured errors for proving, signing, submission, expiry, and pending-state
   recovery so Passport can safely resume an interrupted deployment.
7. **Integration documentation and test environment.** Publish a complete
   Passport-style example covering custom contract deployment, private witness
   restoration, subsequent circuit calls, and multi-session recovery on a
   supported Midnight testnet.

The minimum unblocker is items 1 and 2. Without arbitrary Compact transaction
support, Dynamic cannot reliably deploy or operate C1. Without app-private
state protection, Passport still needs its own passkey or another trusted
custodian for the C1 witness.

## Current conclusion

We do not yet have live evidence that Dynamic supports arbitrary Compact
deployment transactions. Even if that transaction path succeeds, Dynamic alone
does not make the current Passport C1 usable afterward because its device and
permission circuits require private witness state that Dynamic does not manage.

The clean current boundary is:

> Dynamic owns wallet authentication and exposes transaction authorisation.
> Passport's current WebAuthn provider protects the private C1 witness. The C1
> pilot records device membership and permission state on Midnight.

## Implementation references

- C1 witness and permission circuits:
  `examples/passport-demo/contracts/passport_c1.compact`
- C1 deployment adapter:
  `examples/passport-demo/src/c1.ts`
- Encrypted Passport storage:
  `sdk/src/store.ts`
- WebAuthn PRF key provider:
  `sdk/src/passkey.ts`
- Dynamic capability matrix:
  `docs/sdk/dynamic-capability-matrix.md`
