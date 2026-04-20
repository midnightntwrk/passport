---
name: midnight-deploy
description: Deploy and manage Midnight smart contracts to local or preview network. Use this skill when deploying contracts, starting local infrastructure, or connecting to testnet. Triggers on "deploy contract", "start local node", "setup standalone", "deploy to preview", or "midnight infrastructure".
license: MIT
metadata:
  author: webisoft
  version: "1.0.0"
  midnight-version: "0.27.0"
---

# Midnight Deploy

Deploy Midnight smart contracts to local development environment or preview network (testnet).

## When to Use

Use this skill when:
- Deploying a new Compact contract
- Starting local Midnight infrastructure
- Connecting to preview network (testnet)
- Troubleshooting deployment issues
- Setting up development environment

## How It Works

1. Compiles Compact contract to WebAssembly + ZK circuits
2. Starts required infrastructure (node, indexer, proof server)
3. Deploys contract with initial state
4. Returns contract address for frontend integration

## Prerequisites

Before deploying, ensure you have:

```bash
# Check Compact compiler
compact check

# Check Node.js
node -v  # v23+

# Check Docker (for local infrastructure)
docker -v
```

## Local Development (Standalone)

### Start Local Infrastructure

```bash
# From project root
npm run setup-standalone
```

This starts:
- **Midnight Node**: `ws://127.0.0.1:9944`
- **Indexer**: `http://127.0.0.1:8088`
- **Proof Server**: `http://127.0.0.1:6300`

### Deploy to Local

```bash
# Build contract first
cd counter-contract
npm run build

# Deploy via CLI
cd ../counter-cli
npm run deploy:local
```

## Preview Network (Testnet)

### Configure Environment

Create `counter-cli/.env`:
```env
MY_PREVIEW_MNEMONIC="your twelve word mnemonic phrase here"
MY_UNDEPLOYED_UNSHIELDED_ADDRESS=""
```

### Get Test Tokens

1. Visit [Midnight Faucet](https://faucet.preview.midnight.network/)
2. Enter your wallet address
3. Receive tSTAR tokens

### Deploy to Preview

```bash
# Build contract
cd counter-contract
npm run build

# Deploy to testnet
cd ../counter-cli
npm run deploy:preview
```

## Deployment Output

Successful deployment returns:

```json
{
  "contractAddress": "0x1234567890abcdef...",
  "deploymentTxHash": "0xabcdef1234567890...",
  "network": "preview",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

## Configure Frontend

After deployment, update frontend environment:

```env
# frontend-vite-react/.env
VITE_CONTRACT_ADDRESS="0x1234567890abcdef..."
```

## Network Configuration

### Local (Standalone)
```typescript
const config = {
  node: "ws://127.0.0.1:9944",
  indexer: "http://127.0.0.1:8088",
  proofServer: "http://127.0.0.1:6300",
};
```

### Preview (Testnet)
```typescript
const config = {
  node: "wss://rpc.preview.midnight.network",
  indexer: "https://indexer.preview.midnight.network",
  proofServer: "https://proof.preview.midnight.network",
};
```

## Deployment Script

For automated deployments, use:

```bash
bash /path/to/skills/midnight-deploy/scripts/deploy.sh [network] [contract-path]
```

**Arguments:**
- `network` - Target network: `local` or `preview` (default: `local`)
- `contract-path` - Path to contract directory (default: current directory)

**Examples:**

```bash
# Deploy to local
bash scripts/deploy.sh local ./counter-contract

# Deploy to preview testnet
bash scripts/deploy.sh preview ./counter-contract
```

## Troubleshooting

### Docker Not Running
```
Error: Cannot connect to Docker daemon
```
**Solution**: Start Docker Desktop or Docker daemon

### Compact Compiler Not Found
```
Error: compact: command not found
```
**Solution**: Install Compact compiler:
```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update +0.27.0
```

### Insufficient Funds
```
Error: Insufficient balance for transaction
```
**Solution**: Get test tokens from [faucet](https://faucet.preview.midnight.network/)

### Proof Server Timeout
```
Error: Proof generation timeout
```
**Solution**:
- Check proof server is running
- Simplify circuit complexity
- Increase timeout in config

### Contract Already Deployed
```
Error: Contract at address already exists
```
**Solution**: Use a new deployment or join existing contract

## Deployment Checklist

- [ ] Contract compiled successfully (`npm run build`)
- [ ] Tests passing (`npm run test`)
- [ ] Environment variables configured (`.env`)
- [ ] Wallet funded with tSTAR (for preview)
- [ ] Infrastructure running (for local)
- [ ] Contract address saved
- [ ] Frontend configured

## References

- [Midnight Deployment Guide](https://docs.midnight.network/guides/deployment)
- [Preview Network](https://docs.midnight.network/networks/preview)
- [Starter Template](https://github.com/MeshJS/midnight-starter-template)
