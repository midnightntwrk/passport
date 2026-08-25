import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Copy,
  X,
} from 'lucide-react';
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportEnrolmentConflictError,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from './backend.js';
import type { DiscoveredPassportPasskey, PassportAccountBlob } from './backend.js';

import { compactAddress } from './lib/address.js';
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
import HomeScreen from './screens/Home.js';
import AliasClaimScreen from './screens/AliasClaim.js';
import BackupScreen from './screens/Backup.js';
import EcosystemScreen from './screens/Ecosystem.js';
import AliasReclaimModal from './screens/AliasReclaimModal.js';
import {
  loadAliasRecords,
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
} from './identity/passportContract.js';
/* The account-custody contract's own progress vocabulary. Type-only, so the
   module — and the ledger it statically imports — stays behind the dynamic
   imports every call site below uses. */
import type { AccountCustodyProgress } from './identity/accountCustody.js';
import type { PassportBackupLedgerCheck } from './identity/backup.js';
import {
  NETWORK_LABELS,
  loadStoredNetwork,
  storeNetwork,
  type PassportNetwork,
} from './screens/NetworkSwitcher.js';
import AppsScreen from './screens/Apps.js';
import PassportNav, { type MobileTab } from './screens/Nav.js';
import PassportToasts, { pushToast } from './screens/ToastStack.js';
import { fetchRecentTransactions, type RecentTransaction } from './lib/indexerTx.js';
// In-app notifications only — a closed Passport notifies nobody. The module's
// header says exactly what background Web Push would additionally need.
import { notify } from './lib/notifications.js';
import { PasskeyPresenceError, confirmPresence } from './lib/passkeyPresence.js';
import {
  CLAIMABLE_NETWORKS,
  aliasRegistrationSupported,
  configuredNetworkId,
  defaultSelectedNetwork,
  explorerTxUrl,
  isLedgerTxHash,
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
type TransactionsStatus = 'loading' | 'ready' | 'empty' | 'unavailable';

interface ActivityEntry {
  id: string;
  label: string;
  detail: string;
  status: ActivityStatus;
  source?: ActivitySource;
  txHash?: string;
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
 * The indexer this build reads history from. `fetchRecentTransactions` derives
 * its own WebSocket URL from it, and it must be the same network the wallet is
 * configured for — see `lib/networks.ts`.
 */
const MIDNIGHT_INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
/**
 * Optional activation funder (`VITE_FUNDER_URL`, see
 * `examples/passport-funder`). When set, Passport asks this self-hosted
 * service to drip an activation-sized NIGHT grant to a brand-new wallet, so
 * the first `.night` claim executes immediately instead of queueing until the
 * user has visited the captcha faucet. Unset, the queue behaviour is exactly
 * what it always was.
 */
const FUNDER_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_FUNDER_URL?.trim().replace(/\/+$/, '') ||
  null;
/** Ceiling on the wait for a funder grant to show up in the balance stream. */
const FUNDER_WAIT_CEILING_MS = 45_000;
/**
 * Ceiling on the `/fund-account` round-trip.
 *
 * The sponsor proves and submits a `deposit_night` — and, where it holds one,
 * a shielded stablecoin deposit as well — before it answers, so this is a
 * chain-work wait rather than an HTTP one. It is deliberately generous and
 * deliberately never blocking: the caller fires this and moves on.
 */
const FUND_ACCOUNT_TIMEOUT_MS = 600_000;
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

/**
 * A token colour as both the ledger and {@link colourHexToBytes} quote it — 64
 * lowercase hex characters — or `null` for anything that is not one.
 *
 * Strict on purpose, and for the module's own reason: a short value is a
 * misconfiguration rather than an abbreviation, and padding it would make
 * Passport show one colour's balance under another colour's name.
 */
function normalisedColourHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
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

/** A colour, shortened for a label. It identifies nothing to a reader whole. */
function shortColour(colourHex: string): string {
  return colourHex.length <= 18 ? colourHex : `${colourHex.slice(0, 10)}…${colourHex.slice(-6)}`;
}

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
/** Appended to the queue reason when activation was attempted and failed. */
const FUNDER_UNAVAILABLE_SENTENCE =
  'Automatic activation was unavailable just now, so the wallet still needs funding.';
/**
 * The queue reason when the sponsor cannot register a name right now. Never
 * followed by a wallet-funded attempt: the wallet does not pay for names.
 */
const SPONSOR_UNAVAILABLE_SENTENCE =
  'The Passport service that registers names is not available right now. Your name is kept for you and can be registered when it is back.';

/**
 * Whether the funder is sponsoring `.night` registrations on `network` right
 * now — its own `/status` answer, cached briefly, `false` on any doubt. When
 * this is true the activation drip is NOT the path to a name: the funder
 * registers the name itself (see `identity/sponsoredAlias.ts`) and the user's
 * NIGHT balance is simply not part of the claim, so the callers below skip
 * the shortfall-and-drip dance rather than sending a grant nobody will spend.
 */
async function aliasSponsorshipLikely(network: string | null | undefined): Promise<boolean> {
  if (!FUNDER_URL || !aliasRegistrationSupported(network)) return false;
  const { checkAliasSponsorship } = await import('./identity/sponsoredAlias.js');
  return checkAliasSponsorship(FUNDER_URL, network as MidnamesNetwork);
}

/**
 * Parses a formatted (6-decimal) NIGHT figure back to atomic units, exactly.
 * Mirrors `atomicNightFrom` in `screens/AliasClaim.tsx`.
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
 */
type IdentityStep = 'alias' | 'backup' | 'ecosystem' | null;

/**
 * How long a WebAuthn ceremony may sit unanswered before Passport stops
 * waiting for it.
 *
 * Nothing in WebAuthn guarantees `credentials.create`/`get` ever settles. A
 * browser wallet extension that claims the passkey UI can leave the promise
 * pending forever — Lace was observed doing exactly this on 2026/08/06, where
 * the passkey window simply never appeared — and the user sees a spinner with
 * no end. Better an honest error with a retry than an infinite wait.
 */
const PASSKEY_CEREMONY_TIMEOUT_MS = 25_000;

const PASSKEY_TIMEOUT_MESSAGE =
  'Your device never showed the passkey prompt. A wallet browser extension — Lace, for example — can intercept it. Try disabling the extension, or open Passport in a private window, then try again.';

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
    timer = window.setTimeout(
      () => reject(new Error(PASSKEY_TIMEOUT_MESSAGE)),
      PASSKEY_CEREMONY_TIMEOUT_MS,
    );
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
 * The explorer link a success toast carries — or `undefined`.
 *
 * Preview and pre-production each have a public explorer; mainnet is not in
 * the table. The link takes the 32-byte ledger transaction hash — never the
 * identifier `submitTransaction` answers with. No hash, or a network with no
 * explorer, means no link rather than one that goes nowhere.
 */
function explorerTxLink(
  txHash: string | null | undefined,
  network: string | null | undefined,
): { label: string; href: string } | undefined {
  const href = explorerTxUrl(network, txHash);
  return href ? { label: 'View on explorer', href } : undefined;
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

function activitySource(entry: ActivityEntry): ActivitySource {
  return entry.source ?? (entry.txHash ? 'chain' : 'local');
}

function sourceLabel(source: ActivitySource): string {
  if (source === 'chain') return 'On-chain';
  if (source === 'wallet') return 'Wallet';
  return 'Local';
}

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Some embedded browsers deny the Clipboard API despite a direct user gesture.
  }

  const fallback = document.createElement('textarea');
  fallback.value = value;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('Your browser did not allow this address to be copied.');
}

function ActivityPill({ status }: { status: ActivityStatus }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return <button className="icon-button" onClick={onClick} disabled={disabled} aria-label={label} title={label}>{children}</button>;
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
  const [selectedTx, setSelectedTx] = useState<ActivityEntry | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('home');
  // One-button onboarding (2026/08/05): there is no separate "choose" step
  // any more, so the screen only distinguishes idle from working.
  const [onboardingIntent, setOnboardingIntent] = useState<OnboardingIntent | null>(null);
  const [onboardingBusyLabel, setOnboardingBusyLabel] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<RecentTransaction[]>([]);
  const [transactionsStatus, setTransactionsStatus] = useState<TransactionsStatus>('loading');
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
  const [claimPhase, setClaimPhase] = useState<AliasClaimProgress['phase'] | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  /**
   * Whether the fee sponsor has really told us it can pay this registration's
   * DUST fee — `available > 0` on its own `/wallet-status`, never an
   * assumption. It starts false and only a live probe may raise it, so the
   * claim screen's baseline copy ("its fee in DUST from this wallet too")
   * stands unless the service itself contradicts it.
   *
   * Until 2026/08/06 the claim path consulted the sponsor but the screen never
   * did, so this sentence could not have told the truth on an environment
   * where the fee genuinely was covered. It is wired up now. On preview, where
   * the sponsor is unset (and where the service reports `available: 0` even
   * when it is set), the probe leaves this false and the baseline copy stands.
   */
  const [feesSponsored, setFeesSponsored] = useState(false);
  /** True while a queued name's "Register now" re-run is in flight. */
  const [registerNowBusy, setRegisterNowBusy] = useState(false);
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
   */
  const contractDeploysInFlight = useRef(new Map<string, Promise<PassportContractDeployment>>());
  /**
   * How the deployment fee would be paid, in the send sheet's own words. Read
   * from the wallet's advisory `feeReadiness()` probe — never assumed, and
   * cleared to null when the wallet could not tell us.
   */
  const [contractFeeNote, setContractFeeNote] = useState<string | null>(null);
  /** The pending per-network reclaim conflict, when the target says "taken". */
  const [reclaim, setReclaim] = useState<{ target: PassportNetwork; alias: string } | null>(null);
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [reclaimError, setReclaimError] = useState<string | null>(null);
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
  const transactionsRequest = useRef(0);
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

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const addActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'createdAt'>) => {
    const value = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setActivity((current) => [value, ...current].slice(0, 10));
    return value;
  }, []);

  const updateActivity = useCallback((id: string, patch: Partial<Omit<ActivityEntry, 'id' | 'createdAt'>>) => {
    setActivity((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

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
   * The one surfaces object every shared consumer reads — Home, the address
   * picker, the Apps profile, the dApp consent bridge, and the recent
   * transaction lookup. There is one wallet behind it now, so this is an alias
   * rather than a choice; the loading / ready / partial / unavailable
   * semantics — including the distinction between a real `'0'` and an unknown
   * `null` — are the local wallet's own.
   */
  const activeSurfaces: LocalWalletSurfaces | null = localSurfaces;

  const unshieldedAddress = activeSurfaces?.unshieldedAddress ?? null;

  const refreshTransactions = useCallback(async () => {
    if (!unshieldedAddress) {
      setTransactions([]);
      setTransactionsStatus('loading');
      return;
    }
    const token = transactionsRequest.current + 1;
    transactionsRequest.current = token;
    setTransactionsStatus('loading');
    try {
      const result = await fetchRecentTransactions(MIDNIGHT_INDEXER_URL, { unshieldedAddress });
      if (token !== transactionsRequest.current) return;
      if (result.scope !== 'address') {
        // A chain-scoped result is a sample of everybody's recent blocks, not
        // this account's history: its rows may belong to anyone, and an empty
        // walk proves nothing. The per-address view is simply unavailable.
        setTransactions([]);
        setTransactionsStatus('unavailable');
        return;
      }
      setTransactions(result.rows);
      setTransactionsStatus(result.rows.length > 0 ? 'ready' : 'empty');
    } catch {
      // fetchRecentTransactions only ever throws IndexerUnavailableError.
      if (token !== transactionsRequest.current) return;
      setTransactions([]);
      setTransactionsStatus('unavailable');
    }
  }, [unshieldedAddress]);

  useEffect(() => {
    if (!unshieldedAddress) return;
    void refreshTransactions();
  }, [refreshTransactions, unshieldedAddress]);

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
   * pays the fee and what a legacy balance may still be sitting in, and the
   * account is what the user is shown. The account read is not awaited — it is
   * an indexer round-trip, and nothing that calls this is waiting on a figure.
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
        setOnboardingBusyLabel('Opening your Midnight wallet');
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
   * Records what the platform proved about largeBlob on this credential, in
   * BOTH places that read it: the stored profile, so the next session knows,
   * and this session's state, so a second claim in the same session does not
   * re-ask a question already answered. A storage failure is a non-event —
   * the worst it costs is one more prompt next time.
   */
  const rememberLargeBlobSupport = useCallback(
    async (activeProfile: DemoPassportProfile, supported: boolean): Promise<void> => {
      const updated: DemoPassportProfile = { ...activeProfile, largeBlobSupported: supported };
      setProfile((current) =>
        current && current.subjectId === activeProfile.subjectId ? updated : current,
      );
      await saveDemoProfile(updated).catch(() => {});
    },
    [],
  );

  /**
   * Writes this Passport's account-custody contract onto the passkey itself,
   * so a device that has never seen this Passport can find it again.
   *
   * ALWAYS BEST EFFORT, NEVER BLOCKING. The claim it follows has already
   * succeeded on chain; nothing about it depends on this. So the whole thing
   * is fire-and-forget: `writeAccountBlob` does not throw, whatever the
   * platform does, and the outcome is recorded in the activity feed in the
   * platform's own words rather than surfaced as a failure the user cannot act
   * on.
   *
   * WHY IT IS A SEPARATE CEREMONY. The WebAuthn specification allows a
   * largeBlob write only during an assertion, and forbids pairing it with a
   * read in the same one. The claim's own assertion happened before the
   * contract existed and minutes of chain work ago, so there is no live user
   * gesture left to ride on: this is a second prompt or it is nothing.
   *
   * WHICH IS WHY IT IS NOT ALWAYS ATTEMPTED. On a credential the platform said
   * cannot hold a blob, the write is skipped entirely — it would cost a real
   * prompt and achieve nothing. The first attempt that reports the extension
   * missing writes that fact back to the profile, so nobody is asked twice for
   * nothing.
   */
  const rememberAccountOnPasskey = useCallback(
    async (
      activeProfile: DemoPassportProfile,
      account: { address: string; network: string },
      alias?: string,
    ): Promise<void> => {
      if (activeProfile.largeBlobSupported === false) return;
      const result = await WebAuthnPrfKeyProvider.writeAccountBlob(activeProfile.passkey, {
        v: 1,
        acc: { address: account.address, network: account.network },
        ...(alias ? { alias } : {}),
      });
      if (result.written) {
        addActivity({
          label: 'Passport attached to your passkey',
          detail: `Your account contract ${compactAddress(account.address)} on ${account.network} is now stored on the passkey itself, so a new device can find it. No key material is in it — the address is public.`,
          status: 'complete',
          source: 'local',
        });
        if (activeProfile.largeBlobSupported !== true) {
          await rememberLargeBlobSupport(activeProfile, true);
        }
        return;
      }
      addActivity({
        label: 'Passport not attached to your passkey',
        detail: `${result.reason ?? 'The write did not happen.'} Nothing else is affected: your name and contract are on chain either way.`,
        status: 'blocked',
        source: 'local',
      });
      /* A platform without the extension is a permanent answer for this
         credential; a refusal or a cancellation is not, and must stay
         retryable. */
      if (result.reason?.includes('does not implement')) {
        await rememberLargeBlobSupport(activeProfile, false);
      }
    },
    [addActivity, rememberLargeBlobSupport],
  );

  /**
   * Sign-in recovery: turn a blob read off the passkey into a contract record,
   * but ONLY once the chain has answered for the address.
   *
   * The three conditions, all required:
   *
   *   1. the assertion actually returned a blob (`null` on every platform
   *      without largeBlob, which is most of them — and not an error);
   *   2. this browser holds NO record for that credential and network. A
   *      device that already knows its own contract is not recovering
   *      anything, and a blob must never overwrite a locally observed record;
   *   3. the indexer answers for the address. Until it does, all we have is a
   *      claim by a file; `confirmPassportContractOnLedger` is what turns it
   *      into a fact. If it does not confirm, NOTHING is written and nothing
   *      is said — the user is simply where they were.
   *
   * The record it writes carries `recovered: true` precisely so no surface
   * ever shows a deployment transaction this device never saw.
   */
  const recoverAccountFromPasskey = useCallback(
    async (credentialId: string, blob: PassportAccountBlob | null): Promise<void> => {
      if (!blob) return;
      const handle = localWalletRef.current;
      // The read-back has to happen against the network the blob names, and
      // the only indexer this session holds is the open wallet's.
      if (!handle || handle.network.networkId !== blob.acc.network) return;
      if (loadPassportContractRecord(credentialId, blob.acc.network)) return;
      const { confirmPassportContractOnLedger } = await import('./identity/passportContract.js');
      const confirmed = await confirmPassportContractOnLedger(
        handle.network.indexerHttpUrl,
        blob.acc.address,
      );
      if (!confirmed) {
        addActivity({
          label: 'Passport contract not recovered',
          detail: `Your passkey names a contract on ${blob.acc.network}, but the indexer does not answer for ${compactAddress(blob.acc.address)}, so nothing was restored.`,
          status: 'blocked',
          source: 'chain',
        });
        return;
      }
      savePassportContractRecord({
        credentialId,
        network: blob.acc.network,
        status: 'deployed',
        address: blob.acc.address,
        recovered: true,
        ledgerConfirmed: true,
        updatedAt: new Date().toISOString(),
      });
      addActivity({
        label: 'Passport contract recovered',
        detail: `${compactAddress(blob.acc.address)} was read from your passkey and confirmed on ${blob.acc.network} by the indexer. This device never saw its deployment, so no transaction is shown for it.`,
        status: 'complete',
        source: 'chain',
      });
      pushToast({
        tone: 'success',
        title: 'Your Passport contract is back',
        body: 'Read from your passkey and confirmed on chain.',
      });
    },
    [addActivity],
  );

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
      await openLocalWalletWithSeed(seed, scope, known.passkey.credentialId);
      await recoverAccountFromPasskey(known.passkey.credentialId, discovered.accountBlob);
      addActivity({
        label: 'Passport passkey unlocked',
        detail: 'Signed in with a passkey chosen from the device picker.',
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
    await openLocalWalletWithSeed(seed, scope, discovered.credentialId);
    /* The fresh-device case this whole mechanism exists for: a passkey
       synced here from another device, no local records at all, and its
       blob naming the contract to look for. */
    await recoverAccountFromPasskey(discovered.credentialId, discovered.accountBlob);
    addActivity({
      label: 'Passport bound to passkey',
      detail:
        'A chosen passkey with no Passport here now holds its own profile and on-device wallet.',
      status: 'complete',
      source: 'local',
    });
    pushToast({
      tone: 'success',
      title: 'Passport created',
      body: 'This passkey now holds its own Midnight wallet.',
    });
    storeLastPasskey(discovered.credentialId);
    return nextProfile;
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
   * ASK THE AUTHENTICATOR BEFORE CREATING ANYTHING. "No local profile" is not
   * the same fact as "no passkey". Site data cleared with the passkey still in
   * the keychain looks identical to a first visit, and a `create` there would
   * REPLACE the surviving credential — the user handle is deterministic — and
   * take its PRF secret, and so every coin its wallet seed derives, with it.
   * So this discovers first and only enrols when nothing answers. `created`
   * says which of the two actually happened, so nothing downstream claims a
   * Passport was made when one was merely reopened.
   */
  const createLocalPassportProfile = async (): Promise<{
    profile: DemoPassportProfile;
    created: boolean;
  }> => {
    const existing = await resolveDefaultLocalProfile();
    if (existing) {
      setLocalPassportKnown(true);
      throw new Error(
        'This browser already holds a Passport passkey. Choose Sign in to reopen its wallet.',
      );
    }
    setOnboardingBusyLabel('Checking this device for a Passport passkey');
    /* Every credential this browser still knows about goes into the exclusion
       list. It is empty on a genuinely first visit, and that is precisely the
       case discovery above covers instead. */
    const knownCredentialIds = (await listLocalProfiles().catch(() => []))
      .map((candidate) => candidate.passkey.credentialId)
      .filter((credentialId): credentialId is string => Boolean(credentialId));
    let onboarding: import('./backend.js').PassportPasskeyOnboarding;
    try {
      onboarding = await withPasskeyWatchdog(() =>
        WebAuthnPrfKeyProvider.discoverOrEnroll({
          label: 'Midnight Passport',
          userId: LOCAL_ACCOUNT_ID,
          knownCredentialIds,
        }),
      );
    } catch (cause) {
      if (!(cause instanceof PassportEnrolmentConflictError)) throw cause;
      /* The authenticator refused to overwrite a passkey it still holds. That
         is the guard working, not a failure: the Passport is intact and the
         only honest move is to sign the user into it. */
      setOnboardingIntent('local-signin');
      setOnboardingBusyLabel('You already have a Passport on this device — signing you into it');
      let recovered: DiscoveredPassportPasskey;
      try {
        recovered = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.discover());
      } catch {
        throw new Error(
          'You already have a Passport on this device. Choose "Use a different passkey" to sign in to it.',
        );
      }
      try {
        return { profile: await adoptDiscoveredPasskey(recovered), created: false };
      } finally {
        recovered.dispose();
      }
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
    const enrolled = onboarding.enrolled;
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
      return { profile: nextProfile, created: true };
    } finally {
      handle?.dispose();
    }
  };

  /**
   * Sign-in — exactly ONE assertion.
   *
   * Decrypting the stored state proves the passkey is the right one (and fails
   * loudly if the record belongs to another device); the wallet seed comes
   * from the very same assertion instead of a second prompt.
   */
  const unlockLocalPassportProfile = async (): Promise<DemoPassportProfile> => {
    const existing = await resolveDefaultLocalProfile();
    if (!existing) {
      setLocalPassportKnown(false);
      throw new Error(
        'No Passport passkey is enrolled in this browser yet. Choose Create passkey to make one.',
      );
    }
    setOnboardingBusyLabel('Unlocking your Passport with this device');
    const unlockScope = localScopeFor(existing);
    const handle = await withPasskeyWatchdog(() =>
      WebAuthnPrfKeyProvider.assertOnce(existing.passkey),
    );
    try {
      await loadPassportState(existing, unlockScope, oneShotVaultFor(handle));
      setProfile(existing);
      setLocalPassportKnown(true);
      const seed = await handle.deriveWalletSeed(unlockScope);
      await openLocalWalletWithSeed(seed, unlockScope, existing.passkey.credentialId);
      /* The blob rode in on the assertion above, so this costs no prompt. It
         does nothing at all unless this browser has no record of the contract
         AND the indexer confirms the address. */
      await recoverAccountFromPasskey(existing.passkey.credentialId, handle.accountBlob);
      return existing;
    } finally {
      handle.dispose();
    }
  };

  const runLocalOnboarding = async (requested: 'create' | 'signin' | 'auto') => {
    if (onboardingRunning.current) return;
    onboardingRunning.current = true;
    // A user-initiated ceremony wins over the silent §2.2 restore: two flows
    // must never race to replace `localWalletRef`.
    cancelSessionRestore();
    setOnboardingError(null);
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
      if (intent === 'create') {
        const outcome = await createLocalPassportProfile();
        activeProfile = outcome.profile;
        created = outcome.created;
      } else {
        activeProfile = await unlockLocalPassportProfile();
      }
      storeLastPasskey(activeProfile.passkey.credentialId);
      setOnboardingError(null);
      addActivity({
        label: created ? 'Passport passkey enrolled' : 'Passport passkey unlocked',
        detail: 'On-device Midnight wallet derived from this passkey.',
        status: 'complete',
        source: 'local',
      });
      if (created) {
        pushToast({
          tone: 'success',
          title: 'Passport created',
          body: 'Your passkey now holds a Midnight wallet.',
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalWalletStatus('error');
      setOnboardingError(message);
      addActivity({
        label: intent === 'create' && !created ? 'Passport passkey' : 'Passport unlock',
        detail: message,
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
    setError(null);
    setOnboardingIntent('local-signin');
    setOnboardingBusyLabel('Choose a passkey on this device');
    let discovered: import('./backend.js').DiscoveredPassportPasskey | null = null;
    let activeProfile: DemoPassportProfile | null = null;
    try {
      // Credential-key the legacy record first, so an existing single-profile
      // browser matches its own passkey below.
      await migrateLegacyLocalProfile().catch(() => null);
      discovered = await withPasskeyWatchdog(() => WebAuthnPrfKeyProvider.discover());
      activeProfile = await adoptDiscoveredPasskey(discovered);
      setOnboardingError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalWalletStatus('error');
      setOnboardingError(message);
      addActivity({ label: 'Passkey sign-in', detail: message, status: 'error', source: 'local' });
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
        pushToast({ tone: 'success', title: 'Wallet synced' });
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
      const amount = formatNightUnits(next - previous);
      addActivity({
        label: 'NIGHT received',
        /* It arrived at the address the resolver leaf carries, which is the
           wallet's — so it is NOT yet in the account, and the contract cannot
           see it until a `deposit_night` moves it. Home offers exactly that;
           saying so here is the difference between a balance a user can find
           and one they cannot. */
        detail: `${amount} NIGHT arrived at this Passport's receiving address. Move it into your account to spend it.`,
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
   * Probe the sponsor once the name step is actually on screen, so the fee
   * sentence there describes what will really happen. A failed or disabled
   * probe leaves `feesSponsored` false — the honest baseline — and is never
   * surfaced as an error, because unsponsored is a working state, not a fault.
   */
  useEffect(() => {
    if (identityStep !== 'alias') return undefined;
    let live = true;
    void (async () => {
      try {
        const { sponsorReadiness } = await import('./lib/sponsor.js');
        const readiness = await sponsorReadiness();
        if (live) setFeesSponsored(readiness.state === 'ready');
      } catch {
        if (live) setFeesSponsored(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [identityStep]);

  // The stores are the seam every writer shares: Contract R's connector calls
  // `saveIncentive` directly, and this subscription is what re-renders Home.
  useEffect(() => subscribeAliasRecords(setAliasRecords), []);
  useEffect(() => subscribeIncentives(setIncentives), []);
  useEffect(() => subscribePassportContractRecords(setContractRecords), []);

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
   * The contract card's fee sentence, read from the wallet's own advisory
   * `feeReadiness()` probe — the SAME probe the send sheet quotes, so the two
   * surfaces can never tell different stories about who pays.
   *
   * Deliberately the send sheet's wording, including its hedging: `sponsored`
   * earns "expected to be covered" because the probe is a prediction and a
   * sponsor can drain between this quote and the submit. A wallet that cannot
   * answer leaves the note null rather than guessing at a mode.
   */
  useEffect(() => {
    /* The same condition `localSessionActive` expresses, spelled out because
       that binding is derived further down the component than this effect. */
    if (localWalletStatus !== 'ready' || localSurfaces === null || contractBusy) return undefined;
    const handle = localWalletRef.current;
    if (!handle) return undefined;
    /* A deployed contract has no deploy action, so it has no fee sentence —
       and `feeReadiness()` probes the sponsor over the network. Asking who
       would pay for a deployment that already happened is a request nobody
       reads the answer to. */
    if (
      profile &&
      contractRecords[
        passportContractRecordKey(profile.passkey.credentialId, handle.network.networkId)
      ]?.status === 'deployed'
    ) {
      setContractFeeNote(null);
      return undefined;
    }
    let live = true;
    void (async () => {
      try {
        const readiness = await handle.feeReadiness();
        if (!live) return;
        setContractFeeNote(
          readiness.mode === 'sponsored'
            ? 'Network fee expected to be covered by the fee sponsor.'
            : readiness.mode === 'own-dust'
              ? `Network fee paid from your DUST (${readiness.dustBalance} DUST available).`
              : /* The wallet's own refusal sentence, verbatim. */ readiness.reason,
        );
      } catch {
        // "We could not tell" must not be printed as a fee mode.
        if (live) setContractFeeNote(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [contractBusy, contractRecords, localSurfaces, localWalletNetworkId, localWalletStatus, profile]);

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

  const checkAliasOnActiveNetwork = useCallback(
    (alias: string) => probeAlias(selectedNetwork, alias),
    [probeAlias, selectedNetwork],
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

  /* ---------------------------------------------------------------------- */
  /* Activation funding — VITE_FUNDER_URL only                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Wallet addresses this session has already asked the funder to activate.
   * One attempt per wallet per session, whatever the outcome — the funder's
   * own once-only ledger is the real gate; this ref just avoids asking twice.
   */
  const funderActivationAttempted = useRef(new Set<string>());
  /** The identity step, readable from async funder waits without a stale closure. */
  const identityStepRef = useRef<IdentityStep>(null);
  useEffect(() => {
    identityStepRef.current = identityStep;
  }, [identityStep]);

  /**
   * The registration cost of `alias` when the open wallet holds LESS than it,
   * or `null` when the wallet can already pay (or cannot be read — an unknown
   * balance must not trigger a drip request).
   */
  const claimNightShortfall = useCallback(async (alias: string): Promise<bigint | null> => {
    const handle = localWalletRef.current;
    if (!handle) return null;
    try {
      const { aliasCostAtomicNight } = await import('./identity/midnames.js');
      const cost = aliasCostAtomicNight(alias);
      const held = atomicNightFromFormatted((await handle.getBalances()).unshieldedBalance);
      if (held === null || held >= cost) return null;
      return cost;
    } catch {
      return null;
    }
  }, []);

  /**
   * Asks the funder to activate the open wallet, then waits for the grant on
   * the SAME live balance stream that feeds the Home surfaces — the wallet's
   * push-based `subscribeBalances`, never a `getBalances` poll — with a 45 s
   * ceiling. Resolves `true` only when the wallet really holds
   * `requiredAtomic`; every failure resolves `false` and the caller's queue
   * path stands unchanged.
   */
  const activateWalletViaFunder = useCallback(
    async (requiredAtomic: bigint): Promise<boolean> => {
      if (!FUNDER_URL) return false;
      const handle = localWalletRef.current;
      if (!handle) return false;
      const address = handle.unshieldedAddress;
      if (funderActivationAttempted.current.has(address)) return false;
      funderActivationAttempted.current.add(address);
      pushToast({
        tone: 'info',
        title: 'Activating this Passport',
        body: 'A small NIGHT grant is on its way.',
      });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          response = await fetch(`${FUNDER_URL}/activate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        // `already-funded` and `already-activated` both mean the NIGHT exists
        // on chain and only this wallet's own sync is behind, so the wait
        // below still applies. Every other refusal means no grant is coming.
        if (!response.ok && body.error !== 'already-funded' && body.error !== 'already-activated') {
          console.warn('[funder] activation refused:', body);
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          let unsubscribe: (() => void) | null = null;
          let settled = false;
          const finish = (outcome: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(ceiling);
            unsubscribe?.();
            resolve(outcome);
          };
          const ceiling = setTimeout(() => finish(false), FUNDER_WAIT_CEILING_MS);
          unsubscribe = handle.subscribeBalances(
            (balances) => {
              const held = atomicNightFromFormatted(balances.unshieldedBalance);
              if (held !== null && held >= requiredAtomic) finish(true);
            },
            { minIntervalMs: 1_000 },
          );
          // The listener fires synchronously with the current state, so the
          // wait may already be over by the time the unsubscriber exists.
          if (settled) unsubscribe();
        });
      } catch (cause) {
        console.warn('[funder] activation failed:', cause);
        return false;
      }
    },
    [],
  );

  /**
   * The one gate every contract deploy passes through.
   *
   * Starts `run` only when no deploy for this credential and network is already
   * running; when one is, the caller joins it and receives that deploy's
   * outcome instead of issuing a second one. `joined` says which happened, so
   * the caller can tell "I deployed this" from "somebody else did, and here it
   * is" — the two want different activity entries and only the first wants a
   * toast.
   *
   * The DEPLOYED record is written here rather than by the callers, because it
   * must be written exactly once no matter how many callers were waiting on the
   * deploy. Failure records stay with the callers: each has its own words for
   * what the failure meant to the flow it interrupted, and each writes one only
   * when it owned the run.
   */
  const deployPassportContractOnce = useCallback(
    (
      credentialId: string,
      network: string,
      run: () => Promise<PassportContractDeployment>,
    ): { outcome: Promise<PassportContractDeployment>; joined: boolean } => {
      const key = passportContractRecordKey(credentialId, network);
      const existing = contractDeploysInFlight.current.get(key);
      if (existing) return { outcome: existing, joined: true };

      const started = (async () => {
        const deployment = await run();
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
         un-deployable. */
      contractDeploysInFlight.current.set(key, started);
      const release = () => {
        if (contractDeploysInFlight.current.get(key) === started) {
          contractDeploysInFlight.current.delete(key);
        }
      };
      started.then(release, release);
      return { outcome: started, joined: false };
    },
    [],
  );

  /**
   * Asks the sponsor to put this Passport's opening balance INSIDE its account
   * contract — the activation grant, deposited where the account can spend it.
   *
   * This replaces the old wallet drip as the shape of activation. `/activate`
   * dripped NIGHT to the wallet ADDRESS, which under the account ruling is
   * money the Passport cannot see: the contract's `night_balances` mirror is
   * what a withdrawal is checked against, and NIGHT that reaches the wallet by
   * any other route is invisible to it. `/fund-account` proves a `deposit_night`
   * (and, where the sponsor holds one, a shielded stablecoin deposit) against
   * the contract itself.
   *
   * NEVER BLOCKING, and never fatal. The name is registered and the contract is
   * deployed by the time this runs; a sponsor that is out of funds, rate
   * limited, or simply absent leaves a Passport with a name and an empty
   * account, which is a state the surfaces already describe honestly. So it is
   * fired and forgotten, and it swallows nothing — every outcome is recorded in
   * the activity feed in the sponsor's own words.
   *
   * ONCE PER CONTRACT. `already-activated` and `already-funded` are the
   * sponsor's way of saying the grant exists, so they are recorded as done
   * rather than as failures, and the marker stops this browser asking again.
   */
  const fundAccountOnce = useCallback(
    async (contractAddress: string): Promise<void> => {
      if (!FUNDER_URL) return;
      if (accountFundingAttempted(contractAddress)) return;
      let response: Response;
      let body: {
        txHash?: unknown;
        amountAtomic?: unknown;
        assetTx?: unknown;
        assetAmount?: unknown;
        assetColourHex?: unknown;
        assetSymbol?: unknown;
        assetError?: unknown;
        error?: unknown;
        message?: unknown;
      };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FUND_ACCOUNT_TIMEOUT_MS);
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
        body = (await response.json().catch(() => ({}))) as typeof body;
      } catch (cause) {
        addActivity({
          label: 'Opening balance not requested',
          detail: `The sponsor could not be reached, so no opening balance was deposited into ${compactAddress(
            contractAddress,
          )}: ${cause instanceof Error ? cause.message : String(cause)}`,
          status: 'blocked',
          source: 'chain',
        });
        return;
      }

      const code = typeof body.error === 'string' ? body.error : null;
      if (!response.ok) {
        /* The grant already exists. That is the outcome this call wanted, so it
           is recorded as reached — and the marker is written, because asking
           again would only earn the same refusal. */
        if (code === 'already-activated' || code === 'already-funded') {
          rememberAccountFunding(contractAddress);
          void refreshAccountBalances();
          return;
        }
        addActivity({
          label: 'Opening balance not deposited',
          detail:
            typeof body.message === 'string'
              ? body.message
              : `The sponsor refused with status ${response.status}.`,
          status: 'blocked',
          source: 'chain',
        });
        return;
      }

      rememberAccountFunding(contractAddress);
      /* The sponsor names the colour it just deposited, so a `/status` probe
         that had not answered — or answered before the sponsor had an asset —
         is corrected here. Only ever fills a gap: a colour already known came
         from the same service and must not be overwritten mid-session. */
      const fundedColour = normalisedColourHex(
        typeof body.assetColourHex === 'string' ? body.assetColourHex : null,
      );
      if (fundedColour) {
        setStablecoin(
          (current) =>
            current ?? {
              symbol:
                typeof body.assetSymbol === 'string' && body.assetSymbol.trim()
                  ? body.assetSymbol.trim()
                  : 'mUSD',
              colourHex: fundedColour,
            },
        );
      }
      const txHash = typeof body.txHash === 'string' ? body.txHash : undefined;
      /* The two legs are independent, and the sponsor says so: a 200 can carry
         a landed NIGHT deposit and an `assetError` where the stablecoin half
         failed. Each is reported as what it was — never one sentence covering
         both on the strength of the status code. */
      const assetTx = typeof body.assetTx === 'string' && body.assetTx ? body.assetTx : null;
      const assetError = typeof body.assetError === 'string' ? body.assetError : null;
      addActivity({
        label: 'Opening balance deposited',
        detail: `The sponsor deposited ${
          typeof body.amountAtomic === 'string' ? body.amountAtomic : 'an opening'
        } atomic NIGHT into your account contract ${compactAddress(contractAddress)}.${
          assetError ? ` The stablecoin half did not land: ${assetError}` : ''
        }`,
        status: 'complete',
        source: 'chain',
        ...(txHash ? { txHash } : {}),
      });
      if (assetTx) {
        addActivity({
          label: 'Stablecoin deposited',
          detail: `${
            typeof body.assetAmount === 'string' ? body.assetAmount : 'The sponsor’s stablecoin'
          } went into your account contract ${compactAddress(contractAddress)} alongside the NIGHT.`,
          status: 'complete',
          source: 'chain',
          txHash: assetTx,
        });
      }
      void refreshAccountBalances();
    },
    [addActivity, refreshAccountBalances],
  );

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
  const claimAliasBoundToAccount = useCallback(
    async (
      handle: LocalMidnightWallet,
      activeProfile: DemoPassportProfile,
      alias: string,
      onPhase: (phase: AliasClaimProgress['phase']) => void,
    ): Promise<AliasClaimResult> => {
      const credentialId = activeProfile.passkey.credentialId;
      const network = handle.network.networkId;
      const [
        {
          AliasClaimError,
          checkAliasAvailability,
          checkAliasClaimFunds,
          claimAlias,
          deriveMidnamesOwnerKey,
        },
        { deployPassportContract },
        { deriveWalletSeed },
        { AliasSponsorRefusal, checkAliasSponsorship, sponsorAliasRegistration },
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
          `Passport registers names on ${CLAIMABLE_NETWORKS.join(' and ')} only; this wallet is on ${network}.`,
        );
      }
      const registryNetwork = network as MidnamesNetwork;

      /* (1) Both gates before the prompt. `claimAlias` runs them again for
         itself; running them here as well is what keeps the ACCOUNT CONTRACT
         from being deployed for a claim that was never going to land. */
      const availability = await checkAliasAvailability(registryNetwork, alias, { fresh: true });
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
          'The .night registry could not be reached, so the name cannot be claimed right now.',
          availability.detail,
        );
      }
      /* Sponsorship first, funds second. When the funder says it is sponsoring
         registrations on this network, the user's own NIGHT is simply not part
         of the claim — a wallet holding NOTHING gets its name — so gating on it
         would refuse exactly the person this exists for. The funds gate still
         runs, unchanged, whenever the sponsor cannot be confirmed. */
      const sponsored = FUNDER_URL
        ? await checkAliasSponsorship(FUNDER_URL, registryNetwork)
        : false;
      if (!sponsored) {
        const funds = await checkAliasClaimFunds(handle, alias);
        if (!funds.ok) throw new AliasClaimError('insufficient-night', funds.reason);
      }

      /* (2) The one ceremony. Both secrets, one assertion, handle disposed. */
      const oneShot = await withPasskeyWatchdog(() =>
        WebAuthnPrfKeyProvider.assertOnce(activeProfile.passkey),
      );
      let ownerSecret: Uint8Array;
      let contractRootSecret: Uint8Array;
      try {
        ownerSecret = await deriveWalletSeed(oneShot, MIDNAMES_OWNER_SCOPE);
        contractRootSecret = await deriveWalletSeed(oneShot, PASSPORT_CONTRACT_SCOPE);
      } finally {
        // The PRF output is zeroed here and never reaches any cache.
        oneShot.dispose();
      }

      try {
        /* (3) The account-custody contract. An existing DEPLOYED record for
           this credential and network is reused — a Passport has one contract
           per network, not one per name. */
        const existing = loadPassportContractRecord(credentialId, network);
        let contractAddress = existing?.status === 'deployed' ? existing.address : undefined;
        if (!contractAddress) {
          onPhase('attaching-account');
          setContractBusy(true);
          /* Hoisted out of the try so the catch below knows whether this claim
             merely waited on somebody else's deploy. A joined deploy is theirs
             to record; this claim only reads its outcome. */
          let joinedDeploy = false;
          try {
            /* Through the shared gate, never straight to `deployPassportContract`:
               the Home card's retry may already have one running for this
               credential and network, and a second would be a second contract
               the user paid for and the records would forget. */
            const { outcome, joined } = deployPassportContractOnce(
              credentialId,
              network,
              () =>
                deployPassportContract(handle, contractRootSecret, (progress) =>
                  setContractPhase(progress.phase),
                ),
            );
            joinedDeploy = joined;
            const deployment = await outcome;
            if (!joinedDeploy) {
              // The deployed record was written by the gate; this is the claim's
              // own account of it, which a joining claim must not duplicate.
              addActivity({
                label: 'Passport contract deployed',
                detail: `${compactAddress(deployment.address)} is ${
                  deployment.ledgerConfirmed ? 'live' : 'submitted'
                } on ${deployment.network}, ready for ${alias}.night to point at it.`,
                status: 'complete',
                source: 'chain',
                txHash: deployment.deployTxId,
              });
              /* The deploy is the long half of onboarding and has no toast of
                 its own — the claim's own toast comes later, once the name has
                 landed. This is the only thing that says the first step is
                 done while the second is still running. */
              void notify(
                'Your Passport contract is deployed',
                `${deployment.ledgerConfirmed ? 'It is live' : 'It is submitted'} on ${
                  deployment.network
                }. Registering ${alias}.night against it now.`,
                { tag: 'passport-contract-deployed' },
              );
            }
            contractAddress = deployment.address;
          } catch (cause) {
            /* The failure is recorded as a failure — that record is what puts
               the "Try deploying again" affordance on the Home card — and then
               re-thrown, because the claim must not continue. A deploy this
               claim merely joined has already been recorded by whoever started
               it, so only the owner writes. */
            const message = cause instanceof Error ? cause.message : String(cause);
            const detail = (cause as { detail?: string })?.detail;
            if (!joinedDeploy) {
              savePassportContractRecord({
                credentialId,
                network,
                status: 'failed',
                failureReason: detail ? `${message} (${detail})` : message,
                updatedAt: new Date().toISOString(),
              });
            }
            throw new AliasClaimError(
              'account-contract-failed',
              `${alias}.night was not registered: your Passport's account contract could not be deployed, and the name would have had nothing to point at.`,
              detail ? `${message} (${detail})` : message,
            );
          } finally {
            setContractPhase(null);
            setContractBusy(false);
          }
        }

        /* (4) The claim itself, bound to the contract address the chain gave
           us — never to a value assembled from anything else.

           Sponsored first: the funder registers the name FOR this Passport —
           user's key as owner, this contract as target — paying the registry
           price and the fees itself, so the user-side ceremony is already
           over (the one passkey assertion above). The self-paid path is the
           honest fallback, not a dead branch: it runs when no funder is
           configured, when the funder refuses for a reason self-paying can
           fix (out of NIGHT, rate ceiling, one-sponsored-name-per-Passport),
           and it re-runs its own funds gates, so a broke wallet still gets
           the truthful insufficient-night message rather than a retry loop. */
        let claimed: AliasClaimResult | null = null;
        if (sponsored && FUNDER_URL) {
          onPhase('registering');
          try {
            claimed = await sponsorAliasRegistration(FUNDER_URL, {
              alias,
              ownerKey: await deriveMidnamesOwnerKey(ownerSecret),
              contractAddress,
              ownerAddress: handle.unshieldedAddress,
              network: registryNetwork,
            });
          } catch (cause) {
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
              `${cause.message} Passport registers names through its service and does not spend from your wallet — the name is kept for you to register again shortly.`,
            );
          }
        }
        if (!claimed) {
          /* No sponsor on offer at all: same rule, same outcome. The self-paid
             `claimAlias` path stays in `identity/midnames.ts` for the drills
             that prove the registry, and is deliberately never reached from
             the app. */
          throw new AliasClaimError(
            'network-unreachable',
            'The Passport service that registers names is not available right now. Your name is kept for you and can be registered when it is back — Passport does not spend from your wallet for this.',
          );
        }

        /* (5) The opening balance, into the ACCOUNT rather than into the
           wallet. Fired here because this is the moment the Passport is whole
           — a deployed contract with a name pointing at it — and deliberately
           NOT awaited: the sponsor proves two deposits before it answers, and
           the name's success does not depend on a grant landing. It is fired
           on the self-paid path too, because the grant is about the account and
           not about who paid for the name; `fundAccountOnce` is a no-op with no
           sponsor configured, and once-per-contract either way. */
        void fundAccountOnce(contractAddress);

        /* (6) Attach the account to the passkey, so a device that has never
           seen this Passport can find the contract again. Deliberately NOT
           awaited: the name is registered and the contract is deployed, and a
           largeBlob write is a separate assertion the specification will not
           let us fold into either of them. It must never hold the claim open
           or be able to fail it — see `rememberAccountOnPasskey`, which does
           not throw. */
        void rememberAccountOnPasskey(
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
    [addActivity, deployPassportContractOnce, fundAccountOnce, rememberAccountOnPasskey],
  );

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
        setAliasError('Your wallet is not open yet. Wait for it to finish opening and try again.');
        return;
      }
      setAliasError(null);
      /* The first phase the button narrates is the first thing that really
         happens — the availability and funds re-checks — so it stays on
         'deploying-resolver' only until the ceremony reports otherwise. */
      setClaimPhase('deploying-resolver');
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
          label: 'Midnight name registered',
          detail: `${result.domain} now resolves to this Passport's account contract (${compactAddress(
            result.resolverTargetHex,
          )}) on ${result.network}.`,
          status: 'complete',
          source: 'chain',
          txHash: result.registerTxId,
        });
        pushToast({
          tone: 'success',
          title: `${result.domain} is yours`,
          body: result.registryConfirmed
            ? 'The registry confirmed the registration.'
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
            ? 'The registry confirmed the registration.'
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
        setAliasError(detail ? `${message} (${detail})` : message);
        addActivity({
          label: 'Midnight name',
          detail: detail ? `${message} — ${detail}` : message,
          status: 'error',
          source: 'chain',
        });
      } finally {
        setClaimPhase(null);
      }
    },
    [addActivity, claimAliasBoundToAccount, profile, refreshLocalBalances],
  );

  /**
   * Claim for real on the network the open wallet is actually on; queue
   * honestly anywhere else. Both halves of the condition matter: the user may
   * be *browsing* a network the wallet does not sign on.
   */
  const claimOrQueueAlias = useCallback(
    async (alias: string, network: PassportNetwork): Promise<void> => {
      if (network === localWalletNetworkId && aliasClaimSupported) {
        /* A brand-new Passport holds nothing, and its first act should not be
           a trip to a captcha faucet. Where a funder is configured, the grant
           is fetched and waited for HERE, before the claim — so the one button
           the user pressed does the whole thing. A funder that refuses or
           never lands is not fatal: the claim proceeds and fails with its own
           honest insufficient-funds message.

           A funder that SPONSORS registrations makes the grant itself
           pointless: it will register the name with its own NIGHT, so the
           user's balance is not consulted at all and no drip is requested. */
        /* No activation grant to the wallet, ever: the service registers the
           name from its own funds and, once the account exists, funds THE
           ACCOUNT. A wallet-address drip would put value where the account
           model says none may sit (ruled 2026/08/25). */
        await claimAliasOnChain(alias);
        return;
      }
      queueAlias(
        alias,
        network,
        `Passport's wallet signs and submits on ${signingNetworkLabel} only, so ${alias}.night is reserved for you locally but is NOT registered on ${NETWORK_LABELS[network]}.`,
      );
    },
    [
      activateWalletViaFunder,
      aliasClaimSupported,
      claimAliasOnChain,
      claimNightShortfall,
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
   * funds are re-checked without any passkey prompt; (3) only then does the
   * real `claimAlias` run, with the same progress phases as onboarding.
   * Success upgrades the record to `registered` with both real transaction
   * ids. Failures are surfaced inline on the card, never as a toast.
   */
  const registerQueuedAlias = useCallback(async (): Promise<void> => {
    if (registerNowBusy) return;
    const record = loadAliasRecords()[selectedNetwork];
    if (!record || record.status === 'registered') return;
    const handle = localWalletRef.current;
    const activeProfile = profile;
    if (!handle || !activeProfile) return; // The card disables the action first.
    setRegisterNowBusy(true);
    setAliasError(null);
    const requeue = (reason: string) =>
      saveAliasRecord({
        ...record,
        status: 'queued',
        queuedReason: reason,
        updatedAt: new Date().toISOString(),
      });
    try {
      const { checkAliasAvailability, checkAliasClaimFunds } = await import(
        './identity/midnames.js'
      );
      // (1) The name may have been taken while it sat in the queue. It is
      // re-probed on the network the record is FILED under — which is the one
      // the wallet signs on, because `registerNowDisabledReason` has already
      // refused the action on any other.
      const availability = await checkAliasAvailability(selectedNetwork, record.alias, {
        fresh: true,
      });
      if (availability.status === 'unreachable') {
        requeue(
          `The ${selectedNetwork} .night registry could not be reached, so ${record.domain} is still not on chain: ${availability.detail}`,
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
      // (2) Funds, before any passkey prompt — SKIPPED entirely while the
      // funder is sponsoring registrations, because the sponsored claim never
      // consults the user's balance (see `claimAliasBoundToAccount`, which
      // re-probes and falls back to these same gates itself). Otherwise: with
      // a funder configured, a NIGHT shortfall earns one automatic activation
      // attempt before the record goes honestly back in the queue — and the
      // re-check afterwards is the same gate run again, never an assumption
      // that the drip landed.
      const sponsored = await aliasSponsorshipLikely(selectedNetwork);
      if (!sponsored) {
        let funds = await checkAliasClaimFunds(handle, record.alias);
        if (!funds.ok) {
          /* No drip and no self-paid registration: without the sponsor the
             name simply stays queued, with the reason the wallet must never
             be asked to fix (ruled 2026/08/25). */
          requeue(SPONSOR_UNAVAILABLE_SENTENCE);
          return;
        }
      }
      // (3) The onboarding claim's exact path, contract and all: one passkey
      // ceremony, the account contract deployed if this Passport has none on
      // this network, then the two Midnames transactions with the name bound
      // to that contract. See `claimAliasBoundToAccount`.
      setClaimPhase('deploying-resolver');
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
        label: 'Midnight name registered',
        detail: `${result.domain} now resolves to this Passport's account contract (${compactAddress(
          result.resolverTargetHex,
        )}) on ${result.network}.`,
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
      requeue(detail ? `${message} (${detail})` : message);
      addActivity({
        label: 'Midnight name',
        detail: detail ? `${message} — ${detail}` : message,
        status: 'error',
        source: 'chain',
      });
    } finally {
      setClaimPhase(null);
      setRegisterNowBusy(false);
    }
  }, [activateWalletViaFunder, addActivity, claimAliasBoundToAccount, claimNightShortfall, profile, refreshLocalBalances, registerNowBusy, selectedNetwork]);

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
      const [{ deployPassportContract, checkPassportContractFunds }, { deriveWalletSeed }] =
        await Promise.all([
          import('./identity/passportContract.js'),
          import('./lib/localWallet.js'),
        ]);
      // Funds first, before any passkey prompt: a wallet that cannot pay should
      // be told so rather than asked to touch its authenticator and then fail.
      const funds = await checkPassportContractFunds(handle);
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
           than issuing a second one for the same credential and network. */
        const { outcome, joined } = deployPassportContractOnce(credentialId, network, () =>
          deployPassportContract(handle, rootSecret, (progress) =>
            setContractPhase(progress.phase),
          ),
        );
        joinedDeploy = joined;
        deployment = await outcome;
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
      const txIdResolved = isLedgerTxHash(deployment.deployTxId);
      addActivity({
        label: 'Passport contract deployed',
        detail: `${compactAddress(deployment.address)} is ${
          deployment.ledgerConfirmed ? 'live' : 'submitted'
        } on ${deployment.network}.`,
        status: 'complete',
        source: 'chain',
        txHash: deployment.deployTxId,
      });
      pushToast({
        tone: 'success',
        title: 'Your Passport contract is deployed',
        body: `${
          deployment.ledgerConfirmed
            ? 'The indexer is serving its state.'
            : 'Submitted — the indexer has not reported it yet.'
        }${
          txIdResolved
            ? ''
            : /* No link, and the reason said out loud rather than a link that
                 resolves to nothing on the explorer. */
              ' The indexer has not yet mapped the transaction identifier to a ledger hash, so there is no explorer link yet.'
        }`,
        link: explorerTxLink(deployment.deployTxId, deployment.network),
      });
      /* The retry path. Same tag as the claim's deploy: one contract, one
         story, whichever route reached it. */
      void notify(
        'Your Passport contract is deployed',
        `${compactAddress(deployment.address)} is ${
          deployment.ledgerConfirmed ? 'live' : 'submitted'
        } on ${deployment.network}.`,
        { tag: 'passport-contract-deployed' },
      );
      void refreshLocalBalances();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = (cause as { detail?: string })?.detail;
      const reason = detail ? `${message} (${detail})` : message;
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
        label: 'Passport contract',
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
            `The ${NETWORK_LABELS[next]} .night registry could not be reached during the switch, so ${held.alias}.night is not registered there: ${availability.detail}`,
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
    if (identityStepResolved.current) return;
    identityStepResolved.current = true;
    identityStepArmed.current = false;
    if (loadAliasRecords()[selectedNetwork]) return;
    /* Only a DONE resolution suppresses the step. 'skipped' deliberately does
       not any more: a skip used to be remembered per credential forever, so a
       passkey that skipped once landed on Home with no name and no account on
       every subsequent sign-in — seen live 2026/08/24. A stored skip now means
       "ask again", and the screen itself no longer offers one. */
    if (storedNameStep(profile.passkey.credentialId) === 'done') return;
    setIdentityStep('alias');
  }, [localSurfaces, localWalletStatus, profile, selectedNetwork]);

  const signOutPassport = async () => {
    // Sign-out is the boundary of the §2.2 session stopgap: the wrapped seed
    // and its wrapping key are removed before anything else is torn down.
    await clearPersistedWalletSession();
    await closeLocalWallet();
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
    setSelectedTx(null);
    setMobileTab('home');
    setOnboardingIntent(null);
    setOnboardingBusyLabel(null);
    setOnboardingError(null);
    // The identity steps re-decide on the next sign-in. The alias records
    // themselves are NOT cleared: the same passkey re-derives the same wallet,
    // so the name it registered is still that wallet's name.
    setIdentityStep(null);
    setClaimPhase(null);
    setAliasError(null);
    setReclaim(null);
    setReclaimError(null);
    identityStepResolved.current = false;
    // Signing out does NOT re-arm the name step: the next sign-in is a
    // sign-in, and lands on the dashboard. The stored per-credential
    // resolution is deliberately left in place for the same reason.
    identityStepArmed.current = false;
    transactionsRequest.current += 1;
    setTransactions([]);
    setTransactionsStatus('loading');
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
  const showOnboarding =
    !sessionActive || onboardingIntent !== null || onboardingError !== null;
  // The §2.2 session restore opens the wallet with no onboarding intent set,
  // so an opening local wallet also reads as the working stage.
  const onboardingStage: 'welcome' | 'working' =
    onboardingIntent !== null || localWalletStatus === 'opening' ? 'working' : 'welcome';
  const onboardingLabel =
    onboardingBusyLabel ?? 'Follow the passkey prompt on this device';
  /** The one onboarding route. */
  const startPasskeyOnboarding = (intent: 'create' | 'signin' | 'auto') => {
    void runLocalOnboarding(intent);
  };

  // Transactions confirmed in this session are already known locally; the
  // indexer may not have caught up yet, so session rows lead the feed.
  const sessionTransactions: RecentTransaction[] = activity
    .filter((entry): entry is ActivityEntry & { txHash: string } => Boolean(entry.txHash))
    .map((entry) => ({
      hash: entry.txHash,
      timestamp: entry.createdAt,
      involvesUser: true,
      kind: entry.label,
    }));
  const mergedTransactions: RecentTransaction[] = [];
  const seenTransactionHashes = new Set<string>();
  for (const row of [...sessionTransactions, ...transactions]) {
    if (seenTransactionHashes.has(row.hash)) continue;
    seenTransactionHashes.add(row.hash);
    mergedTransactions.push(row);
  }
  // The indexer's own status is handed to HomeScreen untouched: session rows
  // must never mask an unavailable indexer, and the screen decides how to show
  // rows and a status notice together.
  const mobileTransactionsStatus: TransactionsStatus = transactionsStatus;

  const openTransactionByHash = (hash: string) => {
    const known = activity.find((entry) => entry.txHash === hash);
    if (known) {
      setSelectedTx(known);
      return;
    }
    const row = mergedTransactions.find((candidate) => candidate.hash === hash);
    const status: ActivityStatus =
      row?.applyStage === 'SUCCESS'
        ? 'complete'
        : row?.applyStage === 'FAILURE'
          ? 'error'
          : row?.applyStage === 'PARTIAL_SUCCESS'
            // Finalised, but only partly applied — never still in flight.
            ? 'blocked'
            : 'pending';
    setSelectedTx({
      id: hash,
      label: row?.kind ?? 'Midnight transaction',
      detail:
        typeof row?.blockHeight === 'number'
          ? `Read from the Midnight indexer in block ${row.blockHeight}.`
          : 'Read from the Midnight indexer.',
      status,
      source: 'chain',
      txHash: hash,
      createdAt: row?.timestamp ?? new Date().toISOString(),
    });
  };

  /**
   * Copies the one address Home still shows: the payment address the resolver
   * leaf carries, which is this Passport's unshielded wallet address. The
   * shielded and DUST rows left the Receive sheet with the ruling that a user's
   * identity is their `.night` name — they survive only where a dApp genuinely
   * asks for them, behind consent.
   */
  const copyReceivingAddress = () => {
    const address = activeSurfaces?.unshieldedAddress;
    if (!address) return;
    void copyText(address).then(
      () => pushToast({ tone: 'success', title: 'Address copied' }),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const refreshMobile = () => {
    void refreshLocalBalances();
    void refreshTransactions();
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
      await withPasskeyWatchdog(() => confirmPresence(passkey, reason));
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
        // Nothing has been built, proved, or submitted at this point.
        throw passkeyCeremonyFailure(cause);
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
      /* Structurally a `SendNightError` — `{ code, message }` — without a value
         import of `lib/localWallet.ts`, which statically pulls in the whole
         wallet SDK. */
      throw Object.assign(
        new Error('The Passport wallet session closed before this could be signed.'),
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
              detail: `Paid from your account contract for ${intent.origin}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              title: 'Payment submitted',
              body: intent.purpose,
              link: explorerTxLink(result.txId, result.network),
            });
            // The account's balance has moved and the indexer needs a moment to
            // see it; the session row already carries the transaction meanwhile.
            void refreshLocalBalances();
            window.setTimeout(() => void refreshTransactions(), 5_000);
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
      refreshTransactions,
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
   * How the next transfer's fee would really be paid. Advisory — the send path
   * re-checks everything — so a failure here is thrown, not smoothed into
   * `no-dust`: "we could not tell" and "you cannot pay" are different
   * sentences, and the sheet says whichever is true.
   */
  const readLocalFeeReadiness = useCallback(async (): Promise<FeeReadiness> => {
    const handle = localWalletRef.current;
    if (!handle) throw new Error('The Passport wallet session is not open.');
    return handle.feeReadiness();
  }, []);

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
            label: 'Sent NIGHT',
            detail: `To ${params.recipientAddress}.`,
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
              detail: `Withdrawn from your account contract to ${params.recipientAddress}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              /* The node has accepted the transaction, not yet included it — the
                 title claims exactly that much and no more. */
              title: 'NIGHT accepted by the network — confirming',
              /* A covered fee is claimed on the strength of what the sponsor
                 really did, which is what `feePaidBy` records — a sponsored
                 attempt that fell back reports `own-dust` and says so. */
              body:
                result.feePaidBy === 'sponsored'
                  ? 'The fee sponsor covered the network fee.'
                  : 'The network fee was paid by this Passport.',
              link: explorerTxLink(result.txId, result.network),
            });
            // The account's balance has moved and the indexer needs a moment to
            // see it; the session row already carries the transaction meanwhile.
            void refreshLocalBalances();
            window.setTimeout(() => void refreshTransactions(), 5_000);
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
      refreshTransactions,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
    ],
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
            label: 'Sent a shielded token',
            detail: `To ${params.recipientAddress}.`,
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
              detail: `Withdrawn from your account contract to ${params.recipientAddress}.`,
              source: 'chain',
              txHash: result.txId,
            });
            pushToast({
              tone: 'success',
              /* Accepted, not yet included — the same claim the NIGHT path makes. */
              title: 'Shielded transfer accepted by the network — confirming',
              body:
                result.feePaidBy === 'sponsored'
                  ? 'The fee sponsor covered the network fee.'
                  : 'The network fee was paid by this Passport.',
              link: explorerTxLink(result.txId, result.network),
            });
            void refreshLocalBalances();
            window.setTimeout(() => void refreshTransactions(), 5_000);
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
      refreshTransactions,
      requireAccount,
      updateActivity,
      withAccountDeviceSecret,
    ],
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
        detail: `${formatNightUnits(held)} NIGHT from this device's wallet into ${compactAddress(
          account.address,
        )}.`,
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
        detail: `${formatNightUnits(held)} NIGHT now sits in your account contract.`,
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
      const reason = detail ? `${message} (${detail})` : message;
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
          phase: accountPhase,
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
   * Funds still sitting in the passkey wallet rather than in the account.
   *
   * Offered only where there is really something to move AND somewhere to move
   * it to. It is not a state a Passport created today can reach — onboarding
   * funds the account directly — so this is the older-account path, and it says
   * so in the screen's own words rather than implying the user did something
   * wrong.
   */
  /**
   * The dApp payment seam, handed over only when there is genuinely an account
   * to pay from. Withheld, an app is answered `wallet-unavailable` before a
   * sheet is ever shown — the same rule the Send control keeps, and better than
   * an approval that could only end in a refusal.
   */
  const appTransferSeam =
    localSessionActive && accountContractAddress ? executeAppTransfer : undefined;

  const walletHeldNight = atomicNightFromFormatted(localSurfaces?.unshieldedBalance ?? null);
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
      detail: `${result.fileName} holds ${result.counts.aliases} name claim(s), ${result.counts.passportContracts} contract record(s), and ${result.counts.incentives} reward(s), encrypted under a password Passport never stores. No key material is in the file.`,
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
            'no wallet is open, so there was no indexer to ask. The check runs at your next sign-in.',
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
      const { importPassportBackup } = await import('./identity/backup.js');
      const summary = await importPassportBackup(file, password);
      /* Done HERE, as part of the restore, rather than promised for later: a
         restored contract record is a claim made by a file, and until the
         indexer answers for its address this browser has no evidence the
         contract is there. The result travels back with the summary so the
         Backup screen reports what actually happened rather than what was
         going to happen. */
      const ledgerCheck = await confirmRestoredContracts(summary.passportContracts.restoredKeys);
      addActivity({
        label: 'Passport backup restored',
        detail: `From a backup taken ${summary.createdAt}: ${summary.aliases.restored}/${summary.aliases.found} name claim(s), ${summary.passportContracts.restored}/${summary.passportContracts.found} contract record(s), ${summary.incentives.restored}/${summary.incentives.found} reward(s) written to this browser.${
          ledgerCheck.ran
            ? ` ${ledgerCheck.confirmed} contract(s) confirmed on ${ledgerCheck.network} by the indexer; ${ledgerCheck.unconfirmed} not yet.`
            : ` Contracts were not re-checked against the chain: ${ledgerCheck.reason}`
        }`,
        status: 'complete',
        source: 'local',
      });
      return { ...summary, ledgerCheck };
    },
    [addActivity, confirmRestoredContracts],
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
        ? `Passport's wallet signs and submits on ${signingNetworkLabel} only, so ${activeAliasRecord.domain} cannot be registered on ${NETWORK_LABELS[selectedNetwork]} from here.`
        : !localSessionActive
          ? 'Sign in with your passkey to open the wallet before registering this name.'
          : localWalletNetworkId !== configuredNetworkId() || !aliasClaimSupported
            /* Compared against the RAW configured id: under the env-gated demo
               masquerade the wallet's real network is a devnet presented as
               Preview, and that pairing is exactly the sanctioned one. */
            ? `This wallet session runs on ${localWalletNetworkId ?? 'an unknown network'}; names register on ${signingNetworkLabel} only.`
            : walletStillSyncing
              ? 'The wallet is still syncing. Registration opens once the sync completes.'
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
      setAliasError(null);
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
    ? 'Sign in with your passkey to open the wallet before deploying your contract.'
    : selectedNetwork !== walletPresentedNetwork
      ? `This Passport's wallet signs on ${signingNetworkLabel}, so its contract can only be deployed there.`
      : walletStillSyncing
        ? 'The wallet is still syncing. Deployment opens once the sync completes.'
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
            (claimPhase !== null && activeContractRecord?.status !== 'deployed'),
          phase: contractPhase,
          disabledReason:
            activeContractRecord?.status === 'failed' ? contractDeployDisabledReason : null,
          feeNote: activeContractRecord?.status === 'failed' ? contractFeeNote : null,
        }
      : null;
  /**
   * Queue from the claim screen. Queuing IS a resolution of the name step —
   * the name is chosen, it just is not on chain yet — so it lands on the
   * dashboard, where the queued card carries the "Register now" action.
   */
  const queueFromClaimScreen = async (alias: string, reason: string) => {
    // With a funder configured, an insufficient-NIGHT queue on the wallet's
    // own network becomes an activation attempt first: drip, wait for the
    // grant on the live balance stream, then run the REAL claim (sponsored
    // fees exactly as today). Every other queue reason — wrong network,
    // unreachable registry — passes through untouched, as does everything
    // when no funder is configured.
    /* A queued name stays queued. There is no activation grant to the wallet
       and no wallet-funded registration to fall back to: the sponsor
       registers names from its own funds, and when it cannot, the name
       waits (ruled 2026/08/25). */
    queueAlias(alias, selectedNetwork, reason);
    if (profile) storeNameStep(profile.passkey.credentialId, 'done');
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
      {selectedTx && <TransactionModal entry={selectedTx} onClose={() => setSelectedTx(null)} />}
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
          feesSponsored={feesSponsored}
          autoActivates={
            Boolean(FUNDER_URL) &&
            selectedNetwork === localWalletNetworkId &&
            aliasClaimSupported
          }
          nightBalance={activeSurfaces?.unshieldedBalance ?? null}
          checkAvailability={checkAliasOnActiveNetwork}
          onClaim={(alias) => claimOrQueueAlias(alias, selectedNetwork)}
          onQueue={queueFromClaimScreen}
          onSkip={() => {
            setAliasError(null);
            // Remembered per credential, so a reload — or the next sign-in —
            // never asks again. Home keeps the "Claim a name" entry point.
            if (profile) storeNameStep(profile.passkey.credentialId, 'skipped');
            setIdentityStep(null);
          }}
          claimPhase={claimPhase}
          error={aliasError}
        />
      ) : identityStep === 'backup' ? (
        /* Off the onboarding chain since 2026/08/06 — reached on demand from
           Home. Since 2026/08/19 it also exports and restores the private
           state as one password-encrypted file; see
           `./identity/backup.ts` for what that file holds and what it
           deliberately cannot. */
        <BackupScreen
          hasEncryptedRecord={Boolean(profile)}
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
            setAliasError(null);
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
                 The wallet's own balances, its DUST charge, and its shielded
                 and DUST addresses are no longer on this screen at all. */
              account={homeAccount}
              legacyFunds={homeLegacyFunds}
              unshieldedAddress={activeSurfaces?.unshieldedAddress ?? null}
              error={error}
              onDismissError={() => setError(null)}
              onRefresh={refreshMobile}
              onCopyAddress={copyReceivingAddress}
              /* The Send seam. `null` when no wallet session is open or this
                 Passport has no account contract, which is what makes Home
                 render no Send control at all. */
              send={homeSend}
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

function TransactionModal({ entry, onClose }: { entry: ActivityEntry; onClose: () => void }) {
  const source = activitySource(entry);
  // Activity rows carry no network of their own, so the link is built for the
  // network this build runs on — and omitted entirely where that network has
  // no public explorer, rather than pointing at another network's.
  const explorerHref = explorerTxUrl(configuredWalletNetwork, entry.txHash);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal" role="dialog" aria-modal="true" aria-label="Transaction detail" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Transaction detail</p><h2>{entry.label}</h2></div><IconButton label="Close transaction detail" onClick={onClose}><X size={16} /></IconButton></div>
        <dl><div><dt>Status</dt><dd><ActivityPill status={entry.status} /></dd></div><div><dt>Source</dt><dd><span className={`source-pill ${source}`}>{sourceLabel(source)}</span></dd></div><div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div><div><dt>Detail</dt><dd>{entry.detail}</dd></div><div><dt>Transaction hash</dt><dd>{entry.txHash ? <code>{entry.txHash}</code> : 'No on-chain transaction was produced.'}</dd></div></dl>
        {entry.txHash && (
          <div className="modal-actions">
            <button className="modal-secondary" onClick={() => void copyText(entry.txHash!)}><Copy size={16} /> Copy hash</button>
            {explorerHref ? <a className="modal-copy modal-explorer" href={explorerHref} target="_blank" rel="noreferrer"><ArrowUpRight size={16} /> Open explorer</a> : null}
          </div>
        )}
      </div>
    </div>
  );
}
