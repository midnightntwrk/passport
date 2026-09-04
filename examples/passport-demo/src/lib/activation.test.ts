/**
 * Drills for the activation classifier.
 *
 * This is the module that decides whether a Passport's account contract got
 * its opening balance, and it is the one place in the demo where being
 * optimistic costs a user something they cannot see: a wrongly-`deposited`
 * answer writes a once-per-account marker, and the account then sits at zero
 * forever with nothing on screen saying so. Both times that has happened live
 * it was a classification error, not a network one — see the module header —
 * so every answer the sponsor can give is enumerated here.
 *
 * There is no mock of the sponsor. {@link classifyFundAccountAnswer} takes the
 * answer as data, so what is exercised is the real function against the real
 * bodies `examples/passport-balancer` sends; nothing here pretends to be a
 * service.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVATION_DEPOSITED_LABEL,
  ACTIVATION_EXHAUSTED_LABEL,
  ACTIVATION_REFUSED_LABEL,
  ACTIVATION_STABLECOIN_LABEL,
  OPENING_BALANCE_ON_THE_WAY_DETAIL,
  OPENING_BALANCE_ON_THE_WAY_LABEL,
  OPENING_MUSD,
  OPENING_NIGHT,
  activationRetryRowId,
  classifyFundAccountAnswer,
  openingBalanceOnTheWay,
} from './activation.js';

/** A real stagenet account-custody contract address, for the detail strings. */
const ACCOUNT = '7c2f4a19e6d0b83c5194fe2a77bb0c61d8a3e94f20cb5d7e8f16a0b3c4d5e6f7';
/** The demo's mUSD colour, in the shape the sponsor quotes it. */
const MUSD_COLOUR = 'a'.repeat(64);

describe('a transport failure', () => {
  it('is a retry that records nothing at all', () => {
    expect(
      classifyFundAccountAnswer(
        { kind: 'transport-failure', message: 'The operation was aborted.' },
        ACCOUNT,
      ),
    ).toEqual({
      outcome: 'retry',
      reason: 'The operation was aborted.',
      // Nothing is recorded: a network down for one attempt is not a verdict
      // on the grant, and the schedule will ask again.
      rememberFunded: false,
      refreshBalances: false,
      stablecoin: null,
      activities: [],
    });
  });
});

describe('a refusal the sponsor can recover from', () => {
  it('treats a 503 as a retry and keeps the sponsor’s own sentence', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: false,
        status: 503,
        body: { error: 'wallet-syncing', message: 'The sponsor wallet is still syncing.' },
      },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('retry');
    expect(plan.reason).toBe('The sponsor wallet is still syncing.');
    expect(plan.rememberFunded).toBe(false);
    expect(plan.activities).toEqual([]);
  });

  it('treats every other 5xx and a 429 the same way', () => {
    for (const status of [500, 502, 504, 599, 429]) {
      const plan = classifyFundAccountAnswer(
        { kind: 'response', ok: false, status, body: {} },
        ACCOUNT,
      );
      expect(plan.outcome).toBe('retry');
      // No `message` in the body, so the status is quoted rather than invented.
      expect(plan.reason).toBe(`The sponsor answered with status ${status}.`);
    }
  });

  it('ignores an empty `message` and falls back to the status', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: false, status: 503, body: { message: '' } },
      ACCOUNT,
    );
    expect(plan.reason).toBe('The sponsor answered with status 503.');
  });
});

describe('a refusal time cannot fix', () => {
  it('is refused, recorded in the feed, and never marked funded', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: false,
        status: 400,
        body: { error: 'bad-request', message: 'contractAddress is not a contract address.' },
      },
      ACCOUNT,
    );
    expect(plan).toEqual({
      outcome: 'refused',
      reason: 'contractAddress is not a contract address.',
      rememberFunded: false,
      refreshBalances: false,
      stablecoin: null,
      activities: [
        {
          label: 'Opening balance not deposited',
          detail: 'contractAddress is not a contract address.',
          status: 'blocked',
        },
      ],
    });
  });

  it('refuses a 4xx whose body is not JSON at all', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: false, status: 404, body: null },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('refused');
    expect(plan.reason).toBe('The sponsor answered with status 404.');
  });

  it('refuses a 4xx whose `error` is not a string', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: false, status: 403, body: { error: 17 } },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('refused');
  });
});

