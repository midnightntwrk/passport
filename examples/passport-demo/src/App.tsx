import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportEnrolmentConflictError,
  PassportPasskeyDiscoveryError,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from './backend.js';
import type {
  DiscoveredPassportPasskey,
  PassportAccountBlob,
  PassportAccountBlobWriteOutcome,
} from './backend.js';
import {
  accountFromBlob,
  accountRecheckDelayMs,
  accountToRemember,
  aliasFromRecoveredAccount,
  pendingAccountBlob,
  settledAccountOnPasskey,
  type AccountFromBlobAccount,
} from './lib/accountOnPasskey.js';
import { compactAddress } from './lib/address.js';
import { holdCriticalWork } from './lib/appBusy.js';
import { normalisedColourHex, shortColour } from './lib/colour.js';
import {
  isMidSessionWayOut,
  KEYLESS_PASSKEY_MESSAGE,
  markMidSessionWayOut,
  midSessionPasskeyMessage,
  PASSKEY_CEREMONY_TIMEOUT_MESSAGE,
  passkeySignInRecovery,
} from './lib/passkeyRecovery.js';
import {
  ACTIVATION_EXHAUSTED_LABEL,
  activationRetryRowId,
  classifyFundAccountAnswer,
} from './lib/activation.js';
import type { FundAccountAnswer } from './lib/activation.js';
import {
  ACTIVITY_KEEP,
  activityStorageKey,
  readStoredActivity,
  serialiseActivity,
} from './lib/activityFeed.js';
import type { ActivityFeedItem } from './screens/ActivityFeed.js';
import type { NameLookup } from './lib/recipientName.js';
/* The two-leg send's record and its retry rules. Pure — no React, no fetch, no
   storage — see `lib/sendLegs.ts`, where every branch is drilled. */
import {
  classifyLegError,
  pendingSendsStorageKey,
  readPendingSends,
  retryDelayMs,
  SEND_LEG_ATTEMPTS,
  serialisePendingSends,
  watchForSettlement,
  type PendingSend,
  type PendingSendKind,
} from './lib/sendLegs.js';
/* The note a shielded transfer's two legs are joined by. Type-only, so the rule
   itself is still loaded beside the account module at the moment of the send. */
import type { WalletShieldedNote } from './lib/shieldedNote.js';
import { requestPassportStoragePersistence } from './pwa.js';
import {
  listLocalProfiles,
  loadLocalProfileByCredential,
  localCredentialAccountId,
  localProfileId,
  migrateLegacyLocalProfile,
  saveDemoProfile,
  type DemoPassportProfile,
} from './publicProfile.js';
import { PassportProfileConsent } from './profileConsent.js';
/* The URL-callback flow. `callbackLaunch.js` reads the launch parameters at
   MODULE IMPORT time — before the first render, so the request is recorded
   before onboarding decides what to show — and keeps them alive across the
   reloads and redirects onboarding performs. */
import { passportCallbackLaunch } from './identity/callbackLaunch.js';
import { PassportCallbackConsent } from './screens/callbackConsent.js';
import { PassportTxConsent } from './txConsent.js';
import OnboardingScreen from './screens/Onboarding.js';
import WelcomeScreen from './screens/Welcome.js';
import AccountRecoveryScreen from './screens/AccountRecovery.js';
import HomeScreen from './screens/Home.js';
import AliasClaimScreen from './screens/AliasClaim.js';
import BackupScreen from './screens/Backup.js';
import EcosystemScreen from './screens/Ecosystem.js';
import AliasReclaimModal from './screens/AliasReclaimModal.js';
import {
  loadAliasRecord,
  loadAliasRecords,
  removeAliasRecord,
  saveAliasRecord,
  subscribeAliasRecords,
  type AliasRecord,
} from './identity/aliasStore.js';
import {
  loadIncentives,
  saveIncentive,
  subscribeIncentives,
  type PassportIncentiveRecord,
} from './identity/incentiveStore.js';
import type {
  AliasAvailability,
  AliasClaimProgress,
  AliasClaimResult,
  MidnamesNetwork,
} from './identity/midnames.js';
import { createClaimWarmup } from './identity/claimWarmup.js';
import {
  loadPassportContractRecord,
  loadPassportContractRecords,
  passportContractRecordKey,
  savePassportContractRecord,
  subscribePassportContractRecords,
  type PassportContractRecord,
} from './identity/passportContractStore.js';
import type {
  PassportContractDeployment,
  PassportContractProgress,
  PassportContractSubmission,
} from './identity/passportContract.js';
/* The account-custody contract's own progress vocabulary. Type-only, so the
   module — and the ledger it statically imports — stays behind the dynamic
   imports every call site below uses. */
import type { AccountCustodyProgress, PreparedAccountCall } from './identity/accountCustody.js';
import type { PassportBackupLedgerCheck } from './identity/backup.js';
import {
  NETWORK_LABELS,
  loadStoredNetwork,
  storeNetwork,
  type PassportNetwork,
} from './screens/NetworkSwitcher.js';
import AppsScreen from './screens/Apps.js';
import AssetsScreen from './screens/Assets.js';
import PassportNav, { type MobileTab } from './screens/Nav.js';
import PassportToasts, { pushToast } from './screens/ToastStack.js';
// In-app notifications only — a closed Passport notifies nobody. The module's
// header says exactly what background Web Push would additionally need.
import { notify } from './lib/notifications.js';
import { PasskeyPresenceError, confirmPresence } from './lib/passkeyPresence.js';
import {
  CLAIMABLE_NETWORKS,
  aliasRegistrationSupported,
  configuredNetworkId,
  defaultSelectedNetwork,
  isLedgerTxHash,
  txReceiptLink,
  walletNetwork,
} from './lib/networks.js';
// The local wallet drags the whole Midnight wallet SDK in with it, so it is
// loaded on demand rather than at boot. Types are erased at build time and
// cost nothing here.
import type {
  FeeReadiness,
  LocalMidnightWallet,
  LocalWalletBalances,
  LocalWalletProvingMode,
  LocalWalletSurfaces,
} from './lib/localWallet.js';

type ActivityStatus = 'pending' | 'complete' | 'blocked' | 'error';
type ProfileStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';
type ActivitySource = 'local' | 'wallet' | 'chain';
type OnboardingIntent = 'local-create' | 'local-signin';
type LocalWalletStatus = 'idle' | 'opening' | 'ready' | 'error';

/**
 * One account-custody deploy in flight, as the two moments a caller can want.
 *
 * `submitted` is the transaction handed to the node — and with it the contract
 * ADDRESS, which is a pure function of the constructor's initial state and so
 * is known before any of the waiting starts. `landed` is the chain agreeing,
 * which on stagenet arrives an indexer-lag later (13.2–14.1 s, measured
 * 2026/08/31). A claim needs the first to ask for a name; the Home card's retry
 * needs the second, because finding out whether it worked is the whole of what
 * a retry is for.
 *
 * Both reject when the deploy fails, and a caller that reads only one of them
 * must still account for the other — see `deployPassportContractOnce`.
 */
interface PassportContractRun {
  submitted: Promise<PassportContractSubmission>;
  landed: Promise<PassportContractDeployment>;
}

interface ActivityEntry {
  id: string;
  label: string;
  detail: string;
  status: ActivityStatus;
  source?: ActivitySource;
  txHash?: string;
  /**
   * The network the row was written on, stamped by `addActivity`. It is what
   * builds the row's explorer link later, and it is stored WITH the row for a
   * reason: reading it off the network switcher at render time would hand a
   * transfer made on preview a stagenet link after a switch.
   */
  network?: string;
  createdAt: string;
}

interface PassportC1PrivateRecord {
  address: string;
  privateStateId: string;
  maintenanceSigningKey: string;
  network: 'preview';
  artifact: 'passport-c1-pilot-v1';
  preparedAt: string;
  serializedTransaction?: string;
}

interface PassportPermissionPrivateRecord {
  commitment: string;
  label: string;
  grantSecret: Uint8Array;
  createdAt: string;
}

interface PassportDemoState {
  deviceSecret: Uint8Array;
  recoverySecret?: Uint8Array;
  createdAt: string;
  schema: 1 | 2 | 3 | 4;
  c1?: PassportC1PrivateRecord;
  permissions?: PassportPermissionPrivateRecord[];
}

const APP_ID = 'org.midnight.passport.demo';
/**
 * The public network this build's passkey wallet signs on, and its label.
 * `null` on a devnet build, where the wallet signs on nothing public and every
 * name is honestly queued.
 */
const configuredWalletNetwork = walletNetwork();
/**
 * The public network this build PRESENTS as, which is the only vocabulary the
 * network switcher speaks. Identical to `configuredWalletNetwork` on a public
 * build; on a devnet build — where the wallet's raw network id is `undeployed`
 * and matches nothing the switcher can show — it is the documented default the
 * UI opens on. Anything comparing `selectedNetwork` against "the wallet's
 * network" must compare against this.
 */
const walletPresentedNetwork = defaultSelectedNetwork();
const signingNetworkLabel = configuredWalletNetwork
  ? NETWORK_LABELS[configuredWalletNetwork]
  : 'its configured network';
/**
 * The optional Passport service (`VITE_FUNDER_URL`, see
 * `examples/passport-funder` and `examples/passport-balancer`). It does two
 * things for a Passport, and neither of them puts value in the wallet: it
 * REGISTERS the `.night` name from its own NIGHT (`POST /register-alias`), and
 * it funds the ACCOUNT contract once that account exists (`POST
 * /fund-account`). Unset, a name simply queues until a service is back — the
 * wallet is never asked to pay for one.
 */
const FUNDER_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_FUNDER_URL?.trim().replace(/\/+$/, '') ||
  null;
/**
 * Ceiling on ONE `/fund-account` round-trip.
 *
 * The sponsor proves and submits a `deposit_night` — and, where it holds one,
 * a shielded stablecoin deposit as well — before it answers, so this is a
 * chain-work wait rather than an HTTP one. It is deliberately generous and
 * deliberately never blocking: the caller fires this and moves on.
 */
const FUND_ACCOUNT_TIMEOUT_MS = 600_000;
/**
 * Backoff between activation attempts, in order.
 *
 * The sponsor is not always able to answer the moment a name lands: it has just
 * spent from its own wallet to register that name, and it reports itself
 * SYNCING — a 503 — for a minute or two afterwards while its wallet catches up.
 * Observed live on 2026/08/24, and the account sat at zero because a single
 * attempt was all it got. So a refusal that time can fix is retried rather than
 * recorded as the end of the story: seven retries, ~10 minutes of patience in
 * total, all of it in the background and none of it able to touch the name.
 *
 * THE FIRST WAIT IS FIVE SECONDS, not twenty (2026/09/02). The grant is now
 * fired the moment the account lands rather than after the name is registered,
 * and the commonest refusal at that instant is `indexer-unreachable` for a
 * contract the indexer has not served yet — a state that clears in a block. A
 * twenty-second first wait spent the whole of that gap doing nothing.
 *
 * Separate from {@link FUND_ACCOUNT_TIMEOUT_MS}, which bounds one request. A
 * slow answer is the sponsor doing chain work and is waited out; a fast refusal
 * is what this schedule exists for.
 */
const FUND_ACCOUNT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
/**
 * Which account contracts this browser has already asked the sponsor to
 * activate. Keyed by contract address because that is what a Passport has
 * exactly one of, and persisted so a reload does not ask a second time. The
 * sponsor's own once-per-account ledger is the real gate; this only keeps
 * Passport from knocking on a door it has already been through.
 */
const ACCOUNT_FUNDED_STORAGE_PREFIX = 'mn-passport:account-funded:';

function accountFundingAttempted(contractAddress: string): boolean {
  try {
    return window.localStorage.getItem(`${ACCOUNT_FUNDED_STORAGE_PREFIX}${contractAddress}`) !== null;
  } catch {
    return false;
  }
}

function rememberAccountFunding(contractAddress: string): void {
  try {
    window.localStorage.setItem(
      `${ACCOUNT_FUNDED_STORAGE_PREFIX}${contractAddress}`,
      new Date().toISOString(),
    );
  } catch {
    // Best-effort: without it the sponsor is asked once more and refuses itself.
  }
}

/** Sleeps, for the activation backoff. Nothing here races it. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The stablecoin colour this build was configured with, when it was. The
 * sponsor's own `/status` is the first source (see {@link probeStablecoin});
 * this is the fall-back for a build that knows the colour without being able
 * to ask.
 */
const CONFIGURED_STABLECOIN_COLOUR = normalisedColourHex(
  (import.meta.env as Record<string, string | undefined>).VITE_MUSD_COLOUR_HEX,
);

/**
 * Which shielded colour the demo shows as its stablecoin, and what to call it.
 *
 * The sponsor mints it, so the sponsor is the only honest source for its
 * colour: `GET /status` carries `assetColourHex` and `assetSymbol` where the
 * service holds one. A build with no sponsor, or a sponsor that does not
 * publish an asset, falls back to {@link CONFIGURED_STABLECOIN_COLOUR}, and
 * failing that returns `null` — Home then shows the account's shielded coins
 * by their short colour rather than under a name nobody has verified.
 */
async function probeStablecoin(): Promise<{ symbol: string; colourHex: string } | null> {
  const configured = CONFIGURED_STABLECOIN_COLOUR
    ? { symbol: 'mUSD', colourHex: CONFIGURED_STABLECOIN_COLOUR }
    : null;
  if (!FUNDER_URL) return configured;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    let body: { assetColourHex?: unknown; assetSymbol?: unknown };
    try {
      const response = await fetch(`${FUNDER_URL}/status`, { signal: controller.signal });
      if (!response.ok) return configured;
      body = (await response.json()) as { assetColourHex?: unknown; assetSymbol?: unknown };
    } finally {
      clearTimeout(timer);
    }
    const colourHex = normalisedColourHex(
      typeof body.assetColourHex === 'string' ? body.assetColourHex : null,
    );
    if (!colourHex) return configured;
    return {
      symbol:
        typeof body.assetSymbol === 'string' && body.assetSymbol.trim()
          ? body.assetSymbol.trim()
          : 'mUSD',
      colourHex,
    };
  } catch {
    // Unreachable or unparseable: the configured colour, or nothing at all.
    return configured;
  }
}

/**
 * Turns a failed passkey ceremony into the vocabulary `lib/passkeyPresence.ts`
 * defines, so an account-contract call refuses exactly as a presence
 * confirmation used to.
 *
 * `WebAuthnPrfKeyProvider.assertOnce` re-wraps whatever WebAuthn threw as a
 * plain `Error`, so the `DOMException` name that module branches on is gone by
 * the time it reaches here. What survives is the platform's own sentence, and
 * every browser says "cancelled" or "timed out or was not allowed" when a user
 * dismisses the sheet. Anything else is read as a ceremony that could not run
 * at all. Both codes mean the same thing to every caller — nothing was signed
 * and nothing was sent — so a misread costs precision, never honesty.
 */
function passkeyCeremonyFailure(cause: unknown): PasskeyPresenceError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/cancell?ed|timed out or was not allowed|not allowed/i.test(message)) {
    return new PasskeyPresenceError(
      'approval-cancelled',
      'Approval cancelled — nothing was signed or sent.',
    );
  }
  return new PasskeyPresenceError(
    'presence-unavailable',
    message ||
      'Passport could not use the passkey this session signed in with, so nothing was signed or sent.',
  );
}

/**
 * The refusal a MID-SESSION ceremony raises, carrying a way out rather than
 * only an account of itself.
 *
 * THE REPORT (2026/08/31, with a screenshot). A session restored a stored
 * profile whose credential is not in this browser's keychain. On the name step
 * — whose header is the wordmark, "Last step", and the theme toggle, and which
 * therefore has NO sign-out on it — the user pressed Claim, macOS raised its
 * cross-device sheet because the passkey lives on their phone, and what came
 * back was a card with one line of text and no control at all. There was
 * nothing on that screen that could get them anywhere.
 *
 * WHAT IS DIFFERENT FROM `signInCeremonyFailure`, and why it is a second
 * function rather than a flag on the first: the two paths reach the same rule
 * (`passkeySignInRecovery`, told `context: 'mid-session'`) and deliberately
 * different offers. Sign-in answers a keyless failure with "create a new
 * passkey"; mid-session may not, because a new passkey is a new seed and
 * therefore a NEW Passport — it would abandon the name and account on the
 * screen rather than recover them. So this marks the error, and the surface
 * that receives it offers to run the same action again or to sign out, which
 * are the two things that are safe whether the passkey is on a phone in the
 * next room or gone for good.
 *
 * The error keeps its `PasskeyPresenceError` shape and its code, because
 * `lib/txApproval.ts` maps that code for a framed app and nothing about the
 * app-facing protocol changes here. The mark rides beside it, non-enumerable.
 */
function midSessionCeremonyFailure(cause: unknown): PasskeyPresenceError {
  const refusal = passkeyCeremonyFailure(cause);
  const recovery = passkeySignInRecovery({
    context: 'mid-session',
    stage: 'credential',
    timedOut: cause instanceof PasskeyCeremonyTimeout,
  });
  /* The rule answers `retry-or-sign-out` for every mid-session credential
     failure today. It is still asked, and its answer still branched on, so a
     later narrowing of the rule changes what the screens offer rather than
     leaving this function quietly asserting the old answer. */
  if (recovery !== 'retry-or-sign-out') return refusal;
  return markMidSessionWayOut(
    new PasskeyPresenceError(
      refusal.code,
      midSessionPasskeyMessage({ timedOut: cause instanceof PasskeyCeremonyTimeout }),
    ),
  );
}

/**
 * An account-custody refusal, in the vocabulary `lib/txApproval.ts` already
 * maps for a framed or redirected app.
 *
 * The app-facing protocol is unchanged by the move to the account contract, so
 * the contract's own codes are translated here rather than in the bridge: a
 * shortfall is a shortfall whether the coins were the wallet's or the
 * account's, and an address the contract will not take is the same
 * `invalid-request` the wallet's own send reported.
 */
function appTransferCodeFor(code: string | null): string | null {
  if (code === 'insufficient-balance' || code === 'insufficient-funds') return 'insufficient-night';
  if (code === 'invalid-request') return 'invalid-recipient';
  return code;
}
/**
 * The queue reason when the sponsor cannot register a name right now. Never
 * followed by a wallet-funded attempt: the wallet does not pay for names.
 *
 * ONE SENTENCE, because this is the whole body of the claim screen's failure
 * card — see `aliasRefusalMessage` in `identity/sponsoredAlias.ts` for the rule
 * and the three-sentence card it was written against. What the reader can do
 * about it is on the two controls, not in a second clause.
 */
const SPONSOR_UNAVAILABLE_SENTENCE =
  'The Passport service that registers names is not available right now, and your name is kept for you.';

/**
 * Whether the funder is sponsoring `.night` registrations on `network` right
 * now — its own `/status` answer, cached briefly, `false` on any doubt. It is
 * the whole of the answer: the funder registers the name itself (see
 * `identity/sponsoredAlias.ts`) and the user's NIGHT balance is never part of
 * the claim, so `false` means the name waits rather than that the wallet is
 * asked to buy it.
 */
async function aliasSponsorshipLikely(network: string | null | undefined): Promise<boolean> {
  if (!FUNDER_URL || !aliasRegistrationSupported(network)) return false;
  const { checkAliasSponsorship } = await import('./identity/sponsoredAlias.js');
  return checkAliasSponsorship(FUNDER_URL, network as MidnamesNetwork);
}

/**
 * The claim path's four chunks, fetched and evaluated while the user is still
 * choosing a name.
 *
 * `claimAliasBoundToAccount` opens with a `Promise.all` of these same four
 * imports, and on the live site that resolution was the single largest thing
 * standing between the claim click and the passkey prompt: ~0.9 s of the
 * measured 2.19 s gap (stagenet, 1.6 Mbit, 4x CPU, 2026/08/26). ES module
 * imports are idempotent and deduplicated by the loader, so a prefetch started
 * here and the claim's own `Promise.all` are the SAME work — the claim simply
 * finds it already done. Nothing downstream has to know this ran.
 *
 * Fire-and-forget, and deliberately swallowing: a prefetch that fails has cost
 * nothing, because the claim's own import is what actually produces the
 * bindings and will throw properly if the chunk is genuinely unreachable.
 */
let claimModulePrefetch: Promise<unknown> | null = null;
function warmClaimModules(): void {
  claimModulePrefetch ??= Promise.all([
    import('./identity/midnames.js'),
    import('./identity/passportContract.js'),
    import('./lib/localWallet.js'),
    import('./identity/sponsoredAlias.js'),
  ]).catch(() => undefined);
  void claimModulePrefetch;
}

/**
 * The claim's two pre-checks, warmed as the user types and awaited by the
 * claim — see `identity/claimWarmup.ts` for the rules that make reusing an
 * answer safe, and for why the window is ten seconds.
 *
 * Module scope rather than component state on purpose: the claim screen's
 * availability probe and `claimAliasBoundToAccount` are the two askers, they
 * live in different call stacks, and sharing one in-flight promise between
 * them is the whole mechanism. A re-render must not reset it.
 */
const claimWarmup = createClaimWarmup<AliasAvailability>({
  /* The claim's OWN read — `fresh: true`, straight past `midnames.ts`'s
     registry cache. That matters beyond speed: the answer the user is shown
     under the field is now the identical answer the claim gates on, so the
     screen can no longer say "available" from a cached ledger while the
     claim's fresher read says taken. */
  availability: async (network, alias) => {
    const { checkAliasAvailability } = await import('./identity/midnames.js');
    return checkAliasAvailability(network as MidnamesNetwork, alias, { fresh: true });
  },
  sponsorship: (network) => aliasSponsorshipLikely(network),
  /* An unreachable registry is a non-answer, not a refusal to cache: one blip
     while the user was typing must not refuse the claim they make afterwards.
     `taken` IS an answer and is kept — it can only ever refuse. */
  trustworthy: (availability) => availability.status !== 'unreachable',
});

/**
 * Parses a formatted (6-decimal) NIGHT figure back to atomic units, exactly.
 *
 * One caller: the legacy-funds gate, which needs to know whether the passkey
 * wallet holds a POSITIVE balance. Nothing else in this file reads a wallet
 * balance at all.
 */
function atomicNightFromFormatted(formatted: string | null): bigint | null {
  if (formatted === null) return null;
  const cleaned = formatted.replace(/[\s,]/g, '');
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const padded = `${fraction}000000`.slice(0, 6);
  return BigInt(whole || '0') * 1_000_000n + BigInt(padded || '0');
}

/**
 * LEGACY account identifier for the passkey-only Passport.
 *
 * There is no account issuer behind a passkey, so this route originally used
 * one fixed identifier — one local Passport per browser. Since 2026/08/05 local profiles are keyed
 * per passkey credential (see `publicProfile.ts`): the migrated legacy record
 * KEEPS this accountId so its encrypted private state and derived wallet
 * addresses are unchanged, while new multi-passkey profiles derive under
 * `localCredentialAccountId(credentialId)` so no two credentials' stored
 * state can collide. Every local flow reads its scope from the profile via
 * {@link localScopeFor}.
 */
const LOCAL_ACCOUNT_ID = 'passport-local-device';
const LOCAL_SCOPE = { appId: APP_ID, accountId: LOCAL_ACCOUNT_ID };

/** The private-state and wallet-seed scope a local profile derives under. */
function localScopeFor(profile: DemoPassportProfile): { appId: string; accountId: string } {
  return { appId: APP_ID, accountId: profile.accountId ?? LOCAL_ACCOUNT_ID };
}

/**
 * Which passkey signed in last, so the one-button Continue path targets the
 * profile the user most recently used when several exist. Best-effort.
 */
const LAST_PASSKEY_STORAGE_KEY = 'passport-last-passkey';

function storedLastPasskey(): string | null {
  try {
    return window.localStorage.getItem(LAST_PASSKEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPasskey(credentialId: string): void {
  try {
    window.localStorage.setItem(LAST_PASSKEY_STORAGE_KEY, credentialId);
  } catch {
    // The preference simply will not survive a reload.
  }
}

/**
 * The profile the one-button Continue path signs in to: the last-used
 * passkey's profile when it still exists, otherwise the only profile, or the
 * most recently created. Runs the legacy migration first, so a pre-2026/08/05
 * record is credential-keyed before anything matches against it. Null when
 * this browser holds no local Passport at all.
 */
async function resolveDefaultLocalProfile(): Promise<DemoPassportProfile | null> {
  const migrated = await migrateLegacyLocalProfile().catch(() => null);
  const profiles = await listLocalProfiles().catch(() => (migrated ? [migrated] : []));
  if (profiles.length === 0) return migrated;
  if (profiles.length === 1) return profiles[0];
  const last = storedLastPasskey();
  const lastProfile = last
    ? profiles.find((candidate) => candidate.passkey.credentialId === last)
    : undefined;
  if (lastProfile) return lastProfile;
  return [...profiles].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * The Midnames owner secret's derivation scope.
 *
 * Deliberately a DIFFERENT `accountId` from the wallet's, so the 32 bytes that
 * become the Midnames domain-owner key are cryptographically separated from the
 * wallet seed even though both come from the same passkey. The passkey itself is
 * never re-enrolled: one credential, every network, and a distinct derivation
 * scope per purpose.
 */
const MIDNAMES_OWNER_SCOPE = { appId: APP_ID, accountId: 'midnames-owner-v1' };

/**
 * The account-custody contract's derivation scope — a third distinct scope, on
 * the same principle as {@link MIDNAMES_OWNER_SCOPE}: the contract's device
 * authority must not be derivable from the wallet seed or the Midnames owner
 * key, even though all three come from the one enrolled passkey.
 *
 * One assertion against this scope yields ONE 32-byte root, which
 * `derivePassportContractSecrets` splits by domain into the device secret and
 * the recovery secret. Two scopes would mean two WebAuthn prompts for one user
 * action, which is exactly what the approval convention forbids.
 */
const PASSPORT_CONTRACT_SCOPE = { appId: APP_ID, accountId: 'passport-contract-v1' };

/**
 * The onboarding steps that follow a successful passkey + wallet open.
 *
 * 2026/08/06: only 'alias' is ever SCHEDULED. Backup and Ecosystem left the
 * chain — a new Passport now goes name → dashboard — but both screens stay in
 * the union because Home and the Ecosystem card still route to them on
 * demand. (Backup and recovery proper is flagged for later, not built.)
 *
 * 2026/08/30: 'welcome' joins it in front of 'alias', and ONLY for a Passport
 * this session created. See `WelcomeScreen` for what it says and why it is
 * shown once.
 */
type IdentityStep = 'welcome' | 'alias' | 'backup' | 'ecosystem' | null;

/**
 * An account read off a passkey that the chain has not answered for YET.
 *
 * It is a session's state and never storage: what survives a reload is the
 * profile note the recovery writes (`accountOnPasskey`) and the name it
 * restores. This is only the search itself — where it has got to, and whether
 * it is still running — because a search is the one thing a reload should
 * start again rather than resume half-way through.
 */
interface AccountSearch {
  /** The account-custody address the blob named. */
  address: string;
  network: string;
  /** The name restored with it, when the blob carried one. */
  alias: string | null;
  /** How many read-backs have already come back with nothing. */
  attempt: number;
  /**
   * `checking` while the chain is still being asked — Home says the account is
   * being set up — and `not-found` once the attempts are spent, which raises
   * `AccountRecovery.tsx` and its two controls.
   */
  phase: 'checking' | 'not-found';
}

/**
 * How long a WebAuthn ceremony may sit unanswered before Passport stops
 * waiting for it.
 *
 * Nothing in WebAuthn guarantees `credentials.create`/`get` ever settles. A
 * browser wallet extension that claims the passkey UI can leave the promise
 * pending forever — Lace was observed doing exactly this on 2026/08/06, where
 * the passkey window simply never appeared — and the user sees a spinner with
 * no end. Better an honest error with a retry than an infinite wait.
 *
 * 25 s → 180 s on 2026/08/31, and the reason is a screenshot. A user on the
 * live name step pressed Claim, the platform raised its CROSS-DEVICE sheet
 * ("Sign In: Scan QR Code / Use Security key") because the passkey lives on
 * their phone, and the watchdog fired underneath it — 25 seconds is not enough
 * time to pick up a phone, unlock it, open the camera, and approve. The
 * ceremony was proceeding correctly and Passport killed it, then said the
 * prompt had never appeared.
 *
 * Three minutes is chosen to comfortably exceed that walk rather than to be a
 * round number: fetching a phone from another room and completing a QR sign-in
 * is a minute or two, and the ceiling only has to sit beyond the slowest
 * legitimate case. It still bounds the hang this exists for — a dialog held by
 * an extension ends, with words, rather than never — which is the only thing
 * the timeout was ever for.
 */
const PASSKEY_CEREMONY_TIMEOUT_MS = 180_000;

/**
 * Passport gave up waiting — a DIFFERENT failure from the platform saying no,
 * and the recovery rule has to be able to tell them apart.
 *
 * A `NotAllowedError` means something was decided: a sheet was dismissed, or a
 * picker had nothing in it. This means nothing was decided at all, so nothing
 * has been learnt about whether a credential exists, and offering to enrol
 * over it would be a guess. The class exists so `passkeySignInRecovery` can be
 * told the two apart, and so the copy can be: the timeout's own sentence no
 * longer claims the prompt never appeared, because on 2026/08/31 it was
 * photographed saying exactly that underneath a platform sheet that WAS on
 * screen. See `PASSKEY_CEREMONY_TIMEOUT_MESSAGE` in `lib/passkeyRecovery.ts`.
 */
class PasskeyCeremonyTimeout extends Error {
  constructor() {
    super(PASSKEY_CEREMONY_TIMEOUT_MESSAGE);
    this.name = 'PasskeyCeremonyTimeout';
  }
}

/** What the `unusable-credential` panel's own error says, in one place. */
const UNUSABLE_CREDENTIAL_MESSAGE =
  'A passkey on this device answered but does not support the extension Passport needs, so it cannot open a Passport. Choose "Create a new passkey" to make one that can — the passkeys this browser already has a Passport for are left untouched.';

/**
 * A sign-in failure the screen answers with a PANEL AND A BUTTON rather than a
 * banner, and the reason that distinction is drawn in the type system.
 *
 * Both of the states that carry a way out — no credential could be produced,
 * and a credential answered that cannot open a Passport — are explained on
 * screen by a panel whose whole purpose is to say the thing and then offer the
 * control that resolves it. An error banner above that panel saying the same
 * sentence a second time, usually in the platform's words rather than ours, is
 * the screen telling one story twice and burying the button under it. So a
 * failure of this shape suppresses the banner.
 *
 * It still carries `detail`: the platform's own account of what happened,
 * which goes to the activity trail. Nothing is discarded, it is just not the
 * thing put in front of somebody who needs a next step.
 */
class PasskeyWayOutError extends Error {
  constructor(
    message: string,
    /** The platform's own words, for the activity trail rather than the screen. */
    readonly detail: string,
  ) {
    super(message);
    this.name = 'PasskeyWayOutError';
  }
}

/**
 * Races a passkey ceremony against {@link PASSKEY_CEREMONY_TIMEOUT_MS}.
 *
 * A ceremony that answers after we have given up is disposed rather than
 * abandoned: a late `DiscoveredPassportPasskey` would otherwise keep live PRF
 * bytes in a handle no caller owns. An `EnrolledPassportPasskey` carries that
 * handle at `.prf` rather than on itself, so both shapes are covered — a late
 * creation-time PRF evaluation must not outlive the flow either.
 */
async function withPasskeyWatchdog<T>(ceremony: () => Promise<T>): Promise<T> {
  const pending = ceremony();
  let timer: number | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new PasskeyCeremonyTimeout()), PASSKEY_CEREMONY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, watchdog]);
  } catch (cause) {
    void pending
      .then((late) => {
        /* Every shape a passkey ceremony resolves to, so a late answer never
           leaves PRF bytes alive after the flow that wanted them gave up: a
           one-shot handle, an enrolment, and the discover-or-enrol result
           which nests one of each. */
        const value = late as
          | {
              dispose?: () => void;
              prf?: { dispose?: () => void } | null;
              discovered?: { dispose?: () => void } | null;
              enrolled?: { prf?: { dispose?: () => void } | null } | null;
            }
          | null;
        value?.dispose?.();
        value?.prf?.dispose?.();
        value?.discovered?.dispose?.();
        value?.enrolled?.prf?.dispose?.();
      })
      .catch(() => undefined);
    throw cause;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Whether this browser has already settled the name step for a credential.
 *
 * The in-session `identityStepResolved` ref cannot answer this: it is reset by
 * every mount, so a reload of a live session used to re-enter the wizard and
 * dump the user back on "choose your .night name" — the "app resets during
 * sign-in" report from 2026/08/06. A skipped name leaves no alias record, so
 * the record store alone cannot answer it either. This flag is the missing
 * half, and it deliberately SURVIVES sign-out: the same passkey re-derives the
 * same wallet, so it re-derives the same answer.
 */
const NAME_STEP_STORAGE_PREFIX = 'mn-passport:name-step:';

type NameStepResolution = 'done' | 'skipped';

function storedNameStep(credentialId: string): NameStepResolution | null {
  try {
    const value = window.localStorage.getItem(`${NAME_STEP_STORAGE_PREFIX}${credentialId}`);
    return value === 'done' || value === 'skipped' ? value : null;
  } catch {
    return null;
  }
}

function storeNameStep(credentialId: string, resolution: NameStepResolution): void {
  try {
    window.localStorage.setItem(`${NAME_STEP_STORAGE_PREFIX}${credentialId}`, resolution);
  } catch {
    // Best-effort: without it the name step may be offered once more.
  }
}

/**
 * Whether this browser has already shown the welcome screen for a credential.
 *
 * Its own key rather than a widened `NameStepResolution`, because the two
 * answer different questions and are written at different moments: the name
 * step is resolved when a name is claimed, and the welcome is dismissed the
 * moment it has been read. Sharing a key would mean a Passport that reloaded
 * between the two got welcomed a second time.
 *
 * It deliberately SURVIVES sign-out, on the same reasoning as the name step:
 * the same passkey re-derives the same Passport, so it is the same person, and
 * being introduced to something you already hold reads as an app that has
 * forgotten you.
 */
const WELCOME_STORAGE_PREFIX = 'mn-passport:welcome:';

function welcomeSeen(credentialId: string): boolean {
  try {
    return window.localStorage.getItem(`${WELCOME_STORAGE_PREFIX}${credentialId}`) !== null;
  } catch {
    return false;
  }
}

function storeWelcomeSeen(credentialId: string): void {
  try {
    window.localStorage.setItem(`${WELCOME_STORAGE_PREFIX}${credentialId}`, 'seen');
  } catch {
    // Best-effort. Without it the introduction may be offered once more, which
    // is the harmless direction to fail in.
  }
}

/**
 * The link a success toast carries — or `undefined`.
 *
 * A submitted transaction is a thing the user should be able to GO AND LOOK AT,
 * and the toast is the moment they can: it is on screen, it is tappable, and it
 * lasts twelve seconds rather than the five an unlinked one gets. The activity
 * feed keeps the same link afterwards.
 *
 * Preview, pre-production, and stagenet each have a public explorer; mainnet is
 * not in the table. The explorer takes the 32-byte ledger transaction hash —
 * never the identifier `submitTransaction` answers with — so where that mapping
 * has not happened yet, `fallbackName` (a `.night` name) sends the user to the
 * step verifier instead, which finds the transaction by resolving the name.
 * Without either there is no link at all, rather than one that goes nowhere.
 */
function explorerTxLink(
  txHash: string | null | undefined,
  network: string | null | undefined,
  fallbackName?: string | null,
): { label: string; href: string } | undefined {
  return txReceiptLink(network, txHash, fallbackName) ?? undefined;
}

/**
 * `alice` → `alice.night`. Duplicated from `identity/midnames.ts` on purpose:
 * that module statically imports the Midnight ledger, and App must not drag the
 * whole wallet SDK into its own chunk for one string join.
 */
const aliasDomainOf = (alias: string) => `${alias}.night`;

/* -------------------------------------------------------------------------- */
/* Demo-grade session persistence — a §2.2 stopgap, NOT a security boundary   */
/*                                                                            */
/* Decision 2026/08/05: a signed-in Passport must survive a reload without    */
/* re-prompting for the passkey. After deriveWalletSeed succeeds, the 32-byte */
/* wallet seed is wrapped with AES-GCM under a NON-EXTRACTABLE CryptoKey      */
/* (generateKey with extractable: false) and both — the CryptoKey via         */
/* structured clone, and the ciphertext beside it — are stored in IndexedDB,  */
/* scoped per profile. On load, a persisted session is silently unwrapped and */
/* the wallet rebuilt with createLocalMidnightWallet; signing out clears it.  */
/*                                                                            */
/* BE HONEST ABOUT WHAT THIS IS: the non-extractable flag only prevents       */
/* exporting the raw key bytes. Any script running on this origin can load    */
/* the CryptoKey from IndexedDB and call decrypt with it, so the seed is      */
/* origin-readable at runtime. This is a demo-grade stopgap pending Nicolas's */
/* private-storage decision (§2.2); it deliberately does NOT touch — and must */
/* never weaken — the PRF-derived private-state encryption path, which        */
/* remains gated on a live passkey assertion.                                 */
/* -------------------------------------------------------------------------- */

const SESSION_DATABASE = 'midnight-passport-session';
const SESSION_STORE = 'wallet-sessions';

interface PersistedWalletSession {
  /** AES-GCM-256, extractable: false — structured-cloned into IndexedDB. */
  key: CryptoKey;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  createdAt: string;
  /**
   * Which passkey credential this session belongs to, so a restore signs back
   * in to the right profile when several exist. Absent on records written
   * before multi-passkey profiles; those belong to the migrated legacy record.
   */
  credentialId?: string;
  /** The scope accountId the seed was derived under. Absent = legacy scope. */
  accountId?: string;
}

/**
 * The one live session record. Sessions were previously keyed per scope; the
 * restore path still reads the legacy key so an existing signed-in session
 * survives this build, and sign-out clears both.
 */
const ACTIVE_SESSION_KEY = 'active-session';

function openSessionDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_STORE)) {
        request.result.createObjectStore(SESSION_STORE);
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Unable to open Passport session storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function sessionRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openSessionDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, mode);
    const result = operation(transaction.objectStore(SESSION_STORE));
    result.onsuccess = () => resolve(result.result);
    result.onerror = () =>
      reject(result.error ?? new Error('Passport session storage request failed.'));
  });
}

