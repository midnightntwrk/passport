/**
 * Drills for the activity trail's rules.
 *
 * The trail is the only place in Passport where a person can go back and check
 * what happened to their money, so every way it can mislead is worth a test:
 * a time that rounds the wrong way, a day heading taken off the wrong calendar,
 * a dot that flattens "nothing happened" into "done", and a stored row that
 * paints a half-empty line because nothing refused it on the way in.
 *
 * The clock is always passed in. Nothing here reads `Date.now()` except the
 * two cases that deliberately exercise the default argument.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_KEEP,
  ACTIVITY_VISIBLE,
  activityDot,
  activityStorageKey,
  dayHeading,
  groupActivityByDay,
  readStoredActivity,
  relativeTime,
  serialiseActivity,
  type ActivityFeedEntry,
} from './activityFeed.js';

/** A fixed local noon, so a "yesterday" test cannot straddle a midnight. */
const NOW = new Date(2026, 7, 30, 12, 0, 0);

function at(offsetMs: number): string {
  return new Date(NOW.getTime() - offsetMs).toISOString();
}

function entry(overrides: Partial<ActivityFeedEntry> = {}): ActivityFeedEntry {
  return {
    id: 'row-1',
    label: 'Sent NIGHT',
    detail: 'To alice.night.',
    status: 'complete',
    createdAt: at(0),
    ...overrides,
  };
}

describe('activityDot', () => {
  it('gives “done” and “in flight” their own dots', () => {
    expect(activityDot('complete')).toBe('complete');
    expect(activityDot('pending')).toBe('pending');
  });

  it('sends both “nothing happened” and “it failed” to the same dot', () => {
    // Different sentences, one signal: this row wants reading.
    expect(activityDot('blocked')).toBe('attention');
    expect(activityDot('error')).toBe('attention');
  });
});

describe('relativeTime', () => {
  it('says “just now” for anything under three quarters of a minute', () => {
    expect(relativeTime(at(0), NOW)).toBe('just now');
    expect(relativeTime(at(44_999), NOW)).toBe('just now');
  });

  it('rounds minutes and hours DOWN, never up', () => {
    // 119 seconds is one minute of elapsed time, not two.
    expect(relativeTime(at(119_000), NOW)).toBe('1 min ago');
    expect(relativeTime(at(45_000), NOW)).toBe('1 min ago');
    expect(relativeTime(at(9 * 60_000), NOW)).toBe('9 min ago');
    expect(relativeTime(at(59 * 60_000), NOW)).toBe('59 min ago');
    expect(relativeTime(at(60 * 60_000), NOW)).toBe('1 hour ago');
    expect(relativeTime(at(3 * 60 * 60_000 + 59 * 60_000), NOW)).toBe('3 hours ago');
  });

  it('counts whole days past the first', () => {
    expect(relativeTime(at(24 * 3_600_000), NOW)).toBe('1 day ago');
    expect(relativeTime(at(9 * 24 * 3_600_000), NOW)).toBe('9 days ago');
  });

  it('reads a future timestamp and an unreadable one as “just now”', () => {
    // Two clocks disagreeing, not a negative age.
    expect(relativeTime(at(-60_000), NOW)).toBe('just now');
    expect(relativeTime('not a date', NOW)).toBe('just now');
  });

  it('reads the clock itself when none is passed', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now');
  });
});

describe('dayHeading', () => {
  it('names today and yesterday rather than dating them', () => {
    expect(dayHeading(at(0), NOW)).toBe('Today');
    expect(dayHeading(new Date(2026, 7, 29, 23, 30).toISOString(), NOW)).toBe('Yesterday');
  });

  it('separates “today” from “less than 24 hours ago”', () => {
    // 12 hours before local noon is still today; 13 is yesterday evening. An
    // elapsed-milliseconds test would call both "today" and be wrong once.
    expect(dayHeading(new Date(2026, 7, 30, 0, 30).toISOString(), NOW)).toBe('Today');
    expect(dayHeading(new Date(2026, 7, 29, 23, 0).toISOString(), NOW)).toBe('Yesterday');
  });

  it('dates anything older in the house format', () => {
    expect(dayHeading(new Date(2026, 7, 21, 9, 0).toISOString(), NOW)).toBe('2026/08/21');
    // Both halves zero-padded, which a naive join gets wrong in January.
    expect(dayHeading(new Date(2026, 0, 5, 9, 0).toISOString(), NOW)).toBe('2026/01/05');
  });

  it('crosses a month boundary backwards', () => {
    const firstOfMonth = new Date(2026, 8, 1, 9, 0);
    expect(dayHeading(new Date(2026, 7, 31, 22, 0).toISOString(), firstOfMonth)).toBe('Yesterday');
  });

  it('files an unreadable timestamp under “Earlier” rather than dropping it', () => {
    expect(dayHeading('not a date', NOW)).toBe('Earlier');
  });

  it('reads the clock itself when none is passed', () => {
    expect(dayHeading(new Date().toISOString())).toBe('Today');
  });
});