describe('the grant that already exists', () => {
  it('reads `already-activated` and `already-funded` as deposited', () => {
    for (const error of ['already-activated', 'already-funded']) {
      const plan = classifyFundAccountAnswer(
        { kind: 'response', ok: false, status: 409, body: { error } },
        ACCOUNT,
      );
      expect(plan.outcome).toBe('deposited');
      // The marker IS written here: asking again would only earn the same
      // refusal, and the grant the call wanted is in place.
      expect(plan.rememberFunded).toBe(true);
      expect(plan.refreshBalances).toBe(true);
      // Nothing is announced — this Passport did not just watch it happen.
      expect(plan.activities).toEqual([]);
    }
  });

  it('does not extend that reading to any other refusal code', () => {
    expect(
      classifyFundAccountAnswer(
        { kind: 'response', ok: false, status: 409, body: { error: 'already-asked' } },
        ACCOUNT,
      ).outcome,
    ).toBe('refused');
  });
});

describe('a 200 with both legs in', () => {
  it('is deposited, marked, and announced twice — NIGHT and stablecoin', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: true,
        status: 200,
        body: {
          txHash: 'ab'.repeat(32),
          amountAtomic: '2000',
          assetTx: 'cd'.repeat(32),
          assetAmount: '100 mUSD',
          assetColourHex: MUSD_COLOUR,
          assetSymbol: 'mUSD',
        },
      },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('deposited');
    expect(plan.rememberFunded).toBe(true);
    expect(plan.refreshBalances).toBe(true);
    expect(plan.stablecoin).toEqual({ symbol: 'mUSD', colourHex: MUSD_COLOUR });
    expect(plan.activities).toEqual([
      {
        label: 'Opening balance deposited',
        detail:
          'The sponsor deposited 2000 atomic NIGHT into your account 7c2f4a19e...4d5e6f7.',
        status: 'complete',
        txHash: 'ab'.repeat(32),
      },
      {
        label: 'Stablecoin deposited',
        detail:
          '100 mUSD went into your account 7c2f4a19e...4d5e6f7 alongside the NIGHT.',
        status: 'complete',
        txHash: 'cd'.repeat(32),
      },
    ]);
  });

  it('never names the machinery in what it says', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: true,
        status: 200,
        body: { amountAtomic: '2000', assetTx: 'cd'.repeat(32), assetAmount: '100 mUSD' },
      },
      ACCOUNT,
    );
    const said = plan.activities.map((activity) => `${activity.label} ${activity.detail}`).join(' ');
    // The account is the only thing value ever reaches, and the copy says so.
    expect(said).toMatch(/your account\b/);
    expect(said).not.toMatch(/contract|wallet|DUST|registry|indexer|resolver/i);
    expect(said).not.toContain('mn_addr');
  });

  it('quotes “an opening” rather than inventing an amount the sponsor omitted', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: true, status: 200, body: { amountAtomic: 2000 } },
      ACCOUNT,
    );
    expect(plan.activities[0]?.detail).toContain('deposited an opening atomic NIGHT');
    // No txHash field at all rather than an undefined one.
    expect(Object.keys(plan.activities[0] ?? {})).not.toContain('txHash');
  });

  it('falls back to “The sponsor’s stablecoin” when no amount is named', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: true, status: 200, body: { assetTx: 'cd'.repeat(32) } },
      ACCOUNT,
    );
    expect(plan.activities[1]?.detail).toContain('The sponsor’s stablecoin went into');
  });

  it('ignores a non-string txHash rather than rendering it', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: true, status: 200, body: { txHash: 42 } },
      ACCOUNT,
    );
    expect(plan.activities[0]?.txHash).toBeUndefined();
  });
});