function sessionRecordKey(scope: { appId: string; accountId: string }): string {
  return `${scope.appId}/${scope.accountId}`;
}

/** Wraps the seed and stores it. Throws on storage failure; callers treat it as best-effort. */
async function persistWalletSession(
  scope: { appId: string; accountId: string },
  seed: Uint8Array,
  credentialId: string | null,
): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    seed as BufferSource,
  );
  const record: PersistedWalletSession = {
    key,
    iv,
    ciphertext,
    createdAt: new Date().toISOString(),
    ...(credentialId ? { credentialId } : {}),
    accountId: scope.accountId,
  };
  await sessionRequest('readwrite', (store) => store.put(record, ACTIVE_SESSION_KEY));
}

interface RestoredWalletSession {
  seed: Uint8Array;
  /** Null on a record written before sessions recorded their credential. */
  credentialId: string | null;
  accountId: string;
}

/**
 * Silently unwraps the persisted session, or returns null when no usable
 * session exists. Never throws and never prompts: the whole point of the
 * stopgap is that the reload path involves no passkey ceremony. The caller
 * owns the returned seed bytes and must zero them after use. Reads the
 * pre-multi-passkey per-scope key as a fallback so an existing session is not
 * orphaned by this build.
 */
async function loadPersistedWalletSession(): Promise<RestoredWalletSession | null> {
  try {
    const record =
      (await sessionRequest<PersistedWalletSession | undefined>('readonly', (store) =>
        store.get(ACTIVE_SESSION_KEY),
      )) ??
      (await sessionRequest<PersistedWalletSession | undefined>('readonly', (store) =>
        store.get(sessionRecordKey(LOCAL_SCOPE)),
      ));
    if (!record?.key || !record.iv || !record.ciphertext) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as BufferSource },
      record.key,
      record.ciphertext,
    );
    const seed = new Uint8Array(plain);
    if (seed.byteLength !== 32) return null;
    return {
      seed,
      credentialId: record.credentialId ?? null,
      accountId: record.accountId ?? LOCAL_ACCOUNT_ID,
    };
  } catch {
    return null;
  }
}

/** Removes the persisted session — current and legacy keys. Best-effort; never throws. */
async function clearPersistedWalletSession(): Promise<void> {
  try {
    await sessionRequest('readwrite', (store) => store.delete(ACTIVE_SESSION_KEY));
    await sessionRequest('readwrite', (store) => store.delete(sessionRecordKey(LOCAL_SCOPE)));
  } catch {
    // Storage may be unavailable; there is then nothing persisted to clear.
  }
}

/**
 * NIGHT is quoted to six decimals — Contract W's `formatUnits(night, 6)`, and
 * the same scale the account contract's atomic `night_balances` are on. These
 * two undo and redo exactly that, in whole micro-NIGHT, so every figure on
 * screen is reached without a float ever touching a balance.
 */
const NIGHT_DECIMALS = 6n;
const NIGHT_UNITS = 1_000_000n;

/** `null` for anything that is not a plain formatted amount, unknown included. */
function parseNightUnits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole) * NIGHT_UNITS + BigInt(fraction.padEnd(Number(NIGHT_DECIMALS), '0'));
  return sign === '-' ? -units : units;
}

