---
name: midnight-sdk-guide
description: TypeScript SDK integration guide for Midnight dApps. Use this skill when building frontends, connecting wallets, or calling contracts from TypeScript. Triggers on "SDK", "TypeScript", "wallet integration", "connect dApp", "call contract".
license: MIT
metadata:
  author: webisoft
  version: "1.0.0"
  midnight-version: "0.27.0"
---

# Midnight TypeScript SDK Quick Reference

Guide for integrating Midnight contracts with TypeScript applications.

## When to Use

Reference this guide when:
- Building a frontend for a Midnight dApp
- Connecting the Lace wallet
- Deploying or calling contracts from TypeScript
- Handling errors from the SDK
- Building transaction flows

---

## Installation

```bash
npm install @midnight-ntwrk/midnight-js-contracts
```

---

## Core Types

### Contract Deployment

```typescript
import { deployContract, ContractDeployment } from '@midnight-ntwrk/midnight-js-contracts';

const deployment: ContractDeployment = await deployContract({
  contract: compiledContract,
  privateState: initialPrivateState,
  args: constructorArgs,
});

const { contractAddress, initialState } = deployment;
```

### Contract Interaction

```typescript
import { callContract } from '@midnight-ntwrk/midnight-js-contracts';

// Call a circuit
const result = await callContract({
  contractAddress,
  circuitName: 'increment',
  args: [amount],
  privateState: currentPrivateState,
});

// Result contains new state and return value
const { newPrivateState, returnValue, proof } = result;
```

### Providers

```typescript
import {
  MidnightProvider,
  createMidnightProvider
} from '@midnight-ntwrk/midnight-js-contracts';

const provider = await createMidnightProvider({
  indexer: 'https://indexer.testnet.midnight.network',
  node: 'https://node.testnet.midnight.network',
  proofServer: 'https://prover.testnet.midnight.network',
});
```

---

## State Management

```typescript
interface ContractState<T> {
  publicState: PublicState;
  privateState: T;
}

// Subscribe to state changes
provider.subscribeToContract(contractAddress, (state) => {
  console.log('New state:', state);
});
```

---

## Transaction Building

```typescript
import { buildTransaction } from '@midnight-ntwrk/midnight-js-contracts';

const tx = await buildTransaction({
  contractAddress,
  circuitName: 'transfer',
  args: [recipient, amount],
  privateState,
});

// Sign and submit
const signedTx = await wallet.signTransaction(tx);
const txHash = await provider.submitTransaction(signedTx);
```

---

## Wallet Integration

### Browser Detection

```typescript
declare global {
  interface Window {
    midnight?: {
      mnLace?: MidnightProvider;
    };
  }
}

function isWalletAvailable(): boolean {
  return typeof window !== 'undefined'
    && window.midnight?.mnLace !== undefined;
}
```

### DApp Connector API

```typescript
interface DAppConnectorAPI {
  enable(): Promise<MidnightAPI>;
  isEnabled(): Promise<boolean>;
  apiVersion(): string;
  name(): string;
  icon(): string;
}

async function connectWallet(): Promise<MidnightAPI> {
  if (!window.midnight?.mnLace) {
    throw new Error('Midnight Lace wallet not found');
  }
  return await window.midnight.mnLace.enable();
}
```

### MidnightAPI Interface

```typescript
interface MidnightAPI {
  getUsedAddresses(): Promise<string[]>;
  getBalance(): Promise<Balance>;
  signTx(tx: Transaction): Promise<SignedTransaction>;
  submitTx(signedTx: SignedTransaction): Promise<TxHash>;
  signData(address: string, payload: string): Promise<Signature>;
}
```

### React Hook

```typescript
export function useWallet() {
  const [state, setState] = useState({
    isConnected: false,
    address: null as string | null,
    isLoading: false,
    error: null as string | null,
  });

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      if (!window.midnight?.mnLace) {
        throw new Error('Please install Midnight Lace wallet');
      }
      const api = await window.midnight.mnLace.enable();
      const addresses = await api.getUsedAddresses();
      setState({
        isConnected: true,
        address: addresses[0] || null,
        isLoading: false,
        error: null,
      });
      return api;
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed',
      }));
      throw error;
    }
  }, []);

  return { ...state, connect };
}
```

### Connection Flow

```
1. User clicks "Connect Wallet"
2. DApp calls window.midnight.mnLace.enable()
3. Wallet popup asks user to approve
4. User approves → DApp receives MidnightAPI
5. DApp can now interact with wallet
```

---

## Error Handling

```typescript
import { MidnightError, ContractError } from '@midnight-ntwrk/midnight-js-contracts';

try {
  await callContract({ ... });
} catch (error) {
  if (error instanceof ContractError) {
    console.error('Contract assertion failed:', error.message);
  } else if (error instanceof MidnightError) {
    console.error('Network error:', error.code);
  }
}
```

### DApp Connector Errors

```typescript
import { ErrorCodes } from '@midnight-ntwrk/dapp-connector-api';

// ErrorCodes.Rejected - User rejected the request
// ErrorCodes.InvalidRequest - Malformed transaction or request
// ErrorCodes.InternalError - DApp connector couldn't process request

try {
  const api = await window.midnight.mnLace.enable();
} catch (error) {
  if (error.code === ErrorCodes.Rejected) {
    console.log('User rejected wallet connection');
  }
}
```

### ContractTypeError

```typescript
// Thrown when there's a contract type mismatch
try {
  const contract = await findDeployedContract(provider, address, MyContract);
} catch (e) {
  if (e instanceof ContractTypeError) {
    console.error('Contract type mismatch:', e.circuitIds);
  }
}
```

---

## Private State Witnesses

TypeScript witnesses implement the Compact `witness` declarations:

```typescript
// counter-witnesses.ts
import type { Witnesses } from './managed/counter';

export type CounterPrivateState = {
  localSecretKey: Uint8Array;
  storedValues: Map<string, bigint>;
};

export const createWitnesses = (
  state: CounterPrivateState
): Witnesses<CounterPrivateState> => ({
  local_secret_key: () => state.localSecretKey,

  store_secret_value: (value: bigint) => {
    state.storedValues.set('secret', value);
    return undefined; // returns []
  },

  get_secret_value: () => {
    return state.storedValues.get('secret') ?? 0n;
  },
});

export const createInitialState = (): CounterPrivateState => ({
  localSecretKey: crypto.getRandomValues(new Uint8Array(32)),
  storedValues: new Map(),
});
```

---

## Best Practices

1. **Always check wallet availability** before connecting
2. **Handle user rejection** gracefully
3. **Store connection state** in context/global state
4. **Provide clear loading/error feedback**
5. **Test with Midnight Lace extension**
6. **Keep private state secure** - never log or expose it

---

## Rules

See `/rules/` directory for detailed documentation:
- `wallet-integration.md` - Complete wallet integration patterns

---

## References

- [Midnight Docs](https://docs.midnight.network)
- [TypeScript SDK](https://docs.midnight.network/develop/reference/sdk)
- [DApp Connector API](https://github.com/midnightntwrk/midnight-dapp-connector-api)
- [Lace Wallet](https://www.lace.io)
