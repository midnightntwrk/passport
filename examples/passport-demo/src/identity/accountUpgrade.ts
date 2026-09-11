/**
 * Moving a Passport onto the account build that can pay in ONE transaction.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The account-custody contract gained a circuit on 2026/09/10 —
 * `transfer_shielded_to_account`, the one `docs/demo/one-tx-transfer-drill.md`
 * §3d settles on chain — and a circuit is part of a contract's deployed code.
 * There is no upgrade path for a deployed Compact contract and this project is
 * not inventing one: every Passport deployed from now on carries the circuit,
 * and every Passport deployed before it does not, for ever.
 *
 * RECEIVING IS UNAFFECTED. The peer is reached through a contract declaration
 * of the account's own `deposit_shielded`, whose verifier key is byte-identical
 * across both builds, so a pre-upgrade Passport can be PAID in one transaction
 * today. What it cannot do is SEND in one, because the circuit that would do
 * the sending is not in its code. That is why the check is on the sender's own
 * state and on nothing else (§4 of the drill), and it is why this migration
 * exists at all: without it, half the Passports at the demo would send in two
 * transactions and half in one, and the difference would be invisible until a
 * send took twice as long in front of an audience.
 *
 * THE SHAPE, ACCEPTED 2026/09/08
 * ------------------------------
 * Drain, deploy, re-point the name, refund. About four to six sponsored
 * transactions per Passport, once, and nothing the holder pays for. The new
 * account is deployed with the SAME device and recovery commitments as the old
 * one, derived from the same passkey by the same function, so the same
 * authenticator controls it and the holder is never asked to enrol anything.
 *
 * WHY IT IS A RESUMABLE STATE MACHINE RATHER THAN A FUNCTION
 * ----------------------------------------------------------
 * Four to six sponsored transactions is minutes on stagenet, on a phone, in a
 * browser tab that can be closed, backgrounded, or lose its socket. Two things
 * follow, and they are the whole design:
 *
 *   Every step CHECKS THE CHAIN BEFORE IT ACTS. Not "have we recorded this",
 *   but "is it already true on chain" — the account already empty, the new
 *   contract already served by the indexer, the name already resolving to it,
 *   the colour already back inside. A retry after a landed step therefore costs
 *   one read and nothing else, and can never spend a second sponsored fee doing
 *   what has been done.
 *
 *   Every step is WRITTEN DOWN THE MOMENT IT LANDS, and the deploy is written
 *   down the moment it is SUBMITTED. `./passportContractStore.ts`'s header
 *   records what the second half of that rule is worth: a deploy remembered
 *   nowhere is a deploy that happens twice.
 *
 * Every wait is bounded, the way `../lib/chainWait.ts` bounds the rest of this
 * app's waits, and a window that closes is reported as "we could not see it
 * land" rather than as a failure — the transaction is real either way, and the
 * next attempt reads the chain again.
 *
 * NOTHING HERE ADDS A CIRCUIT. The account contract is at its deployable
 * ceiling — thirteen circuits, of which the twelve now deployed must all stay
 * (drill §3b) — so a migration that needed a new circuit could not be deployed
 * at all. This one needs none: it uses `withdraw_night`, `withdraw_shielded`,
 * `deposit_night`, and `deposit_shielded`, all of which both builds carry.
 *
 * WHAT IS NOT PROVEN. This has not been run against a live pre-upgrade
 * Passport, because doing so needs a funded one and the passkey secret that
 * controls it, which only a real device holds. What is checked here is every
 * decision it makes — resume after each step, and skip what is already done —
 * against mocked providers in `./accountUpgrade.test.ts`.
 */

import type { LocalMidnightWallet } from '../lib/localWallet.js';
import { pollUntilTrue } from '../lib/chainWait.js';
import type { AccountState } from './accountCustody.js';
import type { MidnamesNetwork, ResolvedDomainTarget } from './midnames.js';
import {
  clearPassportUpgradeProgress,
  completePassportUpgrade,
  loadPassportUpgradeProgress,
  savePassportUpgradeProgress,
  type PassportUpgradeProgress,
} from './passportContractStore.js';

/**
 * NOTHING IS STATICALLY IMPORTED FROM `./contractRuntime.ts`, and that is not
 * an oversight.
 *
 * That module opens with `import * as ledger from '@midnightntwrk/ledger-v9'`,
 * a static import of the 9.84 MB ledger WASM. This module is reached from
 * `../App.tsx`'s detection, which runs on a Passport that has just signed in —
 * so a value import here would hold that behind the WASM, which is the exact
 * mistake `./midnamesText.ts` exists to avoid for the claim screen. Every
 * reach into the runtime below is therefore an `await import(...)` inside the
 * function that needs it, and the one pure helper this module wants from it is
 * restated here.
 *
 * `rawContractAddress`, restated: normalises a Midnight contract address to the
 * raw 64-hex form the indexer and the explorers both take, and throws rather
 * than guessing. Kept byte-for-byte identical to `contractRuntime`'s, which is
 * the single place the rule is decided; if that one changes, this follows.
 */
