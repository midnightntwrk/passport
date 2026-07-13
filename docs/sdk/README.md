# Passport SDK Foundation

The initial Passport SDK solves one boundary only: securely persist and inject
application-owned private state into a Midnight contract join/deploy flow.
It does not own a wallet seed, act as a cross-chain bridge, or export witness
material.

## Packages and boundaries

| Surface | Role |
|---|---|
| `sdk/` | Encrypted private-state storage, WebAuthn PRF unlock, and typed injection helper. |
| `examples/passport-demo/` | Dynamic embedded-wallet validation and Passport UX reference. |
| `experiments/account-custody-prototype/` | Localnet-only proof of C1/C4 concepts. Not an SDK dependency. |

## Integration

```ts
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from '@midnight-ntwrk/passport-sdk';

const scope = {
  appId: 'com.example.credit-app',
  accountId: passportAccountAddress,
};

const stateStore = new EncryptedPassportPrivateStateStore(
  new IndexedDbPassportEncryptedRecordStore(),
  new WebAuthnPrfKeyProvider(passkeyReference),
);

const { privateState } = await PassportStateInjection({
  store: stateStore,
  scope,
  initialPrivateState: appProvidedPrivateState,
});

await findDeployedContract(providers, {
  contractAddress,
  compiledContract,
  privateStateId: 'credit-scorer-private-state',
  initialPrivateState: privateState,
});
```

`PassportStateInjection` returns decrypted state only after an explicit
WebAuthn user gesture. The app remains the owner of the private-state schema;
Passport owns storage, scope isolation, and encryption.

## Security rules

- A WebAuthn PRF output is immediately derived into a non-exportable AES-GCM
  key. The raw output is zeroed after derivation.
- IndexedDB contains only versioned ciphertext, IV, timestamp, and a hashed
  storage key. It does not contain the app/account scope or plaintext state.
- AES-GCM additional authenticated data binds each record to its `appId` and
  `accountId`; copied ciphertext cannot decrypt under another scope.
- No SDK method exports, logs, syncs, or writes private state to
  `localStorage`. Cloud sync is intentionally absent from this release.
- `WebAuthnPrfKeyProvider` is browser-only. Native secure-store adapters are a
  separate platform implementation, not a browser fallback.

## Architecture

```mermaid
flowchart LR
  App["Integrating app\nprivate-state schema"] --> Inject["PassportStateInjection"]
  Passkey["Passport passkey\nWebAuthn PRF"] --> Key["Non-exportable\nAES-GCM key"]
  Key --> Store["Encrypted IndexedDB\nenvelope"]
  Store --> Inject
  Inject --> Join["deployContract /\nfindDeployedContract\ninitialPrivateState"]
  Join --> Prover["Local witness / proof path"]
```

See [Dynamic capability matrix](dynamic-capability-matrix.md), the
[client-demo runbook](client-demo-runbook.md), the live [validation log](validation-log.md), and the
[blocker register](blockers.md) before describing an integration as live.
