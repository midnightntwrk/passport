/**
 * The package's own test configuration, and the written record of which of its
 * modules are held to a coverage bar and which are not.
 *
 * THE DENOMINATOR is an explicit allow-list and the threshold on it is 100% of
 * statements, branches, functions, and lines. A percentage is only worth
 * reading if the thing it is a percentage OF is stated, so every module that
 * is NOT in it is named below with the reason. There are no wildcards standing
 * in for a decision.
 *
 * IN, and why
 * -----------
 *   src/protocol/**        The wire. Every rule in it is a rule about what an
 *                          app is allowed to be told, and every branch is a
 *                          way of telling it something untrue — a reply that
 *                          claims a transaction with no id, a "fee covered"
 *                          badge bought with the string "false", a profile
 *                          carrying a field nobody asked for. Pure functions,
 *                          untrusted values in, decisions out.
 *   src/core/random.ts     The ids every pair binding rests on.
 *   src/core/client.ts     The exchange state machine. It is in the
 *                          denominator because its branches are the ones that
 *                          decide what a user is told when nothing came back:
 *                          a blocked window, a closed window, a budget that
 *                          elapsed, a reply for somebody else's exchange. It
 *                          holds no DOM of its own — the window is injected —
 *                          so all of it is drilled against a fake one.
 *   src/core/transport/**  Same reason, same injection. The origin gate, the
 *                          source gate, the pair matching, and the pop-up
 *                          launch contract are the security model.
 *   src/redirect/**        The signed channel. The verification walk is the
 *                          one place in this package where being wrong means
 *                          accepting a forged reply, so every step of it and
 *                          every way it can fail is drilled, including the
 *                          real curve against real signatures.
 *
 * OUT, and why
 * ------------
 *   src/react/index.tsx    React components and hooks. There is no DOM
 *                          renderer in this package and adding one would only
 *                          let a test assert against a fake tree. The hooks
 *                          are `useState` around the client, and the client is
 *                          at 100% underneath them; the bindings themselves
 *                          are exercised in a real browser by the example apps
 *                          that use them.
 *   src/index.ts,          Barrels. They re-export and hold no decisions. The
 *   src/protocol/index.ts  no-second-copy check in the demo app's suite is
 *                          what stops one drifting.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: [
        'src/protocol/errors.ts',
        'src/protocol/limits.ts',
        'src/protocol/profile.ts',
        'src/protocol/tx.ts',
        'src/protocol/version.ts',
        'src/core/client.ts',
        'src/core/random.ts',
        'src/core/transport/iframe.ts',
        'src/core/transport/popup.ts',
        'src/core/transport/types.ts',
        'src/redirect/crypto.ts',
        'src/redirect/encoding.ts',
        'src/redirect/index.ts',
        'src/redirect/protocol.ts',
        'src/redirect/verify.ts',
      ],
      /* A file in the list with nothing exercising it must show as 0% rather
         than vanish from the report. */
      all: true,
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
