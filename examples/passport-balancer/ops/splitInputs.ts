/**
 * Choosing, pinning, and PROVING the UTxOs a split spends.
 *
 * Split out of `./split-night.ts` for one reason: everything here is pure, and
 * the guarantee it provides is the one worth testing. `split-night.ts` cannot
 * be imported by a test without pulling in the wallet SDK, the ledger WASM, and
 * a network client; this module imports nothing at all, so `node --test` can
 * exercise the selector and the verifier directly.
 *
 * THE PROBLEM. `WalletFacade.transferTransaction` does its own coin selection
 * and offers no way to name inputs — the argument type is `{ type, outputs }`
 * and `{ ttl, payFees }`, with no `inputs` field in the type or the runtime
 * (`wallet-sdk-facade/dist/index.d.ts:427-433`). The selector it uses,
 * `chooseCoin` in `wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`, is
 * SMALLEST-FIRST and called repeatedly until the outputs are covered. On this
 * wallet the smallest NIGHT UTxO is the original ~4,998.9 coin, so any
 * self-send would consume THAT first — the coin the ruling protects — and then
 * break a 5,000 anyway to make up the shortfall.
 *
 * THE FIX. `V1Builder.withCoinSelection` replaces that selector wholesale, and
 * the selector is the only way a UTxO becomes an unshielded input:
 * `makeTransfer` passes it to `#balanceSegment` → `getBalanceRecipe`, whose
 * `doBalance` adds inputs from nowhere else
 * (`wallet-sdk-unshielded-wallet/dist/v1/Transacting.js:100,114,243-255`;
 * `wallet-sdk-capabilities/dist/balancer/Balancer.js:28-62`). A selector that
 * only returns UTxOs from an allow-list therefore makes a protected coin
 * unreachable rather than merely unlikely.
 *
 * AND THEN WE CHECK ANYWAY. {@link assertOnlyChosenInputs} reads the built
 * transaction's own unshielded offers before anything is signed. Two
 * independent checks of the same property, because the cost of being wrong is
 * the balancer's fee-paying DUST.
 */

/** Atomic units per NIGHT — the ledger carries six decimals. */
const ATOMIC_PER_NIGHT = 1_000_000n;

/** A refusal an operator can act on, as distinct from a crash. */
export class Refusal extends Error {}

/** The parts of `ledger.Utxo` this module needs. */
export interface UtxoLike {
  readonly intentHash: string;
  readonly outputNo: number;
  readonly value: bigint;
  readonly type: string;
}

/**
 * How a UTxO is named on the command line and in the printed plan:
 * `<intentHash>:<outputNo>`.
 *
 * `intentHash` and not "transaction hash", because `intentHash` is what the
 * ledger keys a UTxO by (`ledger-v9.d.ts:1856-1876`) and therefore the only
 * identifier this tool can match without guessing. The operator is not expected
 * to know it: `--plan --live` prints one line per NIGHT UTxO with its hash, its
 * value, its age, and its registration flag, and the reference is copied from
 * there. A PREFIX is accepted so the paste can be short, but an ambiguous
 * prefix is a refusal rather than a coin toss.
 */
export interface UtxoRef {
  readonly intentHashPrefix: string;
  readonly outputNo: number;
}

export function parseUtxoRef(raw: string): UtxoRef {
  const [hash, index] = raw.split(':');
  if (!hash || !/^[0-9a-fA-F]{4,}$/.test(hash)) {
    throw new Error(
      `"${raw}" is not a UTxO reference — expected <intentHash>:<outputNo>, with at least four hex characters of hash`,
    );
  }
  if (index === undefined || !/^\d+$/.test(index)) {
    throw new Error(`"${raw}" is missing its output index — expected <intentHash>:<outputNo>`);
  }
  return { intentHashPrefix: hash.toLowerCase(), outputNo: Number(index) };
}

/** The key the allow-list, the verifier, and every printed line agree on. */
export function utxoKey(utxo: { intentHash: string; outputNo: number }): string {
  return `${String(utxo.intentHash).toLowerCase()}:${utxo.outputNo}`;
}

export function matchesRef(utxo: { intentHash: string; outputNo: number }, ref: UtxoRef): boolean {
  return (
    utxo.outputNo === ref.outputNo &&
    String(utxo.intentHash).toLowerCase().startsWith(ref.intentHashPrefix)
  );
}

/**
 * Resolves each reference to exactly one of the wallet's NIGHT UTxOs.
 *
 * Every failure mode here is a refusal and not a best effort: a reference that
 * matches nothing is a typo or a stale plan, and a reference that matches two
 * UTxOs is a prefix the operator thought was unique. Either way, guessing would
 * mean spending a coin nobody named.
 */
