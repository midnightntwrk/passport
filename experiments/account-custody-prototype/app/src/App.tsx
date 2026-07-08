import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DynamicWidget,
  useDynamicContext,
  useUserWallets,
} from '@dynamic-labs/sdk-react-core';
import { WalletAddressType } from '@dynamic-labs/sdk-api-core';
import { isMidnightWallet, type MidnightWallet } from '@dynamic-labs/midnight';

import { PassportAccount } from '../../src/wallet/account.js';
import type { Ledger } from '../../src/wallet/contract.js';
import { hexToBytes32 } from '../../src/wallet/hex.js';

import { getMidnight, type Midnight } from './lib/midnight.js';
import { compiledAccountContract, BROWSER_PROVER } from './lib/providers.js';
import { loadSession, saveSession, clearSession, type Session } from './lib/session.js';
import { useTxTask, dismissTask, type TxTask } from './lib/txTracker.js';
import { Busy, Mono, Chip } from './ui.js';

import { OnboardView } from './views/Onboard.js';
import { FoundationsFlowView, FoundationsLogo } from './views/FoundationsFlow.js';
import { OverviewView } from './views/Overview.js';
import { WalletPanel } from './views/WalletPanel.js';
import { DevicesPanel } from './views/DevicesPanel.js';
import { GrantsPanel } from './views/GrantsPanel.js';
import { RecoveryPanel } from './views/RecoveryPanel.js';

function normalizeDynamicHandle(value: string): string {
  const [local] = value.split('@');
  const normalized = local
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length >= 3 ? normalized.slice(0, 24) : 'bubbles';
}

function midnightAdditionalAddress(wallet: MidnightWallet, type: WalletAddressType): string {
  return wallet.additionalAddresses.find((address) => address.type === type)?.address ?? 'pending';
}

export interface AppContext {
  mid: Midnight;
  session: Session;
  account: PassportAccount;
  ledger: Ledger | null;
  refreshLedger: () => Promise<void>;
  log: (msg: string) => void;
  nightColor: Uint8Array;
  resetSession: () => void;
  reconnect: (secrets: {
    deviceSecret?: Uint8Array;
    grantSecret?: Uint8Array;
    recoverySecret?: Uint8Array;
  }) => Promise<PassportAccount>;
  setSession: (s: Session) => void;
  /** Commitment (decimal string) of this browser's device secret, when known. */
  deviceCommitment: string | null;
  setDeviceCommitment: (c: string | null) => void;
  goToView: (view: ViewId) => void;
  dynamicWallet: MidnightWallet | null;
}

export type ViewId = 'flow' | 'overview' | 'assets' | 'grants' | 'devices' | 'recovery';

// App navigation — MN Passport is the product shell; these are the embedded
// custody surfaces behind the earn flow.
const NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  {
    id: 'flow',
    label: 'Foundations Flow',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M4 6h8a4 4 0 0 1 4 4v8" />
        <path d="M4 6l3.5-3.5M4 6l3.5 3.5" />
        <circle cx="16" cy="18" r="2.5" />
      </svg>
    ),
  },
  {
    id: 'overview',
    label: 'Wallet Overview',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
        <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
        <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
        <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
      </svg>
    ),
  },
  {
    id: 'assets',
    label: 'Holdings',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="3" y="6" width="18" height="13" rx="2.5" />
        <path d="M3 10h18M7 15h4" />
      </svg>
    ),
  },
  {
    id: 'grants',
    label: 'Connections',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2.8v4M12 17.2v4M2.8 12h4M17.2 12h4" />
      </svg>
    ),
  },
  {
    id: 'devices',
    label: 'Devices',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="3" y="5" width="13" height="9" rx="1.8" />
        <path d="M6.5 18h6M9.5 14v4" />
        <rect x="17" y="9" width="4.5" height="9" rx="1.4" />
      </svg>
    ),
  },
  {
    id: 'recovery',
    label: 'Recovery',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
        <path d="M9 12l2 2 4-4.5" />
      </svg>
    ),
  },
];

