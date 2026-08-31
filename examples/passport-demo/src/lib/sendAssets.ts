/**
 * What a Passport can send, and where each of those things is allowed to go.
 *
 * WHY THE SEND SHEET WAS INVERTED (2026/08/31)
 * --------------------------------------------
 * Until this date the Send sheet decided what was being sent by looking at the
 * RECIPIENT: an `mn_addr…` meant NIGHT, an `mn_shield-addr…` meant one of the
 * shielded colours the account held, and the person sending never chose. That
 * reads fine in a demo with one token in it and stops being true the moment an
 * account holds several — "right now I can only send NIGHT; I want to be able
 * to send mUSD, and any other asset I have going forward" (2026/08/31).
 *
 * Inferring the asset from the address also puts the two decisions in the wrong
 * order. Somebody sending money knows WHAT they are sending before they know
 * where; and an address that silently re-picked the asset is the shape of a
 * wrong send, because the field that changed is not the field that was touched.
 *
 * So the asset is chosen first, and it is the asset that says which recipients
 * are valid. This module holds both halves of that as plain data:
 * {@link buildSendAssets} turns what the account holds into the list the picker
 * offers, and {@link recipientRuleFor} says, for one chosen asset, which kind
 * of recipient it can be paid to and — in the asset's own name — what to say
 * about one it cannot.
 *
 * THE RECIPIENT TYPE DECIDES TOO (2026/08/31, later the same day)
 * ----------------------------------------------------------------
 * The first pass of the inversion left one dead end in it: a shielded asset was
 * refused a `.night` name outright, in a sentence claiming that a name is
 * always paid in NIGHT. That was a fact about what had been BUILT and not about
 * the ledger, and stating it as a fact about the ledger is exactly the kind of
 * confident wrong sentence this module exists to avoid.
 *
 * So a rule is now asked about the PAIR — the chosen asset and the kind of
 * recipient in the field — and it is told what the Passport behind the sheet
 * can actually do ({@link SendCapabilities}). The agreed model then reads
 * straight off {@link routeFor}: a shielded ADDRESS takes a withdrawal only, a
 * PASSPORT takes the account route, in either asset.
 *
 * The address TAXONOMY is not here and does not move: the wallet SDK's own
 * codec still decides whether a string is an address, whose network it belongs
 * to, and which of the two ledgers it names. This module only checks that
 * answer against what was chosen. One authority on what an address is, one
 * authority on what may be sent to it.
 *
 * Nothing here touches the DOM, React, the network, or the wallet SDK, which is
 * the point: the rules that decide where money is allowed to go are drilled
 * directly in `src/lib/sendAssets.test.ts` rather than through a sheet.
 */

import {
  classifyHolding,
  describeColours,
  NIGHT_COLOUR_HEX,
  nftTitle,
  normalisedColourHex,
  sortTokenHoldings,
  type HoldingClass,
} from './colour.js';

/**
 * Which ledger an asset lives on, and therefore which kind of address can
 * receive it. The same two words the Send sheet's own `Mode` uses, because they
 * are the same distinction.
 */
export type SendAssetMode = 'unshielded' | 'shielded';

/** The picker's identity for NIGHT. Not a colour: NIGHT is not held in `coins`. */
export const NIGHT_ASSET_ID = 'night';

/** One thing the account can send. */
export interface SendAsset {
  /**
   * Stable identity for the picker — {@link NIGHT_ASSET_ID} for NIGHT, and the
   * ledger colour for everything else. A colour is 64 hex characters, so the
   * two can never collide.
   */
  id: string;
  /** What leads the option, named across the whole list so no two read alike. */
  symbol: string;
  /** The line beside it: what kind of thing this is, or the shortened colour. */
  name: string;
  /** How many decimal places an amount of it is quoted with. */
  decimals: number;
  mode: SendAssetMode;
  /** Whether this is a balance or a one-of-a-kind item. See `classifyHolding`. */
  kind: HoldingClass;
  /**
   * The raw ledger colour the shielded withdrawal is keyed by, or `null` for
   * NIGHT — which the unshielded withdrawal names no colour for at all.
   */
  tokenType: string | null;
  /** How much of it the account holds, in this asset's own atomic units. */
  available: bigint | null;
  /**
   * The only amount this asset can be sent in, when there is only one.
   *
   * An item is a thing you either send or do not: there is no quantity to
   * choose, so the amount is stated rather than typed. `null` for everything
   * that is a balance.
   */
  amountCap: bigint | null;
}

/** The shape of a holding this module can file. */
export interface SendAssetHolding {
  tokenType: string;
  amount: bigint;
}

export interface BuildSendAssetsInput {
  /** Atomic NIGHT the account holds, or `null` when it is not known yet. */
  nightBalance: bigint | null;
  /**
   * The shielded colours the account holds, or `null` when nothing has been
   * read yet. An empty array is a real answer — an account holding nothing
   * shielded — and yields NIGHT alone.
   */
  holdings: readonly SendAssetHolding[] | null;
  /** The colour the fee sponsor named for itself, when it named one. */
  sponsored?: { colourHex: string; symbol: string } | null;
}

