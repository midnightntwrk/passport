# Quickstart — zero to running inside Passport

Every step below is verified against the code in this template. Where a
behaviour belongs to Passport rather than to this app, the step says so.

## A. Run the template on its own (60 seconds)

1. ```bash
   cd passport-app-template     # wherever you copied it
   npm install
   npm run dev
   ```
2. Open **<http://localhost:5178>**. The port is fixed with `strictPort`
   ([`vite.config.ts`](../vite.config.ts)) — Passport frames your app by URL,
   and a dev server that quietly moves to the next free port is a handshake
   that quietly stops working.
3. The header chip reads **Standalone** — `window.parent !== window` is the
   whole mode detection (`src/main.tsx`, `EMBEDDED`). Without a Passport
   running there is nothing to connect to yet; that is the next section.

## B. Run it inside Passport, locally

You need two dev servers on two different origins.

1. **Start this app** (section A): `http://localhost:5178`.
2. **Start Passport**, from the Passport repository, on
   `http://localhost:5175`.

   > **`5175` is not a suggestion.** Passport's dev build accepts exactly
   > `http://localhost:5175` and redirects any other origin there when
   > `import.meta.env.DEV` is set, and its Vite server pins port 5175 with
   > `strictPort`. If your browser lands on 5175 after you started Passport
   > somewhere else, nothing is broken. Start Passport first, and leave 5175
   > to it. (This template's default `VITE_PASSPORT_ORIGIN` is
   > `http://localhost:5175` for the same reason — `src/main.tsx`.)
3. **Point Passport's app grid at this app.** Passport's in-app browser reads
   a public registry and prepends a local development entry whose URL comes
   from an environment variable. Start Passport with:

   ```bash
   VITE_LOCAL_APP_URL=http://localhost:5178 npm run demo
   ```

   Add `VITE_LOCAL_APP_NAME="My App"` to label it; without one the grid calls
   it *Local app*. The entry is prepended to the fetched registry, not swapped
   in for it. (`VITE_RAFFLE_URL` is the legacy name for the same slot and
   still works; setting both gives you two local entries.)
4. **In Passport:** create a passkey, open the apps grid, and tap your entry.
   The app loads in the in-app browser, the header chip flips to **Inside
   Passport**, and Passport posts the handshake down automatically — the
   Handshake row in Act 1 fills in without you doing anything.
5. **Tap "Connect Midnight Passport".** Passport shows its consent sheet on
   its own surface — your app's origin and the requested fields, each one
   unticked by default. Approve some or all; Act 2 renders exactly what came
   back and labels the rest *not shared*.

## C. Standalone mode against any Passport

Standalone mode needs nothing but `npm run dev` and a Passport origin to point
at:

1. Set the origin if it is not the local default:

   ```bash
   # .env.local
   VITE_PASSPORT_ORIGIN=http://localhost:5175
   ```
2. Open `http://localhost:5178` directly and tap Connect. The app mints the
   handshake pair itself and opens Passport in a popup with the pair on the
   URL (`passportRequestId`, `passportNonce` — `src/main.tsx`, `connect()`).
3. Allow popups for `localhost` if the browser blocks the window — the app
   tells you when that happens.

Note the limits of this mode: consent is all-or-nothing rather than
per-field, and **the transaction bridge does not exist here** — Act 3 says so
rather than offering a button that cannot work.

## D. Testing against the deployed Passport

The same template talks to a deployed Passport; only the origin changes.

1. **Standalone:** set `VITE_PASSPORT_ORIGIN` to the deployed Passport's
   exact HTTPS origin (no trailing slash needed — the template strips it) and
   restart `npm run dev`. Connect opens the deployed Passport in a popup. The
   user needs a passkey on that Passport, created in that browser profile.
2. **Embedded:** the deployed Passport can only frame apps listed in its
   registry, and the registry refuses `http:` entries outright — `localhost`
   works only via the local `VITE_LOCAL_APP_URL` slot, never via the
   registry. So embedded testing against the deployed Passport means
   deploying your app to a public HTTPS URL and adding it to the registry
   (see the README's registry section).

## E. Arming the optional payment (Act 3)

Off by default, and deliberately hard to arm by accident. All of the
following must hold (`src/main.tsx`, `PAYMENT_ARMED`):

1. `VITE_DEMO_PAYMENT=1` — exactly `1`.
2. `VITE_DEMO_PAYMENT_ADDRESS` — an unshielded `mn_addr…` recipient on the
   same network as the connected Passport wallet.
3. `VITE_DEMO_PAYMENT_AMOUNT` — atomic NIGHT as a base-10 string
   (default `100000` = 0.1 NIGHT).
4. The app is **embedded** — the transaction bridge is embedded-only.
5. The profile is connected — the payment act needs an approved profile
   first.

And the half that is not on your side: the Passport you point at must have a
wallet that can actually pay — NIGHT for the amount, **and something covering
the network fee**, which is paid in DUST rather than NIGHT. On the public
networks the fee sponsor covers it by default; a Passport with no sponsor
reachable and no DUST of its own cannot pay. Short of either, the reply is a
`failed` carrying `insufficient-funds` or `wallet-unavailable`, which is the
designed behaviour — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

**The payment flow truth, worth stating once:** the entry amount is paid in
NIGHT by the user's own Passport wallet. The network fee is either covered by
a sponsor — in which case, and only in which case, the reply says
`sponsored: true` — or paid from the user's DUST. Nothing in this system
promises a free transaction, and your app must not either.
