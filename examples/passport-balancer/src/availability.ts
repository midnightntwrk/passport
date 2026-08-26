/**
 * The one decision `GET /wallet-status` exists to publish: can this wallet pay
 * somebody's fee right now?
 *
 * It lives in its own module because it is a POLICY, not a reading, and because
 * the client gates on it absolutely — `sponsor.ts` will not even attempt a
 * `/balance-only` while `available` is 0. A policy with that much authority
 * should be readable on its own and testable without a chain.
 *
 * The four inputs, and why each one is here:
 *
 *   - `synced` — an unsynced wallet cannot select coins it has not seen.
 *   - `dustSpecks` — the fee is DUST, and the SDK's balance already excludes
 *     coins another in-flight transaction has reserved, so this figure falls on
 *     its own when the wallet really is out of usable DUST.
 *   - `reserved` — a CLAIM on the wallet's coin state is outstanding. This is
 *     deliberately not "a job is running": see `./reservation.ts`. A grant that
 *     is proving holds nothing, and reporting it as busy is what took fee
 *     sponsorship down for two minutes at a time.
 *   - `proving` — a wallet full of DUST that cannot prove the leg it would add
 *     is no use to a caller, and claiming otherwise makes the demo promise a
 *     free transaction and then fail.
 */

/** Exactly the states `BalancerWallet.provingReadiness()` reports. */
export type ProvingState = 'server' | 'ready' | 'warming' | 'failed';

export interface AvailabilityInput {
  synced: boolean;
  dustSpecks: bigint;
  reserved: boolean;
  proving: ProvingState;
}

export interface Availability {
  available: 0 | 1;
  /**
   * Not read by `sponsor.ts`, which ignores unknown fields; it is here because
   * the upstream gateway carries it and an operator reading a raw probe should
   * not have to guess between "no DUST" and "still syncing".
   */
  unavailableCause?: string;
}

export function walletAvailability(input: AvailabilityInput): Availability {
  const canProve = input.proving === 'ready' || input.proving === 'server';
  if (input.synced && input.dustSpecks > 0n && !input.reserved && canProve) {
    return { available: 1 };
  }
  if (!input.synced) return { available: 0, unavailableCause: 'WALLET_SYNCING' };
  if (input.reserved) return { available: 0, unavailableCause: 'PENDING_TRANSACTION' };
  if (input.dustSpecks <= 0n) return { available: 0, unavailableCause: 'INSUFFICIENT_DUST' };
  if (input.proving === 'warming') return { available: 0, unavailableCause: 'PROVER_WARMING' };
  return { available: 0, unavailableCause: 'PROVER_UNAVAILABLE' };
}