function rawContractAddress(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long each read-back is given before the attempt gives up and says so.
 *
 * Two minutes, from the same measurement `./passportContract.ts`'s
 * `RESUME_CONFIRM_WINDOW_MS` comes from: what is going to appear on the
 * stagenet indexer appears in about fourteen seconds, so a window this wide is
 * generous about a lagging indexer while still ending. What happens at the end
 * of it is not a verdict on the transaction — it is the point at which the
 * person is offered the retry rather than left watching a spinner.
 */
export const UPGRADE_CONFIRM_WINDOW_MS = 120_000;

/** How often a read-back asks again. */
export const UPGRADE_CONFIRM_INTERVAL_MS = 5_000;

/**
 * The shorter window for "is the new account already there", asked at the top
 * of the deploy step on a RESUME.
 *
 * Twenty seconds rather than two minutes, because this question is asked
 * before anything has been submitted in this attempt and its answer only
 * decides whether the step is skipped. A `false` here costs one deploy that
 * was going to happen anyway; two minutes of waiting to find that out costs the
 * reader two minutes.
 */
export const UPGRADE_RESUME_PROBE_MS = 20_000;

/** Ceiling on one `POST /repoint-alias` round trip. The service proves first. */
export const REPOINT_TIMEOUT_MS = 300_000;

/* -------------------------------------------------------------------------- */
/* What a caller sees                                                         */
/* -------------------------------------------------------------------------- */

/** The six steps, in the order they run. */
export type UpgradeStepId = 'detect' | 'drain' | 'deploy' | 'repoint' | 'refund' | 'switch';

export interface UpgradePhase {
  step: UpgradeStepId;
  /**
   * What is happening inside the step, in the machinery's own words. For a
   * log line and for a drill — NEVER for the screen, which says its own three
   * sentences and is not a transcript of this.
   */
  detail?: string;
}

export type UpgradeAccountOutcome =
  /** The old account already carries the circuit. Nothing was done. */
  | 'not-needed'
  /** The Passport is on the new account, with its name and its value. */
  | 'upgraded';

export interface UpgradeAccountResult {
  outcome: UpgradeAccountOutcome;
  /** The account the Passport was on when this started. */
  oldAddress: string;
  /** The account it is on now, or the old one when nothing was needed. */
  newAddress: string;
  /** The name that now resolves to {@link newAddress}, or null where none. */
  name: string | null;
}

export type AccountUpgradeErrorCode =
  /** The chain could not be asked which build the old account is. */
  | 'build-unknown'
  /** Value could not be moved out of the old account. */
  | 'drain-failed'
  /** The new account could not be deployed, or was never seen on chain. */
  | 'deploy-failed'
  /** The name could not be moved to the new account. */
  | 'repoint-failed'
  /** Value could not be moved back into the new account. */
  | 'refund-failed'
  /** The request itself could not be formed. */
  | 'invalid-request';

/**
 * An upgrade that stopped, carrying WHERE it stopped.
 *
 * The step is on the error rather than in the sentence because the resume is
 * driven by it: a caller catches this, shows the reader one line, and the next
 * attempt starts from the store — which already knows everything that landed
 * before the step named here.
 */
export class AccountUpgradeError extends Error {
  constructor(
    readonly code: AccountUpgradeErrorCode,
    readonly step: UpgradeStepId,
    message: string,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AccountUpgradeError';
  }
}

/** The two passkey-derived secrets one upgrade needs. */
export interface UpgradeSecrets {
  /**
   * The `PASSPORT_CONTRACT_SCOPE` seed — 32 bytes from ONE user-verified
   * WebAuthn assertion. Both the old account's device secret and the new
   * account's commitments come out of it, by the same derivation, which is
   * what makes the new account the same Passport.
   *
   * The caller owns these bytes and should zero them afterwards; nothing here
   * retains them beyond the call.
   */
  rootSecret: Uint8Array;
  /**
   * The `MIDNAMES_OWNER_SCOPE` seed, from the SAME assertion.
   *
   * Needed only to decide who owns the name's resolver and, where that is the
   * holder, to call `update_domain_target` as them. Absent, the re-point is
   * asked of the sponsor, which is right for a name whose resolver has not been
   * handed over yet and a refusal for one that has.
   */
  ownerSecret?: Uint8Array;
}

export interface UpgradeAccountRequest {
  /** The account to upgrade away from, raw 64-hex. */
  oldAddress: string;
  /**
   * The `.night` label this Passport holds, or null where it holds none.
   *
   * Null is a real state and not a missing argument: a Passport can be set up
   * and funded before its name is claimed, and one being upgraded then has
   * nothing to re-point. The step is skipped rather than failed.
   */
  name: string | null;
  /** The passkey credential the contract store is keyed on. */
  credentialId: string;
  /** Where `POST /repoint-alias` is asked. Null disables the sponsored path. */
  funderUrl?: string | null;
}

/* -------------------------------------------------------------------------- */
/* The seams                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every reach outside this module, in one object.
 *
 * It exists so the decisions above can be tested — resume after each step, skip
 * what is already done, act only on what the chain says — without a network, a
 * wallet, or the 9.84 MB ledger WASM that every real implementation below pulls
 * in behind a dynamic import. The defaults ARE the real thing; a test overrides
 * the two or three seams its case is about and leaves the rest.
 *
 * Each default is `await import(...)`ed at the moment it is called, so a module
 * that merely imports this file costs nothing.
 */
export interface UpgradeDeps {
  /** `null` when the chain could not be asked — see `accountHasOneTxTransfer`. */
  hasOneTxTransfer(indexerHttpUrl: string, address: string): Promise<boolean | null>;
  /** The contract's own balances, decoded. Throws when it cannot be read. */
  readAccountState(handle: LocalMidnightWallet, address: string): Promise<AccountState>;
  /** `withdraw_night` of the whole holding, to this wallet's own address. */
  withdrawNight(
    handle: LocalMidnightWallet,
    deviceSecret: Uint8Array,
    request: { contractAddress: string; colourHex: string; amount: bigint },
  ): Promise<void>;
  /** `withdraw_shielded` with `whole: true`, to this wallet's own address. */
  withdrawShielded(
    handle: LocalMidnightWallet,
    deviceSecret: Uint8Array,
    request: { contractAddress: string; colourHex: string; amount: bigint },
  ): Promise<void>;
  /** The device secret the old account was deployed with. */
  deriveDeviceSecret(rootSecret: Uint8Array): Promise<Uint8Array>;
  /** Deploys the new account, and hands the address back before the chain has. */
  submitAccount(
    handle: LocalMidnightWallet,
    rootSecret: Uint8Array,
  ): Promise<{
    address: string;
    identifier: string;
    deviceCommitment: string;
    settled: Promise<unknown>;
  }>;
  /** Is the indexer serving contract state at this address, within `windowMs`? */
  awaitOnLedger(indexerHttpUrl: string, address: string, windowMs: number): Promise<boolean>;
  /** What the name points at right now, or null when it is not registered. */
  resolveName(
    network: MidnamesNetwork,
    name: string,
  ): Promise<{ resolverAddress: string; target: ResolvedDomainTarget } | null>;
  /** The 32-byte `DOMAIN_OWNER[0]` a resolver leaf carries, or null. */
  readLeafOwnerKey(network: MidnamesNetwork, resolverAddress: string): Promise<Uint8Array | null>;
  /** This Passport's own Midnames owner key. */
  deriveOwnerKey(ownerSecret: Uint8Array): Promise<Uint8Array>;
  /** `update_domain_target` on the leaf, as the sponsor, over HTTP. */
  repointBySponsor(
    funderUrl: string,
    body: { name: string; newAccount: string; oldAccount: string; network: string },
  ): Promise<void>;
  /** `update_domain_target` on the leaf, as the holder, sponsored like any call. */
  repointByUser(
    handle: LocalMidnightWallet,
    ownerSecret: Uint8Array,
    resolverAddress: string,
    newAccount: string,
  ): Promise<void>;
  /** `deposit_night` from this wallet into the new account. */
  depositNight(
    handle: LocalMidnightWallet,
    request: { contractAddress: string; colourHex: string; amount: bigint },
  ): Promise<void>;
  /** `deposit_shielded` of a fresh coin worth `amount` into the new account. */
  depositShielded(
    handle: LocalMidnightWallet,
    request: { contractAddress: string; colourHex: string; amount: bigint },
  ): Promise<void>;
  /* Properties rather than method signatures, deliberately: both are read off
     the deps object and handed to `pollUntilTrue` UNBOUND, and a method
     signature is exactly the shape that makes doing so a mistake worth
     flagging. Neither has a `this` to lose. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function defaultDeps(): UpgradeDeps {
  return {
    async hasOneTxTransfer(indexerHttpUrl, address) {
      const { accountHasOneTxTransfer } = await import('./passportContract.js');
      return accountHasOneTxTransfer(indexerHttpUrl, address);
    },
    async readAccountState(handle, address) {
      const { readAccountState } = await import('./accountCustody.js');
      return readAccountState(handle.network, address);
    },
    async withdrawNight(handle, deviceSecret, request) {
      const { withdrawNight } = await import('./accountCustody.js');
      await withdrawNight(handle, deviceSecret, {
        contractAddress: request.contractAddress,
        colourHex: request.colourHex,
        amount: request.amount,
        /* This wallet's own address. The value is being parked, not paid: it
           goes back into the new account at the refund step. */
        recipientAddress: handle.unshieldedAddress,
      });
    },
    async withdrawShielded(handle, deviceSecret, request) {
      const { withdrawShielded } = await import('./accountCustody.js');
      await withdrawShielded(handle, deviceSecret, {
        contractAddress: request.contractAddress,
        colourHex: request.colourHex,
        amount: request.amount,
        recipientShieldedAddress: handle.shieldedAddress,
        /* THE ONLY SAFE BRANCH. `withdraw_shielded` asked for part of a coin
           splits and re-registers the remainder, and the node refuses every
           later withdrawal against what that leaves behind (`Custom error:
           239`, live 2026/09/03). A drain wants the whole thing anyway. */
        whole: true,
      });
    },
    async deriveDeviceSecret(rootSecret) {
      const { deriveAccountDeviceSecret } = await import('./accountCustody.js');
      return deriveAccountDeviceSecret(rootSecret);
    },
    async submitAccount(handle, rootSecret) {
      const { submitPassportContract } = await import('./passportContract.js');
      const submission = await submitPassportContract(handle, rootSecret);
      return {
        address: submission.address,
        identifier: submission.identifier,
        deviceCommitment: submission.deviceCommitment,
        settled: submission.settled,
      };
    },
    async awaitOnLedger(indexerHttpUrl, address, windowMs) {
      const { awaitPassportContractOnLedger } = await import('./passportContract.js');
      return awaitPassportContractOnLedger(indexerHttpUrl, address, {
        windowMs,
        intervalMs: UPGRADE_CONFIRM_INTERVAL_MS,
      });
    },
    async resolveName(network, name) {
      const { resolveAliasTarget } = await import('./midnames.js');
      return resolveAliasTarget(network, name);
    },
    async readLeafOwnerKey(network, resolverAddress) {
      return readLeafOwnerKey(network, resolverAddress);
    },
    async deriveOwnerKey(ownerSecret) {
      const { deriveMidnamesOwnerKey } = await import('./midnames.js');
      return deriveMidnamesOwnerKey(ownerSecret);
    },
    repointBySponsor,
    repointByUser,
    async depositNight(handle, request) {
      const { depositNight } = await import('./accountCustody.js');
      await depositNight(handle, {
        contractAddress: request.contractAddress,
        colourHex: request.colourHex,
        amount: request.amount,
      });
    },
    async depositShielded(handle, request) {
      const { depositShielded, shieldedCoinOfValue } = await import('./accountCustody.js');
      await depositShielded(handle, {
        contractAddress: request.contractAddress,
        /* A FRESH coin for exactly what is owed, not a note handed over
           intact. The wallet holds the drained value merged into whatever else
           it had; `receiveShielded` states a commitment the transaction must
           contain and the wallet's balancing funds it out of whatever notes it
           holds, returning the change to itself. */
        coin: shieldedCoinOfValue(request.colourHex, request.amount),
      });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

/* -------------------------------------------------------------------------- */
/* The machine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Moves this Passport onto an account that can send in one transaction, from
 * wherever the last attempt got to.
 *
 * Safe to call again after any failure and after any interruption, including
 * one that killed the tab in the middle of a proof. It is NOT safe to run twice
 * at once against the same Passport, for the reason every other spend path in
 * this app is not: two attempts would drain against each other's reads. The
 * caller holds that lock — `App.tsx` holds it the same way it holds the deploy
 * lock, with one in-flight flag.
 */
export async function upgradeAccount(
  handle: LocalMidnightWallet,
  secrets: UpgradeSecrets,
  request: UpgradeAccountRequest,
  onPhase?: (phase: UpgradePhase) => void,
  overrides: Partial<UpgradeDeps> = {},
): Promise<UpgradeAccountResult> {
  const deps: UpgradeDeps = { ...defaultDeps(), ...overrides };
  const network = handle.network.networkId;
  const indexer = handle.network.indexerHttpUrl;
  const credentialId = request.credentialId;
  let oldAddress: string;
  try {
    oldAddress = rawContractAddress(request.oldAddress);
  } catch (cause) {
    throw new AccountUpgradeError(
      'invalid-request',
      'detect',
      'That is not a Passport account address.',
      messageOf(cause),
      { cause },
    );
  }
  const name = request.name && request.name.trim() ? request.name.trim() : null;

  /* ---- (a) DETECT ------------------------------------------------------- */

  onPhase?.({ step: 'detect', detail: 'reading which build the account is' });
  const already = await deps.hasOneTxTransfer(indexer, oldAddress);
  if (already === null) {
    throw new AccountUpgradeError(
      'build-unknown',
      'detect',
      'Your Passport could not be checked just now. Try again in a moment.',
      `the operations of ${oldAddress} could not be read`,
    );
  }
  if (already) {
    /* Nothing to do, and any block left over from an abandoned attempt is now
       about a question that has been answered. */
    clearPassportUpgradeProgress(credentialId, network);
    return { outcome: 'not-needed', oldAddress, newAddress: oldAddress, name };
  }

  let progress = beginProgress(credentialId, network, oldAddress, name);

  /* The device secret authorises the drain and nothing else. It is derived
     once, zeroed on the way out, and never written anywhere. */
  const deviceSecret = await deps.deriveDeviceSecret(secrets.rootSecret);
  try {
    /* ---- (b) DRAIN ------------------------------------------------------ */

    if (progress.drained !== true) {
      progress = await drain(handle, deviceSecret, {
        deps,
        credentialId,
        network,
        oldAddress,
        progress,
        onPhase,
      });
    }

    /* ---- (c) DEPLOY ----------------------------------------------------- */

    if (progress.deployed !== true) {
      progress = await deploy(handle, secrets.rootSecret, {
        deps,
        credentialId,
        network,
        indexer,
        progress,
        onPhase,
      });
    }
    const newAddress = progress.toAddress;
    if (!newAddress) {
      /* Unreachable while `deploy` keeps its own contract, and stated anyway:
         everything below spends against this address. */
      throw new AccountUpgradeError(
        'deploy-failed',
        'deploy',
        'Your new Passport account could not be set up.',
        'the deploy step reported success without an address',
      );
    }

    /* ---- (d) RE-POINT --------------------------------------------------- */

    if (name && progress.repointed !== true) {
      progress = await repoint(handle, secrets, {
        deps,
        credentialId,
        network,
        name,
        oldAddress,
        newAddress,
        funderUrl: request.funderUrl ?? null,
        progress,
        onPhase,
      });
    }

    /* ---- (e) REFUND ----------------------------------------------------- */

    if (progress.refunded !== true) {
      progress = await refund(handle, {
        deps,
        credentialId,
        network,
        newAddress,
        progress,
        onPhase,
      });
    }

    /* ---- (f) SWITCH ----------------------------------------------------- */

    onPhase?.({ step: 'switch', detail: 'recording the new account' });
    completePassportUpgrade(credentialId, network);
    return { outcome: 'upgraded', oldAddress, newAddress, name };
  } finally {
    deviceSecret.fill(0);
  }
}

/**
 * The upgrade block for this attempt — the one already in the store when the
 * last attempt was interrupted, or a fresh one.
 *
 * A block for a DIFFERENT old account is replaced rather than resumed. That can
 * only happen where a Passport was restored or recovered onto another account
 * between attempts, and resuming it would be resuming somebody else's
 * migration: the drained figures, the new address, and the name would all be
 * about a contract this attempt is not touching.
 */
function beginProgress(
  credentialId: string,
  network: string,
  oldAddress: string,
  name: string | null,
): PassportUpgradeProgress {
  const existing = loadPassportUpgradeProgress(credentialId, network);
  if (existing && existing.fromAddress === oldAddress) {
    return savePassportUpgradeProgress(credentialId, network, {
      fromAddress: oldAddress,
      /* The name can arrive later than the upgrade — a Passport being upgraded
         before its name is claimed — so a name in hand always wins over an
         empty one recorded earlier. It never overwrites a DIFFERENT name with
         nothing. */
      name: name ?? existing.name,
      startedAt: existing.startedAt,
      /* This attempt has not failed yet, whatever the last one did. */
      failureReason: undefined,
    });
  }
  return savePassportUpgradeProgress(credentialId, network, {
    fromAddress: oldAddress,
    name: name ?? '',
    startedAt: new Date().toISOString(),
  });
}

/** Records why an attempt stopped, then throws it. Never swallows. */
function stop(
  credentialId: string,
  network: string,
  progress: PassportUpgradeProgress,
  error: AccountUpgradeError,
): never {
  try {
    savePassportUpgradeProgress(credentialId, network, {
      fromAddress: progress.fromAddress,
      name: progress.name,
      startedAt: progress.startedAt,
      failureReason: error.message,
    });
  } catch {
    /* The store is a convenience here and the error is the point. A browser
       that refused the write still gets the throw below. */
  }
  throw error;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* -------------------------------------------------------------------------- */
/* (b) Drain                                                                  */
/* -------------------------------------------------------------------------- */

interface StepContext {
  deps: UpgradeDeps;
  credentialId: string;
  network: string;
  progress: PassportUpgradeProgress;
  onPhase?: (phase: UpgradePhase) => void;
}

/**
 * Empties the old account into this Passport's own wallet, colour by colour.
 *
 * WHAT IT CHECKS BEFORE IT ACTS. The account's own ledger, read fresh. A colour
 * that reads zero is skipped — which is what makes a resume after a landed
 * withdrawal free — and each withdrawal is followed by a bounded read-back that
 * waits for that colour to reach zero before the next one starts. Serial rather
 * than parallel, deliberately: `withdraw_shielded` takes the whole coin the
 * account holds of a colour and reads the figure at build time, and two
 * withdrawals in flight against one account's `round` counter is a replay the
 * contract refuses.
 *
 * WHAT IT WRITES DOWN. The holdings as they were BEFORE any of this, on the
 * first attempt only. They are what the refund pays back, and they cannot be
 * recovered afterwards: once the account is empty its ledger says nothing about
 * what it held, and the wallet's balance is this value mixed with whatever else
 * the wallet had.
 */
async function drain(
  handle: LocalMidnightWallet,
  deviceSecret: Uint8Array,
  ctx: StepContext & { oldAddress: string },
): Promise<PassportUpgradeProgress> {
  const { deps, credentialId, network, oldAddress, onPhase } = ctx;
  let progress = ctx.progress;

  onPhase?.({ step: 'drain', detail: 'reading what the account holds' });
  let state: AccountState;
  try {
    state = await deps.readAccountState(handle, oldAddress);
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'drain-failed',
        'drain',
        'Your Passport’s balances could not be read just now. Try again in a moment.',
        messageOf(cause),
        { cause },
      ),
    );
  }

  /* Recorded ONCE, on the first attempt, from the state before anything moved.
     A resume that recorded them again would record what is left rather than
     what there was, and the refund would pay back the remainder of a drain
     instead of the whole of it. */
  if (!progress.drainedNight || !progress.drainedShielded) {
    progress = savePassportUpgradeProgress(credentialId, network, {
      fromAddress: progress.fromAddress,
      name: progress.name,
      startedAt: progress.startedAt,
      drainedNight: positiveEntries(state.nightBalances),
      drainedShielded: positiveEntries(state.shieldedCoins),
    });
  }

  for (const [colourHex, amount] of positiveEntries(state.nightBalances)) {
    onPhase?.({ step: 'drain', detail: `withdraw_night ${amount} of ${colourHex.slice(0, 8)}…` });
    await moveOut(
      () =>
        deps.withdrawNight(handle, deviceSecret, {
          contractAddress: oldAddress,
          colourHex,
          amount: BigInt(amount),
        }),
      () => readBalance(deps, handle, oldAddress, colourHex, 'night'),
      deps,
      () => {
        throw new AccountUpgradeError(
          'drain-failed',
          'drain',
          'Some of your Passport’s balance could not be moved. Try again in a moment.',
          `${colourHex} still shows on ${oldAddress} after the withdrawal`,
        );
      },
    ).catch((cause: unknown) => stop(credentialId, network, progress, asUpgradeError(cause, 'drain-failed', 'drain', 'Some of your Passport’s balance could not be moved. Try again in a moment.')));
  }

  for (const [colourHex, amount] of positiveEntries(state.shieldedCoins)) {
    onPhase?.({
      step: 'drain',
      detail: `withdraw_shielded whole ${amount} of ${colourHex.slice(0, 8)}…`,
    });
    await moveOut(
      () =>
        deps.withdrawShielded(handle, deviceSecret, {
          contractAddress: oldAddress,
          colourHex,
          amount: BigInt(amount),
        }),
      () => readBalance(deps, handle, oldAddress, colourHex, 'shielded'),
      deps,
      () => {
        throw new AccountUpgradeError(
          'drain-failed',
          'drain',
          'Some of your Passport’s balance could not be moved. Try again in a moment.',
          `${colourHex} still shows on ${oldAddress} after the withdrawal`,
        );
      },
    ).catch((cause: unknown) => stop(credentialId, network, progress, asUpgradeError(cause, 'drain-failed', 'drain', 'Some of your Passport’s balance could not be moved. Try again in a moment.')));
  }

  /* THE STEP IS DONE WHEN THE CHAIN SAYS SO, not when the loops end. A fresh
     read, and every colour at zero — anything else and the next attempt runs
     the loops again against whatever is left. */
  let empty = false;
  try {
    const after = await deps.readAccountState(handle, oldAddress);
    empty =
      positiveEntries(after.nightBalances).length === 0 &&
      positiveEntries(after.shieldedCoins).length === 0;
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'drain-failed',
        'drain',
        'Your Passport’s balances could not be read just now. Try again in a moment.',
        messageOf(cause),
        { cause },
      ),
    );
  }
  if (!empty) {
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'drain-failed',
        'drain',
        'Some of your Passport’s balance has not moved yet. Try again in a moment.',
        `${oldAddress} still reports a holding after the drain`,
      ),
    );
  }

  return savePassportUpgradeProgress(credentialId, network, {
    fromAddress: progress.fromAddress,
    name: progress.name,
    startedAt: progress.startedAt,
    drained: true,
  });
}