export default function App() {
  const { primaryWallet, user, handleLogOut } = useDynamicContext();
  const userWallets = useUserWallets();
  const [mid, setMid] = useState<Midnight | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const [account, setAccount] = useState<PassportAccount | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [deviceCommitment, setDeviceCommitment] = useState<string | null>(null);
  const [nav, setNav] = useState<ViewId>('flow');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [explain, setExplain] = useState(() => localStorage.getItem('passport-explain') !== '0');

  const dynamicWallet = useMemo(() => {
    const fromList = userWallets.find((candidate) => isMidnightWallet(candidate));
    if (fromList) return fromList;
    if (primaryWallet && isMidnightWallet(primaryWallet)) return primaryWallet;
    return null;
  }, [primaryWallet, userWallets]);

  const dynamicIdentity = useMemo(() => {
    const profile = user as any;
    const social = profile?.verifiedCredentials?.find?.(
      (credential: any) => credential?.format === 'oauth' || credential?.oauthProvider,
    );
    const candidate =
      social?.oauthUsername ||
      social?.oauthDisplayName ||
      profile?.username ||
      profile?.email ||
      'bubbles';
    return normalizeDynamicHandle(candidate);
  }, [user]);

  // Hover explainers: a body attribute the CSS and the tooltip listen to.
  useEffect(() => {
    document.body.dataset.explain = explain ? '1' : '0';
    localStorage.setItem('passport-explain', explain ? '1' : '0');
  }, [explain]);

  const log = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogLines((prev) => {
      // StrictMode double-runs effects in dev; drop consecutive repeats.
      if (prev.length > 0 && prev[prev.length - 1].endsWith(`  ${msg}`)) return prev;
      return [...prev.slice(-199), `${time}  ${msg}`];
    });
    console.log(`[passport] ${msg}`);
  }, []);

  // Boot the Midnight context only after Dynamic has produced a Midnight wallet.
  // Otherwise the login screen spams localnet websocket retries while Dynamic is
  // still creating or recovering the embedded wallet.
  useEffect(() => {
    if (!dynamicWallet || mid) return;

    log('connecting to localnet (syncing fee wallet)…');
    getMidnight()
      .then((m) => {
        setMid(m);
        log('localnet connected — fee wallet synced.');
        if (BROWSER_PROVER) {
          log(
            'browser proving enabled — ALL proofs (contract circuits, zswap, dust) are computed in this tab; no proof server.',
          );
        } else {
          log('local proof server enabled — reliable mode for the end-to-end demo.');
        }
      })
      .catch((e) => setBootError(String(e?.message ?? e)));
  }, [dynamicWallet, log, mid]);

  const setSession = useCallback((s: Session) => {
    saveSession(s);
    setSessionState(s);
  }, []);

  const resetSession = useCallback(() => {
    clearSession();
    setSessionState(null);
    setAccount(null);
    setLedger(null);
    setDeviceCommitment(null);
    setNav('flow');
  }, []);

  // Lock: drop the in-memory account handle (and with it the device secret's
  // session) but keep the remembered session — the unlock screen re-derives
  // the secret from the passkey.
  const lock = useCallback(() => {
    log('session locked — the device secret is dropped; a passkey re-derives it next time.');
    setAccount(null);
    setLedger(null);
    setDeviceCommitment(null);
    setNav('flow');
  }, [log]);

  const refreshLedger = useCallback(async () => {
    if (!account) return;
    try {
      setLedger(await account.ledgerState());
    } catch (e: any) {
      log(`ledger read failed: ${e?.message ?? e}`);
    }
  }, [account, log]);

  // Poll the ledger while an account is connected.
  useEffect(() => {
    if (!account) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        setLedger(await account.ledgerState());
      } catch {
        /* not indexed yet */
      }
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [account]);

  const reconnect = useCallback(
    async (secrets: {
      deviceSecret?: Uint8Array;
      grantSecret?: Uint8Array;
      recoverySecret?: Uint8Array;
    }) => {
      if (!mid || !session) throw new Error('not connected');
      return PassportAccount.connect(
        mid.accountProviders,
        compiledAccountContract(),
        session.accountAddress,
        secrets,
      );
    },
    [mid, session],
  );

  const nightColor = useMemo(
    () => (mid ? hexToBytes32(mid.nightColorHex) : new Uint8Array(32)),
    [mid],
  );

  const goToView = useCallback((view: ViewId) => {
    setNav(view);
  }, []);

  if (bootError) {
    return (
      <div className="stage stage-center">
        <BrandMark large />
        <div className="panel boot-card">
          <h2 className="eyebrow">Cannot reach the localnet</h2>
          <p className="error">{bootError}</p>
          <p className="hint">
            Start it with <code>cd infra && docker compose -f docker-compose.yml -f
            docker-compose.macos.yml up -d --wait</code> and reload.
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="stage stage-onboard">
        <div className="onboard-top">
          <BrandMark />
          <ProverChip />
        </div>
        <DynamicGate
          title="Sign in with Dynamic first."
          copy="Use Discord in the Dynamic modal, then MN Passport will create or unlock the custody account for the same session."
        />
        <div className="dock-stack">
          <ProvingDock />
          <ActivityDock lines={logLines} />
        </div>
        <ExplainTip />
      </div>
    );
  }

  if (!dynamicWallet) {
    return (
      <div className="stage stage-onboard">
        <div className="onboard-top">
          <BrandMark />
          <button className="linkish" onClick={() => handleLogOut()}>
            log out
          </button>
        </div>
        <DynamicGate
          title="Creating your Dynamic Midnight wallet."
          copy="Auth is connected. Waiting for Dynamic to return the embedded Midnight wallet object with unshielded, shielded, and DUST address surfaces."
        />
        <div className="dock-stack">
          <ProvingDock />
          <ActivityDock lines={logLines} />
        </div>
        <ExplainTip />
      </div>
    );
  }

  if (!mid) {
    return (
      <div className="stage stage-center">
        <BrandMark large />
        <div className="boot-card">
          <Busy label="Connecting to the localnet and syncing the fee wallet…" />
          <div className="dynamic-wallet-ready">
            <p className="eyebrow">Dynamic Midnight wallet ready</p>
            <div className="dynamic-wallet-row">
              <span>wallet.address</span>
              <Mono v={dynamicWallet.address} />
            </div>
            <div className="dynamic-wallet-row">
              <span>midnight_shielded</span>
              <Mono v={midnightAdditionalAddress(dynamicWallet, WalletAddressType.MidnightShielded)} />
            </div>
            <div className="dynamic-wallet-row">
              <span>midnight_dust</span>
              <Mono v={midnightAdditionalAddress(dynamicWallet, WalletAddressType.MidnightDust)} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Onboarding: no account session, or session but account handle not yet
  // re-established (page reload → re-derive device secret from passkey).
  if (!session || !account) {
    return (
      <div className="stage stage-onboard">
        <div className="onboard-top">
          <BrandMark />
          <ProverChip />
        </div>
        <OnboardView
          mid={mid}
          session={session}
          dynamicIdentity={dynamicIdentity}
          dynamicWallet={dynamicWallet}
          log={log}
          onConnected={(s, a, commitment) => {
            setSession(s);
            setAccount(a);
            setDeviceCommitment(commitment ?? null);
            setNav('flow');
          }}
          onReset={resetSession}
        />
        <div className="dock-stack">
          <ProvingDock />
          <ActivityDock lines={logLines} />
        </div>
        <ExplainTip />
      </div>
    );
  }

  const ctx: AppContext = {
    mid,
    session,
    account,
    ledger,
    refreshLedger,
    log,
    nightColor,
    resetSession,
    reconnect,
    setSession,
    deviceCommitment,
    setDeviceCommitment,
    goToView,
    dynamicWallet,
  };

  if (nav === 'flow') {
    return (
      <div className="foundations-page">
        <FoundationsFlowView
          ctx={ctx}
          onOpenCustody={() => setNav('assets')}
          onDisconnect={resetSession}
        />
        <div className="nf-demo-docks">
          <ProvingDock />
          <ActivityDock lines={logLines} defaultOpen={false} />
        </div>
        <ExplainTip />
      </div>
    );
  }

  const counts = navCounts(ledger);

  return (
    <div className="shell">
      <MobileBar onMenu={() => setDrawerOpen(true)} />
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        open={drawerOpen}
        nav={nav}
        counts={counts}
        onView={(view) => {
          goToView(view);
          setDrawerOpen(false);
        }}
        round={ledger ? String(ledger.round) : '…'}
        onDisconnect={resetSession}
      />
      <div className="main">
        <HeaderStrip
          ctx={ctx}
          explain={explain}
          onToggleExplain={() => setExplain((e) => !e)}
          onLock={lock}
        />
        <div className="content">
          <div className={`view ${nav === 'overview' ? '' : 'view-hidden'}`}>
            <OverviewView ctx={ctx} />
          </div>
          <div className={`view ${nav === 'assets' ? '' : 'view-hidden'}`}>
            <WalletPanel ctx={ctx} />
          </div>
          <div className={`view ${nav === 'grants' ? '' : 'view-hidden'}`}>
            <GrantsPanel ctx={ctx} />
          </div>
          <div className={`view ${nav === 'devices' ? '' : 'view-hidden'}`}>
            <DevicesPanel ctx={ctx} />
          </div>
          <div className={`view ${nav === 'recovery' ? '' : 'view-hidden'}`}>
            <RecoveryPanel
              ctx={ctx}
              onRecovered={(s, a, commitment) => {
                setSession(s);
                setAccount(a);
                setDeviceCommitment(commitment ?? null);
              }}
            />
          </div>
        </div>
        <div className="dock-stack">
          <ProvingDock />
          <ActivityDock lines={logLines} />
        </div>
      </div>
      <ExplainTip />
    </div>
  );
}

/** Live counts for the nav badges — derived from on-chain state. */
function navCounts(ledger: Ledger | null): Partial<Record<ViewId, number>> {
  if (!ledger) return {};
  const epoch = ledger.device_epoch;
  return {
    assets:
      [...ledger.night_balances].filter(([, v]) => v > 0n).length +
      [...ledger.coins].filter(([, q]) => q.value > 0n).length,
    grants: [...ledger.grants].filter(([, g]) => g.active && g.epoch === epoch).length,
    devices: [...ledger.devices].filter(([, e]) => e === epoch).length,
  };
}

function BrandMark(props: { large?: boolean }) {
  return (
    <div className={`brand ${props.large ? 'brand-large' : ''}`}>
      <span className="brand-glyph brand-nf-glyph" aria-hidden="true">
        <FoundationsLogo />
      </span>
      <div className="brand-words">
        <span className="brand-name brand-nf-name">
          <span>MN</span>
          <em>Passport</em>
        </span>
      </div>
    </div>
  );
}

function DynamicGate(props: { title: string; copy: string }) {
  return (
    <div className="onboard-grid onboard-grid-narrow dynamic-gate-grid">
      <div className="onboard-copy">
        <PassportDynamicShowcase />
        <p className="eyebrow">Dynamic embedded wallet</p>
        <h1 className="hero-title">{props.title}</h1>
        <p className="lede">{props.copy}</p>
        <ol className="hero-steps">
          <li>
            <span className="hero-step-n">1</span>
            <span>Authenticate with Dynamic using the enabled social provider.</span>
          </li>
          <li>
            <span className="hero-step-n">2</span>
            <span>Dynamic provisions the embedded Midnight wallet for this account.</span>
          </li>
          <li>
            <span className="hero-step-n">3</span>
            <span>MN Passport uses that wallet context before deploying the custody account.</span>
          </li>
        </ol>
      </div>
      <div className="onboard-cards">
        <div className="panel onboard-card dynamic-auth-card">
          <h2 className="eyebrow">Sign in</h2>
          <DynamicWidget />
          <p className="hint">
            Discord appears here when it is enabled for this Dynamic environment.
          </p>
        </div>
      </div>
    </div>
  );
}

function PassportDynamicShowcase() {
  return (
    <div className="passport-showcase passport-showcase-compact dynamic-passport-showcase">
      <div className="passport-showcase-grid" />
      <div className="passport-rings" />
      <div className="passport-demo-card" aria-hidden="true">
        <div className="passport-demo-top">
          <span>DYNAMIC</span>
          <span>MIDNIGHT</span>
        </div>
        <div className="passport-demo-mark">
          <span />
        </div>
        <div className="passport-demo-bottom">
          <small>MN PASSPORT</small>
          <strong>social wallet</strong>
        </div>
      </div>
    </div>
  );
}

function ProverChip() {
  return (
    <Chip tone={BROWSER_PROVER ? 'info' : 'muted'}>
      {BROWSER_PROVER ? 'prover · this device' : 'prover · local server'}
    </Chip>
  );
}

// Compact top bar shown only on narrow screens (the sidebar becomes a drawer).
function MobileBar(props: { onMenu: () => void }) {
  return (
    <div className="mobilebar">
      <button className="menu-btn" onClick={props.onMenu} aria-label="open menu">
        ☰
      </button>
      <BrandMark />
      <span className="mobilebar-spacer" />
      <ProverChip />
    </div>
  );
}

function Sidebar(props: {
  open: boolean;
  nav: ViewId;
  counts: Partial<Record<ViewId, number>>;
  onView: (v: ViewId) => void;
  round: string;
  onDisconnect: () => void;
}) {
  return (
    <aside className={`sidebar ${props.open ? 'sidebar-open' : ''}`}>
      <BrandMark />
      <nav className="sidenav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`step ${props.nav === item.id ? 'step-active' : ''}`}
            onClick={() => props.onView(item.id)}
          >
            <span className="step-ico">{item.icon}</span>
            <span className="step-title">{item.label}</span>
            {props.counts[item.id] !== undefined && (
              <span className="step-n">{props.counts[item.id]}</span>
            )}
          </button>
        ))}
      </nav>
      <footer className="side-foot">
        <div className="side-foot-row">
          <span className="netdot" />
          <span
            className="side-net x"
            data-x="Live connection to the Midnight network. Every balance and status in this app is read from chain state, not from a database; there is no server of ours behind it (P8)."
          >
            localnet · round <span className="side-round">{props.round}</span>
          </span>
          <button className="linkish" onClick={props.onDisconnect}>
            disconnect
          </button>
        </div>
        <p className="side-fine">Self-custodial · no operator</p>
      </footer>
    </aside>
  );
}

