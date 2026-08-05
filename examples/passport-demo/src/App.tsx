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
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
} from './backend.js';

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
import { deleteDemoProfile, loadDemoProfile, saveDemoProfile, type DemoPassportProfile } from './publicProfile.js';
import { PassportProfileConsent } from './profileConsent.js';
import OnboardingScreen from './screens/Onboarding.js';
import HomeScreen from './screens/Home.js';
import AppsScreen from './screens/Apps.js';
import PassportNav, { type MobileTab } from './screens/Nav.js';
import { fetchRecentTransactions, type RecentTransaction } from './lib/indexerTx.js';
// The local wallet drags the whole Midnight wallet SDK in with it. It is loaded
// on demand, from the passkey routes only, so a Dynamic-only session never pays
// for it. Types are erased at build time and cost nothing here.
import type { LocalMidnightWallet, LocalWalletSurfaces } from './lib/localWallet.js';

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
const MIDNIGHT_EXPLORER_URL = 'https://explorer.preview.midnight.network';
/** Preview indexer. `fetchRecentTransactions` derives its own WebSocket URL from this. */
const MIDNIGHT_INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL ?? 'https://indexer.preview.midnight.network/api/v4/graphql';
const EXPERIENCE_STORAGE_KEY = 'passport-experience';
const WALLET_MODE_STORAGE_KEY = 'passport-wallet-mode';

/**
 * Account identifier for the passkey-only Passport.
 *
 * The Dynamic route takes its subject from the hosted account. The passkey
 * route has no such issuer, so it uses this fixed identifier: the encrypted
 * private state, the stored profile, and the wallet-seed derivation info all
 * hang off it, which is what makes "Sign in" find the same wallet again. One
 * local Passport per browser profile — deliberately, for the demo.
 */
const LOCAL_ACCOUNT_ID = 'passport-local-device';
const LOCAL_SCOPE = { appId: APP_ID, accountId: LOCAL_ACCOUNT_ID };

