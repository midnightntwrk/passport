/**
 * The sponsor's own watchdog: a periodic verdict on whether this wallet is
 * still able to sponsor, and an escalating set of remedies when it is not.
 *
 * WHY THIS IS MOSTLY ABOUT *NOT* ACTING
 * -------------------------------------
 * The balancer holds ONE large NIGHT UTxO. Every fee-bearing submission
 * nullifies the DUST it spends, and the replacement UTxO only appears when that
 * transaction lands — so for 20 to 60 seconds after a sponsorship the wallet
 * genuinely reads `available: 0, utxoCount: 0`. It is also documented (README,
 * and `CHANGE_SETTLE_MS` in `./server.ts`) that a spend puts the wallet through
 * a "syncing" flap of up to about two minutes, because the SDK scores being one
 * event AHEAD of the stream the same as being behind.
 *
 * Both of those are the service working. A watchdog that reopened the wallet or
 * restarted the process on either of them would take a healthy sponsor down
 * every time somebody onboarded — which is a worse outage than the one it was
 * written to fix. So the classifier's first job is to recognise the two states
 * in which doing nothing is correct:
 *
 *   - `busy`     — `isReserved()` or `isBusy()`. Somebody is mid-spend. A
 *                  grant's shielded proof runs about two minutes in-process,
 *                  and a contract call holds a claim on coin state for part of
 *                  it. NOTHING may run here. This is the "locked while in use"
 *                  the service owner asked for.
 *   - `settling` — no DUST, but a sponsorship landed inside the settle window,
 *                  or the process has not been up long enough to have finished
 *                  its first chain walk and DUST registration. Expected;
 *                  self-healing; intervening would be the bug.
 *
 * and only then the two in which it is not:
 *
 *   - `degraded` — the wallet can still be read, but it is not doing its job:
 *                  unsynced with nothing in flight, an indexer subscription
 *                  dropped ("RPC-CORE: disconnected … Normal Closure"), the
 *                  prover's key material never loaded, or `available: 0` long
 *                  after anything could still be settling.
 *   - `wedged`   — the wallet facade will not answer at all: `currentState()`
 *                  threw or timed out on consecutive ticks. Nothing in this
 *                  process can talk to the wallet, so nothing in this process
 *                  can repair it; the only remedy left is a restart.
 *
 * A NOTE ON THE FIFTH FAILURE, WHICH IS NOT IN HERE
 * ------------------------------------------------
 * A process that is alive but no longer answering HTTP cannot be detected from
 * inside itself — the loop that would notice is in the same event loop that is
 * not running. That case belongs to the external leg,
 * `passport-balancer-watchdog.timer` on the droplet, which curls
 * `/wallet-status` from outside and restarts the unit. The verdict named
 * `wedged` here is the narrower thing this process CAN see: a facade that has
 * stopped answering while the HTTP server still does.
 *
 * THE SIXTH FAILURE, AND THE TWO WRONG SIGNALS IT WAS CHASED WITH
 * ---------------------------------------------------------------
 * Every fact above is read from the wallet, and there is one question a wallet
 * cannot answer about itself: is the connection I submit on still there? None
 * of it moves when that connection dies — the wallet reads its state from the
 * INDEXER — which is how five hours of every-submission-fails read as `healthy`
 * on 2026/09/05.
 *
 * THE FIRST WRONG SIGNAL was the wallet's own sync indices, waited on for half
 * an hour. It was slow — the socket died at about 14:48 and the first word came
 * at 15:28 — but that patience was at least deliberate: a wallet watching only
 * itself cannot tell a quiet chain from a lost one.
 *
 * THE SECOND WRONG SIGNAL, added on 2026/09/06, kept the indices and gave them
 * a second opinion: the public node's head over HTTPS, with forty blocks
 * produced while the indices stood still called a cut-off wallet in five
 * minutes instead of thirty. It fired on a healthy idle sponsor every single
 * tick — 614 `degraded` lines in a day — because a wallet's indices are not a
 * liveness signal at all: `highestTransactionId` and the shielded and DUST
 * merkle indices only move on ledger activity THAT CONCERNS THIS WALLET, so a
 * quiet stagenet leaves them still for hours while everything is well.
 *
 * WHAT IS ACTUALLY WATCHED NOW is the connection itself. `./submission.ts`
 * holds one `chain_subscribeNewHeads` on the very `ApiPromise` this service
 * submits on, re-established on every rebuild, and records the height and
 * instant of each header. A header arriving over that connection is proof the
 * connection is alive; a header not arriving while the chain demonstrably
 * climbs is proof that it is not. Unlike the indices, a header is produced
 * whether or not anything in the block concerns this wallet, so silence has no
 * quiet-chain explanation to protect — which is what buys five minutes.
 *
 * AND THE REFERENCE IS TWO OBSERVERS, NOT ONE, because of the second finding of
 * 2026/09/06: when the node's addresses were black-holed the HTTPS head probe
 * went blind at the same instant the socket did, and `/status` said connected
 * and synced for seven and a half minutes while nothing could get through. A
 * reference that shares a host with the thing it checks is not a reference. So
 * `referenceHead` is `max(node HTTPS head, indexer head)` — a different host
 * answering a different protocol — and either alone is enough. Both
 * unavailable is no observation, which falls back to the old thirty-minute
 * indices rule and concludes nothing.
 *
 * The indices rule is kept exactly as it was, for exactly the reason it is
 * worth keeping: it is looking at something else.
 *
 * WHAT THE REMEDIES ACTUALLY CALL, AND WHAT THE SDK WILL NOT LET US DO
 * -------------------------------------------------------------------
 * Three rungs, cheapest first, each rate-limited:
 *
 *   1. `refresh`  — `wallet.currentState()` and `wallet.progress()`. A fresh
 *                   read off the facade's state observable (which carries a
 *                   30-second timeout of its own). It fixes nothing by itself;
 *                   it is how a transient is distinguished from a fault, and it
 *                   costs nothing — except that it now also rebuilds the
 *                   submission socket when that socket is not answering, which
 *                   is the one thing this rung was missing on 2026/09/05.
 *   1b. `reconnect` — `wallet.reconnectNode()`. A fresh `WsProvider` and a
 *                   fresh `ApiPromise` for SUBMISSIONS, the old pair
 *                   disconnected and discarded. Off the ladder rather than on
 *                   it: a socket that has failed N submissions in a row takes
 *                   this rung on the first tick, because no amount of patience
 *                   repairs a transport and every second of it is somebody's
 *                   registration failing.
 *   2. `rewarm`   — `wallet.warmProvingKeys()` and `wallet.saveSnapshot()`.
 *                   The first is a real repair, not a probe: `warmProvingKeys`
 *                   re-attempts the fetch whenever readiness is `warming` or
 *                   `failed` (it short-circuits only on `ready` and `server`),
 *                   so a start-up in which the 31 MiB of circuit key material
 *                   could not be fetched — which pins `/balance-only` on
 *                   `PROVER_UNAVAILABLE` for the life of the process — heals
 *                   here. The second checkpoints the sync state so that if the
 *                   next rung fires, the restarted process resumes near the tip
 *                   instead of walking the chain from genesis.
 *   3. `restart`  — checkpoint, then `process.exit(1)`; `Restart=always` on the
 *                   unit brings it back and `openBalancerWallet` re-establishes
 *                   the indexer subscriptions from the snapshot.
 *
 * There is deliberately NO "reopen the wallet in place" rung, and that is a
 * finding rather than an omission. `WalletFacade` does expose `start()` and
 * `stop()`, and the seed never leaves this process, so `stop()` then `start()`
 * looks like exactly the in-place reconnection this wants. It is not one:
 * `stop()` closes the submission service's Effect scope
 * (`submissionService.close()` → `Scope.close`) and `start()` does NOT reopen
 * it — it starts only the shielded, unshielded, and dust wallets and the
 * pending-transactions service. A facade restarted that way would sync happily
 * and then fail to submit anything, which is a worse fault than the one being
 * repaired and a silent one. So the escalation goes straight from `rewarm` to a
 * process restart, which is the only reopen the SDK actually supports.
 *
 * THE RESTART GATES, ALL OF WHICH MUST HOLD
 * -----------------------------------------
 *   - `isReserved()` and `isBusy()` are both false. A restart mid-spend would
 *     abandon a proof somebody is waiting on, and — worse — could drop a
 *     transaction between its balancing and its submission.
 *   - The cause is one a restart can plausibly fix (`restartEligible`). A
 *     prover whose key material will not download is not fixed by restarting
 *     into the same download, and a wallet whose sync indices have merely gone
 *     quiet is too soft a signal to bounce a live sponsor on.
 *   - At most once in any 30 minutes, and the clock is PERSISTED to the state
 *     directory. An in-memory limit would reset on the very event it is meant
 *     to bound, which is how restart loops are written by accident.
 *   - Never twice without an intervening healthy tick, likewise persisted.
 */

import type { NodeSocketState, SocketHead } from './submission.js';
import type { ProvingState } from './availability.js';
import type { ChainHeadProbe, ChainHeadReading } from './chainHead.js';

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

export type HealthVerdict =
  | 'healthy'
  | 'busy'
  | 'settling'
  | 'degraded'
  | 'dust-wedged'
  | 'wedged';

/**
 * Everything the verdict is allowed to look at — the same facts `walletStatus()`
 * already gathers, plus the loop's own bookkeeping. No I/O, no clock, no
 * wallet: `now` is passed in so a test can place a two-minute proof or a
 * forty-second settle wherever it likes.
 */
