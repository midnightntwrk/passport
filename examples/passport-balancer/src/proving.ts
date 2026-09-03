/**
 * How many proofs this service has outstanding, and why anything cares.
 *
 * The stall watchdog in `./reservation.ts` aborts a spend job that has reported
 * no step for `BALANCER_JOB_STALL_MS`. That rule is only safe because of the
 * counter in this module: a contract proof is legitimately minutes long and
 * reports nothing at all while it runs, so a watchdog that could not tell
 * "proving" from "wedged" would abort healthy registrations. The watchdog
 * therefore fires only while {@link proofsInFlight} is zero — nothing of ours is
 * at the prover, so a job that is not moving is not working either.
 *
 * It is a process-wide counter rather than a value threaded through the call
 * graph because the four places that prove are nowhere near each other: the
 * fee-leg prover inside `/balance-only`, `finalizeRecipe` inside the contract
 * wallet provider, and midnight-js's own `proveTx` for a contract deploy or
 * call — the last of which this service reaches only by wrapping the provider
 * it hands to midnight-js.
 *
 * The same counter is what `/status` publishes as `proofInFlight`, and what the
 * resolver-pool filler reads before it decides the sponsor is busy.
 */

let outstanding = 0;

/** How many proofs are at the prover right now. */
export function proofsInFlight(): number {
  return outstanding;
}

/** True while NOTHING of ours is at the prover. See the module note. */
export function proverIdle(): boolean {
  return outstanding === 0;
}

/**
 * Counts `work` as a proof for as long as it runs.
 *
 * The decrement is in a `finally`, so a proof that fails still stops being
 * counted — a leaked increment would disable the stall watchdog for the life of
 * the process, which is the failure this whole change exists to prevent.
 */
export async function countingProof<T>(work: () => Promise<T>): Promise<T> {
  outstanding += 1;
  try {
    return await work();
  } finally {
    outstanding -= 1;
  }
}

/** For tests that need a known starting point. */
export function resetProofCounter(): void {
  outstanding = 0;
}

/* -------------------------------------------------------------------------- */
/* The WALLET's own circuits, proved over the configured route                 */
/* -------------------------------------------------------------------------- */

/** A transaction that can prove itself — all this needs of the ledger's type. */
interface ProvableTransaction {
  prove(provingProvider: unknown, costModel: unknown): Promise<unknown>;
}

/** The shape `WalletFacade.init({ provingService })` expects back. */
export interface WalletProvingService {
  prove(tx: ProvableTransaction): Promise<unknown>;
}

/**
 * The ZK config provider for a wallet's own circuits: one that never serves.
 *
 * Every key location the wallet proves is a `midnight/…` protocol builtin —
 * `midnight/zswap/spend`, `midnight/zswap/output`, `midnight/dust/spend` — and
 * midnight-js's key-material resolver reads a refusal from a flat provider as
 * "not ours, the proof server has it". Refusing is therefore the correct
 * answer, and cheaper than fetching artefacts that would be discarded.
 */
const SERVER_RESOLVES_SYSTEM_CIRCUITS = {
  get(keyLocation: string): Promise<never> {
    return Promise.reject(
      new Error(
        `'${keyLocation}' is a protocol circuit; the proof server resolves its key material.`,
      ),
    );
  },
};

/**
 * The wallet's proving service, over `BALANCER_PROVER_URL` WITH ITS PATH.
 *
 * WHY NOT THE SDK'S OWN CLIENT. `makeServerProvingService` builds
 * `wallet-sdk-prover-client`'s `HttpProverClient`, which composes its endpoint
 * as `new URL('/prove', base)`. `/prove` is an ABSOLUTE path, so the base's
 * path is discarded: `https://…/prover` became `https://…/prove`, the origin
 * root. On this droplet that root is routed straight to the local proof server,
 * so the wallet's DUST and Zswap legs — every fee leg this service proves, and
 * the split tool's — never reached the 1AM gateway at all. Measured
 * 2026/09/03: 132 `POST /prove` at the local proof server between 13:11 and
 * 14:07 while `BALANCER_PROVER_URL` named the gateway route.
 *
 * midnight-js's `httpClientProvingProvider` composes as
 * `pathname.replace(/\/$/, '') + '/prove'`, which KEEPS the path, so
 * `https://…/prover` posts to `https://…/prover/prove` — the route Caddy sends
 * to the gateway first and to `127.0.0.1:6300` only as a fallback. It is the
 * same client the contract leg has always used
 * (`createContractProofProvider` in `./contractRuntime.ts`), so both legs of a
 * spend now go the same way.
 *
 * Built lazily, on the first proof: constructing a wallet must not depend on a
 * dynamic import that has nothing to do yet.
 */
export function httpWalletProvingService(
  url: string,
  options: { timeoutMs?: number } = {},
): WalletProvingService {
  let building: Promise<unknown> | null = null;
  const provingProvider = (): Promise<unknown> => {
    building ??= (async () => {
      const [{ httpClientProvingProvider }, { CONTRACT_PROOF_TIMEOUT_MS }] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
        import('./contractRuntime.js'),
      ]);
      return httpClientProvingProvider(url, SERVER_RESOLVES_SYSTEM_CIRCUITS as never, {
        timeout: options.timeoutMs ?? CONTRACT_PROOF_TIMEOUT_MS,
      });
    })();
    return building;
  };

  return {
    async prove(tx: ProvableTransaction): Promise<unknown> {
      const ledger = await import('@midnightntwrk/ledger-v9');
      return tx.prove(await provingProvider(), ledger.CostModel.initialCostModel());
    },
  };
}