/**
 * One withdrawal, then a bounded wait for the account to agree it is gone.
 *
 * The wait is the reason this is a function rather than two lines: a withdrawal
 * that has been submitted is not a withdrawal the next `readAccountState` can
 * see — the stagenet indexer runs about fourteen seconds behind the node — and
 * a drain that moved on without waiting would read a stale balance and withdraw
 * against a coin that is no longer there.
 */
async function moveOut(
  submit: () => Promise<void>,
  remaining: () => Promise<bigint>,
  deps: UpgradeDeps,
  onStillThere: () => never,
): Promise<void> {
  await submit();
  const gone = await pollUntilTrue(async () => (await remaining()) === 0n, {
    windowMs: UPGRADE_CONFIRM_WINDOW_MS,
    intervalMs: UPGRADE_CONFIRM_INTERVAL_MS,
    now: deps.now,
    sleep: deps.sleep,
  });
  if (!gone) onStillThere();
}

async function readBalance(
  deps: UpgradeDeps,
  handle: LocalMidnightWallet,
  address: string,
  colourHex: string,
  kind: 'night' | 'shielded',
): Promise<bigint> {
  const state = await deps.readAccountState(handle, address);
  const map = kind === 'night' ? state.nightBalances : state.shieldedCoins;
  return map.get(colourHex) ?? 0n;
}