/**
 * Everything the account can send, in the order the picker offers it.
 *
 * NIGHT IS ALWAYS FIRST, AND ALWAYS PRESENT. It is the one asset every Passport
 * can send, it is the only thing a name can be paid in, and a picker whose
 * first entry moved about between renders would be a picker somebody could
 * mis-tap. It is listed even at a zero or unknown balance: the amount field
 * below already says what is available, and removing the entry would replace a
 * readable "0 NIGHT available" with a puzzle about where NIGHT went.
 *
 * Everything else follows in {@link sortTokenHoldings}' order — the same order
 * the balance list on Home puts colours in — so the list somebody has been
 * looking at all week is the list they are choosing from. Items are not
 * separated out: an account with one item and one token has two things it can
 * send, and hiding one of them behind a second control would be inventing a
 * distinction the ledger does not make about spending.
 *
 * The whole list is NAMED AT ONCE through {@link describeColours}, not one
 * entry at a time. A colour named in isolation cannot know that another colour
 * beside it was given the same ticker, and two options both reading "mUSD" over
 * different money is exactly the wrong-send this picker exists to prevent.
 */
export function buildSendAssets(input: BuildSendAssetsInput): SendAsset[] {
  const { nightBalance, holdings, sponsored = null } = input;
  const shielded = sortTokenHoldings(
    (holdings ?? [])
      /* NIGHT IS NOT A SHIELDED COLOUR, and an entry claiming otherwise would
         put the same money in the picker twice — once as the entry above, once
         as a shielded one that cannot reach an unshielded address. The account
         keeps NIGHT in its own map, so nothing should ever report it here; this
         is what makes that true rather than assumed. */
      .filter((held) => normalisedColourHex(held.tokenType) !== NIGHT_COLOUR_HEX)
      .map((held) => ({ colourHex: held.tokenType, amount: held.amount })),
    sponsored,
  );
  const identities = describeColours(
    [NIGHT_COLOUR_HEX, ...shielded.map((held) => held.colourHex)],
    sponsored,
  );
  const night = identities[0];
  const assets: SendAsset[] = [
    {
      id: NIGHT_ASSET_ID,
      symbol: night.symbol,
      name: night.name,
      decimals: night.decimals,
      mode: 'unshielded',
      kind: 'token',
      tokenType: null,
      available: nightBalance,
      amountCap: null,
    },
  ];
  shielded.forEach((held, index) => {
    const identity = identities[index + 1];
    const kind = classifyHolding(held, sponsored);
    assets.push({
      id: held.colourHex,
      /* An item's handle is RE-NOUNED rather than renamed: `nftTitle` turns the
         `Token · a1b2…` the naming authority produced into `Item · a1b2…`, so
         the four characters that tell two items apart are the same four
         characters everywhere else in Passport. */
      symbol: kind === 'nft' ? nftTitle(identity.symbol) : identity.symbol,
      name: identity.name,
      decimals: identity.decimals,
      mode: 'shielded',
      kind,
      tokenType: held.colourHex,
      available: held.amount,
      /* An item is sent whole or not at all. The rule that made it an item is
         that the account holds exactly one, so the cap is that one. */
      amountCap: kind === 'nft' ? 1n : null,
    });
  });
  return assets;
}

/**
 * What the Passport behind the sheet can actually do, as far as these rules
 * care.
 *
 * There is exactly one of these, and it exists because "where may this asset
 * go" stopped being a question about the LEDGER alone on 2026/08/31. Paying a
 * name in a shielded asset is possible — the deposit side of an account is
 * permissionless and takes a whole note — but it is a route the host has to
 * implement and hand in, and a build without it must refuse a name rather than
 * offer one it cannot pay. So the rule is told what the host can do, instead of
 * guessing from the asset alone.
 *
 * It defaults to what a host that supplies nothing can do, which is the honest
 * default: a sheet with no shielded-name seam behind it refuses a name for a
 * shielded asset, exactly as every build before that date did.
 */
export interface SendCapabilities {
  /** Whether a `.night` name can be paid in a shielded asset. */
  shieldedToName: boolean;
}

/** What a host that supplies no shielded-name seam can do. */
const NO_CAPABILITIES: SendCapabilities = { shieldedToName: false };

/** What a recipient field currently contains, as far as this rule cares. */
export type SendRecipientKind =
  /** An address the SDK's codec has already placed on one of the two ledgers. */
  | { kind: 'address'; mode: SendAssetMode }
  /** A `.night` name the registry has been asked about. */
  | { kind: 'name' };

/** Where one chosen asset is allowed to go, and what to say about anywhere else. */
export interface RecipientRule {
  /** The one kind of address this asset can be paid to. */
  accepts: SendAssetMode;
  /** Whether a `.night` name may stand in for that address. */
  acceptsName: boolean;
  /** The sentence for an address on the other ledger. */
  addressRefusal: string;
  /** The sentence for a name, when a name cannot be paid in this asset. */
  nameRefusal: string | null;
}