function formatNightUnits(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(Number(NIGHT_DECIMALS) + 1, '0');
  const whole = digits.slice(0, digits.length - Number(NIGHT_DECIMALS));
  const fraction = digits.slice(digits.length - Number(NIGHT_DECIMALS)).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * How long the wait between a send's two legs is given.
 *
 * Three minutes rather than the two the two paths used to allow separately.
 * The wait is for the indexer to serve a transaction it has already accepted —
 * measured at 13–14 s on stagenet — and every second past that is congestion
 * rather than failure. Running out no longer ends the transfer either way: the
 * record stays at `settle` and Home offers to look again.
 */
const SETTLE_DEADLINE_MS = 180_000;

/**
 * What one unfinished send is called, in the sender's own units.
 *
 * A shielded colour publishes no decimal scale on the ledger, so its amount is
 * a whole count and the word beside it is `units` — the same words the Send
 * sheet uses, so the card on Home and the sheet that opened it agree.
 */
function pendingSendAmountLabel(record: PendingSend): string {
  return record.kind === 'night'
    ? `${formatNightUnits(BigInt(record.amount))} NIGHT`
    : `${record.amount} units`;
}

/** A run, as it is written down before anything is submitted. */
function newPendingSend(input: {
  kind: PendingSendKind;
  recipient: { label: string; accountAddress: string };
  amount: bigint;
  tokenType?: string;
  colourHex: string;
  ownReceivingAddress: string;
}): PendingSend {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    recipient: input.recipient,
    amount: input.amount.toString(),
    ...(input.tokenType ? { tokenType: input.tokenType } : {}),
    colourHex: input.colourHex,
    ownReceivingAddress: input.ownReceivingAddress,
    leg: 'withdraw',
    attempts: { withdraw: 0, deposit: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The addresses of a freshly opened local wallet, before its first balance
 * read. Every balance is `null` — unknown — and never a fabricated zero.
 */
function initialLocalSurfaceState(wallet: LocalMidnightWallet): LocalWalletSurfaces {
  return {
    unshieldedAddress: wallet.unshieldedAddress,
    shieldedAddress: wallet.shieldedAddress,
    dustAddress: wallet.dustAddress,
    unshieldedBalance: null,
    shieldedTokenCount: null,
    dustBalance: null,
    dustCap: null,
    dustSyncing: false,
    // All three addresses come out of local key derivation, so they are either
    // all present or the wallet failed to open at all.
    addressStatus: 'ready',
    balanceStatus: 'loading',
    balanceError: null,
  };
}

function newDeviceSecret(): Uint8Array {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  return value;
}

/**
 * What the signed-in Passport's account-custody contract holds, as Home shows
 * it. These figures are the CONTRACT's `night_balances` and `coins`, read
 * through `identity/accountCustody.ts` — never the passkey wallet's own.
 */
interface AccountBalances {
  /** Atomic NIGHT the contract holds. `null` means unknown, never a zero. */
  night: bigint | null;
  /** Every shielded colour the contract holds a positive balance of. */
  shielded: { colourHex: string; amount: bigint }[];
  /**
   * `idle` means there is no deployed contract to read — a different fact from
   * a read that failed, and Home shows nothing rather than zeros for it.
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  /** Present only on `unavailable`, in the module's own words. */
  error: string | null;
}

const NO_ACCOUNT_BALANCES: AccountBalances = {
  night: null,
  shielded: [],
  status: 'idle',
  error: null,
};

export default function PassportDemo() {
  // Selected network context: filters the app registry. The demo wallet runs
  // on the ONE network this build was configured for, and the UI says so
  // rather than pretending balances exist elsewhere. The initial selection
  // follows that same configuration (see lib/networks.ts).
  const [selectedNetwork, setSelectedNetwork] = useState<PassportNetwork>(loadStoredNetwork);
  useEffect(() => {
    storeNetwork(selectedNetwork);
  }, [selectedNetwork]);
  // One route, one subject: the encrypted state this browser writes always
  // belongs to the passkey account.
  const subjectId = LOCAL_ACCOUNT_ID;
  const scope = useMemo(() => ({ appId: APP_ID, accountId: subjectId }), [subjectId]);
  const [profile, setProfile] = useState<DemoPassportProfile | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('home');
  // One-button onboarding (2026/08/05): there is no separate "choose" step
  // any more, so the screen only distinguishes idle from working.
  const [onboardingIntent, setOnboardingIntent] = useState<OnboardingIntent | null>(null);
  const [onboardingBusyLabel, setOnboardingBusyLabel] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  /**
   * Set when a resident credential answered WITHOUT a PRF result, which means
   * it cannot open a Passport and Passport will not create over it unasked.
   *
   * It is state rather than just an error string because it is not merely a
   * message: it is the one onboarding state that needs a control of its own
   * (see `enrolNewLocalPassportProfile`, and the false remedy this replaced).
   * Holds the authenticator's own account of what happened.
   */
  const [unusableCredential, setUnusableCredential] = useState<string | null>(null);
  /**
   * Set when a sign-in ceremony ended with NO credential in hand — the dead
   * end reported on 2026/08/30 and the reason this state exists.
   *
   * A browser can hold Passport records whose credential the platform keystore
   * will no longer produce: the passkey deleted, a different OS profile, a
   * keychain that never synced. Sign-in then raises the platform's "use a
   * saved passkey" sheet, nothing in it is loadable, and WebAuthn returns
   * `NotAllowedError`. Until now the screen said so and stopped — there was no
   * control on it that could get that user a Passport, and they asked the
   * obvious question: if there is no key, why can it only ever load one?
   *
   * Like `unusableCredential` it is a state rather than an error string,
   * because it needs a control of its own — `enrolNewLocalPassportProfile`,
   * the same one, reached through `onCreateNewPasskey`. Holds the sentence the
   * panel shows.
   */
  const [keylessPasskey, setKeylessPasskey] = useState<string | null>(null);
  const [localSurfaces, setLocalSurfaces] = useState<LocalWalletSurfaces | null>(null);
  const [localWalletStatus, setLocalWalletStatus] = useState<LocalWalletStatus>('idle');
  const [localSyncPercent, setLocalSyncPercent] = useState<number | null>(null);
  const [localWalletNetworkId, setLocalWalletNetworkId] = useState<string | null>(null);
  /**
   * Where the open wallet computes its proofs. Held in state rather than read
   * off the handle during render, so the Send sheet's progress line names the
   * right machine without a render-time ref read.
   */
  const [localWalletProvingMode, setLocalWalletProvingMode] = useState<
    LocalWalletProvingMode | null
  >(null);
  /**
   * Whether the OPEN wallet's network is one Passport genuinely registers
   * names on. Falls back to the build's configured network before a wallet has
   * opened, so the claim screen can already say which mode it is in.
   */
  const aliasClaimSupported = aliasRegistrationSupported(
    localWalletNetworkId ?? configuredWalletNetwork,
  );
  /**
   * Whether a passkey Passport is already enrolled in this browser. `null`
   * while the lookup is still running — which is not the same as "no", so the
   * Sign in option stays live until we actually know.
   */
  const [localPassportKnown, setLocalPassportKnown] = useState<boolean | null>(null);
  /* ---------------------------------------------------------------------- */
  /* Identity — the .night name, per network                                */
  /* ---------------------------------------------------------------------- */
  const [aliasRecords, setAliasRecords] = useState<Record<string, AliasRecord>>(loadAliasRecords);
  const [incentives, setIncentives] = useState<PassportIncentiveRecord[]>(loadIncentives);
  const [identityStep, setIdentityStep] = useState<IdentityStep>(null);
  /** See {@link AccountSearch}. `null` when nothing is being looked for. */
  const [accountSearch, setAccountSearch] = useState<AccountSearch | null>(null);
  /**
   * A sign-in that is CARRYING an account blob, from the moment the ceremony
   * hands one over to the moment the recovery has finished with it.
   *
   * It exists to hold the name step, and it is a separate flag from
   * {@link accountSearch} because it has to be true EARLIER than the search
   * can be: the name-step gate resolves the instant the wallet opens, which is
   * before the blob's name has been restored, and a gate that resolved there
   * would put a Passport that has a name onto "Choose your .night name" —
   * which is the defect, seen live on 2026/09/03.
   */
  const [recoveringAccount, setRecoveringAccount] = useState(false);
  const [claimPhase, setClaimPhase] = useState<AliasClaimProgress['phase'] | null>(null);
  /**
   * Why the last claim did not complete, and whether the screen owes the user
   * a WAY OUT as well as a sentence.
   *
   * One state rather than a message beside a flag, so the two cannot desync
   * into a passkey panel over a registry failure's words: every path that
   * writes a failure writes both halves at once. See `lib/passkeyRecovery.ts`
   * for what makes a failure one that carries a way out.
   */
  const [aliasFailure, setAliasFailure] = useState<{
    message: string;
    wayOut: boolean;
  } | null>(null);
  /**
   * Whether the fee sponsor has really told us it can pay this registration's
   * fee — `available > 0` on its own `/wallet-status`, never an assumption. It
   * starts false and only a live probe may raise it, so the claim screen's
   * baseline copy — the name is kept and registered when the service is back,
   * and nothing is ever spent from the user's Passport for it — stands unless
   * the service itself contradicts it.
   *
   * Until 2026/08/06 the claim path consulted the sponsor but the screen never
   * did, so this sentence could not have told the truth on an environment
   * where the fee genuinely was covered. It is wired up now. On preview, where
   * the sponsor is unset (and where the service reports `available: 0` even
   * when it is set), the probe leaves this false and the baseline copy stands.
   */
  const [nameSponsored, setNameSponsored] = useState(false);
  /** True while a queued name's "Register now" re-run is in flight. */
  const [registerNowBusy, setRegisterNowBusy] = useState(false);
  /**
   * True while the trail's own "Retry" is asking for the opening balance again.
   *
   * `fundAccountOnce` is patient — it keeps asking for up to ten minutes — and
   * it is silent while it waits, by design. Without this the control would
   * answer a second press by doing nothing at all (the in-flight guard) with
   * nothing on screen to say why, which is a button that looks broken.
   */
  const [grantRetryBusy, setGrantRetryBusy] = useState(false);
  /* ---------------------------------------------------------------------- */
  /* The account-custody contract (C1), per credential and network          */
  /* ---------------------------------------------------------------------- */
  const [contractRecords, setContractRecords] = useState<Record<string, PassportContractRecord>>(
    loadPassportContractRecords,
  );
  /** The live phase of a deployment in flight; null when none is running. */
  const [contractPhase, setContractPhase] = useState<PassportContractProgress['phase'] | null>(null);
  const [contractBusy, setContractBusy] = useState(false);
  /* ---------------------------------------------------------------------- */
  /* The account is the account (2026/08/24)                                */
  /*                                                                        */
  /* Every value flow after onboarding runs through the account-custody      */
  /* contract's circuits: Home's figures are its ledger, a send is a         */
  /* `withdraw_*`, and a dApp payment is a `withdraw_night` behind the same  */
  /* consent. The passkey wallet is still the signer and the fee payer, and  */
  /* is no longer anything a user is shown.                                 */
  /* ---------------------------------------------------------------------- */
  const [accountBalances, setAccountBalances] = useState<AccountBalances>(NO_ACCOUNT_BALANCES);
  /** The live phase of an account-contract call in flight; null when none is. */
  const [accountPhase, setAccountPhase] = useState<AccountCustodyProgress['phase'] | null>(null);
  /**
   * Which shielded colour this deployment shows as its stablecoin, and what to
   * call it. `null` until the sponsor has been asked and answered — Home then
   * shows the account's shielded coins by their short colour, which is honest
   * rather than empty.
   */
  const [stablecoin, setStablecoin] = useState<{ symbol: string; colourHex: string } | null>(null);
  /** True while the one-time sweep of legacy wallet funds is running. */
  const [depositBusy, setDepositBusy] = useState(false);
  /**
   * Contract deploys in flight, keyed by credential and network.
   *
   * TWO paths can deploy the account-custody contract: the Home card's "Try
   * deploying again", and a name claim, which deploys one automatically before
   * it can bind the name to it. Nothing stopped them from running at once —
   * `contractBusy` is React state, so it is both too slow (a click landing in
   * the same tick still reads `false`) and too narrow (the claim only raises it
   * around its own deploy, leaving the retry live through every other phase of
   * the claim). Two deploys for one credential and network would leave the user
   * paying twice for two contracts, one of which the records would then forget.
   *
   * A ref is the guard because it is synchronous: the entry is claimed before
   * the first `await` and released when the promise settles, whichever way. A
   * caller that finds an entry already there does not start a second deploy and
   * does not refuse either — it awaits the one that is running and uses its
   * outcome, which is the answer it would have got anyway.
   *
   * Whichever caller STARTED a deploy owns the recording of it: see
   * {@link deployPassportContractOnce}, which writes the deployed record itself
   * so a joining caller cannot write a duplicate.
   *
   * Each entry holds BOTH halves of a deploy — the submission, which carries
   * the contract address, and the landing, which is the chain agreeing — so a
   * joining caller gets whichever of the two it actually needs rather than the
   * slower one by default.
   */
  const contractDeploysInFlight = useRef(new Map<string, PassportContractRun>());
  /** The pending per-network reclaim conflict, when the target says "taken". */
  const [reclaim, setReclaim] = useState<{ target: PassportNetwork; alias: string } | null>(null);
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [reclaimError, setReclaimError] = useState<string | null>(null);
  /**
   * "Passport is in the middle of something", declared once for the whole
   * screen from the busy states the flows already keep.
   *
   * Its only consumer is `src/pwa.tsx`, which reloads this document the moment
   * a newly deployed service worker takes over. That reload is what keeps an
   * installed Passport on the deployed build (see `public/sw.js`), and it must
   * never land inside a passkey ceremony, a proving run, or a registration —
   * each of those has already cost the user an assertion, and a reload
   * abandons it. Nothing here decides anything; it reads the same flags the
   * screens render from, so a flow can never be busy on screen and idle here.
   */
  const passportBusy =
    onboardingIntent !== null ||
    localWalletStatus === 'opening' ||
    claimPhase !== null ||
    contractPhase !== null ||
    contractBusy ||
    accountPhase !== null ||
    depositBusy ||
    registerNowBusy ||
    reclaimBusy;
  useEffect(() => (passportBusy ? holdCriticalWork() : undefined), [passportBusy]);

  /** Guards the one-shot decision to enter the identity steps for a session. */
  const identityStepResolved = useRef(false);
  /**
   * Whether THIS session created the Passport it is holding.
   *
   * Only a fresh Passport is walked through the name step. A sign-in, and a
   * silently restored session, land on the dashboard — jumping an existing
   * user back into "STEP 2 OF 3" is precisely the reset reported on
   * 2026/08/06.
   */
  const identityStepArmed = useRef(false);
  const passportKeyProviders = useRef(new Map<string, WebAuthnPrfKeyProvider>());
  /**
   * Cancels the in-flight §2.2 session restore, if any. A user-initiated
   * ceremony calls it before touching the wallet so the two never both replace
   * `localWalletRef`.
   */
  const sessionRestoreCancel = useRef<(() => void) | null>(null);
  const cancelSessionRestore = useCallback(() => {
    sessionRestoreCancel.current?.();
    sessionRestoreCancel.current = null;
  }, []);
  const onboardingRunning = useRef(false);
  // The live handle is held in a ref, not in state: it is an object with a
  // socket behind it, and every consumer wants the current one rather than a
  // render-scoped snapshot.
  const localWalletRef = useRef<LocalMidnightWallet | null>(null);
  /**
   * The signed-in profile, readable from callbacks that must NOT re-identify
   * when it changes.
   *
   * `refreshLocalBalances` is a dependency of the session-restore effect and of
   * `openLocalWalletWithSeed`, so it has to keep a stable identity across
   * renders; it now also refreshes the account contract's balances, and that
   * read needs the credential the contract is keyed by. A ref is how the two
   * requirements meet without making the restore effect re-run every time a
   * profile field is written.
   */
  const profileRef = useRef<DemoPassportProfile | null>(null);
  /**
   * Has the open wallet finished walking the chain at least once?
   *
   * Only the incoming-transfer watch reads it, and it has to: while the walk is
   * in progress the unshielded balance climbs as historical blocks are applied,
   * and every one of those steps looks exactly like an arriving transfer. Set
   * by the sync-progress effect, which owns the same handle's stream.
   */
  const localWalletSynced = useRef(false);
  /**
   * This wallet's own receiving address, for the incoming-transfer watch.
   *
   * A ref rather than the state it mirrors: the watch subscribes to a balance
   * stream and must not resubscribe every time an address is re-read.
   */
  const unshieldedAddressRef = useRef<string | null>(null);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    unshieldedAddressRef.current = localSurfaces?.unshieldedAddress ?? null;
  }, [localSurfaces]);

  /**
   * Records something that happened, for the trail Home renders.
   *
   * Two things are stamped rather than passed: the clock, and the network. The
   * network is the one a row's explorer link is built from later, and it is
   * fixed at the moment the row is written because that is when it was true —
   * see {@link ActivityEntry.network}.
   *
   * {@link ACTIVITY_KEEP} rows are held rather than the ten Home OPENS on. The
   * feed is persisted and paged — a press reveals the next ten, down to all
   * fifty — so a trail that forgot everything past the first ten would have
   * nothing to restore after a reload and nothing to disclose before one.
   */
  const addActivity = useCallback(
    (entry: Omit<ActivityEntry, 'id' | 'createdAt' | 'network'>) => {
      const value = {
        ...entry,
        network: selectedNetwork,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      setActivity((current) => [value, ...current].slice(0, ACTIVITY_KEEP));
      return value;
    },
    [selectedNetwork],
  );

  const updateActivity = useCallback((id: string, patch: Partial<Omit<ActivityEntry, 'id' | 'createdAt'>>) => {
    setActivity((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  /* ---------------------------------------------------------------------- */
  /* The trail, across reloads                                              */
  /*                                                                        */
  /* Keyed by credential: a browser can hold several Passports and one       */
  /* Passport's transfers are not another's to show. The two `localStorage`  */
  /* calls are here rather than in `lib/activityFeed.ts` because that module */
  /* is in the 100% denominator and storage cannot be drilled without a fake */
  /* DOM — the parse that refuses junk and the writer that caps what is kept */
  /* are the halves that CAN be, and both are.                              */
  /* ---------------------------------------------------------------------- */
  const activityCredentialId = profile?.passkey?.credentialId ?? null;
  /* Nothing is written back until the stored trail has been read for THIS
     credential. Without the gate the save effect's first pass would write the
     empty initial state over a real trail. */
  const activityLoadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!activityCredentialId) {
      activityLoadedFor.current = null;
      return;
    }
    let stored: ActivityEntry[] = [];
    try {
      stored = readStoredActivity(
        window.localStorage.getItem(activityStorageKey(activityCredentialId)),
      );
    } catch {
      // Storage blocked or unreadable. A trail is a convenience; a Passport
      // that cannot remember one still works.
      stored = [];
    }
    activityLoadedFor.current = activityCredentialId;
    /* MERGED, not replaced. Rows are written during onboarding — before the
       profile that names the credential exists — and replacing here would
       throw away the account deploy the user just watched happen. */
    setActivity((current) => {
      const known = new Set(current.map((entry) => entry.id));
      const merged = [...current, ...stored.filter((entry) => !known.has(entry.id))];
      merged.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      return merged.slice(0, ACTIVITY_KEEP);
    });
  }, [activityCredentialId]);

  useEffect(() => {
    if (!activityCredentialId || activityLoadedFor.current !== activityCredentialId) return;
    try {
      window.localStorage.setItem(
        activityStorageKey(activityCredentialId),
        serialiseActivity(activity),
      );
    } catch {
      // Full, or blocked. Nothing on screen depends on the write succeeding.
    }
  }, [activity, activityCredentialId]);

  // Does this browser already hold a passkey Passport? Answered once, before
  // any sign-in, so onboarding can order and enable its options honestly.
  // Also runs the one-time legacy-profile migration to per-credential keys.
  useEffect(() => {
    let current = true;
    void resolveDefaultLocalProfile()
      .then((stored) => {
        if (current) setLocalPassportKnown(Boolean(stored));
      })
      .catch(() => {
        // Storage is unreadable. Offering "Sign in" and letting it fail with a
        // real message beats claiming no passkey exists.
        if (current) setLocalPassportKnown(null);
      });
    return () => {
      current = false;
    };
  }, []);

  // A local wallet holds live indexer and relay sockets. Close it when the app
  // goes away rather than leaking them into the next page.
  useEffect(
    () => () => {
      const handle = localWalletRef.current;
      localWalletRef.current = null;
      if (handle) void handle.close().catch(() => undefined);
    },
    [],
  );

  /**
   * The one surfaces object every shared consumer reads — the Receive sheet,
   * the Apps profile, the dApp consent bridge, and the legacy-funds gate. There
   * is one wallet behind it now, so this is an alias rather than a choice; the
   * loading / ready / partial / unavailable semantics — including the
   * distinction between a real `'0'` and an unknown `null` — are the local
   * wallet's own.
   */
  const activeSurfaces: LocalWalletSurfaces | null = localSurfaces;

  const keyProviderFor = useCallback((passkey: DemoPassportProfile['passkey']) => {
    let keyProvider = passportKeyProviders.current.get(passkey.credentialId);
    if (!keyProvider) {
      keyProvider = new WebAuthnPrfKeyProvider(passkey);
      passportKeyProviders.current.set(passkey.credentialId, keyProvider);
    }
    return keyProvider;
  }, []);

  const vault = useCallback(
    (passkey: DemoPassportProfile['passkey']) =>
      new EncryptedPassportPrivateStateStore(
        new IndexedDbPassportEncryptedRecordStore(),
        keyProviderFor(passkey),
      ),
    [keyProviderFor],
  );

  /**
   * Reads and validates the encrypted device state.
   *
   * `store` defaults to the profile's own vault, which costs a passkey
   * assertion of its own. The single-sign flows pass a one-shot store built
   * over an assertion they have ALREADY made, so unlocking the state and
   * deriving the wallet seed share one ceremony.
   */
  const loadPassportState = async (
    activeProfile: DemoPassportProfile,
    stateScope = scope,
    store: ReturnType<typeof vault> = vault(activeProfile.passkey),
  ): Promise<PassportDemoState> => {
    const injection = await PassportStateInjection({
      store,
      scope: stateScope,
      initialPrivateState: {
        deviceSecret: new Uint8Array(),
        createdAt: '',
        schema: 4,
      } satisfies PassportDemoState,
    });
    if (injection.source !== 'stored') {
      throw new Error('No encrypted Passport key record exists in this browser. Create a Passport key first.');
    }
    const state = injection.privateState;
    if (!(state.deviceSecret instanceof Uint8Array) || state.deviceSecret.byteLength !== 32) {
      throw new Error('The encrypted Passport device state is invalid. Create a new Passport key before deploying.');
    }
    return state;
  };

  /* ---------------------------------------------------------------------- */
  /* Passkey-only wallet                                                     */
  /*                                                                          */
  /* The passkey is enrolled or asserted, its PRF output is turned into a     */
  /* 32-byte Midnight seed, and the wallet is built in this tab by            */
  /* lib/localWallet.ts.                                                      */
  /* ---------------------------------------------------------------------- */

  const closeLocalWallet = useCallback(async () => {
    const handle = localWalletRef.current;
    localWalletRef.current = null;
    if (!handle) return;
    try {
      await handle.close();
    } catch {
      // Closing is best-effort; a failed teardown must not block a new wallet.
    }
  }, []);

  /**
   * The open wallet and the account contract it signs for, or `null`.
   *
   * Read from the contract STORE rather than from `contractRecords` state, so
   * this can be a stable callback: the store is the same source that state
   * subscribes to, and a synchronous read of it can never be a render behind.
   * Both halves are required — a contract with no wallet cannot be called, and
   * a wallet with no contract has nothing to call.
   */
  const accountContractOf = useCallback((): {
    handle: LocalMidnightWallet;
    address: string;
  } | null => {
    const handle = localWalletRef.current;
    const activeProfile = profileRef.current;
    if (!handle || !activeProfile) return null;
    const record = loadPassportContractRecord(
      activeProfile.passkey.credentialId,
      handle.network.networkId,
    );
    if (record?.status !== 'deployed' || !record.address) return null;
    return { handle, address: record.address };
  }, []);

  /**
   * Reads the account contract's own ledger — the figures Home shows.
   *
   * Deliberately uncached and deliberately not smoothed: a read that could not
   * be made is `unavailable` with the module's own sentence, because an empty
   * balance map and a failed read look identical to a screen handed zeros, and
   * only one of them means this account holds nothing. With no deployed
   * contract there is nothing to read at all, which is `idle` — the asset row
   * is then absent rather than showing a balance nobody can spend.
   */
  const refreshAccountBalances = useCallback(async () => {
    const account = accountContractOf();
    if (!account) {
      setAccountBalances(NO_ACCOUNT_BALANCES);
      return;
    }
    setAccountBalances((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const { nightColourHex, readAccountState } = await import('./identity/accountCustody.js');
      const state = await readAccountState(account.handle.network, account.address);
      // A stale handle's read must never write over a newer wallet's figures.
      if (localWalletRef.current !== account.handle) return;
      const nightColour = normalisedColourHex(nightColourHex());
      setAccountBalances({
        night: (nightColour ? state.nightBalances.get(nightColour) : undefined) ?? 0n,
        shielded: [...state.shieldedCoins]
          .filter(([, amount]) => amount > 0n)
          .map(([colourHex, amount]) => ({ colourHex, amount })),
        status: 'ready',
        error: null,
      });
    } catch (cause) {
      if (localWalletRef.current !== account.handle) return;
      /* The figures go with the read that failed. Keeping the last ones on
         screen beneath a notice saying they could not be read would be the
         screen telling two stories at once — and a stale balance is exactly the
         thing a user would act on. */
      setAccountBalances({
        night: null,
        shielded: [],
        status: 'unavailable',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [accountContractOf]);

  /**
   * Refreshes the wallet's own surfaces AND the account contract's balances.
   *
   * One call, because they are one refresh to every caller: the wallet is what
   * pays the fee on the one transaction it originates, and the account is what
   * the user is shown. The account read is not awaited — it is an indexer
   * round-trip, and nothing that calls this is waiting on a figure.
   *
   * WHY THE WALLET'S OWN BALANCE IS STILL READ. Exactly one surface consumes
   * it: the legacy-funds gate (`walletHeldNight` → `homeLegacyFunds`), which
   * offers to `deposit_night` money that reached the wallet address from
   * outside. Nothing else on any screen shows a wallet balance, nothing spends
   * from one, and no claim consults one. If that card ever goes, this read goes
   * with it.
   */
  const refreshLocalBalances = useCallback(async () => {
    void refreshAccountBalances();
    const handle = localWalletRef.current;
    if (!handle) return;
    setLocalSurfaces((current) =>
      current ? { ...current, balanceStatus: 'loading', balanceError: null } : current,
    );
    // `getBalances` never throws: a failure arrives as balanceStatus
    // 'unavailable' plus a balanceError, which Home already knows how to show.
    const balances = await handle.getBalances();
    if (localWalletRef.current !== handle) return;
    setLocalSurfaces((current) => ({
      ...(current ?? initialLocalSurfaceState(handle)),
      ...balances,
    }));
  }, [refreshAccountBalances]);

  /**
   * Builds the wallet from an already-derived seed and publishes its address
   * surfaces. Owns the seed: it is zeroed here whatever happens.
   */
  const openLocalWalletWithSeed = useCallback(
    async (
      seed: Uint8Array,
      scope: { appId: string; accountId: string },
      credentialId: string | null,
    ) => {
      const { createLocalMidnightWallet } = await import('./lib/localWallet.js');
      setLocalWalletStatus('opening');
      // §2.2 stopgap (see the banner near LOCAL_SCOPE): persist the wrapped
      // seed so a reload silently reopens this session without a passkey
      // prompt. Best-effort — a storage failure never blocks the live session.
      try {
        await persistWalletSession(scope, seed, credentialId);
      } catch {
        // No persisted session, then; the next reload asks for the passkey.
      }
      let wallet: LocalMidnightWallet;
      try {
        setOnboardingBusyLabel('Opening your Passport');
        wallet = await createLocalMidnightWallet(seed);
      } finally {
        // The seed's only job is done. Nothing retains it past this point.
        seed.fill(0);
      }
      await closeLocalWallet();
      localWalletRef.current = wallet;
      setLocalWalletNetworkId(wallet.network.networkId);
      setLocalWalletProvingMode(wallet.provingMode);
      // Addresses are known immediately; balances are still unknown, and say so.
      setLocalSurfaces(initialLocalSurfaceState(wallet));
      setLocalWalletStatus('ready');
      // The first balance read waits on indexer sync, so it runs behind the
      // screen rather than holding onboarding open.
      void refreshLocalBalances();
    },
    [closeLocalWallet, refreshLocalBalances],
  );

  /* The old `openLocalWallet` — derive-the-seed-with-its-own-assertion — is
     gone (2026/08/06). It was the second and third passkey prompt: both
     onboarding journeys now derive the seed from the ceremony that already
     unlocked the profile. See `createLocalPassportProfile` and
     `unlockLocalPassportProfile`. */

  // §2.2 session-stopgap restore: if a persisted session exists, unwrap the
  // seed and rebuild the wallet silently — no passkey ceremony — landing the
  // returning user on Home. Sign-out clears the session, so a signed-out
  // reload lands on onboarding as before. The effect's deps are stable
  // callbacks, so it runs on mount; cancellation (not a one-shot ref, which
  // StrictMode's mount–unmount–remount would defeat) keeps it single-flight.
  useEffect(() => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
    };
    sessionRestoreCancel.current = abort;
    // The restore is silent and abandonable; a ceremony the user actually
    // started is not. Any of these means this effect must not touch state.
    const superseded = () => cancelled || onboardingRunning.current;
    void (async () => {
      // A wallet is already open — nothing to restore over.
      if (localWalletRef.current || superseded()) return;
      const restored = await loadPersistedWalletSession();
      if (!restored) return;
      const seed = restored.seed;
      if (superseded()) {
        seed.fill(0);
        return;
      }
        setLocalWalletStatus('opening');
      setOnboardingBusyLabel('Reopening your Passport');
      try {
        const { createLocalMidnightWallet } = await import('./lib/localWallet.js');
        let wallet: LocalMidnightWallet;
        try {
          wallet = await createLocalMidnightWallet(seed);
        } finally {
          seed.fill(0);
        }
        // Last check before the only mutation that could collide with a
        // ceremony: whoever the user asked for keeps the wallet.
        if (superseded()) {
          void wallet.close().catch(() => undefined);
          return;
        }
        await closeLocalWallet();
        localWalletRef.current = wallet;
        setLocalWalletNetworkId(wallet.network.networkId);
        setLocalWalletProvingMode(wallet.provingMode);
        setLocalSurfaces(initialLocalSurfaceState(wallet));
        setLocalWalletStatus('ready');
        pushToast({
          tone: 'info',
          title: 'Welcome back',
          body: 'Session restored on this device.',
        });
        void refreshLocalBalances();
        // The profile is public metadata; restoring it keeps the display
        // side of the session (and the enrolled-passkey answer) in step.
        // Sessions record their credential; ones written before that belong
        // to the migrated legacy record.
        const stored = restored.credentialId
          ? await loadLocalProfileByCredential(restored.credentialId).catch(() => null)
          : await migrateLegacyLocalProfile().catch(() => null);
        if (!superseded() && stored) {
          setProfile(stored);
          setLocalPassportKnown(true);
        }
      } catch {
        // The persisted session could not be reopened (for example, the
        // network is unreachable). Fall back to onboarding; the session
        // record is kept so a later reload can try again.
        if (!superseded()) setLocalWalletStatus('idle');
      } finally {
        // A ceremony owns the busy label once it has started; clearing it here
        // would blank the label out from under it.
        if (!superseded()) setOnboardingBusyLabel(null);
      }
    })();
    return () => {
      cancelled = true;
      if (sessionRestoreCancel.current === abort) sessionRestoreCancel.current = null;
    };
  }, [closeLocalWallet, refreshLocalBalances]);

  /* ---------------------------------------------------------------------- */
  /* largeBlob — account metadata that travels with the passkey              */
  /* ---------------------------------------------------------------------- */

  /**
   * Persists a patch to the stored profile in BOTH places that read it: the
   * record on disk, so the next session knows, and this session's state, so a
   * second claim does not re-ask a question already answered. A storage
   * failure is a non-event — the worst it costs is one more attempt later.
   */
  const patchProfile = useCallback(
    async (
      activeProfile: DemoPassportProfile,
      patch: Partial<DemoPassportProfile>,
    ): Promise<void> => {
      const updated: DemoPassportProfile = { ...activeProfile, ...patch };
      setProfile((current) =>
        current && current.subjectId === activeProfile.subjectId ? updated : current,
      );
      await saveDemoProfile(updated).catch(() => {});
    },
    [],
  );

  /**
   * REMEMBERS the account this Passport now holds. Prompts for nothing.
   *
   * This is the whole of what a finished claim does about the passkey, and the
   * change is deliberate (2026/08/31). It used to call `writeAccountBlob`
   * here, fire-and-forget, on the reasoning that the write would ride the
   * gesture that earned the claim's own prompt. It did not: a claim is minutes
   * of chain work, a largeBlob write may not be paired with the read every
   * other assertion makes, and so it was a second whole user-verified
   * assertion. The product owner met it as a macOS passkey prompt sitting on
   * top of a finished Home screen — name registered, account deployed,
   * balances rendered — having pressed nothing to summon it.
   *
   * The bytes still reach the passkey. They go on during the next assertion
   * the user asks for anyway (see {@link unlockLocalPassportProfile}), where
   * the largeBlob slice is free and the read it displaces is worthless to a
   * browser that already holds the record. Arriving on Home costs nothing.
   */
  const noteAccountForPasskey = useCallback(
    async (
      activeProfile: DemoPassportProfile,
      account: { address: string; network: string },
      alias?: string,
    ): Promise<void> => {
      const note = accountToRemember(activeProfile, account, alias);
      if (!note) return;
      await patchProfile(activeProfile, { accountOnPasskey: note });
    },
    [patchProfile],
  );

  /**
   * Records what an assertion that CARRIED a write made of it, and says so
   * once — in the activity trail, where the user can go and look.
   *
   * A refusal records nothing and is retried on the next assertion; a platform
   * with no largeBlob at all is a permanent answer for this credential and
   * stops the ride-along for good. Neither is surfaced: nothing the user did
   * failed, and there is nothing for them to act on.
   */
  const settleAccountOnPasskey = useCallback(
    async (
      activeProfile: DemoPassportProfile,
      outcome: PassportAccountBlobWriteOutcome | null,
    ): Promise<void> => {
      const patch = settledAccountOnPasskey(activeProfile, outcome);
      if (!patch) return;
      await patchProfile(activeProfile, patch);
      if (outcome !== 'written') return;
      addActivity({
        label: 'Passport saved to your passkey',
        detail:
          'A new device signing in with this passkey can now find your Passport on its own. No keys were stored — only where to look.',
        status: 'complete',
        source: 'local',
      });
    },
    [addActivity, patchProfile],
  );

  /**
   * Writes down an account that has ANSWERED — the end of a successful
   * recovery, from the sign-in itself or from the search that followed it.
   *
   * `recovered: true` is load-bearing: it is what stops every surface showing
   * a deployment transaction this device never saw.
   */
  const saveRecoveredAccount = useCallback(
    (credentialId: string, account: AccountFromBlobAccount): void => {
      savePassportContractRecord({
        credentialId,
        network: account.network,
        status: 'deployed',
        address: account.address,
        recovered: true,
        ledgerConfirmed: true,
        updatedAt: new Date().toISOString(),
      });
      addActivity({
        label: 'Passport restored',
        detail: `Your account was read from your passkey and confirmed on ${account.network}. This device never saw it being set up, so there is no transaction to show for it.`,
        status: 'complete',
        source: 'chain',
      });
      pushToast({
        tone: 'success',
        title: 'Your account is back',
        body: 'Read from your passkey and confirmed on Midnight.',
      });
    },
    [addActivity],
  );

  /**
   * Sign-in recovery: what a blob read off the passkey is worth, and what is
   * kept while the chain is still being asked.
   *
   * THE DEFECT THIS REPLACES (reproduced 2026/09/03). The old shape was one
   * indexer read and a straight discard on anything but `true`. A browser whose
   * site data had been cleared — which iOS does by itself after seven days away
   * — signed in with the passkey that held the account, met one bad read, and
   * was left holding NOTHING: no account, no name, and no trace but a line in
   * an activity trail it could not reach. The screen it landed on was "Choose
   * your .night name", over a Passport that already had one, where claiming
   * again would set up a second account and pay for a second name.
   *
   * So the blob is treated as what it is: evidence, written by this Passport,
   * onto its own credential. `src/lib/accountOnPasskey.ts` holds the rule; this
   * is the wiring, and it does three things the old path did not:
   *
   *   - it KEEPS the account before the chain has answered — on the profile,
   *     where a reload still finds it — and restores the name that came with
   *     it, so the person lands on their own Passport rather than on a naming
   *     ceremony they have already been through;
   *   - it goes on ASKING, on a bounded backoff (see the effect below), and
   *     upgrades to a recorded account the moment the chain answers;
   *   - and when the asking runs out it hands the user a screen with two
   *     controls rather than silence.
   *
   * What it still refuses to do is overrule this device's own witness: a record
   * here for a different address is a conflict, and the record stays.
   */
  const recoverAccountFromPasskey = useCallback(
    async (
      activeProfile: DemoPassportProfile,
      blob: PassportAccountBlob | null,
    ): Promise<void> => {
      try {
        const credentialId = activeProfile.passkey.credentialId;
        const handle = localWalletRef.current;
        const context = {
          // The read-back can only happen against the open wallet's own indexer.
          walletNetwork: handle?.network.networkId ?? null,
          localRecord: blob ? loadPassportContractRecord(credentialId, blob.acc.network) : null,
          hasLocalAlias: blob ? loadAliasRecord(blob.acc.network) !== null : false,
        };
        const pending = accountFromBlob(blob, context, 'unconfirmed');
        if (pending.kind === 'conflict') {
          /* Both cannot be this Passport's account, and the one this device
             watched being made is the one it has evidence for. Said out loud
             rather than silently resolved, because it is the one outcome a
             person might want to act on. */
          addActivity({
            label: 'Your passkey names a different account',
            detail:
              'This device already holds an account for this Passport, so the one written on your passkey was left alone. Nothing was changed.',
            status: 'blocked',
            source: 'local',
          });
          return;
        }
        const indexerUrl = handle?.network.indexerHttpUrl ?? null;
        if (pending.kind !== 'adopt-checking' || !indexerUrl) return;
        const account = pending.account;
        /* HELD BEFORE IT IS CHECKED. The note is what a reload reads, and the
           name is what keeps this Passport off the name step; neither claims
           the account has been seen on chain, which is what a contract record
           would claim and why one is not written here. */
        await patchProfile(activeProfile, {
          accountOnPasskey: {
            address: account.address,
            network: account.network,
            ...(account.alias ? { alias: account.alias } : {}),
            /* It came OFF the credential, so it is already on it: nothing is
               owed to a future assertion. */
            written: true,
          },
        });
        const restoredAlias = aliasFromRecoveredAccount(account, new Date().toISOString());
        if (restoredAlias) saveAliasRecord(restoredAlias);
        const { confirmPassportContractOnLedger } = await import('./identity/passportContract.js');
        const confirmed = await confirmPassportContractOnLedger(indexerUrl, account.address);
        const settled = accountFromBlob(blob, context, confirmed ? 'confirmed' : 'unconfirmed');
        if (settled.kind === 'adopt-confirmed') {
          saveRecoveredAccount(credentialId, settled.account);
          return;
        }
        /* Not answered for yet. The search below keeps asking; Home says the
           account is being set up while it does. */
        setAccountSearch({
          address: account.address,
          network: account.network,
          alias: account.alias ?? null,
          attempt: 0,
          phase: 'checking',
        });
      } finally {
        setRecoveringAccount(false);
      }
    },
    [addActivity, patchProfile, saveRecoveredAccount],
  );

  /**
   * Marks a sign-in as one that is carrying an account to recover, BEFORE the
   * wallet opens. See {@link recoveringAccount} for why the moment matters.
   */
  const armAccountRecovery = (blob: PassportAccountBlob | null): void => {
    if (blob) setRecoveringAccount(true);
  };

  /**
   * A private-state store bound to ONE already-made assertion.
   *
   * Every `getKey` answers from the retained PRF output of that ceremony
   * rather than starting a new one, and derives byte-identically to the
   * targeted provider for the same scope.
   */
  const oneShotVaultFor = useCallback(
    (handle: DiscoveredPassportPasskey) =>
      new EncryptedPassportPrivateStateStore(new IndexedDbPassportEncryptedRecordStore(), {
        getKey: (keyScope) => handle.deriveStateKey(keyScope),
      }),
    [],
  );

  /**
   * Takes whichever resident credential answered a discoverable assertion and
   * makes it this session's Passport: signs in to the profile bound to it, or
   * binds a fresh profile to it when this browser has no record of it.
   *
   * Shared by "Use a different passkey" and by the create path's
   * discover-before-create guard, so both land in exactly the same place. The
   * caller owns `discovered` and disposes it.
   */
  const adoptDiscoveredPasskey = async (
    discovered: DiscoveredPassportPasskey,
  ): Promise<DemoPassportProfile> => {
    const known = await loadLocalProfileByCredential(discovered.credentialId).catch(() => null);
    if (known) {
      setOnboardingBusyLabel('Unlocking your Passport');
      const scope = localScopeFor(known);
      // Same PRF output, same HKDF constants as the targeted path — the
      // one assertion already made is enough to derive this profile's seed.
      const seed = await discovered.deriveWalletSeed(scope);
      setProfile(known);
      setLocalPassportKnown(true);
      // Held before the wallet opens: see `recoveringAccount`.
      armAccountRecovery(discovered.accountBlob);
      await openLocalWalletWithSeed(seed, scope, known.passkey.credentialId);
      await recoverAccountFromPasskey(known, discovered.accountBlob);
      addActivity({
        label: 'Signed in',
        detail: 'Opened with a passkey chosen from this device.',
        status: 'complete',
        source: 'local',
      });
      storeLastPasskey(discovered.credentialId);
      return known;
    }
    setOnboardingBusyLabel('Creating a Passport for this passkey');
    const accountId = localCredentialAccountId(discovered.credentialId);
    const scope = { appId: APP_ID, accountId };
    const hostname = window.location?.hostname;
    const nextProfile: DemoPassportProfile = {
      subjectId: localProfileId(discovered.credentialId),
      passkey: {
        credentialId: discovered.credentialId,
        label: 'Midnight Passport',
        ...(hostname ? { rpId: hostname } : {}),
      },
      accountId,
      createdAt: new Date().toISOString(),
    };
    const state: PassportDemoState = {
      deviceSecret: newDeviceSecret(),
      recoverySecret: newDeviceSecret(),
      createdAt: new Date().toISOString(),
      schema: 4,
    };
    // Encrypt the initial private state with a key derived from the SAME
    // assertion — no second passkey prompt, and byte-identical to what
    // the targeted provider would derive for this scope.
    await oneShotVaultFor(discovered).save<PassportDemoState>(scope, state);
    await saveDemoProfile(nextProfile);
    await requestPassportStoragePersistence();
    setProfile(nextProfile);
    setLocalPassportKnown(true);
    // A Passport that did not exist here a moment ago: the name step is
    // part of ITS setup. A sign-in to a known profile never arms it.
    identityStepArmed.current = true;
    const seed = await discovered.deriveWalletSeed(scope);
    armAccountRecovery(discovered.accountBlob);
    await openLocalWalletWithSeed(seed, scope, discovered.credentialId);
    /* The fresh-device case this whole mechanism exists for: a passkey
       synced here from another device, no local records at all, and its
       blob naming the account to look for. */
    await recoverAccountFromPasskey(nextProfile, discovered.accountBlob);
    addActivity({
      label: 'Passport created',
      detail: 'This passkey now holds its own Passport on this device.',
      status: 'complete',
      source: 'local',
    });
    // Same rule as the create journey above: the welcome screen says this.
    if (welcomeSeen(discovered.credentialId)) {
      pushToast({
        tone: 'success',
        title: 'Passport created',
        body: 'This passkey now holds its own Passport on this device.',
      });
    }
    storeLastPasskey(discovered.credentialId);
    return nextProfile;
  };

  /**
   * Every credential this browser still knows about, for `excludeCredentials`.
   *
   * It is what makes the authenticator ITSELF refuse to replace a Passport
   * passkey rather than silently overwriting it, so no create path may skip
   * it — see `enrollWithPrf`, which turns that refusal into
   * {@link PassportEnrolmentConflictError}. Empty on a genuinely first visit,
   * which is the case discovery covers instead.
   */
  /**
   * Turns a failed CREDENTIAL ceremony into the way out the screen will offer.
   *
   * Every sign-in journey funnels its ceremony failure through here, and it is
   * one function rather than a `catch` apiece so the targeted unlock behind
   * "Continue with Passport" and the discoverable assertion behind "Use a
   * different passkey" cannot drift into offering different things for the
   * same fact. `passkeySignInRecovery` holds the rule and the reasoning; this
   * is only the wiring between it, the two panel states, and the error the
   * caller rethrows.
   *
   * It is called ONLY around the ceremony itself — never around the wallet
   * bring-up or the state decryption that follow it. A credential that worked
   * is not a credential worth replacing, and a new passkey would leave a
   * failed decryption exactly as failed.
   *
   * Returns what to throw, so the caller reads `throw signInCeremonyFailure(cause)`
   * and nothing else about the failure has to be remembered.
   */
  const signInCeremonyFailure = (cause: unknown): unknown => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const recovery = passkeySignInRecovery({
      stage: 'credential',
      /* The authenticator's own reason, where the discoverable path preserved
         it. The targeted path flattens its DOMException to text on the way out
         of the backend, so `null` here means "not said", which the rule reads
         as keyless — the honest answer when WebAuthn will not distinguish a
         dismissed sheet from an empty one. */
      reason: cause instanceof PassportPasskeyDiscoveryError ? cause.reason : null,
      timedOut: cause instanceof PasskeyCeremonyTimeout,
    });
    if (recovery === 'unusable-credential') {
      setUnusableCredential(detail);
      return new PasskeyWayOutError(UNUSABLE_CREDENTIAL_MESSAGE, detail);
    }
    if (recovery === 'none') return cause;
    setKeylessPasskey(KEYLESS_PASSKEY_MESSAGE);
    return new PasskeyWayOutError(KEYLESS_PASSKEY_MESSAGE, detail);
  };

  const knownLocalCredentialIds = async (): Promise<string[]> =>
    (await listLocalProfiles().catch(() => []))
      .map((candidate) => candidate.passkey.credentialId)
      .filter((credentialId): credentialId is string => Boolean(credentialId));

  /**
   * The authenticator refused to overwrite a passkey it still holds — the
   * guard working, not a failure. The Passport is intact and the only honest
   * move is to sign the user into it.
   */
  const signInAfterEnrolmentConflict = async (): Promise<{
    profile: DemoPassportProfile;
    created: boolean;
  }> => {
    setOnboardingIntent('local-signin');
    setOnboardingBusyLabel('You already have a Passport on this device — signing you into it');
    let recovered: DiscoveredPassportPasskey;
    try {
      recovered = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.discover());
    } catch {
      /* The authenticator has just PROVED it holds a Passport credential, by
         refusing to create over it. So this is the one failure on which
         offering to enrol would be wrong — it would be refused again, and the
         user would loop. Both controls the screen already carries do lead
         somewhere from here, and the sentence names them. */
      throw new Error(
        'You already have a Passport on this device. Choose "Use a different passkey" to pick it, or "Continue with Passport" to try again.',
      );
    }
    try {
      return { profile: await adoptDiscoveredPasskey(recovered), created: false };
    } finally {
      recovered.dispose();
    }
  };

  /**
   * Turns a freshly enrolled credential into an open Passport: per-credential
   * scope, encrypted state, wallet.
   *
   * Extracted on 2026/08/26 so the deliberate "create a new passkey" recovery
   * below reaches the SAME Passport a first-time create reaches, rather than a
   * second, subtly different transcription of these twenty lines.
   */
  const adoptEnrolledPasskey = async (
    enrolled: import('./backend.js').EnrolledPassportPasskey,
  ): Promise<DemoPassportProfile> => {
    const passkey = enrolled.reference;
    // New profiles bind to their credential: per-credential storage key and
    // per-credential scope, so a second passkey can never collide with this
    // one's encrypted state.
    const accountId = localCredentialAccountId(passkey.credentialId);
    const scope = { appId: APP_ID, accountId };
    let handle = enrolled.prf;
    try {
      if (!handle) {
        setOnboardingBusyLabel('Confirm with your passkey to finish setting up');
        handle = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.assertOnce(passkey));
      }
      const nextProfile: DemoPassportProfile = {
        subjectId: localProfileId(passkey.credentialId),
        passkey,
        accountId,
        createdAt: new Date().toISOString(),
        /* Recorded only when the platform gave a definite answer. `null` — an
           older client that ignored the extension — stays absent, so the first
           write attempt is still allowed to find out for itself. */
        ...(typeof enrolled.largeBlobSupported === 'boolean'
          ? { largeBlobSupported: enrolled.largeBlobSupported }
          : {}),
      };
      const state: PassportDemoState = {
        deviceSecret: newDeviceSecret(),
        recoverySecret: newDeviceSecret(),
        createdAt: new Date().toISOString(),
        schema: 4,
      };
      setOnboardingBusyLabel('Encrypting your Passport state on this device');
      await oneShotVaultFor(handle).save<PassportDemoState>(scope, state);
      await saveDemoProfile(nextProfile);
      await requestPassportStoragePersistence();
      setProfile(nextProfile);
      setLocalPassportKnown(true);
      // A brand-new Passport is the only session walked through the name step.
      identityStepArmed.current = true;
      // Same handle, same ceremony: the wallet seed costs no further prompt.
      const seed = await handle.deriveWalletSeed(scope);
      await openLocalWalletWithSeed(seed, scope, passkey.credentialId);
      return nextProfile;
    } finally {
      handle?.dispose();
    }
  };

  /**
   * THE WAY OUT of `unusable-credential`, and why creating here is defensible.
   *
   * A resident credential for this origin answered and returned no PRF output,
   * so it CANNOT open a Passport — there is no seed to derive from it and no
   * state it could decrypt. Passport still does not enrol over that on its own:
   * the credential that answered may be somebody else's Passport, and quietly
   * leaving a second passkey for this site beside it — which is all a create
   * can do since the user handle became random on 2026/09/03 — is not a
   * decision an app may take without saying so.
   *
   * It is a decision the USER may take, and this is the only path on which
   * they take it: they have been told, in as many words, that the passkey this
   * device offered cannot open a Passport, and they have pressed a button that
   * says it will make a new one. Two things still hold the line:
   *
   *   - `excludeCredentials` is still populated from `listLocalProfiles()`, so
   *     any credential THIS BROWSER has a Passport record for is still
   *     protected by the authenticator itself, and the refusal still arrives
   *     as `PassportEnrolmentConflictError` and still routes into sign-in
   *     rather than an error;
   *   - the credential that could not answer with a PRF is, by construction,
   *     not one of those records — it opens no Passport here.
   *
   * Before 2026/08/26 this state had no way out at all. It threw a message
   * advising "Use a different passkey", which runs `runDiscoverableSignIn` —
   * a discovery that can only ever assert, never enrol — so the same PRF-less
   * credential answered the picker again and the user looped. The only escape
   * was to dismiss the OS picker so the `cancelled` path fell through to
   * enrolment, which nobody could be expected to guess.
   *
   * SINCE 2026/08/30 IT IS ALSO THE WAY OUT OF `keylessPasskey` — a browser
   * holding Passport records whose credential the keystore will no longer
   * produce. That case is the reason to be precise about what a NEW passkey
   * does to the OLD records, and the answer, verified rather than assumed, is
   * that it does nothing to them:
   *
   *   - the profile record is stored under `localProfileId(credentialId)`, an
   *     IndexedDB key derived from the credential id, so a new credential gets
   *     a new key and the old record is still sitting there under its own;
   *   - the private state is stored under a key derived from the scope, and
   *     the scope's accountId is `localCredentialAccountId(credentialId)` — so
   *     no write under the new passkey can land on the old passkey's
   *     ciphertext, and no read under it can even address it;
   *   - and the old ciphertext is encrypted under a key HKDF'd from the old
   *     credential's PRF output, so it stays unreadable to everything but that
   *     credential, whatever any key collision might have done.
   *
   * The old Passport is therefore intact, not deleted and not overwritten. If
   * its passkey comes back — a keychain that syncs late, the right OS profile
   * — signing in with it reopens exactly the Passport it left. If it does not,
   * those records are recoverable only from a backup, which is what backup is
   * for; nothing here can derive a seed without the credential.
   *
   * The one thing that is NOT per-credential is the alias record
   * (`passport-alias:v1`, keyed by network), which a later claim under the new
   * passkey would replace. That is pre-existing multi-passkey behaviour rather
   * than anything this path introduces, and it is a display record: the name
   * itself is held on chain by the wallet that registered it.
   */
  const enrolNewLocalPassportProfile = async (): Promise<{
    profile: DemoPassportProfile;
    created: boolean;
  }> => {
    setOnboardingBusyLabel('Creating your Passport passkey');
    const knownCredentialIds = await knownLocalCredentialIds();
    let enrolled: import('./backend.js').EnrolledPassportPasskey;
    try {
      enrolled = await withPasskeyWatchdog(() =>
        WebAuthnPrfKeyProvider.enrollWithPrf({
          label: 'Midnight Passport',
          userId: LOCAL_ACCOUNT_ID,
          knownCredentialIds,
        }),
      );
    } catch (cause) {
      if (!(cause instanceof PassportEnrolmentConflictError)) throw cause;
      return signInAfterEnrolmentConflict();
    }
    return { profile: await adoptEnrolledPasskey(enrolled), created: true };
  };

  /**
   * First-time create — ONE enrolment, and at most ONE assertion.
   *
   * The enrolment asks the platform to evaluate the PRF there and then. Where
   * it obliges, that single ceremony yields both the private-state key and the
   * wallet seed and the user is prompted exactly once. Where it does not — the
   * common case, and never surfaced as an error — one targeted assertion
   * covers both. The old path cost three prompts: enrol, encrypt, derive.
   *
   * ASK THE AUTHENTICATOR BEFORE CREATING ANYTHING — BUT ONLY WHEN THERE IS
   * SOMETHING TO ASK ABOUT. "No local profile" is not the same fact as "no
   * passkey": site data cleared with the passkey still in the keychain looks
   * identical to a first visit. Until 2026/09/03 a `create` there REPLACED the
   * surviving credential — the user handle was a digest of a constant — taking
   * its PRF secret and every coin the wallet seed derives with it. The handle
   * is now random per enrolment (`demo-backend/src/passkey.ts#newUserHandle`),
   * so that credential can no longer be overwritten by anything this app does;
   * what a create still costs such a user is a SECOND Passport where they
   * meant to reopen their first. So when this browser knows of any credential,
   * discovery runs first and enrolment only follows if nothing answers.
   *
   * When it knows of none, discovery is skipped, because the dialog it raises
   * asks the wrong question of a newcomer and can leave them with no way
   * forward at all. See the note at the call below. `created` says which of
   * the two actually happened, so nothing downstream claims a Passport was
   * made when one was merely reopened.
   */
  const createLocalPassportProfile = async (): Promise<{
    profile: DemoPassportProfile;
    created: boolean;
  }> => {
    const existing = await resolveDefaultLocalProfile();
    if (existing) {
      setLocalPassportKnown(true);
      /* THE GUARD, AND THE WAY THROUGH IT. Creating here could replace a
         credential this browser's Passport depends on, so the create journey
         stops — but it stops POINTING SOMEWHERE. It used to name "Sign in", a
         control that has not existed since the one-button consolidation on
         2026/08/05, which made this a sentence about a button the reader could
         not find. It now names the button that is on the screen, and that
         button runs the targeted unlock; if the unlock cannot produce the
         credential, that path ends at the keyless panel with its create
         action. So the chain from here reaches a working Passport in every
         case, rather than terminating in advice. */
      throw new Error(
        'This browser already holds a Passport passkey. Choose "Continue with Passport" to reopen it.',
      );
    }
    const knownCredentialIds = await knownLocalCredentialIds();
    /* BUT DO NOT LEAD A NEWCOMER WITH A SIGN-IN DIALOG. Discovering first is
       right for a browser that has reason to think a passkey exists; it is
       wrong for one that does not. The discoverable assertion renders as
       "Use a saved passkey for this site", and a Chrome profile with nothing
       saved and no platform credential offers only "Use a phone or tablet"
       and "USB security key" — no way to make one. Reviewers stopped dead
       there, and the one who got through did so by signing with his phone,
       which was the only door left open. A browser that holds no credential
       we know of goes straight to enrolment, where the platform offers Touch
       ID, Windows Hello, or a phone, and the question asked is the one the
       user came to answer.

       What that costs is bounded, and since 2026/09/03 it is bounded at the
       right place: the create cannot replace anything, because the user handle
       is random per enrolment, and `knownCredentialIds` still makes the
       authenticator refuse outright for a credential this browser knows of.
       The user whose site data was cleared with the passkey surviving does
       still enrol a second credential instead of finding the first — their
       original is untouched, in the picker, holding the account blob, and
       "Use a different passkey" is the one control that reaches it. That is a
       recoverable wrong turn rather than the permanent loss it used to be. */
    const discoverFirst = knownCredentialIds.length > 0;
    setOnboardingBusyLabel(
      discoverFirst
        ? 'Checking this device for a Passport passkey'
        : 'Creating your Passport passkey',
    );
    let onboarding: import('./backend.js').PassportPasskeyOnboarding;
    try {
      onboarding = await withPasskeyWatchdog(() =>
        discoverFirst
          ? WebAuthnPrfKeyProvider.discoverOrEnroll({
              label: 'Midnight Passport',
              userId: LOCAL_ACCOUNT_ID,
              knownCredentialIds,
            })
          : WebAuthnPrfKeyProvider.enrollWithPrf({
              label: 'Midnight Passport',
              userId: LOCAL_ACCOUNT_ID,
              knownCredentialIds,
            }).then((enrolled) => ({
              outcome: 'enrolled' as const,
              discovered: null,
              enrolled,
            })),
      );
    } catch (cause) {
      if (!(cause instanceof PassportEnrolmentConflictError)) throw cause;
      return signInAfterEnrolmentConflict();
    }
    if (onboarding.outcome === 'unusable-credential') {
      /* A passkey for this site answered and cannot open a Passport: it
         returned no PRF output. Creating one under the same handle could
         replace it, so Passport will not do it unasked — but this is a state
         with a REAL way out, and since 2026/08/26 it offers one rather than
         describing one.

         What it used to say was false. It advised "Use a different passkey",
         which runs `runDiscoverableSignIn` — one discoverable assertion, which
         can never enrol — so a user whose only passkey for this origin has no
         PRF picked the same credential again and got the same sentence, for
         ever. The escape hatch was to dismiss the OS picker until the
         `cancelled` path fell through to enrolment, which is not a thing a
         person could be expected to work out.

         So the state is raised on its own, with the control that actually
         resolves it: `enrolNewLocalPassportProfile`, which enrols deliberately
         with the exclusion guard still on. The thrown message stays as the
         explanation and now describes the button beside it. */
      const detail =
        onboarding.message ||
        'A passkey on this device answered but does not support the extension Passport needs.';
      setUnusableCredential(detail);
      /* Thrown as a way-out failure so the banner stands down and the panel
         below is the only thing saying this. It used to be both, in two
         near-identical sentences, with the button underneath the second one. */
      throw new PasskeyWayOutError(UNUSABLE_CREDENTIAL_MESSAGE, detail);
    }
    if (onboarding.outcome === 'existing') {
      /* A passkey answered, so this device already has a Passport whatever
         local storage says. Sign in to it — one prompt, no enrolment, and the
         wallet seed comes from the assertion just made. */
      const recovered = onboarding.discovered;
      setOnboardingIntent('local-signin');
      try {
        return { profile: await adoptDiscoveredPasskey(recovered), created: false };
      } finally {
        recovered.dispose();
      }
    }
    setOnboardingBusyLabel('Creating your Passport passkey');
    return { profile: await adoptEnrolledPasskey(onboarding.enrolled), created: true };
  };

  /**
   * Sign-in — exactly ONE assertion.
   *
   * Decrypting the stored state proves the passkey is the right one (and fails
   * loudly if the record belongs to another device); the wallet seed comes
   * from the very same assertion instead of a second prompt.
   *
   * AND, SINCE 2026/08/31, IT CARRIES THE ACCOUNT BLOB. A claim only notes the
   * account it bound; the bytes go onto the credential here, in the largeBlob
   * slice of an assertion that was happening anyway. That slice is either a
   * read or a write and never both, so the trade is real — and it is free,
   * because a browser holding this profile already knows its own contract and
   * `recoverAccountFromPasskey` does nothing for it. The alternative was a
   * ceremony of its own, which is the prompt this app raised on Home for a
   * piece of metadata nobody asked to save. See `src/lib/accountOnPasskey.ts`.
   */
  const unlockLocalPassportProfile = async (): Promise<DemoPassportProfile> => {
    const existing = await resolveDefaultLocalProfile();
    if (!existing) {
      setLocalPassportKnown(false);
      /* The mirror of the create path's guard, and named after the same
         control for the same reason: "Create passkey" has not been on this
         screen since 2026/08/05. */
      throw new Error(
        'No Passport passkey is enrolled in this browser yet. Choose "Continue with Passport" to make one.',
      );
    }
    setOnboardingBusyLabel('Unlocking your Passport with this device');
    const unlockScope = localScopeFor(existing);
    /* THE KEYLESS DEAD END, CLOSED (2026/08/30).
       This is the exact ceremony the reported failure died on: a stored
       profile names a credential, the platform keystore can no longer produce
       it — deleted, another OS profile, never synced — and the "use a saved
       passkey" sheet comes back empty as `NotAllowedError`. Everything the
       user could see then was an explanation. `signInCeremonyFailure` raises
       the panel that offers to enrol instead, and the enrolment it offers
       still excludes this profile's credential, so a passkey that turns out to
       be alive after all is refused by the authenticator rather than replaced. */
    let handle: DiscoveredPassportPasskey;
    /* What this Passport owes its passkey, if anything. `null` on every
       session that owes nothing, and the assertion then reads as it always
       has. */
    const pendingBlob = pendingAccountBlob(existing);
    try {
      handle = await withPasskeyWatchdog(() =>
        WebAuthnPrfKeyProvider.assertOnce(
          existing.passkey,
          pendingBlob ? { writeAccountBlob: pendingBlob } : {},
        ),
      );
    } catch (cause) {
      throw signInCeremonyFailure(cause);
    }
    try {
      await loadPassportState(existing, unlockScope, oneShotVaultFor(handle));
      setProfile(existing);
      setLocalPassportKnown(true);
      const seed = await handle.deriveWalletSeed(unlockScope);
      armAccountRecovery(handle.accountBlob);
      await openLocalWalletWithSeed(seed, unlockScope, existing.passkey.credentialId);
      /* The blob rode in on the assertion above, so this costs no prompt. It
         does nothing at all unless this browser has no record of the account —
         which is exactly why the assertion above may spend its largeBlob slice
         writing instead. */
      await recoverAccountFromPasskey(existing, handle.accountBlob);
      /* What the write did, recorded rather than announced. Never awaited into
         the sign-in's own outcome: a blob is a nicety, and a signed-in
         Passport does not depend on one. */
      void settleAccountOnPasskey(existing, handle.accountBlobWritten);
      return existing;
    } finally {
      handle.dispose();
    }
  };

  const runLocalOnboarding = async (
    requested: 'create' | 'signin' | 'auto' | 'enrol-new',
  ) => {
    if (onboardingRunning.current) return;
    onboardingRunning.current = true;
    // A user-initiated ceremony wins over the silent §2.2 restore: two flows
    // must never race to replace `localWalletRef`.
    cancelSessionRestore();
    setOnboardingError(null);
    /* Whatever happens next supersedes the dead end. Cleared on the way IN as
       well as on success, so a second attempt is never read against the first
       attempt's explanation. Both way-out panels go: pressing either control
       is a new attempt, and the one being pressed is very often the button one
       of these panels put there. */
    setUnusableCredential(null);
    setKeylessPasskey(null);
    setError(null);
    // Provisional intent so the screen flips to its working stage at once;
    // the resolved journey below corrects the label.
    setOnboardingIntent(requested === 'signin' ? 'local-signin' : 'local-create');
    setOnboardingBusyLabel('Checking this browser for a Passport');
    // One button, both journeys (2026/08/05): a stored local profile means the
    // existing sign-in/unlock flow runs; a clean browser means enrolment.
    // WebAuthn discoverable credentials mean the assertion path also finds a
    // passkey synced from another device once a profile exists here.
    let intent: 'create' | 'signin' = requested === 'signin' ? 'signin' : 'create';
    let activeProfile: DemoPassportProfile | null = null;
    /* What the create journey DID, not what it set out to do: the
       discover-before-create guard may sign the user in instead of enrolling,
       and the copy below must not claim a Passport was created then. */
    let created = false;
    try {
      if (requested === 'auto') {
        const existing = await resolveDefaultLocalProfile().catch(() => null);
        intent = existing ? 'signin' : 'create';
      }
      setOnboardingIntent(intent === 'create' ? 'local-create' : 'local-signin');
      setOnboardingBusyLabel(
        intent === 'create' ? 'Creating your Passport passkey' : 'Unlocking your Passport',
      );
      // Both journeys now open the wallet from the SAME ceremony that unlocked
      // the profile — no second passkey prompt to derive the seed.
      if (requested === 'enrol-new') {
        /* The `unusable-credential` recovery, and the ONE path that enrols
           without discovering first. Everything the discover-before-create
           guard protects has already been established here: a credential
           answered, and it cannot open a Passport. See
           `enrolNewLocalPassportProfile` for why creating is the user's call
           to make and what still stops it replacing a real Passport. */
        const outcome = await enrolNewLocalPassportProfile();
        activeProfile = outcome.profile;
        created = outcome.created;
      } else if (intent === 'create') {
        const outcome = await createLocalPassportProfile();
        activeProfile = outcome.profile;
        created = outcome.created;
      } else {
        activeProfile = await unlockLocalPassportProfile();
      }
      storeLastPasskey(activeProfile.passkey.credentialId);
      setOnboardingError(null);
      addActivity({
        label: created ? 'Passport created' : 'Signed in',
        detail: created
          ? 'This passkey now holds its own Passport on this device.'
          : 'Opened with your passkey.',
        status: 'complete',
        source: 'local',
      });
      /* The toast says exactly what the welcome screen's own headline says, and
         it is pinned to the bottom of the viewport — which is where that
         screen's primary action is. So it is offered only to a creation that
         will NOT be welcomed: on a first Passport the screen is the
         confirmation, and a toast over its one button is not a celebration. */
      if (created && welcomeSeen(activeProfile.passkey.credentialId)) {
        pushToast({
          tone: 'success',
          title: 'Passport created',
          body: 'Your passkey now holds a Passport on this device.',
        });
      }
    } catch (cause) {
      const wayOut = cause instanceof PasskeyWayOutError;
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalWalletStatus('error');
      // A failure with a way out is explained by its own panel, which carries
      // the control that resolves it. See `PasskeyWayOutError`.
      setOnboardingError(wayOut ? null : message);
      addActivity({
        label:
          intent === 'create' && !created
            ? 'Passport could not be created'
            : 'Passport could not be opened',
        /* The trail keeps the platform's own words even where the screen shows
           ours: a diagnosis nobody can act on is still a diagnosis somebody
           may have to read later. */
        detail: wayOut ? cause.detail : message,
        status: 'error',
        source: 'local',
      });
    } finally {
      // The state key is cached for 30s inside the provider; drop it now that
      // the wallet is open. The wallet seed was never cached at all.
      if (activeProfile) {
        passportKeyProviders.current
          .get(activeProfile.passkey.credentialId)
          ?.lock(localScopeFor(activeProfile));
      }
      setOnboardingIntent(null);
      setOnboardingBusyLabel(null);
      /* A sign-in that never reached the recovery — the wallet refused to open,
         the state would not decrypt — must not leave the name step held open
         for a recovery that is not coming. */
      setRecoveringAccount(false);
      onboardingRunning.current = false;
    }
  };

  /**
   * "Use a different passkey" — one DISCOVERABLE assertion with no
   * allow-list, so the platform offers its own picker of resident passkeys
   * for this origin. Whichever credential answers: an existing profile bound
   * to it is signed in; a credential with no profile here gets one created
   * and bound to it — no enrolment, because the credential already exists.
   * Enrolment remains only on the true first-time create path.
   */
  const runDiscoverableSignIn = async () => {
    if (onboardingRunning.current) return;
    onboardingRunning.current = true;
    cancelSessionRestore();
    setOnboardingError(null);
    /* Same rule as `runLocalOnboarding`, and it was missing here: whatever
       happens next supersedes the last attempt's way-out panel, so a second
       try is never read against the first try's explanation. */
    setUnusableCredential(null);
    setKeylessPasskey(null);
    setError(null);
    setOnboardingIntent('local-signin');
    setOnboardingBusyLabel('Choose a passkey on this device');
    let discovered: import('./backend.js').DiscoveredPassportPasskey | null = null;
    let activeProfile: DemoPassportProfile | null = null;
    try {
      // Credential-key the legacy record first, so an existing single-profile
      // browser matches its own passkey below.
      await migrateLegacyLocalProfile().catch(() => null);
      /* The OTHER half of the keyless dead end. A picker the user dismisses
         and a picker with nothing in it are one and the same `NotAllowedError`
         to WebAuthn, and this path used to answer both with a sentence and no
         control — which is precisely where a user with no loadable passkey was
         being sent by the advice on the create path. It now ends where the
         targeted unlock ends: a panel offering to enrol one. */
      try {
        discovered = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.discover());
      } catch (cause) {
        throw signInCeremonyFailure(cause);
      }
      activeProfile = await adoptDiscoveredPasskey(discovered);
      setOnboardingError(null);
    } catch (cause) {
      const wayOut = cause instanceof PasskeyWayOutError;
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalWalletStatus('error');
      // The panel says it, and offers the button. A banner above it would say
      // it again. See `PasskeyWayOutError`.
      setOnboardingError(wayOut ? null : message);
      addActivity({
        label: 'Could not sign in',
        detail: wayOut ? cause.detail : message,
        status: 'error',
        source: 'local',
      });
    } finally {
      discovered?.dispose();
      if (activeProfile) {
        passportKeyProviders.current
          .get(activeProfile.passkey.credentialId)
          ?.lock(localScopeFor(activeProfile));
      }
      setOnboardingIntent(null);
      setOnboardingBusyLabel(null);
      onboardingRunning.current = false;
    }
  };

  // Live sync progress from the local wallet's state stream. Resubscribes per
  // wallet handle; on the transition to fully synced, refresh balances once so
  // the surfaces settle the moment the chain walk completes.
  useEffect(() => {
    if (localWalletStatus !== 'ready') {
      setLocalSyncPercent(null);
      localWalletSynced.current = false;
      return;
    }
    const handle = localWalletRef.current;
    if (!handle) return;
    let wasSynced = false;
    const unsubscribe = handle.subscribeSyncProgress((progress) => {
      setLocalSyncPercent(progress.percent);
      if (progress.synced && !wasSynced) {
        wasSynced = true;
        // Read by the incoming-transfer watch below, which must not mistake the
        // chain walk's own climbing balance for money arriving.
        localWalletSynced.current = true;
        pushToast({ tone: 'success', title: 'Passport synced' });
        void refreshLocalBalances();
      }
    });
    return () => {
      unsubscribe();
      setLocalSyncPercent(null);
      localWalletSynced.current = false;
    };
  }, [localWalletStatus, refreshLocalBalances]);

  /**
   * Live balances from the same wallet state stream the sync percent rides.
   *
   * This REPLACES the three-attempt 10 s DUST retry timer that used to sit
   * here. That loop existed because the only way DUST state ever settled was a
   * refresh the user could not know to press, and it gave up after thirty
   * seconds whether or not the wallet had caught up. Incoming NIGHT had no
   * equivalent at all — funds arrived and sat invisible until a page reload.
   * `subscribeBalances` covers both: every change the wallet sees, for as long
   * as the session lasts, with no timers on this side.
   *
   * Throttling is entirely the wallet's (Contract W's ≥4 s floor, leading and
   * trailing). This effect adds no debounce of its own — two independent
   * throttles over one stream would only make the delay harder to reason about.
   *
   * Battery sanity: while the tab is hidden the newest snapshot is stored and
   * NOT rendered, then flushed once on return to visible. A backgrounded
   * Passport therefore costs a ref write per emission and no React work.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready') return;
    const handle = localWalletRef.current;
    if (!handle) return;

    let pending: LocalWalletBalances | null = null;
    /** Last unshielded NIGHT this watch has seen, in whole micro-NIGHT. */
    let knownNight: bigint | null = null;

    const apply = (balances: LocalWalletBalances) => {
      // A stale handle's stream must never write over a newer wallet's numbers.
      if (localWalletRef.current !== handle) return;
      setLocalSurfaces((current) =>
        current ? { ...current, ...balances } : current,
      );
    };

    /**
     * Money arriving, announced from the only place that can see it.
     *
     * This runs on the RAW emission, ahead of the visibility deferral below,
     * and that ordering is the point: a backgrounded Passport is exactly the
     * Passport whose owner needs telling. Rendering still waits for the tab to
     * come back; the announcement does not.
     *
     * Three things it deliberately will not claim:
     *
     * - Nothing before the wallet reports fully synced. The chain walk credits
     *   historical blocks one at a time, and each step is a rise.
     * - Nothing off an unknown or unreadable balance. `null` is "the wallet
     *   could not say", never a zero to subtract from.
     * - Nothing on a fall or a flat reading, which is what an outgoing send
     *   and a DUST-only change respectively look like.
     *
     * A shielded receive is invisible here by construction — that is what
     * shielded means — and DUST accrual is not a transfer. Both are out of
     * scope for the same honest reason.
     */
    const watchForIncomingNight = (balances: LocalWalletBalances) => {
      if (localWalletRef.current !== handle) return;
      const next = parseNightUnits(balances.unshieldedBalance);
      if (next === null) return;
      const previous = knownNight;
      knownNight = next;
      if (previous === null || next <= previous) return;
      if (!localWalletSynced.current) return;
      const arrived = next - previous;
      /* NOT A RECEIPT — the sender's OWN first leg (2026/09/02). Paying a
         Passport pays the amount to the sender's own receiving address before
         paying it on, so the wallet really does see it arrive; announcing that
         as "NIGHT received" reports somebody's outgoing payment back to them as
         income, and the row then invites them to move into their account money
         that is on its way to somebody else. */
      if (
        pendingSendsRef.current.some(
          (record) =>
            record.kind === 'night' &&
            record.ownReceivingAddress === unshieldedAddressRef.current &&
            BigInt(record.amount) === arrived,
        )
      ) {
        return;
      }
      const amount = formatNightUnits(arrived);
      addActivity({
        label: 'NIGHT received',
        /* It arrived at the address the resolver leaf carries, which is the
           wallet's — so it is NOT yet in the account, and the contract cannot
           see it until a `deposit_night` moves it. Home offers exactly that;
           saying so here is the difference between a balance a user can find
           and one they cannot. */
        detail: `${amount} NIGHT arrived at your receiving address. Move it into your account to spend it.`,
        status: 'complete',
        source: 'chain',
      });
      pushToast({ tone: 'success', title: `${amount} NIGHT received` });
      /* Silent unless the user has turned notifications on for this device. */
      void notify('NIGHT received', `${amount} NIGHT arrived in your Passport.`, {
        tag: 'passport-night-received',
      });
    };

    const unsubscribe = handle.subscribeBalances((balances) => {
      watchForIncomingNight(balances);
      if (document.visibilityState === 'hidden') {
        pending = balances;
        return;
      }
      pending = null;
      apply(balances);
    });

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || pending === null) return;
      const latest = pending;
      pending = null;
      apply(latest);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [addActivity, localWalletStatus]);

  /* ---------------------------------------------------------------------- */
  /* Identity — claiming, queueing, and reclaiming a .night name             */
  /*                                                                         */
  /* A Passport alias IS a Midnames name. Everything below either reads the   */
  /* deployed registry or submits a real transaction to it; the only other    */
  /* state is 'queued', which always carries the reason it is not on chain.   */
  /* The passkey is NEVER re-enrolled here — it is the login credential for   */
  /* every network, and only the name is per network.                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Probe the NAME sponsor once the name step is actually on screen, so the
   * sentence there describes what will really happen.
   *
   * Deliberately `aliasSponsorshipLikely` and not the fee sponsor. The claim
   * screen makes exactly one promise — the Passport service registers this name
   * and pays for it — and only `/status` reporting `aliasSponsorship:
   * "available"` on THIS network makes that true. The fee sponsor is a
   * different service answering a different question (who pays the DUST on the
   * account deploy), and quoting it here once let the screen promise a
   * registration nobody was going to make.
   *
   * A failed or disabled probe leaves this false — the honest baseline, under
   * which the screen says the name is kept and registered when the service is
   * back — and is never surfaced as an error, because queued is a working
   * state, not a fault.
   */
  useEffect(() => {
    if (identityStep !== 'alias') return undefined;
    /* The claim's four chunks, started the moment the screen mounts rather
       than when the button is pressed. The user is about to spend at least a
       few seconds choosing a name, and this is the work that used to happen
       in the silence after their click (see `warmClaimModules`). */
    warmClaimModules();
    let live = true;
    void (async () => {
      const sponsored = await aliasSponsorshipLikely(selectedNetwork).catch(() => false);
      if (live) setNameSponsored(sponsored);
    })();
    return () => {
      live = false;
    };
  }, [identityStep, selectedNetwork]);

  // The stores are the seam every writer shares: Contract R's connector calls
  // `saveIncentive` directly, and this subscription is what re-renders Home.
  useEffect(() => subscribeAliasRecords(setAliasRecords), []);
  useEffect(() => subscribeIncentives(setIncentives), []);
  useEffect(() => subscribePassportContractRecords(setContractRecords), []);

  /**
   * KEEP ASKING — the bounded search for an account a passkey named and the
   * chain has not answered for yet.
   *
   * The read it retries used to happen exactly once, inside the sign-in, and a
   * single unlucky answer was the difference between somebody's Passport and a
   * blank name step. One read is the right number for a sign-in, which must not
   * stall behind an indexer; it is the wrong number for the question "does this
   * account exist", which a node three blocks behind answers wrongly and
   * correctly a few seconds later.
   *
   * So the retrying happens HERE, out of the sign-in's way: five attempts on a
   * doubling backoff — about a minute in all, `accountRecheckDelayMs` — while
   * Home says the account is being set up. It ends in one of two places and
   * never in silence: a recorded account, or `AccountRecovery.tsx`, which puts
   * the choice to the person whose account it is.
   */
  useEffect(() => {
    const search = accountSearch;
    if (!search || search.phase !== 'checking') return undefined;
    const delay = accountRecheckDelayMs(search.attempt);
    if (delay === null) {
      /* Spent. The screen this raises is the way out; nothing is deleted and
         nothing is set up behind the user's back. */
      setAccountSearch({ ...search, phase: 'not-found' });
      addActivity({
        label: 'Your account could not be found',
        detail: `Your passkey names an account on ${search.network} and ${search.network} has not answered for it. Nothing was changed — you can look again, or set up a new account.`,
        status: 'blocked',
        source: 'chain',
      });
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const handle = localWalletRef.current;
        const credentialId = profileRef.current?.passkey.credentialId ?? null;
        const indexerUrl = handle?.network.indexerHttpUrl ?? null;
        /* Signed out, or the wallet moved networks under us: the search is
           about a session that no longer exists. */
        if (!indexerUrl || !credentialId) return;
        const { confirmPassportContractOnLedger } = await import(
          './identity/passportContract.js'
        );
        const confirmed = await confirmPassportContractOnLedger(indexerUrl, search.address);
        if (!live) return;
        if (!confirmed) {
          setAccountSearch((current) =>
            current && current.phase === 'checking'
              ? { ...current, attempt: current.attempt + 1 }
              : current,
          );
          return;
        }
        saveRecoveredAccount(credentialId, {
          address: search.address,
          network: search.network,
          ...(search.alias ? { alias: search.alias } : {}),
        });
        setAccountSearch(null);
      })();
    }, delay);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [accountSearch, addActivity, saveRecoveredAccount]);

  /**
   * The way out's second control: stop looking, and set an account up the way
   * a new Passport does — by choosing a name, deliberately, on screen.
   *
   * It CREATES NOTHING here. What it does is clear what was read off the
   * passkey — the profile note, and the name restored from it, which is the
   * one record that would otherwise sit on a Passport claiming a name whose
   * account nobody could find — and hand the person to the name step. The
   * account the passkey names is untouched: it is on Midnight, not on this
   * device, and a later sign-in that can see it will still find it.
   */
  const startNewAccountAfterSearch = async (): Promise<void> => {
    const search = accountSearch;
    const active = profileRef.current;
    setAccountSearch(null);
    if (search) {
      const restored = loadAliasRecord(search.network);
      // Only the name THIS search restored; never one this browser watched.
      if (restored?.recovered === true) removeAliasRecord(search.network);
    }
    if (active) await patchProfile(active, { accountOnPasskey: undefined });
    setIdentityStep('alias');
  };

  /**
   * The stored record for THIS credential on the network the WALLET signs on.
   * Read per credential as well as per network: a second passkey in the same
   * browser must never be shown — or spend from — the first one's contract.
   *
   * Declared here, above every flow that needs it, because since 2026/08/24 it
   * is not merely what a status card shows: it is the account every send,
   * every dApp payment, and every balance on Home is made against.
   */
  const activeContractRecord =
    profile && localWalletNetworkId
      ? contractRecords[
          passportContractRecordKey(profile.passkey.credentialId, localWalletNetworkId)
        ] ?? null
      : null;
  /** The account contract to call, or `null` when this Passport has none yet. */
  const accountContractAddress =
    activeContractRecord?.status === 'deployed' ? activeContractRecord.address ?? null : null;

  /**
   * The account's balances follow the account: read them the moment there IS
   * one to read, and again whenever the contract this Passport holds changes.
   *
   * This covers the three arrivals no explicit refresh does — a wallet opening,
   * a session silently restored, and the contract's own deployment landing in
   * the record store. Every deliberate refresh (a send, a deposit, a pull) goes
   * through {@link refreshLocalBalances} instead.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready' || !accountContractAddress) return;
    void refreshAccountBalances();
  }, [accountContractAddress, localWalletStatus, refreshAccountBalances]);

  /**
   * Which colour the sponsor calls its stablecoin. Asked once a session, and
   * only where there is a wallet open to spend it: a probe that fails leaves
   * the name unknown, which Home renders as the colour itself rather than as a
   * label nobody has verified.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready') return undefined;
    let live = true;
    void probeStablecoin().then((found) => {
      /* A probe that could not answer leaves whatever is already known in
         place: the sponsor may have named the colour on a funding response, and
         a later unreachable `/status` is not evidence that it changed. */
      if (live) setStablecoin((current) => found ?? current);
    });
    return () => {
      live = false;
    };
  }, [localWalletStatus]);

  /**
   * Re-asks the indexer, ONCE, for the ledger hash of a deployment whose
   * transaction identifier was still unmapped when it was written.
   *
   * `resolveTransactionHash` gives the indexer a bounded window at deploy time
   * and then stores the identifier unchanged rather than inventing a hash. That
   * record is honest but unlinkable, and it would stay unlinkable forever even
   * though the indexer catches up within seconds. So the next time the wallet
   * is open with such a record in hand, one query upgrades it in place — and
   * the explorer link the user was owed appears without a redeploy.
   *
   * A ref, not state: once per identifier per session. A record that re-renders
   * must not become a poll, and an indexer that still has no answer is left
   * alone until the next launch.
   */
  const attemptedTxHashResolves = useRef(new Set<string>());
  useEffect(() => {
    const handle = localWalletRef.current;
    if (localWalletStatus !== 'ready' || !handle || !profile) return;
    const record =
      contractRecords[
        passportContractRecordKey(profile.passkey.credentialId, handle.network.networkId)
      ];
    if (!record || record.status !== 'deployed' || !record.deployTxId) return;
    /* `txIdResolved` is absent on records written before the field existed —
       the value itself is then the only evidence, and it is enough. */
    if (record.txIdResolved === true || isLedgerTxHash(record.deployTxId)) return;
    const identifier = record.deployTxId;
    if (attemptedTxHashResolves.current.has(identifier)) return;
    attemptedTxHashResolves.current.add(identifier);
    void (async () => {
      const { resolveDeployTxHashOnce } = await import('./identity/passportContract.js');
      const hash = await resolveDeployTxHashOnce(handle.network.indexerHttpUrl, identifier);
      /* Deliberately not guarded by an effect-cleanup flag: this write is to
         localStorage, the answer is as true after a re-render as before it,
         and dropping it would waste the one attempt this session gets. */
      if (!isLedgerTxHash(hash)) return;
      savePassportContractRecord({
        ...record,
        deployTxId: hash as string,
        txIdResolved: true,
        updatedAt: new Date().toISOString(),
      });
    })();
  }, [contractRecords, localWalletStatus, profile]);

  /**
   * The same read-back, at sign-in, for a record that has never had one.
   *
   * A contract record can reach this browser without any chain evidence behind
   * it: a backup restored while no wallet was open writes the file's claim and
   * says so. This is where that claim is settled — one indexer read per
   * address per session, the moment a wallet is open on the record's network.
   *
   * Upgrades only. A read that does not answer leaves `ledgerConfirmed` where
   * it is, because "the indexer did not answer" and "the contract is not
   * there" are the same silence, and the unconfirmed state is already the
   * honest one. A ref keeps it to one attempt: a re-render must not become a
   * poll.
   */
  const attemptedContractConfirms = useRef(new Set<string>());
  useEffect(() => {
    const handle = localWalletRef.current;
    if (localWalletStatus !== 'ready' || !handle || !profile) return;
    const key = passportContractRecordKey(
      profile.passkey.credentialId,
      handle.network.networkId,
    );
    const record = contractRecords[key];
    if (!record || record.status !== 'deployed' || !record.address) return;
    if (record.ledgerConfirmed === true) return;
    if (attemptedContractConfirms.current.has(key)) return;
    attemptedContractConfirms.current.add(key);
    void (async () => {
      const { confirmPassportContractOnLedger } = await import('./identity/passportContract.js');
      const live = await confirmPassportContractOnLedger(
        handle.network.indexerHttpUrl,
        record.address as string,
      );
      if (!live) return;
      savePassportContractRecord({
        ...record,
        ledgerConfirmed: true,
        updatedAt: new Date().toISOString(),
      });
    })();
  }, [contractRecords, localWalletStatus, profile]);

  /** A live availability probe against one network's own registry. */
  const probeAlias = useCallback(
    async (network: PassportNetwork, alias: string): Promise<AliasAvailability> => {
      const { checkAliasAvailability } = await import('./identity/midnames.js');
      return checkAliasAvailability(network, alias);
    },
    [],
  );

  /**
   * The claim screen's own availability question — AND the moment the claim's
   * work starts.
   *
   * The screen already debounces this by 500 ms per candidate name, which
   * makes it exactly the hook the warming wants: the user has stopped typing,
   * the name is a real candidate, and everything the claim will need is known.
   * So this asks through {@link claimWarmup} rather than probing directly,
   * which does three things in one call — answers the line under the field,
   * starts the sponsorship probe alongside it rather than after it, and leaves
   * both answers where `claimAliasBoundToAccount` will find them. The four
   * chunks are prefetched beside it, for the same reason.
   *
   * The pre-checks have NOT moved relative to the ceremony. They still run,
   * and still refuse, strictly before any passkey prompt — see
   * `claimAliasBoundToAccount`. All that changed is that they usually started
   * while the user was reading the availability line.
   */
  const checkAliasOnActiveNetwork = useCallback(
    (alias: string) => {
      warmClaimModules();
      return claimWarmup.answers(selectedNetwork, alias).availability;
    },
    [selectedNetwork],
  );

  const checkAliasOnReclaimTarget = useCallback(
    (alias: string) => probeAlias(reclaim?.target ?? selectedNetwork, alias),
    [probeAlias, reclaim?.target, selectedNetwork],
  );

  /** Records a name as queued — never as registered — with its reason. */
  const queueAlias = useCallback(
    (alias: string, network: PassportNetwork, reason: string) => {
      saveAliasRecord({
        alias,
        domain: aliasDomainOf(alias),
        network,
        status: 'queued',
        queuedReason: reason,
        updatedAt: new Date().toISOString(),
      });
      pushToast({
        tone: 'info',
        title: `${aliasDomainOf(alias)} queued`,
        body: 'Not on chain yet — Passport says so plainly until it is.',
      });
    },
    [],
  );

  /**
   * The one gate every contract deploy passes through.
   *
   * Starts `run` only when no deploy for this credential and network is already
   * running; when one is, the caller joins it and receives that deploy's
   * submission and outcome instead of issuing a second one. `joined` says which
   * happened, so the caller can tell "I deployed this" from "somebody else did,
   * and here it is" — the two want different activity entries and only the
   * first wants a toast.
   *
   * TWO PROMISES, AND WHY (2026/08/31)
   * ----------------------------------
   * `submitted` settles when the transaction has been proved, balanced, signed,
   * and handed to the node — the moment the contract ADDRESS is a fact. `landed`
   * settles when the chain has been seen carrying it. They used to be the same
   * moment, and the ~14 s of indexer lag between them was time the claim spent
   * not asking for a name it already had the target for.
   *
   * The DEPLOYED record is still written from `landed`, and deliberately: this
   * store's own rule is that nothing is written here until the chain has
   * answered (see `identity/passportContractStore.ts`), and knowing an address
   * early is not the chain answering. It is written here rather than by the
   * callers because it must be written exactly once no matter how many callers
   * were waiting. Failure records stay with the callers: each has its own words
   * for what the failure meant to the flow it interrupted, and each writes one
   * only when it owned the run.
   */
  const deployPassportContractOnce = useCallback(
    (
      credentialId: string,
      network: string,
      run: () => Promise<PassportContractSubmission>,
    ): PassportContractRun & { joined: boolean } => {
      const key = passportContractRecordKey(credentialId, network);
      const existing = contractDeploysInFlight.current.get(key);
      if (existing) return { ...existing, joined: true };

      const submitted = run();
      const landed = (async () => {
        const deployment = await (await submitted).settled;
        /* `deployTxId` is whatever the resolution loop ended with: the ledger
           HASH where the indexer had caught up, and the raw 33-byte identifier
           where it had not. Which of the two it is gets recorded, because an
           identifier must never be dressed up as an explorer link. */
        savePassportContractRecord({
          credentialId,
          network: deployment.network,
          status: 'deployed',
          address: deployment.address,
          deployTxId: deployment.deployTxId,
          txIdResolved: isLedgerTxHash(deployment.deployTxId),
          deviceCommitment: deployment.deviceCommitment,
          ledgerConfirmed: deployment.ledgerConfirmed,
          feePaidBy: deployment.feePaidBy,
          updatedAt: deployment.deployedAt,
        });
        return deployment;
      })();

      /* Claimed synchronously — before anything awaits — and released however
         it settles, so a failed deploy never leaves the pair permanently
         un-deployable. Released on `landed`, not on `submitted`: until the
         chain has answered there is still a deploy in flight for this pair, and
         a second caller arriving in that window must join it rather than start
         another contract. */
      const entry: PassportContractRun = { submitted, landed };
      contractDeploysInFlight.current.set(key, entry);
      const release = () => {
        if (contractDeploysInFlight.current.get(key) === entry) {
          contractDeploysInFlight.current.delete(key);
        }
      };
      landed.then(release, release);
      /* `submitted` and `landed` both reject when a deploy fails, and every
         caller reads at most one of them. The other would be an unhandled
         rejection — a console error the user's browser reports and nobody
         asked for — so both are given a no-op handler here. Nothing is
         swallowed: these are extra handlers, not replacements. */
      submitted.catch(() => undefined);
      landed.catch(() => undefined);
      return { ...entry, joined: false };
    },
    [],
  );

  /**
   * ONE attempt at the activation grant, classified by what really came back.
   *
   * The taxonomy — `deposited`, `refused`, `retry` — and every rule behind it
   * live in {@link classifyFundAccountAnswer}, which is pure and drilled
   * exhaustively in `lib/activation.test.ts`. What stays here is the half that
   * genuinely needs this component: the request, and the effects the plan asks
   * for. The localStorage marker is written where the plan says so and nowhere
   * else, so a contract is only ever marked funded on evidence that it is.
   */
  const requestAccountFunding = useCallback(
    async (
      contractAddress: string,
    ): Promise<{ kind: 'deposited' | 'refused' } | { kind: 'retry'; reason: string }> => {
      if (!FUNDER_URL) return { kind: 'refused' };
      let answer: FundAccountAnswer;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FUND_ACCOUNT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(`${FUNDER_URL}/fund-account`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contractAddress }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        answer = {
          kind: 'response',
          ok: response.ok,
          status: response.status,
          body: await response.json().catch(() => ({})),
        };
      } catch (cause) {
        /* Unreachable, or the round-trip ceiling. Nothing is recorded: a
           network that is down for one attempt is not a verdict on the grant,
           and the schedule above will ask again. */
        answer = {
          kind: 'transport-failure',
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }

      const plan = classifyFundAccountAnswer(answer, contractAddress);
      if (plan.rememberFunded) rememberAccountFunding(contractAddress);
      const namedStablecoin = plan.stablecoin;
      /* Only ever fills a gap: a colour already known came from the same
         service and must not be overwritten mid-session. */
      if (namedStablecoin) setStablecoin((current) => current ?? namedStablecoin);
      for (const activity of plan.activities) addActivity({ ...activity, source: 'chain' });
      if (plan.refreshBalances) void refreshAccountBalances();
      return plan.outcome === 'retry'
        ? { kind: 'retry', reason: plan.reason }
        : { kind: plan.outcome };
    },
    [addActivity, refreshAccountBalances],
  );

  /**
   * Activation chains this browser tab is already running, keyed by contract
   * address. The localStorage marker is the cross-session gate; this is the
   * within-session one, so the claim that fires this and the wallet-open effect
   * that finishes a pending one cannot both be knocking at the same door.
   */
  const accountFundingInFlight = useRef(new Set<string>());

  /**
   * Asks the sponsor to put this Passport's opening balance INSIDE its account
   * contract — the activation grant, deposited where the account can spend it.
   *
   * This replaces the old wallet drip as the shape of activation. A drip to the
   * wallet ADDRESS is, under the account ruling, money the Passport cannot see:
   * the contract's `night_balances` mirror is what a withdrawal is checked
   * against, and NIGHT that reaches the wallet by any other route is invisible
   * to it. `/fund-account` proves a `deposit_night` (and, where the sponsor
   * holds one, a shielded stablecoin deposit) against the contract itself.
   *
   * NEVER BLOCKING, and never fatal. The name is registered and the contract is
   * deployed by the time this runs, and nothing about the name depends on a
   * grant landing. So it is fired and forgotten — and it is PATIENT, because
   * the sponsor's commonest refusal is "not yet" rather than "no": see
   * {@link FUND_ACCOUNT_RETRY_DELAYS_MS}.
   *
   * QUIET WHILE IT WAITS. A retry earns no activity row and no toast; the feed
   * gets exactly one row when the grant lands, and one row if the schedule is
   * spent without it landing. A user watching Home sees the balance appear, not
   * a running commentary on the sponsor's health.
   *
   * ONCE PER CONTRACT, ACROSS SESSIONS. The marker is written only on evidence
   * the grant exists, so a Passport whose activation never landed is still
   * PENDING on the next launch — and the wallet-open effect below finishes it.
   */
  const fundAccountOnce = useCallback(
    async (contractAddress: string): Promise<void> => {
      if (!FUNDER_URL) return;
      if (accountFundingAttempted(contractAddress)) return;
      if (accountFundingInFlight.current.has(contractAddress)) return;
      accountFundingInFlight.current.add(contractAddress);
      try {
        for (let attempt = 0; ; attempt += 1) {
          const outcome = await requestAccountFunding(contractAddress);
          if (outcome.kind !== 'retry') return;
          const delayMs = FUND_ACCOUNT_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined) {
            /* The schedule is spent. The account is empty and the screen already
               says so honestly; this row is why, in the sponsor's own words. */
            addActivity({
              label: ACTIVATION_EXHAUSTED_LABEL,
              detail: `The sponsor could not add your opening balance within ten minutes of trying: ${outcome.reason}`,
              status: 'blocked',
              source: 'chain',
            });
            return;
          }
          await pause(delayMs);
          // Another surface — or another tab — may have finished it meanwhile.
          if (accountFundingAttempted(contractAddress)) return;
        }
      } finally {
        accountFundingInFlight.current.delete(contractAddress);
      }
    },
    [addActivity, requestAccountFunding],
  );

  /**
   * Finishes an activation that never landed.
   *
   * A grant can be left pending by anything that outlives the tab it started
   * in: the sponsor syncing past this browser's patience, a reload during the
   * backoff, a laptop closed mid-claim. The marker is only written on evidence
   * the grant exists, so "pending" is simply a deployed contract with no
   * marker — and this is where a session that finds one picks it up, the
   * moment a wallet is open on the contract's own network.
   *
   * Costs nothing when there is nothing to do: `fundAccountOnce` returns
   * immediately on a marked contract and on one already in flight, so the
   * claim's own call and this effect can never both run a schedule.
   *
   * IT NO LONGER WAITS FOR THE CLAIM (2026/09/02).
   * ------------------------------------------------------------------------
   * From 2026/08/31 this effect stood down while a claim was running, because
   * the sponsor ran one spend job at a time and the grant took the queue in
   * front of the name — three consecutive claims reconstructed block by block
   * from the stagenet indexer that day (register blocks 257787, 257685,
   * 257522) all showed the same shape: account deploy at +0 s, `deposit_night`
   * at +24 s, resolver deploy at +48 s, `register_domain_for` at +84 s. Those
   * two middle blocks were this effect, sitting between the account and the
   * name.
   *
   * The sponsor now puts a registration ahead of a waiting grant itself, so the
   * deferral no longer buys the name anything and costs the account the whole
   * registration — a minute and a half — before it starts filling. The claim
   * fires the grant the moment the account LANDS, and this effect is the
   * safety net for everything that never gets there: a claim that failed at the
   * registration, a reload during the backoff, a laptop closed mid-claim.
   * `fundAccountOnce` is once per contract across all of them, so nothing here
   * can run a second schedule.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready' || !accountContractAddress) return;
    void fundAccountOnce(accountContractAddress);
  }, [accountContractAddress, fundAccountOnce, localWalletStatus]);

  /**
   * ONE user action, from the passkey prompt to the registered name.
   *
   * Hector, 2026/08/19: "which account is basically being related? … this needs
   * to deploy the account custody and then we need to come to this", and "this
   * has to be completely transparent for the user. The user shouldn't choose to
   * deploy the contract. It should automatically happen." So a claim now owns
   * the account-custody contract's deployment: the name binds to the CONTRACT,
   * and the contract comes into existence as part of claiming, not as a button
   * the user has to know to press first.
   *
   * ONE PASSKEY CEREMONY, and the reason it is one
   * ----------------------------------------------
   * The two secrets involved live in deliberately different derivation scopes —
   * {@link MIDNAMES_OWNER_SCOPE} for the domain owner key, and
   * {@link PASSPORT_CONTRACT_SCOPE} for the contract root that
   * `derivePassportContractSecrets` splits into the device and recovery
   * secrets. Calling `deriveWalletSeed` twice on the cached provider would cost
   * TWO user-verified assertions, and therefore two prompts for one action.
   *
   * `assertOnce` runs exactly one assertion and hands back a one-shot handle
   * over that assertion's PRF output, from which BOTH scopes derive — and,
   * because the HKDF salts and info strings are the same either way (see
   * `demo-backend/src/passkey.ts`), byte-identically to what two prompts would
   * have produced. So a contract deployed here and a contract deployed by the
   * card's retry carry the same device commitment. The handle is disposed the
   * moment both derivations are done: the PRF output never outlives this flow,
   * and nothing caches it.
   *
   * ORDER, AND WHERE IT STOPS
   * -------------------------
   * Availability and funds are re-checked BEFORE the prompt, so a doomed claim
   * never asks the user to touch their authenticator. Then the contract, then
   * the resolver, then the registration. If the contract deploy fails the claim
   * STOPS with that failure's real words — it does not fall back to binding the
   * name to the wallet address, because a name that silently points somewhere
   * other than where the user was told is the one outcome worth failing for.
   */
  const runClaimBoundToAccount = useCallback(
    async (
      handle: LocalMidnightWallet,
      activeProfile: DemoPassportProfile,
      alias: string,
      onPhase: (phase: AliasClaimProgress['phase']) => void,
    ): Promise<AliasClaimResult> => {
      const credentialId = activeProfile.passkey.credentialId;
      const network = handle.network.networkId;
      /* Usually already resolved. `warmClaimModules` starts these same four
         imports when the name step mounts and again as the user types, and the
         module loader hands both callers the one evaluation — so on the common
         path this `await` is a microtask rather than the ~0.9 s it measured
         cold on the live site. It is still written as the real import, because
         it IS the real import: the prefetch is an optimisation the claim does
         not depend on, and a chunk that genuinely cannot be fetched throws
         here with its own message. */
      const [
        { AliasClaimError, deriveMidnamesOwnerKey },
        { submitPassportContract },
        { deriveWalletSeed },
        { AliasSponsorRefusal, sponsorAliasRegistration },
      ] = await Promise.all([
        import('./identity/midnames.js'),
        import('./identity/passportContract.js'),
        import('./lib/localWallet.js'),
        import('./identity/sponsoredAlias.js'),
      ]);

      /* The registry probes below need the network as a Midnames network, and
         the only thing that makes that cast true is the same gate `claimAlias`
         applies. Refusing here means the contract is never deployed for a claim
         that could not have been made on this network at all. */
      if (!aliasRegistrationSupported(network)) {
        throw new AliasClaimError(
          'unsupported-network',
          `Passport registers names on ${CLAIMABLE_NETWORKS.join(' and ')} only; this Passport signs on ${network}.`,
        );
      }
      const registryNetwork = network as MidnamesNetwork;

      /* (1) Both gates before the prompt, so the ACCOUNT CONTRACT is never
         deployed for a claim that was going to be refused anyway. Neither gate
         reads the wallet's balance: the wallet does not pay for names.

         WARMED, NOT WEAKENED. Both answers come from `claimWarmup`, which
         hands back the probe the claim screen started for THIS name on THIS
         network if it is still in flight or younger than ten seconds, and
         otherwise re-probes exactly as this line used to. The reads are the
         same reads — `checkAliasAvailability(…, { fresh: true })` and the
         funder's `/status` — the refusals below are the same refusals in the
         same order, and every one of them still happens before the ceremony.
         See `identity/claimWarmup.ts` for why a ten-second window cannot let a
         stale "available" through. The two probes also now overlap instead of
         running strictly one after the other, which is where the rest of the
         measured gap went. */
      onPhase('checking');
      const warmed = claimWarmup.answers(registryNetwork, alias);
      const availability = await warmed.availability;
      if (availability.status === 'taken') {
        throw new AliasClaimError(
          'taken',
          `${alias}.night is already registered on ${registryNetwork}.`,
          availability.resolverAddress,
        );
      }
      if (availability.status === 'unreachable') {
        throw new AliasClaimError(
          'network-unreachable',
          'Names cannot be checked right now, so the name cannot be claimed yet.',
          availability.detail,
        );
      }
      /* Sponsorship, and nothing else. The user's own NIGHT is not part of a
         claim at all — a wallet holding NOTHING gets its name — so there is no
         funds gate to run beside this one, and no balance whose emptiness could
         refuse exactly the person this exists for.

         `aliasSponsorshipLikely` behind the warm probe answers `false` for a
         missing `FUNDER_URL` and for a network Passport cannot register on,
         which is the same answer the `FUNDER_URL ? … : false` here used to
         give. */
      onPhase('preparing');
      const sponsored = await warmed.sponsored;
      if (!sponsored) {
        /* Refused HERE — before the passkey ceremony and before any deploy —
           rather than deploying an account and then refusing the name. The
           wallet's balance is never consulted: it pays for nothing. */
        throw new AliasClaimError('network-unreachable', SPONSOR_UNAVAILABLE_SENTENCE);
      }

      /* (2) The one ceremony. Both secrets, one assertion, handle disposed.
         The label flips to "Confirm with your passkey" on the line ABOVE the
         call, so the sentence is on screen as the platform raises its prompt
         rather than after it — and the gap between the user's click and this
         line is now the warmed pre-checks alone, which is what keeps the call
         inside the activation window platforms require. */
      onPhase('confirm-passkey');
      let oneShot: DiscoveredPassportPasskey;
      try {
        oneShot = await withPasskeyWatchdog(() =>
          WebAuthnPrfKeyProvider.assertOnce(activeProfile.passkey),
        );
      } catch (cause) {
        /* THE MID-SESSION DEAD END, CLOSED (2026/08/31). Nothing is deployed,
           registered, or spent at this point — the gates above have all
           answered — so the whole of what is owed here is a refusal the screen
           can act on. `midSessionCeremonyFailure` marks it, and the claim
           screen's own failure card grows the two controls. */
        throw midSessionCeremonyFailure(cause);
      }
      let ownerSecret: Uint8Array;
      let contractRootSecret: Uint8Array;
      try {
        ownerSecret = await deriveWalletSeed(oneShot, MIDNAMES_OWNER_SCOPE);
        contractRootSecret = await deriveWalletSeed(oneShot, PASSPORT_CONTRACT_SCOPE);
      } finally {
        // The PRF output is zeroed here and never reaches any cache.
        oneShot.dispose();
      }

      /**
       * One place the account deploy's failure becomes the claim's failure.
       *
       * It is reached from two directions now that the deploy is not waited on
       * in a straight line: the submission itself refusing, and the chain later
       * refusing a transaction that was already submitted. Both mean the same
       * thing to the reader — there is nothing for the name to point at — so
       * both say it in the same words, and the failure RECORD (which is what
       * puts "Try deploying again" on the Home card) is written exactly once,
       * by whichever claim owned the run.
       */
      const accountFailure = (cause: unknown, owned: boolean): Error => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const detail = (cause as { detail?: string })?.detail;
        if (owned) {
          savePassportContractRecord({
            credentialId,
            network,
            status: 'failed',
            failureReason: detail ? `${message} (${detail})` : message,
            updatedAt: new Date().toISOString(),
          });
        }
        return new AliasClaimError(
          'account-contract-failed',
          /* No machinery in a sentence a person reads. What failed is the
             ACCOUNT — the thing they were waiting for — and the reason the name
             did not follow is that there was nothing for it to point at. The
             parts' own names go in the detail, for a log. */
          `${alias}.night was not registered: your Passport account could not be set up, so there was nothing for the name to point at.`,
          /* The inner REASON only. Its message now says the same thing as the
             sentence above, and carrying both put one fact on screen twice with
             a dash between the copies. */
          detail ?? message,
        );
      };

      /* The claim failure the deploy's own landing produced, when the chain
         refused a transaction that had already been submitted. The RECORD is
         written by the handler that sets this — not by whoever reads it — so a
         deploy that fails while the claim is busy elsewhere still puts "Try
         deploying again" on the Home card, whatever the claim does next.

         Read SYNCHRONOUSLY where the registration fails, so a name refused for
         its own reasons — taken, rate-limited — is never made to wait on a
         deploy it has nothing to do with. */
      let accountDeployFailure: Error | null = null;
      /* How the registration waits for the account to appear on chain, when
         this claim submitted it and the chain has not answered yet. */
      let awaitAccountOnChain: (() => Promise<unknown>) | undefined;
      /* Whether this claim OWNS the deploy it is watching, and therefore
         whether it is the one that records how it ended. */
      let ownsDeploy = false;

      try {
        /* (3) The account-custody contract. An existing DEPLOYED record for
           this credential and network is reused — a Passport has one contract
           per network, not one per name. */
        const existing = loadPassportContractRecord(credentialId, network);
        let contractAddress = existing?.status === 'deployed' ? existing.address : undefined;
        if (!contractAddress) {
          onPhase('attaching-account');
          setContractBusy(true);
          try {
            /* Through the shared gate, never straight to
               `submitPassportContract`: the Home card's retry may already have
               one running for this credential and network, and a second would
               be a second contract the user paid for and the records would
               forget. */
            const { submitted, landed, joined } = deployPassportContractOnce(
              credentialId,
              network,
              () =>
                submitPassportContract(handle, contractRootSecret, (progress) =>
                  setContractPhase(progress.phase),
                ),
            );
            ownsDeploy = !joined;

            /* THE MOMENT THIS CLAIM STOPS WAITING (2026/08/31). What the name
               needs from the account is its ADDRESS, and the address is settled
               when the transaction is built — it is the hash of the initial
               contract state the constructor produced, so the chain cannot
               answer with a different one. Waiting for the indexer to serve the
               deploy before asking for the name cost a full indexer lag
               (13.2–14.1 s on stagenet, measured 2026/08/31) of doing nothing,
               and then a further four blocks before the resolver was deployed.
               So the claim takes the address and carries on; the landing is
               WATCHED below, and nothing is reported as an account that exists
               until it lands. */
            const submission = await submitted;
            contractAddress = submission.address;
            awaitAccountOnChain = () => landed;

            /* The landing, watched rather than waited on. Its handlers are
               attached HERE, before the registration is posted, so the failure
               flag is already set by the time a `target-missing` refusal
               travels back up through `awaitAccountOnChain`. */
            void landed.then(
              (deployment) => {
                setContractBusy(false);
                /* THE OPENING BALANCE, THE MOMENT THERE IS AN ACCOUNT TO PUT IT
                   IN (2026/09/02).
                   ------------------------------------------------------------
                   It used to be fired at step (5), after the registration had
                   come back, and it was deferred there on 2026/08/31 because
                   the sponsor ran one spend job at a time and the grant took
                   the queue in front of the name. The sponsor now puts a
                   registration ahead of a waiting grant itself, so the deferral
                   buys nothing and costs the whole registration — a minute and
                   a half — before the account starts filling. An activation is
                   ~250 s of the sponsor's own work; started here it overlaps
                   the name instead of following it.

                   Fired for a JOINED deploy too, and before the `ownsDeploy`
                   return: the grant is once per contract, not once per claim,
                   and `fundAccountOnce` owns that. Never awaited — nothing
                   about the name depends on it. */
                void fundAccountOnce(deployment.address);
                if (!ownsDeploy) return;
                // The deployed record was written by the gate; this is the
                // claim's own account of it, which a joining claim must not
                // duplicate.
                addActivity({
                  /* "Your account is set up", not "the contract deployed":
                     ruled 2026/08/26. The contract is the machinery; the
                     account is the thing the user was waiting for. The
                     transaction is still linked, so nothing is hidden. */
                  label: 'Your account is set up',
                  detail: `It is ${
                    deployment.ledgerConfirmed ? 'live' : 'submitted'
                  } on ${deployment.network}, ready for ${alias}.night to point at it.`,
                  status: 'complete',
                  source: 'chain',
                  txHash: deployment.deployTxId,
                });
                /* The deploy is the long half of onboarding, and since
                   2026/08/25 it says so on screen the moment it lands rather
                   than waiting for the name. It is the FIRST transaction this
                   Passport ever submits and the only one the passkey wallet
                   itself originates, so it is the one most worth being able to
                   go and look at — and the indexer has usually not mapped its
                   identifier to a ledger hash yet, which is what the verifier
                   fallback is for. */
                pushToast({
                  tone: 'success',
                  title: 'Your account is set up',
                  body: `${compactAddress(deployment.address)} is ${
                    deployment.ledgerConfirmed ? 'live' : 'submitted'
                  } on ${deployment.network}. Registering ${alias}.night against it now.`,
                  link: explorerTxLink(
                    deployment.deployTxId,
                    deployment.network,
                    aliasDomainOf(alias),
                  ),
                });
                void notify(
                  'Your account is set up',
                  `${deployment.ledgerConfirmed ? 'It is live' : 'It is submitted'} on ${
                    deployment.network
                  }. Registering ${alias}.night against it now.`,
                  { tag: 'passport-contract-deployed' },
                );
              },
              (cause) => {
                /* Recorded, not thrown: nothing is awaiting this promise on the
                   happy path, and an unhandled rejection would be a console
                   error rather than a message to anybody. `accountFailure`
                   writes the failed record here, once, and the registration
                   below throws what it returns. */
                setContractBusy(false);
                accountDeployFailure = accountFailure(cause, ownsDeploy);
              },
            );
          } catch (cause) {
            /* The submission itself refused — nothing was signed, nothing was
               submitted, and there is no landing to watch. */
            setContractBusy(false);
            throw accountFailure(cause, ownsDeploy);
          } finally {
            /* `contractPhase` is the deploy's own sub-label and it belongs to
               the part of the deploy the reader is watching; the claim's next
               phase names itself. `contractBusy` is NOT cleared here — it is
               cleared when the deploy lands or fails, because until then there
               genuinely is a deploy in flight. The Home card's retry is guarded
               by `contractDeploysInFlight` in any case, which is the guard that
               actually holds. */
            setContractPhase(null);
          }
        }

        /* (4) The claim itself, bound to the account contract's own address —
           never to a value assembled from anything else. Since 2026/08/31 that
           address comes out of the deploy transaction's construction rather
           than out of the chain's answer about it, which is the same 32 bytes
           a block earlier: the address IS the hash of the initial contract
           state, so there is nothing for the chain to disagree with. The chain
           is still asked, and the registry call still waits for its answer —
           see `targetPending` below.

           Sponsored, and only sponsored: the service registers the name FOR
           this Passport — user's key as owner, this contract as target —
           paying the registry price and the fees itself, so the user-side
           ceremony is already over (the one passkey assertion above). There is
           no self-paid branch beneath this one. The wallet originates exactly
           one transaction in its life, the account deploy above; a name it
           bought would be a second, and a registration the service will not
           carry right now is kept and retried instead. */
        let claimed: AliasClaimResult | null = null;
        if (sponsored && FUNDER_URL) {
          onPhase('registering');
          try {
            claimed = await sponsorAliasRegistration(
              FUNDER_URL,
              {
                alias,
                ownerKey: await deriveMidnamesOwnerKey(ownerSecret),
                contractAddress,
                /* No payment address: the leaf's owner-address half used to
                   carry the wallet's address, which a resolver honouring it
                   would PAY — outside the account model. The service zero-fills
                   it; the registry's authority is the owner key, and the target
                   is the account (audit finding, 2026/08/25). */
                network: registryNetwork,
                /* Set only where this claim submitted the deploy and is not
                   waiting for it: the service is being told to check the target
                   before it REGISTERS rather than before it accepts, which is
                   the whole of what buys the time. A claim reusing an account
                   that was already on the record sends nothing, because there
                   is nothing pending about it. */
                targetPending: awaitAccountOnChain !== undefined,
              },
              {
                /* The compatibility half, and the correctness one: a service
                   that has never heard of `targetPending` refuses
                   `target-missing`, and a service that has may still be asked
                   about an account whose deploy is genuinely slow. Either way
                   the answer is to wait for the chain and ask once more. */
                awaitTarget: awaitAccountOnChain,
              },
            );
          } catch (cause) {
            /* THE DEPLOY'S OWN FAILURE OUTRANKS THE NAME SERVICE'S. Read
               synchronously — the flag is set by the landing handler attached
               before this request went out — so a name refused for its own
               reasons never waits on a deploy, and a name refused BECAUSE the
               account never landed is reported as the account failing rather
               than as the registry being unhelpful. */
            if (accountDeployFailure !== null) throw accountDeployFailure;
            if (!(cause instanceof AliasSponsorRefusal)) throw cause;
            if (cause.code === 'name-taken') {
              throw new AliasClaimError('taken', cause.message);
            }
            if (!cause.selfPayWorthTrying) {
              /* `registration-in-flight` or `confirmation-failed`: something
                 for this name or this Passport may already be on chain, and a
                 self-paid attempt on top of it could register twice. Stop with
                 the funder's own sentence. */
              throw new AliasClaimError('register-rejected', cause.message);
            }
            /* The wallet never pays for a name. Under the account model the
               only transaction the wallet originates is the account deploy;
               a registration the sponsor will not carry right now is kept
               and retried, never bought from the wallet (ruled 2026/08/25). */
            throw new AliasClaimError(
              'register-rejected',
              /* The service's own sentence, and nothing added to it. What used
                 to be appended here said the name was kept for a second time
                 in a row — `aliasRefusalMessage` had already said it — and
                 volunteered that Passport does not spend from the account,
                 which the foot of the claim screen says on every state of it.
                 The card is a heading, one sentence, and two controls. */
              cause.message,
            );
          }
        }
        if (!claimed) {
          /* No sponsor on offer at all: same rule, same outcome. There is no
             self-paid registration left anywhere in the app to fall through
             to — the name waits for the service, which is the honest end of
             this path rather than a gap in it. */
          throw new AliasClaimError(
            'network-unreachable',
            /* The same sentence the pre-check refusal above uses, from the one
               place it is written down: two copies of one fact drifted apart
               once already. */
            SPONSOR_UNAVAILABLE_SENTENCE,
          );
        }

        /* (5) The opening balance is NOT fired here. It was started the moment
           the account landed (see the `void fundAccountOnce(deployment.address)`
           above), and a reused account that never passes through that landing
           is covered by the wallet-ready effect. Firing it again here bought
           nothing but a second schedule to reason about. */

        /* (6) REMEMBER the account, so a device that has never seen this
           Passport can find the contract again — and remember it WITHOUT
           asking the user for anything.

           This used to write the blob onto the passkey here, which is a second
           user-verified assertion the specification will not let us fold into
           the claim's own. The gesture it was supposed to ride was minutes
           gone by then, so what it really produced was a passkey prompt on a
           finished Home screen that nobody had asked for (reported repeatedly;
           fixed 2026/08/31). The write now rides the next assertion the user
           makes — see `noteAccountForPasskey` and
           `unlockLocalPassportProfile`. Still not awaited, and still unable to
           fail the claim: it is a storage write that swallows its own error. */
        void noteAccountForPasskey(
          activeProfile,
          { address: contractAddress, network },
          alias,
        );
        return claimed;
      } finally {
        ownerSecret.fill(0);
        contractRootSecret.fill(0);
      }
    },
    [addActivity, deployPassportContractOnce, fundAccountOnce, noteAccountForPasskey],
  );

  /**
   * {@link runClaimBoundToAccount}, under the name the rest of the app calls.
   *
   * It used to raise a flag that kept the activation grant out of the claim's
   * way, and the flag went with the deferral on 2026/09/02: the grant is now
   * fired the moment the account lands, deliberately alongside the name, and
   * there is nothing left to hold back.
   */
  const claimAliasBoundToAccount = runClaimBoundToAccount;

  /**
   * The real claim, as ONE user action: the account-custody contract is
   * deployed if this Passport has none on this network, and then the name is
   * registered pointing AT it. See {@link claimAliasBoundToAccount} for the
   * single-ceremony derivation and the order the steps run in.
   */
  const claimAliasOnChain = useCallback(
    async (alias: string): Promise<void> => {
      const handle = localWalletRef.current;
      const activeProfile = profile;
      if (!handle || !activeProfile) {
        setAliasFailure({
          message: 'Your Passport is not open yet. Wait for it to finish opening and try again.',
          wayOut: false,
        });
        return;
      }
      setAliasFailure(null);
      /* The first phase the button narrates is the first thing that really
         happens — the availability re-check. It used to say "Deploying your
         name's resolver…" here, which was a sentence about a step three stages
         further on and left the user watching a spinner that never changed
         until the account deploy. `claimAliasBoundToAccount` advances it. */
      setClaimPhase('checking');
      try {
        const result = await claimAliasBoundToAccount(handle, activeProfile, alias, setClaimPhase);
        saveAliasRecord({
          alias: result.alias,
          domain: result.domain,
          network: result.network,
          status: 'registered',
          resolverAddress: result.resolverAddress,
          resolverDeployTxId: result.resolverDeployTxId,
          registerTxId: result.registerTxId,
          registryConfirmed: result.registryConfirmed,
          resolverTarget: result.resolverTarget,
          resolverTargetHex: result.resolverTargetHex,
          updatedAt: result.claimedAt,
        });
        addActivity({
          label: 'Your name is registered',
          detail: `${result.domain} now points at your Passport account on ${result.network}. Anyone can send to the name.`,
          status: 'complete',
          source: 'chain',
          txHash: result.registerTxId,
        });
        pushToast({
          tone: 'success',
          title: `${result.domain} is yours`,
          body: result.registryConfirmed
            ? 'Your name is confirmed on the network.'
            : 'Submitted — the registry has not reported it yet.',
          // The toast is the success surface now, so the transaction has to be
          // reachable from it. No link on a network with no public explorer.
          link: explorerTxLink(result.registerTxId, result.network),
        });
        /* A claim can outlast the user's attention — the two Midnames
           transactions and a contract deploy take minutes on preview. Silent
           unless notifications were turned on. */
        void notify(
          `${result.domain} is yours`,
          result.registryConfirmed
            ? 'Your name is confirmed on the network.'
            : 'Submitted — the registry has not reported it yet.',
          { tag: 'passport-name-registered' },
        );
        void refreshLocalBalances();
        // Only record the step as settled when the claim genuinely landed.
        storeNameStep(activeProfile.passkey.credentialId, 'done');
        // Name, then dashboard (2026/08/06): Backup and Ecosystem have left
        // the chain, so a landed claim ends the wizard outright.
        setIdentityStep((current) => (current === 'alias' ? null : current));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const detail = (cause as { detail?: string })?.detail;
        /* An em dash, not parentheses. The detail routinely carries its own
           parenthetical, and nesting them produced "A. (B. (C))" on screen. */
        setAliasFailure({
          message: detail ? `${message} — ${detail}` : message,
          /* A passkey the platform would not use is the one claim failure the
             screen can DO something about, and the only one whose way out is
             not "try a different name". The mark comes from the ceremony
             itself — see `midSessionCeremonyFailure`. */
          wayOut: isMidSessionWayOut(cause),
        });
        /* A claim that died part-way used to leave NO record at all, so the
           name the user picked vanished from the Passport and the Register-now
           path had nothing to pick up. Persist it queued, carrying the failure
           as the reason, exactly as the requeue in `registerQueuedAlias` does. */
        saveAliasRecord({
          alias,
          domain: aliasDomainOf(alias),
          network: localWalletNetworkId ?? configuredWalletNetwork ?? selectedNetwork,
          status: 'queued',
          queuedReason: detail ? `${message} — ${detail}` : message,
          updatedAt: new Date().toISOString(),
        });
        addActivity({
          label: 'Your name could not be registered',
          detail: detail ? `${message} — ${detail}` : message,
          status: 'error',
          source: 'chain',
        });
      } finally {
        setClaimPhase(null);
      }
    },
    [
      addActivity,
      claimAliasBoundToAccount,
      localWalletNetworkId,
      profile,
      refreshLocalBalances,
      selectedNetwork,
    ],
  );

  /**
   * Claim for real on the network the open wallet is actually on; queue
   * honestly anywhere else. Both halves of the condition matter: the user may
   * be *browsing* a network the wallet does not sign on.
   */
  const claimOrQueueAlias = useCallback(
    async (alias: string, network: PassportNetwork): Promise<void> => {
      if (network === localWalletNetworkId && aliasClaimSupported) {
        /* Straight to the claim. A brand-new Passport holds nothing and never
           needs to: the service registers the name from its own funds and,
           once the account exists, funds THE ACCOUNT. There is no grant to the
           wallet address to fetch and wait for first — value at the wallet is
           value the account model says may not sit there (ruled 2026/08/25). */
        await claimAliasOnChain(alias);
        return;
      }
      queueAlias(
        alias,
        network,
        `Passport signs and submits on ${signingNetworkLabel} only, so ${alias}.night is reserved for you locally but is NOT registered on ${NETWORK_LABELS[network]}.`,
      );
    },
    [
      aliasClaimSupported,
      claimAliasOnChain,
      localWalletNetworkId,
      queueAlias,
      signingNetworkLabel,
    ],
  );

  /**
   * "Register now" on a queued name — the REAL claim path re-run on demand.
   *
   * Order matters, and every early exit leaves the record queued with a FRESH
   * `queuedReason`: (1) the live TLD is re-probed — the name may have been
   * taken since, in which case the existing alternative-picker opens; (2) the
   * sponsor is re-probed, because it is the only thing that registers a name;
   * (3) only then does the real claim run, with the same progress phases as
   * onboarding. Success upgrades the record to `registered` with both real
   * transaction ids. Failures are surfaced inline on the card, never as a toast.
   *
   * The wallet's balance is consulted at no point. It never was the thing that
   * paid for a name, and since 2026/08/25 there is no path in which it could be.
   */
  const registerQueuedAlias = useCallback(async (): Promise<void> => {
    if (registerNowBusy) return;
    const record = loadAliasRecords()[selectedNetwork];
    if (!record || record.status === 'registered') return;
    const handle = localWalletRef.current;
    const activeProfile = profile;
    if (!handle || !activeProfile) return; // The card disables the action first.
    setRegisterNowBusy(true);
    setAliasFailure(null);
    const requeue = (reason: string) =>
      saveAliasRecord({
        ...record,
        status: 'queued',
        queuedReason: reason,
        updatedAt: new Date().toISOString(),
      });
    try {
      const { checkAliasAvailability } = await import('./identity/midnames.js');
      // (1) The name may have been taken while it sat in the queue. It is
      // re-probed on the network the record is FILED under — which is the one
      // the wallet signs on, because `registerNowDisabledReason` has already
      // refused the action on any other.
      const availability = await checkAliasAvailability(selectedNetwork, record.alias, {
        fresh: true,
      });
      if (availability.status === 'unreachable') {
        requeue(
          `Names on ${selectedNetwork} cannot be checked right now, so ${record.domain} is still not registered: ${availability.detail}`,
        );
        return;
      }
      if (availability.status === 'taken') {
        requeue(
          `${record.domain} was registered by someone else while it was queued here. Pick an alternative name to register instead.`,
        );
        setReclaimError(null);
        setReclaim({ target: selectedNetwork, alias: record.alias });
        return;
      }
      // (2) The sponsor, before any passkey prompt. It is the only thing that
      // registers a name, so its absence is the whole answer: the record stays
      // queued with the reason the wallet must never be asked to fix (ruled
      // 2026/08/25). `claimAliasBoundToAccount` re-probes for itself; this
      // spares the user a ceremony that could only end in the same sentence.
      const sponsored = await aliasSponsorshipLikely(selectedNetwork);
      if (!sponsored) {
        requeue(SPONSOR_UNAVAILABLE_SENTENCE);
        return;
      }
      // (3) The onboarding claim's exact path, contract and all: one passkey
      // ceremony, the account contract deployed if this Passport has none on
      // this network, then the two Midnames transactions with the name bound
      // to that contract. See `claimAliasBoundToAccount`.
      setClaimPhase('checking');
      const result = await claimAliasBoundToAccount(
        handle,
        activeProfile,
        record.alias,
        setClaimPhase,
      );
      saveAliasRecord({
        alias: result.alias,
        domain: result.domain,
        network: result.network,
        status: 'registered',
        resolverAddress: result.resolverAddress,
        resolverDeployTxId: result.resolverDeployTxId,
        registerTxId: result.registerTxId,
        registryConfirmed: result.registryConfirmed,
        resolverTarget: result.resolverTarget,
        resolverTargetHex: result.resolverTargetHex,
        updatedAt: result.claimedAt,
      });
      addActivity({
        label: 'Your name is registered',
        detail: `${result.domain} now points at your Passport account on ${result.network}. Anyone can send to the name.`,
        status: 'complete',
        source: 'chain',
        txHash: result.registerTxId,
      });
      pushToast({
        tone: 'success',
        title: 'Name registered on-chain',
        body: result.registryConfirmed
          ? `${result.domain} is confirmed by the registry.`
          : `${result.domain} was submitted — the registry has not reported it yet.`,
        link: explorerTxLink(result.registerTxId, result.network),
      });
      /* Same event as the onboarding claim, reached from the queued-name card.
         One tag, so a retry replaces rather than stacks. */
      void notify(
        'Name registered on-chain',
        result.registryConfirmed
          ? `${result.domain} is confirmed by the registry.`
          : `${result.domain} was submitted — the registry has not reported it yet.`,
        { tag: 'passport-name-registered' },
      );
      void refreshLocalBalances();
    } catch (cause) {
      // A real failure from the claim itself: keep the record queued with the
      // fresh reason, shown inline where the queued pill already is. No
      // failure toast — the card says everything.
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = (cause as { detail?: string })?.detail;
      requeue(detail ? `${message} — ${detail}` : message);
      addActivity({
        label: 'Your name could not be registered',
        detail: detail ? `${message} — ${detail}` : message,
        status: 'error',
        source: 'chain',
      });
    } finally {
      setClaimPhase(null);
      setRegisterNowBusy(false);
    }
  }, [
    addActivity,
    claimAliasBoundToAccount,
    profile,
    refreshLocalBalances,
    registerNowBusy,
    selectedNetwork,
  ]);

  /**
   * RETRY ONLY, since 2026/08/19. Deploys this Passport's account-custody
   * contract (C1) on the network the OPEN PASSKEY WALLET actually signs on.
   *
   * Deploying is no longer something a user chooses: a name claim deploys the
   * contract automatically (see {@link claimAliasBoundToAccount}), and the Home
   * card is a status surface. What survives here is the one case where a person
   * genuinely has a decision to make — an automatic deploy that FAILED, whose
   * record puts a "Try deploying again" affordance on that card.
   *
   * The derivation is unchanged and must stay unchanged: `deriveWalletSeed`
   * against {@link PASSPORT_CONTRACT_SCOPE} produces the same 32 bytes the
   * claim's single-assertion path derives for that scope, so a retry rebuilds
   * the same device commitment rather than a second, different contract.
   *
   * The localnet is reached the same way every other network is: by the wallet
   * being pointed at it.
   *
   * The approval convention is the name claim's, exactly: `deriveWalletSeed`
   * against {@link PASSPORT_CONTRACT_SCOPE} costs ONE fresh user-verified
   * WebAuthn assertion, and that assertion IS this transaction's ceremony. A
   * `confirmPresence` on top would double-prompt for one user action.
   *
   * Nothing is recorded as deployed without an address and a transaction id that
   * came back from the chain; a failure is stored as a failure, with its reason.
   */
  const deployPassportContractOnChain = useCallback(async (): Promise<void> => {
    if (contractBusy) return;
    const handle = localWalletRef.current;
    const activeProfile = profile;
    if (!handle || !activeProfile) return; // The card disables the action first.
    const credentialId = activeProfile.passkey.credentialId;
    const network = handle.network.networkId;
    /* Synchronous, unlike the `contractBusy` state above: a claim raises that
       flag only around its own deploy, and a click landing in the same tick
       would read the stale value anyway. This is the guard that actually holds.
       A retry that finds a deploy already running has nothing to add — the
       running one is the outcome it wanted — so it simply stands down. */
    if (contractDeploysInFlight.current.has(passportContractRecordKey(credentialId, network))) {
      return;
    }
    setContractBusy(true);
    setError(null);
    setContractPhase('deriving');
    /* Set only when this call found a deploy already running and waited on it
       instead of starting one. Declared out here because the catch needs it
       too: the outcome of somebody else's deploy — good or bad — is theirs to
       record, and this call must not write a second account of it. Every other
       failure on this path, including one that never reached the deploy at
       all, is genuinely this call's own and is recorded as usual. */
    let joinedDeploy = false;
    try {
      const [{ submitPassportContract, checkPassportContractFunds }, { deriveWalletSeed }] =
        await Promise.all([
          import('./identity/passportContract.js'),
          import('./lib/localWallet.js'),
        ]);
      // The fee question first, before any passkey prompt: a deployment nobody
      // will pay for should be refused with the sponsor's reason rather than
      // asked to touch an authenticator and then fail.
      const funds = await checkPassportContractFunds();
      if (!funds.ok) {
        savePassportContractRecord({
          credentialId,
          network,
          status: 'failed',
          failureReason: funds.reason,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const rootSecret = await deriveWalletSeed(
        keyProviderFor(activeProfile.passkey),
        PASSPORT_CONTRACT_SCOPE,
      );
      let deployment;
      try {
        /* Through the same shared gate the claim path uses. The synchronous
           check at the top of this function cannot cover the awaits since —
           the imports, the funds probe, the passkey derivation — so a claim may
           have started a deploy in the meantime. If so this joins it rather
           than issuing a second one for the same credential and network.

           This path waits for the LANDING, unlike a claim: a retry has nothing
           to do with the address except find out whether it worked, so a
           submission it did not wait for would be a card that changed its mind
           twice for no reader's benefit. `submitPassportContract` reports the
           `confirming` phase itself here, through the same callback. */
        const { landed, joined } = deployPassportContractOnce(credentialId, network, () =>
          submitPassportContract(handle, rootSecret, (progress) =>
            setContractPhase(progress.phase),
          ).then((submission) => {
            setContractPhase('confirming');
            return submission;
          }),
        );
        joinedDeploy = joined;
        deployment = await landed;
      } finally {
        // The root secret's only job is done; nothing retains it.
        rootSecret.fill(0);
        passportKeyProviders.current.get(credentialId)?.lock(PASSPORT_CONTRACT_SCOPE);
      }
      /* The deployed record is written by the gate, exactly once. What follows
         is this path's own announcement of it, so a retry that merely joined a
         claim's deploy stays quiet — the claim is already telling that story. */
      if (joinedDeploy) {
        void refreshLocalBalances();
        return;
      }
      /* The name this Passport already holds on this network, if any — read
         from the store rather than from render state, because this callback
         must not be rebuilt every time a record changes. It is only a fallback
         link target. */
      const deployedDomain = loadAliasRecord(deployment.network)?.domain ?? null;
      const deployLink = explorerTxLink(
        deployment.deployTxId,
        deployment.network,
        /* Same fallback as the onboarding deploy: an unmapped identifier is the
           norm this early, and the verifier resolves the name instead. */
        deployedDomain,
      );
      addActivity({
        label: 'Your account is set up',
        detail: `It is ${
          deployment.ledgerConfirmed ? 'live' : 'submitted'
        } on ${deployment.network}.`,
        status: 'complete',
        source: 'chain',
        txHash: deployment.deployTxId,
      });
      pushToast({
        tone: 'success',
        title: 'Your account is set up',
        body: `${
          deployment.ledgerConfirmed
            ? 'The indexer is serving its state.'
            : 'Submitted — the indexer has not reported it yet.'
        }${
          deployLink
            ? ''
            : /* Nowhere to send them, and the reason said out loud rather than
                 a link that resolves to nothing on the explorer. */
              ' The indexer has not yet mapped the transaction identifier to a ledger hash, so there is no explorer link yet.'
        }`,
        link: deployLink,
      });
      /* The retry path. Same tag as the claim's deploy: one contract, one
         story, whichever route reached it. */
      void notify(
        'Your account is set up',
        `${compactAddress(deployment.address)} is ${
          deployment.ledgerConfirmed ? 'live' : 'submitted'
        } on ${deployment.network}.`,
        { tag: 'passport-contract-deployed' },
      );
      void refreshLocalBalances();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = (cause as { detail?: string })?.detail;
      const reason = detail ? `${message} — ${detail}` : message;
      /* A deploy this call merely joined has already been recorded — and
         narrated — by whoever started it. Writing again would put two failures
         on the record for one attempt. */
      if (joinedDeploy) return;
      savePassportContractRecord({
        credentialId,
        network,
        status: 'failed',
        failureReason: reason,
        updatedAt: new Date().toISOString(),
      });
      addActivity({
        label: 'Your account could not be set up',
        detail: reason,
        status: 'error',
        source: 'chain',
      });
    } finally {
      setContractPhase(null);
      setContractBusy(false);
    }
  }, [
    addActivity,
    contractBusy,
    deployPassportContractOnce,
    keyProviderFor,
    profile,
    refreshLocalBalances,
  ]);

  /**
   * Network switch. The passkey and the wallet session are untouched — no
   * re-enrolment, no new seed, no new addresses. Only the name is per network,
   * so Passport tries to reclaim it on the target and asks when it cannot.
   */
  const handleSelectNetwork = useCallback(
    (next: PassportNetwork) => {
      const previous = selectedNetwork;
      setSelectedNetwork(next);
      if (next === previous) return;
      const held =
        aliasRecords[previous] ??
        Object.values(aliasRecords).find((record) => record.status === 'registered') ??
        Object.values(aliasRecords)[0];
      if (!held) return;
      if (aliasRecords[next]) return;
      void (async () => {
        const availability = await probeAlias(next, held.alias);
        if (availability.status === 'taken') {
          setReclaimError(null);
          setReclaim({ target: next, alias: held.alias });
          return;
        }
        if (availability.status === 'unreachable') {
          queueAlias(
            held.alias,
            next,
            `Names on ${NETWORK_LABELS[next]} could not be checked during the switch, so ${held.alias}.night is not registered there: ${availability.detail}`,
          );
          return;
        }
        await claimOrQueueAlias(held.alias, next);
      })();
    },
    [aliasRecords, claimOrQueueAlias, probeAlias, queueAlias, selectedNetwork],
  );

  const handleReclaimPick = useCallback(
    async (alias: string): Promise<void> => {
      const target = reclaim?.target;
      if (!target) return;
      setReclaimBusy(true);
      setReclaimError(null);
      try {
        await claimOrQueueAlias(alias, target);
        setReclaim(null);
      } catch (cause) {
        setReclaimError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setReclaimBusy(false);
      }
    },
    [claimOrQueueAlias, reclaim?.target],
  );

  /**
   * Decides once per session whether the name step runs — and the rule is the
   * account invariant, not the session's history: a Passport with no name on
   * this network is walked through the step, whoever opened it and however.
   *
   * This used to be gated on "only a Passport this session just created", so
   * that a sign-in or a reload restoring a live session went straight to the
   * dashboard. That gate existed for a world with a skip button, where "no
   * name" was a choice; with the skip gone, "no name" can only mean an
   * interrupted ceremony — and a reload mid-onboarding was landing users on a
   * Home with no name and no account (seen live 2026/08/24, twice). The
   * per-mount `identityStepResolved` ref still keeps this to one decision per
   * session; the stored resolution keeps a completed name from ever being
   * asked for again.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready' || !localSurfaces || !profile) return;
    /* A RECOVERY IS STILL RUNNING, so this cannot be decided yet — and this
       guard deliberately does not latch. The wallet is open before the blob
       read off the passkey has been acted on, and the name that blob carries
       is the whole answer to the question below. Resolving here is exactly how
       a Passport that HAS a name met "Choose your .night name" on a browser
       whose site data had been cleared (2026/09/03). */
    if (recoveringAccount) return;
    if (identityStepResolved.current) return;
    identityStepResolved.current = true;
    /* Read before it is cleared: this is the one signal that says the Passport
       in hand was CREATED by this session rather than signed into, and it is
       what the welcome screen is gated on. Both enrolment paths set it
       synchronously, immediately after the profile is stored and well before
       the wallet this effect waits on has opened. */
    const passportJustCreated = identityStepArmed.current;
    identityStepArmed.current = false;
    if (loadAliasRecords()[selectedNetwork]) return;
    /* A name recovered from the passkey, before any of it reaches the alias
       store — a second reading of the same fact, because the cost of getting
       this wrong is asking somebody to claim a name they already own. */
    const recoveredNote = profile.accountOnPasskey;
    if (recoveredNote?.alias && recoveredNote.network === selectedNetwork) return;
    /* Only a DONE resolution suppresses the step. 'skipped' deliberately does
       not any more: a skip used to be remembered per credential forever, so a
       passkey that skipped once landed on Home with no name and no account on
       every subsequent sign-in — seen live 2026/08/24. A stored skip now means
       "ask again", and the screen itself no longer offers one. */
    if (storedNameStep(profile.passkey.credentialId) === 'done') return;
    /* The introduction, in front of the name step and only for a Passport that
       did not exist a moment ago. A sign-in is not a first impression, and a
       second reading is not one either — the dismissal is stored per
       credential and outlives both a reload and a sign-out. */
    setIdentityStep(
      passportJustCreated && !welcomeSeen(profile.passkey.credentialId) ? 'welcome' : 'alias',
    );
  }, [localSurfaces, localWalletStatus, profile, recoveringAccount, selectedNetwork]);

  const signOutPassport = async () => {
    // Sign-out is the boundary of the §2.2 session stopgap: the wrapped seed
    // and its wrapping key are removed before anything else is torn down.
    await clearPersistedWalletSession();
    /* THE WALLET IS DETACHED, NOT WAITED FOR (2026/08/31).
       `closeLocalWallet` drops the handle SYNCHRONOUSLY and only then awaits
       the SDK's own teardown — which is a network conversation and takes as
       long as the network takes. Awaiting it here put that conversation
       between the user and the landing screen: pressing Sign out did nothing
       visible at all, which is intolerable on the surface that made this
       control necessary. The name step has no other exit, so its Sign out is
       the one control in Passport that may not depend on a remote close.
       Nothing below reads the handle — the ref is already null — so nothing
       below needs to wait for it, and the teardown still happens. */
    void closeLocalWallet();
    setLocalSurfaces(null);
    setLocalWalletStatus('idle');
    setLocalWalletNetworkId(null);
    setLocalWalletProvingMode(null);
    /* The account's figures belong to the Passport that just left. Nothing may
       carry them into the next sign-in, which may be a different passkey. */
    setAccountBalances(NO_ACCOUNT_BALANCES);
    setAccountPhase(null);
    passportKeyProviders.current.clear();
    setProfile(null);
    setActivity([]);
    setError(null);
    setMobileTab('home');
    setOnboardingIntent(null);
    setOnboardingBusyLabel(null);
    setOnboardingError(null);
    setUnusableCredential(null);
    setKeylessPasskey(null);
    // The identity steps re-decide on the next sign-in. The alias records
    // themselves are NOT cleared: the same passkey re-derives the same wallet,
    // so the name it registered is still that wallet's name.
    setIdentityStep(null);
    /* The search belongs to the session that started it. A sign-out ends both;
       what it does NOT touch is the profile note, which is how the next
       sign-in on this browser still knows where to look. */
    setAccountSearch(null);
    setRecoveringAccount(false);
    setClaimPhase(null);
    setAliasFailure(null);
    setReclaim(null);
    setReclaimError(null);
    identityStepResolved.current = false;
    // Signing out does NOT re-arm the name step: the next sign-in is a
    // sign-in, and lands on the dashboard. The stored per-credential
    // resolution is deliberately left in place for the same reason.
    identityStepArmed.current = false;
  };

  /* ---------------------------------------------------------------------- */
  /* Mobile experience                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * A passkey session is live only while a wallet is actually open. The wallet
   * is derived from a PRF assertion and is deliberately not persisted, so a
   * reload genuinely has no wallet until the user re-asserts the passkey. The
   * remembered mode makes that one tap ("Sign in", offered first) rather than a
   * fresh enrolment.
   *
   * There is one route now, so an open wallet IS the session: nothing can be
   * signed in without one, and no consumer has to ask which kind it is.
   */
  const localSessionActive = localWalletStatus === 'ready' && localSurfaces !== null;
  const sessionActive = localSessionActive;
  /* The two way-out panels hold the screen open in their own right. They have
     to: a failure that suppresses the error banner in favour of its panel
     would otherwise have nothing left keeping onboarding on screen. */
  const showOnboarding =
    !sessionActive ||
    onboardingIntent !== null ||
    onboardingError !== null ||
    keylessPasskey !== null ||
    unusableCredential !== null;
  // The §2.2 session restore opens the wallet with no onboarding intent set,
  // so an opening local wallet also reads as the working stage.
  const onboardingStage: 'welcome' | 'working' =
    onboardingIntent !== null || localWalletStatus === 'opening' ? 'working' : 'welcome';
  const onboardingLabel =
    onboardingBusyLabel ?? 'Follow the passkey prompt on this device';
  /** The one onboarding route, plus the `unusable-credential` recovery. */
  const startPasskeyOnboarding = (intent: 'create' | 'signin' | 'auto' | 'enrol-new') => {
    void runLocalOnboarding(intent);
  };

  const refreshMobile = () => {
    void refreshLocalBalances();
  };

  /** Shared by Home's embedded apps grid and the Apps tab: feed plus toast. */
  const handleProfileShared = (appName: string, fields: string[]) => {
    addActivity({
      label: 'Profile shared',
      detail: `${appName} received ${fields.join(', ')}.`,
      status: 'complete',
      source: 'local',
    });
    pushToast({
      tone: 'success',
      title: `${appName} connected`,
      body: `${fields.length} profile ${fields.length === 1 ? 'field' : 'fields'} shared.`,
    });
  };

  /* ---------------------------------------------------------------------- */
  /* The app-to-account seam — a framed dApp asking Passport to pay          */
  /*                                                                        */
  /* An app never touches the wallet, and since 2026/08/24 neither does the  */
  /* payment: it posts a transaction request, the in-app browser shows the   */
  /* approval sheet, and only on approval does the callback below run a      */
  /* `withdraw_night` against this Passport's account-custody contract. The  */
  /* wallet signs the transaction and its fee is sponsored; the value moves  */
  /* out of the ACCOUNT. The response protocol is unchanged — a txId only    */
  /* ever accompanies a transaction the node really took.                    */
  /* ---------------------------------------------------------------------- */

  /**
   * The per-transaction approval ceremony for the open passkey session.
   *
   * The wallet seed lives in memory once a session is open, so without this a
   * submission would be a bare click. The platform's own verification sheet —
   * Touch ID, fingerprint, device PIN — is the approval UI, and a refusal
   * aborts before anything is signed. Exactly ONE ceremony per user-approved
   * action: a flow that makes several chain transactions from one approval
   * calls this once. A session restored without its profile has no credential
   * to assert against, and fails closed rather than skipping the ceremony.
   *
   * This remains the ceremony for the ONE flow that needs no secret of its own
   * — the permissionless deposit that sweeps legacy wallet funds into the
   * account. Every gated account call uses {@link withAccountDeviceSecret}
   * instead, because the assertion that yields the device secret IS a
   * user-verified assertion and a `confirmPresence` on top of it would
   * double-prompt for one user action.
   */
  const confirmLocalApproval = useCallback(
    async (reason: string): Promise<void> => {
      const passkey = profile?.passkey;
      if (!passkey?.credentialId) {
        throw new PasskeyPresenceError(
          'presence-unavailable',
          'Passport cannot find the passkey this session signed in with, so nothing was signed or sent. Sign in again, then retry.',
        );
      }
      try {
        await withPasskeyWatchdog(() => confirmPresence(passkey, reason));
      } catch (cause) {
        /* Same ceremony, same platform sheet, same two things it can mean —
           so the same offer. Nothing has been signed or submitted here either. */
        throw midSessionCeremonyFailure(cause);
      }
    },
    [profile],
  );

  /**
   * ONE user-verified assertion, turned into the account contract's device
   * secret, held for exactly one call, and zeroed.
   *
   * THE CEREMONY AND THE SECRET ARE THE SAME EVENT. `assertOnce` runs one
   * assertion with `userVerification: 'required'`, so the platform's own
   * verification sheet is what the user answers — the same sheet
   * `confirmPresence` raises, and the same approval. Deriving through
   * {@link PASSPORT_CONTRACT_SCOPE} then costs no further prompt, exactly as
   * `claimAliasBoundToAccount` and `deployPassportContractOnChain` already do
   * it, and yields byte-identical material to either of them: same PRF salt,
   * same HKDF constants, so the device secret this produces is the one the
   * contract was DEPLOYED with and nothing else will pass `require_device`.
   *
   * The derivation is not ours to vary: `deriveAccountDeviceSecret` is
   * `derivePassportContractSecrets`'s own device half, re-exposed by
   * `identity/accountCustody.ts` so no caller re-derives from memory.
   *
   * Nothing outlives the call. The PRF handle is disposed the moment the root
   * secret exists, the root is zeroed the moment the device secret exists, and
   * the device secret is zeroed however `run` settles.
   */
  const withAccountDeviceSecret = useCallback(
    async <T,>(run: (deviceSecret: Uint8Array) => Promise<T>): Promise<T> => {
      const passkey = profile?.passkey;
      if (!passkey?.credentialId) {
        throw new PasskeyPresenceError(
          'presence-unavailable',
          'Passport cannot find the passkey this session signed in with, so nothing was signed or sent. Sign in again, then retry.',
        );
      }
      let oneShot: DiscoveredPassportPasskey;
      try {
        oneShot = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.assertOnce(passkey));
      } catch (cause) {
        /* Nothing has been built, proved, or submitted at this point — so this
           refusal can afford to be an offer. The Send sheet renders the two
           controls inside its own "Nothing was sent" notice; see
           `midSessionCeremonyFailure`. */
        throw midSessionCeremonyFailure(cause);
      }
      let rootSecret: Uint8Array;
      try {
        const { deriveWalletSeed } = await import('./lib/localWallet.js');
        rootSecret = await deriveWalletSeed(oneShot, PASSPORT_CONTRACT_SCOPE);
      } finally {
        oneShot.dispose();
      }
      let deviceSecret: Uint8Array;
      try {
        const { deriveAccountDeviceSecret } = await import('./identity/accountCustody.js');
        deviceSecret = await deriveAccountDeviceSecret(rootSecret);
      } finally {
        rootSecret.fill(0);
      }
      try {
        return await run(deviceSecret);
      } finally {
        deviceSecret.fill(0);
      }
    },
    [profile],
  );

  /**
   * The account this Passport spends from, or the refusal a caller should
   * surface instead of a send.
   *
   * `wallet-closed` and a missing contract are different failures and get
   * different sentences: one is a session that went away mid-flow, the other is
   * a Passport whose account was never deployed — which is a state onboarding
   * is supposed to have left behind, and which no amount of retrying will fix.
   */
  const requireAccount = useCallback((): { handle: LocalMidnightWallet; address: string } => {
    const handle = localWalletRef.current;
    if (!handle) {
      /* The account module's `AccountCustodyError` shape — `{ code, message }`
         — without a value import of `identity/accountCustody.ts`, which
         statically pulls the ledger and the wallet SDK in behind it. */
      throw Object.assign(
        new Error('The Passport signing session closed before this could be signed.'),
        { code: 'wallet-closed' as const },
      );
    }
    const account = accountContractOf();
    if (!account) {
      throw Object.assign(
        new Error(
          'This Passport has no account contract on this network yet, so there is nothing to pay from. Claim your name to have one deployed.',
        ),
        { code: 'contract-not-found' as const },
      );
    }
    return account;
  }, [accountContractOf]);

  /* ---------------------------------------------------------------------- */
  /* Sending to a `.night` name                                             */
  /*                                                                        */
  /* "A name, not an address" is the second promise the welcome screen makes */
  /* and the first thing Passport is FOR. Until 2026/08/30 the Send sheet    */
  /* could not keep it: `resolveAliasTarget` existed and was called from two */
  /* places, both of them checking one's own claim.                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Asks the `.night` registry what one name points at.
   *
   * Answers, rather than throws, for every state the registry can genuinely be
   * in about a name: nobody holds it, or somebody holds it and it points
   * somewhere Passport cannot pay. It THROWS only when the registry could not
   * be read, because "nobody has this name" and "we could not find out" are
   * different things to tell somebody who is about to send money — and the
   * sheet caches the first and never the second.
   *
   * A target that is not a CONTRACT is refused rather than paid. A Passport
   * name resolves to that Passport's account, which is a contract; a leaf
   * pointing at a bare key or a shielded address is somebody else's name shape,
   * and paying it would be Passport guessing at what its owner meant.
   */
  const resolveRecipientName = useCallback(
    async (domain: string): Promise<NameLookup> => {
      const network = selectedNetwork as MidnamesNetwork;
      const { normalizePassportAlias, resolveAliasTarget } = await import(
        './identity/midnames.js'
      );
      let label: string;
      try {
        label = normalizePassportAlias(domain);
      } catch {
        return { found: false, reason: 'That is not a Midnight name.' };
      }
      const resolved = await resolveAliasTarget(network, label);
      if (!resolved) {
        return { found: false, reason: `No Passport has the name ${label}.night on ${network}.` };
      }
      if (resolved.target.kind !== 'contract') {
        return {
          found: false,
          reason: `${label}.night is registered, but it does not point at a Passport account, so Passport cannot pay it.`,
        };
      }
      /* An all-zero target is a leaf that was never pointed at anything.
         Treating it as an account would send money to nobody. */
      if (/^0*$/.test(resolved.target.hex)) {
        return {
          found: false,
          reason: `${label}.night is registered, but no account has been attached to it yet.`,
        };
      }
      return {
        found: true,
        domain: `${label}.night`,
        accountAddress: resolved.target.hex,
      };
    },
    [selectedNetwork],
  );

  /**
   * Signs and submits a real unshielded NIGHT transfer for a framed app.
   *
   * Handed to the in-app browser ONLY while a local wallet is genuinely open —
   * an undefined callback is what makes the browser answer `wallet-unavailable`
   * instead of showing a sheet it could not honour.
   *
   * The circuit is `withdraw_night`, from this Passport's account contract to
   * the address the app asked for, in the native NIGHT colour. The consent is
   * unchanged — the sheet the browser already showed, and the one platform
   * verification that {@link withAccountDeviceSecret} raises. Refusals are
   * rethrown carrying a code `lib/txApproval.ts` maps, so the bridge's own
   * vocabulary is unchanged too; nothing is swallowed and nothing is invented.
   */
  const executeAppTransfer = useCallback(
    async (intent: {
      recipientAddress: string;
      amount: bigint;
      purpose: string;
      origin: string;
    }): Promise<{ txId: string }> => {
      const account = requireAccount();
      try {
        const { nightColourHex, withdrawNight } = await import('./identity/accountCustody.js');
        /* The approval sheet's Approve tap lands here; the ceremony IS the
           platform's verification sheet, raised once, and it is what yields the
           device secret the circuit is gated on. */
        return await withAccountDeviceSecret(async (deviceSecret) => {
          /* Raised only now the ceremony has answered: a cancelled approval
             signed nothing, so it leaves no trace in the feed either. */
          const entry = addActivity({
            label: intent.purpose,
            detail: `Requested by ${intent.origin}.`,
            status: 'pending',
            source: 'wallet',
          });
          try {
            const result = await withdrawNight(
              account.handle,
              deviceSecret,
              {
                contractAddress: account.address,
                colourHex: nightColourHex(),
                amount: intent.amount,
                recipientAddress: intent.recipientAddress,
              },
              (progress) => setAccountPhase(progress.phase),
            );
            updateActivity(entry.id, {
              status: 'complete',
              detail: `Paid from your account for ${intent.origin}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              title: 'Payment submitted',
              body: intent.purpose,
              link: explorerTxLink(result.txId, result.network),
            });
            // The account's balance has moved; the session row already carries
            // the transaction meanwhile.
            void refreshLocalBalances();
            return { txId: result.txId };
          } catch (cause) {
            updateActivity(entry.id, {
              status: 'error',
              detail: cause instanceof Error ? cause.message : String(cause),
              source: 'local',
            });
            throw cause;
          }
        });
      } catch (cause) {
        const code =
          typeof cause === 'object' && cause !== null &&
          typeof (cause as { code?: unknown }).code === 'string'
            ? (cause as { code: string }).code
            : null;
        const mapped = appTransferCodeFor(code);
        /* The contract's vocabulary translated into the app protocol's, and
           only where they differ — the object is otherwise rethrown untouched
           so its `detail` reaches the app unchanged. */
        if (mapped !== null && mapped !== code && cause instanceof Error) {
          throw Object.assign(cause, { code: mapped });
        }
        throw cause;
      } finally {
        setAccountPhase(null);
      }
    },
    [
      addActivity,
      refreshLocalBalances,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
    ],
  );

  /**
   * What an app is told about the account it is asking to spend from: the
   * network a recipient must belong to, and the balance the sheet quotes —
   * the ACCOUNT's NIGHT, because that is what the payment will come out of.
   * `null` whenever no local wallet is open.
   */
  const appTransferContext =
    localSessionActive && localWalletNetworkId
      ? {
          networkId: localWalletNetworkId,
          formattedBalance:
            accountBalances.night === null ? null : formatNightUnits(accountBalances.night),
        }
      : null;

  /* ---------------------------------------------------------------------- */
  /* The user's own Send — the same account call, initiated by the owner     */
  /*                                                                        */
  /* `executeAppTransfer` above is a framed app asking Passport to pay. This  */
  /* is the user asking Passport to pay, from the Send sheet on Home. The     */
  /* circuit, the activity row, the explorer link, and the two refreshes are  */
  /* deliberately the same — one transfer path, one set of side effects.      */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether the next transfer's fee would really be covered. Advisory — the
   * send path re-checks everything — so a failure here is thrown, not smoothed
   * into `unsponsored`: "we could not check" and "the sponsor is not covering
   * this" are different sentences, and the sheet says whichever is true.
   */
  const readLocalFeeReadiness = useCallback(
    async (options?: { force?: boolean }): Promise<FeeReadiness> => {
      const handle = localWalletRef.current;
      if (!handle) throw new Error('The Passport signing session is not open.');
      /* `force` is passed straight through: the Send sheet WATCHES this, and a
         watcher reading a 30-second cache would keep saying "waiting" for half
         the time the sponsor was already free. */
      return handle.feeReadiness(options);
    },
    [],
  );

  /**
   * The user's own NIGHT transfer, as a withdrawal from their account.
   *
   * The circuit is `withdraw_night` and the recipient is whatever `mn_addr…`
   * was pasted or scanned. Every refusal is rethrown untouched: an
   * `AccountCustodyError` already carries `{ code, message, detail }`, which is
   * exactly the shape the Send sheet renders, so nothing is swallowed and no
   * sentence is rewritten on the way through.
   */
  const executeOwnSend = useCallback(
    async (params: { recipientAddress: string; amount: bigint }): Promise<void> => {
      const account = requireAccount();
      try {
        const { nightColourHex, withdrawNight } = await import('./identity/accountCustody.js');
        /* The Send sheet's confirm lands here; the ceremony IS the platform's
           verification sheet, and it is what yields the device secret
           `withdraw_night` is gated on. */
        await withAccountDeviceSecret(async (deviceSecret) => {
          /* Raised only now the ceremony has answered: a cancelled approval
             signed nothing, so it writes no activity row either. */
          const entry = addActivity({
            label: 'Sending NIGHT',
            detail: `${formatNightUnits(params.amount)} NIGHT to ${compactAddress(
              params.recipientAddress,
            )}.`,
            status: 'pending',
            source: 'wallet',
          });
          try {
            const result = await withdrawNight(
              account.handle,
              deviceSecret,
              {
                contractAddress: account.address,
                colourHex: nightColourHex(),
                amount: params.amount,
                recipientAddress: params.recipientAddress,
              },
              (progress) => setAccountPhase(progress.phase),
            );
            updateActivity(entry.id, {
              status: 'complete',
              label: 'Sent NIGHT',
              detail: `${formatNightUnits(params.amount)} NIGHT left your account for ${compactAddress(
                params.recipientAddress,
              )}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              /* The node has accepted the transaction, not yet included it — the
                 title claims exactly that much and no more. */
              title: 'NIGHT accepted by the network — confirming',
              /* A covered fee is claimed on the strength of what the sponsor
                 really did: `balanceTx` refuses to build a transaction the
                 sponsor has not agreed to pay for, so a submitted transfer is
                 itself the evidence. */
              body: 'The fee sponsor covered the network fee.',
              link: explorerTxLink(result.txId, result.network),
            });
            // The account's balance has moved; the session row already carries
            // the transaction meanwhile.
            void refreshLocalBalances();
          } catch (cause) {
            updateActivity(entry.id, {
              status: 'error',
              detail: cause instanceof Error ? cause.message : String(cause),
              source: 'local',
            });
            throw cause;
          }
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code =
          typeof cause === 'object' && cause !== null &&
          typeof (cause as { code?: unknown }).code === 'string'
            ? (cause as { code: string }).code
            : null;
        if (code === 'wallet-closed') {
          // The sheet closes on this one, so the toast has to carry the message.
          pushToast({ tone: 'error', title: 'Nothing was sent', body: message });
        }
        throw cause;
      } finally {
        setAccountPhase(null);
      }
    },
    [
      addActivity,
      refreshLocalBalances,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
    ],
  );

  /**
   * Which leg of a send-to-name is running, for the sheet's progress line.
   *
   * It exists because a name's transfer is genuinely two transactions and the
   * person watching has to be told so — a progress line that hid the second
   * would leave an apparently finished send running for another minute.
   *
   * `returning` is the shielded path's fourth state and belongs to a FAILURE
   * rather than to the transfer: it is the amount being put back into the
   * sender's own account after the paying leg refused. See
   * {@link executeShieldedSendToName} for why that path puts money back where
   * the NIGHT path leaves it at the receiving address for Home to sweep in.
   */
  const [nameSendLeg, setNameSendLeg] = useState<
    'withdrawing' | 'settling' | 'depositing' | 'returning' | null
  >(null);

  /**
   * Which attempt at the running leg this is, for the sheet's progress line.
   *
   * `null` for a first attempt and for the wait between the legs. A retry is
   * shown rather than hidden: a step that silently restarted would leave
   * somebody watching a line that had said the same thing for a minute with no
   * way to tell patience from a hang.
   */
  const [nameSendAttempt, setNameSendAttempt] = useState<number | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Sends that have not finished                                            */
  /*                                                                         */
  /* Keyed by credential, exactly as the trail is, and for the same reason.   */
  /* The two `localStorage` calls are here rather than in `lib/sendLegs.ts`   */
  /* because storage cannot be drilled without a fake DOM; the parse that     */
  /* refuses a record nothing could resume and the writer that drops a        */
  /* finished one are the halves that CAN be, and both are.                   */
  /* ---------------------------------------------------------------------- */
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  /* Read by the orchestrator and by the incoming-transfer watch, both of which
     need the current list without re-subscribing when it changes. */
  const pendingSendsRef = useRef<PendingSend[]>([]);
  const pendingSendsLoadedFor = useRef<string | null>(null);

  const persistPendingSends = useCallback((next: PendingSend[]) => {
    pendingSendsRef.current = next;
    setPendingSends(next);
    const credentialId = profileRef.current?.passkey?.credentialId ?? null;
    if (!credentialId) return;
    try {
      window.localStorage.setItem(
        pendingSendsStorageKey(credentialId),
        serialisePendingSends(next),
      );
    } catch {
      /* A browser that refuses storage is a browser that cannot resume after a
         reload. Nothing else about the run depends on this write. */
    }
  }, []);

  const writePendingSend = useCallback(
    (record: PendingSend) => {
      persistPendingSends([
        record,
        ...pendingSendsRef.current.filter((entry) => entry.id !== record.id),
      ]);
    },
    [persistPendingSends],
  );

  const dropPendingSend = useCallback(
    (id: string) => {
      persistPendingSends(pendingSendsRef.current.filter((entry) => entry.id !== id));
    },
    [persistPendingSends],
  );

  const pendingSendsCredentialId = profile?.passkey?.credentialId ?? null;
  useEffect(() => {
    if (!pendingSendsCredentialId) {
      pendingSendsRef.current = [];
      setPendingSends([]);
      pendingSendsLoadedFor.current = null;
      return;
    }
    if (pendingSendsLoadedFor.current === pendingSendsCredentialId) return;
    pendingSendsLoadedFor.current = pendingSendsCredentialId;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(pendingSendsStorageKey(pendingSendsCredentialId));
    } catch {
      stored = null;
    }
    const records = readPendingSends(stored);
    pendingSendsRef.current = records;
    setPendingSends(records);
  }, [pendingSendsCredentialId]);

  /**
   * Paying a `.night` name — and why it is two transactions rather than one.
   *
   * A name resolves to that Passport's ACCOUNT, which is a contract. Two facts
   * about `contracts-stagenet/src/account.compact` decide everything here:
   *
   *   - `withdraw_night(color, amount, recipient: UserAddress)` sends through
   *     `right<ContractAddress, UserAddress>(recipient)`. The recipient is a
   *     USER address by type. There is no way to name a contract with it.
   *   - `night_balances` is an explicit mirror, and its own comment says so:
   *     "Deposits that bypass deposit_night are invisible to the mirror". A
   *     contract's unshielded holdings are not part of contract ledger state,
   *     so value pushed at a contract's 32 bytes by any other route is not
   *     value that account can see or spend. It is lost.
   *
   * So there is no honest one-transaction send to a name, and the tempting one
   * — hand the account's address to `withdraw_night` as if it were a user
   * address — is precisely the silent footgun: it would build, submit, and
   * succeed, and the money would be gone.
   *
   * What genuinely works is the pair. `deposit_night` is PERMISSIONLESS — the
   * contract's own comment: "anyone may fund an account" — and
   * {@link depositNight} takes the contract address as a parameter, so it can
   * target a stranger's account as easily as one's own. It needs no device
   * secret, because it is not spending from anything the recipient controls;
   * what it spends is the caller's own unshielded balance, which the SDK covers
   * when it balances the transaction. Hence:
   *
   *   1. `withdraw_night` out of the sender's account, to the SENDER's own
   *      receiving address. One passkey ceremony, because this is the only leg
   *      that spends from an account.
   *   2. wait for the wallet to actually see the money — `deposit_night` is
   *      balanced from real holdings, and a deposit built before the wallet has
   *      synced the arrival fails at balancing rather than at a check we wrote;
   *   3. `deposit_night` into the RECIPIENT's account. No ceremony, and the
   *      recipient's mirror is credited, which is the whole point.
   *
   * IF THE SECOND LEG FAILS the money is not lost and the row says exactly
   * where it is: at the sender's own receiving address, which is the state
   * Home's "Money outside your account" card exists for and offers to undo in
   * one transaction. That is the honest failure, and it is why the first leg
   * pays the sender rather than anywhere cleverer.
   */
  /**
   * ONE RUN, WRITTEN DOWN — the orchestrator both name sends go through.
   *
   * Until 2026/09/02 there were two of these, one per asset, and every fact
   * about a run in progress lived in the closure: `withdrawn`, `arrived`,
   * `heldBefore`, the leg. A reload took all of it, and what was left was value
   * parked at the sender's own receiving address with nothing on screen
   * offering to finish the transfer or put it back. Neither path retried
   * anything, so a fee sponsor whose change was settling — a state that clears
   * in a block — ended the transfer, and the sheet then said "Nothing was sent"
   * over a first leg that had landed.
   *
   * So the run is a RECORD (`lib/sendLegs.ts`), persisted before the first leg
   * is submitted and again at every transition, and this walks it:
   *
   *   1. `withdraw` — out of the sender's account to their OWN receiving
   *      address, inside a single passkey ceremony. Up to three attempts on a
   *      retryable failure, and the secret stays in the closure, so a retry
   *      costs no second prompt.
   *   2. `settle` — the wait for the wallet to actually hold what it withdrew.
   *      For NIGHT that is a RISE of at least the amount above what was held
   *      before, not a total; for a shielded run it is the note whose nonce was
   *      not held before (`lib/shieldedNote.ts`). A timeout leaves the record at
   *      `settle` rather than failing it: the money has moved and the arrival is
   *      still coming.
   *   3. `deposit` — the permissionless call into the RECIPIENT's account. No
   *      ceremony, because it spends nothing of theirs. Three attempts again,
   *      and only after those does a shielded run put the note back.
   *
   * Every failure is classified before it is acted on, and the classification
   * is the thing that decides whether the same step is attempted again — never
   * a substring match written here. See `classifyLegError`.
   */
  const runNameSend = useCallback(
    async (initial: PendingSend, options: { resumed?: boolean } = {}): Promise<void> => {
      const account = requireAccount();
      const {
        depositNight,
        depositShielded,
        prepareAccountDeposit,
        shieldedCoinFromNote,
        walletShieldedNotes,
        withdrawNight,
        withdrawShielded,
      } = await import('./identity/accountCustody.js');
      const { findArrivedNote, shieldedNoteIds } = await import('./lib/shieldedNote.js');

      const amount = BigInt(initial.amount);
      const amountText = pendingSendAmountLabel(initial);
      let record = initial;
      const save = (patch: Partial<PendingSend>): void => {
        record = { ...record, ...patch, updatedAt: new Date().toISOString() };
        writePendingSend(record);
      };

      /* The record and the feed row are raised TOGETHER, and both of them only
         once the ceremony has answered on a first run: a cancelled approval
         signed nothing, so it must leave neither a row in the trail nor a card
         on Home offering to continue a transfer that never began.

         A resumed run REUSES the row it opened, so a transfer that took three
         sessions to finish reads as one thing that happened. */
      const begin = (resumed: boolean): string => {
        if (record.activityId) {
          if (resumed) {
            updateActivity(record.activityId, {
              status: 'pending',
              detail: `${amountText}. Carrying on from where it stopped.`,
            });
          }
          return record.activityId;
        }
        const entry = addActivity({
          label: `Sending to ${record.recipient.label}`,
          detail: `${amountText}, in two steps.`,
          status: 'pending',
          source: 'wallet',
        });
        save({ activityId: entry.id });
        return entry.id;
      };

      /* What the Send sheet is handed. `legLanded` is the one fact its copy
         turns on: "nothing was sent" over a landed first leg is a false
         statement about where somebody's money is. */
      const failure = (cause: unknown, message: string, legLanded: boolean): Error =>
        Object.assign(new Error(message, { cause }), {
          code: 'name-send-failed' as const,
          legLanded,
        });

      let activityId = record.activityId ?? '';
      let settledNote: WalletShieldedNote | null = null;
      /* WHAT THE CHAIN HAS SEEN OF LEG ONE. `txIdResolved` is an indexer answer
         FOR that transaction, so a resolved hash IS the landing; an unresolved
         one leaves the 33-byte identifier, which the indexer can be asked about
         directly and cheaply while the wait runs. */
      let withdrawLanded = false;
      let withdrawIdentifier: string | null = null;
      /* LEG TWO'S CONNECTION, OPENED WHILE LEG ONE CONFIRMS (2026/09/03).
         Nothing about it depends on leg one: the recipient's account address
         was resolved before the send began, and `deposit_night` /
         `deposit_shielded` are permissionless, so the private state is empty.
         What it buys is the expensive half of reaching a contract — the
         compiled artefact, the providers, and `findDeployedContract`'s
         verifier-key read against the deployed build — off the critical path,
         so leg two's proof starts as soon as the note is there rather than a
         connection later. The fee gate is deliberately NOT prewarmed: it is
         one cached probe (`lib/sponsor.ts`, 30-second TTL) and a fresher
         answer is worth more than the round trip it would save.

         A failure here is absorbed, never propagated: the unprepared path
         still works, and a prewarm that could break a send would cost more
         than the wait it saves. */
      let depositConnection: Promise<PreparedAccountCall | null> | null = null;
      const prepareDeposit = (): void => {
        if (depositConnection !== null) return;
        depositConnection = prepareAccountDeposit(
          account.handle,
          record.recipient.accountAddress,
        ).catch((cause) => {
          console.info('[send] leg two could not be opened ahead of time', cause);
          return null;
        });
      };
      /* A RESUME GETS A FRESH BUDGET. The counts are what the record remembers
         about the run that stopped; carrying them into a new press would spend
         a person's Continue on a single attempt. */
      if (options.resumed) save({ attempts: { withdraw: 0, deposit: 0 } });

      const runWithdraw = async (deviceSecret: Uint8Array): Promise<void> => {
        activityId = begin(false);
        /* WHAT THE WALLET ALREADY HELD, read before anything is submitted and
           written down before it is used. Both halves matter: a shielded run
           identifies its note by the nonce that was NOT here, and a NIGHT run
           waits for a rise above this figure rather than for a total. */
        const expectedNote =
          record.kind === 'shielded'
            ? { heldBeforeIds: [...shieldedNoteIds(await walletShieldedNotes(account.handle))] }
            : {
                unshieldedBefore: (
                  atomicNightFromFormatted(
                    (await account.handle.getBalances()).unshieldedBalance,
                  ) ?? 0n
                ).toString(),
              };
        save({ expectedNote });
        for (let attempt = record.attempts.withdraw; ; attempt += 1) {
          setNameSendLeg('withdrawing');
          setNameSendAttempt(attempt + 1);
          try {
            const out =
              record.kind === 'night'
                ? await withdrawNight(
                    account.handle,
                    deviceSecret,
                    {
                      contractAddress: account.address,
                      colourHex: record.colourHex,
                      amount,
                      recipientAddress: record.ownReceivingAddress,
                    },
                    (progress) => setAccountPhase(progress.phase),
                  )
                : await withdrawShielded(
                    account.handle,
                    deviceSecret,
                    {
                      contractAddress: account.address,
                      colourHex: record.tokenType ?? record.colourHex,
                      amount,
                      recipientShieldedAddress: record.ownReceivingAddress,
                    },
                    (progress) => setAccountPhase(progress.phase),
                  );
            withdrawLanded = out.txIdResolved;
            withdrawIdentifier = out.txIdResolved ? null : out.txId;
            save({
              leg: 'settle',
              withdrawTxHash: out.txId,
              attempts: { ...record.attempts, withdraw: attempt + 1 },
              lastError: undefined,
            });
            updateActivity(activityId, {
              detail: `${amountText} left your account. Paying it into ${record.recipient.label}’s account next.`,
              source: 'chain',
              txHash: out.txId,
            });
            return;
          } catch (cause) {
            const verdict = classifyLegError(cause);
            save({
              attempts: { ...record.attempts, withdraw: attempt + 1 },
              lastError: { message: verdict.message, retryable: verdict.retryable },
            });
            if (!verdict.retryable || attempt + 1 >= SEND_LEG_ATTEMPTS) {
              throw failure(cause, verdict.message, false);
            }
            await pause(retryDelayMs(attempt));
          }
        }
      };

      /**
       * ONE LOOK at the sender's own wallet for what leg one paid in. No
       * network: this reads the state the wallet's live sync has applied.
       */
      const lookForArrival = async (): Promise<
        { arrived: false } | { arrived: true; note: WalletShieldedNote | null }
      > => {
        const expectation = record.expectedNote;
        if (record.kind === 'shielded') {
          const heldBefore = new Set(
            expectation && 'heldBeforeIds' in expectation ? expectation.heldBeforeIds : [],
          );
          const arrived = findArrivedNote(await walletShieldedNotes(account.handle), {
            tokenType: record.tokenType ?? record.colourHex,
            amount,
            heldBefore,
          });
          return arrived === null ? { arrived: false } : { arrived: true, note: arrived };
        }
        /* THE ARRIVAL, NOT THE TOTAL. This compared the wallet's whole
           unshielded balance against the amount until 2026/09/02, so a wallet
           that already held enough went straight on to the paying leg and
           built it against money that had not arrived — which fails inside the
           SDK, unreadably. */
        const before =
          expectation && 'unshieldedBefore' in expectation
            ? BigInt(expectation.unshieldedBefore)
            : 0n;
        const held = atomicNightFromFormatted(
          (await account.handle.getBalances()).unshieldedBalance,
        );
        return held !== null && held >= before + amount
          ? { arrived: true, note: null }
          : { arrived: false };
      };

      /**
       * THE WAIT BETWEEN THE LEGS — 20 to 30 seconds of a 54-second NIGHT send
       * until 2026/09/03, and most of it spent not asking.
       *
       * It was a flat two-or-three-second sleep around the look above, so the
       * arrival was noticed up to a whole tick after it happened, and the tick
       * had been chosen for a client that never asked the CHAIN anything. It
       * asks now: `withdrawIdentifier` is leg one's own transaction identifier
       * and one indexer point lookup answers whether it has landed, at which
       * moment the wallet is re-read immediately and thereafter every 400 ms —
       * see `watchForSettlement` in `lib/sendLegs.ts` for the two cadences and
       * why they are what they are.
       *
       * The deadline behaviour is unchanged and deliberate: a wait that runs
       * out leaves the record at `settle` rather than failing it, because the
       * money has moved and the arrival is still coming.
       */
      const runSettle = async (): Promise<WalletShieldedNote | null> => {
        setNameSendLeg('settling');
        setNameSendAttempt(null);
        /* Leg two's connection, started before the first look rather than
           after the last one. */
        prepareDeposit();
        /* The chain's own answer about leg one: one point lookup of the
           identifier the withdrawal came back with. Absent where leg one
           already resolved its ledger hash, which is the same evidence. */
        const identifier = withdrawIdentifier;
        let confirmLanded: (() => Promise<boolean>) | undefined;
        if (identifier !== null) {
          const { resolveDeployTxHashOnce } = await import('./identity/passportContract.js');
          confirmLanded = async () =>
            (await resolveDeployTxHashOnce(
              account.handle.network.indexerHttpUrl,
              identifier,
            )) !== null;
        }
        const outcome = await watchForSettlement<WalletShieldedNote | null>({
          readWallet: lookForArrival,
          landed: withdrawLanded,
          confirmLanded,
          /* The surfaces catch up with the chain rather than with the next
             render: the amount has demonstrably left the account by now, and
             Home was showing the figure from before it did. */
          onLanded: () => {
            void refreshLocalBalances();
          },
          now: () => Date.now(),
          sleep: pause,
          deadlineMs: SETTLE_DEADLINE_MS,
        });
        if (outcome.settled) return outcome.note;
        /* Left at `settle`, not failed: the amount has moved and the arrival
           is still coming. Home offers to look again. */
        const message = `${amountText} left your account and has not reached your Passport yet.`;
        save({ leg: 'settle', lastError: { message, retryable: true } });
        throw failure(new Error(message), message, true);
      };

      const runDeposit = async (note: WalletShieldedNote | null): Promise<void> => {
        save({ leg: 'deposit' });
        /* Whatever the prewarm managed, or nothing — a resumed run that skipped
           the wait never started one, and the deposit opens its own.

           FIRST ATTEMPT ONLY. A retryable refusal is a REBUILD (see
           `classifyLegError`): the state it was proved against has moved, so
           the next attempt opens the contract again rather than reusing a
           connection made before the failure. The prewarm's whole value is on
           the attempt that follows the wait, which is the one that succeeds. */
        let prepared = depositConnection === null ? null : await depositConnection;
        for (let attempt = record.attempts.deposit; ; attempt += 1) {
          setNameSendLeg('depositing');
          setNameSendAttempt(attempt + 1);
          try {
            const paid =
              record.kind === 'night'
                ? await depositNight(
                    account.handle,
                    {
                      contractAddress: record.recipient.accountAddress,
                      colourHex: record.colourHex,
                      amount,
                      prepared,
                    },
                    (progress) => setAccountPhase(progress.phase),
                  )
                : await depositShielded(
                    account.handle,
                    {
                      contractAddress: record.recipient.accountAddress,
                      coin: shieldedCoinFromNote(note as WalletShieldedNote),
                      prepared,
                    },
                    (progress) => setAccountPhase(progress.phase),
                  );
            save({
              leg: 'done',
              attempts: { ...record.attempts, deposit: attempt + 1 },
              lastError: undefined,
            });
            dropPendingSend(record.id);
            updateActivity(activityId, {
              status: 'complete',
              label: `Sent to ${record.recipient.label}`,
              detail: `${amountText} is now in ${record.recipient.label}’s account.`,
              source: 'chain',
              txHash: paid.txId,
            });
            pushToast({
              tone: 'success',
              /* Accepted, not yet included — the same claim every other
                 transfer on this surface makes. */
              title: `${record.recipient.label} paid — confirming`,
              body: 'The fee sponsor covered both network fees.',
              link: explorerTxLink(paid.txId, paid.network),
            });
            void refreshLocalBalances();
            return;
          } catch (cause) {
            const verdict = classifyLegError(cause);
            prepared = null;
            save({
              attempts: { ...record.attempts, deposit: attempt + 1 },
              lastError: { message: verdict.message, retryable: verdict.retryable },
            });
            if (!verdict.retryable || attempt + 1 >= SEND_LEG_ATTEMPTS) {
              throw failure(cause, verdict.message, true);
            }
            await pause(retryDelayMs(attempt));
          }
        }
      };

      try {
        if (!record.withdrawTxHash) {
          await withAccountDeviceSecret((deviceSecret) => runWithdraw(deviceSecret));
        } else {
          activityId = begin(options.resumed ?? false);
          /* A run being carried on submitted its first leg in an earlier pass
             of this function — a reload ago at least — so the chain has had it
             for longer than any block time. Nothing is gained by asking the
             indexer whether a minutes-old transaction landed, and the record
             keeps the resolved HASH rather than the identifier the lookup takes. */
          withdrawLanded = true;
        }
        /* A shielded run needs the note itself however far it had got: the
           deposit consumes one specific note and only this can name it. A NIGHT
           run past `settle` has already seen its arrival. */
        if (record.kind === 'shielded' || record.leg === 'settle') {
          settledNote = await runSettle();
        }
        await runDeposit(settledNote);
      } catch (cause) {
        const legLanded = Boolean(record.withdrawTxHash);
        const message = cause instanceof Error ? cause.message : String(cause);

        /* THE LAST RESORT, and only now the paying leg has had its three
           attempts: the note goes back into the sender's own account, where it
           is spendable again. The NIGHT path needs no equivalent — Home's
           "Money outside your account" card sweeps unshielded value in on one
           press, and that card cannot see a note. */
        let returned = false;
        if (record.kind === 'shielded' && record.leg === 'deposit' && settledNote !== null) {
          try {
            setNameSendLeg('returning');
            await depositShielded(
              account.handle,
              { contractAddress: account.address, coin: shieldedCoinFromNote(settledNote) },
              (progress) => setAccountPhase(progress.phase),
            );
            returned = true;
          } catch (returnCause) {
            /* The ORIGINAL failure is what the reader is told about; this one
               only changes which sentence says where the money is. The record
               keeps the note's identity either way, so the run is still
               resumable from Home. */
            console.info(
              '[send] the shielded amount could not be returned to the account',
              returnCause,
            );
          }
        }

        if (returned || !legLanded) {
          /* Nothing of theirs is anywhere it should not be: either the note is
             back in the account, or the first leg never spent. Neither is a
             thing to offer a Continue button over. */
          dropPendingSend(record.id);
        } else if (record.leg !== 'settle') {
          save({ leg: 'failed' });
        }

        if (activityId) {
          updateActivity(activityId, {
            status: 'error',
            label: legLanded ? `${record.recipient.label} was not paid yet` : 'Nothing was sent',
            /* WHERE THE MONEY IS. A half-finished transfer is the one state
               where saying only "it failed" would be a lie by omission. */
            detail: returned
              ? `${message} Nothing was paid to ${record.recipient.label}, and the ${amountText} is back in your account.`
              : legLanded
                ? `${message} The ${amountText} is waiting at your Passport — Home offers to carry the payment on.`
                : message,
            source: 'local',
          });
        }
        if (legLanded) {
          pushToast({
            tone: 'error',
            title: `${record.recipient.label} was not paid yet`,
            body: returned
              ? `Your ${amountText} is back in your account.`
              : `Your ${amountText} is safe. Carry the payment on from Home.`,
          });
          void refreshLocalBalances();
        }
        throw cause;
      } finally {
        setNameSendLeg(null);
        setNameSendAttempt(null);
        setAccountPhase(null);
      }
    },
    [
      addActivity,
      dropPendingSend,
      refreshLocalBalances,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
      writePendingSend,
    ],
  );

  /**
   * Carrying on a run that stopped — the Home card's Continue.
   *
   * A PRESENCE CEREMONY stands in front of it, because a resume moves money and
   * nothing that moves money in Passport is promptless. Which ceremony depends
   * on what is left to do: leg two is permissionless and needs only the
   * confirmation, while a run that never spent has to raise the account's own
   * assertion — and the orchestrator raises that one itself, so asking for a
   * confirmation first would be two prompts for one press.
   */
  const continuePendingSend = useCallback(
    async (id: string): Promise<void> => {
      const record = pendingSendsRef.current.find((entry) => entry.id === id);
      if (!record) return;
      try {
        if (record.withdrawTxHash) {
          await confirmLocalApproval(`Continue sending to ${record.recipient.label}`);
        }
        await runNameSend(record, { resumed: true });
      } catch (cause) {
        /* The trail row and the toast are the orchestrator's, and a refused
           ceremony has its own. Nothing here says any of it twice. */
        console.info('[send] carrying the payment on did not finish', cause);
      }
    },
    [confirmLocalApproval, runNameSend],
  );

  const executeSendToName = useCallback(
    async (params: {
      domain: string;
      accountAddress: string;
      amount: bigint;
    }): Promise<void> => {
      const ownReceivingAddress = localSurfaces?.unshieldedAddress ?? null;
      if (!ownReceivingAddress) {
        throw Object.assign(
          new Error(
            'Passport cannot see its own receiving address yet, so it cannot route a payment there. Try again in a moment.',
          ),
          { code: 'wallet-closed' as const },
        );
      }
      const { nightColourHex } = await import('./identity/accountCustody.js');
      await runNameSend(
        newPendingSend({
          kind: 'night',
          recipient: { label: params.domain, accountAddress: params.accountAddress },
          amount: params.amount,
          colourHex: nightColourHex(),
          ownReceivingAddress,
        }),
      );
    },
    [localSurfaces, runNameSend],
  );

  /**
   * The shielded colours the ACCOUNT holds, from its own `coins` map.
   *
   * Not the wallet's: the wallet may hold shielded notes of its own and none of
   * them is spendable by a `withdraw_shielded`, which moves what the CONTRACT
   * holds. Reading them here would offer the user a colour the circuit would
   * then refuse.
   *
   * Thrown, not smoothed, when the account cannot be read: "we could not read
   * your shielded balances" and "you hold none" are different sentences, and
   * the Send sheet shows whichever is true.
   */
  const readAccountShieldedHoldings = useCallback(async (): Promise<
    { tokenType: string; amount: bigint }[]
  > => {
    const account = accountContractOf();
    if (!account) {
      throw new Error('This Passport has no account contract on this network yet.');
    }
    const { readAccountState } = await import('./identity/accountCustody.js');
    const state = await readAccountState(account.handle.network, account.address);
    return [...state.shieldedCoins]
      .filter(([, amount]) => amount > 0n)
      .map(([tokenType, amount]) => ({ tokenType, amount }));
  }, [accountContractOf]);

  /**
   * The user's own shielded transfer — the Otrix totem case: a QR carrying a
   * `mn_shield-addr…` deposit address, paid out of this Passport's account.
   *
   * The circuit is `withdraw_shielded`, and it takes the WHOLE recipient
   * address rather than the coin key inside it: midnight-js builds the note's
   * ciphertext client-side and needs the recipient's encryption key, which only
   * the full bech32m address carries. See `WithdrawShieldedRequest`.
   *
   * Deliberately the same shape as {@link executeOwnSend}: one ceremony, one
   * activity row, refusals rethrown untouched, and a covered fee claimed only
   * on the strength of what the sponsor really did.
   */
  const executeOwnShieldedSend = useCallback(
    async (params: {
      recipientAddress: string;
      tokenType: string;
      amount: bigint;
    }): Promise<void> => {
      const account = requireAccount();
      try {
        const { withdrawShielded } = await import('./identity/accountCustody.js');
        await withAccountDeviceSecret(async (deviceSecret) => {
          const entry = addActivity({
            label: 'Sending a shielded token',
            detail: `${params.amount} units to ${compactAddress(params.recipientAddress)}.`,
            status: 'pending',
            source: 'wallet',
          });
          try {
            const result = await withdrawShielded(
              account.handle,
              deviceSecret,
              {
                contractAddress: account.address,
                colourHex: params.tokenType,
                amount: params.amount,
                recipientShieldedAddress: params.recipientAddress,
              },
              (progress) => setAccountPhase(progress.phase),
            );
            updateActivity(entry.id, {
              status: 'complete',
              label: 'Sent a shielded token',
              detail: `${params.amount} units left your account for ${compactAddress(
                params.recipientAddress,
              )}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              /* Accepted, not yet included — the same claim the NIGHT path makes. */
              title: 'Shielded transfer accepted by the network — confirming',
              body: 'The fee sponsor covered the network fee.',
              link: explorerTxLink(result.txId, result.network),
            });
            void refreshLocalBalances();
          } catch (cause) {
            updateActivity(entry.id, {
              status: 'error',
              detail: cause instanceof Error ? cause.message : String(cause),
              source: 'local',
            });
            throw cause;
          }
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code =
          typeof cause === 'object' && cause !== null &&
          typeof (cause as { code?: unknown }).code === 'string'
            ? (cause as { code: string }).code
            : null;
        if (code === 'wallet-closed') {
          pushToast({ tone: 'error', title: 'Nothing was sent', body: message });
        }
        throw cause;
      } finally {
        setAccountPhase(null);
      }
    },
    [
      addActivity,
      refreshLocalBalances,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
    ],
  );

  /**
   * Paying a `.night` name in a SHIELDED asset — a Passport-to-Passport
   * shielded transfer.
   *
   * WHY THIS IS TWO TRANSACTIONS, AND WHAT IT WOULD TAKE TO MAKE IT ONE
   * -------------------------------------------------------------------
   * Both halves of the pair already exist in `account.compact` and neither can
   * be made to reach the other in a single call:
   *
   *   - `withdraw_shielded(recipient: ZswapCoinPublicKey, colour, amount)`
   *     sends through `left<ZswapCoinPublicKey, ContractAddress>(recipient)`.
   *     The recipient is a USER key BY TYPE, so a recipient account cannot be
   *     named with it at all. Unlike the NIGHT withdrawal this fails CLOSED
   *     rather than silently: the address decoder refuses anything that is not
   *     an `mn_shield-addr…`, and the transaction builder refuses to resolve an
   *     encryption key for contract bytes before anything is submitted.
   *   - `deposit_shielded(coin: ShieldedCoinInfo)` calls no `require_device()`,
   *     so it is permissionless exactly as `deposit_night` is — anyone may pay
   *     into a stranger's account. What it takes is one WHOLE note, nonce and
   *     all, because `receiveShielded` consumes that specific note.
   *
   * The two cannot be batched into one transaction either: batching is scoped
   * to a single contract by design, and the two legs are two different
   * accounts. One transaction would need a NEW circuit on the account contract
   * making a cross-contract call — send in the caller, receive in the callee —
   * and adding any circuit to `account.compact` invalidates every account
   * already deployed, because opening a contract verifies EVERY local circuit's
   * verifier key against the deployed state. That is a migration for every
   * existing Passport, and it is not this unit's to spend.
   *
   * So the pair, mirroring {@link executeSendToName} step for step:
   *
   *   1. `withdraw_shielded` out of the sender's account to the SENDER's own
   *      shielded address, for EXACTLY the transfer amount — because a note is
   *      deposited whole, and a note larger than the amount cannot be split on
   *      the way in. One passkey ceremony, because this is the only leg that
   *      spends from an account;
   *   2. wait for the wallet to hold the note, and identify it by NONCE rather
   *      than by colour and value. A wallet that already held a note of the
   *      same colour and the same size would otherwise offer two candidates and
   *      the wrong one strands the new one — see `lib/shieldedNote.ts`, which
   *      holds that rule and is drilled directly;
   *   3. `deposit_shielded` that exact note into the RECIPIENT's account. No
   *      ceremony, and the recipient's own `coins` ledger is credited, which is
   *      what makes the value theirs to spend.
   *
   * IF THE PAYING LEG FAILS the money is put BACK into the sender's account,
   * which is where this path departs from the NIGHT one. That is not cleverness
   * for its own sake: the NIGHT path can leave the amount at the receiving
   * address because Home's "Money outside your account" card sweeps unshielded
   * value back in on one press, and that card cannot see a shielded note. With
   * no card to hand the reader, the honest thing is to undo the leg that did
   * run — one more permissionless deposit, no ceremony — and say so. If the
   * return ALSO fails, or the note never arrived to return, the row says
   * exactly where the value is rather than claiming it came back.
   *
   * PRIVACY, said plainly because the contract's own header admits it: value
   * held by an account is PUBLIC ledger state. This hides the sender and the
   * recipient from the shielded pool, and it does not hide the amount from
   * anybody reading either account. Nothing in the copy implies otherwise.
   */
  const executeShieldedSendToName = useCallback(
    async (params: {
      domain: string;
      accountAddress: string;
      tokenType: string;
      amount: bigint;
    }): Promise<void> => {
      const ownShieldedAddress = localSurfaces?.shieldedAddress ?? null;
      if (!ownShieldedAddress) {
        throw Object.assign(
          new Error(
            'Passport cannot see its own receiving address yet, so it cannot route a payment there. Try again in a moment.',
          ),
          { code: 'wallet-closed' as const },
        );
      }
      await runNameSend(
        newPendingSend({
          kind: 'shielded',
          recipient: { label: params.domain, accountAddress: params.accountAddress },
          amount: params.amount,
          tokenType: params.tokenType,
          colourHex: params.tokenType,
          ownReceivingAddress: ownShieldedAddress,
        }),
      );
    },
    [localSurfaces, runNameSend],
  );

  /**
   * Sweeps NIGHT the passkey WALLET still holds into the account contract.
   *
   * The one flow that runs the other way, and the one that needs no device
   * secret: `deposit_night` is permissionless, so anybody may fund an account,
   * and what makes the money move is the balancing — `receiveUnshielded` leaves
   * the transaction short and the wallet provider covers it from the wallet's
   * own funds. The approval is therefore a plain presence confirmation.
   *
   * It exists because the contract's own header is explicit that NIGHT reaching
   * it by any route other than `deposit_night` is invisible to it. A Passport
   * from before the account ruling — or one a faucet dripped straight to its
   * wallet address — holds funds that no `withdraw_night` can see, and this is
   * the only way to make them spendable again.
   */
  const moveWalletFundsIntoAccount = useCallback(async (): Promise<void> => {
    if (depositBusy) return;
    const account = accountContractOf();
    if (!account) return;
    const held = atomicNightFromFormatted(localSurfaces?.unshieldedBalance ?? null);
    if (held === null || held <= 0n) return;
    setDepositBusy(true);
    setError(null);
    let entryId: string | null = null;
    try {
      await confirmLocalApproval('Move your funds into your account');
      entryId = addActivity({
        label: 'Moving funds into your account',
        detail: `${formatNightUnits(held)} NIGHT from your receiving address into your account.`,
        status: 'pending',
        source: 'wallet',
      }).id;
      const { depositNight, nightColourHex } = await import('./identity/accountCustody.js');
      const result = await depositNight(
        account.handle,
        { contractAddress: account.address, colourHex: nightColourHex(), amount: held },
        (progress) => setAccountPhase(progress.phase),
      );
      updateActivity(entryId, {
        status: 'complete',
        detail: `${formatNightUnits(held)} NIGHT now sits in your account.`,
        source: 'chain',
        txHash: result.txId,
      });
      pushToast({
        tone: 'success',
        title: 'Funds moved into your account',
        body: `${formatNightUnits(held)} NIGHT is now spendable from your Passport.`,
        link: explorerTxLink(result.txId, result.network),
      });
      void refreshLocalBalances();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = (cause as { detail?: string })?.detail;
      const reason = detail ? `${message} — ${detail}` : message;
      if (entryId) {
        updateActivity(entryId, { status: 'error', detail: reason, source: 'local' });
      }
      setError(reason);
    } finally {
      setAccountPhase(null);
      setDepositBusy(false);
    }
  }, [
    accountContractOf,
    addActivity,
    confirmLocalApproval,
    depositBusy,
    localSurfaces?.unshieldedBalance,
    refreshLocalBalances,
    updateActivity,
  ]);

  /**
   * The Send seam handed to Home — `null` unless a local wallet session is
   * genuinely open AND this Passport has a deployed account contract to spend
   * from. Home renders no Send control at all in that case, rather than a
   * disabled one implying the account nearly could.
   */
  const homeSend =
    localSessionActive && localWalletNetworkId && localWalletProvingMode && accountContractAddress
      ? {
          networkId: localWalletNetworkId,
          provingMode: localWalletProvingMode,
          readFeeReadiness: readLocalFeeReadiness,
          onSend: executeOwnSend,
          readShieldedHoldings: readAccountShieldedHoldings,
          onSendShielded: executeOwnShieldedSend,
          /* The two halves of sending to a name. Supplied together or not at
             all: a sheet that could resolve a name but not pay it would offer
             a promise nothing behind it could keep. */
          resolveName: resolveRecipientName,
          onSendToName: executeSendToName,
          /* The shielded half of paying a name. Supplied separately from
             `onSendToName` because it is a different pair of circuits, and a
             build that had one and not the other must refuse the combination
             it cannot make rather than quietly route it to the other one. */
          onSendShieldedToName: executeShieldedSendToName,
          phase: accountPhase,
          nameLeg: nameSendLeg,
          nameLegAttempt: nameSendAttempt,
        }
      : null;

  /**
   * What Home shows as this Passport's money: the account contract's own
   * ledger, split into the stablecoin the sponsor named and everything else.
   *
   * `null` when there is no deployed contract — the asset row is then absent
   * rather than showing zeros against an account that does not exist. The
   * contract card directly below already says why.
   */
  const homeAccount = accountContractAddress
    ? {
        nightBalance:
          accountBalances.night === null ? null : formatNightUnits(accountBalances.night),
        stablecoin: stablecoin
          ? {
              symbol: stablecoin.symbol,
              /* Carried alongside the symbol because the sponsor's answer is
                 the AUTHORITY on what that colour is called, and the Send
                 sheet's picker has to name the same colour the same way. */
              colourHex: stablecoin.colourHex,
              /* A colour the account does not hold is a real zero — the sponsor
                 named the colour, so the row belongs on screen either way. */
              amount:
                accountBalances.shielded.find((held) => held.colourHex === stablecoin.colourHex)
                  ?.amount ?? 0n,
            }
          : null,
        otherShielded: accountBalances.shielded.filter(
          (held) => held.colourHex !== stablecoin?.colourHex,
        ),
        status: accountBalances.status,
        error: accountBalances.error,
      }
    : null;

  /**
   * The dApp payment seam, handed over only when there is genuinely an account
   * to pay from. Withheld, an app is answered `wallet-unavailable` before a
   * sheet is ever shown — the same rule the Send control keeps, and better than
   * an approval that could only end in a refusal.
   */
  const appTransferSeam =
    localSessionActive && accountContractAddress ? executeAppTransfer : undefined;

  /**
   * NIGHT that reached the passkey wallet's ADDRESS from outside this app, and
   * the one honest remediation for it.
   *
   * Nothing Passport does puts money there: the service registers the name and
   * funds the ACCOUNT, and every value flow the user can start is an account
   * circuit. But an address is an address — a faucet, an old Passport, or
   * somebody paying the receiving address by hand will all land NIGHT at the
   * wallet, where the account cannot see it and `withdraw_night` cannot spend
   * it. So the card offers a `deposit_night` and says plainly that this money
   * is outside the account.
   *
   * Gated on a POSITIVE balance and on there being an account to move it into.
   * `null` — an unknown balance — is not an offer to move nothing, and an
   * account that does not exist is nowhere to move it to. `walletHeldNight` is
   * the sole consumer of the wallet's own balance in this component; see
   * {@link refreshLocalBalances}.
   */
  const walletHeldNight = atomicNightFromFormatted(localSurfaces?.unshieldedBalance ?? null);
  /**
   * The trail, as Home renders it: the rows plus the explorer link each one
   * earns.
   *
   * The link is built from the row's OWN network, not the selected one, and
   * only where the row carries a ledger transaction hash. Where it does not,
   * there is no link at all rather than one that goes nowhere — the same rule
   * the success toasts follow, and for the same reason.
   */
  const homeActivity = useMemo<ActivityFeedItem[]>(() => {
    /* THE ONE ROW THAT IS STILL FIXABLE (2026/09/02). The opening grant has its
       own ten-minute schedule and can run out of it — a Passport then has its
       name and its stablecoin on the trail and no NIGHT, with the row that says
       so and nothing to press. The marker is only ever written on evidence the
       grant landed, so `fundAccountOnce` will genuinely ask again; which row
       carries the control is decided by `activationRetryRowId`, and it is at
       most one. No account, no control: there would be nothing to fund. */
    const retryRowId = accountContractAddress ? activationRetryRowId(activity) : null;
    const address = accountContractAddress;
    return activity.map((entry) => {
      const link = explorerTxLink(entry.txHash, entry.network ?? selectedNetwork);
      return {
        id: entry.id,
        label: entry.label,
        detail: entry.detail,
        status: entry.status,
        createdAt: entry.createdAt,
        ...(entry.txHash ? { txHash: entry.txHash } : {}),
        ...(entry.network ? { network: entry.network } : {}),
        ...(link ? { link } : {}),
        ...(address !== null && entry.id === retryRowId
          ? {
              retry: {
                label: 'Retry',
                busy: grantRetryBusy,
                run: () => {
                  setGrantRetryBusy(true);
                  void fundAccountOnce(address).finally(() => setGrantRetryBusy(false));
                },
              },
            }
          : {}),
      };
    });
  }, [accountContractAddress, activity, fundAccountOnce, grantRetryBusy, selectedNetwork]);

  /**
   * The unfinished payments Home offers to carry on.
   *
   * Every record that is not `done` earns a card: a run at `settle` is waiting
   * for the amount to reach this Passport, one at `deposit` or `failed` has
   * money here that has not been paid on, and one still at `withdraw` never
   * spent — which is the only one there is anything to forget about.
   *
   * NO MACHINERY IN ANY OF THESE SENTENCES. The step lines say what happened to
   * the money, in the same two-step language the Send sheet uses.
   */
  const homePendingSends = useMemo(
    () =>
      pendingSends.map((record) => ({
        id: record.id,
        label: `Sending ${pendingSendAmountLabel(record)} to ${record.recipient.label}`,
        step: !record.withdrawTxHash
          ? 'Nothing has left your account yet.'
          : record.leg === 'settle'
            ? 'Step 1 done. Waiting for the amount to reach your Passport.'
            : `Step 1 done. Step 2 — paying it into ${record.recipient.label}’s account — has not finished.`,
        reason: record.lastError?.message ?? null,
        onContinue: () => void continuePendingSend(record.id),
        ...(record.withdrawTxHash
          ? {}
          : { onGiveUp: () => dropPendingSend(record.id) }),
      })),
    [continuePendingSend, dropPendingSend, pendingSends],
  );

  const homeLegacyFunds =
    accountContractAddress && walletHeldNight !== null && walletHeldNight > 0n
      ? {
          balance: formatNightUnits(walletHeldNight),
          busy: depositBusy,
          onMove: () => void moveWalletFundsIntoAccount(),
        }
      : null;

  /**
   * Records something an app says it granted. Passport never invents these:
   * the only writer is an app's own incentive report, and the store keys by id
   * so a repeated report updates one row rather than adding another.
   */
  const handleIncentiveRedeemed = useCallback(
    (incentive: { id: string; app: string; label: string; txId?: string }) => {
      saveIncentive({
        id: incentive.id,
        app: incentive.app,
        label: incentive.label,
        ...(incentive.txId ? { txId: incentive.txId } : {}),
        network: localWalletNetworkId ?? selectedNetwork,
        redeemedAt: new Date().toISOString(),
      });
      pushToast({
        tone: 'success',
        title: 'Added to your Passport',
        body: incentive.label,
      });
    },
    [localWalletNetworkId, selectedNetwork],
  );

  /**
   * Private-state backup, both directions.
   *
   * The module is imported on demand for the same reason the identity modules
   * are: nothing about a session that never opens the Backup screen should pay
   * for it. Neither callback takes anything from this component beyond the
   * password the user typed — `collectPassportBackup` reads its own three
   * stores and accepts no data, which is what makes "no key material in the
   * file" a property of the shape rather than a promise. See
   * `./identity/backup.ts`.
   *
   * Restoring writes through the stores' own save functions, and those publish
   * to the subscriptions this component already holds, so Home reflects a
   * restored name or contract without any refresh wiring here.
   */
  const exportPassportState = useCallback(async (password: string) => {
    const { exportPassportBackup } = await import('./identity/backup.js');
    const result = await exportPassportBackup(password);
    addActivity({
      label: 'Passport backup exported',
      detail: `Saved as ${result.fileName}, encrypted under a password Passport never stores. No keys are in it.`,
      status: 'complete',
      source: 'local',
    });
    return result;
  }, [addActivity]);

  /**
   * The chain re-check behind the Backup screen's promise.
   *
   * Every contract record a restore wrote is read back against the indexer the
   * open wallet uses, and the record is annotated with what the indexer said:
   * `ledgerConfirmed: true` where it answered, `false` where it did not. A
   * record is never DELETED on a negative — one unanswered read is not proof
   * that a contract is absent, only that this browser has not seen it — but it
   * also never keeps a confirmation it did not earn.
   *
   * Records for another network are left alone and counted: this session holds
   * exactly one indexer, the open wallet's, and asking it about a contract on
   * a different chain would produce a confident wrong answer.
   *
   * With no wallet open there is no indexer to ask. That case is reported as
   * such — never as a pass — and the effect further up (see
   * `attemptedContractConfirms`) performs the same read at the next sign-in.
   */
  const confirmRestoredContracts = useCallback(
    async (restoredKeys: string[]): Promise<PassportBackupLedgerCheck> => {
      if (restoredKeys.length === 0) {
        return {
          ran: false,
          reason: 'the backup wrote no contract records, so there was nothing to check.',
        };
      }
      const handle = localWalletRef.current;
      if (!handle) {
        return {
          ran: false,
          reason:
            'no Passport is open, so there was no indexer to ask. The check runs at your next sign-in.',
        };
      }
      const network = handle.network.networkId;
      const { confirmPassportContractOnLedger } = await import('./identity/passportContract.js');
      const records = loadPassportContractRecords();
      let confirmed = 0;
      let unconfirmed = 0;
      let otherNetworks = 0;
      for (const key of restoredKeys) {
        const record = records[key];
        if (!record || record.status !== 'deployed' || !record.address) continue;
        if (record.network !== network) {
          otherNetworks += 1;
          continue;
        }
        const live = await confirmPassportContractOnLedger(
          handle.network.indexerHttpUrl,
          record.address,
        );
        if (live) confirmed += 1;
        else unconfirmed += 1;
        if (record.ledgerConfirmed === live) continue;
        try {
          savePassportContractRecord({
            ...record,
            ledgerConfirmed: live,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          /* A RECOVERED record may not be held unconfirmed at all — the store
             refuses one whose read-back is not `true` — so it stays exactly as
             the file wrote it and is reported in the count above rather than
             quietly rewritten. */
        }
      }
      return { ran: true, network, confirmed, unconfirmed, otherNetworks };
    },
    [],
  );

  const restorePassportState = useCallback(
    async (file: File, password: string) => {
      const { importPassportBackup, describeBackupCreatedAt } = await import(
        './identity/backup.js'
      );
      /* A contract address that arrived in the file proves nothing on its
         own, so the registry re-check asks the chain: does that contract
         hold this Passport as a device? The device secret is derived under
         user verification for the length of the question and zeroed after,
         exactly as every other gated account call derives it. */
      const provesOwnership = async (network: string, address: string): Promise<boolean> => {
        const [{ accountHoldsDevice }, { MIDNAMES_INDEXER_URLS }] = await Promise.all([
          import('./identity/accountCustody.js'),
          import('./identity/midnames.js'),
        ]);
        const indexerHttpUrl = (MIDNAMES_INDEXER_URLS as Record<string, string | undefined>)[
          network
        ];
        /* No indexer for that network means the question cannot be put, which
           is not the same as "no": throwing keeps the two apart, and the
           re-check words it as a check that could not run. */
        if (!indexerHttpUrl) throw new Error(`No indexer is configured for ${network}.`);
        return withAccountDeviceSecret((deviceSecret) =>
          accountHoldsDevice({ indexerHttpUrl }, address, deviceSecret),
        );
      };
      const summary = await importPassportBackup(file, password, undefined, provesOwnership);
      /* Done HERE, as part of the restore, rather than promised for later: a
         restored contract record is a claim made by a file, and until the
         indexer answers for its address this browser has no evidence the
         contract is there. The result travels back with the summary so the
         Backup screen reports what actually happened rather than what was
         going to happen. */
      const ledgerCheck = await confirmRestoredContracts(summary.passportContracts.restoredKeys);
      /* The ACTIVITY LOG IS PERMANENT, so it may not carry a date this app
         never read. `openPassportBackup` now normalises an unreadable
         `createdAt` to absent, and this reads it through the same guard the
         Backup screen uses rather than interpolating the file's own text — the
         "Invalid Date" defect the screen took care to avoid, one layer up. */
      const takenAt = describeBackupCreatedAt(summary.createdAt);
      addActivity({
        label: 'Passport backup restored',
        detail: `${summary.aliases.restored} name(s) and ${summary.passportContracts.restored} account(s) came back from a backup ${
          takenAt === null ? 'with no readable date' : `taken ${takenAt}`
        }.${
          ledgerCheck.ran
            ? ` ${ledgerCheck.confirmed} confirmed on ${ledgerCheck.network}, ${ledgerCheck.unconfirmed} not yet.`
            : ''
        }`,
        status: 'complete',
        source: 'local',
      });
      return { ...summary, ledgerCheck };
    },
    [addActivity, confirmRestoredContracts, withAccountDeviceSecret],
  );

  /**
   * The display name Passport is willing to SHARE — the `displayName` field of
   * the profile a dApp may ask for, and the row the consent sheet offers.
   *
   * Until 2026/08/06 this was hardcoded to null on the passkey route, so the
   * very first field a developer requests came back withheld: the consent sheet
   * had nothing to tick, and every integration's "Hello, {name}" rendered
   * blank. A passkey Passport does have a name — the `.night` name it claimed
   * on its own wallet network, and failing that the label the passkey was
   * enrolled under — so it says so.
   *
   * Keyed on the CONFIGURED wallet network, not the selected one: this is the
   * name attached to the Passport whose addresses are being shared, and a name
   * claimed on preview says nothing about who holds it on pre-production.
   * Sharing is still consent-gated — nothing here changes what leaves without
   * a tick.
   */
  /* `configuredWalletNetwork` is null on a devnet build, which signs on no
     public network at all — there is then no per-network record to read, and
     the enrolled passkey's label is the honest answer. */
  const passkeyDisplayName =
    (configuredWalletNetwork ? aliasRecords[configuredWalletNetwork]?.domain : null) ??
    profile?.passkey.label ??
    null;
  const sessionDisplayName = passkeyDisplayName;

  /**
   * The greeting's subject on Home, which is a different question from the name
   * above: the alias already leads the greeting when there is one, so repeating
   * it beneath as a display name would say the same thing twice, and the
   * enrolled passkey's label ('Midnight Passport') is not a person's name. null
   * lets HomeScreen render its designed fallback — the greeting alone, set as a
   * display headline wrapped into ragged lines.
   */
  const homeDisplayName = null;

  /**
   * The name held on the ACTIVE network — the greeting's subject. Nothing is
   * borrowed from another network here: if this network has no record, the
   * greeting falls back to the display name, because claiming a name on
   * preview says nothing about who holds it on pre-production.
   */
  const activeAliasRecord = aliasRecords[selectedNetwork] ?? null;
  const aliasLabel = activeAliasRecord?.alias ?? null;
  /**
   * Why "Register now" cannot run right now, or null when it can. The demo
   * wallet signs on exactly one network — the one this build was configured
   * for; a missing or still-syncing session cannot pay or prove; each case
   * renders the action disabled with its honest sentence instead of leaving a
   * live button to fail.
   */
  const walletStillSyncing =
    localSessionActive &&
    ((activeSurfaces?.balanceStatus ?? 'loading') === 'loading' ||
      (localSyncPercent !== null && localSyncPercent < 100));
  const registerNowDisabledReason =
    (import.meta.env as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1'
      ? null /* demo mode: the mock claim needs no gating */
      : activeAliasRecord?.status === 'queued'
      ? selectedNetwork !== configuredWalletNetwork
        ? `Passport signs and submits on ${signingNetworkLabel} only, so ${activeAliasRecord.domain} cannot be registered on ${NETWORK_LABELS[selectedNetwork]} from here.`
        : !localSessionActive
          ? 'Sign in with your passkey to open Passport before registering this name.'
          : localWalletNetworkId !== configuredNetworkId() || !aliasClaimSupported
            /* Compared against the RAW configured id: under the env-gated demo
               masquerade the wallet's real network is a devnet presented as
               Preview, and that pairing is exactly the sanctioned one. */
            ? `This Passport session runs on ${localWalletNetworkId ?? 'an unknown network'}; names register on ${signingNetworkLabel} only.`
            : walletStillSyncing
              ? 'Passport is still syncing. Registration opens once the sync completes.'
              : null
      : null;
  /** Everything the identity card needs to re-run a queued claim honestly. */
  const registerNowProps = {
    onRegisterNow: () => void registerQueuedAlias(),
    registerNowDisabledReason,
    registerNowBusy,
    registerNowPhase: claimPhase,
  };
  const homeIdentity = {
    record: activeAliasRecord,
    incentives,
    onClaimName: () => {
      setAliasFailure(null);
      setIdentityStep('alias');
    },
    ...registerNowProps,
  };

  /* ---------------------------------------------------------------------- */
  /* The account-custody contract card on Home                              */
  /* ---------------------------------------------------------------------- */

  /**
   * What the two consent sheets may offer as "your Passport contract".
   *
   * One writer, one record: the contract the passkey wallet deploys from the
   * Home card lands in the contract STORE. It is offered only when it is
   * genuinely `'deployed'` with a real address — a failed deploy is not a
   * contract — and both address and network come from the record itself, so
   * the pair can never be assembled from two different networks.
   */
  const consentPassportContract =
    activeContractRecord?.status === 'deployed' && activeContractRecord.address
      ? { address: activeContractRecord.address, network: activeContractRecord.network }
      : null;

  /**
   * Why the deploy action cannot run right now, or null when it can. Same
   * discipline as `registerNowDisabledReason`: every case renders the action
   * disabled with its honest sentence rather than leaving a live button to fail.
   *
   * Note what is NOT here: the network the user is *browsing*. The card is about
   * the network the wallet signs on, so a browsing switch cannot make it lie.
   */
  const contractDeployDisabledReason = !localSessionActive
    ? 'Sign in with your passkey to open Passport before setting your account up.'
    : selectedNetwork !== walletPresentedNetwork
      ? `This Passport works on ${signingNetworkLabel}, so its account can only be set up there.`
      : walletStillSyncing
        ? 'Passport is still catching up. Setting up again opens once it has.'
        : null;
  /**
   * The card. Present only when a passkey wallet session is genuinely open and
   * the network being shown is the one it signs on — omitted rather than
   * disabled otherwise, on the same principle as the Send seam.
   *
   * Compared against the wallet's PUBLIC PRESENTATION, not its raw network id,
   * exactly as the alias-claim gate above is (`selectedNetwork !==
   * configuredWalletNetwork`). On a localnet build the raw id is `undeployed`
   * while the switcher can only ever show one of the three public networks, so
   * the raw comparison was false on every render and the card never appeared
   * on the very builds the contract flow is demonstrated on.
   */
  const homePassportContract =
    localSessionActive && localWalletNetworkId && selectedNetwork === walletPresentedNetwork
      ? {
          record: activeContractRecord,
          /* The ONLY action the card offers, and only where there is a real
             decision to make: a previous AUTOMATIC deploy failed, and the user
             may want to run it again. Every other state is status. */
          onRetry:
            activeContractRecord?.status === 'failed'
              ? () => void deployPassportContractOnChain()
              : undefined,
          /* Busy covers a claim as well as a deploy. A claim deploys this very
             contract on its way to binding the name, but raises `contractBusy`
             only around that one step — leaving the retry live through the
             availability probe, the passkey ceremony, and the registration. The
             shared in-flight gate makes a second deploy impossible either way;
             this is so the card does not offer an action that would quietly do
             nothing.

             Narrowed to the case where the claim really will deploy: with a
             contract already deployed a claim reuses it, and the pill would
             otherwise read "Deploying…" over a contract that is simply there. */
          busy:
            contractBusy ||
            (claimPhase !== null && activeContractRecord?.status !== 'deployed') ||
            /* Looking for an account read off the passkey. There is no record
               to show yet and the card would otherwise render nothing at all,
               which is the same screen as "you have no account" — and the
               person does have one. */
            accountSearch?.phase === 'checking',
          phase: accountSearch?.phase === 'checking' ? 'confirming' : contractPhase,
          disabledReason:
            activeContractRecord?.status === 'failed' ? contractDeployDisabledReason : null,
        }
      : null;
  /**
   * Queue from the claim screen. Queuing IS a resolution of the name step —
   * the name is chosen, it just is not on chain yet — so it lands on the
   * dashboard, where the queued card carries the "Register now" action.
   */
  const queueFromClaimScreen = async (alias: string, reason: string) => {
    /* A queued name stays queued, whatever the reason. There is no grant to
       the wallet to fetch first and no wallet-funded registration to fall back
       to: the sponsor registers names from its own funds, and when it cannot,
       the name waits (ruled 2026/08/25). */
    queueAlias(alias, selectedNetwork, reason);
    if (profile) storeNameStep(profile.passkey.credentialId, 'done');
    setIdentityStep(null);
  };

  /**
   * Leaves the name step for Home. ONE handler, two offers.
   *
   * The claim screen's host escape hatch (a network Passport cannot register
   * on) and its failure card's "Continue to Home" do exactly the same thing —
   * the step is settled, the failure is dropped, and the dashboard comes up —
   * so they are the same function rather than two copies that can drift. The
   * name is not lost either way: a claim that failed persisted it as queued,
   * and Home's card carries "Register now" for it.
   *
   * The resolution is remembered per credential, so a reload — or the next
   * sign-in — never asks again; Home keeps the "Claim a name" entry point.
   */
  const leaveNameStepForHome = () => {
    setAliasFailure(null);
    if (profile) storeNameStep(profile.passkey.credentialId, 'skipped');
    setIdentityStep(null);
  };

  const appsProfile = sessionActive
    ? {
        displayName: sessionDisplayName,
        // The network travels with the address: a localnet deployment must not
        // be shared with a dApp as though it lived on preview.
        passportContract: consentPassportContract,
        midnightAddresses: {
          unshielded: activeSurfaces?.unshieldedAddress ?? null,
          shielded: activeSurfaces?.shieldedAddress ?? null,
          dust: activeSurfaces?.dustAddress ?? null,
        },
      }
    : null;

  const overlays = (
    <>
      <PassportProfileConsent
        sessionActive={sessionActive}
        displayName={sessionActive ? sessionDisplayName : null}
        passportContract={consentPassportContract}
        midnightAddresses={
          activeSurfaces?.unshieldedAddress
            ? {
                unshielded: activeSurfaces.unshieldedAddress,
                ...(activeSurfaces.shieldedAddress ? { shielded: activeSurfaces.shieldedAddress } : {}),
                ...(activeSurfaces.dustAddress ? { dust: activeSurfaces.dustAddress } : {}),
              }
            : null
        }
      />
      {/* The redirect half of the profile bridge, and the deliberate sibling of
          the popup consent above: armed only by a launch carrying
          ?passportCallback, and rendering nothing on every other launch. It
          answers by NAVIGATING rather than by posting, because the tab that
          sent the user here may no longer exist — which is the whole reason
          the contract in identity/callbackProtocol.ts exists. The signing seam
          is a getter, not a value: the wallet lives in a ref and may open
          after this component first renders. */}
      <PassportCallbackConsent
        launch={passportCallbackLaunch}
        sessionActive={sessionActive}
        displayName={sessionActive ? sessionDisplayName : null}
        passportContract={consentPassportContract}
        midnightAddresses={
          activeSurfaces?.unshieldedAddress
            ? {
                unshielded: activeSurfaces.unshieldedAddress,
                ...(activeSurfaces.shieldedAddress ? { shielded: activeSurfaces.shieldedAddress } : {}),
                ...(activeSurfaces.dustAddress ? { dust: activeSurfaces.dustAddress } : {}),
              }
            : null
        }
        getSigningKeystore={() => localWalletRef.current?.keys.unshieldedKeystore ?? null}
      />
      {/* The popup half of the transaction bridge, and the deliberate sibling
          of the profile consent above: armed only by a launch carrying
          ?passportTxRequestId and ?passportTxNonce, and rendering nothing on
          every other launch. It is handed exactly what the in-app browser is
          handed — the same send seam (which runs the passkey ceremony), the
          same session flags, and the same wallet context — so a standalone
          app and a framed one are answered by the same rules. */}
      <PassportTxConsent
        sessionActive={sessionActive}
        executeTransfer={appTransferSeam}
        transferContext={appTransferContext}
      />
    </>
  );

  return (
    <div className="passport-experience is-mobile">
      {showOnboarding ? (
        <OnboardingScreen
          stage={onboardingStage}
          busyLabel={onboardingLabel}
          error={onboardingError}
          hasExistingPassport={localPassportKnown}
          onContinue={() => startPasskeyOnboarding('auto')}
          onUseDifferentPasskey={() => void runDiscoverableSignIn()}
          onDismissError={() => setOnboardingError(null)}
          /* The two dead ends that now have a way out, and it is the SAME way
             out: `onCreateNewPasskey` enrols DELIBERATELY. It is deliberately
             not `onUseDifferentPasskey`, which only ever asserts and was the
             false remedy both of these replace — advice to run a discovery for
             a user who has just watched a discovery find nothing. */
          unusableCredential={unusableCredential}
          keylessPasskey={keylessPasskey}
          onCreateNewPasskey={() => startPasskeyOnboarding('enrol-new')}
        />
      ) : accountSearch?.phase === 'not-found' ? (
        /* THE END OF THE SEARCH, and the reason it has one. A passkey named an
           account, the chain never answered for it, and what used to happen at
           this point was nothing: no record, no name, and the name step in
           front of somebody who already had a name. Two controls, and neither
           of them sets anything up on its own. See `AccountRecovery.tsx`. */
        <AccountRecoveryScreen
          name={accountSearch.alias ? `${accountSearch.alias}.night` : null}
          onTryAgain={() =>
            setAccountSearch((current) =>
              current ? { ...current, attempt: 0, phase: 'checking' } : current,
            )
          }
          onStartOver={() => void startNewAccountAfterSearch()}
        />
      ) : identityStep === 'welcome' ? (
        /* What Passport IS, said once to a Passport that has just been made
           (2026/08/26). ONE control, since 2026/08/30: it used to carry a
           "Skip" beside it that landed on the very same mandatory name step,
           which is a promise of an escape route that does not exist. See
           `WelcomeScreen` for the whole reasoning. */
        <WelcomeScreen
          onChooseName={() => {
            if (profile) storeWelcomeSeen(profile.passkey.credentialId);
            setIdentityStep('alias');
          }}
        />
      ) : identityStep === 'alias' ? (
        /* The name step — the last thing between a new Passport and its
           dashboard (2026/08/06). Everything on the screen is real registry
           state; claiming or skipping both land on Home. */
        <AliasClaimScreen
          networkId={selectedNetwork}
          walletReady={localSessionActive}
          registrationSupported={selectedNetwork === localWalletNetworkId && aliasClaimSupported}
          signingNetworkLabel={signingNetworkLabel}
          nameSponsored={nameSponsored}
          checkAvailability={checkAliasOnActiveNetwork}
          onClaim={(alias) => claimOrQueueAlias(alias, selectedNetwork)}
          onQueue={queueFromClaimScreen}
          onSkip={leaveNameStepForHome}
          /* The failure card's second control. It runs the same handler as the
             skip above because the two land in the same place, but it is a
             different OFFER and the screen says so: a claim that failed has
             already saved its name as queued (see `claimOrQueueAlias`), so
             Home is where that name is waiting with "Register now" on it. */
          onContinueHome={leaveNameStepForHome}
          claimPhase={claimPhase}
          error={aliasFailure?.message ?? null}
          /* The name step has no sign-out in its header, so when a passkey
             ceremony refuses here the failure card is the ONLY place a way out
             can be. See `midSessionCeremonyFailure`. */
          errorIsPasskeyWayOut={aliasFailure?.wayOut === true}
          onSignOut={() => void signOutPassport()}
        />
      ) : identityStep === 'backup' ? (
        /* Off the onboarding chain since 2026/08/06 — reached on demand from
           Home. Since 2026/08/19 it also exports and restores the private
           state as one password-encrypted file; see
           `./identity/backup.ts` for what that file holds and what it
           deliberately cannot. */
        <BackupScreen
          onExport={exportPassportState}
          onRestore={restorePassportState}
          onDone={() => setIdentityStep(null)}
        />
      ) : identityStep === 'ecosystem' ? (
        /* Entry to the ecosystem: the name, its real transactions, and
           everything redeemed so far. */
        <EcosystemScreen
          network={selectedNetwork}
          record={activeAliasRecord}
          incentives={incentives}
          variant="screen"
          onContinue={() => setIdentityStep(null)}
          onClaimName={() => {
            setAliasFailure(null);
            setIdentityStep('alias');
          }}
          {...registerNowProps}
        />
      ) : (
        <>
          {mobileTab === 'home' ? (
            <HomeScreen
              displayName={homeDisplayName}
              aliasLabel={aliasLabel}
              identity={homeIdentity}
              passportContract={homePassportContract}
              network={selectedNetwork}
              onSelectNetwork={handleSelectNetwork}
              syncPercent={localSyncPercent}
              /* The account's ledger, not the wallet's — see `homeAccount`.
                 The engine's own balances, its fee charge, and its three
                 technical addresses are no longer on this screen at all, and
                 the props that used to carry an address here went with them:
                 Receive offers the ACCOUNT address, which Home derives for
                 itself. */
              account={homeAccount}
              legacyFunds={homeLegacyFunds}
              /* Payments that left this Passport and have not arrived. See
                 `runNameSend` for why a two-leg send is written down. */
              pendingSends={homePendingSends}
              error={error}
              onDismissError={() => setError(null)}
              onRefresh={refreshMobile}
              /* The Send seam. `null` when no wallet session is open or this
                 Passport has no account contract, which is what makes Home
                 render no Send control at all. */
              send={homeSend}
              /* Everything Passport has recorded for this credential, under
                 the apps grid. An empty array is a real answer and gets the
                 section's one quiet line. */
              activity={homeActivity}
              appsProfile={appsProfile}
              onProfileShared={handleProfileShared}
              executeTransfer={appTransferSeam}
                    transferContext={appTransferContext}
              onIncentiveRedeemed={handleIncentiveRedeemed}
              supportUrl={(import.meta.env.VITE_TELEGRAM_URL as string | undefined) ?? null}
              /* The only route to the Backup screen. It is offered whenever a
                 Passport exists here, because restoring is exactly what a
                 browser with no records needs. */
              onOpenBackup={profile ? () => setIdentityStep('backup') : undefined}
              onSignOut={() => void signOutPassport()}
            />
          ) : mobileTab === 'assets' ? (
            /* The Assets shelf. Fed from the SAME `homeAccount` Home's balance
               strip reads, so the two screens cannot disagree about what this
               Passport holds — and `null` there means no account yet, which
               the screen says in one line rather than filling with zeros. */
            <AssetsScreen
              account={homeAccount}
              network={selectedNetwork}
              onSelectNetwork={handleSelectNetwork}
              onRefresh={refreshMobile}
              /* The same trail Home reads, so this shelf can say what is on
                 its way but has not landed. */
              activity={homeActivity}
            />
          ) : (
            <AppsScreen
              profile={appsProfile}
              onProfileShared={handleProfileShared}
              network={selectedNetwork}
              onSelectNetwork={handleSelectNetwork}
              executeTransfer={appTransferSeam}
                    transferContext={appTransferContext}
              onIncentiveRedeemed={handleIncentiveRedeemed}
            />
          )}
          <PassportNav active={mobileTab} onSelect={setMobileTab} />
        </>
      )}
      {reclaim ? (
        <AliasReclaimModal
          targetNetwork={reclaim.target}
          currentAlias={reclaim.alias}
          checkAvailability={checkAliasOnReclaimTarget}
          onPick={handleReclaimPick}
          onKeepCurrent={() => {
            setReclaim(null);
            setReclaimError(null);
          }}
          busy={reclaimBusy}
          error={reclaimError}
        />
      ) : null}
      {overlays}
      <PassportToasts />
    </div>
  );
}
