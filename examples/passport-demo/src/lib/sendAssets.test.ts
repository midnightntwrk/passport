/**
 * Drills for the asset-first Send rules.
 *
 * Two things are being held to account here, and both of them are ways of
 * losing somebody's money rather than ways of looking untidy.
 *
 * The first is the LIST: NIGHT has to be there and has to be first, the rest
 * has to arrive in the same order the balance list on Home puts it in, no two
 * options may read alike, and an item has to arrive as an item with the one
 * amount it can be sent in already on it.
 *
 * The second is the REFUSAL. The whole reason the sheet was inverted is that a
 * pasted address used to re-pick the asset silently; the replacement is only an
 * improvement if the mismatch is refused in words that say WHICH asset is the
 * problem. So the sentences are asserted, not just their existence — including
 * that none of them names any machinery.
 */

import { describe, expect, it } from 'vitest';

import { MUSD_COLOUR_HEX, NIGHT_COLOUR_HEX, sortTokenHoldings } from './colour.js';
import {
  buildSendAssets,
  NIGHT_ASSET_ID,
  recipientRuleFor,
  refusalFor,
  type SendAsset,
} from './sendAssets.js';

const ITEM = 'ab'.repeat(32);
const OTHER_ITEM = 'cd'.repeat(32);
const UNNAMED = 'ef'.repeat(32);
const SPONSOR_COLOUR = 'aa'.repeat(32);

/** The picker's own view of an account: some NIGHT and four shielded colours. */
function fullAccount() {
  return buildSendAssets({
    nightBalance: 12_500_000n,
    holdings: [
      { tokenType: UNNAMED, amount: 40n },
      { tokenType: ITEM, amount: 1n },
      { tokenType: MUSD_COLOUR_HEX, amount: 250n },
      { tokenType: OTHER_ITEM, amount: 1n },
    ],
  });
}

function assetFor(assets: readonly SendAsset[], id: string): SendAsset {
  const found = assets.find((asset) => asset.id === id);
  if (!found) throw new Error(`no asset ${id} in the picker`);
  return found;
}

describe('buildSendAssets — NIGHT', () => {
  it('puts NIGHT first, and describes it as the unshielded thing it is', () => {
    const [first] = fullAccount();
    expect(first.id).toBe(NIGHT_ASSET_ID);
    expect(first.symbol).toBe('NIGHT');
    expect(first.mode).toBe('unshielded');
    expect(first.decimals).toBe(6);
    expect(first.kind).toBe('token');
    /* NIGHT is not held in `coins` and the unshielded withdrawal names no
       colour, so there is nothing to key it by. A colour here would be one this
       module invented. */
    expect(first.tokenType).toBeNull();
    expect(first.available).toBe(12_500_000n);
    expect(first.amountCap).toBeNull();
  });

  it('offers NIGHT with nothing else held, nothing read, and no balance known', () => {
    /* Three separate states that all have to leave a usable picker. An empty
       array is an account that holds nothing shielded; `null` is a read that
       has not answered yet; a null balance is a figure not yet known. None of
       them is a reason to hide the one asset every Passport can send. */
    for (const holdings of [[], null]) {
      const assets = buildSendAssets({ nightBalance: null, holdings });
      expect(assets).toHaveLength(1);
      expect(assets[0].id).toBe(NIGHT_ASSET_ID);
      expect(assets[0].available).toBeNull();
    }
  });

  it('is still NIGHT-first when the account holds far more of something else', () => {
    const assets = buildSendAssets({
      nightBalance: 0n,
      holdings: [{ tokenType: MUSD_COLOUR_HEX, amount: 10_000n }],
    });
    // A zero balance is a real, known figure and does not demote the entry.
    expect(assets.map((asset) => asset.id)).toEqual([NIGHT_ASSET_ID, MUSD_COLOUR_HEX]);
    expect(assets[0].available).toBe(0n);
  });
});