describe('the stablecoin colour the sponsor names', () => {
  it('accepts a 0x-prefixed, upper-case, padded colour', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: true,
        status: 200,
        body: { assetColourHex: `  0x${'A'.repeat(64)}  `, assetSymbol: '  NGT  ' },
      },
      ACCOUNT,
    );
    expect(plan.stablecoin).toEqual({ symbol: 'NGT', colourHex: 'a'.repeat(64) });
  });

  it('defaults the symbol to mUSD, and refuses a colour that is not 32 bytes', () => {
    expect(
      classifyFundAccountAnswer(
        { kind: 'response', ok: true, status: 200, body: { assetColourHex: MUSD_COLOUR } },
        ACCOUNT,
      ).stablecoin,
    ).toEqual({ symbol: 'mUSD', colourHex: MUSD_COLOUR });
    expect(
      classifyFundAccountAnswer(
        {
          kind: 'response',
          ok: true,
          status: 200,
          body: { assetColourHex: MUSD_COLOUR, assetSymbol: '   ' },
        },
        ACCOUNT,
      ).stablecoin?.symbol,
    ).toBe('mUSD');
    // Short, over-long, non-hex, and non-string all read as "no colour named".
    for (const assetColourHex of ['a'.repeat(63), 'a'.repeat(65), `${'z'.repeat(64)}`, 7, null]) {
      expect(
        classifyFundAccountAnswer(
          { kind: 'response', ok: true, status: 200, body: { assetColourHex } },
          ACCOUNT,
        ).stablecoin,
      ).toBeNull();
    }
  });
});

describe('the 200 whose stablecoin leg failed', () => {
  /* The incident this exists for, live 2026/08/25: the NIGHT landed, the mUSD
     did not, the client called it done, wrote the marker, and never asked
     again. The account opened with NIGHT and no mUSD and nothing on screen
     said so. */
  it('is a RETRY, and leaves the marker unwritten', () => {
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: true,
        status: 200,
        body: {
          txHash: 'ab'.repeat(32),
          amountAtomic: '2000',
          assetError: 'the shielded deposit was rejected: insufficient balance',
          assetColourHex: MUSD_COLOUR,
        },
      },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('retry');
    expect(plan.reason).toBe('the shielded deposit was rejected: insufficient balance');
    expect(plan.rememberFunded).toBe(false);
    // The NIGHT that DID land still has to show up.
    expect(plan.refreshBalances).toBe(true);
    // Nothing is announced until both halves are in.
    expect(plan.activities).toEqual([]);
    // The colour still travels: the next attempt deposits that same colour.
    expect(plan.stablecoin).toEqual({ symbol: 'mUSD', colourHex: MUSD_COLOUR });
  });

  it('reads an empty-string assetTx as no stablecoin transaction', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: true, status: 200, body: { assetTx: '', assetError: 'timed out' } },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('retry');
    expect(plan.reason).toBe('timed out');
  });

  it('still finishes when BOTH an assetTx and an assetError came back', () => {
    /* A partial success the sponsor reported on: the leg landed and something
       about it went wrong. The grant is complete, and the sentence says both. */
    const plan = classifyFundAccountAnswer(
      {
        kind: 'response',
        ok: true,
        status: 200,
        body: {
          amountAtomic: '2000',
          assetTx: 'cd'.repeat(32),
          assetError: 'the receipt could not be read back',
        },
      },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('deposited');
    expect(plan.activities[0]?.detail).toContain(
      'The stablecoin half did not land: the receipt could not be read back',
    );
    expect(plan.activities).toHaveLength(2);
  });

  it('ignores a non-string assetError on an otherwise clean 200', () => {
    const plan = classifyFundAccountAnswer(
      { kind: 'response', ok: true, status: 200, body: { assetError: { code: 5 } } },
      ACCOUNT,
    );
    expect(plan.outcome).toBe('deposited');
  });
});