/** Colour → amount, as decimal strings, for the colours with anything in them. */
function positiveEntries(balances: Map<string, bigint>): [string, string][] {
  const entries: [string, string][] = [];
  for (const [colour, amount] of balances) {
    if (amount > 0n) entries.push([colour, amount.toString()]);
  }
  /* Sorted, so two attempts drain and refund in the same order and a reader
     comparing two runs is comparing the same thing. */
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries;
}

/* -------------------------------------------------------------------------- */
/* (c) Deploy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deploys the new account, with the SAME commitments as the old one.
 *
 * Nothing about the sameness is arranged here, and that is the point:
 * `submitPassportContract` derives the device and recovery commitments from the
 * passkey root secret by the one derivation this project has, so the new
 * contract's constructor burns in the same two Field values the old one
 * carries. The three recovery SLOTS are fresh random values, as they are on
 * every deploy since 2026/09/01 — they reconstruct nothing, whichever two are
 * combined, so there is nothing about them to preserve.
 *
 * WHAT IT CHECKS BEFORE IT ACTS. Whether the address this upgrade already
 * recorded is being served by the indexer. It is asked on a short window,
 * because it only decides whether a deploy is skipped.
 *
 * WHAT IT WRITES DOWN, AND WHEN. The address, the moment the transaction is
 * SUBMITTED and before the chain has said anything — the address is the hash of
 * the initial contract state, so it is known before proving. `./
 * passportContractStore.ts`'s header records what an unwritten submission cost
 * the last time: a second contract on a second sponsored fee.
 */
