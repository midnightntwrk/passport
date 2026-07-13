import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Box,
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
import {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  WebAuthnPrfKeyProvider,
} from '@midnight-ntwrk/passport-sdk';

import {
  compactAddress,
  initialDynamicSurfaceState,
  refreshDynamicAddresses,
  refreshDynamicBalances,
  type DynamicSurfaceState,
} from './dynamic.js';
import {
  buildPassportC1Deployment,
  createPassportC1MaintenanceSigningKey,
  type PassportC1DeploymentDraft,
} from './c1.js';
import { loadDemoProfile, saveDemoProfile, type DemoPassportProfile } from './publicProfile.js';

type ActivityStatus = 'pending' | 'complete' | 'blocked' | 'error';
type TransferPool = 'unshielded' | 'shielded';
type WorkspaceTab = 'assets' | 'permissions';
type AddressKind = 'unshielded' | 'shielded' | 'dust';

interface ActivityEntry {
  id: string;
  label: string;
  detail: string;
  status: ActivityStatus;
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
}

interface PassportDemoState {
  deviceSecret: Uint8Array;
  createdAt: string;
  schema: 1 | 2;
  c1?: PassportC1PrivateRecord;
}

const APP_ID = 'org.midnight.passport.demo';

function newDeviceSecret(): Uint8Array {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  return value;
}

