# First exploration of NEAR

### Installation of CLI

```bash
$ nix develop

$ cargo install near-cli-rs
```

A `libudev` dependency had to be added to [flake.nix](./flake.nix).

## Create and fund account

```console
$ near create-account bwbush.testnet --useFaucet

Note: `near` CLI configuration is stored in "/home/bbush/.config/near-cli/config.toml"
├  Your transaction:
│    signer_id:    testnet
│    actions:
│       -- create account:      bwbush.testnet
│       -- add access key:
│                       public key:   ed25519:EbXqLEm7dkWc5ZMDFAm1eET1W9UHjKbKpB4qLYZM6cnf
│                       permission:   FullAccess
│
├  Transaction Execution Info:
│    Transaction ID: BGhqpWqimGC8HKbPvw7LCCQeMnUcTDrkQXp2ehY57kHH
│    To see the transaction in the transaction explorer, please open this url in your browser:
│    https://explorer.testnet.near.org/transactions/BGhqpWqimGC8HKbPvw7LCCQeMnUcTDrkQXp2ehY57kHH

New account <bwbush.testnet> created successfully.
The data for the access key is saved in the keychain

Here is your console command if you need to script it or re-run:
    near account create-account sponsor-by-faucet-service bwbush.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

Interesting that in this `save-to-keychain` case the secret is stored in the cloud via JSON-RPC.

## Export secrets

### To wallet in web browser

```console
$ near account export-account using-web-wallet network-config testnet
```

### To seed words

```console
$ near account export-account using-seed-phrase network-config testnet
```

```asc
-----BEGIN PGP MESSAGE-----

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
V89BiIPslaR2HANVYYVwmMmNSNwPnMJP8w==
=kDx8
-----END PGP MESSAGE-----
```

### To private key

```console
$ near account export-account using-private-key network-config testnet
```

```asc
-----BEGIN PGP MESSAGE-----

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
=RMGl
-----END PGP MESSAGE-----
```

## Execute a smart contract

Install tools:

```console
$ rustup target add wasm32-unknown-unknown

$ cargo install cargo-near
```

The [instructions](./Instructions.md) don't quite work because we're on NixOS with a non-standard git folder structure, so deploy manually.

```console
$ cargo near build

$ cargo test

$ cargo near build non-reproducible-wasm

$ near contract deploy bwbush.testnet use-file target/near/contract1.wasm without-init-call network-config testnet sign-with-keychain send

├  Unsigned transaction:
│    signer_id:    bwbush.testnet
│    receiver_id:  bwbush.testnet
│    actions:
│       -- deploy code <Gx3Jgy9kmpbFSE2LLX2CqPu91EFRH147iBxhpKdCCJ3C> to a account <bwbush.testnet>
│
├  Your transaction was signed successfully.
│    Public key: ed25519:EbXqLEm7dkWc5ZMDFAm1eET1W9UHjKbKpB4qLYZM6cnf
│    Signature:  ed25519:4y9q7jFnmSsYEhLm1QWLdV7PdrQtcBgT732m3gSNbr6mQdfd5C73zu4DswamtnCswJtZurCfen1mS5W9vXQHhCSk
│
├  Transaction Execution Info:
│    Gas burned: 1.2 Tgas
│    Transaction fee: 0.0001109199668174 NEAR
│    Transaction ID: BNBndKQRtzeUoXBUw4g4UqQfuEaMq1WHSCuaiKT6w6Ws
│    To see the transaction in the transaction explorer, please open this url in your browser:
│    https://explorer.testnet.near.org/transactions/BNBndKQRtzeUoXBUw4g4UqQfuEaMq1WHSCuaiKT6w6Ws
│

Contract code has been successfully deployed.

Here is your console command if you need to script it or re-run:
    near contract deploy bwbush.testnet use-file target/near/contract1.wasm without-init-call network-config testnet sign-with-keychain send
```

Initialize:

```console
$ TWO_MINUTES_FROM_NOW=$(date -d '+5 minutes' +%s000000000)

$ near contract call-function as-transaction 'bwbush.testnet' init json-args '{"end_time": "'$TWO_MINUTES_FROM_NOW'", "auctioneer": "bwbush.testnet"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as bwbush.testnet network-config testnet sign-with-keychain send

├  Unsigned transaction:
│    signer_id:    bwbush.testnet
│    receiver_id:  bwbush.testnet
│    actions:
│       -- function call:
│                       method name:  init
│                       args:         {
│                                       "auctioneer": "bwbush.testnet",
│                                       "end_time": "1773689748000000000"
│                                     }
│                       gas:          30.0 Tgas
│                       deposit:      0 NEAR
│
├  Your transaction was signed successfully.
│    Public key: ed25519:EbXqLEm7dkWc5ZMDFAm1eET1W9UHjKbKpB4qLYZM6cnf
│    Signature:  ed25519:4yLouftcyMicm5noZXBXX72h38NFFQx5BdcmjXRm2aWSJWdtGBu3x7wxG3kzJCHWJsv7BTC1U2iW6BjRpossrbdE
│
├  Transaction Execution Info:
│    Gas burned: 0.309 Tgas
│    Transaction fee: 0.0000308211543512 NEAR
│    Transaction ID: DyHPSZ8ubkEUxaXYKGH6qtRUHHuC7huqjgTEpLATWbjJ
│    To see the transaction in the transaction explorer, please open this url in your browser:
│    https://explorer.testnet.near.org/transactions/DyHPSZ8ubkEUxaXYKGH6qtRUHHuC7huqjgTEpLATWbjJ
│
├  Function execution logs:
│    Logs [bwbush.testnet]:   No logs
│
├  Function execution return value:
│    Empty return value
│

