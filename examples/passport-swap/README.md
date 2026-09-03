# Passport Swap

A swap desk on its own origin. It sells one fixed lot of the demo stablecoin
for a fixed price in NIGHT, and every step that spends is a question put to
Passport and answered there.

```
npm install            # from the workspace root
npm run dev -w passport-swap        # http://localhost:5175
```

The three things it needs are named in `src/config.ts` and overridable with a
`.env.local`:

| Variable | Default | What it is |
| --- | --- | --- |
| `VITE_PASSPORT_ORIGIN` | `https://midnightpassport.com` | The Passport this app talks to. |
| `VITE_SWAP_DESK` | `https://67-205-177-162.sslip.io/balancer` | The desk — the same service that opens a Passport's account. |
| `VITE_SWAP_DESK_KEY` | unset | Sent as `x-passport-key`, when the desk requires one. |

The desk's origin allow-list must name whatever origin this app is served on,
or the browser refuses the quote before the desk ever sees it.

## The trade, and which way it runs

The desk takes NIGHT and pays the stablecoin. That is not a preference: the
payment protocol a partner app may use carries exactly one intent — a positive
NIGHT transfer to an address the user's Passport approves — so the leg an app
is allowed to ask for is the NIGHT leg. The other leg is the desk's, and it
runs through the sponsor's existing asset path.

1. **Sign in.** A profile request for `displayName` and `passportContract`. The
   account address is what a settlement needs; without it the app says so.
2. **The quote.** `GET /swap/quote?from=NIGHT&to=mUSD` — price, lot, rate, and
   the address the payment goes to.
3. **Swap.** A payment request for the quoted price to the quoted address.
   Passport shows its own consent sheet; this page never sees an approval.
4. **Settle.** `POST /swap { account, txHash, amount }`. The desk checks the
   chain for the payment itself, pays the lot into the account, and answers
   with both transaction hashes. One payment buys one lot, forever.

## Listing it inside Passport

The Apps tab is data-driven from the public 1AM app registry, which lives
outside this repository. Until an entry lands there, a build of the Passport
demo can point at this app directly with `VITE_LOCAL_APP_URL` (and
`VITE_LOCAL_APP_NAME=Passport Swap`), which puts it at the top of the grid.
