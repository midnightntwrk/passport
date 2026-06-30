import React, { useEffect, useMemo, useState } from 'react';

import type { AppContext } from '../App.js';
import { beginTask, completeTask, failTask } from '../lib/txTracker.js';
import {
  loadAliasForAccount,
  normalizeAlias,
  saveAlias,
} from '../lib/session.js';
import { registerIdentity } from '../lib/midnight.js';

type Scene = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type PoolKey = 'retail' | 'accredited';
type TxStatus = 'awaiting' | 'confirming' | 'confirmed' | 'error';

const POOLS: Record<
  PoolKey,
  {
    name: string;
    serif: string;
    tier: string;
    apy: number;
    cap: string;
    lockup: string;
    tvl: string;
    desc: string;
  }
> = {
  retail: {
    name: 'Retail Yield',
    serif: 'Pool',
    tier: 'Tier 01',
    apy: 7.42,
    cap: '$5,000',
    lockup: 'None',
    tvl: '$12.8M',
    desc: 'Permissionless. No verification required. Capital flows into blue-chip on-chain credit markets.',
  },
  accredited: {
    name: 'Accredited',
    serif: 'Vault',
    tier: 'Tier 02',
    apy: 14.8,
    cap: 'Up to $5B',
    lockup: '30 days',
    tvl: '$284M',
    desc: 'Accredited investors only. Eligibility proven through ZK-attestation, never your identity.',
  },
};

const STEPS = [
  'Choose pool',
  'Set amount',
  'Source funds',
  'Custody deposit',
  'Verify Night ID',
  'Deploy capital',
  'Manage positions',
];

interface Position {
  pool: PoolKey;
  amount: number;
  apy: number;
  earned: number;
  deposited: number;
  txId: string;
}

const fmtUsd = (value: number | string) => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '$0';
  return `$${Math.round(n).toLocaleString('en-US')}`;
};

const fmtUsdDec = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtNight = (value: number | string) => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0 Night';
  return `${Math.round(n).toLocaleString('en-US')} Night`;
};

const shortMiddle = (value: string, head = 16, tail = 10) =>
  value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;

