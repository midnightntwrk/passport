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