describe('buildSendAssets — order and naming', () => {
  it('follows sortTokenHoldings exactly, so the picker matches the balance list', () => {
    const assets = fullAccount();
    const expected = sortTokenHoldings([
      { colourHex: UNNAMED, amount: 40n },
      { colourHex: ITEM, amount: 1n },
      { colourHex: MUSD_COLOUR_HEX, amount: 250n },
      { colourHex: OTHER_ITEM, amount: 1n },
    ]);
    expect(assets.slice(1).map((asset) => asset.id)).toEqual(
      expected.map((held) => held.colourHex),
    );
    // Named first, then unnamed — largest holding leading the unnamed run.
    expect(assets.map((asset) => asset.id)).toEqual([
      NIGHT_ASSET_ID,
      MUSD_COLOUR_HEX,
      UNNAMED,
      ITEM,
      OTHER_ITEM,
    ]);
  });

  it('lets the fee sponsor outrank the built-in name, and carries its scale', () => {
    const assets = buildSendAssets({
      nightBalance: 1n,
      holdings: [{ tokenType: SPONSOR_COLOUR, amount: 9n }],
      sponsored: { colourHex: SPONSOR_COLOUR, symbol: 'mUSD' },
    });
    expect(assets[1].symbol).toBe('mUSD');
    expect(assets[1].mode).toBe('shielded');
    /* A shielded colour publishes no decimal scale on the ledger, so an amount
       of it is a whole count and the sheet must not offer a decimal point. */
    expect(assets[1].decimals).toBe(0);
    expect(assets[1].tokenType).toBe(SPONSOR_COLOUR);
    expect(assets[1].available).toBe(9n);
  });

  it('never offers two options that read the same', () => {
    /* The real deployment that produces this: the table names one colour mUSD
       and the fee sponsor names a DIFFERENT colour mUSD over `/status`. Two
       options both reading "mUSD" over different money is the wrong-send this
       picker exists to prevent. */
    const assets = buildSendAssets({
      nightBalance: 1n,
      holdings: [
        { tokenType: MUSD_COLOUR_HEX, amount: 5n },
        { tokenType: SPONSOR_COLOUR, amount: 7n },
      ],
      sponsored: { colourHex: SPONSOR_COLOUR, symbol: 'mUSD' },
    });
    const symbols = assets.map((asset) => asset.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols).toContain('mUSD · aaaa…');
  });
});

describe('buildSendAssets — items', () => {
  it('carries an item as an item, capped at the one it can be sent in', () => {
    const item = assetFor(fullAccount(), ITEM);
    expect(item.kind).toBe('nft');
    expect(item.amountCap).toBe(1n);
    expect(item.available).toBe(1n);
    /* Re-nouned from the handle the naming authority produced, so the four
       characters that tell two items apart are the same four everywhere. */
    expect(item.symbol).toBe('Item · abab…');
    expect(item.symbol.startsWith('Token')).toBe(false);
  });

  it('leaves a balance uncapped, however small it is', () => {
    const assets = fullAccount();
    expect(assetFor(assets, MUSD_COLOUR_HEX).kind).toBe('token');
    expect(assetFor(assets, MUSD_COLOUR_HEX).amountCap).toBeNull();
    expect(assetFor(assets, NIGHT_ASSET_ID).amountCap).toBeNull();

    /* The one that must not become an item: a named colour down to its last
       unit is a balance of one, not a collectible. */
    const dust = buildSendAssets({
      nightBalance: 1n,
      holdings: [{ tokenType: MUSD_COLOUR_HEX, amount: 1n }],
    });
    expect(dust[1].kind).toBe('token');
    expect(dust[1].amountCap).toBeNull();
    expect(dust[1].symbol).toBe('mUSD');
  });
});

