import { describe, expect, it } from 'vitest';

import {
  OPENING_BALANCE_ON_THE_WAY_DETAIL,
  OPENING_BALANCE_ON_THE_WAY_LABEL,
} from '../lib/activation.js';
import { assetsOnTheWay, assetsOnTheWayLine } from './assetsOnTheWay.js';

describe('assetsOnTheWay', () => {
  it('returns nothing for an empty trail', () => {
    expect(assetsOnTheWay([])).toEqual([]);
    expect(assetsOnTheWay(undefined)).toEqual([]);
  });

  it('reports a pending row that names a transaction', () => {
    expect(
      assetsOnTheWay([{ id: 'a', label: 'Grant arriving', status: 'pending', txHash: '0xabc' }]),
    ).toEqual([{ id: 'a', label: 'Grant arriving' }]);
  });

  it('reports a pending row stamped as off-device', () => {
    expect(assetsOnTheWay([{ id: 'b', label: 'Transfer in', status: 'pending', source: 'chain' }]))
      .toEqual([{ id: 'b', label: 'Transfer in' }]);
  });

  it('ignores a completed row', () => {
    expect(
      assetsOnTheWay([{ id: 'c', label: 'Grant arrived', status: 'complete', txHash: '0xabc' }]),
    ).toEqual([]);
  });

  it('ignores a pending row that never left this device', () => {
    expect(assetsOnTheWay([{ id: 'd', label: 'Signing in', status: 'pending', source: 'local' }]))
      .toEqual([]);
  });

  it('names one arrival and counts several', () => {
    expect(assetsOnTheWayLine([])).toBeNull();
    expect(assetsOnTheWayLine([{ id: 'a', label: 'Grant arriving' }])).toBe(
      'On the way · Grant arriving',
    );
    expect(
      assetsOnTheWayLine([
        { id: 'a', label: 'Grant arriving' },
        { id: 'b', label: 'Transfer in' },
      ]),
    ).toBe('On the way · 2 amounts still arriving');
  });
});

describe('the opening balance', () => {
  const openingRow = {
    id: 'opening-balance',
    label: OPENING_BALANCE_ON_THE_WAY_LABEL,
    detail: OPENING_BALANCE_ON_THE_WAY_DETAIL,
  };

  it('leads the list, and names the two figures it is waiting for', () => {
    /* The reviewer asked for the opening balance to read as pending from the
       moment activation begins, and on 2026/09/03 for the expected figures to
       be visible while it is. Both are the sponsor's fixed grant, so naming
       them promises nothing this device has not been told — and the line still
       leads with `On the way`, so it is never read as a settled balance. */
    expect(assetsOnTheWay([], { openingBalance: true })).toEqual([openingRow]);
    expect(assetsOnTheWayLine(assetsOnTheWay([], { openingBalance: true }))).toBe(
      'On the way · 100 mUSD and 0.002 NIGHT are being added to your account.',
    );
  });

  it('sits above whatever else is arriving', () => {
    expect(
      assetsOnTheWay([{ id: 'x', label: 'Transfer in', status: 'pending', source: 'chain' }], {
        openingBalance: true,
      }),
    ).toEqual([openingRow, { id: 'x', label: 'Transfer in' }]);
  });

  it('is absent unless asked for', () => {
    expect(assetsOnTheWay([], { openingBalance: false })).toEqual([]);
    expect(assetsOnTheWay(undefined, {})).toEqual([]);
  });

  it('is offered even when there is no trail at all', () => {
    /* A Passport whose account has just been deployed has nothing on its trail
       yet, and that is exactly the moment the line is needed. */
    expect(assetsOnTheWay(undefined, { openingBalance: true })).toEqual([openingRow]);
  });
});