async function deploy(
  handle: LocalMidnightWallet,
  rootSecret: Uint8Array,
  ctx: StepContext & { indexer: string },
): Promise<PassportUpgradeProgress> {
  const { deps, credentialId, network, indexer, onPhase } = ctx;
  let progress = ctx.progress;

  if (progress.toAddress) {
    onPhase?.({ step: 'deploy', detail: `probing ${progress.toAddress} on chain` });
    if (await deps.awaitOnLedger(indexer, progress.toAddress, UPGRADE_RESUME_PROBE_MS)) {
      return savePassportUpgradeProgress(credentialId, network, {
        fromAddress: progress.fromAddress,
        name: progress.name,
        startedAt: progress.startedAt,
        deployed: true,
      });
    }
  }

  onPhase?.({ step: 'deploy', detail: 'submitting the new account' });
  let submitted: Awaited<ReturnType<UpgradeDeps['submitAccount']>>;
  try {
    submitted = await deps.submitAccount(handle, rootSecret);
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      asUpgradeError(
        cause,
        'deploy-failed',
        'deploy',
        'Your new Passport account could not be set up. Try again in a moment.',
      ),
    );
  }

  /* WRITTEN BEFORE THE WAIT, not after it. */
  progress = savePassportUpgradeProgress(credentialId, network, {
    fromAddress: progress.fromAddress,
    name: progress.name,
    startedAt: progress.startedAt,
    toAddress: submitted.address,
    toDeployTxId: submitted.identifier,
    toDeviceCommitment: submitted.deviceCommitment,
  });

  onPhase?.({ step: 'deploy', detail: 'waiting for the new account to appear' });
  try {
    /* Rejects only where the transaction landed in a state other than
       `SucceedEntirely` — the account genuinely does not exist. A watch that
       merely said nothing resolves with `ledgerConfirmed: false`, and the
       read-back below is what decides. */
    await submitted.settled;
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      asUpgradeError(
        cause,
        'deploy-failed',
        'deploy',
        'Your new Passport account could not be set up. Try again in a moment.',
      ),
    );
  }

  if (!(await deps.awaitOnLedger(indexer, submitted.address, UPGRADE_CONFIRM_WINDOW_MS))) {
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'deploy-failed',
        'deploy',
        'Your new Passport account has not appeared yet. Try again in a moment.',
        `no contract state served at ${submitted.address} inside ${UPGRADE_CONFIRM_WINDOW_MS} ms`,
      ),
    );
  }

  return savePassportUpgradeProgress(credentialId, network, {
    fromAddress: progress.fromAddress,
    name: progress.name,
    startedAt: progress.startedAt,
    deployed: true,
  });
}