export interface HealthFacts {
  now: number;
  /** Milliseconds this process has been up, for the start-up grace. */
  uptimeMs: number;
  /**
   * False when the wallet could not be read at all — `currentState()` threw or
   * hit its 30-second timeout. This is the fact that separates "the wallet is
   * in a bad state" from "there is no longer a wallet answering".
   */
  stateReadable: boolean;
  /** `progress.isSynced` — the SDK's own strict verdict, not a guess. */
  synced: boolean;
  /**
   * Every one of the three sub-wallets reports its indexer subscription
   * connected. A synced wallet whose subscriptions have dropped is the
   * "RPC-CORE: disconnected … Normal Closure" failure, and it is invisible in
   * the balance alone.
   */
  connected: boolean;
  /** Spendable DUST, in Specks. Zero is the interesting value. */
  dustSpecks: bigint;
  /** How many DUST UTxOs back that balance. Zero and zero travel together. */
  utxoCount: number;
  /**
   * Unshielded NIGHT this wallet holds, in atomic units.
   *
   * The fact that turns "no DUST" from a funding problem into a bookkeeping
   * one. DUST is generated by NIGHT and by nothing else, so a wallet holding
   * thousands of NIGHT and reporting no spendable DUST is not out of money —
   * its coins are being withheld from it. A wallet holding no NIGHT that
   * reports no DUST is simply empty, and there is nothing here to repair.
   */
  nightAtomic: bigint;
  /**
   * Every NIGHT UTxO this wallet holds is registered for DUST generation.
   *
   * The fact that lets a wedge be recognised INSIDE the start-up grace, which
   * is precisely when it must be: the snapshot carries the pending flags across
   * a restart, so the first fifteen minutes of a restarted process is exactly
   * where an inherited wedge lives. Without this the grace hides it — observed
   * live at 17:21:01 on 2026/09/02, where a revert reported the wedge and the
   * verdict came back 'still starting up (271 s in)'.
   *
   * A cold start whose NIGHT is not yet registered genuinely has no DUST and
   * genuinely must wait, so it keeps the grace. A wallet whose NIGHT IS
   * registered generates continuously, so reaching zero spendable coins can
   * only be a spend — and if nothing is pending, that spend's coins are being
   * withheld.
   */
  dustGenerating: boolean;
  /**
   * Transactions the wallet itself has booked as pending and not yet seen
   * resolved — its OWN submissions, as distinct from {@link orphans}, which are
   * transactions it balanced for somebody else.
   *
   * A DUST balance of zero with one of these outstanding is correct: the coin
   * that paid for it is legitimately nullified until the transaction lands. The
   * same reading with nothing pending is the ledger holding coins nobody is
   * spending, which is the wedge. See `wallet.ts`'s `isDustWedged`.
   */
  pendingTransactions: number;
  proving: ProvingState;
  /** A CLAIM on the wallet's coin state — seconds. See `./reservation.ts`. */
  reserved: boolean;
  /** A whole spend job on the queue, proving included — minutes. */
  busy: boolean;
  /**
   * The legs this wallet has applied PAST the indexer's last progress figure,
   * named — `unshielded applied 9549 > highest 9521` — or `null` when none is.
   *
   * This is the post-spend state the SDK scores as unsynced and this service
   * scores as settled: see `isEffectivelySynced` in `./wallet.ts` for what the
   * SDK's `Math.abs` lag actually measures. It is carried here because it is
   * the REASON, and until 2026/09/02 the verdict for those two to four and a
   * half minutes was `busy: a spend job holds the queue — proving, most
   * likely`, which was a guess and was wrong: nothing was proving, the wallet
   * was catching up with a submission of its own.
   */
  syncAhead: string | null;
  /**
   * When this service last successfully sponsored anything — a balanced fee
   * leg, a registered name, a funded account. `null` when it has not sponsored
   * since it started, which is normal on a quiet morning and is why its absence
   * is never on its own a fault.
   */
  lastSponsorshipAt: number | null;
  /**
   * Transactions this service has balanced and handed to a caller, which the
   * chain has not yet been seen carrying.
   *
   * Each one holds a DUST coin booked as spent, so a wallet reading zero DUST
   * with one outstanding is doing exactly what it should be doing — and, unlike
   * the settle window, this fact ENDS when the sweeper in `./wallet.ts` rules
   * on the transaction rather than when a clock runs out. A wallet whose orphan
   * has already been released is a wallet with its DUST back, which is what
   * makes the verdict `healthy` again without waiting out the window.
   */
  orphans: number;
  /**
   * When the wallet's observed facts last changed — the sync indices, the
   * connection flags, the UTxO count. NOT the DUST balance, which is computed
   * against the current time and therefore moves even on a dead wallet.
   */
  lastStateChangeAt: number;
  /**
   * The submission socket, as `./submission.ts` reports it.
   *
   * THE FACT THIS VERDICT DID NOT HAVE ON 2026/09/05. From 15:30:27 to 20:12
   * UTC every submission this service made failed instantly on a dead
   * websocket — 520 of them — and not one fact above moves when that happens.
   * The wallet reads its state from the INDEXER, which was fine; the socket
   * that carries transactions to the NODE is a different connection entirely,
   * and nothing in this classifier could see it. So the verdict was `healthy`
   * or, once the indices went quiet, `degraded: … indices have not moved`, with
   * a `refresh` remedy that re-read the wallet and left the socket dead.
   */
  nodeSocket: NodeSocketState;
  /** Submissions that have failed on the socket since the last one that did not. */
  consecutiveSocketFailures: number;
  /**
   * Rebuilds of that socket that have failed since the last one that did not.
   *
   * The escalation signal. A rebuild is a fresh `WsProvider` and a fresh
   * `ApiPromise`, so several failing in a row means the fault is not the
   * provider's state — it is this process's, and the operator's remedy of
   * 2026/09/05 (restart the unit) is the one that is left.
   */
  consecutiveRebuildFailures: number;
  /** Unhealthy ticks BEFORE this one, so the first bad tick sees zero. */
  consecutiveUnhealthy: number;
  /**
   * The chain as read THROUGH THE SUBMISSION SOCKET — one
   * `chain_subscribeNewHeads` on the very `ApiPromise` this service submits
   * on, re-established on every rebuild. See `SocketHead` in `./submission.ts`.
   *
   * This is the signal the wallet's sync indices were standing in for and
   * should never have been. A head arriving over this subscription is proof
   * that THIS connection is alive; a head not arriving while an independent
   * reference climbs is proof that it is not. Both are block heights of the
   * same chain, so the difference between them is a number.
   */
  socketHead: SocketHead;
  /**
   * The chain as somebody who is NOT this socket sees it — and `undefined` when
   * nobody does.
   *
   * See {@link ChainHeadFacts}. Absent means exactly one thing: no independent
   * observation is available this tick, so the classifier falls back to the old
   * thirty-minute patience on the wallet's indices. It never means the chain
   * has stopped.
   */
  chainHead?: ChainHeadFacts;
}

/**
 * THE REFERENCE HEAD: how far the chain has got, according to somebody who is
 * not the connection under test.
 *
 * WHY IT IS TWO OBSERVERS AND NOT ONE. Until 2026/09/06 this was the public
 * node's head over one HTTPS `chain_getHeader`, which is independent of the
 * SOCKET but not of the NODE. On 2026/09/06 the node's addresses were
 * black-holed, and the HTTPS probe went blind at the same instant the socket
 * did — so the probe reported nothing, the fast rule turned itself off for want
 * of a second opinion, and `/status` said connected and synced for seven and a
 * half minutes while not one transaction could get through. A reference that
 * shares a host with the thing it is meant to check is not a reference.
 *
 * So the reference is `max(nodeHeight, indexerHeight)`, and the indexer is a
 * different host answering a different protocol. Either one alone is enough,
 * `max` because whichever is further along is the better lower bound on the
 * true head, and both being unavailable is `undefined` — no observation, which
 * falls back to the wallet's own thirty-minute rule rather than concluding
 * anything.
 *
 * Every duration here is bookkeeping the LOOP owns, because "for five minutes"
 * cannot be read off a single tick. `assessHealth` stays pure: it is handed how
 * long a condition has held and decides, and a test can place a five-minute
 * stall exactly where it likes.
 */
export interface ChainHeadFacts {
  /**
   * The node's own HTTPS head, or `null` when it will not answer or its last
   * answer has gone stale. Published; never on its own the reference.
   */
  nodeHeight: number | null;
  /** The indexer's latest block height, or `null` when it would not answer. */
  indexerHeight: number | null;
  /** `max` of the two above. This is what everything below is measured against. */
  referenceHead: number;
  /** How old the freshest of the two readings is. */
  ageMs: number;
  /** Node head probes that have failed since the last one that did not. */
  probeFailures: number;
  /**
   * `referenceHead` minus the socket's own head, or `null` when the socket has
   * delivered no header to compare against.
   *
   * Never negative: a socket ahead of the reference is a socket doing its job
   * with an indexer a block behind it, which is the normal reading.
   */
  socketLagBlocks: number | null;
  /**
   * How long {@link socketLagBlocks} has been CONTINUOUSLY at or over
   * `socketLagBlocks` in the policy. Zero the moment it is not.
   */
  socketLaggingForMs: number;
  /**
   * How long since the socket last delivered a header — or, on a connection
   * that has delivered none, since the watch on it began.
   *
   * The second half of the rule, and it catches what the lag cannot: a
   * subscription that has delivered nothing at all has no height to be behind
   * with.
   */
  socketSilentForMs: number;
  /** Blocks the reference head has climbed during that silence. */
  advancedWhileSocketSilent: number;
  /**
   * `referenceHead` minus the indexer's height, or `null` when the indexer did
   * not answer. Zero when the indexer IS the reference.
   */
  indexerBehindHeadBlocks: number | null;
  /**
   * How long {@link indexerBehindHeadBlocks} has been continuously at or over
   * `indexerBehindBlocks` in the policy.
   */
  indexerBehindForMs: number;
}

export interface HealthAssessment {
  verdict: HealthVerdict;
  /** One line, logged verbatim and published on `/status`. */
  reason: string;
  /** Only `degraded` and `wedged` act. */
  act: boolean;
  /**
   * Whether a process restart is a plausible repair for THIS cause. False for
   * causes a restart would either not fix (key material that will not download)
   * or should not be risked on (a soft staleness signal).
   */
  restartEligible: boolean;
  /**
   * This verdict is about the SUBMISSION SOCKET, not the wallet.
   *
   * Carried rather than re-derived because the remedy is a different one —
   * `reconnect`, and then a restart on the rebuild count rather than on the
   * unhealthy streak — and a `chooseRemedy` that had to guess which `degraded`
   * it was looking at would be guessing from a sentence.
   */
  socketFault?: true;
}