export function FoundationsFlowView({
  ctx,
  onOpenCustody,
  onDisconnect,
}: {
  ctx: AppContext;
  onOpenCustody: () => void;
  onDisconnect: () => void;
}) {
  const storedAlias = loadAliasForAccount(ctx.session.accountAddress)?.alias ?? ctx.session.alias ?? 'bubbles';
  const [scene, setScene] = useState<Scene>(0);
  const [pool, setPool] = useState<PoolKey>('retail');
  const [amount, setAmount] = useState('1000');
  const [nightHandle, setNightHandle] = useState(storedAlias);
  const [showAmount, setShowAmount] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showTx, setShowTx] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>('awaiting');
  const [txStatusText, setTxStatusText] = useState('Awaiting custody deposit...');
  const [txConfirms, setTxConfirms] = useState(0);
  const [txId, setTxId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [positions, setPositions] = useState<Position[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('passport-foundations-positions') ?? '[]') as Position[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('passport-foundations-positions', JSON.stringify(positions));
  }, [positions]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [scene]);

  useEffect(() => {
    if (positions.length === 0) return;
    const t = setInterval(() => {
      setPositions((current) =>
        current.map((p) => {
          const perSecond = (p.amount * (p.apy / 100)) / (365 * 24 * 60 * 60);
          return { ...p, earned: p.earned + perSecond * 2 };
        }),
      );
    }, 2000);
    return () => clearInterval(t);
  }, [positions.length]);

  const ledgerNightTotal = useMemo(
    () => (ctx.ledger ? [...ctx.ledger.night_balances].reduce((sum, [, v]) => sum + v, 0n) : 0n),
    [ctx.ledger],
  );
  const activePool = POOLS[pool];
  const currentStep = positions.length > 0 && scene === 6 ? 6 : scene;

  function pickPool(nextPool: PoolKey) {
    setPool(nextPool);
    setAmount(nextPool === 'retail' ? '1000' : '50000');
    setShowAmount(true);
    setScene(1);
  }

  function proceedToSource() {
    if (Number(amount) <= 0) return;
    setShowAmount(false);
    setShowSource(true);
    setScene(2);
  }

  async function depositFromLocalWallet() {
    setShowSource(false);
    setShowTx(true);
    setScene(3);
    setError('');
    setTxId('');
    setTxConfirms(0);
    setTxStatus('confirming');
    setTxStatusText('Submitting deposit_night from the localnet fee wallet...');
    beginTask('Depositing Night into the MN Passport vault', 'deposit_night');
    try {
      const depositValue = BigInt(Math.max(1, Math.floor(Number(amount))));
      const result = await ctx.account.depositNight(ctx.nightColor, depositValue);
      const id = result.txId;
      setTxId(id);
      setTxConfirms(12);
      setTxStatus('confirmed');
      setTxStatusText('Night deposited into your MN Passport custody account');
      ctx.log(`passport deposit ${amount} -> tx ${id}`);
      await ctx.refreshLedger();
      completeTask(id);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      setTxStatus('error');
      setTxStatusText(message);
      failTask(message);
      setError(message);
    }
  }

  function continueAfterBridge() {
    setShowTx(false);
    setScene(4);
  }

  async function confirmNightId() {
    setError('');
    setBusy('identity');
    try {
      const alias = normalizeAlias(nightHandle || storedAlias || 'bubbles');
      if (ctx.session.alias !== alias || !ctx.session.identityRegistrationTxId) {
        const identity = await registerIdentity(ctx.mid, alias, ctx.session.accountAddress);
        saveAlias(alias, ctx.session.accountAddress, {
          identityRegistryAddress: identity.registryAddress,
          identityRegistrationTxId: identity.txId,
        });
        ctx.setSession({
          ...ctx.session,
          alias,
          identityRegistryAddress: identity.registryAddress,
          identityRegistrationTxId: identity.txId,
        });
        ctx.log(`identity registry updated ${alias}.night -> ${ctx.session.accountAddress} tx ${identity.txId}`);
      } else {
        ctx.log(
          `identity registry verified ${alias}.night -> ${ctx.session.accountAddress} tx ${ctx.session.identityRegistrationTxId}`,
        );
      }
      setNightHandle(alias);
      setScene(5);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  }

  async function deployCapital() {
    setBusy('deploy');
    setError('');
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      setPositions((current) => [
        ...current,
        {
          pool,
          amount: Number(amount),
          apy: activePool.apy,
          earned: 0,
          deposited: Date.now(),
          txId,
        },
      ]);
      ctx.log(`passport position opened: ${fmtNight(amount)} -> ${activePool.name} ${activePool.serif}`);
      setShowSuccess(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  }

  function finishDeploy() {
    setShowSuccess(false);
    setScene(6);
  }

  function startNew() {
    setAmount(pool === 'retail' ? '1000' : '50000');
    setTxId('');
    setShowSuccess(false);
    setScene(0);
  }

  return (
    <main className="nf-app passport-nf" data-theme="light">
      <div className="nf-grid-bg" />
      <div className="nf-vignette" />

      <Topbar
        round={ctx.ledger ? String(ctx.ledger.round) : '...'}
        handle={nightHandle}
        hasPositions={positions.length > 0}
        scene={scene}
        onEarn={() => setScene(0)}
        onDashboard={() => positions.length > 0 && setScene(6)}
        onOpenCustody={onOpenCustody}
        onDisconnect={onDisconnect}
      />

      <Rail scene={currentStep} />

      <div className="nf-stage">
        <div className="nf-stage-inner">
          {scene === 0 && <SceneYield onPick={pickPool} ledgerNightTotal={ledgerNightTotal} />}
          {scene === 4 && (
            <SceneNightId
              handle={nightHandle}
              error={error}
              busy={busy === 'identity'}
              onChange={setNightHandle}
              onClaim={confirmNightId}
            />
          )}
          {scene === 5 && (
            <SceneDeploy
              pool={pool}
              amount={amount}
              handle={nightHandle}
              txId={txId}
              busy={busy === 'deploy'}
              error={error}
              onBack={() => setScene(4)}
              onDeploy={deployCapital}
            />
          )}
          {scene === 6 && (
            <SceneDashboard handle={nightHandle} positions={positions} onNew={startNew} />
          )}
        </div>
      </div>

      {showAmount && (
        <DepositModal
          pool={pool}
          amount={amount}
          onAmount={setAmount}
          onClose={() => {
            setShowAmount(false);
            setScene(0);
          }}
          onContinue={proceedToSource}
        />
      )}

      {showSource && (
        <SourceModal
          amount={amount}
          accountAddress={ctx.session.accountAddress}
          walletNightTotal={ledgerNightTotal}
          onClose={() => {
            setShowSource(false);
            setScene(0);
          }}
          onContinue={depositFromLocalWallet}
        />
      )}

      {showTx && (
        <TxModal
          amount={amount}
          txId={txId}
          confirms={txConfirms}
          status={txStatus}
          statusText={txStatusText}
          onClose={() => setShowTx(false)}
          onContinue={continueAfterBridge}
        />
      )}

      {showSuccess && (
        <SuccessModal
          pool={`${activePool.name} ${activePool.serif}`}
          amount={amount}
          apy={activePool.apy}
          onContinue={finishDeploy}
        />
      )}
    </main>
  );
}

export function FoundationsLogo() {
  return (
    <svg viewBox="0 0 789.37 789.37" role="img" aria-label="MN Passport" width="100%" height="100%">
      <path
        d="m394.69,0C176.71,0,0,176.71,0,394.69s176.71,394.69,394.69,394.69,394.69-176.71,394.69-394.69S612.67,0,394.69,0Zm0,716.6c-177.5,0-321.91-144.41-321.91-321.91S217.18,72.78,394.69,72.78s321.91,144.41,321.91,321.91-144.41,321.91-321.91,321.91Z"
        fill="currentColor"
      />
      <rect x="357.64" y="357.64" width="74.09" height="74.09" fill="currentColor" />
      <rect x="357.64" y="240.66" width="74.09" height="74.09" fill="currentColor" />
      <rect x="357.64" y="123.69" width="74.09" height="74.09" fill="currentColor" />
    </svg>
  );
}

function Topbar(props: {
  round: string;
  handle: string;
  hasPositions: boolean;
  scene: Scene;
  onEarn: () => void;
  onDashboard: () => void;
  onOpenCustody: () => void;
  onDisconnect: () => void;
}) {
  const dashboard = props.scene === 6;
  return (
    <div className="nf-top">
      <div className="nf-brand">
        <div className="nf-mark">
          <FoundationsLogo />
        </div>
        <div className="nf-word">
          <span className="night">MN</span>
          <span className="fi">Passport</span>
        </div>
      </div>
      <div className="nf-tabs">
        <button className={`nf-tab ${!dashboard ? 'active' : ''}`} onClick={props.onEarn}>
          Earn
        </button>
        <button
          className={`nf-tab ${dashboard ? 'active' : ''}`}
          onClick={props.onDashboard}
          disabled={!props.hasPositions}
        >
          Dashboard
        </button>
      </div>
      <div className="nf-top-right">
        <div className="nf-net">
          <span className="dot" />
          <span>Localnet</span>
          <span className="muted-dot">·</span>
          <span className="block">round {props.round}</span>
        </div>
        <div className="nf-handle-chip">
          <span className="nf-handle-avatar">{props.handle.slice(0, 2).toUpperCase()}</span>
          <span className="nf-handle-name">
            <span className="user">{props.handle || 'you'}</span>
            <span className="suffix">.night</span>
          </span>
        </div>
        <button className="nf-ghost-top" onClick={props.onOpenCustody}>
          Custody details
        </button>
        <button className="nf-iconbtn" onClick={props.onDisconnect} title="Disconnect">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5M21 12H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Rail({ scene }: { scene: Scene }) {
  return (
    <div className="nf-rail">
      {STEPS.map((label, index) => (
        <React.Fragment key={label}>
          <span className={`nf-rail-step ${index < scene ? 'done' : ''} ${index === scene ? 'active' : ''}`}>
            <span className="num">{String(index + 1).padStart(2, '0')}</span>
            {label}
          </span>
          {index < STEPS.length - 1 && <span className="nf-rail-sep" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function SceneYield({
  onPick,
  ledgerNightTotal,
}: {
  onPick: (p: PoolKey) => void;
  ledgerNightTotal: bigint;
}) {
  return (
    <div className="nf-scene">
      <div className="nf-scene-head">
        <div className="nf-eyebrow">MN Passport foundations</div>
        <h1 className="nf-title">
          Earn yield, <span className="serif">privately.</span>
        </h1>
        <p className="nf-sub-text">
          Choose a pool, source funds through your MN Passport custody account, bind a Night ID, and
          deploy capital. The deposit step is a real Midnight localnet custody transaction.
        </p>
      </div>

      <div className="nf-market">
        <MarketCell label="Total value locked" value="$296.8M" delta="+2.4%" />
        <MarketCell label="Custody balance" value={fmtNight(ledgerNightTotal.toString())} />
        <MarketCell label="Active depositors" value="14,892" />
        <MarketCell label="Yield distributed" value="$8.4M" />
      </div>

      <div className="nf-pools">
        <PoolCard poolKey="retail" onClick={() => onPick('retail')} />
        <PoolCard poolKey="accredited" onClick={() => onPick('accredited')} />
      </div>
    </div>
  );
}

function MarketCell(props: { label: string; value: string; delta?: string }) {
  return (
    <div className="nf-market-cell">
      <div className="nf-market-label">{props.label}</div>
      <div className="nf-market-val">
        {props.value}
        {props.delta && <span className="delta">{props.delta}</span>}
      </div>
    </div>
  );
}

function PoolCard({ poolKey, onClick }: { poolKey: PoolKey; onClick: () => void }) {
  const p = POOLS[poolKey];
  return (
    <button className={`nf-pool ${poolKey === 'accredited' ? 'b' : ''}`} onClick={onClick}>
      <div className="accent-line" />
      <div className="glow" />
      <div className="nf-pool-inner">
        <div className="nf-pool-head">
          <div className="nf-tags">
            <span className={`nf-pool-tag ${poolKey === 'accredited' ? 'tier2' : 'tier1'}`}>
              {p.tier}
            </span>
            <span className="nf-pool-tag zk">
              {poolKey === 'accredited' ? 'ZK-Accredited' : 'Open access'}
            </span>
          </div>
          <div className="nf-pool-icon">+</div>
        </div>
        <div className="nf-pool-name">
          {p.name} <span className="serif">{p.serif}</span>
        </div>
        <div className="nf-pool-desc">{p.desc}</div>
        <div className="nf-apy-row">
          <div>
            <div className="nf-apy-label">Net APY</div>
            <div className="nf-apy-val">
              {p.apy}
              <span className="pct">%</span>
            </div>
          </div>
          <svg className="nf-spark" viewBox="0 0 120 36" fill="none">
            <path d="M0,28 L15,24 L30,26 L45,18 L60,20 L75,14 L90,15 L105,8 L120,10" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </div>
        <div className="nf-meta">
          <Meta label="TVL" value={p.tvl} />
          <Meta label="Cap / wallet" value={p.cap} gold={poolKey === 'accredited'} />
          <Meta label="Lockup" value={p.lockup} />
        </div>
        <div className="nf-pool-cta">
          <span>Deposit into {poolKey === 'accredited' ? 'vault' : 'pool'}</span>
          <span className="arrow">{'->'}</span>
        </div>
      </div>
    </button>
  );
}

function Meta(props: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="nf-meta-cell">
      <div className="nf-meta-label">{props.label}</div>
      <div className={`nf-meta-val ${props.gold ? 'gold' : ''}`}>{props.value}</div>
    </div>
  );
}

function DepositModal(props: {
  pool: PoolKey;
  amount: string;
  onAmount: (v: string) => void;
  onClose: () => void;
  onContinue: () => void;
}) {
  const isRetail = props.pool === 'retail';
  const presets = isRetail ? [500, 1000, 2500, 5000] : [50000, 250000, 1000000, 5000000];
  return (
    <div className="nf-mb" onClick={props.onClose}>
      <div className="nf-modal" onClick={(e) => e.stopPropagation()}>
        <ModalHead title={`Deposit · ${POOLS[props.pool].name} ${POOLS[props.pool].serif}`} onClose={props.onClose} />
        <div className="nf-modal-body">
          <div className="nf-flbl">
            <span>Deposit amount</span>
            <button className="max" onClick={() => props.onAmount(String(isRetail ? 5000 : 5000000))}>
              Max
            </button>
          </div>
          <div className="nf-amt">
            <input value={props.amount} onChange={(e) => props.onAmount(e.target.value)} type="number" autoFocus />
            <span className="nf-amt-cur">Night</span>
          </div>
          <div className="nf-quick">
            {presets.map((n) => (
              <button key={n} className={Number(props.amount) === n ? 'active' : ''} onClick={() => props.onAmount(String(n))}>
                {n >= 1_000_000 ? `$${n / 1_000_000}M` : `$${n / 1000}K`}
              </button>
            ))}
          </div>
          <div className={`nf-banner ${isRetail ? '' : 'warn'}`}>
            <div className="nf-banner-icon">i</div>
            <div>
              <div className="nf-banner-title">
                {isRetail ? 'Retail tier - open access' : 'Accredited tier - verification required'}
              </div>
              <div className="nf-banner-desc">
                This demo submits a real deposit_night transaction into your MN Passport custody
                account on Midnight localnet.
              </div>
            </div>
          </div>
          <button className={`nf-btn ${isRetail ? '' : 'b'}`} disabled={Number(props.amount) <= 0} onClick={props.onContinue}>
            Continue - choose source
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceModal(props: {
  amount: string;
  accountAddress: string;
  walletNightTotal: bigint;
  onClose: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="nf-mb" onClick={props.onClose}>
      <div className="nf-modal nf-source-modal" onClick={(e) => e.stopPropagation()}>
        <ModalHead title="Step 02 · Fund custody" onClose={props.onClose} />
        <div className="nf-modal-body">
          <p className="nf-small-copy">
            Depositing <b>{fmtNight(props.amount)}</b> from the synced localnet fee wallet into your
            MN Passport custody contract. This step is the real Midnight <code>deposit_night</code>
            circuit call.
          </p>
          <div className="nf-witem selected">
            <div className="nf-wicon">MN</div>
            <div className="nf-winfo">
              <div className="nf-wname">
                Localnet fee wallet <span className="nf-recommended">Synced</span>
              </div>
              <div className="nf-waddr">Genesis-funded wallet pays fees and funds custody.</div>
            </div>
            <div className="nf-wbal">
              <div className="nf-wbal-lbl">Available</div>
              <div className="nf-wbal-val">{props.walletNightTotal.toString()} Night</div>
            </div>
          </div>
          <div className="nf-witem">
            <div className="nf-wicon muted">AC</div>
            <div className="nf-winfo">
              <div className="nf-wname">
                MN Passport custody account <span className="nf-recommended muted">Destination</span>
              </div>
              <div className="nf-waddr" title={props.accountAddress}>{shortMiddle(props.accountAddress)}</div>
            </div>
          </div>
          <button className="nf-btn" onClick={props.onContinue}>
            Deposit Night into custody {'->'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TxModal(props: {
  amount: string;
  txId: string;
  confirms: number;
  status: TxStatus;
  statusText: string;
  onClose: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="nf-mb">
      <div className="nf-modal">
        <ModalHead title="Step 03 · Custody deposit" onClose={props.onClose} />
        <div className="nf-modal-body">
          <div className="nf-tx-flow">
            <TxNode label="From" name="Localnet fee wallet" active />
            <div className={`nf-tx-arr ${props.status === 'confirmed' ? '' : 'flowing'}`} />
            <TxNode label="To" name="MN Passport custody" active={props.status === 'confirmed'} />
          </div>
          <div className="nf-tx-rows">
            <TxRow k="Amount" v={fmtNight(props.amount)} />
            <TxRow k="Circuit" v="deposit_night" />
            <TxRow k="Tx hash" v={props.txId || '-'} mono />
            <TxRow k="Confirmations" v={`${props.confirms} / 12`} />
            <TxRow k="Network" v="Midnight localnet" />
          </div>
          <div className={`nf-tx-status ${props.status}`}>{props.statusText}</div>
          <button className="nf-btn" disabled={props.status !== 'confirmed'} onClick={props.onContinue}>
            Continue - verify Night ID
          </button>
        </div>
      </div>
    </div>
  );
}

function SceneNightId(props: {
  handle: string;
  onChange: (v: string) => void;
  onClaim: () => void;
  error: string;
  busy: boolean;
}) {
  const normalized = props.handle.trim().toLowerCase();
  const valid = normalized.length >= 3 && /^[a-z0-9_-]+$/.test(normalized);
  return (
    <div className="nf-scene">
      <div className="nf-scene-head">
        <div className="nf-eyebrow">MN Passport identity</div>
        <h1 className="nf-title">
          Verify your <span className="serif">Night ID.</span>
        </h1>
        <p className="nf-sub-text">
          A human-readable handle bound to your MN Passport custody account through the identity
          registry. The binding is created during onboarding and can be refreshed here.
        </p>
      </div>
      <div className="nf-id-setup">
        <div className="nf-id-card">
          <div className="nf-id-step">Step 1 / 2 - Registry handle</div>
          <div className="nf-id-title">Your Night ID</div>
          <div className="nf-id-input">
            <input value={props.handle} onChange={(e) => props.onChange(e.target.value)} autoFocus />
            <span className="nf-id-suffix">.night</span>
          </div>
          <div className={`nf-avail ${valid ? 'ok' : 'bad'}`}>
            <span className="ind" />
            {valid ? `${normalized}.night is registered` : 'Use 3+ letters, numbers, dash, underscore'}
          </div>
        </div>
        <div className="nf-id-card">
          <div className="nf-id-step">Step 2 / 2 - Bind wallet</div>
          <div className="nf-id-title">Account-backed signing</div>
          <div className="nf-passkey-illu">
            <div className="nf-passkey-asset">
              <div className="nf-passkey-handle">
                <span className="nf-passkey-status" />
                <strong>
                  {normalized || 'bubbles'}
                  <span>.night</span>
                </strong>
              </div>
              <div className="nf-passkey-device">
                <div className="nf-device-screen">
                  <div className="nf-secure-module">✓</div>
                </div>
              </div>
            </div>
          </div>
          <button className="nf-btn" disabled={!valid || props.busy} onClick={props.onClaim}>
            {props.busy ? 'Checking registry...' : 'Continue with registry identity'}
          </button>
          {props.error && <div className="nf-tx-status error">{props.error}</div>}
        </div>
      </div>
    </div>
  );
}

function SceneDeploy(props: {
  pool: PoolKey;
  amount: string;
  handle: string;
  txId: string;
  busy: boolean;
  error: string;
  onBack: () => void;
  onDeploy: () => void;
}) {
  const p = POOLS[props.pool];
  return (
    <div className="nf-scene">
      <div className="nf-scene-head">
        <div className="nf-eyebrow">Capital deployment</div>
        <h1 className="nf-title">
          Deploy into <span className="serif">{p.serif.toLowerCase()}.</span>
        </h1>
        <p className="nf-sub-text">
          Your capital is now held by the MN Passport custody account. Sign the deploy intent to open
          the MN Passport position.
        </p>
      </div>
      <div className="nf-tx-panel">
        <div className="nf-tx-flow">
          <TxNode label="Asset" name={fmtNight(props.amount)} active />
          <div className="nf-tx-arr flowing" />
          <TxNode label="Destination" name={`${p.name} ${p.serif}`} active />
        </div>
        <div className="nf-tx-rows">
          <TxRow k="Pool" v={`${p.name} ${p.serif}`} />
          <TxRow k="Amount" v={fmtNight(props.amount)} />
          <TxRow k="Night ID" v={`${props.handle || 'you'}.night`} />
          <TxRow k="Expected APY" v={`${p.apy}%`} />
          <TxRow k="Custody tx" v={props.txId || '-'} mono />
        </div>
        <div className="nf-row-flex">
          <button className="nf-btn-ghost" onClick={props.onBack} disabled={props.busy}>
            Back
          </button>
          <button className={`nf-btn ${props.busy ? 'nf-btn-busy' : ''}`} onClick={props.onDeploy} disabled={props.busy}>
            {props.busy ? 'Signing deposit...' : 'Sign deposit'}
          </button>
        </div>
        {props.error && <div className="nf-tx-status error">{props.error}</div>}
      </div>
    </div>
  );
}

function SceneDashboard({
  handle,
  positions,
  onNew,
}: {
  handle: string;
  positions: Position[];
  onNew: () => void;
}) {
  const total = positions.reduce((sum, p) => sum + p.amount, 0);
  const earned = positions.reduce((sum, p) => sum + p.earned, 0);
  const blended = total > 0 ? positions.reduce((sum, p) => sum + p.amount * p.apy, 0) / total : 0;
  return (
    <div className="nf-scene">
      <div className="nf-dash-head">
        <div className="nf-dash-id">
          <div className="nf-avatar">{(handle || 'yo').slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="nf-dash-name">
              <span>{handle || 'you'}</span>
              <span className="acc">.night</span>
            </div>
            <div className="nf-dash-sub">
              <span>MN Passport verified</span>
              <span className="nf-verified-pill">localnet</span>
            </div>
          </div>
        </div>
        <button className="nf-btn-ghost" onClick={onNew}>
          + New deposit
        </button>
      </div>
      <div className="nf-dash-stats">
        <DashStat label="Total deposited" value={fmtNight(total)} detail={`${positions.length} active`} />
        <DashStat label="Earned" value={fmtUsdDec(earned)} detail="Streaming" />
        <DashStat label="Blended APY" value={`${blended.toFixed(2)}%`} detail="Real-time" />
        <DashStat label="Positions" value={String(positions.length)} detail="Auto-compounded" />
      </div>
      <div className="nf-pos">
        <div className="nf-pos-row head">
          <div>Pool</div>
          <div>Tier</div>
          <div>Deposited</div>
          <div>Earned</div>
          <div>Status</div>
          <div>Action</div>
        </div>
        {positions.map((p, i) => (
          <div className="nf-pos-row" key={`${p.txId}-${i}`}>
            <div className="nf-pos-pool">
              <span className={`nf-pdot ${p.pool === 'accredited' ? 'b' : 'a'}`} />
              {POOLS[p.pool].name} {POOLS[p.pool].serif}
            </div>
            <div>{POOLS[p.pool].tier}</div>
            <div>{fmtNight(p.amount)}</div>
            <div className="nf-pos-earned">{fmtUsdDec(p.earned)}</div>
            <div className="nf-pos-status active">Active</div>
            <div className="nf-pos-action">
              <button>Manage</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashStat(props: { label: string; value: string; detail: string }) {
  return (
    <div className="nf-dstat">
      <div className="nf-dstat-label">{props.label}</div>
      <div className="nf-dstat-val">{props.value}</div>
      <div className="nf-dstat-delta">{props.detail}</div>
    </div>
  );
}

function SuccessModal(props: {
  pool: string;
  amount: string;
  apy: number;
  onContinue: () => void;
}) {
  return (
    <div className="nf-mb">
      <div className="nf-modal nf-success">
        <div className="nf-success-icon">✓</div>
        <h2>Position opened</h2>
        <p>
          {fmtNight(props.amount)} deployed to {props.pool} at {props.apy}% APY.
        </p>
        <button className="nf-btn" onClick={props.onContinue}>
          View dashboard {'->'}
        </button>
      </div>
    </div>
  );
}

function ModalHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="nf-modal-head">
      <div className="nf-modal-title">
        <span className="acc">//</span>
        <span>{title}</span>
      </div>
      <button className="nf-modal-close" onClick={onClose}>
        x
      </button>
    </div>
  );
}

function TxNode(props: { label: string; name: string; active?: boolean }) {
  return (
    <div className={`nf-tx-node ${props.active ? 'active' : ''}`}>
      <div className="nf-tx-node-icon">N</div>
      <div className="nf-tx-node-label">{props.label}</div>
      <div className="nf-tx-node-name">{props.name}</div>
    </div>
  );
}

function TxRow(props: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="nf-tx-row">
      <span className="k">{props.k}</span>
      <span className={`v ${props.mono ? 'nf-tx-hash' : ''}`}>{props.v}</span>
    </div>
  );
}
