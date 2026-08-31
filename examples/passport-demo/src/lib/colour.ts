/**
 * Token colours, normalised and shortened.
 *
 * A Midnight token is identified by its COLOUR — 32 bytes, quoted as 64
 * lowercase hex characters by the ledger, by `colourHexToBytes`, and by the
 * sponsor's own `/status` and `/fund-account` answers. Three separate places
 * in the app read a colour out of somewhere it does not control (build
 * configuration, a sponsor response, the ledger itself), and every one of them
 * has to agree on what counts as one.
 *
 * These two functions lived inside `App.tsx` until 2026/08/25. They moved here
 * for the reason anything moves out of that file: they are pure, they decide
 * something that shows up on screen, and a unit test can hold them to it.
 * Nothing about their behaviour changed.
 */

/**
 * A token colour as both the ledger and `colourHexToBytes` quote it — 64
 * lowercase hex characters — or `null` for anything that is not one.
 *
 * Strict on purpose, and for the caller's own reason: a short value is a
 * misconfiguration rather than an abbreviation, and padding it would make
 * Passport show one colour's balance under another colour's name.
 */
export function normalisedColourHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/** A colour, shortened for a label. It identifies nothing to a reader whole. */
export function shortColour(colourHex: string): string {
  return colourHex.length <= 18 ? colourHex : `${colourHex.slice(0, 10)}…${colourHex.slice(-6)}`;
}

/* -------------------------------------------------------------------------- */
/* Naming a colour (2026/08/30)                                               */
/* -------------------------------------------------------------------------- */

/**
 * NIGHT's colour: 32 zero bytes, as `nativeToken()` quotes it.
 *
 * Not read from the ledger module on purpose. This file is imported by the
 * screens, and `identity/accountCustody.ts` — where `nightColourHex()` lives —
 * statically pulls the whole wallet SDK in behind it.
 */
export const NIGHT_COLOUR_HEX = '0'.repeat(64);

/**
 * The demo stablecoin's colour on stagenet, as minted by the fee sponsor.
 *
 * Hard-coded as a FALLBACK, not as the truth: the sponsor's own `/status`
 * answers `assetColourHex` and `assetSymbol`, and where it does, that answer
 * wins (see the `sponsored` argument to {@link describeColour}). This entry is
 * what names the colour on a build that cannot reach the sponsor, which would
 * otherwise show a stablecoin as an anonymous 64-character string.
 */
export const MUSD_COLOUR_HEX =
  '1a2917fbed8b5ce44d12ebc7d337689045f6c96a6bbd39cf3d8691ab310ef6a6';

/** What a colour is called on screen. */
export interface TokenIdentity {
  /** What leads the row — a ticker, or `Token · 1a29…` for a colour we cannot name. */
  symbol: string;
  /** The line under it: what kind of thing this is, or the shortened colour. */
  name: string;
  /**
   * How many decimal places the amount is quoted with.
   *
   * Six for NIGHT, and ZERO for every shielded colour — including the ones
   * named here. That is not an omission: a shielded colour is minted by a
   * contract and carries no decimal scale anywhere on the ledger, so an amount
   * is a whole count of that colour's own atomic units and any scale Passport
   * applied would be one it had invented. This is the one place to change if a
   * colour ever publishes a real one.
   */
  decimals: number;
  /** False when nothing could name it, which is what the `Token · …` form means. */
  known: boolean;
}

/** Colours Passport can name without asking anybody. */
const KNOWN_COLOURS: Readonly<Record<string, { symbol: string; name: string; decimals: number }>> =
  {
    [NIGHT_COLOUR_HEX]: { symbol: 'NIGHT', name: 'native token', decimals: 6 },
    [MUSD_COLOUR_HEX]: { symbol: 'mUSD', name: 'stablecoin', decimals: 0 },
  };

/**
 * What to call a colour.
 *
 * `sponsored` is the colour the fee sponsor named for itself over `/status`,
 * and it OUTRANKS the table above: the sponsor mints that asset, so it is the
 * only authority on what it is called, and a build pointed at a different
 * sponsor would otherwise show that sponsor's asset under this one's ticker.
 *
 * A colour nobody can name gets `Token · 1a29…` with the shortened colour
 * beneath it. Never the raw 64 characters: they identify nothing to a reader,
 * they are the same width as every other colour on the screen, and a row of
 * them is what made the balance list unreadable in the first place.
 */
