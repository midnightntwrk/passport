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
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
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
} from '@midnight-ntwrk/passport-sdk';

import {
  compactAddress,
  initialDynamicSurfaceState,
  refreshDynamicAddresses,
  refreshDynamicBalances,
  signDynamicTransaction,
  submitDynamicTransaction,
  type DynamicSurfaceState,
} from './dynamic.js';
import {
  buildPassportC1Deployment,
  createPassportC1MaintenanceSigningKey,
  type PassportC1DeploymentDraft,
} from './c1.js';
import { requestPassportStoragePersistence } from './pwa.js';
import { deleteDemoProfile, loadDemoProfile, saveDemoProfile, type DemoPassportProfile } from './publicProfile.js';

type ActivityStatus = 'pending' | 'complete' | 'blocked' | 'error';
type TransferPool = 'unshielded' | 'shielded';
type WorkspaceTab = 'assets' | 'permissions';
type AddressKind = 'unshielded' | 'shielded' | 'dust';
type ActivationState = 'waiting' | 'ready' | 'active' | 'complete';
type BusyAction = 'passport-key' | 'passport-unlock' | 'message' | 'dust' | 'transfer' | 'recovery' | 'passport-deploy';
type ProfileStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';
type ActivitySource = 'local' | 'wallet' | 'chain';

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
  finalizedTransaction?: string;
}

interface PassportDemoState {
  deviceSecret: Uint8Array;
  createdAt: string;
  schema: 1 | 2 | 3;
  c1?: PassportC1PrivateRecord;
}

const APP_ID = 'org.midnight.passport.demo';
const MIDNIGHT_EXPLORER_URL = 'https://explorer.preview.midnight.network';

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
  onContinue,
  onClose,
}: {
  onContinue: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal passport-setup-modal" role="dialog" aria-modal="true" aria-label="Set up Passport before deployment" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Passport setup</p><h2>One key, then deploy.</h2></div><IconButton label="Close Passport setup" onClick={onClose}><X size={16} /></IconButton></div>
        <p className="passport-setup-intro">Passport needs one private device witness to operate the C1 contract after deployment. It is encrypted locally with a browser passkey before Dynamic signs the transaction.</p>
        <ol className="passport-setup-steps">
          <li><span>01</span><div><strong>Save a Passport key</strong><small>Your browser or device passkey manager will ask you to create and confirm this key. It protects encrypted Passport state; it is not a Dynamic wallet key.</small></div></li>
          <li><span>02</span><div><strong>Request C1 deployment</strong><small>The demo asks Dynamic to sign, prove, and submit the testnet draft. It is successful only after a transaction is confirmed on Midnight.</small></div></li>
        </ol>
        <p className="passport-setup-note">Without the Passport key, the deployed C1 would not have a safe private-state unlock path. No wallet seed or Dynamic private key is stored by Passport.</p>
        <div className="passport-setup-actions"><button className="modal-copy" onClick={onContinue}><Fingerprint size={16} /> Set up &amp; deploy Passport</button><button className="modal-secondary" onClick={onClose}>Not now</button></div>
      </div>
    </div>
  );
}