function HeaderStrip(props: {
  ctx: AppContext;
  explain: boolean;
  onToggleExplain: () => void;
  onLock: () => void;
}) {
  const { session, ledger } = props.ctx;
  return (
    <header className="topbar">
      <div className="topbar-id">
        <span className="eyebrow">MN Passport custody account</span>
        <span
          className="x"
          data-x="The address of your personal MN Passport custody contract on Midnight. Anyone can verify this wallet state against the ledger."
        >
          <Mono v={session.accountAddress} short className="topbar-addr" />
        </span>
      </div>
      <span className="topbar-spacer" />
      <span
        className="statchip x"
        data-x="The current ledger round and your device epoch. The epoch is bumped by recovery, which instantly retires every previously enrolled device and grant (P4, P5)."
      >
        round <b>{ledger ? String(ledger.round) : '…'}</b> · epoch{' '}
        <b>{ledger ? String(ledger.device_epoch) : '…'}</b>
      </span>
      <span
        className="x"
        data-x={
          BROWSER_PROVER
            ? 'Zero-knowledge proofs are computed on this device by a wasm prover. Transactions leave your hands already proven; no proof server sees your witnesses (P6).'
            : 'Proofs are computed by the local Docker proof server. Add ?prover=browser to opt into experimental on-device proving.'
        }
      >
        <ProverChip />
      </span>
      <button
        className={`xtoggle ${props.explain ? 'xtoggle-on' : ''}`}
        onClick={props.onToggleExplain}
        title="Toggle hover explainers"
      >
        explain · {props.explain ? 'on' : 'off'}
      </button>
      <button className="lockbtn" onClick={props.onLock} title="Lock the session">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="10" width="16" height="11" rx="2.5" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </button>
    </header>
  );
}