export function describeColour(
  colourHex: string,
  sponsored?: { colourHex: string; symbol: string } | null,
): TokenIdentity {
  const normalised = normalisedColourHex(colourHex) ?? colourHex.trim().toLowerCase();
  if (sponsored && normalisedColourHex(sponsored.colourHex) === normalised) {
    return { symbol: sponsored.symbol, name: 'stablecoin', decimals: 0, known: true };
  }
  const known = KNOWN_COLOURS[normalised];
  if (known) return { ...known, known: true };
  return {
    symbol: `Token · ${normalised.slice(0, 4)}…`,
    name: shortColour(normalised),
    decimals: 0,
    known: false,
  };
}

/** How many token rows a balance list shows before "Show all". */
export const TOKENS_VISIBLE = 5;

/**
 * The order a balance list puts colours in.
 *
 * NIGHT first, because it is the one token every Passport has and the only one
 * a fee, a transfer, or an opening balance is ever quoted in. Then everything
 * that has a name, alphabetically, because a named row is a row somebody is
 * looking FOR and alphabetical is the only order they can predict. Then the
 * unnamed, largest holding first, because with nothing to read but four
 * characters of colour the amount is the only thing that distinguishes them.
 *
 * Ties break on the colour itself, so the order is total and a list does not
 * reshuffle between two renders of the same balances.
 */
export function sortTokenHoldings<T extends { colourHex: string; amount: bigint }>(
  holdings: readonly T[],
  sponsored?: { colourHex: string; symbol: string } | null,
): T[] {
  const ranked = holdings.map((held) => {
    const identity = describeColour(held.colourHex, sponsored);
    const normalised = normalisedColourHex(held.colourHex) ?? held.colourHex.toLowerCase();
    const rank = normalised === NIGHT_COLOUR_HEX ? 0 : identity.known ? 1 : 2;
    return { held, identity, normalised, rank };
  });
  ranked.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.rank === 1) {
      const bySymbol = left.identity.symbol.localeCompare(right.identity.symbol);
      if (bySymbol !== 0) return bySymbol;
    } else if (left.rank === 2 && left.held.amount !== right.held.amount) {
      return left.held.amount > right.held.amount ? -1 : 1;
    }
    return left.normalised < right.normalised ? -1 : left.normalised > right.normalised ? 1 : 0;
  });
  return ranked.map((entry) => entry.held);
}

/**
 * Names a whole screenful of colours at once, so no two of them read the same.
 *
 * {@link describeColour} answers about one colour in isolation, and in
 * isolation it cannot know that another colour on the same screen has been
 * given the same ticker. That happens for real: the fee sponsor names ITS
 * colour over `/status`, and a deployment whose sponsor mints a different
 * "mUSD" from the one in the table above would show two rows, both labelled
 * mUSD, holding different money. Seen on 2026/08/30 in the mocked tier, which
 * is exactly the configuration that produces it.
 *
 * A symbol shown twice is not a name, so where one repeats, every row that
 * carries it gains four characters of its own colour. Rows with a symbol
 * nobody else shares are left exactly as they were — the disambiguation is
 * paid for only where it is needed.
 */
export function describeColours(
  colourHexes: readonly string[],
  sponsored?: { colourHex: string; symbol: string } | null,
): TokenIdentity[] {
  const normalised = colourHexes.map(
    (hex) => normalisedColourHex(hex) ?? hex.trim().toLowerCase(),
  );
  const identities = colourHexes.map((hex) => describeColour(hex, sponsored));
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.symbol)) repeated.add(identity.symbol);
    else seen.add(identity.symbol);
  }
  return identities.map((identity, index) => {
    /* Only a NAME is worth qualifying. A colour nobody could name already
       reads `Token · a1b2…`, and appending the same four characters again
       would produce `Token · a1b2… · a1b2…` — noise where the subtitle
       beneath already carries the tail that tells two of them apart. */
    if (!identity.known || !repeated.has(identity.symbol)) return identity;
    return { ...identity, symbol: `${identity.symbol} · ${normalised[index].slice(0, 4)}…` };
  });
}

