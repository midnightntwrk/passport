/**
 * passport-funder — a small self-hosted activation service.
 *
 * Drips an activation-sized NIGHT grant (default 1 000 atomic = 0.001 NIGHT,
 * roughly one hundred long-name Midnames registrations) to brand-new Passport
 * wallets, so a user's first `.night` claim executes immediately instead of
 * queueing behind a captcha faucet.
 *
 *   POST /activate  { address }  →  { txHash, amount }
 *   GET  /status                 →  { network, address, balanceAtomic,
 *                                     dripsServed, ready }
 *
 * Policy, in the order it is enforced: well-formed unshielded address on THIS
 * network → once-only per address (persisted ledger) → global hourly rate
 * limit → funder able to pay → recipient not already holding a drip's worth.
 * Every refusal is a clear JSON error.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { nativeToken } from '@midnight-ntwrk/ledger-v8';
import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import { applyEnvFile, loadConfig, type FunderConfig } from './config.js';
import { DripLedger, HourlyRateLimiter } from './dripLedger.js';
import { recipientNightBalance } from './recipientBalance.js';
import { formatNight, openFunderWallet, type FunderWallet } from './wallet.js';

/**
 * `MidnightBech32m.parse` reports mainnet as the exported `mainnet` symbol (a
 * mainnet address carries no network segment), every other network as its
 * string — the SDK's own normalisation, mirrored from the demo wallet.
 */
function parsedNetworkName(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value;
}

type Refusal = { status: number; error: string; message: string; extra?: Record<string, unknown> };

function refusal(status: number, error: string, message: string, extra?: Record<string, unknown>): Refusal {
  return { status, error, message, ...(extra ? { extra } : {}) };
}