/**
 * Where an asset may be sent.
 *
 * THE LEDGER'S HALF, which no capability changes:
 *
 * NIGHT is unshielded. `nativeToken()` is tagged `unshielded`, the ledger keys
 * its balance check by that tag, and the account keeps the two in separate
 * maps — so NIGHT cannot reach a shielded address by any route. A shielded
 * colour cannot reach an unshielded address for the mirror-image reason. That
 * is what `accepts` and `addressRefusal` are about, and both are facts rather
 * than choices this app made.
 *
 * THE RECIPIENT'S HALF, which is where 2026/08/31 changed something. Until that
 * date this said "a name is always paid in NIGHT", and it was wrong about the
 * ledger rather than merely cautious: what a name resolves to is an ACCOUNT,
 * and an account's shielded deposit is as permissionless as its unshielded one
 * — it takes one whole note rather than a colour and an amount, which is a
 * constraint on how the payment is assembled and not on whether it can be made.
 * What was really true was that nothing behind the sheet had been built to
 * assemble it. That is a fact about the HOST, so the host now states it: see
 * {@link SendCapabilities}.
 *
 * The two halves compose the way the agreed model reads — a shielded ADDRESS
 * takes a withdrawal, a PASSPORT takes the account route — and the sheet's own
 * dispatch is on that same pair rather than on the asset alone.
 *
 * Every sentence NAMES THE ASSET. "That is a shielded address" leaves the
 * reader to work out which of the two things they are holding is the problem;
 * "mUSD goes to a shielded address — this is an unshielded one" tells them, and
 * tells them in the same ticker the picker above is showing. None of them names
 * any machinery: what is refused is a send, not a subsystem. The refusal a
 * capability-less host earns says what PASSPORT cannot do, because that is what
 * is true — never that the ledger forbids it, which would be a tidier sentence
 * and a false one.
 */
export function recipientRuleFor(
  asset: SendAsset,
  capabilities: SendCapabilities = NO_CAPABILITIES,
): RecipientRule {
  if (asset.mode === 'unshielded') {
    return {
      accepts: 'unshielded',
      acceptsName: true,
      addressRefusal: `${asset.symbol} goes to an unshielded (mn_addr…) address — this is a shielded one.`,
      nameRefusal: null,
    };
  }
  return {
    accepts: 'shielded',
    acceptsName: capabilities.shieldedToName,
    addressRefusal: `${asset.symbol} goes to a shielded (mn_shield-addr…) address — this is an unshielded one.`,
    nameRefusal: capabilities.shieldedToName
      ? null
      : `This Passport cannot pay a name in ${asset.symbol}. Choose NIGHT above, or paste a shielded (mn_shield-addr…) address.`,
  };
}

/**
 * The chosen asset, checked against what is in the recipient field.
 *
 * `null` means the two agree. Anything else is the sentence to show, and the
 * sheet shows it INSTEAD OF sending — never by quietly changing the asset to
 * suit the address, which is the behaviour this whole inversion replaced.
 */
export function refusalFor(
  asset: SendAsset,
  recipient: SendRecipientKind,
  capabilities: SendCapabilities = NO_CAPABILITIES,
): string | null {
  const rule = recipientRuleFor(asset, capabilities);
  if (recipient.kind === 'name') return rule.acceptsName ? null : rule.nameRefusal;
  return recipient.mode === rule.accepts ? null : rule.addressRefusal;
}

/**
 * WHICH SEND this pair is, once both halves are known and agreed.
 *
 * The agreed model, said as data: a shielded ADDRESS gets a withdrawal only; a
 * PASSPORT — which is what a `.night` name resolves to — gets the account
 * route. Until 2026/08/31 the sheet dispatched on the recipient FIRST and the
 * asset second, so a shielded asset paid to a name was unreachable by
 * construction rather than by rule; this makes the pair the thing that decides,
 * which is the only shape in which all four combinations can be read at once.
 *
 * `null` when the two do not go together at all — {@link refusalFor} owns the
 * sentence for that, and this deliberately does not repeat it.
 */
export type SendRoute =
  /** NIGHT to an `mn_addr…`. One transaction out of the account. */
  | 'night-address'
  /** NIGHT to a Passport. Out of the sender's account, then into theirs. */
  | 'night-name'
  /** A shielded colour to an `mn_shield-addr…`. One transaction. */
  | 'shielded-address'
  /** A shielded colour to a Passport. Out, then into their account. */
  | 'shielded-name';

export function routeFor(
  asset: SendAsset,
  recipient: SendRecipientKind,
  capabilities: SendCapabilities = NO_CAPABILITIES,
): SendRoute | null {
  if (refusalFor(asset, recipient, capabilities) !== null) return null;
  if (recipient.kind === 'name') {
    return asset.mode === 'shielded' ? 'shielded-name' : 'night-name';
  }
  return asset.mode === 'shielded' ? 'shielded-address' : 'night-address';
}