/** Floating tooltip for the hover explainers ([data-x] elements). */
function ExplainTip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let current: Element | null = null;
    const place = (e: MouseEvent) => {
      tip.style.left = `${Math.min(e.clientX + 16, window.innerWidth - 350)}px`;
      tip.style.top = `${Math.min(e.clientY + 18, window.innerHeight - tip.offsetHeight - 12)}px`;
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-x]');
      if (!el || document.body.dataset.explain !== '1') return;
      current = el;
      tip.innerHTML =
        '<span class="xtip-k">what you are seeing</span>' +
        ((el as HTMLElement).dataset.x ?? '');
      tip.classList.add('on');
      place(e);
    };
    const move = (e: MouseEvent) => {
      if (!tip.classList.contains('on')) return;
      place(e);
    };
    const out = (e: MouseEvent) => {
      if (current && !current.contains(e.relatedTarget as Node)) {
        tip.classList.remove('on');
        current = null;
      }
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseout', out);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseout', out);
    };
  }, []);
  return <div id="xtip" ref={ref} />;
}

const PHASES: { id: TxTask['phase']; label: string; detail: string }[] = [
  { id: 'build', label: 'Build', detail: 'executing the circuit in this browser' },
  {
    id: 'prove',
    label: 'Prove',
    detail: BROWSER_PROVER
      ? 'computing the zero-knowledge proof in this browser (zkir-v2 wasm)'
      : 'zero-knowledge proof on the proof server',
  },
  { id: 'submit', label: 'Submit', detail: 'balancing, signing & confirming' },
];