/* -------------------------------------------------------------------------- */
/* (d) Re-point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Moves the name onto the new account.
 *
 * TWO OWNERS, AND BOTH ARE NORMAL. A sponsored registration deploys the
 * resolver leaf under the SPONSOR's key, points it at the account, registers
 * the name for the user, and hands the leaf over with `change_owner` afterwards
 * — as its own queued job, behind everything, not awaited. So a Passport
 * claimed minutes ago is very likely still on a sponsor-owned leaf and one
 * claimed yesterday is very likely on its own, and neither is a fault.
 * `update_domain_target` asserts `derive_public_key(secret) == DOMAIN_OWNER[0]`
 * and nothing else, so the whole question is which secret can satisfy it.
 *
 * The leaf is asked, rather than guessed at: its `DOMAIN_OWNER[0]` is compared
 * with this Passport's own owner key. Matching, the holder calls the circuit —
 * sponsored like every other call this app makes. Not matching, the sponsor is
 * asked over `POST /repoint-alias`, which proves control by reading both
 * accounts and requiring the new one to carry the old one's device commitment.
 *
 * WHAT IT CHECKS BEFORE IT ACTS. What the name resolves to. Already the new
 * account and the step is over, which is what makes a resume after a landed
 * re-point free.
 */
async function repoint(
  handle: LocalMidnightWallet,
  secrets: UpgradeSecrets,
  ctx: StepContext & {
    name: string;
    oldAddress: string;
    newAddress: string;
    funderUrl: string | null;
  },
): Promise<PassportUpgradeProgress> {
  const { deps, credentialId, network, name, oldAddress, newAddress, funderUrl, onPhase } = ctx;
  const progress = ctx.progress;
  const midnamesNetwork = network as MidnamesNetwork;

  const pointsAtNew = async (): Promise<boolean> => {
    const resolved = await deps.resolveName(midnamesNetwork, name);
    return (
      resolved !== null &&
      resolved.target.kind === 'contract' &&
      rawContractAddress(resolved.target.hex) === newAddress
    );
  };

  onPhase?.({ step: 'repoint', detail: `reading what ${name} points at` });
  let resolved: Awaited<ReturnType<UpgradeDeps['resolveName']>>;
  try {
    resolved = await deps.resolveName(midnamesNetwork, name);
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      asUpgradeError(
        cause,
        'repoint-failed',
        'repoint',
        'Your name could not be checked just now. Try again in a moment.',
      ),
    );
  }
  if (resolved === null) {
    /* The name is not registered at all. Nothing to move, and nothing this
       migration can do about it — a claim is its own flow, with its own gates
       and its own sponsored budget. */
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'repoint-failed',
        'repoint',
        'Your name is not registered on this network, so it could not be moved.',
        `${name} resolves to nothing on ${network}`,
      ),
    );
  }
  if (
    resolved.target.kind === 'contract' &&
    rawContractAddress(resolved.target.hex) === newAddress
  ) {
    return savePassportUpgradeProgress(credentialId, network, {
      fromAddress: progress.fromAddress,
      name: progress.name,
      startedAt: progress.startedAt,
      repointed: true,
    });
  }

  const resolverAddress = resolved.resolverAddress;
  let ownedByHolder = false;
  if (secrets.ownerSecret) {
    try {
      const [leafOwner, ours] = await Promise.all([
        deps.readLeafOwnerKey(midnamesNetwork, resolverAddress),
        deps.deriveOwnerKey(secrets.ownerSecret),
      ]);
      ownedByHolder = leafOwner !== null && sameBytes(leafOwner, ours);
    } catch {
      /* Could not tell. The sponsored path below is the safe default: it
         refuses politely where the leaf is the holder's, and nothing has been
         spent to find that out. */
      ownedByHolder = false;
    }
  }

  onPhase?.({
    step: 'repoint',
    detail: ownedByHolder ? 'update_domain_target as the holder' : 'asking the service to re-point',
  });
  try {
    if (ownedByHolder) {
      await deps.repointByUser(handle, secrets.ownerSecret!, resolverAddress, newAddress);
    } else {
      if (!funderUrl) {
        throw new Error(
          'this name’s resolver belongs to the service and no service is configured',
        );
      }
      await deps.repointBySponsor(funderUrl, {
        name,
        newAccount: newAddress,
        oldAccount: oldAddress,
        network,
      });
    }
  } catch (cause) {
    return stop(
      credentialId,
      network,
      progress,
      asUpgradeError(
        cause,
        'repoint-failed',
        'repoint',
        'Your name could not be moved to your new Passport. Try again in a moment.',
      ),
    );
  }

  onPhase?.({ step: 'repoint', detail: `waiting for ${name} to point at the new account` });
  const moved = await pollUntilTrue(pointsAtNew, {
    windowMs: UPGRADE_CONFIRM_WINDOW_MS,
    intervalMs: UPGRADE_CONFIRM_INTERVAL_MS,
    now: deps.now,
    sleep: deps.sleep,
  });
  if (!moved) {
    return stop(
      credentialId,
      network,
      progress,
      new AccountUpgradeError(
        'repoint-failed',
        'repoint',
        'Your name has not moved to your new Passport yet. Try again in a moment.',
        `${name} does not resolve to ${newAddress} inside ${UPGRADE_CONFIRM_WINDOW_MS} ms`,
      ),
    );
  }

  return savePassportUpgradeProgress(credentialId, network, {
    fromAddress: progress.fromAddress,
    name: progress.name,
    startedAt: progress.startedAt,
    repointed: true,
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* (e) Refund                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Puts back into the new account exactly what came out of the old one.
 *
 * WHAT IT CHECKS BEFORE IT ACTS. The NEW account's own holding of each colour,
 * against the figure the drain wrote down. Already there and the colour is
 * skipped, which is what makes a resume after a landed deposit free — and it is
 * a stronger check than the store's own list, because a deposit that landed
 * while the tab was closing is invisible to the list and plain in the ledger.
 *
 * Serial, and for the same reason the drain is: `deposit_shielded` merges into
 * whatever the contract already holds of that colour, and two deposits in
 * flight against one account are a race the node settles by refusing one.
 */
async function refund(
  handle: LocalMidnightWallet,
  ctx: StepContext & { newAddress: string },
): Promise<PassportUpgradeProgress> {
  const { deps, credentialId, network, newAddress, onPhase } = ctx;
  let progress = ctx.progress;

  const legs: {
    kind: 'night' | 'shielded';
    entries: [string, string][];
    done: string[];
  }[] = [
    {
      kind: 'night',
      entries: progress.drainedNight ?? [],
      done: [...(progress.refundedNight ?? [])],
    },
    {
      kind: 'shielded',
      entries: progress.drainedShielded ?? [],
      done: [...(progress.refundedShielded ?? [])],
    },
  ];

  for (const leg of legs) {
    for (const [colourHex, amountText] of leg.entries) {
      if (leg.done.includes(colourHex)) continue;
      const owed = BigInt(amountText);
      onPhase?.({
        step: 'refund',
        detail: `deposit_${leg.kind === 'night' ? 'night' : 'shielded'} ${owed} of ${colourHex.slice(0, 8)}…`,
      });

      let held: bigint;
      try {
        held = await readBalance(deps, handle, newAddress, colourHex, leg.kind);
      } catch (cause) {
        return stop(
          credentialId,
          network,
          progress,
          asUpgradeError(
            cause,
            'refund-failed',
            'refund',
            'Your new Passport’s balances could not be read just now. Try again in a moment.',
          ),
        );
      }

      if (held < owed) {
        /* THE DIFFERENCE, not the whole figure. A deposit that landed and was
           not recorded — the tab closed between the two — leaves the account
           holding part of what it is owed, and paying the full amount again
           would double it. */
        const outstanding = owed - held;
        try {
          if (leg.kind === 'night') {
            await deps.depositNight(handle, {
              contractAddress: newAddress,
              colourHex,
              amount: outstanding,
            });
          } else {
            await deps.depositShielded(handle, {
              contractAddress: newAddress,
              colourHex,
              amount: outstanding,
            });
          }
        } catch (cause) {
          return stop(
            credentialId,
            network,
            progress,
            asUpgradeError(
              cause,
              'refund-failed',
              'refund',
              'Your balance could not be moved into your new Passport. Try again in a moment.',
            ),
          );
        }

        const back = await pollUntilTrue(
          async () => (await readBalance(deps, handle, newAddress, colourHex, leg.kind)) >= owed,
          {
            windowMs: UPGRADE_CONFIRM_WINDOW_MS,
            intervalMs: UPGRADE_CONFIRM_INTERVAL_MS,
            now: deps.now,
            sleep: deps.sleep,
          },
        );
        if (!back) {
          return stop(
            credentialId,
            network,
            progress,
            new AccountUpgradeError(
              'refund-failed',
              'refund',
              'Your balance has not arrived in your new Passport yet. Try again in a moment.',
              `${newAddress} holds less than ${owed} of ${colourHex}`,
            ),
          );
        }
      }

      leg.done.push(colourHex);
      progress = savePassportUpgradeProgress(credentialId, network, {
        fromAddress: progress.fromAddress,
        name: progress.name,
        startedAt: progress.startedAt,
        ...(leg.kind === 'night'
          ? { refundedNight: [...leg.done] }
          : { refundedShielded: [...leg.done] }),
      });
    }
  }

  return savePassportUpgradeProgress(credentialId, network, {
    fromAddress: progress.fromAddress,
    name: progress.name,
    startedAt: progress.startedAt,
    refunded: true,
  });
}

/* -------------------------------------------------------------------------- */
/* The two re-point transports                                                */
/* -------------------------------------------------------------------------- */

/**
 * Asks the service to point the name's resolver at the new account.
 *
 * The proof of control is the pair of ADDRESSES and what the chain says about
 * them: the service reads both accounts and requires the new one to hold the
 * old one's device commitment as an active device. Only the passkey that
 * controls the old account can produce a contract that does, because the
 * commitment is `derive_device_commitment(device_secret)` and the secret never
 * leaves the device. That is the same kind of gate `/register-alias` and
 * `/fund-account` already use — a real read of real ledger state rather than a
 * bearer token — and it needs nothing this client cannot honestly send.
 */
async function repointBySponsor(
  funderUrl: string,
  body: { name: string; newAccount: string; oldAccount: string; network: string },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPOINT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${funderUrl}/repoint-alias`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new Error(`the service could not be reached: ${messageOf(cause)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let refusal: { error?: unknown; message?: unknown } = {};
    try {
      refusal = (await response.json()) as typeof refusal;
    } catch {
      // A non-JSON body from the service is a refusal, not a crash.
    }
    throw new Error(
      typeof refusal.message === 'string'
        ? refusal.message
        : `the service refused with status ${response.status}`,
    );
  }
}

/**
 * Points the name's resolver at the new account with the HOLDER's own key.
 *
 * The leaf is a Midnames contract, so this is the midnames build's
 * `update_domain_target` under the `secretKey` witness — the same circuit and
 * the same witness the service calls it with, differing only in which secret
 * satisfies `assert_is_owner`. The fee is the sponsor's, as it is for every
 * other circuit this app calls; the holder pays for nothing.
 */
async function repointByUser(
  handle: LocalMidnightWallet,
  ownerSecret: Uint8Array,
  resolverAddress: string,
  newAccount: string,
): Promise<void> {
  const [{ createContractProviders, compiledContractFor, contractAddressBytes, bytesToHex }, { findDeployedContract }] =
    await Promise.all([
      import('./contractRuntime.js'),
      import('@midnight-ntwrk/midnight-js-contracts'),
    ]);
  const address = rawContractAddress(resolverAddress);
  const nonce = new Uint8Array(8);
  globalThis.crypto.getRandomValues(nonce);
  /* Fresh per call, for the reason `accountCustody.connectAccountContract`
     gives: the secret this call was handed must win over anything a previous
     connection left behind. */
  const privateStateId = `passport-midnames-${address.slice(0, 8)}-${bytesToHex(nonce)}`;
  const initialPrivateState = { secretKey: bytesToHex(ownerSecret) };

  const [providers, compiledContract] = await Promise.all([
    createContractProviders(handle, {
      contract: 'midnames',
      privateStateId,
      initialPrivateState,
    }),
    compiledContractFor('midnames', 'passport-midnames-leaf', {
      secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
        privateState,
        hexBytes(privateState.secretKey),
      ],
    }),
  ]);

  const leaf = await findDeployedContract(providers as never, {
    compiledContract,
    contractAddress: address,
    privateStateId,
    initialPrivateState,
  } as never);
  const callTx = (leaf as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
    .callTx;
  /* `Either<ContractAddress, Either<ZswapCoinPublicKey, UserAddress>>` with the
     CONTRACT branch selected, the two unselected branches zero-filled — the
     same convention the leaf's constructor produces and `decodeDomainTarget`
     reads back. */
  const zero = (): { bytes: Uint8Array } => ({ bytes: new Uint8Array(32) });
  await callTx.update_domain_target({
    is_left: true,
    left: { bytes: contractAddressBytes(rawContractAddress(newAccount)) },
    right: { is_left: true, left: zero(), right: zero() },
  });
}

/** Hex to bytes, without importing the account module's copy. */
function hexBytes(value: string): Uint8Array {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The 32-byte owner key a resolver leaf carries, or null when it cannot be
 * read.
 *
 * `DOMAIN_OWNER` is `[Bytes<32>, UserAddress]` and only the first half is the
 * registry's authority — `assert_is_owner` compares
 * `derive_public_key(secretKey())` against it and looks at nothing else. The
 * second half is where a payment made TO the leaf would go, and is zero on
 * every leaf this project's service deploys.
 */
async function readLeafOwnerKey(
  network: MidnamesNetwork,
  resolverAddress: string,
): Promise<Uint8Array | null> {
  try {
    const [{ MIDNAMES_INDEXER_URLS }, { loadContractModule, sharedPublicDataProvider, indexerWsFrom }] =
      await Promise.all([import('./midnames.js'), import('./contractRuntime.js')]);
    const httpUrl = MIDNAMES_INDEXER_URLS[network];
    const provider = (await sharedPublicDataProvider(httpUrl, indexerWsFrom(httpUrl))) as {
      queryContractState(address: string): Promise<unknown>;
    };
    const state = await provider.queryContractState(rawContractAddress(resolverAddress));
    if (!state) return null;
    const module = (await loadContractModule('midnames')) as unknown as {
      ledger(data: unknown): { DOMAIN_OWNER: [Uint8Array, { bytes: Uint8Array }] };
    };
    const leaf = module.ledger((state as { data: unknown }).data);
    const owner = leaf.DOMAIN_OWNER?.[0];
    return owner instanceof Uint8Array ? owner : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Keeps an upgrade error as it is; wraps anything else, cause and all. */
function asUpgradeError(
  cause: unknown,
  code: AccountUpgradeErrorCode,
  step: UpgradeStepId,
  message: string,
): AccountUpgradeError {
  if (cause instanceof AccountUpgradeError) return cause;
  return new AccountUpgradeError(code, step, message, messageOf(cause), { cause });
}