describe('bodies that are not objects', () => {
  it('reads a 200 with a non-object body as a bare deposit', () => {
    for (const body of [null, 'ok', 42, undefined]) {
      const plan = classifyFundAccountAnswer(
        { kind: 'response', ok: true, status: 200, body },
        ACCOUNT,
      );
      expect(plan.outcome).toBe('deposited');
      expect(plan.activities).toHaveLength(1);
      expect(plan.activities[0]?.detail).toContain('an opening atomic NIGHT');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The row that carries the retry (2026/09/02).                               */
/*                                                                            */
/* A grant that never arrives leaves a trail row saying so and, until this     */
/* rule existed, nothing to press. The marker is only written on evidence the  */
/* grant landed, so asking again was always going to work — see               */
/* `activationRetryRowId`. Rows arrive newest first, as `addActivity` writes   */
/* them.                                                                      */
/* -------------------------------------------------------------------------- */

/** A trail row, in the two fields the rule reads. */
const row = (id: string, label: string) => ({ id, label });

describe('the trail row that carries a retry', () => {
  it('is the failure row when nothing has happened since', () => {
    expect(
      activationRetryRowId([
        row('c', ACTIVATION_EXHAUSTED_LABEL),
        row('b', 'Your name is registered'),
        row('a', 'Passport created'),
      ]),
    ).toBe('c');
  });

  it('is the one-attempt refusal too', () => {
    expect(activationRetryRowId([row('c', ACTIVATION_REFUSED_LABEL)])).toBe('c');
  });

  it('is nothing at all when the grant has since landed', () => {
    /* A control here would ask the sponsor for a SECOND opening balance. */
    expect(
      activationRetryRowId([
        row('d', ACTIVATION_DEPOSITED_LABEL),
        row('c', ACTIVATION_EXHAUSTED_LABEL),
      ]),
    ).toBeNull();
  });

  it('is nothing when only the stablecoin half is on the trail above it', () => {
    /* The stablecoin row is written by the same landed answer as the NIGHT
       one, so it is the same evidence and it counts. */
    expect(
      activationRetryRowId([
        row('d', ACTIVATION_STABLECOIN_LABEL),
        row('c', ACTIVATION_EXHAUSTED_LABEL),
      ]),
    ).toBeNull();
  });

  it('steps over rows that are about anything else', () => {
    /* A send made after a failed grant must not hide the failed grant. */
    expect(
      activationRetryRowId([
        row('e', 'Sent to bob.night'),
        row('d', 'Your name is registered'),
        row('c', ACTIVATION_EXHAUSTED_LABEL),
      ]),
    ).toBe('c');
  });

  it('offers the newest failure only, never both', () => {
    /* Two spent schedules leave two rows and one of them is history; a control
       on the older would describe an attempt that is over. */
    expect(
      activationRetryRowId([
        row('c', ACTIVATION_EXHAUSTED_LABEL),
        row('b', ACTIVATION_REFUSED_LABEL),
      ]),
    ).toBe('c');
  });

  it('is nothing on an empty trail, and on one with no activation in it', () => {
    expect(activationRetryRowId([])).toBeNull();
    expect(activationRetryRowId([row('a', 'Passport created')])).toBeNull();
  });
});

describe('openingBalanceOnTheWay', () => {
  const entry = (label: string) => ({ label });
  /** An account holding neither half of the grant yet. */
  const waiting = { holdsOpeningNight: false, holdsOpeningStablecoin: false };

  it('is on its way from the moment there is an account holding nothing', () => {
    /* Asked for on 2026/09/02: the opening balance should read as pending from
       the moment activation begins, not from whenever the sponsor answers. */
    expect(openingBalanceOnTheWay({ hasAccount: true, ...waiting, entries: [] })).toBe(true);
  });

  it('is nothing without an account for it to land in', () => {
    expect(openingBalanceOnTheWay({ hasAccount: false, ...waiting, entries: [] })).toBe(false);
  });

  it('goes only once BOTH halves of the grant are held', () => {
    /* THE 2026/09/04 STABILITY AUDIT. The grant is two deposits and they do not
       land together: the audit watched the opening NIGHT arrive, the row go on
       the spot, and the screen then show `mUSD 0` beside "Your account is
       ready" for 18.1 seconds. Either half on its own leaves the other still
       coming, and the row names both figures. */
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        holdsOpeningNight: true,
        holdsOpeningStablecoin: false,
        entries: [],
      }),
    ).toBe(true);
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        holdsOpeningNight: false,
        holdsOpeningStablecoin: true,
        entries: [],
      }),
    ).toBe(true);
    /* Both held: the balances above ARE the answer now. */
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        holdsOpeningNight: true,
        holdsOpeningStablecoin: true,
        entries: [],
      }),
    ).toBe(false);
  });

  it('goes when the sponsor refused, and when its ten minutes ran out', () => {
    for (const label of [ACTIVATION_REFUSED_LABEL, ACTIVATION_EXHAUSTED_LABEL]) {
      expect(
        openingBalanceOnTheWay({
          hasAccount: true,
          ...waiting,
          entries: [entry('Passport created'), entry(label)],
        }),
      ).toBe(false);
    }
  });

  it('goes on a refusal even when one half of the grant did land', () => {
    /* The half that arrived does not make the other one still coming: the
       sponsor has said it is not sending it, and the trail carries the retry. */
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        holdsOpeningNight: true,
        holdsOpeningStablecoin: false,
        entries: [entry(ACTIVATION_EXHAUSTED_LABEL)],
      }),
    ).toBe(false);
  });

  it('survives a trail of rows about anything else', () => {
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        ...waiting,
        entries: [entry('Passport created'), entry('Your name is registered')],
      }),
    ).toBe(true);
  });
});