function ProvingDock() {
  const task = useTxTask();
  const [, setTick] = useState(0);

  // Tick the elapsed timer while a task is running.
  useEffect(() => {
    if (!task || task.phase === 'done' || task.phase === 'error') return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [task?.id, task?.phase]);

  // Auto-dismiss a landed task after a while.
  useEffect(() => {
    if (!task || task.phase !== 'done') return;
    const t = setTimeout(() => dismissTask(task.id), 45_000);
    return () => clearTimeout(t);
  }, [task?.id, task?.phase]);

  if (!task) return null;

  const elapsed = fmtElapsed((task.endedAt ?? Date.now()) - task.startedAt);
  const phaseIdx = PHASES.findIndex((p) => p.id === task.phase);

  if (task.phase === 'error') {
    return (
      <div className="provedock provedock-error">
        <div className="provedock-row">
          <span className="chip chip-danger">failed</span>
          <span className="provedock-label">{task.label}</span>
          <code className="provedock-circuit">{task.circuit}</code>
          <span className="provedock-spacer" />
          <span className="provedock-msg">{task.error}</span>
          <button className="linkish" onClick={() => dismissTask(task.id)}>
            dismiss
          </button>
        </div>
      </div>
    );
  }

  if (task.phase === 'done') {
    return (
      <div className="provedock provedock-done">
        <div className="provedock-row">
          <span className="chip chip-ok">landed</span>
          <span className="provedock-label">{task.label}</span>
          <code className="provedock-circuit">{task.circuit}</code>
          <span className="provedock-spacer" />
          {task.txId && (
            <>
              <span className="provedock-txk">tx</span> <Mono v={task.txId} short />
            </>
          )}
          <span className="provedock-elapsed">{elapsed}</span>
          <button className="linkish" onClick={() => dismissTask(task.id)}>
            dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="provedock provedock-live">
      <div className="provedock-scan" />
      <div className="provedock-row">
        <span className="provedock-pulse" />
        <span className="provedock-label">{task.label}</span>
        <code className="provedock-circuit">{task.circuit}</code>
        {BROWSER_PROVER && <Chip tone="info">on-device</Chip>}
        <span className="provedock-spacer" />
        <div className="provedock-phases">
          {PHASES.map((p, i) => (
            <span
              key={p.id}
              className={`phase ${i < phaseIdx ? 'phase-done' : ''} ${i === phaseIdx ? 'phase-live' : ''}`}
              title={p.detail}
            >
              {i < phaseIdx ? '✓ ' : ''}
              {p.label}
            </span>
          ))}
        </div>
        <span className="provedock-elapsed">{elapsed}</span>
      </div>
      <p className="provedock-detail">
        {PHASES[phaseIdx]?.detail} — real cryptographic work in progress.
      </p>
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ActivityDock({
  lines,
  defaultOpen,
}: {
  lines: string[];
  defaultOpen?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Collapsed by default on phones — vertical space is the scarce resource.
  const [open, setOpen] = useState(() => defaultOpen ?? window.innerWidth >= 700);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, open]);
  return (
    <div className={`activity ${open ? '' : 'activity-closed'}`}>
      <button className="activity-head" onClick={() => setOpen((o) => !o)}>
        <span className="eyebrow">Activity</span>
        <span className="activity-count">{lines.length}</span>
        <span className="activity-toggle">{open ? '▾' : '▴'}</span>
      </button>
      {open && (
        <div className="activity-body" ref={ref}>
          {lines.length === 0 && <div className="activity-line dim">no activity yet</div>}
          {lines.map((l, i) => (
            <ActivityLine key={i} line={l} />
          ))}
        </div>
      )}
    </div>
  );
}

// Render "… → tx <id>" suffixes as copyable chips, keep the rest verbatim.
function ActivityLine({ line }: { line: string }) {
  const m = line.match(/^(.*→ tx )([0-9a-fA-F]{16,})(.*)$/);
  if (!m) return <div className="activity-line">{line}</div>;
  return (
    <div className="activity-line">
      {m[1]}
      <Mono v={m[2]} short />
      {m[3]}
    </div>
  );
}