/* -------------------------------------------------------------------------- */
/* Tokens and items (2026/08/31)                                              */
/* -------------------------------------------------------------------------- */

/**
 * What kind of thing a holding is, as the Assets screen files it.
 *
 * Two shelves, because a person asked for two: "those assets can be NFTs and
 * tokens". A balance and a one-of-a-kind item are read differently — one is a
 * quantity you spend down, the other is a thing you either have or do not —
 * and putting both on one list makes the second look like a rounding error.
 */
export type HoldingClass = 'token' | 'nft';

/** The least a colour-carrying row has to be for this file to file it. */
export interface ColourHolding {
  colourHex: string;
  amount: bigint;
}

/**
 * Which shelf a holding belongs on.
 *
 * THE RULE: a holding is an item iff the account holds exactly ONE of it AND
 * nothing can name the colour. Both halves matter.
 *
 * The second half is what keeps a NAMED colour off the item shelf however
 * little of it is held: an account down to its last atomic unit of the
 * sponsor's stablecoin holds a stablecoin balance of one, not a collectible,
 * and NIGHT is never an item at any amount. `describeColour` already knows
 * every colour that has a name — the two in `KNOWN_COLOURS` and whatever the
 * fee sponsor named for itself over `/status` — so this asks it rather than
 * keeping a second list that could disagree with the first.
 *
 * The first half is a PROXY, and an honest one to state plainly here because
 * the screen does not state it: a holding of one is not the same fact as a
 * SUPPLY of one, and nothing this app can currently read reports supply. Until
 * a real item source lands, "you hold exactly one of a colour nobody can name"
 * is the closest thing to a one-of-a-kind this ledger will answer, and it is
 * the same evidence a person would use looking at the raw numbers themselves.
 * When that source arrives, this function is the ONE place the rule changes.
 */
export function classifyHolding(
  holding: ColourHolding,
  sponsored?: { colourHex: string; symbol: string } | null,
): HoldingClass {
  if (holding.amount !== 1n) return 'token';
  return describeColour(holding.colourHex, sponsored).known ? 'token' : 'nft';
}

/**
 * The same holdings, split onto the two shelves, IN THE ORDER THEY ARRIVED.
 *
 * Order is the caller's business — {@link sortTokenHoldings} is the authority
 * on it, and a split that re-sorted would silently overrule a caller that had
 * already sorted. So this only partitions: whatever order went in comes out of
 * both halves unchanged.
 */
export function splitHoldings<T extends ColourHolding>(
  holdings: readonly T[],
  sponsored?: { colourHex: string; symbol: string } | null,
): { tokens: T[]; nfts: T[] } {
  const tokens: T[] = [];
  const nfts: T[] = [];
  for (const held of holdings) {
    if (classifyHolding(held, sponsored) === 'nft') nfts.push(held);
    else tokens.push(held);
  }
  return { tokens, nfts };
}

/**
 * What an item card leads with, given the symbol {@link describeColours} gave
 * that colour.
 *
 * `describeColour` calls a colour nobody can name `Token · a1b2…`, which is
 * right on a balance list and wrong on the item shelf: on a card whose whole
 * job is to say "this is a one-of-a-kind thing", the first word must not be
 * "Token". This RE-NOUNS the handle the naming authority already produced
 * rather than inventing a second naming scheme beside it — the four characters
 * are the same four, so two items that read alike here read alike everywhere,
 * and the shortened colour beneath is still what tells them apart.
 *
 * A symbol that is a real ticker is returned untouched. Nothing classified as
 * an item can carry one — the rule above requires that nothing could name the
 * colour — but a function that answers only for its expected input is one the
 * next caller has to read the rule before using.
 */
export function nftTitle(symbol: string): string {
  const prefix = 'Token · ';
  return symbol.startsWith(prefix) ? `Item · ${symbol.slice(prefix.length)}` : symbol;
}