export interface HealthPolicy {
  /**
   * How long after start-up an unsynced or DUST-less wallet is still merely
   * starting. A cold start walks the chain and then waits for the DUST
   * registration to cover its own fee out of projected generation, which is
   * minutes on a fresh wallet; treating that as a fault would restart the
   * service into the same wait forever.
   */
  startupGraceMs: number;
  /**
   * How long after a sponsorship a DUST-less, possibly unsynced wallet is
   * merely settling. The observed window is 20–60 seconds for the DUST
   * replacement and up to about two minutes for the post-spend syncing flap;
   * this is `CHANGE_SETTLE_MS`, the figure the service already refuses to
   * disbelieve a shortfall inside.
   */
  settleWindowMs: number;
  /**
   * How long the wallet's sync indices may stand still before it is reported as
   * stale. Soft, and never on its own a reason to restart.
   *
   * HALF AN HOUR, AND IT STAYS HALF AN HOUR. On 2026/09/06 this figure was
   * shortened to five minutes wherever the public head was seen to be climbing,
   * on the reasoning that blocks produced while the wallet learned nothing
   * cannot be a quiet chain. That reasoning was wrong about what the indices
   * measure: a wallet's unshielded `highestTransactionId` and its shielded and
   * DUST merkle indices only move on ledger activity THAT CONCERNS IT, so on a
   * quiet stagenet a perfectly well sponsor stands still for hours. The rule
   * fired on every tick of an idle, healthy sponsor — 614 `degraded` lines in a
   * day, each with a remedy, none of them a fault.
   *
   * The signal that rule wanted is now taken directly, from the socket's own
   * head subscription rather than from the wallet's indices — see
   * {@link socketStallMs}. This is what remains: the old, patient rule on the
   * old, indirect signal, which is worth keeping precisely because it is
   * looking at something else.
   */
  stallMs: number;
  /**
   * How long the SUBMISSION SOCKET may lag the reference head, or stay silent,
   * before this service concludes the connection is gone — five minutes.
   *
   * Five rather than thirty because this signal has no quiet-chain
   * explanation to protect. The wallet's indices stand still on an idle chain;
   * a head subscription does not, because a head is produced whether or not
   * anything on it concerns this wallet. Silence here is silence about blocks
   * that demonstrably exist.
   */
  socketStallMs: number;
  /**
   * Blocks the reference head must be ahead of the socket, or must climb during
   * the socket's silence, before that counts.
   *
   * Stagenet produces a block about every six seconds, so five minutes is
   * roughly fifty. Forty is deliberately under that: a probe that missed a
   * tick, or an indexer a few blocks behind, must not be able to trip this on
   * its own — it should only ever be the case that the reference is CLEARLY
   * moving and the socket clearly is not.
   */
  socketLagBlocks: number;
  /**
   * How stale the reference reading may be and still be a reference.
   *
   * The node's HTTPS reading is sticky across failed probes — see
   * `ChainHeadReading.height` in `./chainHead.ts` — so without this an old
   * height and a running clock would eventually read as a chain that had
   * stopped, which is a conclusion no probe here is entitled to. Past this age
   * there is no reference, and the socket rule turns itself off.
   */
  chainHeadMaxAgeMs: number;
  /**
   * How far the indexer may fall behind the reference head before `/status`
   * says so — a hundred blocks, about ten minutes of stagenet.
   *
   * ALERT-ONLY AND IT HAS NO REMEDY, which is the point of it. An indexer that
   * has fallen behind is somebody else's server having a bad afternoon: this
   * service cannot repair it, restarting into it repairs nothing, and failing
   * over is a decision for the endpoint list rather than for the health ladder.
   * What it CAN do is stop an operator diagnosing a sponsor that reads stale
   * because the indexer it reads through is stale.
   */
  indexerBehindBlocks: number;
  /** How long the indexer must be that far behind before it is reported. */
  indexerBehindMs: number;
  /**
   * Consecutive head-probe failures before `/status` publishes the probe as
   * `failing`.
   *
   * A REPORT AND NOT A VERDICT. Nothing acts on it: a public node that will not
   * answer this service's HTTPS requests is a fault somewhere, but it is not
   * evidence about this wallet, and the only correct response to losing the
   * second opinion is to go back to the first one. It is published because an
   * operator reading a thirty-minute diagnosis is entitled to know that the
   * five-minute one was unavailable.
   */
  chainHeadProbeFailuresForFailing: number;
  /** Consecutive unreadable ticks before the facade is called wedged. */
  wedgeTicks: number;
  /**
   * `BALANCER_BALANCE_ORPHAN_MS` — how long a transaction this service balanced
   * may go unseen on chain before the sweeper rules on it.
   *
   * Used here as the floor under {@link HealthVerdict} `dust-wedged`: past it,
   * every legitimate reason for a DUST coin to be booked has ended, because the
   * sweeper has either seen the transaction land or taken the coin back.
   */
  orphanMs: number;
  /**
   * Consecutive submission failures on the socket before the verdict is
   * `degraded` — N.
   *
   * Three, and not one: a single failure is what a node restart or a momentary
   * drop looks like, and the connection retries that one itself on a fresh
   * socket. Three in a row is a socket that is not coming back, and on
   * 2026/09/05 the count reached three within four minutes of the first
   * failure and then ran to 520.
   */
  socketFailuresForDegraded: number;
  /**
   * Consecutive REBUILD failures before the verdict escalates to a restart — M.
   *
   * Each rebuild is already a fresh `WsProvider` and a fresh `ApiPromise`, so
   * three of those failing means the fault is not in the connection that was
   * thrown away.
   */
  rebuildFailuresForRestart: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  startupGraceMs: 900_000,
  settleWindowMs: 300_000,
  stallMs: 1_800_000,
  socketStallMs: 300_000,
  socketLagBlocks: 40,
  chainHeadMaxAgeMs: 120_000,
  indexerBehindBlocks: 100,
  indexerBehindMs: 300_000,
  chainHeadProbeFailuresForFailing: 10,
  wedgeTicks: 2,
  orphanMs: 120_000,
  socketFailuresForDegraded: 3,
  rebuildFailuresForRestart: 3,
};

const seconds = (ms: number): string => `${Math.round(ms / 1_000)} s`;
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/**
 * The whole classifier. Pure: same facts in, same verdict out, no clock and no
 * chain, which is what lets `test/health.test.ts` place a forty-second settle
 * and a two-minute proof exactly where it wants them.
 *
 * The order of the branches IS the policy, and it is the safe order: the two
 * "do nothing" verdicts are decided before any of the "act" ones, so no
 * combination of facts can reach a remedy while a spend is in flight or while
 * the DUST is merely on its way back.
 */
