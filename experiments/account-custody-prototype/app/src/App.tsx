import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PassportAccount } from '../../src/wallet/account.js';
import type { Ledger } from '../../src/wallet/contract.js';
import { hexToBytes32 } from '../../src/wallet/hex.js';

import { getMidnight, type Midnight } from './lib/midnight.js';
import { compiledAccountContract, BROWSER_PROVER } from './lib/providers.js';
import { loadSession, saveSession, clearSession, type Session } from './lib/session.js';
import { useTxTask, dismissTask, type TxTask } from './lib/txTracker.js';
import { Busy, Mono, Chip } from './ui.js';

import { OnboardView } from './views/Onboard.js';
import { OverviewView } from './views/Overview.js';
import { WalletPanel } from './views/WalletPanel.js';
import { DevicesPanel } from './views/DevicesPanel.js';
import { GrantsPanel } from './views/GrantsPanel.js';
import { RecoveryPanel } from './views/RecoveryPanel.js';

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
  goToStep: (step: StepId) => void;
}

export type StepId = 1 | 2 | 3 | 4 | 5;
type ViewId = 'overview' | 'assets' | 'grants' | 'devices' | 'recovery';

const STEP_VIEW: Record<StepId, ViewId> = {
  1: 'overview',
  2: 'assets',
  3: 'grants',
  4: 'grants',
  5: 'recovery',
};

const STEPS: { n: StepId; title: string; sub: string }[] = [
  { n: 1, title: 'Onboard', sub: 'Passkey → on-chain account' },
  { n: 2, title: 'Fund the account', sub: 'Night & shielded custody' },
  { n: 3, title: 'Spend via a grant', sub: 'The dApp holds a scoped credential' },
  { n: 4, title: 'Revoke the grant', sub: 'The contract stops honouring it' },
  { n: 5, title: 'Recover from total loss', sub: '2-of-3 shares, fresh device' },
];

