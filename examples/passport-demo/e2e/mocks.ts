/**
 * The network boundary tier 1 replaces, and nothing inside it.
 *
 * Everything here is an HTTP (or WebSocket) interception. No module is stubbed,
 * no function is spied on, and the app under test is a production build served
 * by `vite preview` — so what runs is the shipped bundle, driven by a real
 * passkey, with the four services it talks to answered from this file.
 *
 * WHAT EACH ANSWER IS, AND WHERE IT CAME FROM
 * -------------------------------------------
 *   `GET  /status`         the balancer's sponsorship probe. Answered as
 *                          available on stagenet, which is what the deployed
 *                          service answers.
 *   `GET  /wallet-status`  the fee sponsor's readiness. Answered with
 *                          `available: 1`, the only shape `sponsor.ts` accepts
 *                          as able to pay — and flippable mid-run through
 *                          {@link NetworkBoundary.setSponsorAvailable}, because
 *                          `available: 0` is a state the deployed service is
 *                          genuinely in for a minute or two after every
 *                          activation grant, and it is what a surface must
 *                          neither hide behind nor give up on.
 *   `POST /register-alias` the sponsored registration. Its two-transaction
 *                          proving run is minutes long and is drilled for real
 *                          by `stagenet.live.spec.ts`; here it is refused with
 *                          a code the client is meant to queue behind, which is
 *                          the branch this tier CAN hold honestly.
 *   `POST /fund-account`   the activation grant. Same rule.
 *   indexer GraphQL        two queries. `BlockHeight` decides whether the
 *                          wallet may cold-start (`localWallet.ts`'s depth
 *                          guard); a shallow answer lets it. `CONTRACT_STATE_
 *                          QUERY` is ANSWERED BY ADDRESS, from REAL RECORDINGS:
 *                          `fixtures/stagenet-night-registry.json` is the
 *                          stagenet `.night` TLD's own answer (2026/08/25), and
 *                          `fixtures/stagenet-night-resolver.json` is the
 *                          resolver leaf `iamtester.night` points at
 *                          (2026/08/30). So availability AND resolution are
 *                          decoded by the real Midnames contract module from
 *                          real ledger bytes rather than asserted against a
 *                          hand-written stub.
 *
 *                          Every OTHER address answers `contract: null`, which
 *                          is what the indexer really says about a contract it
 *                          has never seen. It used to answer with the registry's
 *                          state whatever was asked for, which made an account
 *                          balance read decode a `.night` TLD as an account and
 *                          fail with a `TypeError` no user should ever meet.
 *
 * WebSockets are answered by accepting and saying nothing, so the run makes no
 * outbound connection at all: the wallet facade subscribes to the indexer and
 * the node relay on start-up, and a spec that let those through would be a
 * spec whose result depended on stagenet being up.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The stagenet `.night` TLD's own contract state, recorded 2026/08/25. */
const NIGHT_REGISTRY_STATE = fs.readFileSync(
  path.join(here, 'fixtures', 'stagenet-night-registry.json'),
  'utf8',
);

/**
 * The resolver leaf `iamtester.night` points at, recorded from stagenet on
 * 2026/08/30 — the second half of a real resolution.
 *
 * A name lookup is TWO reads: the TLD says which leaf holds the name, and the
 * leaf says what it points at. Only the first was ever recorded, so the second
 * was answered with the TLD's own state — which decodes, wrongly, and made
 * every resolution in this tier report a name pointing at nothing.
 */
const NIGHT_RESOLVER_STATE = fs.readFileSync(
  path.join(here, 'fixtures', 'stagenet-night-resolver.json'),
  'utf8',
);

/**
 * The Passport account `iamtester.night` points at, recorded from stagenet on
 * 2026/08/30. It really holds 2000 atomic NIGHT and 100 units of the sponsor's
 * mUSD colour, so a mocked Home renders a real account's real ledger rather
 * than "Unavailable" — which is what it showed before this recording, because
 * every contract-state query was answered with the `.night` TLD's state and
 * decoding a registry as an account throws.
 */