function storedExperience(): Experience {
  try {
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

function validatePreviewRecipient(address: string, pool: TransferPool): void {
  const parsed = MidnightBech32m.parse(address);
  if (parsed.network !== 'preview') throw new Error('Recipient must be a Midnight preview address.');
  parsed.decode(pool === 'shielded' ? ShieldedAddress : UnshieldedAddress, 'preview');
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
  // A returning visitor whose wallet source is remembered has already met the
  // welcome panel; send them straight to the three options.
  const [onboardingStep, setOnboardingStep] = useState<'welcome' | 'choose'>(() =>
    storedWalletMode() ? 'choose' : 'welcome',
  );
  const [onboardingIntent, setOnboardingIntent] = useState<OnboardingIntent | null>(null);
  const [onboardingBusyLabel, setOnboardingBusyLabel] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<RecentTransaction[]>([]);
  const [transactionsStatus, setTransactionsStatus] = useState<TransactionsStatus>('loading');
  const [localSurfaces, setLocalSurfaces] = useState<LocalWalletSurfaces | null>(null);
  const [localWalletStatus, setLocalWalletStatus] = useState<LocalWalletStatus>('idle');
  const [localSyncPercent, setLocalSyncPercent] = useState<number | null>(null);
  const [localWalletNetworkId, setLocalWalletNetworkId] = useState<string | null>(null);
  const [localDustRetryCount, setLocalDustRetryCount] = useState(0);
  /**
   * Whether a passkey Passport is already enrolled in this browser. `null`
   * while the lookup is still running — which is not the same as "no", so the
   * Sign in option stays live until we actually know.
   */
  const [localPassportKnown, setLocalPassportKnown] = useState<boolean | null>(null);
  const passportKeyProviders = useRef(new Map<string, WebAuthnPrfKeyProvider>());
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
  useEffect(() => {
    let current = true;
    void loadDemoProfile(LOCAL_ACCOUNT_ID)
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

  const loadPassportState = async (
    activeProfile: DemoPassportProfile,
    stateScope = scope,
  ): Promise<PassportDemoState> => {
    const injection = await PassportStateInjection({
      store: vault(activeProfile.passkey),
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

  /** Derives the seed, builds the wallet, and publishes its address surfaces. */
  const openLocalWallet = useCallback(
    async (passkey: DemoPassportProfile['passkey']) => {
      const { createLocalMidnightWallet, deriveWalletSeed } = await import('./lib/localWallet.js');
      setLocalWalletStatus('opening');
      setOnboardingBusyLabel('Deriving your Midnight wallet from this passkey');
      const seed = await deriveWalletSeed(keyProviderFor(passkey), LOCAL_SCOPE);
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
      // Addresses are known immediately; balances are still unknown, and say so.
      setLocalSurfaces(initialLocalSurfaceState(wallet));
      setLocalDustRetryCount(0);
      setLocalWalletStatus('ready');
      // The first balance read waits on indexer sync, so it runs behind the
      // screen rather than holding onboarding open.
      void refreshLocalBalances();
    },
    [closeLocalWallet, keyProviderFor, refreshLocalBalances],
  );

  const createLocalPassportProfile = async (): Promise<DemoPassportProfile> => {
    const existing = await loadDemoProfile(LOCAL_ACCOUNT_ID);
    if (existing) {
      setLocalPassportKnown(true);
      throw new Error(
        'This browser already holds a Passport passkey. Choose Sign in to reopen its wallet.',
      );
    }
    setOnboardingBusyLabel('Creating your Passport passkey');
    const passkey = await WebAuthnPrfKeyProvider.enroll({
      label: 'Midnight Passport',
      userId: LOCAL_ACCOUNT_ID,
    });
    const nextProfile: DemoPassportProfile = {
      subjectId: LOCAL_ACCOUNT_ID,
      passkey,
      createdAt: new Date().toISOString(),
    };
    const state: PassportDemoState = {
      deviceSecret: newDeviceSecret(),
      recoverySecret: newDeviceSecret(),
      createdAt: new Date().toISOString(),
      schema: 4,
    };
    setOnboardingBusyLabel('Encrypting your Passport state on this device');
    await vault(passkey).save<PassportDemoState>(LOCAL_SCOPE, state);
    await saveDemoProfile(nextProfile);
    await requestPassportStoragePersistence();
    setProfile(nextProfile);
    setProfileStatus('ready');
    setLocalPassportKnown(true);
    return nextProfile;
  };

  const unlockLocalPassportProfile = async (): Promise<DemoPassportProfile> => {
    const existing = await loadDemoProfile(LOCAL_ACCOUNT_ID);
    if (!existing) {
      setLocalPassportKnown(false);
      throw new Error(
        'No Passport passkey is enrolled in this browser yet. Choose Create passkey to make one.',
      );
    }
    setOnboardingBusyLabel('Unlocking your Passport with this device');
    // Decrypting the stored state is the proof the passkey is the right one;
    // it also fails loudly if the record was written by a different device.
    await loadPassportState(existing, LOCAL_SCOPE);
    setProfile(existing);
    setProfileStatus('ready');
    setLocalPassportKnown(true);
    return existing;
  };

  const runLocalOnboarding = async (intent: 'create' | 'signin') => {
    if (onboardingRunning.current) return;
    onboardingRunning.current = true;
    setOnboardingError(null);
    setError(null);
    setWalletMode('local');
    setOnboardingIntent(intent === 'create' ? 'local-create' : 'local-signin');
    setOnboardingBusyLabel(
      intent === 'create' ? 'Creating your Passport passkey' : 'Unlocking your Passport',
    );
    let activeProfile: DemoPassportProfile | null = null;
    try {
      activeProfile =
        intent === 'create' ? await createLocalPassportProfile() : await unlockLocalPassportProfile();
      await openLocalWallet(activeProfile.passkey);
      setOnboardingError(null);
      addActivity({
        label: intent === 'create' ? 'Passport passkey enrolled' : 'Passport passkey unlocked',
        detail: 'On-device Midnight wallet derived from this passkey. Dynamic was not involved.',
        status: 'complete',
        source: 'local',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalWalletStatus('error');
      setOnboardingError(message);
      setOnboardingStep('choose');
      addActivity({
        label: intent === 'create' ? 'Passport passkey' : 'Passport unlock',
        detail: message,
        status: 'error',
        source: 'local',
      });
    } finally {
      // The state key is cached for 30s inside the provider; drop it now that
      // the wallet is open. The wallet seed was never cached at all.
      if (activeProfile) {
        passportKeyProviders.current.get(activeProfile.passkey.credentialId)?.lock(LOCAL_SCOPE);
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
        void refreshLocalBalances();
      }
    });
    return () => {
      unsubscribe();
      setLocalSyncPercent(null);
    };
  }, [localWalletStatus, refreshLocalBalances]);

  // DUST state arrives after the indexer has walked far enough. Retry a few
  // times so the battery settles without the user pressing anything.
  useEffect(() => {
    if (walletMode !== 'local' || !localSurfaces?.dustSyncing || localDustRetryCount >= 3) return;
    const timer = window.setTimeout(() => {
      setLocalDustRetryCount((current) => current + 1);
      void refreshLocalBalances();
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [localDustRetryCount, localSurfaces?.dustSyncing, refreshLocalBalances, walletMode]);

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
      setOnboardingStep('choose');
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
        setOnboardingStep('choose');
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

  const registerDust = async () => {
    if (walletMode === 'local') {
      // The Home control is already disabled for this; belt and braces, so no
      // future caller can quietly reach a wallet that cannot sign.
      setError(
        'DUST registration submits a NIGHT transaction. The on-device wallet cannot sign or submit one in this demo yet.',
      );
      return;
    }
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
    if (!recipient.trim() || !amount.trim()) {
      setError('Enter a recipient and an atomic token amount.');
      return;
    }
    if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
      setError('The atomic amount must be a positive whole number.');
      return;
    }
    try {
      validatePreviewRecipient(recipient.trim(), transferPool);
    } catch (cause) {
      setError(`Enter a valid ${transferPool} Midnight preview address: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    await closeLocalWallet();
    setWalletMode(null);
    setLocalSurfaces(null);
    setLocalWalletStatus('idle');
    setLocalWalletNetworkId(null);
    setLocalDustRetryCount(0);
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
    setOnboardingStep('welcome');
    setOnboardingIntent(null);
    setOnboardingBusyLabel(null);
    setOnboardingError(null);
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
  const showOnboarding =
    !sessionActive || onboardingIntent !== null || onboardingError !== null;
  const onboardingStage: 'welcome' | 'choose' | 'working' = onboardingIntent ? 'working' : onboardingStep;
  const onboardingLabel =
    onboardingBusyLabel ??
    (onboardingIntent === 'dynamic'
      ? !user
        ? 'Waiting for the Dynamic sign-in window'
        : !midnightWallet
          ? 'Provisioning your Midnight wallet'
          : 'Preparing Passport'
      : 'Follow the passkey prompt on this device');
  /** Only ever set when Sign in genuinely has nothing to assert against. */
  const signInUnavailableReason =
    localPassportKnown === false
      ? 'No Passport passkey is enrolled in this browser yet.'
      : null;
  const dynamicUnavailableReason = signInReady
    ? null
    : dynamicInitializationBlocked
      ? 'Dynamic did not finish loading. Reload this page to try again.'
      : 'Dynamic is still starting up.';

  /** Passkey route. Dynamic is not loaded, called, or waited on. */
  const startPasskeyOnboarding = (intent: 'create' | 'signin') => {
    void runLocalOnboarding(intent);
  };

  /** The unchanged hosted route: Dynamic sign-in, then the Passport key. */
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
    void copyText(choice.address).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const refreshMobile = () => {
    if (walletMode === 'local') void refreshLocalBalances();
    else void refreshWallet();
    void refreshTransactions();
  };

  /** How this Passport is named on screen — hosted account, or this device. */
  // null lets HomeScreen render its designed 'Your Passport' fallback — the
  // literal sentence set as a display headline wrapped into three ragged lines.
  const sessionDisplayName = localSessionActive ? null : connectedUserName;

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

  /**
   * What the local wallet genuinely cannot do yet. `null` on the Dynamic route,
   * where the embedded wallet does sign and submit.
   */
  const localWalletWriteLimitation =
    walletMode === 'local'
      ? 'The on-device wallet reads balances and history only. Signing, sending, and contract calls are not wired up in this demo yet.'
      : null;

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
        displayName={sessionActive ? sessionDisplayName : null}
        passportContract={
          passportContract
            ? { address: passportContract.address, network: passportContract.network }
            : null
        }
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
            hasExistingPassport={localPassportKnown === true}
            signInUnavailableReason={signInUnavailableReason}
            dynamicUnavailableReason={dynamicUnavailableReason}
            onGetStarted={() => setOnboardingStep('choose')}
            onCreatePasskey={() => startPasskeyOnboarding('create')}
            onSignInPasskey={() => startPasskeyOnboarding('signin')}
            onContinueWithDynamic={startDynamicOnboarding}
            onDismissError={() => setOnboardingError(null)}
            onOpenClassic={() => setExperience('classic')}
          />
        ) : (
          <>
            {mobileTab === 'home' ? (
              <HomeScreen
                displayName={sessionDisplayName}
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
                transactions={mergedTransactions}
                transactionsStatus={mobileTransactionsStatus}
                error={error}
                onDismissError={() => setError(null)}
                onRefresh={refreshMobile}
                onCopyAddress={copyAddressOfKind}
                onOpenTransaction={openTransactionByHash}
                onRegisterDust={() => void registerDust()}
                /* DUST registration submits a real NIGHT transaction. The
                   local wallet cannot sign one here yet, so the control is
                   disabled and says why instead of failing at the tap. */
                registerDustDisabledReason={localWalletWriteLimitation}
                walletSourceNote={
                  walletMode === 'local'
                    ? `On-device wallet · ${localWalletNetworkId ?? 'preview'} · derived from your passkey. Read-only for now: balances and history come from the indexer, and nothing here can sign or send.`
                    : null
                }
                onOpenClassic={openClassicExperience}
                onSignOut={() => void signOutPassport()}
              />
            ) : (
              <AppsScreen
                profile={appsProfile}
                onProfileShared={(appName, fields) =>
                  addActivity({
                    label: 'Profile shared',
                    detail: `${appName} received ${fields.join(', ')}.`,
                    status: 'complete',
                    source: 'local',
                  })
                }
              />
            )}
            <PassportNav active={mobileTab} onSelect={setMobileTab} />
          </>
        )}
        {overlays}
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
  const explorerHref = entry.txHash ? `${MIDNIGHT_EXPLORER_URL}/transactions/${encodeURIComponent(entry.txHash)}` : null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal" role="dialog" aria-modal="true" aria-label="Transaction detail" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Transaction detail</p><h2>{entry.label}</h2></div><IconButton label="Close transaction detail" onClick={onClose}><X size={16} /></IconButton></div>
        <dl><div><dt>Status</dt><dd><ActivityPill status={entry.status} /></dd></div><div><dt>Source</dt><dd><span className={`source-pill ${source}`}>{sourceLabel(source)}</span></dd></div><div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div><div><dt>Detail</dt><dd>{entry.detail}</dd></div><div><dt>Transaction hash</dt><dd>{entry.txHash ? <code>{entry.txHash}</code> : 'No on-chain transaction was produced.'}</dd></div></dl>
        {entry.txHash && (
          <div className="modal-actions">
            <button className="modal-secondary" onClick={() => void copyText(entry.txHash!)}><Copy size={16} /> Copy hash</button>
            <a className="modal-copy modal-explorer" href={explorerHref ?? MIDNIGHT_EXPLORER_URL} target="_blank" rel="noreferrer"><ArrowUpRight size={16} /> Open explorer</a>
          </div>
        )}
      </div>
    </div>
  );
}