async function main(): Promise<void> {
  applyEnvFile();
  const config: FunderConfig = loadConfig();
  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(`prover    ${config.provingServerUrl}`);
  console.log(`state     ${config.stateDir}`);
  console.log(`drip      ${config.dripAtomic} atomic NIGHT (${formatNight(config.dripAtomic)} NIGHT)`);
  console.log(`limit     ${config.maxPerHour} drips per rolling hour`);
  console.log(`origins   ${config.allowedOrigins.join(', ')}\n`);

  const ledgerFile = await DripLedger.open(config.stateDir, config.networkId);
  const limiter = new HourlyRateLimiter(config.maxPerHour);
  const nightTokenType = String(nativeToken().raw);

  process.stdout.write('opening the funder wallet');
  const wallet: FunderWallet = await openFunderWallet(config);
  console.log(`\nfunder address ${wallet.address}`);

  process.stdout.write('syncing');
  await wallet.waitForSync(() => process.stdout.write('.'));
  process.stdout.write('\n');

  const night = await wallet.nightBalance();
  console.log(`funder holds ${formatNight(night)} NIGHT (${night} atomic)`);
  if (night === 0n) {
    console.warn(
      'FUNDER IS EMPTY — faucet this address once (the captcha faucet for this network), then restart or wait: the wallet keeps syncing and picks the funds up live.',
    );
  }

  // Fees are paid in DUST, and DUST only accrues against REGISTERED NIGHT — a
  // freshly fauceted wallet must register once before it can pay its own fees.
  try {
    const registration = await wallet.registerDustIfNeeded();
    if (registration === 'registered') {
      console.log('[dust] registration submitted — DUST starts accruing within a few blocks');
    } else if (registration === 'already-generating') {
      console.log('[dust] every NIGHT UTxO is already registered for DUST generation');
    } else {
      console.log('[dust] no NIGHT yet, so nothing to register — fund the address first');
    }
  } catch (cause) {
    console.warn('[dust] registration failed (will not retry automatically):', cause);
  }
  console.log(`[dust] spendable now: ${await wallet.dustBalance()} Specks\n`);

  let dripsServed = 0;

  /**
   * A spend consumes its whole UTxO and the change comes back in a new one, so
   * for a block or two after a drip the wallet really does hold nothing
   * spendable. Measured on preview 2026/08/07: a funder holding ~5,000 NIGHT
   * read zero immediately after a drip and was whole again 20 s later.
   *
   * Reporting that as `funder-empty` would be false, and would turn away the
   * very next person during a signup run. So a shortfall is not believed until
   * it has had time to settle: `/activate` waits, and only a shortfall that
   * outlives the window is refused.
   */
  const CHANGE_SETTLE_MS = 90_000;
  const SETTLE_POLL_MS = 3_000;

  /** When the last drip was sent, so `/status` can say "settling", not "empty". */
  let lastDripAt = 0;

  const readiness = async (
    options: { settle?: boolean } = {},
  ): Promise<{ ready: boolean; night: bigint; refuse: Refusal | null }> => {
    const deadline = Date.now() + (options.settle ? CHANGE_SETTLE_MS : 0);
    for (;;) {
      const state = await wallet.currentState();
      const heldNight = await wallet.nightBalance(state);
      const heldDust = await wallet.dustBalance(state);
      if (heldNight >= config.dripAtomic && heldDust > 0n) {
        return { ready: true, night: heldNight, refuse: null };
      }
      if (Date.now() >= deadline) {
        if (heldNight < config.dripAtomic) {
          return {
            ready: false,
            night: heldNight,
            refuse: refusal(
              503,
              'funder-empty',
              `The funder holds ${formatNight(heldNight)} NIGHT, less than one ${formatNight(config.dripAtomic)} NIGHT drip. Its address (${wallet.address}) needs topping up from the ${config.networkId} faucet.`,
            ),
          };
        }
        return {
          ready: false,
          night: heldNight,
          refuse: refusal(
            503,
            'funder-no-dust',
            'The funder cannot pay a transaction fee yet: its DUST is still accruing. Try again in a minute.',
          ),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  };

  const activate = async (rawAddress: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const fail = (why: Refusal) => ({
      status: why.status,
      body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
    });

    if (typeof rawAddress !== 'string' || !rawAddress.trim()) {
      return fail(refusal(400, 'invalid-address', 'POST a JSON body of the form {"address": "mn_addr…"}.'));
    }
    const candidate = rawAddress.trim();

    let parsed: MidnightBech32m;
    try {
      parsed = MidnightBech32m.parse(candidate);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-address', `That is not a Midnight address: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    }
    const recipientNetwork = parsedNetworkName(parsed.network);
    if (recipientNetwork !== config.networkId) {
      return fail(
        refusal(400, 'wrong-network', `That address belongs to the ${recipientNetwork} network; this funder drips on ${config.networkId}.`),
      );
    }
    let recipient: UnshieldedAddress;
    try {
      recipient = parsed.decode(UnshieldedAddress, config.networkId);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-address', `That is a Midnight address, but not an unshielded (mn_addr…) one: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    }
    const normalized = parsed.asString();

    if (normalized === wallet.address) {
      return fail(refusal(400, 'invalid-address', 'The funder does not drip to itself.'));
    }

    const previous = ledgerFile.get(normalized);
    if (previous) {
      return fail(
        refusal(409, 'already-activated', `This address was already activated on ${previous.at} (tx ${previous.txHash}). Activation is once per address.`, {
          txHash: previous.txHash,
        }),
      );
    }

    if (!limiter.take()) {
      return fail(
        refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.maxPerHour} activations per hour. Try again later.`),
      );
    }

    const ready = await readiness({ settle: true });
    if (ready.refuse) return fail(ready.refuse);

    // Best-effort, bounded read of the recipient's own balance. An address
    // already holding a drip's worth is not a new wallet; an UNREADABLE
    // balance is not proof of anything, so the drip proceeds — the once-only
    // ledger above remains the hard gate.
    const held = await recipientNightBalance(config.indexerWsUrl, normalized, nightTokenType);
    if (held !== null && held >= config.dripAtomic) {
      return fail(
        refusal(409, 'already-funded', `That address already holds ${formatNight(held)} NIGHT — at least one activation grant's worth — so it does not need activating.`),
      );
    }

    try {
      const result = await wallet.drip(recipient, config.dripAtomic);
      dripsServed += 1;
      lastDripAt = Date.now();
      await ledgerFile.record(normalized, {
        txHash: result.txHash,
        amountAtomic: result.amountAtomic.toString(),
        at: new Date().toISOString(),
      });
      console.log(`[drip] ${formatNight(result.amountAtomic)} NIGHT → ${normalized} (tx ${result.txHash})`);
      return { status: 200, body: { txHash: result.txHash, amount: Number(result.amountAtomic) } };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[drip] FAILED for ${normalized}: ${message}`);
      return fail(refusal(500, 'drip-failed', `The activation transaction could not be sent: ${message}`));
    }
  };

  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin?.replace(/\/+$/, '');
    if (!origin || !config.allowedOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      Vary: 'Origin',
    };
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void => {
    response.writeHead(status, {
      'content-type': 'application/json',
      ...corsHeaders(request),
    });
    response.end(JSON.stringify(body));
  };

  const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4_096) reject(new Error('Request body too large.'));
      });
      request.on('end', () => resolve(body));
      request.on('error', reject);
    });

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      if (request.method === 'GET' && path === '/status') {
        /* Never waits: a monitor asking the question deserves the answer now.
           `settling` distinguishes change in flight from a funder that is
           genuinely out of NIGHT — the two read identically on the chain. */
        const { ready, night } = await readiness().catch(() => ({ ready: false, night: 0n }));
        respond(request, response, 200, {
          network: config.networkId,
          address: wallet.address,
          balanceAtomic: night.toString(),
          dripsServed,
          ready,
          settling: !ready && Date.now() - lastDripAt < CHANGE_SETTLE_MS,
        });
        return;
      }

      if (request.method === 'POST' && path === '/activate') {
        let address: unknown;
        try {
          address = (JSON.parse((await readBody(request)) || '{}') as { address?: unknown }).address;
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"address": "mn_addr…"}.',
          });
          return;
        }
        const outcome = await activate(address);
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      respond(request, response, 404, { error: 'not-found', message: 'Routes: GET /status, POST /activate.' });
    })().catch((cause) => {
      console.error('[http] handler failed', cause);
      try {
        respond(request, response, 500, { error: 'internal', message: 'Internal error.' });
      } catch {
        response.destroy();
      }
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`listening on http://${config.host}:${config.port} — GET /status, POST /activate\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} — saving the sync snapshot and stopping`);
    server.close();
    void wallet
      .close()
      .catch((cause) => console.warn('[wallet] did not stop cleanly', cause))
      .finally(() => process.exit(0));
    // A wedged facade must not hold the process open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((cause) => {
  console.error('\nFUNDER FAILED TO START');
  console.error(cause);
  process.exit(1);
});