export function resolveRefs<T extends { utxo: { intentHash: string; outputNo: number } }>(
  candidates: readonly T[],
  refs: readonly UtxoRef[],
): T[] {
  const chosen: T[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const matches = candidates.filter((candidate) => matchesRef(candidate.utxo, ref));
    if (matches.length === 0) {
      throw new Refusal(
        `no NIGHT UTxO matches ${ref.intentHashPrefix}…:${ref.outputNo} — run --plan --live and copy the reference from its listing`,
      );
    }
    if (matches.length > 1) {
      throw new Refusal(
        `${ref.intentHashPrefix}…:${ref.outputNo} matches ${matches.length} UTxOs — lengthen the hash prefix`,
      );
    }
    const key = utxoKey(matches[0]!.utxo);
    if (seen.has(key)) throw new Refusal(`${key} was named twice`);
    seen.add(key);
    chosen.push(matches[0]!);
  }
  return chosen;
}

/** `1000` or `1000.5` → atomic NIGHT. Six decimals, no more. */
export function parseNightAmount(raw: string | undefined): bigint {
  if (!raw || !/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error('expected NIGHT as a decimal with at most six places, e.g. 1000 or 1000.5');
  }
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole!) * ATOMIC_PER_NIGHT + BigInt(fraction.padEnd(6, '0'));
}

export interface PinnedSelector {
  /** Replaces the SDK's smallest-first `chooseCoin`. */
  select: (coins: readonly UtxoLike[], tokenType: string) => UtxoLike | undefined;
  /** The only UTxOs it will ever hand out. Populated after the wallet syncs. */
  readonly allow: Set<string>;
  /** Everything it actually handed out, in order. The audit trail. */
  readonly handedOut: string[];
  /** Token types it was asked for and could not supply from the allow-list. */
  readonly refusedFor: string[];
}

/**
 * A selector that can only ever return UTxOs from {@link PinnedSelector.allow}.
 *
 * Within the allow-list it keeps the SDK's own smallest-first order, so the
 * change output lands where the SDK would have put it. Outside it, it returns
 * `undefined`, which `doBalance` turns into an `InsufficientFundsError` — the
 * build fails, which is exactly the outcome we want when the only way to finish
 * would be to spend a coin the operator protected.
 */
export function createPinnedSelector(): PinnedSelector {
  const allow = new Set<string>();
  const handedOut: string[] = [];
  const refusedFor: string[] = [];
  return {
    allow,
    handedOut,
    refusedFor,
    select(coins, tokenType) {
      const permitted = coins
        .filter((coin) => coin.type === tokenType && allow.has(utxoKey(coin)))
        .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      const coin = permitted.at(0);
      if (!coin) {
        refusedFor.push(tokenType);
        return undefined;
      }
      handedOut.push(utxoKey(coin));
      return coin;
    },
  };
}

/** The parts of `ledger.UnprovenTransaction` the verifier reads. */
export interface TransactionLike {
  readonly intents?:
    | ReadonlyMap<
        number,
        {
          readonly guaranteedUnshieldedOffer?: { readonly inputs: readonly UtxoLike[] } | undefined;
          readonly fallibleUnshieldedOffer?: { readonly inputs: readonly UtxoLike[] } | undefined;
        }
      >
    | undefined;
}

/**
 * The last gate before a signature, and the one that does not take the
 * selector's word for it: it reads the BUILT transaction's unshielded offers
 * and asserts every input in them is a UTxO the operator named.
 *
 * Returns the keys it saw, so the caller can print them.
 */
export function assertOnlyChosenInputs(
  transaction: TransactionLike,
  chosenKeys: ReadonlySet<string>,
  selector: PinnedSelector,
): string[] {
  for (const key of selector.handedOut) {
    if (!chosenKeys.has(key)) {
      throw new Refusal(`the selector handed out ${key}, which was not among --inputs`);
    }
  }

  const intents = transaction.intents;
  if (!intents) {
    throw new Refusal(
      'the built transaction carries no intents — nothing to verify, so nothing signed',
    );
  }
  const seen = new Set<string>();
  for (const intent of intents.values()) {
    for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
      for (const input of offer?.inputs ?? []) {
        const key = utxoKey(input);
        seen.add(key);
        if (!chosenKeys.has(key)) {
          throw new Refusal(
            `the built transaction would spend ${key}, which is NOT among --inputs. Nothing was signed or submitted.`,
          );
        }
      }
    }
  }
  if (seen.size === 0) {
    throw new Refusal(
      'the built transaction spends no unshielded input at all — refusing to sign it',
    );
  }
  return [...seen];
}