describe('groupActivityByDay', () => {
  it('sorts newest first regardless of the order it was handed', () => {
    const groups = groupActivityByDay(
      [
        entry({ id: 'old', createdAt: at(3 * 60_000) }),
        entry({ id: 'new', createdAt: at(0) }),
        entry({ id: 'middle', createdAt: at(60_000) }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe('Today');
    expect(groups[0].entries.map((row) => row.id)).toEqual(['new', 'middle', 'old']);
  });

  it('opens a new group per day and keeps the days in order', () => {
    const groups = groupActivityByDay(
      [
        entry({ id: 'today-a', createdAt: at(60_000) }),
        entry({ id: 'today-b', createdAt: at(2 * 60_000) }),
        entry({ id: 'yesterday', createdAt: new Date(2026, 7, 29, 9, 0).toISOString() }),
        entry({ id: 'older', createdAt: new Date(2026, 7, 20, 9, 0).toISOString() }),
      ],
      NOW,
    );
    expect(groups.map((group) => group.heading)).toEqual(['Today', 'Yesterday', '2026/08/20']);
    expect(groups[0].entries).toHaveLength(2);
  });

  it('shows only the newest ten by default, and honours a smaller limit', () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      entry({ id: `row-${index}`, createdAt: at(index * 60_000) }),
    );
    const all = groupActivityByDay(many, NOW);
    expect(all.flatMap((group) => group.entries)).toHaveLength(ACTIVITY_VISIBLE);
    expect(all[0].entries[0].id).toBe('row-0');
    const three = groupActivityByDay(many, NOW, 3);
    expect(three.flatMap((group) => group.entries).map((row) => row.id)).toEqual([
      'row-0',
      'row-1',
      'row-2',
    ]);
  });

  it('keeps a row with an unreadable timestamp, at the bottom, under “Earlier”', () => {
    const groups = groupActivityByDay(
      [entry({ id: 'broken', createdAt: 'not a date' }), entry({ id: 'good', createdAt: at(0) })],
      NOW,
    );
    expect(groups.map((group) => group.heading)).toEqual(['Today', 'Earlier']);
    expect(groups[1].entries[0].id).toBe('broken');
  });

  it('is empty for an empty trail', () => {
    expect(groupActivityByDay([], NOW)).toEqual([]);
  });

  it('reads the clock itself when none is passed', () => {
    const groups = groupActivityByDay([entry({ createdAt: new Date().toISOString() })]);
    expect(groups[0].heading).toBe('Today');
  });
});

describe('activityStorageKey', () => {
  it('scopes the trail to one credential, under a versioned prefix', () => {
    expect(activityStorageKey('cred-a')).toBe('midnight.passport.activity.v1:cred-a');
    expect(activityStorageKey('cred-a')).not.toBe(activityStorageKey('cred-b'));
  });
});

describe('readStoredActivity', () => {
  it('reads back what serialiseActivity wrote, hash and network and all', () => {
    const rows = [
      entry({ id: 'a', txHash: 'ab'.repeat(32), network: 'stagenet' }),
      entry({ id: 'b', status: 'pending', detail: '' }),
    ];
    expect(readStoredActivity(serialiseActivity(rows))).toEqual(rows);
  });

  it('reads nothing stored, and storage somebody else wrote over, as an empty trail', () => {
    expect(readStoredActivity(null)).toEqual([]);
    expect(readStoredActivity(undefined)).toEqual([]);
    expect(readStoredActivity('')).toEqual([]);
    expect(readStoredActivity('{not json')).toEqual([]);
    expect(readStoredActivity('{"rows":[]}')).toEqual([]);
  });

  it('refuses every row that would paint something invented', () => {
    const stored = JSON.stringify([
      'a string where a row should be',
      null,
      { ...entry(), id: 42 },
      { ...entry(), id: '' },
      { ...entry(), label: undefined },
      { ...entry(), label: '' },
      { ...entry(), detail: 7 },
      { ...entry(), status: 'queued' },
      { ...entry(), createdAt: 1_700_000_000 },
      { ...entry(), createdAt: 'not a date' },
    ]);
    expect(readStoredActivity(stored)).toEqual([]);
  });

  it('drops a hash or a network that is not a usable string, keeping the row', () => {
    // Neither is worth refusing a row over: without them it simply carries no
    // link out, which is the same state a row that never had a transaction is
    // in. Refusing the row would hide something that really happened.
    const stored = JSON.stringify([
      { ...entry({ id: 'no-hash' }), txHash: '', network: '' },
      { ...entry({ id: 'bad-hash' }), txHash: 123, network: 7 },
    ]);
    const read = readStoredActivity(stored);
    expect(read.map((row) => row.id)).toEqual(['no-hash', 'bad-hash']);
    expect(read.every((row) => row.txHash === undefined)).toBe(true);
    expect(read.every((row) => row.network === undefined)).toBe(true);
  });

  it('accepts every status addActivity can write', () => {
    const stored = JSON.stringify(
      (['pending', 'complete', 'blocked', 'error'] as const).map((status, index) =>
        entry({ id: `row-${index}`, status }),
      ),
    );
    expect(readStoredActivity(stored)).toHaveLength(4);
  });
});

describe('serialiseActivity', () => {
  it('keeps fifty rows and forgets the rest', () => {
    const many = Array.from({ length: 64 }, (_, index) => entry({ id: `row-${index}` }));
    const written = readStoredActivity(serialiseActivity(many));
    expect(written).toHaveLength(ACTIVITY_KEEP);
    expect(written[0].id).toBe('row-0');
    expect(written[ACTIVITY_KEEP - 1].id).toBe(`row-${ACTIVITY_KEEP - 1}`);
  });

  it('writes no field the reader would discard', () => {
    const written = JSON.parse(
      serialiseActivity([{ ...entry(), source: 'chain' } as ActivityFeedEntry]),
    ) as Record<string, unknown>[];
    expect(Object.keys(written[0]).sort()).toEqual([
      'createdAt',
      'detail',
      'id',
      'label',
      'status',
    ]);
  });
});