const PASSPORT_ACCOUNT_STATE = fs.readFileSync(
  path.join(here, 'fixtures', 'stagenet-passport-account.json'),
  'utf8',
);

/** The stagenet `.night` TLD, and the leaf above. Both are real addresses. */
const TLD_ADDRESS = '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116';
const RESOLVER_ADDRESS = '0291d8f9e4f851f24cd1a8d89c5b9d4152343b32d0329de442ff6567739baa66';

/** The name that leaf resolves — the one a spec can drive a real lookup with. */
export const RESOLVABLE_NAME = 'iamtester';

/**
 * The account that name resolves to, whole. A spec seeds it as the Passport's
 * own account so the balances on screen are a real account's, and so a lookup
 * of {@link RESOLVABLE_NAME} lands somewhere that genuinely exists.
 */
export const PASSPORT_ACCOUNT_ADDRESS =
  '8054fcaccc83b5e1ad8e4f8c5d555010b61dbecd838d412a85635dc2b5bf5263';

/**
 * SOMEBODY ELSE'S account, addressed directly rather than through a name.
 *
 * From 2026/09/02 the recipient field takes 32 bytes of hex as well as a
 * `.night` name — a Passport whose owner has not claimed a name yet is still a
 * Passport that can be paid, and Receive already shows the account address. A
 * spec needs an address that is not the SENDER's own, so this is a distinct
 * 32 bytes answered with the same recorded account state: nothing about the
 * recipient's ledger decides anything on the Send sheet, and inventing a second
 * recording would only be a second thing to keep true.
 */
export const RECIPIENT_ACCOUNT_ADDRESS =
  '4b1d0f2a6c8e3157a90d4e6b8c2f10935ad7e46b1c8f025ea3d97b604c1e8a37';

/**
 * A chain shallow enough for `localWallet.ts` to allow a cold start.
 *
 * The guard refuses a from-genesis walk above a million blocks because the tab
 * dies before it finishes; stagenet is far past that, so a first sync there is
 * a thing this demo genuinely cannot do offline. The number below is what lets
 * the wallet open at all in a mocked run, and it is the one value in this file
 * that is not something a service really said.
 */
const MOCK_CHAIN_HEIGHT = 120;

/**
 * The host the funder and primary fee sponsor live on, and the ONE place it is
 * written.
 *
 * It is `67-205-177-162.sslip.io`, the droplet the deployment builds against
 * (`.github/workflows/deploy-demo.yml`) and the one `playwright.config.ts`'s
 * `previewEnv` now compiles tier 1 against. The funder host these routes named
 * until 2026/09/02 was a 1 GB droplet deleted on 2026/08/27 whose address has
 * since been recycled; a route that still named it would silently stop matching
 * the moment the build moved, and every mocked request would go to a stranger's
 * machine instead of being answered here.
 *
 * Every route below and in the specs is built from it by {@link sponsorRoute},
 * so the host can only move in one edit, and if it moves without the build
 * moving the mocked run fails loudly rather than reaching the network.
 */
export const BALANCER_HOST = '67-205-177-162.sslip.io';

/**
 * A matcher for balancer traffic — all of it, or one endpoint of it.
 *
 * A `RegExp` rather than a glob string so the host is interpolated once, from
 * the constant above, and a spec that needs `/status` alone cannot end up
 * writing the host a second time. `sponsorRoute('/status')` matches that
 * endpoint whatever path prefix the configured base URL carries, and — because
 * the optional prefix must end in a slash — does NOT also match
 * `/wallet-status`.
 */
