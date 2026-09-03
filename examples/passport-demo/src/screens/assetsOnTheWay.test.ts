import { describe, expect, it } from 'vitest';

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
  it('leads the list, and names no figure', () => {
    /* The reviewer asked for the opening balance to read as pending from the
       moment activation begins. What it must NOT do is name an amount this
       device has not been told, which would be the settled-looking balance the
       same review objected to. */
    expect(assetsOnTheWay([], { openingBalance: true })).toEqual([
      { id: 'opening-balance', label: 'Your opening balance' },
    ]);
    expect(assetsOnTheWayLine(assetsOnTheWay([], { openingBalance: true }))).toBe(
      'On the way · Your opening balance',
    );
  });

  it('sits above whatever else is arriving', () => {
    expect(
      assetsOnTheWay([{ id: 'x', label: 'Transfer in', status: 'pending', source: 'chain' }], {
        openingBalance: true,
      }),
    ).toEqual([
      { id: 'opening-balance', label: 'Your opening balance' },
      { id: 'x', label: 'Transfer in' },
    ]);
  });

  it('is absent unless asked for', () => {
    expect(assetsOnTheWay([], { openingBalance: false })).toEqual([]);
    expect(assetsOnTheWay(undefined, {})).toEqual([]);
  });

  it('is offered even when there is no trail at all', () => {
    /* A Passport whose account has just been deployed has nothing on its trail
       yet, and that is exactly the moment the line is needed. */
    expect(assetsOnTheWay(undefined, { openingBalance: true })).toEqual([
      { id: 'opening-balance', label: 'Your opening balance' },
    ]);
  });
});
