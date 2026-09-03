/**
 * Drills for the two pure decisions in `gift-nft.ts`: what a label becomes as a
 * 32-byte domain separator, and how the arguments are read.
 *
 * Worth drilling because the separator IS the colour. A label that silently
 * truncated, or that collided with the mUSD separator, would mint the sponsor's
 * stablecoin under an item's name — and the failure would land on chain before
 * anybody could see it. Run as `split-night`'s tests are:
 *
 *   npx esbuild ops/giftSeparator.test.ts --bundle --format=esm --platform=node \
 *     --packages=external --outfile=dist/ops/giftSeparator.test.mjs
 *   node --test dist/ops/giftSeparator.test.mjs
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ITEM_NAME, DEFAULT_SEPARATOR_LABEL, parseArgs, separatorBytes } from './gift-nft.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('separatorBytes', () => {
  it('is the label in ASCII, left-aligned and zero-padded to 32', () => {
    strictEqual(
      hex(separatorBytes(DEFAULT_SEPARATOR_LABEL)),
      '6d69646e696768742d67656e657369732d706173730000000000000000000000',
    );
  });

  it('never produces the mUSD separator', () => {
    /* mUSD's is 32 zero bytes with a leading 0x06, which is not printable
       ASCII and so is unreachable from any label this accepts. A collision
       would mint the sponsor's stablecoin under an item's name. */
    const musd = new Uint8Array(32);
    musd[0] = 0x06;
    for (const label of ['a', 'midnight-genesis-pass', 'x'.repeat(32)]) {
      strictEqual(hex(separatorBytes(label)) === hex(musd), false);
    }
  });

  it('refuses a label too long to fit rather than truncating it', () => {
    /* Truncation would make two different labels one currency — the only
       mistake in this tool that would not announce itself. */
    throws(() => separatorBytes('x'.repeat(33)), /33 bytes/);
  });

  it('refuses anything that is not printable ASCII', () => {
    throws(() => separatorBytes('genesis pass ✨'), /printable ASCII/);
    throws(() => separatorBytes('   '), /printable ASCII/);
  });

  it('takes the label as typed, trimming only the shell around it', () => {
    deepStrictEqual(separatorBytes(' genesis '), separatorBytes('genesis'));
  });
});

describe('parseArgs', () => {
  it('defaults to one Genesis Pass and to planning rather than minting', () => {
    const options = parseArgs(['--account', 'ab'.repeat(32)]);
    strictEqual(options.separator, DEFAULT_SEPARATOR_LABEL);
    strictEqual(options.name, DEFAULT_ITEM_NAME);
    strictEqual(options.amount, 1n);
    strictEqual(options.execute, false);
  });

  it('accepts --dry-run for the operator who says it out loud', () => {
    strictEqual(parseArgs(['--dry-run']).execute, false);
  });

  it('refuses an amount that could not be an item at all', () => {
    throws(() => parseArgs(['--amount', '0']), /must be positive/);
  });

  it('refuses a flag with no value, rather than eating the next flag', () => {
    throws(() => parseArgs(['--account', '--execute']), /needs a value/);
  });

  it('refuses an argument it does not know', () => {
    throws(() => parseArgs(['--colour', 'red']), /unknown argument/);
  });
});
