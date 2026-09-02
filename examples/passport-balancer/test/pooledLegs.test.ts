/**
 * A pooled registration's two legs, and the coin they are not allowed to fight
 * over.
 *
 * THE DEFECT. The pooled branch ran `update_domain_target` and
 * `register_domain_for` concurrently on every request, whatever the wallet
 * held. With one fee-capable DUST coin free that is one job plus one that
 * spends fifteen seconds balancing before it fails — measured at 22 s and 45 s
 * of wasted wait on the deployed service on 2026/09/02 — and, worse, a DUST
 * shortfall on the BIND leg came back as `bind-failed`, a hard refusal, where
 * every other shortfall on this path waits for a coin.
 *
 * Both halves are fixed here rather than by rethrowing the shortfall: the
 * caller's wait rebuilds the WHOLE registration, so rethrowing a bind's
 * shortfall would send it to register a name it already owns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runPooledLegs } from '../src/midnames.js';
import { DustUnavailable } from '../src/wallet.js';

/** midnight-js's re-wrap of our own shortfall, as the journal shows it. */
const rewrapped = (): Error =>
  new Error(
    "Unexpected error submitting scoped transaction '<unnamed>': DustUnavailable: no DUST coin was free to pay this transaction's fee: Insufficient Funds: could not balance dust",
  );

describe('a pooled registration with one lane free', () => {
  it('runs the register leg before the bind leg, never beside it', async () => {
    const order: string[] = [];
    let bindStartedWhileRegistering = false;
    let registering = false;
    const outcome = await runPooledLegs(
      1,
      async () => {
        registering = true;
        order.push('register:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        registering = false;
        order.push('register:done');
        return 'register-tx';
      },
      async () => {
        if (registering) bindStartedWhileRegistering = true;
        order.push('bind:start');
        return 'bind-tx';
      },
    );
    assert.equal(bindStartedWhileRegistering, false);
    assert.deepEqual(order, ['register:start', 'register:done', 'bind:start']);
    assert.deepEqual(outcome, { kind: 'registered', registerTx: 'register-tx' });
  });

  it('does not start the bind leg at all when nothing was registered', async () => {
    let bindRan = false;
    const outcome = await runPooledLegs(
      1,
      () => Promise.reject(new Error('Custom error: 231')),
      async () => {
        bindRan = true;
        return 'bind-tx';
      },
    );
    assert.equal(bindRan, false);
    assert.equal(outcome.kind, 'register-rejected');
  });

  it('passes a register-leg shortfall out, so the caller waits for a coin', async () => {
    await assert.rejects(
      runPooledLegs(
        1,
        () => Promise.reject(new DustUnavailable('Insufficient Funds: could not balance dust')),
        () => Promise.resolve('bind-tx'),
      ),
      DustUnavailable,
    );
  });

  it('keeps a bind-leg shortfall in, because the name is already registered', async () => {
    /* The rethrow this must not do: `withDustWait` would rebuild the whole
       registration, and `register_domain_for` has already landed. */
    const outcome = await runPooledLegs(
      1,
      () => Promise.resolve('register-tx'),
      () => Promise.reject(rewrapped()),
    );
    assert.equal(outcome.kind, 'bind-rejected');
    assert.equal(outcome.kind === 'bind-rejected' && outcome.registerTx, 'register-tx');
  });
});

describe('a pooled registration with two lanes free', () => {
  it('runs both legs together', async () => {
    let bindStarted = false;
    const outcome = await runPooledLegs(
      2,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(bindStarted, true, 'the bind leg should already be running');
        return 'register-tx';
      },
      async () => {
        bindStarted = true;
        return 'bind-tx';
      },
    );
    assert.deepEqual(outcome, { kind: 'registered', registerTx: 'register-tx' });
  });

  it('reports the registration first when both legs fail', async () => {
    const outcome = await runPooledLegs(
      2,
      () => Promise.reject(new Error('Custom error: 231')),
      () => Promise.reject(new Error('bind blew up')),
    );
    assert.equal(outcome.kind, 'register-rejected');
  });

  it('still keeps a bind-leg shortfall in when the registration landed', async () => {
    const outcome = await runPooledLegs(
      2,
      () => Promise.resolve('register-tx'),
      () => Promise.reject(rewrapped()),
    );
    assert.equal(outcome.kind, 'bind-rejected');
  });
});