function subjectFor(wallet: MidnightWallet | null, user: unknown): string {
  const profile = user as { userId?: string; id?: string; email?: string } | null;
  return profile?.userId ?? profile?.id ?? wallet?.id ?? wallet?.address ?? 'passport-preview-user';
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
          <li><span>01</span><div><strong>Save a Passport key</strong><small>Your browser or device passkey manager will ask once. This protects encrypted Passport state; it is not a Dynamic wallet key.</small></div></li>
          <li><span>02</span><div><strong>Approve C1 deployment</strong><small>Dynamic then signs, proves, and submits the real testnet account-management contract.</small></div></li>
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
  const wallet = useMemo(
    () => allWallets.find((candidate) => isMidnightWallet(candidate)) as MidnightWallet | undefined,
    [allWallets],
  );
  const midnightWallet = wallet ?? null;
  const subjectId = subjectFor(midnightWallet, user);
  const scope = useMemo(() => ({ appId: APP_ID, accountId: subjectId }), [subjectId]);
  const [profile, setProfile] = useState<DemoPassportProfile | null>(null);
  const [surfaces, setSurfaces] = useState<DynamicSurfaceState | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
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

  const addActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'createdAt'>) => {
    const value = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setActivity((current) => [value, ...current].slice(0, 10));
    return value;
  }, []);

  const refreshWallet = useCallback(async () => {
    if (!midnightWallet) return;
    setWalletSyncing(true);
    setDustRetryCount(0);
    setError(null);
    const snapshot = initialDynamicSurfaceState(midnightWallet);
    setSurfaces((current) => ({
      ...snapshot,
      unshieldedBalance: current?.unshieldedBalance ?? snapshot.unshieldedBalance,
      shieldedTokenCount: current?.shieldedTokenCount ?? snapshot.shieldedTokenCount,
      dustBalance: current?.dustBalance ?? snapshot.dustBalance,
      dustSyncing: current?.dustSyncing ?? snapshot.dustSyncing,
      balanceStatus: current?.balanceStatus ?? snapshot.balanceStatus,
      balanceError: current?.balanceError ?? snapshot.balanceError,
    }));
    try {
      const addresses = await refreshDynamicAddresses(midnightWallet);
      setSurfaces((current) => ({ ...(current ?? snapshot), ...addresses }));
    } finally {
      setWalletSyncing(false);
    }
    const balances = await refreshDynamicBalances(midnightWallet);
    setSurfaces((current) => ({ ...(current ?? snapshot), ...balances }));
  }, [midnightWallet]);

  useEffect(() => {
    if (!midnightWallet) {
      setSurfaces(null);
      setProfile(null);
      setDustRetryCount(0);
      return;
    }
    void refreshWallet();
    void loadDemoProfile(subjectId).then(setProfile).catch((cause) => setError(String(cause)));
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
    (passkey: DemoPassportProfile['passkey']) =>
      new EncryptedPassportPrivateStateStore(
        new IndexedDbPassportEncryptedRecordStore(),
        new WebAuthnPrfKeyProvider(passkey),
      ),
    [],
  );

  const createPassportKey = async (): Promise<{ profile: DemoPassportProfile; state: PassportDemoState }> => {
    if (!user || !midnightWallet) {
      throw new Error('Sign in and wait for a Midnight embedded wallet before creating a Passport key.');
    }
    if (profile) throw new Error('This Passport already has a primary Passport key in this browser.');
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
    await vault(passkey).save<PassportDemoState>(scope, state);
    await saveDemoProfile(nextProfile);
    setProfile(nextProfile);
    return { profile: nextProfile, state };
  };

  const enrollPassport = async () => {
    setLoading(true);
    setError(null);
    try {
      await createPassportKey();
      addActivity({ label: 'Passport key enrolled', detail: 'Private state encrypted in this browser.', status: 'complete' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Passport key', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const loadPassportState = async (activeProfile: DemoPassportProfile): Promise<PassportDemoState> => {
    const state = await vault(activeProfile.passkey).load<PassportDemoState>(scope);
    if (!state) throw new Error('No encrypted Passport key record exists in this browser. Create a Passport key first.');
    if (!(state.deviceSecret instanceof Uint8Array) || state.deviceSecret.byteLength !== 32) {
      throw new Error('The encrypted Passport device state is invalid. Create a new Passport key before deploying.');
    }
    return state;
  };

  const unlockPassport = async () => {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      await loadPassportState(profile);
      addActivity({ label: 'Passport key unlocked', detail: 'Passkey authorization completed locally.', status: 'complete' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Passport unlock', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const signMessage = async () => {
    if (!midnightWallet) return;
    setLoading(true);
    setError(null);
    try {
      await midnightWallet.signMessage(`Midnight Passport verification\nAccount: ${midnightWallet.address}`);
      addActivity({ label: 'Message signed', detail: 'The Midnight wallet approved this verification.', status: 'complete' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Message signing', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const registerDust = async () => {
    if (!midnightWallet) return;
    setLoading(true);
    setError(null);
    try {
      const result = await midnightWallet.registerDust();
      addActivity({
        label: 'DUST registration',
        detail: result.message,
        status: result.status === 'no_utxos' ? 'blocked' : 'complete',
        txHash: result.txId,
      });
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'DUST registration', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const sendTransfer = async () => {
    if (!midnightWallet) return;
    if (!recipient.trim() || !amount.trim()) {
      setError('Enter a recipient and an atomic token amount.');
      return;
    }
    if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
      setError('The atomic amount must be a positive whole number.');
      return;
    }
    const expectedShielded = recipient.startsWith('mn_shield');
    if ((transferPool === 'shielded') !== expectedShielded) {
      setError(transferPool === 'shielded' ? 'Shielded sends require an mn_shield recipient address.' : 'Unshielded sends require a non-shielded Midnight recipient address.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const draft = await midnightWallet.createTransferTransaction({
        transfers: [{ type: transferPool, recipientAddress: recipient.trim(), amount: amount.trim() }],
      });
      addActivity({ label: 'Transfer prepared', detail: `${transferPool === 'shielded' ? 'Shielded' : 'Unshielded'} transaction built by the wallet.`, status: 'pending' });
      const signedTransaction = await midnightWallet.signTransaction(draft.serializedTransaction);
      addActivity({ label: 'Transaction signed and proved', detail: 'The embedded wallet completed authorization and proof.', status: 'pending' });
      const submitted = await midnightWallet.submitTransaction(signedTransaction);
      if (!submitted?.txHash) throw new Error('Dynamic completed the submission call without returning a transaction hash.');
      addActivity({
        label: `${transferPool === 'shielded' ? 'Shielded' : 'Unshielded'} transfer submitted`,
        detail: `${amount} atomic NIGHT to ${compactAddress(recipient.trim())}`,
        status: 'complete',
        txHash: submitted.txHash,
      });
      setRecipient('');
      setAmount('');
      setShowTransfer(false);
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Dynamic transfer', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const recoverPending = async () => {
    if (!midnightWallet) return;
    setLoading(true);
    setError(null);
    try {
      const result = await midnightWallet.revertAllPending();
      addActivity({ label: 'Pending transfer recovery', detail: result.message, status: result.reverted ? 'complete' : 'blocked' });
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Pending transfer recovery', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const deployPassport = async () => {
    if (!user || !midnightWallet) {
      setError('Sign in and wait for a Midnight embedded wallet before deploying Passport.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let activeProfile: DemoPassportProfile;
      let privateState: PassportDemoState;
      if (profile) {
        activeProfile = profile;
        privateState = await loadPassportState(activeProfile);
      } else {
        addActivity({ label: 'Creating Passport key', detail: 'Use your browser passkey to protect the C1 device state.', status: 'pending' });
        const created = await createPassportKey();
        activeProfile = created.profile;
        privateState = created.state;
        addActivity({ label: 'Passport key enrolled', detail: 'Primary device state is encrypted in this browser.', status: 'complete' });
      }

      const deviceSecret = new Uint8Array(privateState.deviceSecret);
      const maintenanceSigningKey = privateState.c1?.maintenanceSigningKey ?? createPassportC1MaintenanceSigningKey();
      let draft: PassportC1DeploymentDraft;
      try {
        draft = await buildPassportC1Deployment(midnightWallet, deviceSecret, maintenanceSigningKey);
      } finally {
        deviceSecret.fill(0);
      }
      if (privateState.c1 && privateState.c1.address !== draft.contractAddress) {
        throw new Error('Stored Passport C1 state does not match the deployment transaction. Refusing to sign a different contract.');
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
      };
      await vault(activeProfile.passkey).save<PassportDemoState>(scope, {
        ...privateState,
        schema: 2,
        c1: privateC1,
      });
      addActivity({
        label: 'Passport C1 prepared',
        detail: `Contract ${compactAddress(draft.contractAddress)} built for Dynamic testnet signing.`,
        status: 'pending',
      });

      const signedTransaction = await midnightWallet.signTransaction(draft.serializedTransaction);
      addActivity({
        label: 'Passport C1 signed and proved',
        detail: 'Dynamic completed the embedded wallet authorization and proof.',
        status: 'pending',
      });
      const submitted = await midnightWallet.submitTransaction(signedTransaction);
      if (!submitted?.txHash) throw new Error('Dynamic completed Passport submission without returning a transaction hash.');

      const deployedAt = new Date().toISOString();
      const nextProfile: DemoPassportProfile = {
        ...activeProfile,
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
        detail: `Deployment submitted to Midnight testnet for ${compactAddress(draft.contractAddress)}.`,
        status: 'complete',
        txHash: submitted.txHash,
      });
      await refreshWallet();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      addActivity({ label: 'Passport deployment', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const requestPassportDeployment = () => {
    if (!midnightWallet || loading || passportIsDeployed) return;
    if (!profile) {
      setShowPassportSetup(true);
      return;
    }
    void deployPassport();
  };

  const dynamicReady = Boolean(midnightWallet && surfaces?.unshieldedAddress);
  const canCreatePassport = Boolean(user && midnightWallet);
  const signInReady = sdkHasLoaded && !dynamicInitializationBlocked;
  const passportAction = profile ? 'Unlock Passport key' : 'Set up Passport key';
  const passportContract = profile?.passportContract ?? null;
  const passportIsDeployed = passportContract?.status === 'submitted' || passportContract?.status === 'confirmed';
  const passportIsConfirmed = passportContract?.status === 'confirmed';
  const passportDeploymentLabel = passportIsDeployed
    ? passportIsConfirmed ? 'Passport active' : 'Deployment submitted'
    : loading ? 'Deploying Passport' : profile ? 'Deploy Passport' : 'Set up & deploy';
  const connectedUserName = labelForUser(user);
  const permissionState = !midnightWallet
    ? 'Midnight wallet not provisioned'
    : passportIsConfirmed
      ? 'Passport contract connected'
      : passportIsDeployed
        ? 'Passport deployment submitted'
      : 'Deploy Passport to manage permissions';
  const beginSignIn = () => {
    if (signInReady) setShowAuthFlow(true);
  };
  const addressesPending = walletSyncing || !surfaces || surfaces.addressStatus === 'loading';
  const balancesLoading = !surfaces || surfaces.balanceStatus === 'loading';
  const unshieldedBalance = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : balancesLoading ? 'Syncing' : surfaces?.unshieldedBalance ?? '0';
  const dustBalance = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : surfaces?.dustSyncing || balancesLoading ? 'Syncing' : surfaces?.dustBalance ?? '0';
  const shieldedAssets = surfaces?.balanceStatus === 'unavailable' ? 'Unavailable' : balancesLoading ? 'Syncing' : `${surfaces?.shieldedTokenCount ?? 0}`;
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
            <button className="portal-cta" onClick={beginSignIn} disabled={!signInReady}>
              {signInReady ? 'Sign in to Passport' : dynamicInitializationBlocked ? 'Sign-in unavailable' : 'Preparing sign-in'} <ArrowUpRight size={18} />
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
              <button className={workspaceTab === 'permissions' ? 'active' : ''} onClick={() => setWorkspaceTab('permissions')} disabled={!passportIsDeployed}>Permissions</button>
            </nav>
            <div className="workspace-controls">
              <a className="workspace-sdk-link" href="/sdk">SDK</a>
              <span className={`workspace-status ${dynamicReady ? 'online' : ''}`}><i /> {connectedUserName}</span>
              <IconButton label="Sign out" onClick={() => void handleLogOut()}><LogOut size={16} /></IconButton>
            </div>
          </header>

          {error && <div className="workspace-error"><CircleAlert size={17} /><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError(null)}><X size={15} /></IconButton></div>}

          <main className="workspace-main">
            <section className="account-strip">
              <img className="passport-control-atlas" src="/passport-control-atlas.png" alt="" aria-hidden="true" />
              <div className="passport-contract-copy"><p>Passport activation</p><h2>{passportIsConfirmed ? 'Passport is active.' : passportIsDeployed ? 'Passport submitted.' : midnightWallet ? profile ? 'Deploy your Passport.' : 'Set up your Passport.' : 'Preparing your wallet.'}</h2><small>{passportIsDeployed ? `C1 ${compactAddress(passportContract?.address ?? '')} · ${passportIsConfirmed ? 'confirmed' : 'awaiting testnet finality'}` : profile ? 'Deploy the real C1 account-management contract through your Dynamic Midnight wallet.' : 'Set up one secure Passport key, then deploy the C1 account-management contract.'}</small></div>
              <div className="passport-action-stack">
                <div className="passport-command">
                  <button className="deploy-button" onClick={requestPassportDeployment} disabled={!midnightWallet || loading || passportIsDeployed}>
                    {loading && !passportIsDeployed ? <LoaderCircle className="spin" size={16} /> : <Box size={16} />}{passportDeploymentLabel}
                  </button>
                  <ActionHelp label="What does Passport deployment do?"><strong>Two explicit approvals</strong><span>{profile ? 'Builds the C1 deployment from this wallet’s shielded public keys, then asks Dynamic to sign, prove, and submit it.' : 'First, you explicitly set up a local Passport key that protects the C1 device witness. Then Dynamic signs, proves, and submits the testnet deployment.'}</span></ActionHelp>
                </div>
                <div className="passport-command">
                  <button className="key-option-button" onClick={profile ? unlockPassport : enrollPassport} disabled={loading || (!profile && !canCreatePassport)}>
                    {loading ? <LoaderCircle className="spin" size={16} /> : profile ? <Fingerprint size={16} /> : <KeyRound size={16} />}{passportAction}
                  </button>
                  <ActionHelp label="What is a Passport key?"><strong>Local encrypted state</strong><span>A WebAuthn PRF passkey unlocks device and C1 maintenance state. It is separate from Dynamic’s wallet signature and does not contain a wallet seed.</span></ActionHelp>
                </div>
              </div>
              <IconButton label="Refresh Midnight wallet" onClick={refreshWallet} disabled={!midnightWallet || walletSyncing}><RefreshCw className={walletSyncing ? 'spin' : undefined} size={16} /></IconButton>
            </section>

            {workspaceTab === 'assets' ? (
              <>
                <section className="asset-heading">
                  <div><p>Midnight wallet</p><h1>Three address surfaces.</h1></div>
                  <div className="asset-actions">
                    <button className="tool-button" onClick={() => setShowAddressPicker(true)} disabled={!midnightWallet}><Copy size={16} /> Copy address</button>
                    <button className="tool-button" onClick={signMessage} disabled={!midnightWallet || loading}><ShieldCheck size={16} /> Verify</button>
                    <button className="tool-button" onClick={() => setShowTransfer((visible) => !visible)} disabled={!midnightWallet || loading}><Send size={16} /> Send</button>
                    <IconButton label="Register DUST" onClick={registerDust} disabled={!midnightWallet || loading}><DatabaseZap size={16} /></IconButton>
                    <IconButton label="Recover pending transaction" onClick={recoverPending} disabled={!midnightWallet || loading}><RotateCcw size={16} /></IconButton>
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
                      <label>Atomic amount<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1000000" /></label>
                      <button className="send-button" onClick={sendTransfer} disabled={!midnightWallet || loading}><Send size={16} /> Sign and submit</button>
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
                <div className="permission-empty"><span>—</span><div><h2>{permissionState}</h2><p>{passportIsConfirmed ? 'C1 permission reads and writes are the next testnet validation step.' : passportIsDeployed ? 'The deployment has a real transaction hash. Wait for testnet finality before changing contract permissions.' : 'Deploy the Passport account-management contract before permissions become available. This interface does not invent or simulate grants.'}</p></div></div>
                <div className="permission-capabilities"><div><Fingerprint size={17} /><span>Passport key</span><strong>{profile ? 'Local key ready' : 'Required at deploy'}</strong></div><div><WalletCards size={17} /><span>Midnight wallet</span><strong>{midnightWallet ? 'Connected' : 'Awaiting wallet'}</strong></div><div><LockKeyhole size={17} /><span>Contract grants</span><strong>{passportIsConfirmed ? 'Ready for validation' : passportIsDeployed ? 'Awaiting finality' : 'Deployment required'}</strong></div></div>
              </section>
            )}

            <section className="activity-section">
              <div className="activity-heading"><div><p>Activity</p><h2>Network record</h2></div><Activity size={20} /></div>
              {activity.length === 0 ? <div className="activity-empty"><Activity size={17} /> Real wallet and Passport events appear here.</div> : <div className="activity-list">{activity.map((entry) => <button className="activity-row" key={entry.id} onClick={() => setSelectedTx(entry)}><span className="activity-dot"><Activity size={14} /></span><span className="activity-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span><ActivityPill status={entry.status} /><time>{formatTime(entry.createdAt)}</time><ArrowUpRight size={16} /></button>)}</div>}
            </section>
          </main>
        </section>
      )}

      {selectedTx && <TransactionModal entry={selectedTx} onClose={() => setSelectedTx(null)} />}
      {showAddressPicker && <AddressPickerModal choices={addressChoices} onClose={() => setShowAddressPicker(false)} />}
      {showPassportSetup && <PassportSetupModal onClose={() => setShowPassportSetup(false)} onContinue={() => { setShowPassportSetup(false); void deployPassport(); }} />}
    </div>
  );
}

function TransactionModal({ entry, onClose }: { entry: ActivityEntry; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="transaction-modal" role="dialog" aria-modal="true" aria-label="Transaction detail" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p>Transaction detail</p><h2>{entry.label}</h2></div><IconButton label="Close transaction detail" onClick={onClose}><X size={16} /></IconButton></div>
        <dl><div><dt>Status</dt><dd><ActivityPill status={entry.status} /></dd></div><div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div><div><dt>Detail</dt><dd>{entry.detail}</dd></div><div><dt>Transaction hash</dt><dd>{entry.txHash ? <code>{entry.txHash}</code> : 'No on-chain transaction was produced.'}</dd></div></dl>
        {entry.txHash && <button className="modal-copy" onClick={() => void copyText(entry.txHash!)}><Copy size={16} /> Copy transaction hash</button>}
      </div>
    </div>
  );
}
