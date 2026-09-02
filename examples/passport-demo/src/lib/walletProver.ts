/**
 * The WALLET's own circuits, proved over HTTP — with the URL's path intact and
 * more than one proof server allowed.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026/09/02 the facade was handed a single `provingServerUrl` and the
 * wallet SDK built its own client from it. That client is
 * `wallet-sdk-prover-client`'s `HttpProverClient`, and it composes its endpoint
 * as `new URL('/prove', baseUrl)` — an ABSOLUTE path, which replaces whatever
 * path the base URL carried. So `https://67-205-177-162.sslip.io/prover`
 * became `https://67-205-177-162.sslip.io/prove`, which on the deployed Caddy
 * is the catch-all: it answers `200` with no `Access-Control-Allow-Origin`, the
 * browser blocks the preflight, and the proof never happens.
 *
 * That is the whole of the shielded-send bug. NIGHT moves through
 * `withdraw_night` and `deposit_night`, which need no wallet-side Zswap spend
 * proof, so unshielded sends were unaffected. `deposit_shielded` needs one —
 * and it is the SECOND leg, so the note had already left the sender's account
 * when the proof died. `contractRuntime.ts` then reported the blocked preflight
 * as "the sponsor cannot cover this one right now", and the note sat in the
 * passkey wallet with no control anywhere in the app to move it.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The facade is given a `provingService` rather than a URL, so the SDK's
 * origin-only client is never constructed. Proving goes through
 * `httpClientProvingProvider` from `@midnight-ntwrk/midnight-js-http-client-
 * proof-provider`, which builds its endpoint as `pathname + '/prove'` and
 * therefore keeps the path — the same client the CONTRACT path has always used,
 * through the same {@link failoverProvingProvider}. One failover rule now
 * serves both, so a proof server that dies mid-transaction costs a retry rather
 * than the transfer, for the wallet's circuits exactly as for the contract's.
 *
 * KEY MATERIAL. The wallet's circuits are the protocol builtins —
 * `midnight/zswap/spend`, `midnight/zswap/output`, `midnight/dust/spend` — and
 * those are not contract key locations: the proof server resolves them from its
 * own copy of the public bucket. midnight-js's resolver asks a ZK config
 * provider anyway and treats a refusal as "no key material, let the server
 * supply it", so {@link SERVER_RESOLVES_SYSTEM_CIRCUITS} refuses by design
 * rather than fetching artefacts that would be thrown away. This is what the
 * contract path already does for the same circuits, which is why the console
 * has been printing `[contract] prove midnight/zswap/spend by …/prover` on the
 * contract side all along.
 */

import { CostModel } from '@midnightntwrk/ledger-v9';

import { failoverProvingProvider, PROOF_TIMEOUT_MS } from '../identity/contractRuntime.js';
import type { ProvingProviderLike } from '../identity/contractRuntime.js';

/**
 * A transaction that can prove itself, which is all this module needs of one.
 * The wallet SDK hands its `provingService` the ledger's own transaction type.
 */
export interface ProvableTransaction {
  prove(provingProvider: unknown, costModel: unknown): Promise<unknown>;
}

/** The shape `WalletFacade.init({ provingService })` expects back. */
export interface WalletProvingService {
  prove(tx: ProvableTransaction): Promise<unknown>;
}

export interface HttpWalletProvingServiceOptions {
  /**
   * Where key material for a circuit is resolved, when it is resolvable here.
   * Defaults to {@link SERVER_RESOLVES_SYSTEM_CIRCUITS}; injected by the drills.
   */
  zkConfigProvider?: unknown;
  /** How long one circuit gets. Defaults to the contract path's own timeout. */
  timeoutMs?: number;
}

/**
 * The ZK config provider for a wallet's own circuits: one that never serves.
 *
 * Every key location the wallet proves is a `midnight/…` protocol builtin, and
 * midnight-js's key-material resolver reads a refusal from a flat provider as
 * "not ours — the proof server has it". Refusing is therefore the correct
 * answer, and it is a great deal cheaper than fetching a contract's manifest
 * for a lookup whose result would be discarded.
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
 * A wallet proving service over an ORDERED LIST of proof servers.
 *
 * The returned value is the `provingService` factory `WalletFacade.init` takes:
 * it is called with the facade's own configuration, which nothing here needs.
 * The proving provider is built once, lazily, on the first proof — building it
 * eagerly would make constructing a wallet depend on a dynamic import that has
 * nothing to do yet.
 */
export function httpWalletProvingService(
  urls: readonly string[],
  options: HttpWalletProvingServiceOptions = {},
): (configuration: unknown) => WalletProvingService {
  if (urls.length === 0) {
    /* By name, at construction. The alternative is a wallet that starts
       cleanly and fails at its first spend with a message about `undefined`. */
    throw new Error(
      'A wallet proving service needs at least one proof server (VITE_MIDNIGHT_PROVING_URL).',
    );
  }
  const zkConfigProvider = options.zkConfigProvider ?? SERVER_RESOLVES_SYSTEM_CIRCUITS;
  const timeout = options.timeoutMs ?? PROOF_TIMEOUT_MS;

  let building: Promise<ProvingProviderLike> | null = null;
  const provingProvider = (): Promise<ProvingProviderLike> => {
    building ??= (async () => {
      const { httpClientProvingProvider } = await import(
        '@midnight-ntwrk/midnight-js-http-client-proof-provider'
      );
      return failoverProvingProvider(
        urls.map((url) => ({
          url,
          provider: httpClientProvingProvider(url, zkConfigProvider as never, {
            timeout,
          }) as ProvingProviderLike,
        })),
      );
    })();
    return building;
  };

  return () => ({
    async prove(tx: ProvableTransaction): Promise<unknown> {
      return tx.prove(await provingProvider(), CostModel.initialCostModel());
    },
  });
}