export default function PassportDemo() {
  const { handleLogOut, primaryWallet, sdkHasLoaded, setShowAuthFlow, user } = useDynamicContext();
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
  const subjectId = subjectFor(midnightWallet, user);
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
  const passportKeyProviders = useRef(new Map<string, WebAuthnPrfKeyProvider>());

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
    if (!midnightWallet) {
      setSurfaces(null);
      setProfile(null);
      setProfileStatus('idle');
      setDustRetryCount(0);
      return;
    }
    let current = true;
    setProfile(null);
    setProfileStatus('loading');
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
  }, [midnightWallet, refreshWallet, subjectId]);

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

  const vault = useCallback(
    (passkey: DemoPassportProfile['passkey']) => {
      let keyProvider = passportKeyProviders.current.get(passkey.credentialId);
      if (!keyProvider) {
        keyProvider = new WebAuthnPrfKeyProvider(passkey);
        passportKeyProviders.current.set(passkey.credentialId, keyProvider);
      }
      return new EncryptedPassportPrivateStateStore(
        new IndexedDbPassportEncryptedRecordStore(),
        keyProvider,
      );
    },
    [],
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
      createdAt: new Date().toISOString(),
      schema: 2,
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

  const loadPassportState = async (activeProfile: DemoPassportProfile): Promise<PassportDemoState> => {
    const injection = await PassportStateInjection({
      store: vault(activeProfile.passkey),
      scope,
      initialPrivateState: {
        deviceSecret: new Uint8Array(),
        createdAt: '',
        schema: 2,
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
      const signedTransaction = await signDynamicTransaction(midnightWallet, draft.serializedTransaction);
      updateActivity(activityEntry.id, {
        label: 'Transaction signed and proved',
        detail: 'The embedded wallet completed authorization and proof.',
        status: 'pending',
        source: 'wallet',
      });
      const submitted = await submitDynamicTransaction(midnightWallet, signedTransaction);
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

      // Persist the maintenance authority before Dynamic signs. If the browser
      // closes after signing, the same Passport state can still recover this C1.
      const privateC1: PassportC1PrivateRecord = {
        address: draft.contractAddress,
        privateStateId: draft.privateStateId,
        maintenanceSigningKey: draft.maintenanceSigningKey,
        network: draft.network,
        artifact: draft.artifact,
        preparedAt: new Date().toISOString(),
        serializedTransaction: draft.serializedTransaction,
        finalizedTransaction: privateState.c1?.finalizedTransaction,
      };
      await vault(activeProfile.passkey).save<PassportDemoState>(scope, {
        ...privateState,
        schema: 3,
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
        detail: `Contract ${compactAddress(draft.contractAddress)} built for Dynamic testnet signing.`,
        status: 'pending',
        source: 'local',
      });

      let signedTransaction = privateC1.finalizedTransaction;
      if (!signedTransaction) {
        setDeploymentPhase('Dynamic MPC signing & proving');
        signedTransaction = await signDynamicTransaction(midnightWallet, draft.serializedTransaction);
        await vault(activeProfile.passkey).save<PassportDemoState>(scope, {
          ...privateState,
          schema: 3,
          c1: { ...privateC1, finalizedTransaction: signedTransaction },
        });
        addActivity({
          label: 'Passport C1 signed and proved',
          detail: 'Dynamic MPC returned a finalized Midnight transaction.',
          status: 'pending',
          source: 'wallet',
        });
      } else {
        addActivity({
          label: 'Passport C1 signature restored',
          detail: 'Reusing the encrypted Dynamic-finalized transaction for broadcast.',
          status: 'pending',
          source: 'wallet',
        });
      }
      setDeploymentPhase('Submitting to Midnight');
      const submitted = await submitDynamicTransaction(midnightWallet, signedTransaction);

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

  const requestPassportDeployment = () => {
    if (!midnightWallet || busyAction || passportIsDeployed) return;
    if (!passportWalletCompatible) {
      setError('Passport C1 deployment requires the Dynamic embedded Midnight wallet. The connected external wallet does not expose the compatible custom-transaction signer.');
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
  const passportWalletCompatible = midnightWallet ? connectorKey(midnightWallet) === 'dynamicwaas' : false;
  const canResetLocalPassport = Boolean(profile && !passportContract && error && /encrypted|unlock|passkey|private state|stored passport c1 state/i.test(error));
  const passportDeploymentLabel = passportIsDeployed
    ? passportIsConfirmed ? 'Passport active' : 'Deployment submitted'
    : !passportWalletCompatible && midnightWallet ? 'Embedded wallet required'
      : busyAction === 'passport-deploy' ? deploymentPhase ?? 'Deploying Passport' : passportPreparation ? 'Resume deployment' : profile ? 'Deploy Passport' : 'Set up & deploy';
  const connectedUserName = labelForUser(user);
  const permissionState = !midnightWallet
    ? 'Midnight wallet not provisioned'
    : passportIsConfirmed
      ? 'Passport contract connected'
      : passportIsDeployed
        ? 'Passport deployment submitted'
        : passportPreparation
          ? 'Passport deployment prepared'
          : 'Deploy Passport to manage permissions';
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
    await handleLogOut();
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
      address: surfaces?.unshieldedAddress ?? midnightWallet?.address ?? null,
      detail: 'Public, unshielded NIGHT and incoming transfers',
    },
    {
      kind: 'shielded',
      label: 'Shielded address',
      address: surfaces?.shieldedAddress ?? null,
      detail: 'Private assets and shielded transfers',
    },
    {
      kind: 'dust',
      label: 'DUST address',
      address: surfaces?.dustAddress ?? null,
      detail: 'DUST fee-generation surface',
    },
  ];

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
            </nav>
            <div className="workspace-controls">
              <a className="workspace-sdk-link" href="/sdk">SDK</a>
              <span className={`workspace-status ${dynamicReady ? 'online' : ''}`}><i /> {connectedUserName}</span>
              <IconButton label="Sign out" onClick={() => void signOutPassport()}><LogOut size={16} /></IconButton>
            </div>
          </header>

          {error && <div className="workspace-error"><CircleAlert size={17} /><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError(null)}><X size={15} /></IconButton></div>}

          <main className="workspace-main">
            <section className="account-strip">
              <img className="passport-control-atlas" src="/passport-control-atlas.png" alt="" aria-hidden="true" />
              <div className="passport-contract-copy"><p>Passport activation</p><h2>{passportIsConfirmed ? 'Passport is active.' : passportIsDeployed ? 'Deployment submitted.' : passportPreparation ? 'Ready to resume.' : profileStatus === 'loading' ? 'Checking this browser.' : profile ? 'Ready to deploy.' : midnightWallet ? 'Create your Passport.' : 'Preparing your wallet.'}</h2><small>{passportIsDeployed ? `C1 ${compactAddress(passportContract?.address ?? '')} · ${passportIsConfirmed ? 'confirmed on Midnight' : 'awaiting testnet confirmation'}` : passportPreparation ? `C1 ${compactAddress(passportPreparation.address)} is secured locally. Resume Dynamic signing and broadcast.` : profileStatus === 'loading' ? 'Looking for encrypted Passport state linked to this Dynamic account.' : profile ? 'Your encrypted device authority is ready. Dynamic will sign, prove, and submit the C1 transaction.' : 'One protected device authority unlocks your account-management contract.'}</small></div>
              <div className="passport-action-stack">
                <div className="passport-command">
                  <button className="deploy-button" onClick={requestPassportDeployment} disabled={!midnightWallet || !passportWalletCompatible || Boolean(busyAction) || passportIsDeployed || profileStatus === 'loading' || profileStatus === 'idle'}>
                    {busyAction === 'passport-deploy' ? <LoaderCircle className="spin" size={16} /> : <Box size={16} />}{passportDeploymentLabel}
                  </button>
                  <ActionHelp label="What does Passport deployment do?"><strong>Testnet pilot</strong><span>{profile ? 'Builds an unsigned C1 draft from the embedded wallet’s shielded address, then asks Dynamic to sign, prove, and submit it.' : 'First, you set up a local Passport key that protects the C1 device witness. The demo then requests Dynamic approval for the testnet draft.'}</span></ActionHelp>
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
                <ActivationStep number="03" label="C1 contract" detail={passportIsConfirmed ? 'Active on Midnight' : passportIsDeployed ? 'Submitted to testnet' : !passportWalletCompatible && midnightWallet ? 'Dynamic embedded wallet required' : deploymentPhase ?? (passportPreparation ? 'Draft ready to resume' : 'Ready after key setup')} state={contractActivationState} />
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
                {surfaces?.balanceError && <div className="balance-state"><CircleAlert size={16} /> Balance sync is unavailable. Your address surfaces remain available.</div>}
              </>
            ) : (
              <section className="permissions-view">
                <div className="permissions-heading"><div><p>Account management contract</p><h1>Permissions.</h1></div><span>C1</span></div>
                <div className="permission-empty"><span>—</span><div><h2>{permissionState}</h2><p>{passportIsConfirmed ? 'C1 permission reads and writes are the next testnet validation step.' : passportIsDeployed ? 'The deployment has a real transaction hash. Wait for testnet finality before changing contract permissions.' : passportPreparation ? `C1 ${compactAddress(passportPreparation.address)} is encrypted locally and ready for Dynamic MPC signing or broadcast retry.` : 'Deploy the Passport account-management contract before permissions become available. This interface does not invent or simulate grants.'}</p></div></div>
                <div className="permission-capabilities"><div><Fingerprint size={17} /><span>Passport key</span><strong>{profile ? 'Local key ready' : 'Required at deploy'}</strong></div><div><WalletCards size={17} /><span>Midnight wallet</span><strong>{midnightWallet ? 'Connected' : 'Awaiting wallet'}</strong></div><div><LockKeyhole size={17} /><span>Contract grants</span><strong>{passportIsConfirmed ? 'Ready for validation' : passportIsDeployed ? 'Awaiting finality' : passportPreparation ? 'Signing required' : 'Deployment required'}</strong></div></div>
              </section>
            )}

            <section className="activity-section">
              <div className="activity-heading"><div><p>Activity</p><h2>Recent activity</h2></div><Activity size={20} /></div>
              {activity.length === 0 ? <div className="activity-empty"><Activity size={17} /> Wallet and Passport operations will appear here.</div> : <div className="activity-list">{activity.map((entry) => <button className="activity-row" key={entry.id} onClick={() => setSelectedTx(entry)}><span className="activity-dot"><Activity size={14} /></span><span className="activity-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span><span className={`source-pill ${activitySource(entry)}`}>{sourceLabel(activitySource(entry))}</span><ActivityPill status={entry.status} /><time>{formatTime(entry.createdAt)}</time><ArrowUpRight size={16} /></button>)}</div>}
            </section>
          </main>
        </section>
      )}

      {selectedTx && <TransactionModal entry={selectedTx} onClose={() => setSelectedTx(null)} />}
      {showAddressPicker && <AddressPickerModal choices={addressChoices} onClose={() => setShowAddressPicker(false)} />}
      {transferReview && <TransferReviewModal review={transferReview} onCancel={() => setTransferReview(null)} onSubmit={() => void submitTransfer()} busy={busyAction === 'transfer'} />}
      {showPassportSetup && <PassportSetupModal onClose={() => setShowPassportSetup(false)} onContinue={() => { setShowPassportSetup(false); void deployPassport(); }} />}
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