export function assessHealth(
  facts: HealthFacts,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): HealthAssessment {
  const noDust = facts.dustSpecks <= 0n || facts.utxoCount <= 0;

  /* 1. In use. Decided first and unconditionally: whatever else is true, a
        wallet somebody is spending from is not a wallet to repair. */
  if (facts.reserved) {
    return {
      verdict: 'busy',
      reason: 'a claim on this wallet’s coin state is outstanding — balancing, signing, or submitting',
      act: false,
      restartEligible: false,
    };
  }
  /* Before the queue branch, because the queue branch has no way to tell a
     proof from a wallet catching up and used to guess — wrongly, for the whole
     of the post-spend window. When a leg is ahead of the indexer's last
     progress figure, THAT is what is happening, whether or not a job is also on
     the queue, and it is named rather than inferred. Both verdicts act on
     nothing, so nothing is risked by preferring the true one. */
  if (facts.syncAhead !== null) {
    return {
      verdict: 'settling',
      reason: `this wallet has applied its own submission ahead of the indexer’s last progress report (${facts.syncAhead})${
        facts.busy ? ', with a spend job still on the queue' : ''
      } — it is catching up with a spend of its own, not proving`,
      act: false,
      restartEligible: false,
    };
  }
  if (facts.busy) {
    return {
      verdict: 'busy',
      reason: 'a spend job holds the queue — proving, most likely, which is minutes for a shielded leg',
      act: false,
      restartEligible: false,
    };
  }

  /* 2. Not answering at all. Ahead of the start-up grace, because a facade that
        cannot be read is not a facade that is still catching up — a syncing
        wallet answers `currentState()` perfectly well and simply reports
        `isSynced: false`. */
  if (!facts.stateReadable) {
    const ticks = facts.consecutiveUnhealthy + 1;
    if (ticks >= policy.wedgeTicks) {
      return {
        verdict: 'wedged',
        reason: `the wallet facade has not answered for ${ticks} consecutive checks — nothing in this process can reach it`,
        act: true,
        restartEligible: true,
      };
    }
    return {
      verdict: 'degraded',
      reason: 'the wallet state could not be read this tick',
      act: true,
      restartEligible: true,
    };
  }

  /* 3. THE SUBMISSION SOCKET, which is not the wallet and is not the indexer.

        Decided here — after the two "in use" branches and the unreadable one,
        and BEFORE everything that reasons about DUST, the start-up grace, and
        the staleness of the sync indices — because every one of those branches
        can return a verdict on a service that cannot submit a transaction, and
        on 2026/09/05 several of them did. `healthy: synced, connected, 2 DUST
        UTxO(s), able to prove` was true of the wallet, and false of the
        sponsor, for four and a half hours.

        A sponsor that cannot submit is not sponsoring, whatever else is well.
        There is no innocent explanation to rule out here: these are failures on
        this service's own socket, counted by the module that owns it, cleared
        by the first submission that goes out. */
  if (facts.consecutiveSocketFailures >= policy.socketFailuresForDegraded) {
    const dead = facts.consecutiveRebuildFailures >= policy.rebuildFailuresForRestart;
    return {
      verdict: 'degraded',
      reason: dead
        ? `the submission socket has failed ${facts.consecutiveSocketFailures} submission(s) in a row and ${facts.consecutiveRebuildFailures} rebuilds of it have failed too — nothing this service submits is reaching the node`
        : `the submission socket has failed ${facts.consecutiveSocketFailures} submission(s) in a row (${facts.nodeSocket}) — every registration, grant, and mint is failing while the wallet still reads well`,
      act: true,
      /* Only once the rebuild itself has been shown not to work. A restart
         while a fresh connection would do is a chain walk bought for nothing —
         and the rebuild is seconds. */
      restartEligible: dead,
      socketFault: true,
    };
  }

  /* 4. THE WEDGE, and the one DUST reading that is neither settling nor a
        funding problem.

        Everything in the conjunction is here to rule an innocent explanation
         out, and between them they rule out all of them:

           - `noDust` with `nightAtomic > 0` and `dustGenerating`: the wallet
             is not empty AND its NIGHT is registered, so it is generating DUST
             that it is not reporting. A cold start whose NIGHT is not yet
             registered has no DUST for an honest reason and keeps the grace
             below — which is why this may safely precede it, and it MUST
             precede it: the snapshot carries the pending flags across a
             restart, so a restarted process's first fifteen minutes is exactly
             where an inherited wedge lives.
           - `synced`: it is not merely behind the chain.
           - `pendingTransactions === 0`: no submission of its own is holding a
             coin — that reading is correct and ends by itself.
           - `orphans === 0`: nothing it balanced for somebody else is
             outstanding either, so the sweeper has no claim on a coin.
           - past `orphanMs` since the last sponsorship: the settle this would
             otherwise be has had longer than the sweeper's own window.

         What is left is the ledger holding coins behind a `pending_until` that
         no revert will now clear — see `./dustRollback.ts` for the mechanism.
        It is decided BEFORE the start-up grace and the settling branches
        because it is provable rather than inferred, and it earns a remedy of
        its own rather than the `degraded` ladder, whose rungs cannot reach it:
        a refresh re-reads the same hidden coins, a re-warm touches the prover,
        and a restart resumes from a snapshot that carries the flags forward. */
  if (
    noDust &&
    facts.synced &&
    facts.nightAtomic > 0n &&
    facts.dustGenerating &&
    facts.pendingTransactions === 0 &&
    facts.orphans === 0 &&
    (facts.lastSponsorshipAt === null || facts.now - facts.lastSponsorshipAt > policy.orphanMs)
  ) {
    return {
      verdict: 'dust-wedged',
      reason: `holding ${facts.nightAtomic} atomic NIGHT with no spendable DUST, nothing pending and nothing outstanding — the ledger is withholding coins this wallet still owns`,
      act: true,
      /* Not restart-eligible, and that is the finding: a restart resumes from
         the snapshot, and the snapshot serialises the very `pending_until`
         flags that are the fault. The repair has to rewrite the snapshot (or
         cold-start the DUST wallet) before the process comes back. */
      restartEligible: false,
    };
  }

  /* 5. Still starting. A cold start walks the chain and then waits for the DUST
        registration to be affordable; both are minutes and neither is a fault. */
  if (facts.uptimeMs < policy.startupGraceMs && (!facts.synced || noDust)) {
    return {
      verdict: 'settling',
      reason: `still starting up (${seconds(facts.uptimeMs)} in): ${facts.synced ? 'synced, DUST not yet accrued' : 'walking the chain'}`,
      act: false,
      restartEligible: false,
    };
  }

  /* 6. The DUST case, and the reason this whole module leans towards inaction.
        Deliberately NOT gated on `synced`: a spend puts the wallet through a
        syncing flap of up to about two minutes as well as nullifying its DUST,
        and both halves of that are the same expected event. */
  if (noDust && facts.orphans > 0) {
    /* Not a clock at all. The DUST is booked against transactions somebody else
       was handed and has not been seen submitting; the sweeper asks the chain
       about each one and either drops it or gives the coin back. Restarting
       into that would lose the sync position and repair nothing, and the wait
       ends when the sweeper rules — which is sooner than the window below. */
    return {
      verdict: 'settling',
      reason: `${facts.orphans} balanced transaction(s) still outstanding — their DUST is booked until the chain shows them or the sweeper takes it back`,
      act: false,
      restartEligible: false,
    };
  }
  if (noDust && facts.lastSponsorshipAt !== null) {
    const since = facts.now - facts.lastSponsorshipAt;
    if (since < policy.settleWindowMs) {
      return {
        verdict: 'settling',
        reason: `sponsored ${seconds(since)} ago — the DUST it spent is nullified until that transaction lands, and the replacement comes with it`,
        act: false,
        restartEligible: false,
      };
    }
  }

  /* 7. Genuinely degraded, in the order the causes are worth reporting. */
  if (!facts.synced) {
    return {
      verdict: 'degraded',
      reason: `not synced, with nothing in flight and ${seconds(facts.uptimeMs)} of uptime`,
      act: true,
      restartEligible: true,
    };
  }
  if (!facts.connected) {
    return {
      verdict: 'degraded',
      reason: 'an indexer subscription has dropped — synced, but no longer following the chain',
      act: true,
      restartEligible: true,
    };
  }
  if (facts.proving === 'failed') {
    return {
      verdict: 'degraded',
      /* Not restart-eligible: the fix is to fetch the key material again, which
         `warmProvingKeys()` does in place. Restarting would re-attempt the same
         download from a cold cache and lose the sync position for nothing. */
      reason: 'the proving key material could not be loaded, so /balance-only refuses with PROVER_UNAVAILABLE',
      act: true,
      restartEligible: false,
    };
  }
  if (facts.proving === 'warming') {
    return {
      verdict: 'degraded',
      reason: `the prover has been warming for ${minutes(facts.uptimeMs)} — past the point where that is a cold start`,
      act: true,
      restartEligible: false,
    };
  }
  if (noDust) {
    return {
      verdict: 'degraded',
      reason: facts.lastSponsorshipAt === null
        ? 'no spendable DUST, and this service has sponsored nothing to explain it'
        : `no spendable DUST ${minutes(facts.now - facts.lastSponsorshipAt)} after the last sponsorship — too long to be change still settling`,
      act: true,
      restartEligible: true,
    };
  }
  /* 7b. THE SUBMISSION SOCKET, JUDGED AGAINST A CHAIN IT DOES NOT CARRY.

         WHAT THIS BRANCH REPLACES, AND WHY. Until 2026/09/06 it compared the
         public node's head against the WALLET'S SYNC INDICES, and called five
         minutes of head-climbing-while-indices-still a cut-off wallet. On a
         live drill that fired on a healthy idle sponsor every single tick —
         614 `degraded` lines in a day — because a wallet's indices are not a
         liveness signal at all: `highestTransactionId` and the shielded and
         DUST merkle indices only move on ledger activity THAT CONCERNS THIS
         WALLET, so a quiet stagenet leaves them standing still for hours while
         every stream is connected and every figure is correct. Wallet stillness
         never was evidence of a dead socket; on 2026/09/05 the two merely
         coincided.

         The signal that rule wanted, taken directly: one
         `chain_subscribeNewHeads` on the very `ApiPromise` this service submits
         on, re-established on every rebuild, recording the height and the
         instant of each header. A head arriving over THAT connection is proof
         the connection is alive, and — unlike the wallet's indices — a header
         is produced whether or not anything in the block concerns this wallet,
         so silence here has no quiet-chain explanation to protect. That is what
         buys five minutes instead of thirty.

         AND THE REFERENCE IS NOT THE NODE. The second live finding of
         2026/09/06: when the node's addresses were black-holed the HTTPS head
         probe went blind at the same instant the socket did, so the comparison
         had nothing left to compare against and `/status` said connected and
         synced for seven and a half minutes while nothing could get through. A
         reference that shares a host with the thing it checks is not a
         reference. So `referenceHead` is `max(node, indexer)` — see
         {@link ChainHeadFacts} — and the indexer is a different host answering
         a different protocol. The black-hole case is the indexer climbing
         alone, which is exactly what that catches.

         TWO WAYS IN, and the second is not redundant:

           - THE LAG. The reference is `socketLagBlocks` ahead of the socket's
             own head and has been for `socketStallMs`. This is the socket
             frozen at a height.
           - THE SILENCE. No header for `socketStallMs` while the reference
             climbed `socketLagBlocks`. A subscription that has delivered
             NOTHING — a fresh connection whose stream never opened — has no
             height to be behind with, so the lag limb cannot see it.

         WHAT IS NOT REQUIRED, and why not:

           - The wallet's sync indices. Deliberately not consulted anywhere in
             this branch. That is the whole of the correction.
           - A socket head, where the silence limb applies. But a connection
             with no subscription established and no header ever
             (`subscribed: false`, `height: null`) is UNKNOWN rather than
             stalled — a node client that does not offer the subscription must
             not read as a dead one — and is skipped.
           - The wallet not being busy. Already guaranteed rather than
             re-checked: `reserved`, `syncAhead`, and `busy` all return above.

         The remedy is `reconnect`, by way of `socketFault`, because the fault
         this catches IS the connection: a `refresh` re-reads the wallet from
         the indexer, which was never the thing that died. */
  const head = facts.chainHead;
  const socketKnown = facts.socketHead.subscribed || facts.socketHead.height !== null;
  if (head !== undefined && head.ageMs <= policy.chainHeadMaxAgeMs && socketKnown) {
    const lagged =
      head.socketLagBlocks !== null &&
      head.socketLagBlocks >= policy.socketLagBlocks &&
      head.socketLaggingForMs >= policy.socketStallMs;
    const silent =
      head.socketSilentForMs >= policy.socketStallMs &&
      head.advancedWhileSocketSilent >= policy.socketLagBlocks;
    if (lagged || silent) {
      return {
        verdict: 'degraded',
        reason: lagged
          ? `the submission socket is ${head.socketLagBlocks} block(s) behind a chain that has reached ${head.referenceHead}, and has been for ${minutes(head.socketLaggingForMs)} — the connection this service submits on is not following the chain`
          : `the submission socket has delivered no block header for ${minutes(head.socketSilentForMs)} while the chain climbed ${head.advancedWhileSocketSilent} block(s) to ${head.referenceHead} — the connection this service submits on has gone quiet`,
        act: true,
        /* The socket rather than the wallet: `chooseRemedy` reads this and takes
           the `reconnect` rung on the first tick instead of climbing the soft
           ladder. A rebuild is one websocket, and it is what repairs this. */
        socketFault: true as const,
        /* A restart only once rebuilding itself has failed M times, which is the
           bound every other socket fault here carries. */
        restartEligible: facts.consecutiveRebuildFailures >= policy.rebuildFailuresForRestart,
      };
    }
  }

  if (facts.now - facts.lastStateChangeAt >= policy.stallMs) {
    /* THE SOCKET IS ASKED ABOUT HERE TOO, and that is the whole lesson of
       15:28 UTC on 2026/09/05. This branch fired then — `the wallet's sync
       indices have not moved in 40 min` — and its `refresh` remedy re-read the
       wallet in 0 s and touched nothing else, while the submission socket that
       had died forty minutes earlier stayed dead for another four and a half
       hours. The counter above was still zero because nothing had been
       submitted since the socket died, so a count is not enough on its own: the
       socket's own STATE has to be read, and a stalled wallet is exactly the
       reading that should make this service suspect it. */
    const socketSuspect = facts.nodeSocket !== 'connected' || facts.consecutiveSocketFailures > 0;
    return {
      verdict: 'degraded',
      /* Soft, and so never a reason to bounce a live sponsor by itself: a very
         quiet stagenet could in principle produce nothing this wallet considers
         relevant for half an hour. It earns a refresh and a re-warm, and if the
         cause is real one of the hard branches above will catch it too. */
      reason: socketSuspect
        ? `the wallet’s sync indices have not moved in ${minutes(facts.now - facts.lastStateChangeAt)}, and the submission socket reads ${facts.nodeSocket} with ${facts.consecutiveSocketFailures} failure(s) against it — the socket is rebuilt before anything else is concluded`
        : `the wallet’s sync indices have not moved in ${minutes(facts.now - facts.lastStateChangeAt)} (the submission socket is answering)`,
      act: true,
      restartEligible:
        socketSuspect && facts.consecutiveRebuildFailures >= policy.rebuildFailuresForRestart,
      ...(socketSuspect ? { socketFault: true as const } : {}),
    };
  }

  /* 9. THE INDEXER HAS FALLEN BEHIND — reported, and nothing else.

        LAST, AND `act: false`, and both are deliberate. This is the only
        verdict in this module that names a fault in somebody ELSE'S service:
        an indexer a hundred blocks behind is a server having a bad afternoon,
        and there is no rung on the ladder that reaches it. A refresh re-reads
        the same stale answers, a reconnect rebuilds a socket that is fine, a
        restart resumes from a snapshot and asks the same indexer again.
        Choosing a different indexer is a decision for the endpoint list in
        `./endpoints.ts` and its own construction-time probe, not for a health
        remedy — see `publicDataProviderFor`.

        It is last so that it can never mask a fault this service CAN repair: a
        dead socket, a stale wallet, a wedged DUST balance, and every other
        branch above answer first, and this is only reached on a service that is
        otherwise well. `act: false` gives it `remedy: 'none'` through
        `chooseRemedy` and keeps it out of the unhealthy streak, so it cannot
        escalate anything of its own or hurry a later fault towards a restart.

        What it buys is the diagnosis. Nearly everything this wallet knows about
        the chain it learns from the indexer, so an indexer ten minutes behind
        is a sponsor whose every figure is ten minutes old — and without this
        line an operator would be reading those figures looking for a fault in
        the sponsor. */
  if (
    head !== undefined &&
    head.indexerBehindHeadBlocks !== null &&
    head.indexerBehindHeadBlocks >= policy.indexerBehindBlocks &&
    head.indexerBehindForMs >= policy.indexerBehindMs
  ) {
    return {
      verdict: 'degraded',
      reason: `the indexer is ${head.indexerBehindHeadBlocks} block(s) behind a chain that has reached ${head.referenceHead}, and has been for ${minutes(head.indexerBehindForMs)} — everything this wallet reads is that far out of date, and there is no remedy here for somebody else's server`,
      /* Reported and never acted on. See the note above the branch. */
      act: false,
      restartEligible: false,
    };
  }

  return {
    verdict: 'healthy',
    reason: `synced, connected, ${facts.utxoCount} DUST UTxO(s), able to prove`,
    act: false,
    restartEligible: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The remedy ladder                                                          */
/* -------------------------------------------------------------------------- */

export type HealthRemedy =
  | 'none'
  | 'refresh'
  | 'reconnect'
  | 'rewarm'
  | 'resyncDust'
  | 'restart';

export interface RemedyPolicy {
  /** Unhealthy ticks, this one included, before the re-warm rung is reached. */
  rewarmAfterTicks: number;
  rewarmCooldownMs: number;
  /**
   * Unhealthy ticks before a SOFT `degraded` cause may ask for a restart.
   *
   * COUNTED IN TICKS, WHICH MEANS THE CADENCE SETS IT. At the ten-minute
   * interval this service ran until 2026/09/06 the old figure of three was
   * thirty minutes of sustained fault before the first restart was asked for,
   * and thirty minutes was the number that had been reasoned about — three was
   * just how many ticks fitted in it. Dropping the interval to two minutes
   * would have turned the same three into six minutes without anybody deciding
   * that, so the count moves with the cadence and the wall clock stays put.
   *
   * The two HARD restart paths do not come through here and are deliberately
   * left to get faster: a facade that has not answered `wedgeTicks` times runs
   * with `ticksForRestart` of zero, and a submission socket that cannot be
   * rebuilt escalates on `rebuildFailuresForRestart` instead. Both are proved
   * faults with their own bounds, and both are the ones worth reaching sooner.
   */
  restartAfterTicks: number;
  /** The hard floor between two restart requests. Persisted, not in memory. */
  restartCooldownMs: number;
  /**
   * The floor between two DUST resyncs, and it is two minutes rather than the
   * restart's thirty.
   *
   * A wedge is PROVED, not inferred — the conjunction in `assessHealth` admits
   * one explanation — and the repair is cheap and measured: a snapshot rewrite
   * plus a cold DUST walk took 89.5 s on 2026/09/02 (16:24:06 to 16:25:36).
   * Making a provable fault wait out the soft ladder's patience is what left
   * the sponsor down for an hour twice in one afternoon.
   */
  resyncDustCooldownMs: number;
  /**
   * How long this process must have been UP before it may exit for a DUST
   * resync again.
   *
   * THE COOLDOWN ABOVE CANNOT DO THIS JOB, and that is not a flaw in it. A
   * resync ends with `process.exit(1)`; `lastResyncDustAt` is in memory, so it
   * dies with the process it was meant to bound, and the wedge branch
   * deliberately precedes the start-up grace — an inherited wedge lives in
   * exactly those first minutes. A wallet still wedged after its repair
   * therefore exits on its first tick, comes back, and exits again, and the
   * only thing that ever set the period of that loop was the health interval.
   * At ten minutes it was a slow, visible cycle. At two it would be a spin.
   *
   * So the floor is stated rather than inherited, and it is ten minutes: the
   * cadence the deployed service has been recovering at all along, now a
   * decision instead of a side effect. Detection is unaffected — the verdict is
   * published on the two-minute tick as always, eight minutes before anything
   * acts on it, which is strictly better for whoever is reading the journal.
   */
  resyncDustMinUptimeMs: number;
  /**
   * The floor between two restarts requested because the SOCKET could not be
   * rebuilt, and it is five minutes rather than the general thirty.
   *
   * Like the DUST wedge's own cooldown, this is a PROVED fault rather than an
   * inferred one: M bounded rebuilds, each a fresh `WsProvider` and a fresh
   * `ApiPromise`, have all failed, and until one succeeds this service cannot
   * put a single transaction on chain. Making that wait out the soft ladder's
   * half-hour patience is how 15:30 to 20:12 happened.
   */
  socketRestartCooldownMs: number;
}

/**
 * EVERY FIGURE HERE WAS RE-CHECKED AGAINST THE TWO-MINUTE TICK on 2026/09/06,
 * rung by rung, because a cadence change silently retunes anything counted in
 * ticks and anything whose cooldown is shorter than the interval:
 *
 *   `refresh`     — no cooldown, and none wanted. One replayed state read, plus
 *                   a socket rebuild only when the socket reads down. Firing
 *                   every two minutes instead of every ten is cheap and is the
 *                   repair arriving sooner.
 *   `reconnect`   — no cooldown, deliberately (see `socketRestartCooldownMs`).
 *                   One `WsProvider` and one `ApiPromise`. Bounded downstream
 *                   by `rebuildFailuresForRestart`, whose restart has a clock.
 *   `rewarm`      — `rewarmCooldownMs` is five minutes and NEVER bound anything
 *                   at a ten-minute tick. It binds now, which is what it was
 *                   written for; the rung is reached at four minutes instead of
 *                   twenty, and it is a key fetch that short-circuits on a
 *                   healthy prover plus a snapshot save this service already
 *                   makes every sixty seconds.
 *   `restart`     — rate bounded by `restartCooldownMs`, which is PERSISTED,
 *                   and by `awaitingHealthyTick`, likewise. Neither depends on
 *                   the cadence. `restartAfterTicks` did, and has been moved.
 *   `resyncDust`  — the one rung whose bound was the interval itself. Its
 *                   cooldown was two minutes, which at a two-minute tick
 *                   separates nothing, and it is in-memory across a
 *                   `process.exit`. Both halves are fixed below.
 */
export const DEFAULT_REMEDY_POLICY: RemedyPolicy = {
  rewarmAfterTicks: 2,
  rewarmCooldownMs: 300_000,
  /* Fifteen ticks at two minutes — the same thirty minutes of sustained soft
     fault that three ticks at ten minutes bought. */
  restartAfterTicks: 15,
  restartCooldownMs: 1_800_000,
  /* Ten minutes rather than two: a cooldown shorter than the tick that consults
     it is not a cooldown. */
  resyncDustCooldownMs: 600_000,
  resyncDustMinUptimeMs: 600_000,
  socketRestartCooldownMs: 300_000,
};

/**
 * Restart bookkeeping that must SURVIVE the restart it bounds.
 *
 * Kept on disk in the state directory for one reason: a rate limit on restarts
 * that lives in the restarted process's memory is not a rate limit. Both fields
 * here are read before a restart is requested and written as part of requesting
 * it.
 */
export interface HealthRecord {
  /** Restart requests this service has made, ever, on this droplet. */
  restarts: number;
  lastRestartRequestAt: string | null;
  lastRestartReason: string | null;
  /**
   * True from the moment a restart is requested until a healthy tick is seen.
   * This is what "never twice consecutively without an intervening healthy
   * tick" means once the tick in question is on the other side of a reboot.
   */
  awaitingHealthyTick: boolean;
}

export const EMPTY_HEALTH_RECORD: HealthRecord = {
  restarts: 0,
  lastRestartRequestAt: null,
  lastRestartReason: null,
  awaitingHealthyTick: false,
};

export interface RemedyState {
  lastRewarmAt: number | null;
  /** When a DUST resync was last requested, or `null` if never this boot. */
  lastResyncDustAt: number | null;
  record: HealthRecord;
}

export interface RemedyChoice {
  remedy: HealthRemedy;
  /** Why this rung and not the next one — logged, so a decision is auditable. */
  reason: string;
}

/**
 * Which rung this tick has earned. Pure, for the same reason `assessHealth` is:
 * the rate limits are the part most worth testing and the part least pleasant
 * to test against a real clock.
 */
export function chooseRemedy(
  assessment: HealthAssessment,
  facts: HealthFacts,
  state: RemedyState,
  policy: RemedyPolicy = DEFAULT_REMEDY_POLICY,
): RemedyChoice {
  if (!assessment.act) return { remedy: 'none', reason: assessment.verdict };

  const ticks = facts.consecutiveUnhealthy + 1;

  /* The DUST wedge, and it takes its rung on the FIRST tick.
     `restartAfterTicks`, `restartCooldownMs`, and `awaitingHealthyTick` are all
     deliberately bypassed: they exist to stop a soft, possibly-transient signal
     from bouncing a live sponsor, and a wedge is neither soft nor transient.
     Its own two-minute cooldown is what bounds it instead. The in-use gate is
     NOT bypassed — this remedy exits the process, and doing that mid-spend
     would abandon somebody's proof. */
  if (assessment.verdict === 'dust-wedged') {
    if (facts.reserved || facts.busy) {
      return { remedy: 'refresh', reason: 'the DUST is wedged, but the wallet is in use' };
    }
    /* The floor the cooldown below cannot enforce, because this remedy exits
       and the cooldown is in memory. Checked against UPTIME, which is the one
       clock that survives the exit and starts again on the other side of it —
       so a wallet still wedged after its repair cycles at the stated period
       rather than at whatever the health interval happens to be. */
    if (facts.uptimeMs < policy.resyncDustMinUptimeMs) {
      return {
        remedy: 'refresh',
        reason: `the DUST is wedged, but this process has only been up ${minutes(facts.uptimeMs)} — a resync exits, and one that came back wedged must not exit again for ${minutes(policy.resyncDustMinUptimeMs)}`,
      };
    }
    if (
      state.lastResyncDustAt !== null &&
      facts.now - state.lastResyncDustAt < policy.resyncDustCooldownMs
    ) {
      const wait = policy.resyncDustCooldownMs - (facts.now - state.lastResyncDustAt);
      return {
        remedy: 'refresh',
        reason: `a DUST resync is warranted, but the last one was ${seconds(facts.now - state.lastResyncDustAt)} ago — ${seconds(wait)} of the cooldown left`,
      };
    }
    return {
      remedy: 'resyncDust',
      reason: 'the ledger is withholding coins this wallet owns, and only a resync from chain forgets them',
    };
  }

  /* The submission socket, and — like the DUST wedge — it takes its rung on the
     FIRST tick rather than climbing the soft ladder.

     The soft ladder exists to keep a possibly-transient signal from acting on a
     live sponsor. This signal is neither: N submissions in a row have failed on
     the transport, or the socket says outright that it is not connected, and
     every second of it is a registration or a grant a person is watching fail.
     `refresh` cannot repair it — that is what was tried at 15:28 on 2026/09/05
     — and `rewarm` touches the prover, which is a different subsystem again.

     The in-use gate is NOT bypassed at the restart rung, for the reason it
     never is. A RECONNECT while a job is in flight is allowed, and deliberately
     so: the job's own submission is the thing that is failing, and a rebuilt
     socket is what its retry needs. */
  if (assessment.socketFault) {
    if (assessment.restartEligible) {
      if (facts.reserved || facts.busy) {
        return {
          remedy: 'reconnect',
          reason:
            'the socket cannot be rebuilt and a restart is warranted, but the wallet is in use — rebuilding once more instead',
        };
      }
      const last = state.record.lastRestartRequestAt
        ? Date.parse(state.record.lastRestartRequestAt)
        : null;
      if (
        last !== null &&
        Number.isFinite(last) &&
        facts.now - last < policy.socketRestartCooldownMs
      ) {
        return {
          remedy: 'reconnect',
          reason: `the socket cannot be rebuilt, but the last restart was ${minutes(facts.now - last)} ago — ${seconds(policy.socketRestartCooldownMs - (facts.now - last))} of the cooldown left`,
        };
      }
      return {
        remedy: 'restart',
        reason: `${facts.consecutiveRebuildFailures} rebuilds of the submission socket have failed in a row — a fresh process is the only connection left to try`,
      };
    }
    /* No cooldown, and that is deliberate. Every other rung here has one
       because it is expensive or destructive; a rebuild is one websocket, it is
       bounded, and the thing that bounds how often it can be worth doing is the
       rebuild-failure count that escalates past it. A cooldown on this rung
       would only ever be a delay between a broken sponsor and its repair. */
    return {
      remedy: 'reconnect',
      reason: `${facts.consecutiveSocketFailures} submission(s) have failed on the socket in a row and it reads ${facts.nodeSocket}`,
    };
  }

  /* A wedged facade needs no patience: by construction it has already failed
     `wedgeTicks` consecutive checks, and no in-process remedy can reach it. A
     merely degraded one waits out `restartAfterTicks` first. */
  const ticksForRestart = assessment.verdict === 'wedged' ? 0 : policy.restartAfterTicks;

  if (assessment.restartEligible && ticks >= ticksForRestart) {
    /* Re-checked here as well as in `assessHealth`, and not because the facts
       could have changed between the two — they cannot, it is one snapshot —
       but because this is the gate that must be impossible to reach past by
       adding a branch above. A restart while a spend is in flight is the one
       failure this whole module must never cause. */
    if (facts.reserved || facts.busy) {
      return { remedy: 'refresh', reason: 'a restart is warranted, but the wallet is in use' };
    }
    const last = state.record.lastRestartRequestAt
      ? Date.parse(state.record.lastRestartRequestAt)
      : null;
    if (last !== null && Number.isFinite(last) && facts.now - last < policy.restartCooldownMs) {
      const wait = policy.restartCooldownMs - (facts.now - last);
      return {
        remedy: 'refresh',
        reason: `a restart is warranted, but the last one was ${minutes(facts.now - last)} ago — ${minutes(wait)} of the cooldown left`,
      };
    }
    if (state.record.awaitingHealthyTick) {
      return {
        remedy: 'refresh',
        reason: 'a restart is warranted, but the previous restart has not yet been followed by a healthy tick',
      };
    }
    return {
      remedy: 'restart',
      reason: `${ticks} consecutive unhealthy checks, nothing in flight, and the restart cooldown has elapsed`,
    };
  }

  if (ticks >= policy.rewarmAfterTicks) {
    if (
      state.lastRewarmAt === null ||
      facts.now - state.lastRewarmAt >= policy.rewarmCooldownMs
    ) {
      return { remedy: 'rewarm', reason: `${ticks} consecutive unhealthy checks` };
    }
    return {
      remedy: 'refresh',
      reason: `a re-warm is warranted, but the last one was ${seconds(facts.now - state.lastRewarmAt)} ago`,
    };
  }

  return { remedy: 'refresh', reason: `unhealthy check ${ticks}` };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What one tick reads — every fact except the three the loop itself owns: the
 * clock, the unhealthy streak, and when the state last changed.
 */
export type HealthProbeReading = Omit<
  HealthFacts,
  'now' | 'consecutiveUnhealthy' | 'lastStateChangeAt' | 'chainHead'
> & {
  /**
   * A cheap string over the facts that ought to move on a live chain — the sync
   * indices, the connection flags, the UTxO count. The loop compares it with
   * the previous tick's to maintain `lastStateChangeAt`, so the probe does not
   * have to remember anything.
   */
  fingerprint: string;
};

/** `./server.ts` supplies this from the live wallet. */
export type HealthProbe = () => Promise<HealthProbeReading>;

export interface HealthRemedies {
  /**
   * Re-read the wallet's state, and rebuild the submission socket if it is not
   * answering. Rejects if it cannot.
   *
   * The second half is new, and it is the correction to 15:28 UTC on
   * 2026/09/05: this rung ran, reported `refreshed the wallet state in 0 s`,
   * and left the dead connection under it untouched.
   */
  refresh(): Promise<void>;
  /**
   * Throw the submission socket away and open a fresh one — a new `WsProvider`
   * and a new `ApiPromise`, the old one disconnected and discarded.
   *
   * The rung the ladder had no answer for. `refresh` reads the wallet, which is
   * a different connection; `rewarm` fetches proving keys, which is a different
   * subsystem; and a restart is thirty seconds of chain walk for a fault a
   * socket would fix.
   */
  reconnect(reason: string): Promise<void>;
  /** Re-fetch the proving key material, and checkpoint the sync snapshot. */
  rewarm(): Promise<void>;
  /**
   * Give this wallet back the DUST the ledger is withholding from it.
   *
   * Not an in-process repair, because there is no SDK call that un-pends a live
   * wallet: `./server.ts` checkpoints, rewrites the snapshot's DUST state (or
   * marks it for a cold start), and exits for systemd to bring back. Like
   * `restart` it is not expected to return.
   */
  resyncDust(reason: string): Promise<void>;
  /** Checkpoint, then leave with a non-zero status for systemd to notice. */
  restart(reason: string): Promise<void>;
}

export interface HealthRecordStore {
  read(): HealthRecord;
  write(record: HealthRecord): Promise<void>;
}

export interface HealthLoopOptions {
  intervalMs: number;
  probe: HealthProbe;
  /**
   * The node's own head over HTTPS — `./chainHead.ts`. Optional: without it and
   * without {@link indexerHeight} there is no reference, and the loop behaves
   * exactly as it did on `stallMs` alone.
   *
   * Read on the same tick as the wallet, because the figures are only worth
   * anything together: what `assessHealth` compares is the reference head
   * against the socket's own, and reading them minutes apart would put a gap
   * into the comparison that neither of them put there.
   */
  chainHead?: ChainHeadProbe;
  /**
   * The indexer's latest block height — the OTHER half of the reference, and
   * the half that survives the node being unreachable.
   *
   * One bounded GraphQL query per tick against a different host answering a
   * different protocol. It exists because of 2026/09/06: when the node's
   * addresses were black-holed the HTTPS probe went blind at the same instant
   * the socket did, and a reference that shares a host with the thing it checks
   * is not a reference.
   *
   * Must not reject — `null` is how it says the indexer would not answer — and
   * a rejection is caught here anyway, because losing the second observer must
   * never be able to fail a tick.
   */
  indexerHeight?: () => Promise<number | null>;
  remedies: HealthRemedies;
  store: HealthRecordStore;
  policy?: HealthPolicy;
  remedyPolicy?: RemedyPolicy;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
  /** Injectable so a test gets a deterministic schedule. */
  random?: () => number;
}

/** What `GET /status` publishes as `health`. */
export interface HealthSnapshot {
  intervalMs: number;
  checks: number;
  lastCheckAt: string | null;
  verdict: HealthVerdict | null;
  reason: string | null;
  consecutiveUnhealthy: number;
  lastRemedy: {
    remedy: HealthRemedy;
    at: string;
    reason: string;
    outcome: 'ok' | 'failed';
    detail?: string;
  } | null;
  restartsRequestedSinceBoot: number;
  restartsRequestedTotal: number;
  /** When this process last asked for a DUST resync. `/status` publishes it. */
  lastResyncDustAt: string | null;
  lastRestartRequestAt: string | null;
  lastRestartReason: string | null;
  awaitingHealthyTick: boolean;
  /**
   * The reference head and everything measured against it, as `/status`
   * publishes it. `null` when neither observer is configured, which is the only
   * case in which this service has nothing to say about the chain under it.
   */
  chainHead: ChainHeadSnapshot | null;
  /**
   * The chain as the SUBMISSION SOCKET sees it, and how far behind the
   * reference that leaves it. `null` before the first tick.
   *
   * The pair of figures the stall rule acts on, published so that an operator
   * can watch the rule not firing as well as firing — which, after 614 false
   * `degraded` lines in a day from the rule this replaced, is the reading that
   * matters most.
   */
  socketHead: SocketHeadSnapshot | null;
  /**
   * `ok` while the public node is answering, `failing` once it has refused
   * `chainHeadProbeFailuresForFailing` times in a row, `off` when there is no
   * probe.
   *
   * Reported and NEVER acted on — see the policy field's own note. `failing` is
   * how an operator reading a thirty-minute stall diagnosis finds out that the
   * five-minute one was not available to make it.
   */
  chainHeadProbe: 'ok' | 'failing' | 'off';
}

export interface ChainHeadSnapshot {
  /** The HTTPS endpoint being asked. */
  url: string;
  /** The last height the NODE gave, or `null` if it never has. */
  height: number | null;
  /** When it was read, ISO-8601. */
  at: string | null;
  /** How old that reading was at the last tick. */
  ageMs: number | null;
  /** Head probes failed since the last one that did not. */
  probeFailures: number;
  /** Head probes attempted and failed, ever, this process. */
  probes: number;
  failures: number;
  /** Why the last one failed. `null` after a success. */
  lastError: string | null;
  /** The INDEXER's latest block height, or `null` when it would not answer. */
  indexerHead: number | null;
  /**
   * `max` of the two heights above — what the socket is judged against, and
   * `null` only when neither observer answered.
   */
  referenceHead: number | null;
  /**
   * How far the indexer is behind the reference. Zero when the indexer IS the
   * reference, `null` when it did not answer. Past
   * `indexerBehindBlocks` for `indexerBehindMs` this is reported as `degraded`
   * with no remedy — see `assessHealth`.
   */
  indexerBehindHeadBlocks: number | null;
}

export interface SocketHeadSnapshot {
  /** The highest header the submission socket has delivered, or `null`. */
  height: number | null;
  /** When that header arrived, ISO-8601. */
  at: string | null;
  /** Whether a head subscription is established on the current connection. */
  subscribed: boolean;
  /** Headers delivered since that connection was built. */
  headers: number;
  /**
   * `referenceHead - height`, and the figure the lag limb of the stall rule
   * acts on. Zero on a socket that is keeping up, which is what an operator
   * should expect to see; `null` when there is nothing to compare.
   */
  socketHeadLagBlocks: number | null;
  /** How long since the last header, and how far the chain got meanwhile. */
  silentForMs: number;
  advancedWhileSilentBlocks: number;
}

export interface HealthMonitor {
  /** For `/status`. Cheap; reads nothing. */
  snapshot(): HealthSnapshot;
  /** Runs one tick now, and resolves once it and any remedy have finished. */
  tick(): Promise<HealthAssessment | null>;
  /**
   * The verdict as it stands RIGHT NOW — one probe, no remedy, no bookkeeping.
   *
   * `snapshot()` is the last tick's word, and the loop's interval is minutes.
   * That is fine for `/status`, which is a report, and wrong for a gate: the
   * resolver-pool filler reading a `busy` verdict left over from a spend that
   * finished four minutes ago paused itself for no reason. This asks.
   *
   * It deliberately does NOT touch the streak counter or the snapshot: a probe
   * taken to answer a gate must not be able to escalate a remedy or reset a
   * fault streak that the loop is tracking.
   */
  assessNow(): Promise<HealthAssessment>;
  stop(): void;
}

/**
 * How far either side of the interval a tick may land.
 *
 * Small on purpose. The point is not to spread load — one tick every ten
 * minutes is nothing — it is that this service already has a snapshot save and
 * a DUST registration retry on exact sixty-second boundaries, and a health
 * check that lands on the same second as one of them every time would be
 * reading the wallet mid-write for the life of the process.
 */
const JITTER_FRACTION = 0.05;

export function startHealthLoop(options: HealthLoopOptions): HealthMonitor {
  const policy = options.policy ?? DEFAULT_HEALTH_POLICY;
  const remedyPolicy = options.remedyPolicy ?? DEFAULT_REMEDY_POLICY;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));

  const bootedAt = now();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /* One tick at a time, remedy included. A re-warm can take seconds and a
     checkpoint can take longer; a second tick landing on top of the first would
     double-count the unhealthy streak and could run two remedies at once. */
  let inFlight = false;

  let consecutiveUnhealthy = 0;
  let lastFingerprint: string | null = null;
  let lastStateChangeAt = bootedAt;
  let lastRewarmAt: number | null = null;
  let lastResyncDustAt: number | null = null;
  let restartsSinceBoot = 0;

  /* THE REFERENCE HEAD'S BOOKKEEPING, and the socket's.

     `assessHealth` is pure and is handed durations, because "for five minutes"
     cannot be read off a single tick. Everything below is what turns a sequence
     of readings into those durations.

     `lastHeadReading` and `lastIndexerHeight` are the two observers' last
     answers, kept so `assessNow()` can answer a gate without opening requests
     of its own — a probe taken to answer a gate must not be able to move any of
     this loop's bookkeeping.

     `socketLagSince` is when the lag last REACHED the threshold and has been at
     or over it since; `null` the moment it is not, so the duration is a
     continuous one rather than a total.

     `lastSocketHeaderAt` and `referenceAtLastHeader` are the silence limb: the
     instant of the last header this socket delivered, and where the chain had
     got to then. A rebuild resets the socket's own figures to nothing, and
     `socketWatchSince` is what gives a connection that has delivered no header
     at all a clock to be silent against — its own start, not the process's.

     `indexerBehindSince` is the same continuous-duration idea for the indexer,
     whose verdict is alert-only. */
  let lastHeadReading: ChainHeadReading | null = null;
  let lastIndexerHeight: number | null = null;
  let socketLagSince: number | null = null;
  let lastSocketHeaderAt: number | null = null;
  let referenceAtLastHeader: number | null = null;
  let socketWatchSince: number | null = null;
  let indexerBehindSince: number | null = null;

  const snapshot: HealthSnapshot = {
    intervalMs: options.intervalMs,
    checks: 0,
    lastCheckAt: null,
    verdict: null,
    reason: null,
    consecutiveUnhealthy: 0,
    lastRemedy: null,
    restartsRequestedSinceBoot: 0,
    restartsRequestedTotal: options.store.read().restarts,
    lastResyncDustAt: null,
    lastRestartRequestAt: options.store.read().lastRestartRequestAt,
    lastRestartReason: options.store.read().lastRestartReason,
    awaitingHealthyTick: options.store.read().awaitingHealthyTick,
    chainHead: options.chainHead
      ? {
          url: options.chainHead.url,
          height: null,
          at: null,
          ageMs: null,
          probeFailures: 0,
          probes: 0,
          failures: 0,
          lastError: null,
          indexerHead: null,
          referenceHead: null,
          indexerBehindHeadBlocks: null,
        }
      : null,
    socketHead: null,
    chainHeadProbe: options.chainHead ? 'ok' : 'off',
  };

  /**
   * The node's HTTPS height, but only while it is still an OBSERVATION.
   *
   * `ChainHeadReading.height` is sticky across failed probes — see
   * `./chainHead.ts` — so a node that stopped answering four minutes ago is
   * still reporting the height it last saw. Carrying that into the reference
   * would turn a blind probe into a chain that had stopped climbing, which is a
   * conclusion no probe here is entitled to. Past `chainHeadMaxAgeMs` the node
   * contributes nothing and the indexer is the whole reference — which is
   * exactly the black-holed-node case of 2026/09/06.
   */
  const freshNodeHeightAt = (at: number): number | null => {
    const reading = lastHeadReading;
    if (reading === null || reading.height === null || reading.at === null) return null;
    return at - reading.at <= policy.chainHeadMaxAgeMs ? reading.height : null;
  };

  /**
   * One tick's readings turned into the facts the classifier reasons about,
   * and the durations it cannot derive on its own.
   *
   * `undefined` when NEITHER observer answered. That is "no observation" rather
   * than "an observation of nothing", and the difference is the whole of what
   * keeps this rule honest: the first falls back to the wallet's thirty-minute
   * rule, the second would be a claim about a chain nobody looked at.
   *
   * MUTATES the loop's memory, and is therefore called exactly once per tick,
   * from `runTick`. `assessNow()` uses {@link headFactsForGate} instead, which
   * reads the same memory without moving it.
   */
  const observeAt = (at: number, socket: SocketHead): ChainHeadFacts | undefined => {
    const nodeHeight = freshNodeHeightAt(at);
    const indexerHeight = lastIndexerHeight;
    if (nodeHeight === null && indexerHeight === null) {
      /* No reference this tick. The continuous-duration clocks are left where
         they are rather than reset: an outage of both observers must not be
         able to forgive a lag that was already four minutes old, and it must
         not be able to extend one either — the branch is skipped entirely for
         want of a reading, which is the correct answer. */
      return undefined;
    }
    const referenceHead = Math.max(nodeHeight ?? 0, indexerHeight ?? 0);
    /* The freshest of the two: the indexer is asked on this very tick, so when
       it answered the reference is as new as the tick. */
    const ageMs =
      indexerHeight !== null ? 0 : at - (lastHeadReading?.at ?? at);

    /* THE SILENCE LIMB. A header the socket has not delivered before is stamped
       with where the chain had got to when it arrived, so the climb during a
       silence is measured from the right place. A connection that has delivered
       NO header — a fresh rebuild, or a stream that never opened — is silent
       from the moment this loop first saw it in that state, not from process
       start: a rebuild must be given its own five minutes rather than
       inheriting the previous connection's. */
    if (socket.at !== null && socket.at !== lastSocketHeaderAt) {
      lastSocketHeaderAt = socket.at;
      referenceAtLastHeader = referenceHead;
      socketWatchSince = null;
    } else if (socket.at === null) {
      if (socketWatchSince === null) {
        socketWatchSince = at;
        referenceAtLastHeader = referenceHead;
      }
      lastSocketHeaderAt = null;
    }
    const silentSince = socket.at ?? socketWatchSince ?? at;
    const socketSilentForMs = Math.max(0, at - silentSince);
    const advancedWhileSocketSilent =
      referenceAtLastHeader === null ? 0 : Math.max(0, referenceHead - referenceAtLastHeader);

    /* THE LAG LIMB. Never negative: a socket ahead of the reference is a socket
       doing its job with an indexer a block behind it. */
    const socketLagBlocks =
      socket.height === null ? null : Math.max(0, referenceHead - socket.height);
    if (socketLagBlocks !== null && socketLagBlocks >= policy.socketLagBlocks) {
      if (socketLagSince === null) socketLagSince = at;
    } else {
      socketLagSince = null;
    }

    const indexerBehindHeadBlocks =
      indexerHeight === null ? null : Math.max(0, referenceHead - indexerHeight);
    if (
      indexerBehindHeadBlocks !== null &&
      indexerBehindHeadBlocks >= policy.indexerBehindBlocks
    ) {
      if (indexerBehindSince === null) indexerBehindSince = at;
    } else {
      indexerBehindSince = null;
    }

    return {
      nodeHeight,
      indexerHeight,
      referenceHead,
      ageMs,
      probeFailures: lastHeadReading?.probeFailures ?? 0,
      socketLagBlocks,
      socketLaggingForMs: socketLagSince === null ? 0 : at - socketLagSince,
      socketSilentForMs,
      advancedWhileSocketSilent,
      indexerBehindHeadBlocks,
      indexerBehindForMs: indexerBehindSince === null ? 0 : at - indexerBehindSince,
    };
  };

  /**
   * The same facts for a GATE, derived without moving anything.
   *
   * `assessNow()` is documented not to touch the loop's bookkeeping — a gate's
   * cadence is whatever the resolver-pool filler happens to be doing, and
   * letting it stamp the silence clock would let it decide how long a socket
   * had been quiet. So this reads the clocks the last tick set and computes the
   * durations against `at`; between ticks that is the same answer the tick
   * would have given, and it can never be a longer one.
   */
  const headFactsForGate = (at: number, socket: SocketHead): ChainHeadFacts | undefined => {
    const nodeHeight = freshNodeHeightAt(at);
    const indexerHeight = lastIndexerHeight;
    if (nodeHeight === null && indexerHeight === null) return undefined;
    const referenceHead = Math.max(nodeHeight ?? 0, indexerHeight ?? 0);
    const silentSince = socket.at ?? socketWatchSince;
    const socketLagBlocks =
      socket.height === null ? null : Math.max(0, referenceHead - socket.height);
    const indexerBehindHeadBlocks =
      indexerHeight === null ? null : Math.max(0, referenceHead - indexerHeight);
    return {
      nodeHeight,
      indexerHeight,
      referenceHead,
      ageMs: indexerHeight !== null ? 0 : at - (lastHeadReading?.at ?? at),
      probeFailures: lastHeadReading?.probeFailures ?? 0,
      socketLagBlocks,
      socketLaggingForMs: socketLagSince === null ? 0 : Math.max(0, at - socketLagSince),
      socketSilentForMs: silentSince === null ? 0 : Math.max(0, at - silentSince),
      advancedWhileSocketSilent:
        referenceAtLastHeader === null ? 0 : Math.max(0, referenceHead - referenceAtLastHeader),
      indexerBehindHeadBlocks,
      indexerBehindForMs: indexerBehindSince === null ? 0 : Math.max(0, at - indexerBehindSince),
    };
  };

  /** The socket head a tick that could not read the wallet has to assume. */
  const UNKNOWN_SOCKET_HEAD: SocketHead = {
    height: null,
    at: null,
    subscribed: false,
    headers: 0,
  };

  const publishRecord = (record: HealthRecord): void => {
    snapshot.restartsRequestedTotal = record.restarts;
    snapshot.lastRestartRequestAt = record.lastRestartRequestAt;
    snapshot.lastRestartReason = record.lastRestartReason;
    snapshot.awaitingHealthyTick = record.awaitingHealthyTick;
  };

  const runTick = async (): Promise<HealthAssessment | null> => {
    if (inFlight || stopped) return null;
    inFlight = true;
    try {
      /* BOTH OBSERVERS ARE ASKED FIRST, before the clock is stamped, so the
         reference the classifier judges by age is a fresh one rather than one
         aged by however long the wallet took to answer. Neither can fail the
         tick: the head probe is bounded at five seconds and cannot reject (see
         `./chainHead.ts`), and the indexer query is caught here — losing an
         observer must never be able to end a check. */
      if (options.chainHead) lastHeadReading = await options.chainHead.read();
      if (options.indexerHeight) {
        lastIndexerHeight = await options.indexerHeight().catch(() => null);
      }

      const at = now();
      let facts: HealthFacts;
      try {
        const reading = await options.probe();
        const moved = lastFingerprint !== null && reading.fingerprint !== lastFingerprint;
        if (moved) lastStateChangeAt = at;
        lastFingerprint = reading.fingerprint;
        facts = {
          ...reading,
          now: at,
          lastStateChangeAt,
          consecutiveUnhealthy,
          chainHead: observeAt(at, reading.socketHead),
        };
      } catch (cause) {
        /* The probe itself is written not to throw — it reports an unreadable
           wallet as `stateReadable: false`. If it throws anyway, that IS an
           unreadable wallet, and swallowing it would make the watchdog blind to
           exactly the failure it exists for. */
        warn(`[health] the probe failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        facts = {
          now: at,
          uptimeMs: at - bootedAt,
          stateReadable: false,
          synced: false,
          connected: false,
          dustSpecks: 0n,
          utxoCount: 0,
          nightAtomic: 0n,
          dustGenerating: false,
          pendingTransactions: 0,
          proving: 'failed',
          reserved: false,
          busy: false,
          syncAhead: null,
          lastSponsorshipAt: null,
          orphans: 0,
          /* A wallet that cannot be read says nothing about the socket, and
             claiming it is dead would escalate a wallet fault into a restart
             for the wrong reason. The `wedged` branch above owns this case. */
          nodeSocket: 'connected',
          consecutiveSocketFailures: 0,
          consecutiveRebuildFailures: 0,
          /* For the same reason as `nodeSocket` above: a wallet that cannot be
             read says nothing about the socket, and an unknown socket head is
             no evidence rather than a stalled one. */
          socketHead: UNKNOWN_SOCKET_HEAD,
          lastStateChangeAt,
          consecutiveUnhealthy,
          /* Carried even here, where it changes no verdict — the unreadable
             branches return long before the stall ones — because `/status`
             publishes this reading and an operator looking at a wedged facade
             is entitled to know whether the chain under it was moving. */
          chainHead: observeAt(at, UNKNOWN_SOCKET_HEAD),
        };
      }

      const assessment = assessHealth(facts, policy);
      /* `act` as well as the verdict, and that is what keeps the alert-only
         indexer-behind branch out of the escalation ladder. Every verdict that
         acts is one this service can do something about; a `degraded` that
         cannot be acted on is a report, and counting it would let somebody
         else's slow indexer hurry a later, genuine fault towards a restart. */
      const unhealthy =
        assessment.act &&
        (assessment.verdict === 'degraded' ||
          assessment.verdict === 'wedged' ||
          assessment.verdict === 'dust-wedged');
      /* Only `healthy` clears the streak. `busy` and `settling` LEAVE IT ALONE:
         a wallet that was degraded and is now merely mid-spend has not been
         shown to be well, and zeroing the count there would let a fault that
         happens to coincide with traffic never escalate. */
      const previousStreak = consecutiveUnhealthy;
      if (assessment.verdict === 'healthy') consecutiveUnhealthy = 0;
      else if (unhealthy) consecutiveUnhealthy = previousStreak + 1;

      snapshot.checks += 1;
      snapshot.lastCheckAt = new Date(at).toISOString();
      snapshot.verdict = assessment.verdict;
      snapshot.reason = assessment.reason;
      snapshot.consecutiveUnhealthy = consecutiveUnhealthy;
      if (options.chainHead && lastHeadReading !== null) {
        const head = lastHeadReading;
        snapshot.chainHead = {
          url: options.chainHead.url,
          height: head.height,
          at: head.at === null ? null : new Date(head.at).toISOString(),
          ageMs: head.at === null ? null : at - head.at,
          probeFailures: head.probeFailures,
          probes: head.probes,
          failures: head.failures,
          lastError: head.lastError,
          indexerHead: lastIndexerHeight,
          referenceHead: facts.chainHead?.referenceHead ?? null,
          indexerBehindHeadBlocks: facts.chainHead?.indexerBehindHeadBlocks ?? null,
        };
        /* Published, not acted on. A public node that will not answer says
           nothing about this wallet, and since 2026/09/06 it does not even turn
           the fast rule off — the indexer is the other half of the reference,
           and one observer is enough. It is published because an operator
           diagnosing by hand is entitled to know which observers were
           available. */
        snapshot.chainHeadProbe =
          head.probeFailures >= policy.chainHeadProbeFailuresForFailing ? 'failing' : 'ok';
      }
      /* The socket's own view, published every tick — including, and especially,
         on the healthy ticks. A rule that fired 614 times in a day on a well
         sponsor is a rule an operator has to be able to watch NOT firing. */
      snapshot.socketHead = {
        height: facts.socketHead.height,
        at: facts.socketHead.at === null ? null : new Date(facts.socketHead.at).toISOString(),
        subscribed: facts.socketHead.subscribed,
        headers: facts.socketHead.headers,
        socketHeadLagBlocks: facts.chainHead?.socketLagBlocks ?? null,
        silentForMs: facts.chainHead?.socketSilentForMs ?? 0,
        advancedWhileSilentBlocks: facts.chainHead?.advancedWhileSocketSilent ?? 0,
      };

      const record = options.store.read();
      if (assessment.verdict === 'healthy' && record.awaitingHealthyTick) {
        const cleared: HealthRecord = { ...record, awaitingHealthyTick: false };
        await options.store.write(cleared);
        publishRecord(cleared);
        log('[health] healthy again — the restart bar is lifted');
      }

      const choice = chooseRemedy(
        assessment,
        facts,
        { lastRewarmAt, lastResyncDustAt, record: options.store.read() },
        remedyPolicy,
      );

      const line = `[health] ${assessment.verdict}: ${assessment.reason}`;
      if (unhealthy) warn(`${line} — remedy: ${choice.remedy} (${choice.reason})`);
      else log(line);

      if (choice.remedy === 'none') return assessment;

      const startedAt = now();
      try {
        if (choice.remedy === 'refresh') {
          await options.remedies.refresh();
          log(`[health] refreshed the wallet state in ${seconds(now() - startedAt)}`);
        } else if (choice.remedy === 'reconnect') {
          warn(
            `[health] REBUILDING THE SUBMISSION SOCKET — ${assessment.reason}. Nothing this service submits reaches the node until it is back.`,
          );
          await options.remedies.reconnect(assessment.reason);
          log(`[health] rebuilt the submission socket in ${seconds(now() - startedAt)}`);
        } else if (choice.remedy === 'rewarm') {
          await options.remedies.rewarm();
          lastRewarmAt = now();
          log(`[health] re-warmed the prover and checkpointed the wallet in ${seconds(now() - startedAt)}`);
        } else if (choice.remedy === 'resyncDust') {
          /* Recorded BEFORE the call, for the reason the restart record is:
             this remedy is expected to end the process, and a cooldown a
             process only writes on the way out is not a cooldown. In memory
             rather than on disk because the resync itself is what clears the
             fault — a restarted process reads its DUST from chain and either is
             wedged again, which is new evidence, or is not. */
          lastResyncDustAt = startedAt;
          snapshot.lastResyncDustAt = new Date(startedAt).toISOString();
          warn(
            `[health] RESYNCING THE DUST FROM CHAIN — ${assessment.reason}. The snapshot's pending flags are the fault, so they are rewritten before this process comes back; the next resync cannot come for ${seconds(remedyPolicy.resyncDustCooldownMs)}.`,
          );
          await options.remedies.resyncDust(assessment.reason);
        } else {
          const requested: HealthRecord = {
            restarts: record.restarts + 1,
            lastRestartRequestAt: new Date(startedAt).toISOString(),
            lastRestartReason: assessment.reason,
            awaitingHealthyTick: true,
          };
          /* Written BEFORE the exit, or the limit it enforces would not exist:
             a process that dies between deciding and recording has no memory of
             having decided. */
          await options.store.write(requested);
          publishRecord(requested);
          restartsSinceBoot += 1;
          snapshot.restartsRequestedSinceBoot = restartsSinceBoot;
          warn(
            `[health] REQUESTING A RESTART — ${assessment.reason}. This is restart request ${requested.restarts}; the next one cannot come for ${minutes(remedyPolicy.restartCooldownMs)}, and not until a healthy check has been seen.`,
          );
          await options.remedies.restart(assessment.reason);
        }
        snapshot.lastRemedy = {
          remedy: choice.remedy,
          at: new Date(startedAt).toISOString(),
          reason: choice.reason,
          outcome: 'ok',
        };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        warn(`[health] the ${choice.remedy} remedy failed: ${detail}`);
        snapshot.lastRemedy = {
          remedy: choice.remedy,
          at: new Date(startedAt).toISOString(),
          reason: choice.reason,
          outcome: 'failed',
          detail,
        };
      }

      return assessment;
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    const jitter = options.intervalMs * JITTER_FRACTION;
    const delay = Math.max(1_000, Math.round(options.intervalMs + (random() * 2 - 1) * jitter));
    timer = setTimeout(() => {
      void runTick()
        .catch((cause) => warn(`[health] the check failed: ${cause}`))
        .finally(schedule);
    }, delay);
    /* Unreferenced so the watchdog never becomes the reason this process will
       not exit — SIGTERM handling is `./server.ts`'s, and it saves a snapshot. */
    timer.unref();
  };

  schedule();

  return {
    snapshot: () => ({ ...snapshot }),
    tick: runTick,
    assessNow: async (): Promise<HealthAssessment> => {
      const at = now();
      try {
        const reading = await options.probe();
        /* The LAST readings rather than fresh ones, deliberately. This method
           answers a gate and is documented not to touch the loop's bookkeeping;
           opening requests here would also let a gate's cadence — which is
           whatever the resolver-pool filler happens to be doing — drive how
           often somebody else's node and indexer are asked. */
        return assessHealth(
          {
            ...reading,
            now: at,
            lastStateChangeAt,
            consecutiveUnhealthy,
            chainHead: headFactsForGate(at, reading.socketHead),
          },
          policy,
        );
      } catch {
        /* An unreadable wallet, which is a real verdict rather than an error —
           and the caller (a gate) needs an answer, not an exception. */
        return assessHealth(
          {
            now: at,
            uptimeMs: at - bootedAt,
            stateReadable: false,
            synced: false,
            connected: false,
            dustSpecks: 0n,
            utxoCount: 0,
            nightAtomic: 0n,
            dustGenerating: false,
            pendingTransactions: 0,
            proving: 'failed',
            reserved: false,
            busy: false,
            syncAhead: null,
            lastSponsorshipAt: null,
            orphans: 0,
            nodeSocket: 'connected',
            consecutiveSocketFailures: 0,
            consecutiveRebuildFailures: 0,
            socketHead: UNKNOWN_SOCKET_HEAD,
            lastStateChangeAt,
            consecutiveUnhealthy,
            chainHead: headFactsForGate(at, UNKNOWN_SOCKET_HEAD),
          },
          policy,
        );
      }
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
