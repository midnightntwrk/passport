# Gifting an item (NFT) to a Passport account

`ops/gift-nft.ts` mints ONE shielded token of its own colour and deposits it
into an account-custody contract, so the account's Assets tab shows an item
card. It is the balancer's own asset leg — `mint_shielded` then
`deposit_shielded` — run once by hand with a different domain separator and an
amount of one.

## The colour, and why the client has to agree with it

The faucet computes a coin's colour as `tokenType(separator, kernel.self())`.
A separator this service has never minted under is a colour nobody holds, and a
single unit of it is what `passport-demo/src/lib/colour.ts::classifyHolding`
files as an item.

For `midnight-genesis-pass` against the stagenet faucet
`4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f`:

| | |
|---|---|
| separator (ASCII, zero-padded to 32) | `6d69646e696768742d67656e657369732d706173730000000000000000000000` |
| **colour** | `815183a74a98593bf16344ef6e920313f9c57ccb2feef3f9fe944ba5c4079e26` |

That colour is pinned in `passport-demo/src/lib/colour.ts` as
`GENESIS_PASS_COLOUR_HEX`, which is what makes the card read "Midnight Genesis
Pass" over `public/nft/genesis-pass.svg` rather than `Item · 8151…`. A
different faucet is a different colour and the card correctly falls back to the
anonymous one. `src/lib/colour.test.ts` pins the hex, so a change to it is a
failing test rather than an item that quietly loses its picture.

## The plan — safe against the running unit

`--dry-run` (the default) opens no wallet. It computes the colour off the
faucet address and the separator, which is everything a client needs.

```bash
# locally, in examples/passport-balancer
npx esbuild ops/gift-nft.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/gift-nft.mjs
rsync -a dist/ops/gift-nft.mjs root@67.205.177.162:/opt/passport-balancer/dist/ops/

# on the droplet — the unit may stay up for this
cd /opt/passport-balancer
BALANCER_ENV_FILE=/etc/passport-balancer.env \
BALANCER_NETWORK=stagenet \
BALANCER_STATE_DIR=/var/lib/passport-balancer \
BALANCER_PROVER_URL=http://127.0.0.1:6300 \
  node dist/ops/gift-nft.mjs --account <account contract address>
```

## The gift — and the stop window it costs

`--execute` opens the SERVICE'S OWN wallet, from the service's seed and the
service's sync snapshot, and refuses to run while the unit is active for the
reason `SPLIT.md` sets out: two writers over one coin set and one snapshot is
how a wallet loses track of its own DUST.

**The stop is not ten seconds.** A minted coin has to become spendable in this
wallet before it can be deposited — the three minutes `MINT_VISIBLE_ATTEMPTS`
in `src/account.ts` exists for, and the reason the service keeps a spare mUSD
coin ahead of every request — and the deposit's credit then has to be read back
off the chain. **Budget five to ten minutes with the unit down**, run it when
nobody is onboarding, and start the unit again afterwards.

There is no shorter version of this that is also safe. A tool that ran against
the live wallet would be a second writer; a tool that split the wait across two
invocations would still have to hold the wallet through the mint and through
the deposit, and the sponsor would be down for both.

```bash
systemctl stop passport-balancer
cd /opt/passport-balancer
BALANCER_ENV_FILE=/etc/passport-balancer.env \
BALANCER_NETWORK=stagenet \
BALANCER_STATE_DIR=/var/lib/passport-balancer \
BALANCER_PROVER_URL=http://127.0.0.1:6300 \
  node dist/ops/gift-nft.mjs --account <account contract address> --execute
systemctl start passport-balancer
```

It prints the colour, the mint hash, the deposit hash, and the account's
holding of that colour afterwards. The wallet is closed on the way out whether
or not the gift landed, so the snapshot the service resumes from is current.

If the mint lands and the coin does not become spendable in time, the coin is
not lost: it is in the sponsor's wallet under that colour, and running the tool
again with the same `--separator` deposits it.

## What it will not do

Move NIGHT. The only transactions it builds are a faucet mint and an account
deposit. The account contract is compiled here with the same three refusing
witnesses `src/account.ts` gives it, so `withdraw_night`,
`grant_withdraw_night`, and `recover` are impossible from this process by
construction rather than by discipline.

## Tests

```bash
npx esbuild ops/giftSeparator.test.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/giftSeparator.test.mjs
node --test dist/ops/giftSeparator.test.mjs
```
