/**
 * The colour an item is minted under, pinned.
 *
 * The separator IS the colour: `tokenType(separator, faucet address)`. So the
 * one thing worth a test that runs on every commit is that the label the
 * service mints under, against the faucet stagenet actually uses, still
 * computes the hex the client's item registry is keyed on. Change either half
 * and this fails loudly instead of quietly minting an anonymous colour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SEPARATOR_LABEL, giftColourHex, separatorBytes } from '../ops/gift-nft.js';

/** `ASSET_FAUCET_DEFAULTS.stagenet` in `../src/config.ts`. */
const STAGENET_FAUCET = '4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f';

/** What the client files as an item, and what `/gift-nft` reports. */
const GENESIS_PASS_COLOUR = '815183a74a98593bf16344ef6e920313f9c57ccb2feef3f9fe944ba5c4079e26';

describe('the item colour', () => {
  it('is the one the client pins for the genesis pass', () => {
    assert.equal(giftColourHex(DEFAULT_SEPARATOR_LABEL, STAGENET_FAUCET), GENESIS_PASS_COLOUR);
  });

  it('is a label in ASCII, zero-padded to 32 bytes — never mUSD’s separator', () => {
    const bytes = separatorBytes(DEFAULT_SEPARATOR_LABEL);
    assert.equal(bytes.length, 32);
    assert.equal(new TextDecoder().decode(bytes.slice(0, DEFAULT_SEPARATOR_LABEL.length)), DEFAULT_SEPARATOR_LABEL);
    assert.ok(bytes.slice(DEFAULT_SEPARATOR_LABEL.length).every((byte) => byte === 0));
    assert.notEqual(bytes[0], 6);
  });
});