describe('the opening balance copy', () => {
  it('names the sponsor’s two fixed figures', () => {
    /* 2026/09/03: the reviewer wanted the expected figures visible while the
       deposits are pending. They are the sponsor's fixed grant, so this device
       can name them before the sponsor has answered. */
    expect(OPENING_MUSD).toBe(100);
    expect(OPENING_NIGHT).toBe('0.002');
    expect(OPENING_BALANCE_ON_THE_WAY_LABEL).toBe('Opening balance on the way');
    expect(OPENING_BALANCE_ON_THE_WAY_DETAIL).toBe(
      '100 mUSD and 0.002 NIGHT are being added to your account.',
    );
  });

  it('builds the sentence from the constants, so one figure cannot drift', () => {
    expect(OPENING_BALANCE_ON_THE_WAY_DETAIL).toContain(`${OPENING_MUSD} mUSD`);
    expect(OPENING_BALANCE_ON_THE_WAY_DETAIL).toContain(`${OPENING_NIGHT} NIGHT`);
  });

  it('reads as pending, never as a balance that has landed', () => {
    /* Present continuous, both halves: the figures are what is COMING. Nothing
       here may read as a settled deposit, which is the reviewer's standing
       objection and the one this row could most easily break. */
    expect(OPENING_BALANCE_ON_THE_WAY_LABEL).toContain('on the way');
    expect(OPENING_BALANCE_ON_THE_WAY_DETAIL).toContain('are being added');
    for (const copy of [OPENING_BALANCE_ON_THE_WAY_LABEL, OPENING_BALANCE_ON_THE_WAY_DETAIL]) {
      expect(copy).not.toMatch(/deposited|arrived|you (?:now )?have/i);
    }
  });

  it('says nothing about the machinery underneath it', () => {
    /* The row is read by somebody who has never been told this account is a
       contract, has never seen a wallet, and never will. */
    for (const copy of [OPENING_BALANCE_ON_THE_WAY_LABEL, OPENING_BALANCE_ON_THE_WAY_DETAIL]) {
      expect(copy).not.toMatch(/wallet|dust|contract|registry|indexer|resolver/i);
    }
  });

  it('is not one of the labels an activation writes to the trail', () => {
    /* `activationRetryRowId` and `openingBalanceOnTheWay` both match by
       identity, and a pending row mistaken for a landing or a failure would
       either hide the wait or offer a retry for a grant nobody refused. */
    expect(
      activationRetryRowId([{ id: 'p', label: OPENING_BALANCE_ON_THE_WAY_LABEL }]),
    ).toBeNull();
    expect(
      openingBalanceOnTheWay({
        hasAccount: true,
        holdsOpeningNight: false,
        holdsOpeningStablecoin: false,
        entries: [{ label: OPENING_BALANCE_ON_THE_WAY_LABEL }],
      }),
    ).toBe(true);
  });
});
