import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Box,
  Check,
  CircleAlert,
  CircleHelp,
  Copy,
  DatabaseZap,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LogOut,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react';
import { useDynamicContext, useUserWallets } from '@dynamic-labs/sdk-react-core';
import { isMidnightWallet, type MidnightWallet } from '@dynamic-labs/midnight';
import { mainnet, MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportEnrolmentConflictError,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from './backend.js';
import type { DiscoveredPassportPasskey, PassportAccountBlob } from './backend.js';

import {
  compactAddress,
  initialDynamicSurfaceState,
  refreshDynamicAddresses,
  refreshDynamicBalances,
  authorizeAndSubmitDynamicCompactTransaction,
  signDynamicTransferTransaction,
  submitDynamicTransferTransaction,
  type DynamicSurfaceState,
} from './dynamic.js';
import {
  PASSPORT_C1_ARTIFACT,
  PASSPORT_C1_NETWORK,
  buildPassportC1Deployment,
  createPassportC1MaintenanceSigningKey,
  type PassportC1DeploymentDraft,
} from './c1.js';
import {
  DynamicSubmissionPendingError,
  confirmDynamicSubmission,
  deployPassportC1ViaDynamic,
  dynamicSupportsContractSettlement,
} from './lib/dynamicContract.js';
import {
  LOCAL_C1_ARTIFACT,
  LOCAL_C1_NETWORK,
  LocalCustodyPendingError,
  addLocalPassportPermission,
  depositLocalPassportNight,
  deployLocalPassportContract,
  loadLocalPassportCustody,
  loadLocalPassportPermissions,
  localPassportGrantCommitment,
  localPassportMode,
  mintAndDepositLocalPassportShielded,
  registerLocalPassportIdentity,
  revokeLocalPassportPermission,
  withdrawLocalPassportNight,
  withdrawLocalPassportShielded,
  type LocalPassportCustody,
  type LocalPassportPermission,
} from './localC1.js';
import { requestPassportStoragePersistence } from './pwa.js';
import {
  deleteDemoProfile,
  listLocalProfiles,
  loadDemoProfile,
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
// The local wallet drags the whole Midnight wallet SDK in with it. It is loaded
// on demand, from the passkey routes only, so a Dynamic-only session never pays
// for it. Types are erased at build time and cost nothing here.
import type {
  FeeReadiness,
  LocalMidnightWallet,
  LocalWalletBalances,
  LocalWalletSurfaces,
  SendNightResult,
} from './lib/localWallet.js';

type ActivityStatus = 'pending' | 'complete' | 'blocked' | 'error';
type TransferPool = 'unshielded' | 'shielded';
type WorkspaceTab = 'assets' | 'permissions' | 'connections';
type AddressKind = 'unshielded' | 'shielded' | 'dust';
type ActivationState = 'waiting' | 'ready' | 'active' | 'complete';
type BusyAction =
  | 'passport-key'
  | 'passport-unlock'
  | 'message'
  | 'dust'
  | 'transfer'
  | 'recovery'
  | 'passport-deploy'
  | 'identity-register'
  | 'permission-read'
  | 'permission-add'
  | 'permission-revoke'
  | 'custody-read'
  | 'custody-night-deposit'
  | 'custody-night-withdraw'
  | 'custody-shielded-deposit'
  | 'custody-shielded-withdraw';
type ProfileStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';
type ActivitySource = 'local' | 'wallet' | 'chain';
/** The mobile-first Passport, or the original desktop portal and workspace. */
type Experience = 'mobile' | 'classic';
/**
 * Which wallet backs the session.
 *
 * `local` is the passkey-derived, in-browser Midnight wallet built by
 * `lib/localWallet.ts`; Dynamic is never contacted on that route. `dynamic` is
 * the hosted account and its embedded Midnight wallet.
 */
type WalletMode = 'local' | 'dynamic';
type OnboardingIntent = 'local-create' | 'local-signin' | 'dynamic';
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

interface TransferReview {
  pool: TransferPool;
  recipient: string;
  amount: string;
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

type DisplayPermission = LocalPassportPermission & { label: string };

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
  import.meta.env.VITE_INDEXER_URL ?? 'https://indexer.preview.midnight.network/api/v4/graphql';
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
/** Appended to the queue reason when activation was attempted and failed. */
const FUNDER_UNAVAILABLE_SENTENCE =
  'Automatic activation was unavailable just now, so the wallet still needs funding.';

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
const EXPERIENCE_STORAGE_KEY = 'passport-experience';
const WALLET_MODE_STORAGE_KEY = 'passport-wallet-mode';

/**
 * LEGACY account identifier for the passkey-only Passport.
 *
 * The Dynamic route takes its subject from the hosted account. The passkey
 * route has no such issuer, so it originally used this one fixed identifier —
 * one local Passport per browser. Since 2026/08/05 local profiles are keyed
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
 * Which experience this launch opens in. Mobile unless the user has explicitly
 * chosen classic, in which case that choice survives reloads.
 *
 * `?demoMode=local` is the ONE launch that overrides the stored choice, and the
 * reason is a bug it used to cause. Until the passkey wallet could deploy the
 * account-custody contract, the ONLY route to a deployed contract was the
 * classic desktop dashboard: `deployPassport` refuses without a Dynamic
 * `user` and `midnightWallet`, its entry point renders only in the classic
 * branch, and every adapter in `src/localC1.ts` demands a Dynamic
 * `MidnightWallet` plus `?demoMode=local`. So a demo operator had to click
 * through to classic — which pins `passport-experience=classic` in localStorage
 * (see the effect below) — and from then on EVERY `?demoMode=local` launch
 * opened the desktop site instead of the PWA. That is the behaviour reported as
 * "the version with the deployed contract works only with ?demoMode=local but
 * that does not render the PWA".
 *
 * The contract flow now lives on Home, on the passkey wallet, on whatever
 * network that wallet signs on — so `demoMode=local` is nothing more than the
 * localnet flavour of the mobile flow and must land there like any other launch.
 * Clearing the stale pin (rather than merely ignoring it) means a subsequent
 * launch without the flag is not surprised back into classic either. The classic
 * view stays reachable through its own explicit entry point: the "Full
 * dashboard" link in the onboarding footer.
 *
 * ONCE PER TAB, though, and that is what the session marker is for. The flag
 * is carried by RELOADS, not only by the operator's first click:
 *
 *   - `pwa.tsx` reloads on the service worker's `controllerchange` when a new
 *     build takes over, and
 *   - the portal's "Retry Dynamic" control reloads when
 *     `dynamicInitializationBlocked` is set.
 *
 * Both keep the query string. Clearing the pin on EVERY such launch meant an
 * operator who had deliberately opened the classic dashboard — which re-pins
 * `passport-experience=classic` — was thrown back to the PWA by the next
 * service-worker update or Dynamic retry, losing the localnet session they
 * were mid-way through. So the flag forces mobile on the launch that first
 * sees it in this tab and marks that it did; a later reload carrying the same
 * flag finds the marker and respects whatever the pin now says.
 */
const MOBILE_FORCED_SESSION_KEY = 'passport-demo-mobile-forced';

function storedExperience(): Experience {
  try {
    if (
      new URLSearchParams(window.location.search).get('demoMode') === 'local' &&
      window.sessionStorage.getItem(MOBILE_FORCED_SESSION_KEY) === null
    ) {
      window.sessionStorage.setItem(MOBILE_FORCED_SESSION_KEY, '1');
      window.localStorage.removeItem(EXPERIENCE_STORAGE_KEY);
      return 'mobile';
    }
    return window.localStorage.getItem(EXPERIENCE_STORAGE_KEY) === 'classic' ? 'classic' : 'mobile';
  } catch {
    // Private browsing can deny localStorage entirely; the mobile default stands.
    return 'mobile';
  }
}

function storedWalletMode(): WalletMode | null {
  try {
    const value = window.localStorage.getItem(WALLET_MODE_STORAGE_KEY);
    return value === 'local' || value === 'dynamic' ? value : null;
  } catch {
    // See storedExperience. The choice simply will not survive a reload.
    return null;
  }
}

/**
 * Reads a human-scale formatted amount. Both the DUST balance and its cap come
 * from `getFormattedBalances()`, so group separators are the only noise to
 * strip — no Specks conversion belongs here.
 */
function parseFormattedAmount(value: string | null): number | null {
  if (value === null) return null;
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** DUST charge as a 0-100 percentage, or null when either side is unknown. */
function dustFillPercentFrom(balance: string | null, cap: string | null): number | null {
  const heldValue = parseFormattedAmount(balance);
  const capValue = parseFormattedAmount(cap);
  if (heldValue === null || capValue === null || capValue <= 0) return null;
  return Math.max(0, Math.min(100, (heldValue / capValue) * 100));
}

/**
 * The addresses of a freshly opened local wallet, before its first balance
 * read. Deliberately mirrors `initialDynamicSurfaceState`: every balance is
 * `null` — unknown — and never a fabricated zero.
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function positiveAtomicAmount(value: string, label: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive atomic amount.`);
  }
  return BigInt(value);
}

function subjectFor(wallet: MidnightWallet | null, user: unknown): string {
  const profile = user as { userId?: string; id?: string; email?: string } | null;
  return profile?.userId ?? profile?.id ?? wallet?.id ?? wallet?.address ?? 'passport-preview-user';
}

function connectorKey(wallet: MidnightWallet): string | null {
  return (wallet.connector as unknown as { overrideKey?: string }).overrideKey ?? null;
}

function labelForUser(user: unknown): string {
  const profile = user as { email?: string; alias?: string; username?: string } | null;
  return profile?.alias ?? profile?.username ?? profile?.email?.split('@')[0] ?? 'Passport account';
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp),
  );
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

/**
 * A recipient must belong to the SAME network the open wallet signs on. An
 * `mn_addr_preview…` handed to a pre-production wallet is not a typo the node
 * will forgive — the transaction would be built against a chain that address
 * does not exist on — so it is refused here, by name, before anything is
 * signed.
 */
function validateRecipientOnNetwork(
  address: string,
  pool: TransferPool,
  networkId: string,
): void {
  const parsed = MidnightBech32m.parse(address);
  // A mainnet address carries no network segment at all, so the codec reports
  // it as the `mainnet` symbol rather than a string. Normalise before
  // comparing, or every mainnet address would read as a mismatch.
  const parsedNetwork = parsed.network === mainnet ? 'mainnet' : parsed.network;
  if (parsedNetwork !== networkId) {
    throw new Error(`Recipient must be a Midnight ${networkId} address.`);
  }
  parsed.decode(pool === 'shielded' ? ShieldedAddress : UnshieldedAddress, parsed.network);
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

function AssetTile({
  label,
  value,
  detail,
  icon,
  syncing = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  syncing?: boolean;
}) {
  return (
    <article className={`asset-tile ${syncing ? 'is-syncing' : ''}`}>
      <span className="asset-icon">{icon}</span>
      <div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>
    </article>
  );
}

function AddressSurface({
  kind,
  label,
  address,
  detail,
  pending,
}: {
  kind: AddressKind;
  label: string;
  address: string | null;
  detail: string;
  pending: boolean;
}) {
  const addressText = address ? compactAddress(address) : pending ? 'Deriving address...' : 'Not returned by wallet';
  return (
    <article className={`address-surface ${address ? 'is-ready' : 'is-pending'}`}>
      <AddressMark kind={kind} />
      <div className="address-surface-copy"><p>{label}</p><code>{addressText}</code><small>{address ? detail : pending ? 'Loading from your Midnight wallet' : 'Refresh to request this surface again'}</small></div>
    </article>
  );
}

function AddressMark({ kind, size = 19 }: { kind: AddressKind; size?: number }) {
  if (kind === 'unshielded') {
    return <span className="address-surface-icon address-mark-midnight"><img src="/midnight-symbol.svg" alt="" /></span>;
  }
  return <span className={`address-surface-icon address-mark-${kind}`}>{kind === 'shielded' ? <LockKeyhole size={size} /> : <Sparkles size={size} />}</span>;
}

function ActionHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="action-help">
      <button type="button" className="action-help-toggle" aria-label={label} aria-expanded={open} onClick={() => setOpen((visible) => !visible)}>
        <CircleHelp size={16} />
      </button>
      {open && <span className="action-help-popover" role="status">{children}</span>}
    </span>
  );
}

function ActivationStep({
  number,
  label,
  detail,
  state,
}: {
  number: string;
  label: string;
  detail: string;
  state: ActivationState;
}) {
  return (
    <div className={`activation-step is-${state}`}>
      <span className="activation-number">{state === 'complete' ? <Check size={14} /> : number}</span>
      <span className="activation-copy"><strong>{label}</strong><small>{detail}</small></span>
      <i aria-hidden="true" />
    </div>
  );
}

interface AddressChoice {
  kind: AddressKind;
  label: string;
  address: string | null;
  detail: string;
}

function AddressPickerModal({ choices, onClose }: { choices: AddressChoice[]; onClose: () => void }) {
  const [copied, setCopied] = useState<AddressKind | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyAddress = async (choice: AddressChoice) => {
    if (!choice.address) return;
    try {
      await copyText(choice.address);
      setCopied(choice.kind);
      setCopyError(null);
    } catch {
      setCopyError('Copy is unavailable in this browser. Select the full address above and copy it manually.');
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal address-picker-modal" role="dialog" aria-modal="true" aria-label="Copy a Midnight address" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Address book</p><h2>Copy an address.</h2></div><IconButton label="Close address picker" onClick={onClose}><X size={16} /></IconButton></div>
        <p className="address-picker-intro">Choose the surface you need. Each one belongs to the same Midnight wallet, but serves a distinct purpose.</p>
        <div className="address-choice-list">
          {choices.map((choice) => (
            <button key={choice.kind} className="address-choice" disabled={!choice.address} onClick={() => void copyAddress(choice)}>
              <AddressMark kind={choice.kind} />
              <span className="address-choice-copy"><strong>{choice.label}</strong><small>{choice.detail}</small><code>{choice.address ?? 'Not returned by wallet'}</code></span>
              <span className="address-choice-action">{copied === choice.kind ? 'Copied' : 'Copy'} <Copy size={15} /></span>
            </button>
          ))}
        </div>
        {copyError && <p className="address-copy-error" role="status">{copyError}</p>}
      </div>
    </div>
  );
}

function PassportSetupModal({
  localMode,
  onContinue,
  onClose,
}: {
  localMode: boolean;
  onContinue: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal passport-setup-modal" role="dialog" aria-modal="true" aria-label="Set up Passport before deployment" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Passport setup</p><h2>One key, then deploy.</h2></div><IconButton label="Close Passport setup" onClick={onClose}><X size={16} /></IconButton></div>
        <p className="passport-setup-intro">Passport needs one private device witness to operate the C1 contract after deployment. It is encrypted locally with a browser passkey before the deployment transaction is built.</p>
        <ol className="passport-setup-steps">
          <li><span>01</span><div><strong>Save a Passport key</strong><small>Your browser or device passkey manager will ask you to create and confirm this key. It protects encrypted Passport state; it is not a Dynamic wallet key.</small></div></li>
          <li><span>02</span><div><strong>Request C1 deployment</strong><small>{localMode ? 'The disposable localnet fee wallet proves and submits the real account-custody contract. Dynamic remains the login and wallet-surface provider.' : 'The preview path requires Dynamic to prove and finalize the Compact transaction before Passport can submit it.'}</small></div></li>
        </ol>
        <p className="passport-setup-note">Without the Passport key, the deployed C1 would not have a safe private-state unlock path. No wallet seed or Dynamic private key is stored by Passport.</p>
        <div className="passport-setup-actions"><button className="modal-copy" onClick={onContinue}><Fingerprint size={16} /> Set up &amp; deploy Passport</button><button className="modal-secondary" onClick={onClose}>Not now</button></div>
      </div>
    </div>
  );
}

export default function PassportDemo() {
  const { handleLogOut, primaryWallet, sdkHasLoaded, setShowAuthFlow, showAuthFlow, user } = useDynamicContext();
  const connectedWallets = useUserWallets();
  const allWallets = useMemo(() => {
    const candidates = primaryWallet ? [primaryWallet, ...connectedWallets] : connectedWallets;
    return candidates.filter((wallet, index) => candidates.findIndex((candidate) => candidate.id === wallet.id) === index);
  }, [connectedWallets, primaryWallet]);
  const wallet = useMemo(() => {
    const midnightWallets = allWallets.filter((candidate) => isMidnightWallet(candidate)) as MidnightWallet[];
    return midnightWallets.find((candidate) => connectorKey(candidate) === 'dynamicwaas') ?? midnightWallets[0];
  }, [allWallets]);
  const midnightWallet = wallet ?? null;
  const localMode = useMemo(localPassportMode, []);
  const profileClientUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.port = '5176';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  }, []);
  const [walletMode, setWalletMode] = useState<WalletMode | null>(storedWalletMode);
  // Selected network context: filters the app registry. The demo wallet runs
  // on the ONE network this build was configured for, and the UI says so
  // rather than pretending balances exist elsewhere. The initial selection
  // follows that same configuration (see lib/networks.ts).
  const [selectedNetwork, setSelectedNetwork] = useState<PassportNetwork>(loadStoredNetwork);
  useEffect(() => {
    storeNetwork(selectedNetwork);
  }, [selectedNetwork]);
  // The passkey route owns its own subject, so the encrypted state it writes is
  // never confused with a Dynamic account's.
  const subjectId = walletMode === 'local' ? LOCAL_ACCOUNT_ID : subjectFor(midnightWallet, user);
  const scope = useMemo(() => ({ appId: APP_ID, accountId: subjectId }), [subjectId]);
  const [profile, setProfile] = useState<DemoPassportProfile | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('idle');
  const [surfaces, setSurfaces] = useState<DynamicSurfaceState | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [walletSyncing, setWalletSyncing] = useState(false);
  const [dustRetryCount, setDustRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transferPool, setTransferPool] = useState<TransferPool>('unshielded');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedTx, setSelectedTx] = useState<ActivityEntry | null>(null);
  const [dynamicInitializationBlocked, setDynamicInitializationBlocked] = useState(false);
  const [portalVisible, setPortalVisible] = useState(true);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('assets');
  const [showTransfer, setShowTransfer] = useState(false);
  const [showAddressPicker, setShowAddressPicker] = useState(false);
  const [showPassportSetup, setShowPassportSetup] = useState(false);
  const [transferReview, setTransferReview] = useState<TransferReview | null>(null);
  const [deploymentPhase, setDeploymentPhase] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<DisplayPermission[]>([]);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [permissionLabel, setPermissionLabel] = useState('Connected app');
  const [permissionCap, setPermissionCap] = useState('1000000');
  const [custody, setCustody] = useState<LocalPassportCustody | null>(null);
  const [nightCustodyAmount, setNightCustodyAmount] = useState('1000');
  const [shieldedCustodyAmount, setShieldedCustodyAmount] = useState('500');
  const [experience, setExperience] = useState<Experience>(storedExperience);
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
    'browser' | 'http' | null
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
   * Whether the demo sponsor has really told us it can pay this registration's
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
  // Submission identifier whose inclusion poll is currently running, shared
  // between the inline deploy flow and the resume effect below so a reload
  // mid-poll neither double-polls nor strands the profile at 'submitted'.
  const confirmingSubmission = useRef<string | null>(null);
  const onboardingRunning = useRef(false);
  const authFlowWasOpen = useRef(false);
  const transactionsRequest = useRef(0);
  // The live handle is held in a ref, not in state: it is an object with a
  // socket behind it, and every consumer wants the current one rather than a
  // render-scoped snapshot.
  const localWalletRef = useRef<LocalMidnightWallet | null>(null);

  const addActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'createdAt'>) => {
    const value = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setActivity((current) => [value, ...current].slice(0, 10));
    return value;
  }, []);

  const updateActivity = useCallback((id: string, patch: Partial<Omit<ActivityEntry, 'id' | 'createdAt'>>) => {
    setActivity((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  const refreshWallet = useCallback(async () => {
    if (!midnightWallet) return;
    setWalletSyncing(true);
    setDustRetryCount(0);
    setError(null);
    const snapshot = initialDynamicSurfaceState(midnightWallet);
    setSurfaces(snapshot);
    const [addressResult, balances] = await Promise.all([
      refreshDynamicAddresses(midnightWallet).then(
        (value) => ({ value, error: null }),
        (cause) => ({ value: null, error: cause instanceof Error ? cause.message : String(cause) }),
      ),
      refreshDynamicBalances(midnightWallet),
    ]);
    if (addressResult.value) {
      setSurfaces((current) => ({ ...(current ?? snapshot), ...addressResult.value }));
    }
    setSurfaces((current) => ({ ...(current ?? snapshot), ...balances }));
    if (addressResult.error) {
      setError(`Some Midnight addresses could not be refreshed: ${addressResult.error}`);
    }
    setWalletSyncing(false);
  }, [midnightWallet]);

  useEffect(() => {
    // In passkey mode the local route owns `profile` and `profileStatus`
    // outright. Letting this effect run would clear the profile it has just
    // written, because there is no Dynamic wallet to key off.
    if (walletMode === 'local') return;
    if (!midnightWallet) {
      setSurfaces(null);
      setProfile(null);
      setProfileStatus('idle');
      setDustRetryCount(0);
      setPermissions([]);
      setPermissionsLoaded(false);
      setCustody(null);
      return;
    }
    let current = true;
    setProfile(null);
    setProfileStatus('loading');
    setPermissions([]);
    setPermissionsLoaded(false);
    setCustody(null);
    void refreshWallet();
    void loadDemoProfile(subjectId).then((storedProfile) => {
      if (!current) return;
      setProfile(storedProfile);
      setProfileStatus(storedProfile ? 'ready' : 'missing');
    }).catch((cause) => {
      if (!current) return;
      setProfileStatus('error');
      setError(`Passport profile could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return () => {
      current = false;
    };
  }, [midnightWallet, refreshWallet, subjectId, walletMode]);

  useEffect(() => {
    if (!midnightWallet || !surfaces?.dustSyncing || dustRetryCount >= 3) return;
    const timer = window.setTimeout(() => {
      void refreshDynamicBalances(midnightWallet).then((balances) => {
        setSurfaces((current) => ({ ...(current ?? initialDynamicSurfaceState(midnightWallet)), ...balances }));
        setDustRetryCount((current) => current + 1);
      });
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [dustRetryCount, midnightWallet, surfaces?.dustSyncing]);

  useEffect(() => {
    if (sdkHasLoaded) {
      setDynamicInitializationBlocked(false);
      return;
    }
    const timer = window.setTimeout(() => setDynamicInitializationBlocked(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [sdkHasLoaded]);

  useEffect(() => {
    if (!user) {
      setPortalVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setPortalVisible(false), 720);
    return () => window.clearTimeout(timer);
  }, [user]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIENCE_STORAGE_KEY, experience);
    } catch {
      // The chosen experience simply will not survive a reload here.
    }
  }, [experience]);

  // The chosen wallet source survives a reload; signing out clears it.
  useEffect(() => {
    try {
      if (walletMode) window.localStorage.setItem(WALLET_MODE_STORAGE_KEY, walletMode);
      else window.localStorage.removeItem(WALLET_MODE_STORAGE_KEY);
    } catch {
      // See the experience effect above.
    }
  }, [walletMode]);

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
   * transaction lookup.
   *
   * `LocalWalletSurfaces` is field-for-field `DynamicSurfaceState` (see the
   * note at the top of `lib/localWallet.ts`), so neither side is reshaped and
   * the loading / ready / partial / unavailable semantics — including the
   * distinction between a real `'0'` and an unknown `null` — carry across
   * unchanged.
   */
  const activeSurfaces: DynamicSurfaceState | null =
    walletMode === 'local' ? localSurfaces : surfaces;

  const unshieldedAddress = activeSurfaces?.unshieldedAddress ?? midnightWallet?.address ?? null;

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
    if (experience !== 'mobile' || !unshieldedAddress) return;
    void refreshTransactions();
  }, [experience, refreshTransactions, unshieldedAddress]);

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

  const createPassportKey = async (keepUnlocked = false): Promise<{ profile: DemoPassportProfile; state: PassportDemoState }> => {
    if (!user || !midnightWallet) {
      throw new Error('Sign in and wait for a Midnight embedded wallet before creating a Passport key.');
    }
    if (profileStatus === 'loading') throw new Error('Passport is still checking this browser. Wait a moment and try again.');
    const existingProfile = profile ?? await loadDemoProfile(subjectId);
    if (existingProfile) {
      setProfile(existingProfile);
      setProfileStatus('ready');
      throw new Error('This Passport already has a primary Passport key in this browser.');
    }
    const passkey = await WebAuthnPrfKeyProvider.enroll({
      label: 'Midnight Passport',
      userId: subjectId,
    });
    const nextProfile: DemoPassportProfile = {
      subjectId,
      passkey,
      createdAt: new Date().toISOString(),
    };
    const state: PassportDemoState = {
      deviceSecret: newDeviceSecret(),
      recoverySecret: newDeviceSecret(),
      createdAt: new Date().toISOString(),
      schema: 4,
    };
    try {
      await vault(passkey).save<PassportDemoState>(scope, state);
      await saveDemoProfile(nextProfile);
      await requestPassportStoragePersistence();
      setProfile(nextProfile);
      setProfileStatus('ready');
      return { profile: nextProfile, state };
    } finally {
      if (!keepUnlocked) passportKeyProviders.current.get(passkey.credentialId)?.lock(scope);
    }
  };

  const enrollPassport = async () => {
    setBusyAction('passport-key');
    setError(null);
    try {
      await createPassportKey();
      addActivity({ label: 'Passport key enrolled', detail: 'Private state encrypted in this browser.', status: 'complete', source: 'local' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Passport key', detail: message, status: 'error', source: 'local' });
    } finally {
      setBusyAction(null);
    }
  };

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

  const unlockPassport = async () => {
    if (!profile) return;
    setBusyAction('passport-unlock');
    setError(null);
    try {
      await loadPassportState(profile);
      addActivity({ label: 'Passport key unlocked', detail: 'Passkey authorization completed locally.', status: 'complete', source: 'local' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Passport unlock', detail: message, status: 'error', source: 'local' });
    } finally {
      passportKeyProviders.current.get(profile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Passkey-only wallet                                                     */
  /*                                                                          */
  /* Nothing below this banner touches Dynamic. The passkey is enrolled or    */
  /* asserted, its PRF output is turned into a 32-byte Midnight seed, and the */
  /* wallet is built in this tab by lib/localWallet.ts.                       */
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

  const refreshLocalBalances = useCallback(async () => {
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
  }, []);

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
      setWalletMode('local');
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
          setProfileStatus('ready');
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
      setProfileStatus('ready');
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
    setProfileStatus('ready');
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
      setProfileStatus('ready');
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
      setProfileStatus('ready');
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
    setWalletMode('local');
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
        detail: 'On-device Midnight wallet derived from this passkey. Dynamic was not involved.',
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
    setWalletMode('local');
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
      return;
    }
    const handle = localWalletRef.current;
    if (!handle) return;
    let wasSynced = false;
    const unsubscribe = handle.subscribeSyncProgress((progress) => {
      setLocalSyncPercent(progress.percent);
      if (progress.synced && !wasSynced) {
        wasSynced = true;
        pushToast({ tone: 'success', title: 'Wallet synced' });
        void refreshLocalBalances();
      }
    });
    return () => {
      unsubscribe();
      setLocalSyncPercent(null);
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

    const apply = (balances: LocalWalletBalances) => {
      // A stale handle's stream must never write over a newer wallet's numbers.
      if (localWalletRef.current !== handle) return;
      setLocalSurfaces((current) =>
        current ? { ...current, ...balances } : current,
      );
    };

    const unsubscribe = handle.subscribeBalances((balances) => {
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
  }, [localWalletStatus]);

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
        { AliasClaimError, checkAliasAvailability, checkAliasClaimFunds, claimAlias },
        { deployPassportContract },
        { deriveWalletSeed },
      ] = await Promise.all([
        import('./identity/midnames.js'),
        import('./identity/passportContract.js'),
        import('./lib/localWallet.js'),
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
      const funds = await checkAliasClaimFunds(handle, alias);
      if (!funds.ok) throw new AliasClaimError('insufficient-night', funds.reason);

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
           us — never to a value assembled from anything else. */
        const claimed = await claimAlias(
          handle,
          ownerSecret,
          alias,
          { kind: 'contract', contractAddress },
          (progress) => onPhase(progress.phase),
        );

        /* (5) Attach the account to the passkey, so a device that has never
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
    [addActivity, deployPassportContractOnce, rememberAccountOnPasskey],
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
           honest insufficient-funds message. */
        const shortfall = FUNDER_URL ? await claimNightShortfall(alias) : null;
        if (shortfall !== null) {
          setClaimPhase('activating');
          try {
            await activateWalletViaFunder(shortfall);
          } finally {
            setClaimPhase(null);
          }
        }
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
      // (2) Funds, before any passkey prompt. With a funder configured, a
      // NIGHT shortfall earns one automatic activation attempt before the
      // record goes honestly back in the queue — and the re-check afterwards
      // is the same gate run again, never an assumption that the drip landed.
      let funds = await checkAliasClaimFunds(handle, record.alias);
      if (!funds.ok) {
        const shortfall = FUNDER_URL ? await claimNightShortfall(record.alias) : null;
        const activated = shortfall !== null && (await activateWalletViaFunder(shortfall));
        if (activated) funds = await checkAliasClaimFunds(handle, record.alias);
        if (!funds.ok) {
          requeue(
            shortfall !== null && !activated
              ? `${funds.reason} ${FUNDER_UNAVAILABLE_SENTENCE}`
              : funds.reason,
          );
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
   * This is the mobile counterpart to `deployPassport`, and deliberately shares
   * none of its machinery: that path takes a Dynamic `MidnightWallet`, needs a
   * Dynamic session, and — through `src/localC1.ts` — refuses to run unless the
   * launch carries `?demoMode=local`. None of that is available or wanted here.
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
   * Decides once per session whether the name step runs.
   *
   * Three conditions, all of which must hold, and the first is the fix for the
   * reported reset: ONLY a Passport this session just created is walked
   * through the step. A sign-in, and a reload that silently restores a live
   * session, go straight to the dashboard — they used to land on "STEP 2 OF 3"
   * because the ref below is reset by every mount and a skipped name leaves no
   * alias record to find. The stored resolution (A4) is the durable half:
   * it survives sign-out, so a name once claimed or once declined is never
   * asked for again on this device.
   */
  useEffect(() => {
    if (localWalletStatus !== 'ready' || !localSurfaces || !profile) return;
    if (identityStepResolved.current) return;
    identityStepResolved.current = true;
    if (!identityStepArmed.current) return;
    identityStepArmed.current = false;
    if (loadAliasRecords()[selectedNetwork]) return;
    if (storedNameStep(profile.passkey.credentialId)) return;
    setIdentityStep('alias');
  }, [localSurfaces, localWalletStatus, profile, selectedNetwork]);

  // A dismissed Dynamic sign-in window must not strand the onboarding screen in
  // its working stage. The short grace period lets a successful sign-in settle
  // before the intent is abandoned.
  useEffect(() => {
    if (showAuthFlow) {
      authFlowWasOpen.current = true;
      return;
    }
    if (!authFlowWasOpen.current || onboardingIntent !== 'dynamic' || user) return;
    const timer = window.setTimeout(() => {
      authFlowWasOpen.current = false;
      setOnboardingIntent(null);
      setOnboardingBusyLabel(null);
      setOnboardingError('Sign-in was not completed. Choose how you would like to continue.');
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [onboardingIntent, showAuthFlow, user]);

  // Sequences the Dynamic onboarding intent behind Dynamic authentication: the
  // passkey ceremony can only start once a user and an embedded Midnight wallet
  // exist and the stored-profile lookup has settled. The ref guard keeps a
  // single ceremony in flight while React re-runs this effect. The two passkey
  // routes never reach here — they run straight from their click handler.
  // Resume inclusion confirmation for a deploy left at 'submitted' — a
  // reload or a lapsed poll window otherwise strands the profile holding the
  // submission identifier with nothing ever completing it.
  useEffect(() => {
    const contract = profile?.passportContract;
    if (!contract || contract.status !== 'submitted') return;
    if (contract.network !== PASSPORT_C1_NETWORK) return;
    const identifier = contract.txHash;
    if (!identifier || confirmingSubmission.current === identifier) return;
    confirmingSubmission.current = identifier;
    const resumedProfile = profile;
    void (async () => {
      try {
        const confirmation = await confirmDynamicSubmission(identifier);
        if (confirmation.applyStatus === 'FAILURE') {
          const failedProfile: DemoPassportProfile = { ...resumedProfile, passportContract: undefined };
          await saveDemoProfile(failedProfile);
          setProfile(failedProfile);
          setError(`Midnight included transaction ${confirmation.txHash} but applied it as FAILURE; the Passport contract was not created.`);
          return;
        }
        const confirmedProfile: DemoPassportProfile = {
          ...resumedProfile,
          passportContract: { ...contract, txHash: confirmation.txHash, status: 'confirmed' },
        };
        await saveDemoProfile(confirmedProfile);
        setProfile(confirmedProfile);
        addActivity({
          label: 'Passport C1 deployed',
          detail: `${compactAddress(confirmation.deployAddress ?? contract.address)} is live on Midnight preview.`,
          status: 'complete',
          source: 'chain',
          txHash: confirmation.txHash,
        });
      } catch (cause) {
        // Pending or unreachable: stay honestly at 'submitted'; the guard is
        // released so a later profile change or reload polls again.
        confirmingSubmission.current = null;
        if (!(cause instanceof DynamicSubmissionPendingError)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
  }, [profile, addActivity]);

  useEffect(() => {
    if (onboardingIntent !== 'dynamic' || onboardingRunning.current) return;
    if (!user || !midnightWallet) return;
    if (profileStatus === 'loading' || profileStatus === 'idle') return;
    onboardingRunning.current = true;
    void (async () => {
      try {
        // One "Continue with Dynamic" button covers both cases, so the stored
        // profile decides: unlock an existing Passport key, or enrol one.
        const activeProfile = profile ?? (await loadDemoProfile(subjectId));
        if (activeProfile) {
          setOnboardingBusyLabel('Unlocking your Passport with this device');
          try {
            await loadPassportState(activeProfile);
          } finally {
            passportKeyProviders.current.get(activeProfile.passkey.credentialId)?.lock(scope);
          }
          setProfile(activeProfile);
          setProfileStatus('ready');
          addActivity({
            label: 'Passport key unlocked',
            detail: 'Passkey authorization completed locally.',
            status: 'complete',
            source: 'local',
          });
        } else {
          setOnboardingBusyLabel('Creating your Passport passkey');
          await createPassportKey();
          addActivity({
            label: 'Passport key enrolled',
            detail: 'Private state encrypted in this browser.',
            status: 'complete',
            source: 'local',
          });
        }
        setOnboardingError(null);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setOnboardingError(message);
        addActivity({
          label: 'Passport key',
          detail: message,
          status: 'error',
          source: 'local',
        });
      } finally {
        setOnboardingIntent(null);
        setOnboardingBusyLabel(null);
        onboardingRunning.current = false;
      }
    })();
  }, [
    addActivity,
    createPassportKey,
    loadPassportState,
    midnightWallet,
    onboardingIntent,
    profile,
    profileStatus,
    scope,
    subjectId,
    user,
  ]);

  const resetLocalPassport = async () => {
    if (!profile || profile.passportContract) {
      setError('A submitted Passport cannot be reset locally. Restore its original private state or use the future recovery flow.');
      return;
    }
    if (!window.confirm('Reset this unfinished local Passport setup? This removes its encrypted device state from this browser.')) return;
    setBusyAction('passport-key');
    setError(null);
    try {
      await vault(profile.passkey).remove(scope);
      await deleteDemoProfile(subjectId);
      passportKeyProviders.current.get(profile.passkey.credentialId)?.lock(scope);
      passportKeyProviders.current.delete(profile.passkey.credentialId);
      setProfile(null);
      setProfileStatus('missing');
      addActivity({ label: 'Local Passport reset', detail: 'Unfinished encrypted state was removed from this browser.', status: 'complete', source: 'local' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Local Passport reset', detail: message, status: 'error', source: 'local' });
    } finally {
      setBusyAction(null);
    }
  };

  const signMessage = async () => {
    if (!midnightWallet) return;
    setBusyAction('message');
    setError(null);
    try {
      await midnightWallet.signMessage(`Midnight Passport verification\nAccount: ${midnightWallet.address}`);
      addActivity({ label: 'Message signed', detail: 'The Midnight wallet approved this verification.', status: 'complete', source: 'wallet' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Message signing', detail: message, status: 'error', source: 'wallet' });
    } finally {
      setBusyAction(null);
    }
  };

  /**
   * DUST registration for the CLASSIC Dynamic-hosted view only. The passkey
   * wallet's own registration path was removed in the wallet-core review —
   * fees on the demo networks are sponsored, so registering a user's NIGHT was
   * a step that bought them nothing. This handler is reached only from the
   * classic workspace, which is legacy and outside the demo flow.
   */
  const registerDust = async () => {
    if (!midnightWallet) return;
    setBusyAction('dust');
    setError(null);
    try {
      const result = await midnightWallet.registerDust();
      addActivity({
        label: 'DUST registration',
        detail: result.message,
        status: result.status === 'no_utxos' ? 'blocked' : 'complete',
        source: result.txId ? 'chain' : 'wallet',
        txHash: result.txId,
      });
      if (result.status !== 'no_utxos') {
        pushToast({
          tone: 'success',
          title: 'DUST registration submitted',
          link: explorerTxLink(result.txId, selectedNetwork),
        });
      }
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'DUST registration', detail: message, status: 'error', source: 'wallet' });
    } finally {
      setBusyAction(null);
    }
  };

  const reviewTransfer = () => {
    if (!midnightWallet) return;
    // The Dynamic wallet's own address names the network it is on — never this
    // build's configured one, which the hosted wallet knows nothing about.
    const parsedWalletNetwork = MidnightBech32m.parse(midnightWallet.address).network;
    const transferNetworkId = parsedWalletNetwork === mainnet ? 'mainnet' : parsedWalletNetwork;
    if (!recipient.trim() || !amount.trim()) {
      setError('Enter a recipient and an atomic token amount.');
      return;
    }
    if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
      setError('The atomic amount must be a positive whole number.');
      return;
    }
    try {
      validateRecipientOnNetwork(recipient.trim(), transferPool, transferNetworkId);
    } catch (cause) {
      setError(`Enter a valid ${transferPool} Midnight ${transferNetworkId} address: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    setError(null);
    setTransferReview({ pool: transferPool, recipient: recipient.trim(), amount: amount.trim() });
  };

  const submitTransfer = async () => {
    if (!midnightWallet || !transferReview) return;
    setBusyAction('transfer');
    setError(null);
    const labelPrefix = transferReview.pool === 'shielded' ? 'Shielded' : 'Unshielded';
    const activityEntry = addActivity({
      label: `Reviewing ${transferReview.pool} transfer`,
      detail: `${transferReview.amount} atomic NIGHT to ${compactAddress(transferReview.recipient)}`,
      status: 'pending',
      source: 'wallet',
    });
    try {
      const draft = await midnightWallet.createTransferTransaction({
        transfers: [{ type: transferReview.pool, recipientAddress: transferReview.recipient, amount: transferReview.amount }],
      });
      updateActivity(activityEntry.id, {
        label: `${labelPrefix} transfer prepared`,
        detail: 'Dynamic built the wallet-native transfer draft.',
        status: 'pending',
        source: 'wallet',
      });
      const signedTransaction = await signDynamicTransferTransaction(midnightWallet, draft.serializedTransaction);
      updateActivity(activityEntry.id, {
        label: 'Transaction signed and proved',
        detail: 'The embedded wallet completed authorization and proof.',
        status: 'pending',
        source: 'wallet',
      });
      const submitted = await submitDynamicTransferTransaction(midnightWallet, signedTransaction);
      updateActivity(activityEntry.id, {
        label: `${labelPrefix} transfer submitted`,
        detail: `${transferReview.amount} atomic NIGHT to ${compactAddress(transferReview.recipient)}. Awaiting network confirmation.`,
        status: 'pending',
        source: 'chain',
        txHash: submitted.txHash,
      });
      setRecipient('');
      setAmount('');
      setTransferReview(null);
      setShowTransfer(false);
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      updateActivity(activityEntry.id, {
        label: `${labelPrefix} transfer failed`,
        detail: message,
        status: 'error',
        source: 'wallet',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const recoverPending = async () => {
    if (!midnightWallet) return;
    setBusyAction('recovery');
    setError(null);
    try {
      const result = await midnightWallet.revertAllPending();
      addActivity({ label: 'Pending transfer recovery', detail: result.message, status: result.reverted ? 'complete' : 'blocked', source: 'wallet' });
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Pending transfer recovery', detail: message, status: 'error', source: 'wallet' });
    } finally {
      setBusyAction(null);
    }
  };

  const deployPassport = async () => {
    if (!user || !midnightWallet) {
      setError('Sign in and wait for a Midnight embedded wallet before deploying Passport.');
      return;
    }
    setBusyAction('passport-deploy');
    setError(null);
    setDeploymentPhase(profile ? 'Unlocking Passport' : 'Creating Passport key');
    let activeProfileForLock: DemoPassportProfile | null = null;
    try {
      let activeProfile: DemoPassportProfile;
      let privateState: PassportDemoState;
      if (profile) {
        activeProfile = profile;
        activeProfileForLock = activeProfile;
        addActivity({ label: 'Passport unlock requested', detail: 'Approve the browser passkey prompt to continue deployment.', status: 'pending', source: 'local' });
        privateState = await loadPassportState(activeProfile);
      } else {
        addActivity({ label: 'Creating Passport key', detail: 'Use your browser passkey to protect the C1 device state.', status: 'pending', source: 'local' });
        const created = await createPassportKey(true);
        activeProfile = created.profile;
        activeProfileForLock = activeProfile;
        privateState = created.state;
        addActivity({ label: 'Passport key enrolled', detail: 'Primary device state is encrypted in this browser.', status: 'complete', source: 'local' });
      }

      if (localMode) {
        let recoverySecret = privateState.recoverySecret;
        if (!(recoverySecret instanceof Uint8Array) || recoverySecret.byteLength !== 32) {
          recoverySecret = newDeviceSecret();
          privateState = { ...privateState, recoverySecret, schema: 4 };
          await vault(activeProfile.passkey).save<PassportDemoState>(scope, privateState);
        }
        setDeploymentPhase('Deploying localnet C1');
        const localDeployment = await deployLocalPassportContract(
          midnightWallet,
          privateState.deviceSecret,
          recoverySecret,
        );
        const deployedAt = new Date().toISOString();
        const deployedProfile: DemoPassportProfile = {
          ...activeProfile,
          passportPreparation: undefined,
          passportContract: {
            address: localDeployment.address,
            deployedAt,
            txHash: localDeployment.txHash,
            network: LOCAL_C1_NETWORK,
            status: 'confirmed',
            artifact: LOCAL_C1_ARTIFACT,
          },
        };
        // Persist the C1 address before the separate alias transaction. A
        // registry failure must never orphan a successfully deployed account.
        await saveDemoProfile(deployedProfile);
        setProfile(deployedProfile);
        setPermissions([]);
        setPermissionsLoaded(true);
        setCustody({ unshielded: [], shielded: [] });
        addActivity({
          label: 'Passport C1 deployed',
          detail: `${compactAddress(localDeployment.address)} is active on the disposable localnet.`,
          status: 'complete',
          source: 'chain',
          txHash: localDeployment.txHash,
        });

        setDeploymentPhase('Registering Night ID');
        try {
          const identity = await registerLocalPassportIdentity(
            midnightWallet,
            localDeployment.address,
            labelForUser(user),
          );
          const completeProfile: DemoPassportProfile = {
            ...deployedProfile,
            passportContract: {
              ...deployedProfile.passportContract!,
              identityRegistryAddress: identity.identityRegistryAddress,
              identityTxHash: identity.identityTxHash,
              alias: identity.alias,
            },
          };
          await saveDemoProfile(completeProfile);
          setProfile(completeProfile);
          addActivity({
            label: 'Night ID registered',
            detail: `${identity.alias}.night resolves to ${compactAddress(localDeployment.address)}.`,
            status: 'complete',
            source: 'chain',
            txHash:
              identity.identityTxHash === 'already-registered'
                ? undefined
                : identity.identityTxHash,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(`Passport is deployed. Night ID registration is still pending: ${message}`);
          addActivity({
            label: 'Night ID registration',
            detail: message,
            status: 'error',
            source: 'chain',
          });
        }
        return;
      }

      if (dynamicSupportsContractSettlement(midnightWallet)) {
        // Dynamic 4.96.0+ settlement: the embedded wallet balances, pays the
        // DUST fee, MPC-signs, and submits via getWalletProvider(). Any C1
        // draft persisted by the pre-4.96 fail-closed path was never
        // broadcast, so the fresh deployment below simply replaces it.
        const maintenanceSigningKey = privateState.c1?.maintenanceSigningKey ?? createPassportC1MaintenanceSigningKey();
        const coldSyncEntry = addActivity({
          label: 'Dynamic wallet provider requested',
          detail: 'The embedded wallet fully cold-syncs on its first contract settlement — this first call can take over a minute with no visible progress.',
          status: 'pending',
          source: 'wallet',
        });
        const deployment = await deployPassportC1ViaDynamic(
          midnightWallet,
          { deviceSecretHex: bytesToHex(privateState.deviceSecret) },
          maintenanceSigningKey,
          {
            onPhase: (phase) => {
              if (phase === 'connecting-wallet-provider') {
                setDeploymentPhase('Connecting Dynamic wallet — first sync can take over a minute');
              } else {
                updateActivity(coldSyncEntry.id, {
                  label: 'Dynamic wallet provider ready',
                  detail: 'The embedded wallet exposed its contract settlement provider.',
                  status: 'complete',
                });
                setDeploymentPhase('Building, balancing & signing C1');
              }
            },
          },
        );
        updateActivity(coldSyncEntry.id, {
          label: 'Dynamic wallet provider ready',
          detail: 'The embedded wallet exposed its contract settlement provider.',
          status: 'complete',
        });

        const privateC1: PassportC1PrivateRecord = {
          address: deployment.contractAddress,
          privateStateId: deployment.privateStateId,
          maintenanceSigningKey,
          network: PASSPORT_C1_NETWORK,
          artifact: PASSPORT_C1_ARTIFACT,
          preparedAt: new Date().toISOString(),
        };
        await vault(activeProfile.passkey).save<PassportDemoState>(scope, {
          ...privateState,
          schema: 4,
          c1: privateC1,
        });
        addActivity({
          label: 'Passport C1 approved and broadcast',
          detail: `Dynamic approval ${deployment.receipt.approvalSignatureFingerprint.slice(0, 12)}… is bound to the finalized transaction. Submission identifier ${deployment.submissionId.slice(0, 12)}… (not an explorer hash) is awaiting indexer confirmation.`,
          status: 'pending',
          source: 'wallet',
        });

        const deployedAt = new Date().toISOString();
        const submittedProfile: DemoPassportProfile = {
          ...activeProfile,
          passportPreparation: undefined,
          passportContract: {
            address: deployment.contractAddress,
            deployedAt,
            // The submission identifier stands in until the indexer returns
            // the canonical hash below — submitTx does not return a hash.
            txHash: deployment.submissionId,
            network: PASSPORT_C1_NETWORK,
            status: 'submitted',
            artifact: PASSPORT_C1_ARTIFACT,
          },
        };
        await saveDemoProfile(submittedProfile);
        setProfile(submittedProfile);
        activeProfile = submittedProfile;

        setDeploymentPhase('Confirming inclusion on Midnight');
        confirmingSubmission.current = deployment.submissionId;
        try {
          const confirmation = await confirmDynamicSubmission(deployment.submissionId);
          if (confirmation.applyStatus === 'FAILURE') {
            const failedProfile: DemoPassportProfile = { ...submittedProfile, passportContract: undefined };
            await saveDemoProfile(failedProfile);
            setProfile(failedProfile);
            throw new Error(`Midnight included transaction ${confirmation.txHash} but applied it as FAILURE; the Passport contract was not created.`);
          }
          const confirmedProfile: DemoPassportProfile = {
            ...submittedProfile,
            passportContract: {
              ...submittedProfile.passportContract!,
              txHash: confirmation.txHash,
              status: 'confirmed',
            },
          };
          await saveDemoProfile(confirmedProfile);
          setProfile(confirmedProfile);
          addActivity({
            label: 'Passport C1 deployed',
            detail: `${compactAddress(confirmation.deployAddress ?? deployment.contractAddress)} is live on Midnight preview.`,
            status: 'complete',
            source: 'chain',
            txHash: confirmation.txHash,
          });
        } catch (cause) {
          if (!(cause instanceof DynamicSubmissionPendingError)) throw cause;
          // The submission stands; only the inclusion lookup timed out. No
          // mock success: the contract stays 'submitted' until confirmed.
          // Release the guard so the resume effect may poll again later.
          confirmingSubmission.current = null;
          setError(`Passport C1 was submitted, but inclusion is not confirmed yet: ${cause.message}`);
          addActivity({
            label: 'Passport C1 confirmation pending',
            detail: cause.message,
            status: 'pending',
            source: 'chain',
          });
        }
        await refreshWallet();
        return;
      }

      const maintenanceSigningKey = privateState.c1?.maintenanceSigningKey ?? createPassportC1MaintenanceSigningKey();
      let draft: PassportC1DeploymentDraft;
      if (privateState.c1?.serializedTransaction) {
        setDeploymentPhase('Restoring C1 draft');
        draft = {
          artifact: privateState.c1.artifact,
          network: privateState.c1.network,
          contractAddress: privateState.c1.address,
          privateStateId: privateState.c1.privateStateId,
          maintenanceSigningKey: privateState.c1.maintenanceSigningKey,
          serializedTransaction: privateState.c1.serializedTransaction,
        };
      } else {
        setDeploymentPhase('Building C1 contract');
        const initialPrivateState = {
          deviceSecretHex: bytesToHex(privateState.deviceSecret),
        };
        draft = await buildPassportC1Deployment(midnightWallet, initialPrivateState, maintenanceSigningKey);
        if (privateState.c1 && privateState.c1.address !== draft.contractAddress) {
          throw new Error('Stored Passport C1 state does not match the deployment transaction. Reset the unfinished setup before creating another draft.');
        }
      }

      // Persist the maintenance authority before requesting Dynamic proof
      // capability. The same Passport state can rebuild an interrupted draft.
      const privateC1: PassportC1PrivateRecord = {
        address: draft.contractAddress,
        privateStateId: draft.privateStateId,
        maintenanceSigningKey: draft.maintenanceSigningKey,
        network: draft.network,
        artifact: draft.artifact,
        preparedAt: new Date().toISOString(),
        serializedTransaction: draft.serializedTransaction,
      };
      await vault(activeProfile.passkey).save<PassportDemoState>(scope, {
        ...privateState,
        schema: 4,
        c1: privateC1,
      });
      const preparedProfile: DemoPassportProfile = {
        ...activeProfile,
        passportPreparation: {
          address: draft.contractAddress,
          preparedAt: privateC1.preparedAt,
          network: draft.network,
          artifact: draft.artifact,
        },
      };
      await saveDemoProfile(preparedProfile);
      setProfile(preparedProfile);
      activeProfile = preparedProfile;
      addActivity({
        label: 'Passport C1 prepared',
        detail: `Contract ${compactAddress(draft.contractAddress)} built for the Dynamic Compact proof capability.`,
        status: 'pending',
        source: 'local',
      });

      setDeploymentPhase('Checking Dynamic Compact proof support');
      const submitted = await authorizeAndSubmitDynamicCompactTransaction(
        midnightWallet,
        draft.serializedTransaction,
        {
          contractAddress: draft.contractAddress,
          circuit: 'deploy passport_c1',
          summary: 'Deploy the Passport account-management contract',
          arguments: {
            artifact: draft.artifact,
            privateStateId: draft.privateStateId,
          },
        },
      );
      addActivity({
        label: 'Passport C1 approved and broadcast',
        detail: `Dynamic approval ${submitted.approvalSignatureFingerprint.slice(0, 12)}… is bound to the finalized transaction.`,
        status: 'pending',
        source: 'wallet',
        txHash: submitted.txHash,
      });

      const deployedAt = new Date().toISOString();
      const nextProfile: DemoPassportProfile = {
        ...activeProfile,
        passportPreparation: undefined,
        passportContract: {
          address: draft.contractAddress,
          deployedAt,
          txHash: submitted.txHash,
          network: draft.network,
          status: 'submitted',
          artifact: draft.artifact,
        },
      };
      await saveDemoProfile(nextProfile);
      setProfile(nextProfile);
      addActivity({
        label: 'Passport C1 submitted',
        detail: `Deployment submitted for ${compactAddress(draft.contractAddress)}. Awaiting Midnight confirmation.`,
        status: 'pending',
        source: 'chain',
        txHash: submitted.txHash,
      });
      await refreshWallet();
    } catch (cause) {
      const rawMessage = cause instanceof Error ? cause.message : String(cause);
      const message = /timed out/i.test(rawMessage)
        ? `${rawMessage} Your encrypted C1 transaction is safe; press Resume deployment to continue from the last completed stage.`
        : rawMessage;
      setError(message);
      addActivity({ label: 'Passport deployment', detail: message, status: 'error', source: 'wallet' });
    } finally {
      if (activeProfileForLock) {
        passportKeyProviders.current.get(activeProfileForLock.passkey.credentialId)?.lock(scope);
      }
      setBusyAction(null);
      setDeploymentPhase(null);
    }
  };

  const completeLocalIdentityRegistration = async () => {
    if (!user || !midnightWallet || !profile?.passportContract || !localMode) return;
    const activeProfile = profile;
    const activeContract = profile.passportContract;
    setBusyAction('identity-register');
    setError(null);
    try {
      const identity = await registerLocalPassportIdentity(
        midnightWallet,
        activeContract.address,
        labelForUser(user),
      );
      const nextProfile: DemoPassportProfile = {
        ...activeProfile,
        passportContract: {
          ...activeContract,
          identityRegistryAddress: identity.identityRegistryAddress,
          identityTxHash: identity.identityTxHash,
          alias: identity.alias,
        },
      };
      await saveDemoProfile(nextProfile);
      setProfile(nextProfile);
      addActivity({
        label: 'Night ID registered',
        detail: `${identity.alias}.night resolves to ${compactAddress(activeContract.address)}.`,
        status: 'complete',
        source: 'chain',
        txHash:
          identity.identityTxHash === 'already-registered'
            ? undefined
            : identity.identityTxHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Passport remains active, but Night ID registration failed: ${message}`);
      addActivity({
        label: 'Night ID registration',
        detail: message,
        status: 'error',
        source: 'chain',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const localCustodyProfile = (): DemoPassportProfile | null => {
    if (
      !midnightWallet ||
      !profile?.passportContract ||
      !localMode ||
      profile.passportContract.network !== LOCAL_C1_NETWORK ||
      profile.passportContract.status !== 'confirmed'
    ) {
      setError('Deploy a confirmed Passport on the disposable localnet before using C1 custody.');
      return null;
    }
    return profile;
  };

  const refreshPassportCustody = async () => {
    const activeProfile = localCustodyProfile();
    if (!midnightWallet || !activeProfile?.passportContract) return;
    setBusyAction('custody-read');
    setError(null);
    try {
      const next = await loadLocalPassportCustody(
        midnightWallet,
        activeProfile.passportContract.address,
      );
      setCustody(next);
      addActivity({
        label: 'C1 custody loaded',
        detail: `${next.unshielded.length} unshielded and ${next.shielded.length} shielded token types read from the contract ledger.`,
        status: 'complete',
        source: 'chain',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'C1 custody read', detail: message, status: 'error', source: 'chain' });
    } finally {
      setBusyAction(null);
    }
  };

  const depositPassportNight = async () => {
    const activeProfile = localCustodyProfile();
    if (!midnightWallet || !activeProfile?.passportContract) return;
    let depositAmount: bigint;
    try {
      depositAmount = positiveAtomicAmount(nightCustodyAmount, 'NIGHT deposit');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusyAction('custody-night-deposit');
    setError(null);
    try {
      const result = await depositLocalPassportNight(
        midnightWallet,
        activeProfile.passportContract.address,
        depositAmount,
      );
      setCustody(result.custody);
      addActivity({
        label: 'NIGHT deposited into C1',
        detail: `${depositAmount} atomic NIGHT is now held by the Passport custody contract.`,
        status: 'complete',
        source: 'chain',
        txHash: result.txHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (cause instanceof LocalCustodyPendingError) {
        if (cause.custody) setCustody(cause.custody);
        addActivity({
          label: 'C1 NIGHT deposit submitted',
          detail: message,
          status: 'pending',
          source: 'chain',
          txHash: cause.txHash,
        });
      } else {
        addActivity({ label: 'C1 NIGHT deposit', detail: message, status: 'error', source: 'chain' });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const withdrawPassportNight = async () => {
    const activeProfile = localCustodyProfile();
    if (!midnightWallet || !activeProfile?.passportContract) return;
    let withdrawAmount: bigint;
    try {
      withdrawAmount = positiveAtomicAmount(nightCustodyAmount, 'NIGHT withdrawal');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusyAction('custody-night-withdraw');
    setError(null);
    try {
      const privateState = await loadPassportState(activeProfile);
      const result = await withdrawLocalPassportNight(
        midnightWallet,
        activeProfile.passportContract.address,
        privateState.deviceSecret,
        withdrawAmount,
      );
      setCustody(result.custody);
      addActivity({
        label: 'NIGHT withdrawn from C1',
        detail: `${withdrawAmount} atomic NIGHT returned to the disposable localnet wallet.`,
        status: 'complete',
        source: 'chain',
        txHash: result.txHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (cause instanceof LocalCustodyPendingError) {
        if (cause.custody) setCustody(cause.custody);
        addActivity({
          label: 'C1 NIGHT withdrawal submitted',
          detail: message,
          status: 'pending',
          source: 'chain',
          txHash: cause.txHash,
        });
      } else {
        addActivity({ label: 'C1 NIGHT withdrawal', detail: message, status: 'error', source: 'chain' });
      }
    } finally {
      passportKeyProviders.current.get(activeProfile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  const depositPassportShielded = async () => {
    const activeProfile = localCustodyProfile();
    if (!midnightWallet || !activeProfile?.passportContract) return;
    let depositAmount: bigint;
    try {
      depositAmount = positiveAtomicAmount(shieldedCustodyAmount, 'Shielded deposit');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusyAction('custody-shielded-deposit');
    setError(null);
    const pending = addActivity({
      label: 'Shielded C1 deposit',
      detail: 'Minting the local test note, waiting for wallet sync, then depositing the real note.',
      status: 'pending',
      source: 'chain',
    });
    try {
      const result = await mintAndDepositLocalPassportShielded(
        midnightWallet,
        activeProfile.passportContract.address,
        depositAmount,
      );
      setCustody(result.custody);
      updateActivity(pending.id, {
        detail: `${depositAmount} shielded units deposited after mint ${compactAddress(result.mintTxHash)}.`,
        status: 'complete',
        txHash: result.depositTxHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (cause instanceof LocalCustodyPendingError) {
        if (cause.custody) setCustody(cause.custody);
        updateActivity(pending.id, {
          detail: message,
          status: 'pending',
          txHash: cause.txHash,
        });
      } else {
        updateActivity(pending.id, { detail: message, status: 'error' });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const withdrawPassportShielded = async (color: string, available: string) => {
    const activeProfile = localCustodyProfile();
    if (!midnightWallet || !activeProfile?.passportContract) return;
    let withdrawAmount: bigint;
    try {
      withdrawAmount = positiveAtomicAmount(shieldedCustodyAmount, 'Shielded withdrawal');
      if (withdrawAmount > BigInt(available)) {
        throw new Error('The Passport contract does not hold enough shielded value.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusyAction('custody-shielded-withdraw');
    setError(null);
    try {
      const privateState = await loadPassportState(activeProfile);
      const result = await withdrawLocalPassportShielded(
        midnightWallet,
        activeProfile.passportContract.address,
        privateState.deviceSecret,
        color,
        withdrawAmount,
      );
      setCustody(result.custody);
      addActivity({
        label: 'Shielded value withdrawn from C1',
        detail: `${withdrawAmount} shielded units returned to the disposable localnet wallet.`,
        status: 'complete',
        source: 'chain',
        txHash: result.txHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (cause instanceof LocalCustodyPendingError) {
        if (cause.custody) setCustody(cause.custody);
        addActivity({
          label: 'C1 shielded withdrawal submitted',
          detail: message,
          status: 'pending',
          source: 'chain',
          txHash: cause.txHash,
        });
      } else {
        addActivity({ label: 'C1 shielded withdrawal', detail: message, status: 'error', source: 'chain' });
      }
    } finally {
      passportKeyProviders.current.get(activeProfile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  const labelPermissions = (
    records: LocalPassportPermission[],
    privateRecords: PassportPermissionPrivateRecord[] = [],
  ): DisplayPermission[] =>
    records.map((record) => ({
      ...record,
      label:
        privateRecords.find((candidate) => candidate.commitment === record.commitment)?.label ??
        `Grant ${record.commitment.slice(0, 8)}`,
    }));

  const refreshPassportPermissions = async () => {
    if (!midnightWallet || !profile?.passportContract) return;
    if (!localMode || profile.passportContract.network !== LOCAL_C1_NETWORK) {
      setError('Passport permission reads are wired for the disposable localnet only. Dynamic 4.96.0 settles contract transactions via getWalletProvider — the deploy path uses it — but the permission circuits are not routed through it in this demo yet. This path remains disabled instead of simulating a grant.');
      return;
    }
    setBusyAction('permission-read');
    setError(null);
    try {
      const privateState = await loadPassportState(profile);
      const records = await loadLocalPassportPermissions(
        midnightWallet,
        profile.passportContract.address,
        privateState.deviceSecret,
      );
      setPermissions(labelPermissions(records, privateState.permissions));
      setPermissionsLoaded(true);
      addActivity({
        label: 'C1 permissions loaded',
        detail: `${records.filter((record) => record.active).length} active grant${records.filter((record) => record.active).length === 1 ? '' : 's'} read from the account contract.`,
        status: 'complete',
        source: 'chain',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'C1 permission read', detail: message, status: 'error', source: 'chain' });
    } finally {
      passportKeyProviders.current.get(profile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  const addPassportPermission = async () => {
    if (!midnightWallet || !profile?.passportContract) return;
    if (!localMode || profile.passportContract.network !== LOCAL_C1_NETWORK) {
      setError('C1 grant writes are wired for the local validated adapter only; routing them through Dynamic getWalletProvider settlement is not built in this demo yet.');
      return;
    }
    const label = permissionLabel.trim();
    if (!label) {
      setError('Name the app or device that will receive this permission.');
      return;
    }
    if (!/^\d+$/.test(permissionCap) || BigInt(permissionCap) <= 0n) {
      setError('The NIGHT cap must be a positive atomic amount.');
      return;
    }
    setBusyAction('permission-add');
    setError(null);
    let preparedCommitment: string | null = null;
    try {
      const privateState = await loadPassportState(profile);
      const grantSecret = newDeviceSecret();
      preparedCommitment = localPassportGrantCommitment(grantSecret);
      const privateRecord: PassportPermissionPrivateRecord = {
        commitment: preparedCommitment,
        label,
        grantSecret,
        createdAt: new Date().toISOString(),
      };
      const nextPrivateRecords = [
        ...(privateState.permissions ?? []).filter(
          (record) => record.commitment !== preparedCommitment,
        ),
        privateRecord,
      ];
      // Persist the grant authority before its on-chain write. If the browser
      // closes after submission, Passport can still label and use the grant.
      await vault(profile.passkey).save<PassportDemoState>(scope, {
        ...privateState,
        permissions: nextPrivateRecords,
      });
      const result = await addLocalPassportPermission(
        midnightWallet,
        profile.passportContract.address,
        privateState.deviceSecret,
        grantSecret,
        BigInt(permissionCap),
      );
      if (result.commitment !== preparedCommitment) {
        throw new Error('The submitted permission commitment does not match encrypted Passport state.');
      }
      setPermissions(labelPermissions(result.permissions, nextPrivateRecords));
      setPermissionsLoaded(true);
      setPermissionLabel('Connected app');
      addActivity({
        label: 'C1 permission issued',
        detail: `Grant ${compactAddress(preparedCommitment)} is active with a ${permissionCap} atomic NIGHT cap. Its secret remains encrypted in Passport pending a C23 handoff.`,
        status: 'complete',
        source: 'chain',
        txHash: result.txHash,
      });
    } catch (cause) {
      const baseMessage = cause instanceof Error ? cause.message : String(cause);
      const message = preparedCommitment
        ? `${baseMessage} Grant ${compactAddress(preparedCommitment)} remains encrypted locally; read the contract before retrying.`
        : baseMessage;
      setError(message);
      addActivity({ label: 'C1 permission issue', detail: message, status: 'error', source: 'chain' });
    } finally {
      passportKeyProviders.current.get(profile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  const revokePassportPermission = async (permission: DisplayPermission) => {
    if (!midnightWallet || !profile?.passportContract || !permission.active) return;
    if (!localMode || profile.passportContract.network !== LOCAL_C1_NETWORK) return;
    setBusyAction('permission-revoke');
    setError(null);
    try {
      const privateState = await loadPassportState(profile);
      const result = await revokeLocalPassportPermission(
        midnightWallet,
        profile.passportContract.address,
        privateState.deviceSecret,
        permission.commitment,
      );
      setPermissions(labelPermissions(result.permissions, privateState.permissions));
      setPermissionsLoaded(true);
      addActivity({
        label: 'C1 permission revoked',
        detail: `${permission.label}'s grant is revoked and can no longer authorize a custody spend.`,
        status: 'complete',
        source: 'chain',
        txHash: result.txHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'C1 permission revocation', detail: message, status: 'error', source: 'chain' });
    } finally {
      passportKeyProviders.current.get(profile.passkey.credentialId)?.lock(scope);
      setBusyAction(null);
    }
  };

  const requestPassportDeployment = () => {
    if (!midnightWallet || busyAction || (passportIsDeployed && !passportNeedsIdentity)) return;
    if (passportNeedsIdentity) {
      void completeLocalIdentityRegistration();
      return;
    }
    if (!passportWalletCompatible) {
      setError('Passport C1 deployment requires the Dynamic embedded Midnight wallet: only it exposes the getWalletProvider contract settlement boundary.');
      return;
    }
    if (profileStatus === 'loading' || profileStatus === 'idle') {
      setError('Passport is still checking this browser. Wait a moment and try again.');
      return;
    }
    if (!profile) {
      setShowPassportSetup(true);
      return;
    }
    void deployPassport();
  };

  const dynamicReady = Boolean(midnightWallet && surfaces?.unshieldedAddress);
  const canCreatePassport = Boolean(user && midnightWallet && profileStatus === 'missing');
  const signInReady = sdkHasLoaded && !dynamicInitializationBlocked;
  const passportAction = profile ? 'Unlock local key' : 'Create key only';
  const passportContract = profile?.passportContract ?? null;
  const passportPreparation = profile?.passportPreparation ?? null;
  const passportIsDeployed = passportContract?.status === 'submitted' || passportContract?.status === 'confirmed';
  const passportIsConfirmed = passportContract?.status === 'confirmed';
  const passportNeedsIdentity = Boolean(
    localMode &&
    passportIsConfirmed &&
    passportContract &&
    !passportContract.alias,
  );
  const passportWalletCompatible = midnightWallet
    ? localMode || connectorKey(midnightWallet) === 'dynamicwaas'
    : false;
  const canResetLocalPassport = Boolean(profile && !passportContract && error && /encrypted|unlock|passkey|private state|stored passport c1 state/i.test(error));
  const passportDeploymentLabel = passportIsDeployed
    ? passportNeedsIdentity
      ? busyAction === 'identity-register' ? 'Registering Night ID' : 'Register Night ID'
      : passportIsConfirmed ? 'Passport active' : 'Deployment submitted'
    : !passportWalletCompatible && midnightWallet ? 'Embedded wallet required'
      : busyAction === 'passport-deploy' ? deploymentPhase ?? 'Deploying Passport' : passportPreparation ? 'Resume deployment' : profile ? 'Deploy Passport' : 'Set up & deploy';
  const connectedUserName = labelForUser(user);
  const permissionState = !midnightWallet
    ? 'Midnight wallet not provisioned'
    : passportIsConfirmed
      ? localMode ? 'Passport contract connected' : 'Permission calls not yet wired over Dynamic settlement'
      : passportIsDeployed
        ? 'Passport deployment submitted'
        : passportPreparation
          ? 'Passport deployment prepared'
          : 'Deploy Passport to manage permissions';
  const localPermissionReady = Boolean(
    localMode &&
    midnightWallet &&
    profile &&
    passportContract?.status === 'confirmed' &&
    passportContract.network === LOCAL_C1_NETWORK,
  );
  const activePermissionCount = permissions.filter((permission) => permission.active).length;
  const custodyNightTotal = custody
    ? custody.unshielded.reduce((total, balance) => total + BigInt(balance.value), 0n).toString()
    : '—';
  const custodyShieldedTotal = custody
    ? custody.shielded.reduce((total, balance) => total + BigInt(balance.value), 0n).toString()
    : '—';
  const custodyBusy = busyAction?.startsWith('custody-') ?? false;
  const beginSignIn = () => {
    if (signInReady) setShowAuthFlow(true);
  };
  const handlePortalAction = () => {
    if (signInReady) {
      beginSignIn();
      return;
    }
    if (dynamicInitializationBlocked) window.location.reload();
  };
  const signOutPassport = async () => {
    const hadDynamicSession = Boolean(user);
    // Sign-out is the boundary of the §2.2 session stopgap: the wrapped seed
    // and its wrapping key are removed before anything else is torn down.
    await clearPersistedWalletSession();
    await closeLocalWallet();
    setWalletMode(null);
    setLocalSurfaces(null);
    setLocalWalletStatus('idle');
    setLocalWalletNetworkId(null);
    setLocalWalletProvingMode(null);
    passportKeyProviders.current.clear();
    setProfile(null);
    setProfileStatus('idle');
    setSurfaces(null);
    setActivity([]);
    setError(null);
    setSelectedTx(null);
    setShowAddressPicker(false);
    setShowPassportSetup(false);
    setTransferReview(null);
    setShowTransfer(false);
    setRecipient('');
    setAmount('');
    setWorkspaceTab('assets');
    setPermissions([]);
    setPermissionsLoaded(false);
    setMobileTab('home');
    // Classic is a signed-in workspace choice. Leaving it pinned would strand
    // the next visitor there, across reloads, with no way back.
    setExperience('mobile');
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
    // A passkey session never authenticated with Dynamic; there is nothing on
    // that side to log out of, and calling it would be a request we never made.
    if (hadDynamicSession) await handleLogOut();
  };
  const addressesPending = walletSyncing || !surfaces || surfaces.addressStatus === 'loading';
  const balancesLoading = !surfaces || surfaces.balanceStatus === 'loading';
  const unshieldedBalance = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : balancesLoading ? 'Syncing' : surfaces?.unshieldedBalance ?? '0';
  const dustBalance = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : surfaces?.dustSyncing || balancesLoading ? 'Syncing' : surfaces?.dustBalance ?? '0';
  const shieldedAssets = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : balancesLoading ? 'Syncing' : `${surfaces?.shieldedTokenCount ?? 0}`;
  const walletActivationState: ActivationState = midnightWallet ? 'complete' : user ? 'active' : 'waiting';
  const keyActivationState: ActivationState = profile
    ? 'complete'
    : deploymentPhase === 'Creating Passport key'
      ? 'active'
      : midnightWallet
        ? 'ready'
        : 'waiting';
  const contractActivationState: ActivationState = passportIsConfirmed
    ? 'complete'
    : passportIsDeployed || deploymentPhase
      ? 'active'
      : profile && passportWalletCompatible
        ? 'ready'
        : 'waiting';
  const addressChoices: AddressChoice[] = [
    {
      kind: 'unshielded',
      label: 'Midnight address',
      address: activeSurfaces?.unshieldedAddress ?? midnightWallet?.address ?? null,
      detail: 'Public, unshielded NIGHT and incoming transfers',
    },
    {
      kind: 'shielded',
      label: 'Shielded address',
      address: activeSurfaces?.shieldedAddress ?? null,
      detail: 'Private assets and shielded transfers',
    },
    {
      kind: 'dust',
      label: 'DUST address',
      address: activeSurfaces?.dustAddress ?? null,
      detail: 'DUST fee-generation surface',
    },
  ];

  /* ---------------------------------------------------------------------- */
  /* Mobile experience                                                      */
  /* ---------------------------------------------------------------------- */

  // A Passport key is only genuinely enrolled once the stored-profile lookup
  // has resolved, and that lookup needs the subject id derived from the Dynamic
  // account — so this is honestly false before authentication.
  const passportEnrolled = profileStatus === 'ready' && Boolean(profile);
  /**
   * A passkey session is live only while a wallet is actually open. The wallet
   * is derived from a PRF assertion and is deliberately not persisted, so a
   * reload genuinely has no wallet until the user re-asserts the passkey. The
   * remembered mode makes that one tap ("Sign in", offered first) rather than a
   * fresh enrolment.
   */
  const localSessionActive = localWalletStatus === 'ready' && localSurfaces !== null;
  const dynamicSessionActive = Boolean(user) && passportEnrolled;
  const sessionActive = localSessionActive || dynamicSessionActive;
  /**
   * Signed in through Dynamic with no local passkey wallet open: the profile
   * connect works, but nothing here can sign a transfer. The app browser is
   * told so it can refuse payments honestly instead of claiming no session
   * exists at all.
   */
  const dynamicOnlySession = dynamicSessionActive && !localSessionActive;
  const showOnboarding =
    !sessionActive || onboardingIntent !== null || onboardingError !== null;
  // The §2.2 session restore opens the wallet with no onboarding intent set,
  // so an opening local wallet also reads as the working stage.
  const onboardingStage: 'welcome' | 'working' =
    onboardingIntent !== null || localWalletStatus === 'opening' ? 'working' : 'welcome';
  const onboardingLabel =
    onboardingBusyLabel ??
    (onboardingIntent === 'dynamic'
      ? !user
        ? 'Waiting for the Dynamic sign-in window'
        : !midnightWallet
          ? 'Provisioning your Midnight wallet'
          : 'Preparing Passport'
      : 'Follow the passkey prompt on this device');
  /** Passkey route. Dynamic is not loaded, called, or waited on. */
  const startPasskeyOnboarding = (intent: 'create' | 'signin' | 'auto') => {
    void runLocalOnboarding(intent);
  };

  /**
   * The hosted route. No longer offered by the mobile onboarding (2026/08/05
   * decision) — the classic dashboard, reachable through the "Full dashboard"
   * footer link, keeps the Dynamic path — but the machinery is retained.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const startDynamicOnboarding = () => {
    setOnboardingError(null);
    setWalletMode('dynamic');
    if (!user) {
      if (!signInReady) {
        setOnboardingError(
          dynamicInitializationBlocked
            ? 'Dynamic did not finish loading. Reload this page and try again.'
            : 'Passport is still preparing sign-in. Try again in a moment.',
        );
        return;
      }
      setOnboardingIntent('dynamic');
      beginSignIn();
      return;
    }
    setOnboardingIntent('dynamic');
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

  const copyAddressOfKind = (kind: AddressKind) => {
    const choice = addressChoices.find((candidate) => candidate.kind === kind);
    if (!choice?.address) return;
    void copyText(choice.address).then(
      () => pushToast({ tone: 'success', title: 'Address copied' }),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const refreshMobile = () => {
    if (walletMode === 'local') void refreshLocalBalances();
    else void refreshWallet();
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
  /* The app-to-wallet seam — a framed dApp asking Passport to pay          */
  /*                                                                        */
  /* An app never touches the wallet. It posts a transaction request, the    */
  /* in-app browser shows the approval sheet, and only on approval does the  */
  /* callback below run — the same `sendUnshieldedNight` the wallet uses for */
  /* everything else, with the same pre-checks and the same real txid.       */
  /* ---------------------------------------------------------------------- */

  /**
   * The per-transaction approval ceremony for the open passkey session.
   *
   * The wallet seed lives in memory once a session is open, so without this a
   * submission would be a bare click. The platform's own verification sheet —
   * Touch ID, fingerprint, device PIN — is the approval UI, and a refusal
   * aborts before anything is signed. Exactly ONE ceremony per user-approved
   * action: a flow that makes several chain transactions from one approval
   * calls this once. Dynamic sessions never reach it — that wallet carries its
   * own signing UX. A session restored without its profile has no credential
   * to assert against, and fails closed rather than skipping the ceremony.
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
   * Signs and submits a real unshielded NIGHT transfer for a framed app.
   *
   * Handed to the in-app browser ONLY while a local wallet is genuinely open —
   * an undefined callback is what makes the browser answer `wallet-unavailable`
   * instead of showing a sheet it could not honour. Every refusal from the
   * wallet is rethrown untouched so the browser can map it onto the bridge's
   * vocabulary; nothing is swallowed and nothing is invented.
   */
  const executeAppTransfer = useCallback(
    async (intent: {
      recipientAddress: string;
      amount: bigint;
      purpose: string;
      origin: string;
    }): Promise<{ txId: string }> => {
      const handle = localWalletRef.current;
      if (!handle) {
        throw Object.assign(
          new Error('The Passport wallet session closed before this could be signed.'),
          { code: 'wallet-closed' },
        );
      }
      // The approval sheet's Approve tap lands here; the ceremony IS the
      // popup. No verification, no submission — the browser maps a refusal
      // onto the bridge's own vocabulary.
      await confirmLocalApproval(intent.purpose);
      const entry = addActivity({
        label: intent.purpose,
        detail: `Requested by ${intent.origin}.`,
        status: 'pending',
        source: 'wallet',
      });
      try {
        const result = await handle.sendUnshieldedNight({
          recipientAddress: intent.recipientAddress,
          amount: intent.amount,
        });
        updateActivity(entry.id, {
          status: 'complete',
          detail: `Submitted from this device for ${intent.origin}.`,
          source: 'chain',
          txHash: result.txId,
        });
        pushToast({
          tone: 'success',
          title: 'Payment submitted',
          body: intent.purpose,
          link: explorerTxLink(result.txId, localWalletNetworkId),
        });
        // The balance has moved and the indexer needs a moment to see the
        // transaction; the session row already carries it in the meantime.
        void refreshLocalBalances();
        window.setTimeout(() => void refreshTransactions(), 5_000);
        return { txId: result.txId };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        updateActivity(entry.id, {
          status: 'error',
          detail: message,
          source: 'local',
        });
        throw cause;
      }
    },
    [addActivity, confirmLocalApproval, localWalletNetworkId, refreshLocalBalances, refreshTransactions, updateActivity],
  );

  /**
   * What an app is told about the wallet it is asking to spend from: the
   * network a recipient must belong to, and the balance the sheet quotes.
   * `null` whenever no local wallet is open.
   */
  const appTransferContext =
    localSessionActive && localWalletNetworkId
      ? {
          networkId: localWalletNetworkId,
          formattedBalance: activeSurfaces?.unshieldedBalance ?? null,
        }
      : null;

  /* ---------------------------------------------------------------------- */
  /* The user's own Send — the same wallet call, initiated by the owner      */
  /*                                                                        */
  /* `executeAppTransfer` above is a framed app asking Passport to pay. This  */
  /* is the user asking Passport to pay, from the Send sheet on Home. The     */
  /* wallet call, the activity row, the explorer link, and the two refreshes  */
  /* are deliberately the same — one transfer path, one set of side effects.  */
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
   * Signs and submits the user's own unshielded NIGHT transfer.
   *
   * Every refusal is rethrown untouched: the Send sheet maps `SendNightError.code`
   * onto its own copy and keeps the wallet's message, so nothing is swallowed
   * and no code is invented on the way through.
   */
  const executeOwnSend = useCallback(
    async (params: { recipientAddress: string; amount: bigint }): Promise<SendNightResult> => {
      const handle = localWalletRef.current;
      if (!handle) {
        /* Structurally a `SendNightError` — `{ code, message }` — without a
           value import of `lib/localWallet.ts`, which statically pulls in the
           whole wallet SDK. Same reason `executeAppTransfer` does it this way. */
        throw Object.assign(
          new Error('The Passport wallet session closed before this could be signed.'),
          { code: 'wallet-closed' as const },
        );
      }
      // The Send sheet's confirm lands here; the ceremony IS the popup. A
      // refusal is rethrown for the sheet's own failure line — nothing was
      // signed, so no activity row is written for it either.
      await confirmLocalApproval('Send NIGHT');
      const entry = addActivity({
        label: 'Sent NIGHT',
        detail: `To ${params.recipientAddress}.`,
        status: 'pending',
        source: 'wallet',
      });
      try {
        const result = await handle.sendUnshieldedNight(params);
        updateActivity(entry.id, {
          status: 'complete',
          detail: `Submitted from this device to ${params.recipientAddress}.`,
          source: 'chain',
          txHash: result.txId,
        });
        pushToast({
          tone: 'success',
          /* The node has accepted the transaction, not yet included it — the
             title claims exactly that much and no more. */
          title: 'NIGHT accepted by the network — confirming',
          /* A covered fee is claimed on the strength of the flag's own
             contract and nothing else — a sponsored attempt that fell back to
             the user's own DUST reports `false` and is described as such. */
          body: result.sponsored
            ? 'The fee sponsor covered the network fee.'
            : 'The network fee was paid from your DUST.',
          link: explorerTxLink(result.txId, localWalletNetworkId),
        });
        // The balance has moved and the indexer needs a moment to see the
        // transaction; the session row already carries it in the meantime.
        // The live balance stream will also catch this, but an own send is
        // the one case where waiting for a throttle window is needless.
        void refreshLocalBalances();
        window.setTimeout(() => void refreshTransactions(), 5_000);
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        updateActivity(entry.id, {
          status: 'error',
          detail: message,
          source: 'local',
        });
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
      }
    },
    [addActivity, confirmLocalApproval, localWalletNetworkId, refreshLocalBalances, refreshTransactions, updateActivity],
  );

  /**
   * The Send seam handed to Home — `null` unless a local wallet session is
   * genuinely open AND has an unshielded address to send from. Home renders no
   * Send control at all in that case, rather than a disabled one implying the
   * wallet nearly could.
   */
  const homeSend =
    localSessionActive &&
    localWalletNetworkId &&
    localWalletProvingMode &&
    localSurfaces?.unshieldedAddress
      ? {
          networkId: localWalletNetworkId,
          provingMode: localWalletProvingMode,
          readFeeReadiness: readLocalFeeReadiness,
          onSend: executeOwnSend,
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
  const sessionDisplayName = localSessionActive ? passkeyDisplayName : connectedUserName;

  /**
   * The greeting's subject on Home, which is a different question from the name
   * above: the alias already leads the greeting when there is one, so repeating
   * it beneath as a display name would say the same thing twice, and the
   * enrolled passkey's label ('Midnight Passport') is not a person's name. null
   * lets HomeScreen render its designed fallback — the greeting alone, set as a
   * display headline wrapped into ragged lines.
   */
  const homeDisplayName = localSessionActive ? null : connectedUserName;

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
   * The stored record for THIS credential on the network the card is showing.
   * Read per credential as well as per network: a second passkey in the same
   * browser must never be shown the first one's contract.
   */
  const activeContractRecord =
    profile && localWalletNetworkId
      ? contractRecords[
          passportContractRecordKey(profile.passkey.credentialId, localWalletNetworkId)
        ] ?? null
      : null;
  /**
   * What the two consent sheets may offer as "your Passport contract".
   *
   * Two writers, one field. `profile.passportContract` is the Dynamic-deployed
   * C1 record; the contract the passkey wallet deploys from the Home card
   * lands in the contract STORE instead and never touches the profile. Reading
   * only the profile meant a Passport whose contract was deployed the new way
   * told every relying app it had none — the field was simply missing from an
   * otherwise correct, signed reply.
   *
   * The Dynamic record wins when both exist, because that is the one the rest
   * of the classic flow acts on. The stored record is offered only when it is
   * genuinely `'deployed'` with a real address: a failed deploy is not a
   * contract, and both address and network come from the record itself so the
   * pair can never be assembled from two different networks.
   */
  const consentPassportContract = passportContract
    ? { address: passportContract.address, network: passportContract.network }
    : activeContractRecord?.status === 'deployed' && activeContractRecord.address
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
    if (FUNDER_URL && selectedNetwork === localWalletNetworkId && aliasClaimSupported) {
      const shortfall = await claimNightShortfall(alias);
      // The probe keeps this branch honest: a name queued because the REGISTRY
      // was unreachable (or taken meanwhile) must queue exactly as before —
      // only a claim that would succeed given funds is worth activating for.
      const claimable =
        shortfall !== null &&
        (await probeAlias(selectedNetwork, alias).catch(() => null))?.status === 'available';
      if (shortfall !== null && claimable) {
        const activated = await activateWalletViaFunder(shortfall);
        // The user may have skipped or signed out during the wait; springing
        // a passkey prompt (or a queue toast) on them then would be worse
        // than doing nothing — their own action already resolved the step.
        if (identityStepRef.current !== 'alias') return;
        if (activated) {
          await claimAliasOnChain(alias);
          return;
        }
        queueAlias(alias, selectedNetwork, `${reason} ${FUNDER_UNAVAILABLE_SENTENCE}`);
        if (profile) storeNameStep(profile.passkey.credentialId, 'done');
        setIdentityStep(null);
        return;
      }
    }
    queueAlias(alias, selectedNetwork, reason);
    if (profile) storeNameStep(profile.passkey.credentialId, 'done');
    setIdentityStep(null);
  };

  /**
   * The classic workspace is the Dynamic-hosted view and renders its sign-in
   * portal without a Dynamic account. Sending a passkey session there would
   * strand it, so the option explains itself rather than dead-ending.
   */
  const openClassicExperience = () => {
    if (localSessionActive) {
      setError(
        'The full dashboard is the Dynamic-hosted workspace. Sign out, then choose "Continue with Dynamic" to open it.',
      );
      return;
    }
    setExperience('classic');
  };

  const appsProfile = sessionActive
    ? {
        displayName: sessionDisplayName,
        // The network travels with the address: a localnet deployment must not
        // be shared with a dApp as though it lived on preview.
        passportContract: profile?.passportContract
          ? {
              address: profile.passportContract.address,
              network: profile.passportContract.network,
            }
          : null,
        midnightAddresses: {
          unshielded: activeSurfaces?.unshieldedAddress ?? midnightWallet?.address ?? null,
          shielded: activeSurfaces?.shieldedAddress ?? null,
          dust: activeSurfaces?.dustAddress ?? null,
        },
      }
    : null;

  const overlays = (
    <>
      {selectedTx && <TransactionModal entry={selectedTx} onClose={() => setSelectedTx(null)} />}
      {showAddressPicker && <AddressPickerModal choices={addressChoices} onClose={() => setShowAddressPicker(false)} />}
      {transferReview && <TransferReviewModal review={transferReview} onCancel={() => setTransferReview(null)} onSubmit={() => void submitTransfer()} busy={busyAction === 'transfer'} />}
      {showPassportSetup && <PassportSetupModal localMode={localMode} onClose={() => setShowPassportSetup(false)} onContinue={() => { setShowPassportSetup(false); void deployPassport(); }} />}
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
        executeTransfer={localSessionActive ? executeAppTransfer : undefined}
        dynamicOnlySession={dynamicOnlySession}
        transferContext={appTransferContext}
      />
    </>
  );

  if (experience === 'mobile') {
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
            onOpenClassic={() => setExperience('classic')}
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
                syncPercent={walletMode === 'local' ? localSyncPercent : null}
                unshieldedBalance={activeSurfaces?.unshieldedBalance ?? null}
                shieldedTokenCount={activeSurfaces?.shieldedTokenCount ?? null}
                dustBalance={activeSurfaces?.dustBalance ?? null}
                dustCap={activeSurfaces?.dustCap ?? null}
                dustFillPercent={dustFillPercentFrom(activeSurfaces?.dustBalance ?? null, activeSurfaces?.dustCap ?? null)}
                dustSyncing={activeSurfaces?.dustSyncing ?? false}
                balanceStatus={activeSurfaces?.balanceStatus ?? 'loading'}
                unshieldedAddress={activeSurfaces?.unshieldedAddress ?? midnightWallet?.address ?? null}
                shieldedAddress={activeSurfaces?.shieldedAddress ?? null}
                dustAddress={activeSurfaces?.dustAddress ?? null}
                error={error}
                onDismissError={() => setError(null)}
                onRefresh={refreshMobile}
                onCopyAddress={copyAddressOfKind}
                /* The Send seam. `null` when no local wallet session is open,
                   which is what makes Home render no Send control at all. */
                send={homeSend}
                walletSourceNote={
                  walletMode === 'local'
                    ? `On-device wallet · ${localWalletNetworkId ?? configuredWalletNetwork ?? 'unknown network'} · derived from your passkey. Balances and history come from the indexer; transfers are signed here and submitted straight to the node.`
                    : null
                }
                appsProfile={appsProfile}
                onProfileShared={handleProfileShared}
                executeTransfer={localSessionActive ? executeAppTransfer : undefined}
                dynamicOnlySession={dynamicOnlySession}
                transferContext={appTransferContext}
                onIncentiveRedeemed={handleIncentiveRedeemed}
                supportUrl={(import.meta.env.VITE_TELEGRAM_URL as string | undefined) ?? null}
                /* The only route to the Backup screen. It is offered whenever a
                   Passport exists here, because restoring is exactly what a
                   browser with no records needs. */
                onOpenBackup={profile ? () => setIdentityStep('backup') : undefined}
                onOpenClassic={openClassicExperience}
                onSignOut={() => void signOutPassport()}
              />
            ) : (
              <AppsScreen
                profile={appsProfile}
                onProfileShared={handleProfileShared}
                network={selectedNetwork}
                onSelectNetwork={handleSelectNetwork}
                executeTransfer={localSessionActive ? executeAppTransfer : undefined}
                dynamicOnlySession={dynamicOnlySession}
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

  return (
    <div className={`passport-experience ${user ? 'is-authenticated' : ''}`}>
      {portalVisible && (
        <section className={`passport-portal ${user ? 'is-leaving' : ''}`} aria-labelledby="portal-title">
          <div className="portal-art" role="img" aria-label="Monochrome Passport network gateway" />
          <header className="portal-bar">
            <div className="portal-brand"><img src="/midnight-wordmark.svg" alt="Midnight" /></div>
          </header>
          <div className="portal-copy">
            <h1 id="portal-title">
              <span>Your Ultimate</span>
              <span>Entry Point</span>
              <span>To <em>Web3</em></span>
            </h1>
            <button className="portal-cta" onClick={handlePortalAction} disabled={!signInReady && !dynamicInitializationBlocked}>
              {signInReady ? 'Sign in to Passport' : dynamicInitializationBlocked ? 'Retry Dynamic' : 'Preparing sign-in'} {dynamicInitializationBlocked ? <RefreshCw size={18} /> : <ArrowUpRight size={18} />}
            </button>
          </div>
        </section>
      )}

      {user && (
        <section className={`passport-workspace ${portalVisible ? 'is-entering' : ''}`} aria-label="Passport workspace">
          <header className="workspace-bar">
            <div className="workspace-brand"><img src="/midnight-wordmark.svg" alt="Midnight" /><span /> <strong>Passport</strong></div>
            <nav className="workspace-tabs" aria-label="Passport sections">
              <button className={workspaceTab === 'assets' ? 'active' : ''} onClick={() => setWorkspaceTab('assets')}>Assets</button>
              <button className={workspaceTab === 'permissions' ? 'active' : ''} onClick={() => setWorkspaceTab('permissions')}>Permissions</button>
              <button className={workspaceTab === 'connections' ? 'active' : ''} onClick={() => setWorkspaceTab('connections')}>Connections</button>
            </nav>
            <div className="workspace-controls">
              <span className={`workspace-status ${dynamicReady ? 'online' : ''}`}><i /> {connectedUserName}</span>
              <button className="tool-button" onClick={() => setExperience('mobile')}><Smartphone size={16} /> Mobile view</button>
              <IconButton label="Sign out" onClick={() => void signOutPassport()}><LogOut size={16} /></IconButton>
            </div>
          </header>

          {error && <div className="workspace-error"><CircleAlert size={17} /><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError(null)}><X size={15} /></IconButton></div>}

          <main className="workspace-main">
            <section className="account-strip">
              <img className="passport-control-atlas" src="/passport-control-atlas.png" alt="" aria-hidden="true" />
              <div className="passport-contract-copy"><p>Passport activation</p><h2>{passportIsConfirmed ? 'Passport is active.' : passportIsDeployed ? 'Deployment submitted.' : passportPreparation ? 'Ready to resume.' : profileStatus === 'loading' ? 'Checking this browser.' : profile ? 'Ready to deploy.' : midnightWallet ? 'Create your Passport.' : 'Preparing your wallet.'}</h2><small>{passportIsDeployed ? `C1 ${compactAddress(passportContract?.address ?? '')} · ${passportIsConfirmed ? `confirmed on ${passportContract?.network === 'undeployed' ? 'Midnight localnet' : 'Midnight'}` : 'awaiting testnet confirmation'}` : passportPreparation ? `C1 ${compactAddress(passportPreparation.address)} is secured locally. Resume the Dynamic capability check and exact-byte approval.` : profileStatus === 'loading' ? 'Looking for encrypted Passport state linked to this Dynamic account.' : profile ? localMode ? 'Your encrypted device authority is ready. The isolated localnet adapter will deploy the real custody contract.' : 'Your encrypted device authority is ready. Preview deployment waits for Dynamic Compact proof support.' : 'One protected device authority unlocks your account-management contract.'}</small></div>
              <div className="passport-action-stack">
                <div className="passport-command">
                  <button className="deploy-button" onClick={requestPassportDeployment} disabled={!midnightWallet || !passportWalletCompatible || Boolean(busyAction) || (passportIsDeployed && !passportNeedsIdentity) || profileStatus === 'loading' || profileStatus === 'idle'}>
                    {busyAction === 'passport-deploy' ? <LoaderCircle className="spin" size={16} /> : <Box size={16} />}{passportDeploymentLabel}
                  </button>
                  <ActionHelp label="What does Passport deployment do?"><strong>{localMode ? 'Localnet contract' : 'Testnet pilot'}</strong><span>{localMode ? 'Deploys the actual account-custody contract with an isolated fixture fee wallet. Your passkey-protected private witness remains the withdrawal and permission authority; deposits are permissionless.' : profile ? 'Builds an unsigned C1 draft from the embedded wallet’s shielded address, then requires Dynamic Compact proof support to finalize it.' : 'First, you set up a local Passport key that protects the C1 device witness. The preview draft then waits for Dynamic proof support.'}</span></ActionHelp>
                </div>
                <div className="passport-command">
                  <span className="passport-secondary-label">Optional device action</span>
                  <button className="key-option-button" onClick={profile ? unlockPassport : enrollPassport} disabled={Boolean(busyAction) || (!profile && !canCreatePassport)}>
                    {busyAction === 'passport-key' || busyAction === 'passport-unlock' ? <LoaderCircle className="spin" size={16} /> : profile ? <Fingerprint size={16} /> : <KeyRound size={16} />}{passportAction}
                  </button>
                  <ActionHelp label="What is a Passport key?"><strong>Local encrypted state</strong><span>A WebAuthn PRF passkey unlocks device and C1 maintenance state. It is separate from Dynamic’s wallet signature and does not contain a wallet seed.</span></ActionHelp>
                </div>
                {canResetLocalPassport && <button className="reset-passport-button" onClick={() => void resetLocalPassport()} disabled={Boolean(busyAction)}>Reset unfinished setup</button>}
              </div>
              <IconButton label="Refresh Midnight wallet" onClick={refreshWallet} disabled={!midnightWallet || walletSyncing}><RefreshCw className={walletSyncing ? 'spin' : undefined} size={16} /></IconButton>
              <div className="activation-rail" aria-label="Passport activation progress">
                <ActivationStep number="01" label="Dynamic wallet" detail={midnightWallet ? 'Midnight connected' : 'Provisioning wallet'} state={walletActivationState} />
                <ActivationStep number="02" label="Passport key" detail={profile ? 'Private state protected' : deploymentPhase === 'Creating Passport key' ? 'Waiting for browser approval' : 'Required for C1'} state={keyActivationState} />
                <ActivationStep number="03" label="C1 contract" detail={passportIsConfirmed ? `Active on ${passportContract?.network === 'undeployed' ? 'localnet' : 'Midnight'}` : passportIsDeployed ? 'Submitted to testnet' : !passportWalletCompatible && midnightWallet ? 'Dynamic embedded wallet required' : deploymentPhase ?? (passportPreparation ? 'Draft ready to resume' : localMode ? 'Local adapter ready after key setup' : 'Dynamic settlement ready after key setup')} state={contractActivationState} />
              </div>
            </section>

            {workspaceTab === 'assets' ? (
              <>
                <section className="asset-heading">
                  <div><p>Midnight wallet</p><h1>Your Midnight addresses.</h1></div>
                  <div className="asset-actions">
                    <button className="tool-button" onClick={() => setShowAddressPicker(true)} disabled={!midnightWallet}><Copy size={16} /> Copy address</button>
                    <button className="tool-button" onClick={signMessage} disabled={!midnightWallet || Boolean(busyAction)}>{busyAction === 'message' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Verify</button>
                    <button className="tool-button" onClick={() => setShowTransfer((visible) => !visible)} disabled={!midnightWallet || Boolean(busyAction)}><Send size={16} /> Send</button>
                    <IconButton label="Register DUST" onClick={registerDust} disabled={!midnightWallet || Boolean(busyAction)}>{busyAction === 'dust' ? <LoaderCircle className="spin" size={16} /> : <DatabaseZap size={16} />}</IconButton>
                    <IconButton label="Recover pending transaction" onClick={recoverPending} disabled={!midnightWallet || Boolean(busyAction)}>{busyAction === 'recovery' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}</IconButton>
                  </div>
                </section>

                <section className="address-surfaces" aria-label="Midnight addresses">
                  <AddressSurface kind="unshielded" label="Midnight address" address={surfaces?.unshieldedAddress ?? midnightWallet?.address ?? null} detail="Public, unshielded NIGHT transfers" pending={addressesPending} />
                  <AddressSurface kind="shielded" label="Shielded address" address={surfaces?.shieldedAddress ?? null} detail="Private assets and transfers" pending={addressesPending} />
                  <AddressSurface kind="dust" label="DUST address" address={surfaces?.dustAddress ?? null} detail="Fee-generation surface" pending={addressesPending} />
                </section>

                {showTransfer && (
                  <section className="transfer-drawer" aria-label="Send Midnight asset">
                    <div className="drawer-heading"><div><p>Send asset</p><h2>Midnight transfer</h2></div><IconButton label="Close send asset" onClick={() => setShowTransfer(false)}><X size={16} /></IconButton></div>
                    <div className="transfer-controls">
                      <div className="segmented-control" role="group" aria-label="Transfer pool"><button className={transferPool === 'unshielded' ? 'active' : ''} onClick={() => setTransferPool('unshielded')}>Unshielded</button><button className={transferPool === 'shielded' ? 'active' : ''} onClick={() => setTransferPool('shielded')}>Shielded</button></div>
                      <label>Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder={transferPool === 'shielded' ? 'mn_shield...' : 'mn_addr...'} /></label>
                      <label>Amount (atomic NIGHT)<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1000000" /></label>
                      <button className="send-button" onClick={reviewTransfer} disabled={!midnightWallet || Boolean(busyAction)}>{busyAction === 'transfer' ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {busyAction === 'transfer' ? 'Submitting' : 'Review transfer'}</button>
                    </div>
                  </section>
                )}

                <section className="asset-grid" aria-label="Midnight asset surfaces">
                  <AssetTile label="Unshielded NIGHT" value={unshieldedBalance} detail="Public balance" icon={<WalletCards size={19} />} />
                  <AssetTile label="DUST" value={dustBalance} detail={surfaces?.dustSyncing ? 'Synchronizing fee state' : 'Fee balance'} icon={<Sparkles size={19} />} syncing={surfaces?.dustSyncing} />
                  <AssetTile label="Shielded assets" value={shieldedAssets} detail="Token types with balance" icon={<LockKeyhole size={19} />} />
                </section>

                {localPermissionReady && (
                  <section className="custody-console" aria-label="Passport C1 custody">
                    <div className="custody-heading">
                      <div>
                        <p>Account custody contract</p>
                        <h2>Move assets through C1.</h2>
                      </div>
                      <button className="tool-button" onClick={() => void refreshPassportCustody()} disabled={Boolean(busyAction)}>
                        {busyAction === 'custody-read' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                        Read ledger
                      </button>
                    </div>
                    <div className="custody-grid">
                      <article className="custody-pool">
                        <header>
                          <span className="custody-icon unshielded"><WalletCards size={18} /></span>
                          <div><small>Contract-held</small><strong>Unshielded NIGHT</strong></div>
                          <b>{custodyNightTotal}</b>
                        </header>
                        <label>
                          Atomic amount
                          <input inputMode="numeric" value={nightCustodyAmount} onChange={(event) => setNightCustodyAmount(event.target.value)} />
                        </label>
                        <div className="custody-actions">
                          <button onClick={() => void depositPassportNight()} disabled={Boolean(busyAction)}>
                            {busyAction === 'custody-night-deposit' ? <LoaderCircle className="spin" size={15} /> : <ArrowUpRight size={15} />}
                            Deposit
                          </button>
                          <button className="secondary" onClick={() => void withdrawPassportNight()} disabled={Boolean(busyAction) || custodyNightTotal === '0' || custodyNightTotal === '—'}>
                            {busyAction === 'custody-night-withdraw' ? <LoaderCircle className="spin" size={15} /> : <ArrowUpRight size={15} />}
                            Withdraw
                          </button>
                        </div>
                      </article>

                      <article className="custody-pool">
                        <header>
                          <span className="custody-icon shielded"><LockKeyhole size={18} /></span>
                          <div><small>Contract-held</small><strong>Shielded assets</strong></div>
                          <b>{custodyShieldedTotal}</b>
                        </header>
                        <label>
                          Atomic amount
                          <input inputMode="numeric" value={shieldedCustodyAmount} onChange={(event) => setShieldedCustodyAmount(event.target.value)} />
                        </label>
                        <div className="custody-actions">
                          <button onClick={() => void depositPassportShielded()} disabled={Boolean(busyAction)}>
                            {busyAction === 'custody-shielded-deposit' ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                            {busyAction === 'custody-shielded-deposit' ? 'Minting & depositing' : 'Mint test note & deposit'}
                          </button>
                        </div>
                        {custody?.shielded.map((balance) => (
                          <div className="custody-token" key={balance.color}>
                            <code>{compactAddress(balance.color)}</code>
                            <strong>{balance.value}</strong>
                            <IconButton
                              label={`Withdraw ${compactAddress(balance.color)}`}
                              onClick={() => void withdrawPassportShielded(balance.color, balance.value)}
                              disabled={Boolean(busyAction)}
                            >
                              {busyAction === 'custody-shielded-withdraw' ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                            </IconButton>
                          </div>
                        ))}
                      </article>
                    </div>
                    <div className="custody-boundary">
                      <ShieldCheck size={15} />
                      <span>Real disposable-localnet circuits. Deposits are permissionless; withdrawals unlock the Passport key. Every completion returns a chain hash.</span>
                      {custodyBusy && <LoaderCircle className="spin" size={15} />}
                    </div>
                  </section>
                )}
                {surfaces?.balanceError && <div className="balance-state"><CircleAlert size={16} /> Balance sync is unavailable. Your address surfaces remain available.</div>}
              </>
            ) : workspaceTab === 'permissions' ? (
              <section className="permissions-view">
                <div className="permissions-heading">
                  <div><p>Account management contract</p><h1>Permissions.</h1></div>
                  <div className="permissions-heading-actions">
                    {localPermissionReady && (
                      <button className="tool-button" onClick={() => void refreshPassportPermissions()} disabled={Boolean(busyAction)}>
                        {busyAction === 'permission-read' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                        Read contract
                      </button>
                    )}
                    <span>C1</span>
                  </div>
                </div>
                {localPermissionReady ? (
                  <>
                    <div className="permission-overview">
                      <div className="permission-count"><strong>{permissionsLoaded ? activePermissionCount : '—'}</strong><span>active grants</span></div>
                      <div>
                        <h2>{permissionsLoaded ? activePermissionCount ? 'Scoped access is active.' : 'No apps have access yet.' : 'Read the contract to continue.'}</h2>
                        <p>Every grant is written by the C1 account-management contract. Issuing or revoking access asks for your Passport passkey and produces a Midnight localnet transaction. Grant secrets remain encrypted in Passport until a C23 handoff is approved.</p>
                      </div>
                    </div>
                    <div className="permission-composer">
                      <label>App or device<input value={permissionLabel} onChange={(event) => setPermissionLabel(event.target.value)} placeholder="Atlas app" /></label>
                      <label>NIGHT cap (atomic)<input inputMode="numeric" value={permissionCap} onChange={(event) => setPermissionCap(event.target.value)} placeholder="1000000" /></label>
                      <button className="send-button" onClick={() => void addPassportPermission()} disabled={Boolean(busyAction)}>
                        {busyAction === 'permission-add' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                        Issue permission
                      </button>
                    </div>
                    {permissionsLoaded && (
                      <div className="permission-list" aria-label="Contract permissions">
                        {permissions.length === 0 ? (
                          <div className="permission-list-empty">No grants are recorded by this Passport contract.</div>
                        ) : permissions.map((permission) => (
                          <div className={`permission-row ${permission.active ? '' : 'is-revoked'}`} key={permission.commitment}>
                            <span className="permission-mark"><LockKeyhole size={17} /></span>
                            <span className="permission-identity"><strong>{permission.label}</strong><code>{compactAddress(permission.commitment)}</code></span>
                            <span className="permission-usage"><small>NIGHT allowance</small><strong>{permission.spent} / {permission.cap}</strong></span>
                            <span className={`status-pill ${permission.active ? 'complete' : 'blocked'}`}>{permission.active ? 'active' : 'revoked'}</span>
                            <IconButton label={`Revoke ${permission.label}`} onClick={() => void revokePassportPermission(permission)} disabled={!permission.active || Boolean(busyAction)}>
                              {busyAction === 'permission-revoke' && permission.active ? <LoaderCircle className="spin" size={16} /> : <ShieldOff size={16} />}
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="permission-empty"><span>—</span><div><h2>{permissionState}</h2><p>{passportIsConfirmed ? 'The deployed preview contract cannot accept permission writes until Dynamic exposes a supported proof-and-finalization API for arbitrary Compact circuits. This demo does not substitute a discarded message signature.' : passportIsDeployed ? 'The deployment has a real transaction hash. Wait for testnet finality before changing contract permissions.' : passportPreparation ? `C1 ${compactAddress(passportPreparation.address)} is encrypted locally and ready for the Dynamic Compact proof capability check.` : 'Deploy the Passport account-management contract before permissions become available. This interface does not invent or simulate grants.'}</p></div></div>
                )}
                <div className="permission-capabilities"><div><Fingerprint size={17} /><span>Passport key</span><strong>{profile ? 'Local key ready' : 'Required at deploy'}</strong></div><div><WalletCards size={17} /><span>Midnight wallet</span><strong>{midnightWallet ? 'Connected' : 'Awaiting wallet'}</strong></div><div><LockKeyhole size={17} /><span>Contract grants</span><strong>{passportIsConfirmed ? 'Ready for validation' : passportIsDeployed ? 'Awaiting finality' : passportPreparation ? 'Signing required' : 'Deployment required'}</strong></div></div>
              </section>
            ) : (
              <section className="connections-view">
                <div className="permissions-heading"><div><p>Passport connections</p><h1>Connected worlds.</h1></div><span>C23</span></div>
                <div className="connection-list">
                  <article className="connection-row">
                    <span className="connection-index">01</span>
                    <div><p>External application</p><h2>Atlas profile request</h2><small>A separate web origin requests only the profile fields you choose. Passport verifies the opener, origin, request ID, and nonce before showing consent.</small></div>
                    <span className="status-pill complete">ready</span>
                    <a className="tool-button" href={profileClientUrl} target="_blank" rel="noreferrer">Open Atlas <ArrowUpRight size={15} /></a>
                  </article>
                </div>
              </section>
            )}

            <section className="activity-section">
              <div className="activity-heading"><div><p>Activity</p><h2>Recent activity</h2></div><Activity size={20} /></div>
              {activity.length === 0 ? <div className="activity-empty"><Activity size={17} /> Wallet and Passport operations will appear here.</div> : <div className="activity-list">{activity.map((entry) => <button className="activity-row" key={entry.id} onClick={() => setSelectedTx(entry)}><span className="activity-dot"><Activity size={14} /></span><span className="activity-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span><span className={`source-pill ${activitySource(entry)}`}>{sourceLabel(activitySource(entry))}</span><ActivityPill status={entry.status} /><time>{formatTime(entry.createdAt)}</time><ArrowUpRight size={16} /></button>)}</div>}
            </section>
          </main>
        </section>
      )}

      {overlays}
    </div>
  );
}

function TransferReviewModal({
  review,
  busy,
  onCancel,
  onSubmit,
}: {
  review: TransferReview;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const poolLabel = review.pool === 'shielded' ? 'Shielded' : 'Unshielded';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <div className="transaction-modal transfer-review-modal" role="dialog" aria-modal="true" aria-label="Review Midnight transfer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Transfer review</p><h2>Approve with Dynamic.</h2></div><IconButton label="Close transfer review" onClick={onCancel} disabled={busy}><X size={16} /></IconButton></div>
        <p className="transfer-review-intro">Dynamic will build, authorize, prove, and submit this wallet-native Midnight transfer. Passport C1 permissions are not changed by this action.</p>
        <dl>
          <div><dt>Pool</dt><dd>{poolLabel} NIGHT</dd></div>
          <div><dt>Amount</dt><dd>{review.amount} atomic NIGHT</dd></div>
          <div><dt>Recipient</dt><dd><code>{review.recipient}</code></dd></div>
          <div><dt>Authority</dt><dd>Dynamic embedded Midnight wallet</dd></div>
        </dl>
        <div className="modal-actions">
          <button className="modal-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="modal-copy" onClick={onSubmit} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {busy ? 'Submitting' : 'Approve with Dynamic'}</button>
        </div>
      </div>
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