The "init" call to <bwbush.testnet> on behalf of <bwbush.testnet> succeeded.

Here is your console command if you need to script it or re-run:
    near contract call-function as-transaction bwbush.testnet init json-args '{"end_time": "1773689748000000000", "auctioneer": "bwbush.testnet"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as bwbush.testnet network-config testnet sign-with-keychain send
```

Place a bid:

```console
$ near call bwbush.testnet bid '{}' --deposit 0.01 --useAccount briob.testnet

├  Unsigned transaction:
│    signer_id:    briob.testnet
│    receiver_id:  bwbush.testnet
│    actions:
│       -- function call:
│                       method name:  bid
│                       args:         {}
│                       gas:          30.0 Tgas
│                       deposit:      0.01 NEAR
│
├  Your transaction was signed successfully.
│    Public key: ed25519:5YB8npxhkGgFGZazkFn2i7eHCxGvm7z4QeoTCH5GX3Mj
│    Signature:  ed25519:4wwfsENtRrRfLZxrwR7c6uAoxuAyqYwoDAMe7nKkv47jiRst4GEKcHYCcGWP5Erxibo8YokrncEaeSW8X6pbBRQa
│
├  Transaction Execution Info:
│    Gas burned: 0.309 Tgas
│    Transaction fee: 0.0000308297918575 NEAR
│    Transaction ID: 75svNq2BBoti8ZgovcSWs9MTqzRYTkFh5qudaKqtKjou
│    To see the transaction in the transaction explorer, please open this url in your browser:
│    https://explorer.testnet.near.org/transactions/75svNq2BBoti8ZgovcSWs9MTqzRYTkFh5qudaKqtKjou
│
├  Function execution logs:
│    Logs [bwbush.testnet]:   No logs
│    Logs [bwbush.testnet]:   No logs
│    Logs [briob.testnet]:   No logs
│
├  Function execution return value:
│    Empty return value
│

The "bid" call to <bwbush.testnet> on behalf of <briob.testnet> succeeded.

Here is your console command if you need to script it or re-run:
    near contract call-function as-transaction bwbush.testnet bid json-args {} prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' sign-as briob.testnet network-config testnet sign-with-keychain send
```

View bids:

```console
$ near view bwbush.testnet get_highest_bid '{}'

├  Logs:
│    No logs
Function execution return value (printed to stdout):
{
  "bid": "10000000000000000000000",
  "bidder": "briob.testnet"
}

Here is your console command if you need to script it or re-run:
    near contract call-function as-read-only bwbush.testnet get_highest_bid json-args {} network-config testnet now
```

Claim:

```console
$ near call bwbush.testnet claim '{}' --useAccount briob.testnet

├  Unsigned transaction:
│    signer_id:    briob.testnet
│    receiver_id:  bwbush.testnet
│    actions:
│       -- function call:
│                       method name:  claim
│                       args:         {}
│                       gas:          30.0 Tgas
│                       deposit:      0 NEAR
│
├  Your transaction was signed successfully.
│    Public key: ed25519:5YB8npxhkGgFGZazkFn2i7eHCxGvm7z4QeoTCH5GX3Mj
│    Signature:  ed25519:3cMp4MyDLEsLjuwCgBtjMAXDStMSRNn7EUxjMYMfMb8Bf3MrAQVEXEytJAVR6DXQUHRM3m98wn2xywDedUArG4Hr
│
├  Transaction Execution Info:
│    Gas burned: 0.309 Tgas
│    Transaction fee: 0.0000308393286005 NEAR
│    Transaction ID: 8AwKx1Pgd3Yaaa9BXHVEhd1bVgakDwoskGo3i4nkf3vJ
│    To see the transaction in the transaction explorer, please open this url in your browser:
│    https://explorer.testnet.near.org/transactions/8AwKx1Pgd3Yaaa9BXHVEhd1bVgakDwoskGo3i4nkf3vJ
│
├  Function execution logs:
│    Logs [bwbush.testnet]:   No logs
│    Logs [bwbush.testnet]:   No logs
│    Logs [briob.testnet]:   No logs
│
├  Function execution return value:
│    Empty return value
│

The "claim" call to <bwbush.testnet> on behalf of <briob.testnet> succeeded.

Here is your console command if you need to script it or re-run:
    near contract call-function as-transaction bwbush.testnet claim json-args {} prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as briob.testnet network-config testnet sign-with-keychain send
```

## Run an RPC node

### Initialize

```bash
podman run \
  --rm \
  -v $PWD/node:/root/.near \
  nearprotocol/nearcore:testnet neard init --chain-id testnet --download-genesis --download-config rpc

BOOT_NODES=$(curl -s -X POST https://rpc.testnet.near.org -H "Content-Type: application/json" -d '{
        "jsonrpc": "2.0",
        "method": "network_info",
        "params": [],
        "id": "dontcare"
      }' | jq -r '.result.active_peers as $list1 | .result.known_producers as $list2 |
          $list1[] as $active_peer | $list2[] |
          select(.peer_id == $active_peer.id) |
          "\(.peer_id)@\($active_peer.addr)"' | paste -sd "," -)

jq --arg newBootNodes $BOOT_NODES '.network.boot_nodes = $newBootNodes' node/config.json > node/config.tmp \
&& mv node/config.json node/config.json.orig && \
mv node/config.tmp node/config.json
```

### Start

First set kernel parameters:

```bash
./near-kernel-params.sh
```

Then use the kube [near-testnet.yaml](./near-testnet.yaml)

```bash
podman play kube near-testnet.yaml
```

### Monitor

Visit http://127.0.0.1:3030/debug/.
