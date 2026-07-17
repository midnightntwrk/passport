# Midnight Passport SDK

`@midnight-ntwrk/passport-sdk` is the headless integration layer for Midnight
Passport. It gives applications a stable way to use Passport account state
without coupling them to the reference UI or to a specific wallet provider.

The first implemented slice is private-state storage:

- scope private state by application and Passport account;
- encrypt persisted state with a WebAuthn PRF-derived, non-exportable key;
- persist ciphertext in IndexedDB or an injected record store;
- inject the decrypted typed value only at a Midnight contract join or deploy
  boundary.

The package does not own wallet seeds, render user interfaces, or treat a
third-party authentication session as proof of Passport account authority.

## Install

This package is private while its API is being stabilized. In this workspace:

```sh
npm install
npm run build --workspace @midnight-ntwrk/passport-sdk
npm run test --workspace @midnight-ntwrk/passport-sdk
```

## Current API

```ts
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from '@midnight-ntwrk/passport-sdk';

const scope = {
  appId: 'com.example.app',
  accountId: passportContractAddress,
};

const keyProvider = new WebAuthnPrfKeyProvider(passkeyReference);
const store = new EncryptedPassportPrivateStateStore(
  new IndexedDbPassportEncryptedRecordStore(),
  keyProvider,
);

const injection = await PassportStateInjection({
  store,
  scope,
  initialPrivateState: appInitialState,
});

await deployOrJoinContract({
  initialPrivateState: injection.privateState,
});

keyProvider.lock(scope);
```

Call storage operations from an explicit user action because the browser may
request passkey verification. Call `lock()` when the logical operation ends.

## Security contract

- Plaintext private state and witness material remain in process memory only.
- IndexedDB receives a versioned AES-GCM envelope, never plaintext state.
- Authenticated context binds ciphertext to both `appId` and `accountId`.
- PRF output is immediately derived into a non-exportable encryption key and
  is never persisted by the SDK.
- The package does not write secrets to `localStorage`, logs, analytics, or a
  network service.
- Cloud synchronization and recovery are out of scope until their key
  management and threat models are approved.

## Project status

The public surface is pre-release and may change before `1.0.0`. The private
state primitives are implemented; account, wallet-provider, permission, and
recovery modules are sequenced in the SDK roadmap.

Read the [architecture](../docs/sdk/architecture.md) and
[roadmap](../docs/sdk/roadmap.md) before adding a new module.