export default function App() {
  const [mid, setMid] = useState<Midnight | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const [account, setAccount] = useState<PassportAccount | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [deviceCommitment, setDeviceCommitment] = useState<string | null>(null);
  const [nav, setNav] = useState<{ step: StepId | null; view: ViewId }>({
    step: 1,
    view: 'overview',
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  const log = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogLines((prev) => {
      // StrictMode double-runs effects in dev; drop consecutive repeats.
      if (prev.length > 0 && prev[prev.length - 1].endsWith(`  ${msg}`)) return prev;
      return [...prev.slice(-199), `${time}  ${msg}`];
    });
    console.log(`[passport] ${msg}`);
  }, []);

  // Boot the Midnight context (wallet sync) once.
  useEffect(() => {
    log('connecting to localnet (syncing fee wallet)…');
    getMidnight()
      .then((m) => {
        setMid(m);
        log('localnet connected — fee wallet synced.');
        if (BROWSER_PROVER) {
          log(
            'browser proving enabled — ALL proofs (contract circuits, zswap, dust) are computed in this tab; no proof server.',
          );
        }
      })
      .catch((e) => setBootError(String(e?.message ?? e)));
  }, [log]);

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
    setNav({ step: 1, view: 'overview' });
  }, []);

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

  const goToStep = useCallback((step: StepId) => {
    setNav({ step, view: STEP_VIEW[step] });
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

  if (!mid) {
    return (
      <div className="stage stage-center">
        <BrandMark large />
        <div className="boot-card">
          <Busy label="Connecting to the localnet and syncing the fee wallet…" />
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
          log={log}
          onConnected={(s, a, commitment) => {
            setSession(s);
            setAccount(a);
            setDeviceCommitment(commitment ?? null);
            setNav({ step: 1, view: 'overview' });
          }}
          onReset={resetSession}
        />
        <div className="dock-stack">
          <ProvingDock />
          <ActivityDock lines={logLines} />
        </div>
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
    goToStep,
  };

  const stepDone = journeyProgress(ledger, account);

  return (
    <div className="shell">
      <MobileBar onMenu={() => setDrawerOpen(true)} />
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        open={drawerOpen}
        nav={nav}
        stepDone={stepDone}
        onStep={(s) => {
          goToStep(s);
          setDrawerOpen(false);
        }}
        onView={(view) => {
          setNav({ step: null, view });
          setDrawerOpen(false);
        }}
        round={ledger ? String(ledger.round) : '…'}
        onDisconnect={resetSession}
      />
      <div className="main">
        <HeaderStrip ctx={ctx} />
        <div className="content">
          <div className={`view ${nav.view === 'overview' ? '' : 'view-hidden'}`}>
            <OverviewView ctx={ctx} />
          </div>
          <div className={`view ${nav.view === 'assets' ? '' : 'view-hidden'}`}>
            <WalletPanel ctx={ctx} />
          </div>
          <div className={`view ${nav.view === 'grants' ? '' : 'view-hidden'}`}>
            <GrantsPanel ctx={ctx} revokeBeat={nav.step === 4} />
          </div>
          <div className={`view ${nav.view === 'devices' ? '' : 'view-hidden'}`}>
            <DevicesPanel ctx={ctx} />
          </div>
          <div className={`view ${nav.view === 'recovery' ? '' : 'view-hidden'}`}>
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
    </div>
  );
}

/** Which demo beats are complete — derived from on-chain state, not clicks. */
function journeyProgress(ledger: Ledger | null, account: PassportAccount | null) {
  const grants = ledger ? [...ledger.grants] : [];
  return {
    1: !!account,
    2:
      !!ledger &&
      ([...ledger.night_balances].some(([, v]) => v > 0n) ||
        [...ledger.coins].some(([, q]) => q.value > 0n)),
    3: grants.some(([, g]) => g.spent > 0n),
    4: grants.some(([, g]) => !g.active),
    5: !!ledger && ledger.device_epoch > 0n,
  } as Record<StepId, boolean>;
}

function BrandMark(props: { large?: boolean }) {
  return (
    <div className={`brand ${props.large ? 'brand-large' : ''}`}>
      <svg className="brand-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1.5" y="1.5" width="29" height="29" rx="8" />
        <path
          className="brand-moon"
          d="M20.8 7.4a9.4 9.4 0 1 0 3.6 13.8 7.6 7.6 0 0 1-3.6-13.8z"
        />
      </svg>
      <div className="brand-words">
        <span className="brand-name">Midnight Passport</span>
        <span className="brand-tag">Account-custody prototype</span>
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
  nav: { step: StepId | null; view: ViewId };
  stepDone: Record<StepId, boolean>;
  onStep: (s: StepId) => void;
  onView: (v: ViewId) => void;
  round: string;
  onDisconnect: () => void;
}) {
  return (
    <aside className={`sidebar ${props.open ? 'sidebar-open' : ''}`}>
      <BrandMark />
      <nav className="sidenav">
        <p className="nav-label">Demo flow</p>
        {STEPS.map((s) => {
          const active = props.nav.step === s.n;
          return (
            <button
              key={s.n}
              className={`step ${active ? 'step-active' : ''} ${props.stepDone[s.n] ? 'step-done' : ''}`}
              onClick={() => props.onStep(s.n)}
            >
              <span className="step-num">{`0${s.n}`}</span>
              <span className="step-words">
                <span className="step-title">{s.title}</span>
                <span className="step-sub">{s.sub}</span>
              </span>
              <span className="step-check">{props.stepDone[s.n] ? '✓' : ''}</span>
            </button>
          );
        })}
        <p className="nav-label">Browse</p>
        <button
          className={`step step-flat ${props.nav.view === 'devices' ? 'step-active' : ''}`}
          onClick={() => props.onView('devices')}
        >
          <span className="step-num">∙</span>
          <span className="step-words">
            <span className="step-title">Devices</span>
            <span className="step-sub">Epochs & commitments</span>
          </span>
        </button>
      </nav>
      <footer className="side-foot">
        <div className="side-foot-row">
          <span className="netdot" />
          <span className="side-net">
            localnet · round <span className="side-round">{props.round}</span>
          </span>
          <button className="linkish" onClick={props.onDisconnect}>
            disconnect
          </button>
        </div>
        <ProverChip />
      </footer>
    </aside>
  );
}

function HeaderStrip({ ctx }: { ctx: AppContext }) {
  const { session, ledger } = ctx;
  return (
    <header className="topbar">
      <div className="topbar-id">
        {/* "Passport account" stays verbatim — the e2e harness waits for it. */}
        <span className="eyebrow">Passport account</span>
        <Mono v={session.accountAddress} short className="topbar-addr" />
      </div>
      <div className="topbar-stats">
        <TopStat k="round" v={ledger ? String(ledger.round) : '…'} />
        <TopStat k="epoch" v={ledger ? String(ledger.device_epoch) : '…'} />
        <TopStat k="devices" v={ledger ? String(ledger.device_count) : '…'} />
      </div>
    </header>
  );
}

function TopStat(props: { k: string; v: string }) {
  return (
    <div className="topstat">
      <span className="topstat-k">{props.k}</span>
      <span className="topstat-v" key={props.v}>
        {props.v}
      </span>
    </div>
  );
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
      <p className="provedock-detail">{PHASES[phaseIdx]?.detail} — real proving takes minutes.</p>
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ActivityDock({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
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
