/**
 * passport-balancer — the stagenet counterpart of the fee sponsorship the
 * Passport demo already consumes.
 *
 * It holds NIGHT, registers that NIGHT for DUST generation, and spends the
 * resulting DUST on OTHER people's transaction fees:
 *
 *   GET  /status         →  a human answer: network, address, balances, whether
 *                           the wallet is synced, how it proves, what the DUST
 *                           registration did, how many transactions it balanced
 *   GET  /wallet-status  →  { total, available, wallets[] } — the exact shape
 *                           `examples/passport-demo/src/lib/sponsor.ts` parses,
 *                           down to `wallets[].dust.balance` being a STRING
 *   POST /balance-only   →  a serialised finalized transaction in, the same
 *                           transaction with a DUST fee leg attached and proved
 *                           out, as `{ txHash, txBytes, expiresAt }`
 *
 * The protocol is not invented here. `sponsor.ts` is the ground truth and this
 * service answers it, which means three things are load-bearing:
 *
 *   1. **`available` is a capability claim, not a health check.** The client
 *      gates on `available > 0` precisely because the deployed preview gateway
 *      reports a synced wallet with zero DUST as "ready". A wallet that cannot
 *      pay a fee right now contributes nothing to `available` here, whatever
 *      else is true of it.
 *   2. **`/balance-only` never submits.** It hands the balanced transaction
 *      back and the caller's own wallet submits it. That is what keeps the
 *      user's approval moment — and the user's own custody of the send —
 *      untouched by sponsorship.
 *   3. **A refusal is typed and honest.** `WALLET_SYNCING`,
 *      `INSUFFICIENT_DUST`, `PENDING_TRANSACTION`, `INVALID_TRANSACTION`,
 *      `BALANCE_FAILED` — each with the HTTP status `sponsor.ts` branches on.
 *      An unfunded balancer says `available: 0` and refuses; it never pretends.
 *
 * Everything else — env-only configuration, a sync snapshot on disk, a CORS
 * allow-list, SIGTERM saving before it exits — is `examples/passport-funder`'s
 * shape, so an operator running both on the same droplet learns one service.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { applyEnvFile, loadConfig, type BalancerConfig } from './config.js';
import {
  BalanceRefusal,
  formatNight,
  openBalancerWallet,
  type BalancerWallet,
} from './wallet.js';

/** Bigger than any Midnight transaction the demo builds, small enough to bound. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How often the start-up DUST registration is retried while it cannot run yet. */
const REGISTRATION_RETRY_MS = 60_000;

type RegistrationState =
  | 'pending'
  | 'registered'
  | 'already-generating'
  | 'no-night'
  | 'waiting-for-dust'
  | 'failed';