describe('recipientRuleFor', () => {
  const assets = fullAccount();
  const night = assetFor(assets, NIGHT_ASSET_ID);
  const musd = assetFor(assets, MUSD_COLOUR_HEX);
  const item = assetFor(assets, ITEM);

  it('sends NIGHT to an unshielded address, and to a name', () => {
    const rule = recipientRuleFor(night);
    expect(rule.accepts).toBe('unshielded');
    expect(rule.acceptsName).toBe(true);
    expect(rule.nameRefusal).toBeNull();
    expect(rule.addressRefusal).toBe(
      'NIGHT goes to an unshielded (mn_addr…) address — this is a shielded one.',
    );
  });

  it('sends a shielded asset to a shielded address, and to nothing else', () => {
    const rule = recipientRuleFor(musd);
    expect(rule.accepts).toBe('shielded');
    expect(rule.acceptsName).toBe(false);
    expect(rule.addressRefusal).toBe(
      'mUSD goes to a shielded (mn_shield-addr…) address — this is an unshielded one.',
    );
    expect(rule.nameRefusal).toBe(
      'A name is always paid in NIGHT, so mUSD cannot go to one. Choose NIGHT above, or paste a shielded (mn_shield-addr…) address.',
    );
  });

  it('names an item in its refusals exactly as the picker names it', () => {
    const rule = recipientRuleFor(item);
    expect(rule.addressRefusal).toContain('Item · abab…');
    expect(rule.nameRefusal).toContain('Item · abab…');
  });

  it('never names any machinery in any sentence it can produce', () => {
    /* Constraint (b): the passkey engine is invisible. A refusal is where a
       leak is likeliest, because it is written under pressure about something
       that went wrong. */
    const forbidden = /\b(?:wallet|contract|registry|indexer|resolver|dust)\b/i;
    for (const asset of assets) {
      const rule = recipientRuleFor(asset);
      expect(rule.addressRefusal).not.toMatch(forbidden);
      if (rule.nameRefusal !== null) expect(rule.nameRefusal).not.toMatch(forbidden);
    }
  });
});

describe('refusalFor', () => {
  const assets = fullAccount();
  const night = assetFor(assets, NIGHT_ASSET_ID);
  const musd = assetFor(assets, MUSD_COLOUR_HEX);

  it('agrees silently when the asset and the address are on the same ledger', () => {
    expect(refusalFor(night, { kind: 'address', mode: 'unshielded' })).toBeNull();
    expect(refusalFor(musd, { kind: 'address', mode: 'shielded' })).toBeNull();
  });

  it('refuses an unshielded address for a shielded asset, naming the asset', () => {
    expect(refusalFor(musd, { kind: 'address', mode: 'unshielded' })).toBe(
      'mUSD goes to a shielded (mn_shield-addr…) address — this is an unshielded one.',
    );
  });

  it('refuses a shielded address for NIGHT, naming NIGHT', () => {
    expect(refusalFor(night, { kind: 'address', mode: 'shielded' })).toBe(
      'NIGHT goes to an unshielded (mn_addr…) address — this is a shielded one.',
    );
  });

  it('accepts a name for NIGHT and for nothing else', () => {
    expect(refusalFor(night, { kind: 'name' })).toBeNull();
    expect(refusalFor(musd, { kind: 'name' })).toContain('always paid in NIGHT');
    expect(refusalFor(assetFor(assets, ITEM), { kind: 'name' })).toContain(
      'always paid in NIGHT',
    );
  });
});

describe('the colour NIGHT is quoted by', () => {
  it('is never offered twice, however the account reports itself', () => {
    /* The all-zero colour cannot appear in `coins` — the account keeps NIGHT in
       its own map — but a picker that would duplicate it if it did is one bad
       read away from offering the same money twice. */
    const assets = buildSendAssets({
      nightBalance: 5n,
      holdings: [
        { tokenType: NIGHT_COLOUR_HEX.toUpperCase(), amount: 3n },
        { tokenType: MUSD_COLOUR_HEX, amount: 4n },
      ],
    });
    expect(assets.map((asset) => asset.id)).toEqual([NIGHT_ASSET_ID, MUSD_COLOUR_HEX]);
    expect(assets[0].mode).toBe('unshielded');
    // The balance shown is the account's NIGHT, not the stray entry's 3.
    expect(assets[0].available).toBe(5n);
  });
});
