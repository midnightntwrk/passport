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
 * A chain shallow enough for `localWallet.ts` to allow a cold start.
 *
 * The guard refuses a from-genesis walk above a million blocks because the tab
 * dies before it finishes; stagenet is far past that, so a first sync there is
 * a thing this demo genuinely cannot do offline. The number below is what lets
 * the wallet open at all in a mocked run, and it is the one value in this file
 * that is not something a service really said.
 */
const MOCK_CHAIN_HEIGHT = 120;

/** The sponsor and balancer origin this build is compiled against. */
export const BALANCER_ORIGIN = 'https://funder.midnightpassport.com/balancer';

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

  await page.route('**/funder.midnightpassport.com/**', async (route) => {
    const url = route.request().url();
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
      if (address === PASSPORT_ACCOUNT_ADDRESS) {
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
  };
}
