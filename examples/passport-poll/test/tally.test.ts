/* ===========================================================================
 * The three rules, as tests
 * ===========================================================================
 *
 * One vote per account, a vote carries the proof Passport gave it, and the
 * results are what was actually cast. Everything the service promises on
 * screen is promised here first.
 * ========================================================================= */

import { describe, expect, it } from 'vitest';

import { castVote, createPoll, emptyState, results, type TallyState } from '../service/tally.ts';

const PROOF = { exchange: 'req-01HZX' };
const ALICE = 'mn_shield-addr_test1alice';
const BOB = 'mn_shield-addr_test1bob';

function poll(): { state: TallyState; id: string } {
  const state = emptyState();
  const created = createPoll(
    state,
    { question: "What's better: McDonald's or Burger King?", options: ["McDonald's", 'Burger King'] },
    1_000,
    'burgers',
  );
  if (!created.ok) throw new Error(created.reason);
  return { state, id: created.value.id };
}

describe('creating a poll', () => {
  it('takes a question and two to four options', () => {
    const { state, id } = poll();
    expect(id).toBe('burgers');
    expect(state.polls).toHaveLength(1);
    expect(state.polls[0]!.options).toEqual(["McDonald's", 'Burger King']);
  });

  it('refuses fewer than two options', () => {
    const state = emptyState();
    expect(createPoll(state, { question: 'One horse race?', options: ['Only this'] })).toEqual({
      ok: false,
      reason: 'too-few-options',
    });
    expect(state.polls).toHaveLength(0);
  });

  it('refuses more than four', () => {
    const state = emptyState();
    expect(
      createPoll(state, { question: 'Too many', options: ['a', 'b', 'c', 'd', 'e'] }),
    ).toEqual({ ok: false, reason: 'too-many-options' });
  });

  it('refuses two options that are the same', () => {
    const state = emptyState();
    expect(createPoll(state, { question: 'Same', options: ['Chips', 'chips'] })).toEqual({
      ok: false,
      reason: 'duplicate-option',
    });
  });

  it('refuses an empty question', () => {
    const state = emptyState();
    expect(createPoll(state, { question: '   ', options: ['a', 'b'] })).toEqual({
      ok: false,
      reason: 'question-missing',
    });
  });
});

describe('one vote per account', () => {
  it('counts the first vote from an account', () => {
    const { state, id } = poll();
    const cast = castVote(state, { pollId: id, option: "McDonald's", account: ALICE, name: 'alice.night', proof: PROOF });
    expect(cast.ok).toBe(true);
    expect(state.votes).toHaveLength(1);
  });

  it('refuses the second, and does not overwrite the first', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: "McDonald's", account: ALICE, proof: PROOF });
    const again = castVote(state, { pollId: id, option: 'Burger King', account: ALICE, proof: PROOF });
    expect(again).toEqual({ ok: false, reason: 'already-voted' });
    expect(state.votes).toHaveLength(1);
    expect(state.votes[0]!.option).toBe("McDonald's");
  });

  it('lets a different account vote', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: "McDonald's", account: ALICE, proof: PROOF });
    expect(castVote(state, { pollId: id, option: 'Burger King', account: BOB, proof: PROOF }).ok).toBe(true);
    expect(state.votes).toHaveLength(2);
  });

  it('keys on the account, not on the name', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: "McDonald's", account: ALICE, name: 'alice.night', proof: PROOF });
    const impostor = castVote(state, {
      pollId: id,
      option: 'Burger King',
      account: BOB,
      name: 'alice.night',
      proof: PROOF,
    });
    expect(impostor.ok).toBe(true);
    expect(results(state, id)!.total).toBe(2);
  });
});

describe('a vote carries a proof', () => {
  it('refuses a vote with no proof at all', () => {
    const { state, id } = poll();
    expect(castVote(state, { pollId: id, option: "McDonald's", account: ALICE })).toEqual({
      ok: false,
      reason: 'proof-missing',
    });
    expect(state.votes).toHaveLength(0);
  });

  it('refuses a proof with an empty exchange reference', () => {
    const { state, id } = poll();
    expect(
      castVote(state, { pollId: id, option: "McDonald's", account: ALICE, proof: { exchange: '  ' } }),
    ).toEqual({ ok: false, reason: 'proof-missing' });
  });

  it('records a signature when the channel carried one', () => {
    const { state, id } = poll();
    castVote(state, {
      pollId: id,
      option: "McDonald's",
      account: ALICE,
      proof: { exchange: 'req-2', signature: 'ab12', publicKey: 'cd34' },
    });
    expect(state.votes[0]!.proof).toEqual({ exchange: 'req-2', signature: 'ab12', publicKey: 'cd34' });
  });

  it('refuses a vote with no account to count it against', () => {
    const { state, id } = poll();
    expect(castVote(state, { pollId: id, option: "McDonald's", account: '', proof: PROOF })).toEqual({
      ok: false,
      reason: 'account-missing',
    });
  });

  it('refuses an option the poll does not offer', () => {
    const { state, id } = poll();
    expect(castVote(state, { pollId: id, option: 'KFC', account: ALICE, proof: PROOF })).toEqual({
      ok: false,
      reason: 'unknown-option',
    });
  });

  it('refuses a poll that does not exist', () => {
    const { state } = poll();
    expect(castVote(state, { pollId: 'nope', option: "McDonald's", account: ALICE, proof: PROOF })).toEqual({
      ok: false,
      reason: 'unknown-poll',
    });
  });
});

describe('results', () => {
  it('are zero and unshared before anyone votes', () => {
    const { state, id } = poll();
    const tally = results(state, id)!;
    expect(tally.total).toBe(0);
    expect(tally.options.map((option) => option.share)).toEqual([0, 0]);
    expect(tally.receipts).toEqual([]);
  });

  it('count each option and give it a whole-percent share', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: "McDonald's", account: ALICE, name: 'alice.night', proof: PROOF });
    castVote(state, { pollId: id, option: "McDonald's", account: BOB, name: 'bob.night', proof: PROOF });
    castVote(state, { pollId: id, option: 'Burger King', account: 'mn_c', proof: PROOF });
    const tally = results(state, id)!;
    expect(tally.total).toBe(3);
    expect(tally.options[0]).toMatchObject({ option: "McDonald's", count: 2, share: 67 });
    expect(tally.options[1]).toMatchObject({ option: 'Burger King', count: 1, share: 33 });
  });

  it('name the voters who shared a name, and shorten the accounts of those who did not', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: "McDonald's", account: ALICE, name: 'alice.night', proof: PROOF });
    castVote(state, { pollId: id, option: "McDonald's", account: BOB, proof: PROOF });
    const [first] = results(state, id)!.options;
    expect(first!.voters[0]).toBe('alice.night');
    expect(first!.voters[1]).toContain('…');
  });

  it('list one receipt per vote, account and proof together', () => {
    const { state, id } = poll();
    castVote(state, { pollId: id, option: 'Burger King', account: ALICE, name: 'alice.night', proof: PROOF }, 2_000);
    const [receipt] = results(state, id)!.receipts;
    expect(receipt).toEqual({
      account: ALICE,
      name: 'alice.night',
      option: 'Burger King',
      proof: PROOF,
      at: 2_000,
    });
  });

  it('are null for a poll nobody created', () => {
    expect(results(emptyState(), 'ghost')).toBeNull();
  });
});
