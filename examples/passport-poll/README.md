# Passport Poll

Ask a question, answer it with your Passport.

Passport Poll is a small Vite app served on its **own origin** — never mounted
inside the Passport shell — and a vote-tally service beside it. It is the second
consumer of `@midnight-passport/connect`, after Doorman, and it exists to show
the thing a payment demo cannot: an app where **identity is the whole product**.

Three steps, in order:

1. **Sign in with Passport.** The app asks for `displayName` and
   `passportContract`, and Passport answers only after the person consents. The
   account address that comes back is the identity every vote is counted
   against.
2. **Ask something.** A question and two to four options.
3. **Vote.** One vote per account, results updating live, and a **Verify**
   toggle that shows the workings: every account that voted, what it chose, and
   the reference Passport answered the consent under.

## What the votes are, and what they are not

Votes here are **Passport-signed at the identity layer and tallied by the demo
service**. They are not on chain, and the app never says they are.

Being precise about it, because the difference matters:

- The **account** a vote is counted against is not something the app chose. It
  came out of a consent exchange with Passport, bound to a request/nonce pair
  this page minted, delivered by exact-origin `postMessage`. An app cannot vote
  as somebody else without that person approving it in Passport.
- The pop-up profile channel returns **no signature** — the profile protocol
  (`org.midnight.passport.profile/v1`) carries `displayName` and
  `passportContract`, and nothing else — and there is no message-signing request
  in the connector's `postMessage` protocols. So the Verify list shows the
  exchange reference, not a signature, and the `proof` field in the tally
  service has room for a signature that this channel does not fill.
- The connector's **redirect channel** (`@midnight-passport/connect/redirect`)
  *does* carry one: a BIP-340 Schnorr signature over `sha256(payload)`, verified
  by `verifyPassportCallbackReply` and bound to a key whose address derivation
  is `verifyPassportKeyBinding`. Routing sign-in through it would put a real
  signature in the Verify column, and the tally service already stores
  `proof.signature` and `proof.publicKey` when it is given them.

**Next step:** a Compact contract that holds the tally, so the count is
verifiable by anyone rather than by this service. It is not here because the
Compact compiler was unavailable when this was built, and a contract nobody can
compile is worse than an honest service.

## Running it

Two processes, two ports.

```
npm install                          # from the repository root, once
cd examples/passport-poll
npm run service                      # tally service on http://localhost:5183
npm run dev                          # the app on http://localhost:5182
```

For a recording, prefer the built app over the dev server:

```
npx vite build && npm run preview    # http://localhost:5182
```

Passport Poll is deliberately **not** a root workspace — the root
`package.json` belongs to the package, not to its examples — so it takes React,
Vite, TypeScript, and Vitest from the root `node_modules` by ordinary upward
resolution. Its `package.json` lists them so the versions it was written
against are on the record.

By default it asks the **production** Passport at `https://midnightpassport.com`,
which needs no allow-listing: the profile reply is a `postMessage` addressed
back at whatever origin asked, exactly as Doorman receives it, so nothing had
to be added anywhere for this origin to be answered. Point it elsewhere with a
`.env.local`:

```
VITE_PASSPORT_ORIGIN=http://localhost:5175
VITE_TALLY_URL=http://localhost:5183
```

## The tally service

`service/server.ts` is a Node HTTP server with no dependencies. It holds the
polls in memory and mirrors them to `service/data/polls.json`, so a restart
mid-recording does not lose the votes. It is on its own origin, so CORS is not
optional — the allowed origins are **listed**, never reflected, because `*`
would let any page on the internet read the receipts.

| Route | What it does |
| --- | --- |
| `GET /health` | Whether it is up, and how much it is holding. |
| `GET /api/polls` | Every poll, with its results and receipts. |
| `POST /api/polls` | `{ question, options }` — two to four options. |
| `GET /api/polls/:id` | One poll. |
| `POST /api/polls/:id/votes` | `{ option, account, name?, proof }`. |

Environment: `PORT` (5183), `POLL_STORE`, `POLL_ALLOWED_ORIGINS`
(comma-separated, defaults to the app on 5182).

Every decision it makes lives in `service/tally.ts` as pure functions over a
plain state object, which is why that is what the tests exercise:

- one vote per account, refused rather than overwritten on the second attempt;
- a vote with no proof is not recorded at all;
- results count what was actually cast, name the voters who shared a name, and
  shorten the accounts of those who did not.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Serves the app on `localhost:5182`. |
| `npm run preview` | Serves the built app on `localhost:5182`. |
| `npm run service` | Runs the tally service on `localhost:5183`. |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `service/`, and `test/`. |
| `npm run test` | The tally rules, under Vitest. |

## Listing it in the Apps tab

The hub's list is data-driven, but the data is not ours: `registry.ts` fetches
the **1AM app registry**'s `registry.json` and falls back to the bundled
`registry.snapshot.json`. Entries need an absolute `https:` URL — a
`localhost` entry is dropped by the parser by design — so Passport Poll gets
listed once it has a deployed origin, by adding this to the registry
repository:

```json
{
  "id": "passport-poll",
  "name": "Passport Poll",
  "description": "Ask a question, answer it with your Passport",
  "url": "https://<deployed-origin>",
  "category": "identity",
  "section": "standard",
  "networks": ["preview", "preprod", "mainnet"]
}
```

## Where to read next

`docs/demo/integrating.md` — the three entry points, the three calls, and the
four things Passport will refuse to do. `examples/doorman` is the same shape
with a payment instead of a poll.
