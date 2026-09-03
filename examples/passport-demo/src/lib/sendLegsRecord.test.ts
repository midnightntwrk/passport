/**
 * The one drill that admitting `sendLegs.ts` to the coverage bar cost.
 *
 * It lives beside `sendLegs.test.ts` rather than inside it because the change
 * that put `sendLegs.ts` into `coverage.include` owns this file and does not
 * own that one: a drill written for a coverage decision should not reach into
 * a module's existing suite while somebody else may be editing it.
 *
 * What it holds to account is the record written BEFORE the first leg is
 * submitted — the moment between deciding to pay and spending anything, when
 * there is no transaction hash and nothing to wait for yet. The serialiser has
 * to leave those keys out rather than write `undefined`: `JSON.stringify`
 * drops an undefined value silently, so the two look identical on the way out
 * and differ only when the stored shape is compared or migrated.
 */

import { describe, expect, it } from 'vitest';

import {
  readPendingSends,
  serialisePendingSends,
  type PendingSend,
} from './sendLegs.js';

const NOW = '2026-09-02T14:00:00.000Z';

/** A NIGHT run at its first leg, with nothing optional filled in yet. */
function unstartedNightSend(): PendingSend {
  return {
    id: 'send-1',
    kind: 'night',
    recipient: { label: 'alice.night', accountAddress: 'ab'.repeat(32) },
    amount: '1000000',
    colourHex: '00'.repeat(32),
    ownReceivingAddress: 'mn_addr_stagenet1alice',
    leg: 'withdraw',
    withdrawTxHash: undefined,
    expectedNote: undefined,
    lastError: undefined,
    activityId: undefined,
    attempts: { withdraw: 0, deposit: 0, change: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('serialisePendingSends', () => {
  it('writes no key for a half a run has not reached yet', () => {
    const written = serialisePendingSends([unstartedNightSend()]);
    const [row] = JSON.parse(written) as Record<string, unknown>[];
    expect(Object.keys(row)).not.toContain('withdrawTxHash');
    expect(Object.keys(row)).not.toContain('expectedNote');
    expect(Object.keys(row)).not.toContain('tokenType');
    expect(Object.keys(row)).not.toContain('lastError');
    expect(Object.keys(row)).not.toContain('activityId');
    // And it still reads back as the run it is, rather than being dropped.
    expect(readPendingSends(written)).toHaveLength(1);
  });
});