export function sponsorRoute(endpoint = ''): RegExp {
  const host = BALANCER_HOST.replaceAll('.', '\\.');
  const name = endpoint.replace(/^\//, '');
  const tail = endpoint ? `(?:.*\\/)?${name}(?:[?#].*)?$` : '';
  return new RegExp(`^https:\\/\\/${host}\\/${tail}`);
}

/**
 * The SECOND fee sponsor the build lists, and why it has to be answered here.
 *
 * `VITE_SPONSOR_URL` is an ordered list, and `src/lib/sponsor.ts` probes
 * `GET /wallet-status` on EVERY entry before it lets a send go — the first
 * endpoint reporting `available > 0` serves. So a tier that mocks only the
 * balancer is not a mocked tier: the readiness probe goes out to the real 1AM
 * gateway, and a spec that has just dialled the balancer to busy is graded on
 * whatever that gateway happens to hold. That is not hypothetical — it is what
 * `a busy fee sponsor disables the Send control` did on 2026/09/02: it read
 * `Review`, because a live third party said it had DUST.
 *
 * The gateway only ever serves `/wallet-status` and `/balance-only`;
 * `/status`, `/register-alias`, and `/fund-account` come from
 * `VITE_FUNDER_URL` and are ours alone. The handler below answers accordingly
 * rather than pretending the gateway is a second balancer.
 */
export const SPONSOR_FAILOVER_HOST = 'api-stagenet.1am.xyz';

/** Matches every request the app makes to the failover sponsor. */
export const SPONSOR_FAILOVER_ROUTE_GLOB = `**/${SPONSOR_FAILOVER_HOST}/**`;

/** Every host a sponsored build may talk to, in the order it is configured. */
export const SPONSOR_HOSTS: readonly string[] = [BALANCER_HOST, SPONSOR_FAILOVER_HOST];

/** Every request the mocked tier answered, plus the dials a spec can turn. */
export interface NetworkBoundary {
  readonly calls: string[];
  /**
   * What `/wallet-status` answers from now on.
   *
   * `0` is the real service's busy state: its DUST is reserved against a
   * transaction it is balancing, and it frees up on its own. The body carries
   * the diagnostic the live service carries — a wallet index and a DUST balance
   * — precisely so a spec can assert that none of it reaches the screen.
   */
  setSponsorAvailable(available: number): void;
  /**
   * Holds the `.night` registry's answer back by `ms` before fulfilling it.
   *
   * A slow registry is not a fault — the indexer decodes a real contract's
   * state and can take seconds on a poor link — and it is the state in which a
   * claim used to show one unchanging label with nothing behind it. A spec
   * cannot assert that a wait is EXPLAINED unless it can make the wait happen,
   * so this is the dial that makes it happen. Default 0.
   */
  setRegistryDelay(ms: number): void;
  /**
   * How the sponsor traffic split between "answered here" and "left the box".
   *
   * Interception and the real network are mutually exclusive in Playwright — a
   * fulfilled route never opens a socket — so the two numbers being equal, and
   * both above zero, is the proof that the mocked tier both TALKED to the
   * sponsor host the build names and reached none of it. A build whose
   * `VITE_SPONSOR_URL` drifted off {@link BALANCER_HOST} shows `requests`
   * climbing past `intercepted`; one that never asked shows both at zero, which
   * is a mocked run asserting nothing.
   */
  sponsorTraffic(): { requests: number; intercepted: number };
}

/** @deprecated The old name for {@link NetworkBoundary}. */
export type RequestLog = NetworkBoundary;

/**
 * Installs the boundary. Returns the log of what the app asked for, so a spec
 * can assert on what was NOT called as well as what was.
 */
export async function installNetworkBoundary(page: Page): Promise<NetworkBoundary> {
  const calls: string[] = [];
  let sponsorAvailable = 1;
  let registryDelayMs = 0;
  let sponsorRequests = 0;
  let sponsorIntercepted = 0;

  /* Counted before routing decides anything, so a request that slipped past the
     matcher and went to a real machine still shows up here. See
     `sponsorTraffic`. */
  page.on('request', (request) => {
    if (SPONSOR_HOSTS.some((host) => request.url().includes(host))) sponsorRequests += 1;
  });

  await page.route(sponsorRoute(), async (route) => {
    const url = route.request().url();
    sponsorIntercepted += 1;
    calls.push(`${route.request().method()} ${url}`);

    if (url.endsWith('/status')) {
      return route.fulfill({
        json: {
          network: 'stagenet',
          aliasSponsorship: 'available',
          assetSymbol: 'mUSD',
          assetColourHex: 'a'.repeat(64),
        },
      });
    }
    if (url.endsWith('/wallet-status')) {
      return route.fulfill({
        json: {
          total: 1,
          available: sponsorAvailable,
          wallets: [
            {
              index: 0,
              ready: true,
              dust: {
                /* The busy body is the one recorded from the live service on
                   2026/08/25, DUST balance and all: `available: 0` with a wallet
                   that is ready and synced and whose DUST is simply spoken for. */
                balance:
                  sponsorAvailable > 0 ? '288384879317778538' : '4993664979775282371',
                utxoCount: 3,
                isSynced: true,
              },
            },
          ],
        },
      });
    }
    if (url.endsWith('/register-alias')) {
      /* The one refusal a client must QUEUE behind rather than retry or
         self-pay. Registering for real takes two proved transactions and is
         `stagenet.live.spec.ts`'s job. */
      return route.fulfill({
        status: 503,
        json: {
          error: 'funder-empty',
          message: 'The sponsor is out of NIGHT on stagenet right now.',
        },
      });
    }
    if (url.endsWith('/fund-account')) {
      return route.fulfill({
        status: 503,
        json: { error: 'wallet-syncing', message: 'The sponsor wallet is still syncing.' },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not-mocked' } });
  });

  /* The failover sponsor, answering the two endpoints it really serves and
     refusing the rest. Its DUST follows the same dial as the balancer's: a
     spec that says "the fee sponsor is busy" means the whole list is busy,
     which is what the user's screen is a function of — `combineSponsorReadiness`
     folds the list, and one endpoint with DUST is a send that may proceed. */
  await page.route(SPONSOR_FAILOVER_ROUTE_GLOB, async (route) => {
    const url = route.request().url();
    sponsorIntercepted += 1;
    calls.push(`${route.request().method()} ${url}`);

    if (url.endsWith('/wallet-status')) {
      return route.fulfill({
        json: {
          total: 1,
          available: sponsorAvailable,
          wallets: [
            {
              index: 0,
              ready: true,
              dust: {
                balance:
                  sponsorAvailable > 0 ? '288384879317778538' : '4993664979775282371',
                utxoCount: 3,
                isSynced: true,
              },
            },
          ],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not-mocked' } });
  });

  await page.route('**/indexer.stagenet.shielded.tools/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('BlockHeight')) {
      calls.push('POST indexer BlockHeight');
      return route.fulfill({ json: { data: { block: { height: MOCK_CHAIN_HEIGHT } } } });
    }
    if (body.includes('CONTRACT_STATE_QUERY')) {
      calls.push('POST indexer CONTRACT_STATE_QUERY');
      if (registryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, registryDelayMs));
      }
      /* Answered BY ADDRESS. Two real recordings, and honest silence for
         everything else — see the header. The address is read out of the
         GraphQL variables rather than the URL, because this is a POST. */
      const address = (/"address":"([0-9a-fA-F]+)"/.exec(body)?.[1] ?? '').toLowerCase();
      if (address === TLD_ADDRESS) {
        return route.fulfill({ contentType: 'application/json', body: NIGHT_REGISTRY_STATE });
      }
      if (address === RESOLVER_ADDRESS) {
        return route.fulfill({ contentType: 'application/json', body: NIGHT_RESOLVER_STATE });
      }
      if (address === PASSPORT_ACCOUNT_ADDRESS || address === RECIPIENT_ACCOUNT_ADDRESS) {
        return route.fulfill({ contentType: 'application/json', body: PASSPORT_ACCOUNT_STATE });
      }
      return route.fulfill({ json: { data: { contract: null } } });
    }
    calls.push(`POST indexer ${body.slice(0, 60)}`);
    return route.fulfill({ json: { data: {} } });
  });

  /* Accepted and silent. The facade opens subscriptions to the indexer and the
     node relay the moment it starts; letting them out would make this tier
     depend on stagenet being reachable. */
  await page.routeWebSocket(/.*/, () => {});

  return {
    calls,
    setSponsorAvailable(available: number) {
      sponsorAvailable = available;
    },
    setRegistryDelay(ms: number) {
      registryDelayMs = ms;
    },
    sponsorTraffic() {
      return { requests: sponsorRequests, intercepted: sponsorIntercepted };
    },
  };
}