function elapsed(startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1_000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${(seconds - minutes * 60).toFixed(0)} s`;
}

async function main(): Promise<void> {
  applyEnvFile();
  const config: BalancerConfig = loadConfig();
  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`indexerWs ${config.indexerWsUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(
    `prover    ${config.provingServerUrl ?? 'in-process WASM prover (no BALANCER_PROVER_URL set)'}`,
  );
  console.log(`state     ${config.stateDir}`);
  console.log(`ttl       ${config.balanceTtlMs} ms on every balanced transaction`);
  console.log(`origins   ${config.allowedOrigins.join(', ')}\n`);

  const startedAt = Date.now();
  process.stdout.write('opening the balancer wallet\n');
  const wallet: BalancerWallet = await openBalancerWallet(config);
  console.log(`balancer address ${wallet.address}`);
  console.log(`proving via      ${wallet.provingMode === 'server' ? 'proof server' : 'WASM, in this process'}\n`);

  let synced = false;
  let syncSeconds: number | null = null;
  let registration: RegistrationState = 'pending';
  let registrationDetail: string | null = null;
  let balancesServed = 0;
  let lastBalanceAt: string | null = null;

  /* The wallet syncs in the background and the HTTP server starts NOW. A
     sponsor that is unreachable for the length of a chain walk looks, from
     `sponsorReadiness`, exactly like a sponsor that is down; a sponsor that
     answers `available: 0, syncState: "syncing"` tells the truth and tells it
     immediately. The same reasoning applies to the DUST registration below. */
  /* The proving key material is fetched now, in parallel with the chain walk,
     so that "can this service prove a fee leg at all?" is answered before
     anybody asks it to. In WASM mode it is roughly 33 MB over HTTPS; with
     BALANCER_PROVER_URL set it resolves immediately and the answer is the
     server's to give. */
  void (async () => {
    const readiness = await wallet.warmProvingKeys();
    if (readiness.state === 'ready') {
      console.log(
        `[prover] key material warm: ${(readiness.bytes / 1_048_576).toFixed(1)} MiB in ${(readiness.warmedInMs / 1_000).toFixed(1)} s — this service can prove a DUST fee leg with no proof server`,
      );
    } else if (readiness.state === 'server') {
      console.log(`[prover] proving through ${readiness.url}`);
    } else if (readiness.state === 'failed') {
      console.warn(
        `[prover] PROVING IS UNAVAILABLE: ${readiness.reason} — /balance-only will refuse with PROVER_UNAVAILABLE until this resolves. Set BALANCER_PROVER_URL to use a proof server instead.`,
      );
    }
  })();

  const syncStartedAt = Date.now();
  void (async () => {
    try {
      await wallet.waitForSync((progress) => {
        console.log(
          `[sync ${elapsed(syncStartedAt).padStart(9)}] shielded ${progress.shielded.applied}/${progress.shielded.highestRelevant}  unshielded ${progress.unshielded.applied}/${progress.unshielded.highestRelevant}  dust ${progress.dust.applied}/${progress.dust.highestRelevant}`,
        );
      });
      synced = true;
      syncSeconds = (Date.now() - syncStartedAt) / 1_000;
      console.log(`[sync] synced in ${elapsed(syncStartedAt)}`);

      const night = await wallet.nightBalance();
      console.log(`[wallet] holds ${formatNight(night)} NIGHT (${night} atomic)`);
      if (night === 0n) {
        console.warn(
          `BALANCER IS EMPTY — faucet ${wallet.address} on ${config.networkId}, then wait: the wallet keeps syncing and picks the funds up live, and the DUST registration below retries every minute.`,
        );
      }

      /* Fees are paid in DUST, and DUST only accrues against REGISTERED NIGHT.
         This loop never ends: it re-checks every minute rather than registering
         once and stopping.

         What it is NOT for, because it was measured on stagenet 2026/08/24 and
         the obvious worry turned out to be unfounded: spending a registered
         NIGHT UTxO does NOT strand the change. A 2 NIGHT operator transfer out
         of a registered 5,000 NIGHT UTxO emitted `DustSpendProcessed`,
         `DustGenerationDtimeUpdate`, and `DustInitialUtxo` in one transaction,
         and the 4,998 NIGHT change came back already generating — the wallet
         read `already-generating` on the next pass with a HIGHER DUST balance
         than before the spend. (Immediately after submitting, the wallet does
         briefly read `NIGHT 0, DUST 0`: that is the change still settling, not
         a lost registration, and it is why nothing here treats a single zero
         reading as a reason to act.)

         What it IS for: NIGHT that arrives later. A faucet top-up lands as a
         fresh, unregistered UTxO however long after start-up it happens, and a
         one-shot registration would never see it. It also covers a registration
         that could not run the first time — on ledger-9 a registration pays its
         own fee out of projected generation, so on a fresh wallet it has to
         wait minutes before it can be built at all.

         Only transitions are logged, so a steady state is silent. */
      let lastReported: RegistrationState | '' = '';
      for (;;) {
        /* Registration rotates NIGHT UTxOs; balancing reserves DUST. They do
           not touch the same coins, but both move wallet state, and a
           registration landing mid-balance is a needless risk for something
           that can simply wait a minute. */
        if (!wallet.isBalancing()) {
          try {
            const outcome = await wallet.registerDustIfNeeded();
            registration = outcome;
            registrationDetail = null;
            if (outcome !== lastReported) {
              if (outcome === 'registered') {
                console.log('[dust] registration submitted — DUST accrues from here');
              } else if (outcome === 'already-generating') {
                console.log('[dust] every NIGHT UTxO is registered for DUST generation');
              } else if (outcome === 'no-night') {
                console.log('[dust] no NIGHT yet, so nothing to register — faucet the address');
              }
              console.log(`[dust] spendable now: ${await wallet.dustBalance()} Specks`);
              lastReported = outcome;
            }
          } catch (cause) {
            registration = 'failed';
            registrationDetail = cause instanceof Error ? cause.message : String(cause);
            lastReported = 'failed';
            /* Seen live on the very first funded submission: the node relay's
               WebSocket had dropped ("Normal Closure") while the wallet was
               syncing, and the submission raced its reconnect. The next pass a
               minute later went through. A one-shot registration would have
               made that transient permanent. */
            console.warn('[dust] registration failed; retrying in a minute:', cause);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, REGISTRATION_RETRY_MS));
      }
    } catch (cause) {
      console.error('[sync] the wallet stopped syncing', cause);
    }
  })();

  /* -------------------------------------------------------------------------- */
  /* Wire shapes                                                                */
  /* -------------------------------------------------------------------------- */

  /**
   * `GET /wallet-status`, in exactly the shape `parseSponsorWalletStatus` reads.
   *
   * One wallet, so `total` is always 1. `available` is 1 only when this wallet
   * can pay a fee this instant: synced, holding DUST, and not already holding
   * the spend queue. `ready` is the weaker upstream notion — merely synced —
   * kept because the client reports it, and deliberately NOT what the gate uses.
   *
   * `unavailableCause` is not read by `sponsor.ts`, which ignores unknown
   * fields; it is here because the upstream gateway carries it and an operator
   * reading a raw probe should not have to guess between "no DUST" and "still
   * syncing".
   */
  const walletStatus = async (): Promise<Record<string, unknown>> => {
    let ready = false;
    let dustBalance = 0n;
    let dustUtxoCount = 0;
    let dustSynced = false;
    let syncState = 'syncing';
    try {
      const state = await wallet.currentState();
      const progress = await wallet.progress(state);
      ready = progress.isSynced;
      dustSynced = progress.dust.complete;
      syncState = progress.isSynced ? 'ready' : 'syncing';
      dustBalance = await wallet.dustBalance(state);
      dustUtxoCount = await wallet.dustUtxoCount(state);
    } catch {
      /* A wallet that cannot even answer its own state is not available, and
         saying so is the whole job of this endpoint. */
      syncState = 'unavailable';
    }

    const pending = wallet.isBalancing();
    /* Proving is part of "can pay a fee", not a separate concern: a wallet full
       of DUST that cannot prove the leg it would add is no use to a caller, and
       claiming otherwise would make the demo promise a free transaction and
       then fail — the exact failure `sponsor.ts`'s `available > 0` gate exists
       to prevent. */
    const proving = wallet.provingReadiness();
    const canProve = proving.state === 'ready' || proving.state === 'server';
    const available = ready && dustBalance > 0n && !pending && canProve ? 1 : 0;
    const unavailableCause = available
      ? undefined
      : !ready
        ? 'WALLET_SYNCING'
        : pending
          ? 'PENDING_TRANSACTION'
          : dustBalance <= 0n
            ? 'INSUFFICIENT_DUST'
            : proving.state === 'warming'
              ? 'PROVER_WARMING'
              : 'PROVER_UNAVAILABLE';

    return {
      total: 1,
      available,
      wallets: [
        {
          index: 0,
          ready,
          syncState,
          address: wallet.address,
          dust: {
            // A string, because that is what the client's parser expects; a
            // number could not carry a Speck balance faithfully anyway.
            balance: dustBalance.toString(),
            utxoCount: dustUtxoCount,
            isSynced: dustSynced,
          },
          ...(unavailableCause ? { unavailableCause } : {}),
        },
      ],
    };
  };

  /** `GET /status` — the funder's human answer, for an operator and a monitor. */
  const status = async (): Promise<Record<string, unknown>> => {
    let night = 0n;
    let dust = 0n;
    let progress: Awaited<ReturnType<BalancerWallet['progress']>> | null = null;
    try {
      const state = await wallet.currentState();
      progress = await wallet.progress(state);
      night = await wallet.nightBalance(state);
      dust = await wallet.dustBalance(state);
    } catch {
      // Reported as `synced: false` below rather than as an HTTP failure.
    }
    return {
      network: config.networkId,
      address: wallet.address,
      balanceAtomic: night.toString(),
      balanceNight: formatNight(night),
      dustSpecks: dust.toString(),
      synced: progress?.isSynced ?? false,
      syncSeconds,
      progress,
      proving: wallet.provingMode,
      provingReadiness: wallet.provingReadiness(),
      provingServerUrl: config.provingServerUrl ?? null,
      dustRegistration: registration,
      dustRegistrationDetail: registrationDetail,
      balancesServed,
      lastBalanceAt,
      balancing: wallet.isBalancing(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
      /* Same meaning as `available` on `/wallet-status`: able to pay a fee for
         somebody right now, not merely alive. */
      ready:
        (progress?.isSynced ?? false) &&
        dust > 0n &&
        !wallet.isBalancing() &&
        ['ready', 'server'].includes(wallet.provingReadiness().state),
    };
  };

  /* -------------------------------------------------------------------------- */
  /* HTTP                                                                       */
  /* -------------------------------------------------------------------------- */

  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin?.replace(/\/+$/, '');
    if (!origin || !config.allowedOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-api-key, x-client-id',
      Vary: 'Origin',
    };
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    httpStatus: number,
    body: Record<string, unknown>,
  ): void => {
    response.writeHead(httpStatus, {
      'content-type': 'application/json',
      ...corsHeaders(request),
    });
    response.end(JSON.stringify(body));
  };

  const readRawBody = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('Request body too large.'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });

  /**
   * The demo POSTs `application/octet-stream` — raw serialised transaction
   * bytes — and that is the path that matters. Hex and `{"txBytes": "…"}` are
   * accepted too so an operator can reproduce a failure with `curl` without
   * writing a binary body by hand.
   */
  const transactionBytesFrom = (body: Buffer, contentType: string | undefined): Uint8Array => {
    const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/json') {
      const parsed = JSON.parse(body.toString('utf8')) as { txBytes?: unknown };
      if (typeof parsed.txBytes !== 'string') {
        throw new Error('A JSON body must be of the form {"txBytes": "<hex>"}.');
      }
      return hexToBytes(parsed.txBytes);
    }
    if (type === 'application/octet-stream' || type === undefined || type === '') {
      return new Uint8Array(body);
    }
    // text/plain and friends: hex.
    return hexToBytes(body.toString('utf8').trim());
  };

  const hexToBytes = (value: string): Uint8Array => {
    const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('The transaction is not even-length hexadecimal.');
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      if (request.method === 'GET' && path === '/wallet-status') {
        respond(request, response, 200, await walletStatus());
        return;
      }

      if (request.method === 'GET' && path === '/status') {
        respond(request, response, 200, await status());
        return;
      }

      if (request.method === 'POST' && path === '/balance-only') {
        let bytes: Uint8Array;
        try {
          const body = await readRawBody(request);
          bytes = transactionBytesFrom(body, request.headers['content-type']);
        } catch (cause) {
          respond(request, response, 400, {
            error: 'INVALID_TRANSACTION',
            message:
              'POST the serialised finalized transaction as application/octet-stream, as hex, or as {"txBytes": "<hex>"}.',
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }

        try {
          const result = await wallet.balanceOnly(bytes);
          balancesServed += 1;
          lastBalanceAt = new Date().toISOString();
          console.log(
            `[balance] added a DUST fee leg to ${result.txHash} (${bytes.length} bytes in, ${result.txBytes.length / 2} bytes out, expires ${result.expiresAt})`,
          );
          respond(request, response, 200, { ...result });
        } catch (cause) {
          if (cause instanceof BalanceRefusal) {
            console.warn(`[balance] refused: ${cause.code} — ${cause.message}${cause.cause ? ` (${cause.cause})` : ''}`);
            respond(request, response, cause.status, {
              error: cause.code,
              message: cause.message,
              ...(cause.cause !== undefined ? { cause: cause.cause } : {}),
              ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
            });
            return;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error('[balance] failed', cause);
          respond(request, response, 500, { error: 'BALANCE_FAILED', message });
        }
        return;
      }

      respond(request, response, 404, {
        error: 'not-found',
        message: 'Routes: GET /status, GET /wallet-status, POST /balance-only.',
      });
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
    console.log(
      `listening on http://${config.host}:${config.port} — GET /status, GET /wallet-status, POST /balance-only`,
    );
    console.log('(the wallet is still syncing; /wallet-status answers honestly meanwhile)\n');
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
  console.error('\nBALANCER FAILED TO START');
  console.error(cause);
  process.exit(1);
});
