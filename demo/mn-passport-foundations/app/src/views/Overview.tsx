import React from 'react';

import { ViewHeader, Mono, Chip, Field, X } from '../ui.js';
import { FlowDiagram } from './FlowDiagram.js';
import type { AppContext } from '../App.js';

type ExplorerTxStatus = 'landed' | 'pending' | 'recorded';

interface StoredPosition {
  pool?: 'retail' | 'accredited';
  amount?: number;
  apy?: number;
  deposited?: number;
  txId?: string;
}

interface ExplorerRow {
  k: string;
  v: string;
  mono?: boolean;
}

interface ExplorerTx {
  id: string;
  title: string;
  label: string;
  status: ExplorerTxStatus;
  circuit: string;
  txId: string;
  amount?: string;
  timestamp?: string;
  summary: string;
  rows: ExplorerRow[];
  json: Record<string, unknown>;
}

const POOL_LABELS: Record<string, string> = {
  retail: 'Retail Yield Pool',
  accredited: 'Accredited Vault',
};

function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Machine-readable-zone line: uppercase, non-alphanumerics become fillers,
// padded to the classic 44 characters.
function mrzLine(s: string): string {
  return (s.toUpperCase().replace(/[^A-Z0-9]/g, '<') + '<'.repeat(44)).slice(0, 44);
}

function loadPositions(): StoredPosition[] {
  try {
    const raw = localStorage.getItem('passport-foundations-positions');
    const positions = raw ? (JSON.parse(raw) as StoredPosition[]) : [];
    return positions.filter((p) => p && typeof p.txId === 'string' && p.txId.length > 0);
  } catch {
    return [];
  }
}

function fmtExplorerDate(value?: number): string {
  if (!value) return 'recent session';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtNight(value?: number): string {
  if (!Number.isFinite(value)) return '0 Night';
  return `${Math.round(value as number).toLocaleString('en-US')} Night`;
}

function buildExplorerTxs({
  session,
  ledgerRound,
  epoch,
  positions,
}: {
  session: AppContext['session'];
  ledgerRound: string | null;
  epoch: bigint;
  positions: StoredPosition[];
}): ExplorerTx[] {
  const alias = `${session.alias ?? 'bearer'}.night`;
  const depositTxs = [...positions]
    .reverse()
    .slice(0, 5)
    .map((p, index): ExplorerTx => {
      const amount = fmtNight(p.amount);
      const pool = POOL_LABELS[p.pool ?? 'retail'] ?? 'NightFi pool';
      const txId = p.txId ?? 'pending';
      return {
        id: `deposit-${txId}-${index}`,
        title: 'NightFi custody deposit',
        label: 'deposit',
        status: 'landed',
        circuit: 'deposit_night',
        txId,
        amount,
        timestamp: fmtExplorerDate(p.deposited),
        summary: `${amount} moved through the Passport funding rail into the MN Passport custody contract before deployment to ${pool}.`,
        rows: [
          { k: 'Circuit', v: 'deposit_night' },
          { k: 'Network', v: 'Midnight localnet' },
          { k: 'From', v: 'Passport funding rail' },
          { k: 'To', v: session.accountAddress, mono: true },
          { k: 'Amount', v: amount },
          { k: 'Pool', v: pool },
          { k: 'Confirmations', v: '12 / 12' },
          { k: 'Ledger round', v: ledgerRound ?? 'syncing' },
        ],
        json: {
          type: 'custody_deposit',
          status: 'landed',
          network: 'Midnight localnet',
          circuit: 'deposit_night',
          tx_id: txId,
          amount,
          pool,
          custody_account_contract: session.accountAddress,
          owner_identity: alias,
          ledger_round: ledgerRound,
        },
      };
    });

  const identityTx: ExplorerTx = {
    id: `identity-${session.identityRegistrationTxId ?? session.accountAddress}`,
    title: 'Night ID registration',
    label: 'identity',
    status: session.identityRegistrationTxId ? 'landed' : 'pending',
    circuit: 'identity_registry.register',
    txId: session.identityRegistrationTxId ?? 'pending',
    timestamp: session.identityRegistrationTxId ? 'onboarding' : 'awaiting registry',
    summary: `The registry binds ${alias} to this MN Passport custody contract so dApps can use the account as the user identity.`,
    rows: [
      { k: 'Circuit', v: 'identity_registry.register' },
      { k: 'Night ID', v: alias },
      { k: 'Registry', v: session.identityRegistryAddress ?? 'deploying', mono: true },
      { k: 'Custody account', v: session.accountAddress, mono: true },
      { k: 'Device epoch', v: String(epoch) },
      { k: 'Network', v: 'Midnight localnet' },
    ],
    json: {
      type: 'identity_registration',
      status: session.identityRegistrationTxId ? 'landed' : 'pending',
      network: 'Midnight localnet',
      circuit: 'identity_registry.register',
      tx_id: session.identityRegistrationTxId ?? null,
      owner_identity: alias,
      custody_account_contract: session.accountAddress,
      identity_registry_contract: session.identityRegistryAddress ?? null,
      device_epoch: String(epoch),
    },
  };

  return [...depositTxs, identityTx];
}

export function OverviewView({ ctx }: { ctx: AppContext }) {
  const { session, ledger } = ctx;
  const grants = ledger ? [...ledger.grants] : [];
  const epoch = ledger ? ledger.device_epoch : 0n;
  const activeGrants = grants.filter(([, g]) => g.active && g.epoch === epoch).length;
  const shares = ledger ? Number(ledger.recovery_shares.size()) : 0;
  const holder = (
    session.alias ??
    (session.devMode ? 'bearer' : (session.passkey?.label ?? 'bearer'))
  ).toUpperCase();
  const reissued = epoch > 0n;
  const nightTotal = ledger
    ? [...ledger.night_balances].reduce((acc, [, v]) => acc + v, 0n)
    : 0n;
  const coinCount = ledger ? [...ledger.coins].filter(([, q]) => q.value > 0n).length : 0;
  const activeDevices = ledger
    ? [...ledger.devices].filter(([, e]) => e === epoch).length
    : 0;
  const positions = loadPositions();
  const explorerTxs = buildExplorerTxs({
    session,
    ledgerRound: ledger ? String(ledger.round) : null,
    epoch,
    positions,
  });
  const [selectedExplorerTxId, setSelectedExplorerTxId] = React.useState<string | null>(null);
  const [explorerModalTxId, setExplorerModalTxId] = React.useState<string | null>(null);
  const selectedExplorerTx =
    explorerTxs.find((tx) => tx.id === selectedExplorerTxId) ?? explorerTxs[0];
  const explorerModalTx = explorerTxs.find((tx) => tx.id === explorerModalTxId) ?? null;

  React.useEffect(() => {
    if (!explorerModalTxId) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExplorerModalTxId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [explorerModalTxId]);

  const mrz1 = mrzLine(`N<FI${holder}<<MN PASSPORT<WALLET`);
  const mrz2 = mrzLine(
    `${session.accountAddress.slice(0, 20)}<MN<E${String(epoch)}<R${ledger ? String(ledger.round) : ''}`,
  );
  const explorerSnapshot = {
    network: 'Midnight localnet',
    owner_identity: `${session.alias ?? 'bearer'}.night`,
    account_custody_contract: session.accountAddress,
    identity_registry_contract: session.identityRegistryAddress ?? null,
    identity_registration_tx: session.identityRegistrationTxId ?? null,
    ledger_round: ledger ? String(ledger.round) : null,
    device_epoch: String(epoch),
    balances: {
      night_unshielded: String(nightTotal),
      shielded_coin_count: coinCount,
      recovery_shares: shares,
    },
    devices: ledger
      ? [...ledger.devices].map(([commitment, deviceEpoch]) => ({
          commitment: commitment.toString(),
          epoch: String(deviceEpoch),
          active: deviceEpoch === epoch,
        }))
      : [],
    grants: ledger
      ? [...ledger.grants].map(([grant, value]) => ({
          grant: grant.toString(),
          epoch: String(value.epoch),
          color: bytesHex(value.color),
          cap: String(value.cap),
          spent: String(value.spent),
          active: value.active && value.epoch === epoch,
        }))
      : [],
    transactions: explorerTxs.map((tx) => tx.json),
  };

  return (
    <>
      <ViewHeader
        title="Your MN Passport wallet is a contract"
        narration="A personal Compact contract on the Midnight ledger holds this wallet. Everything on this page is read live from chain state — hover any dotted term for what it means."
      />

      <section className="station-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">App Store</p>
            <h2>Launch a dApp from Passport</h2>
          </div>
          <Chip tone="info">single account demo</Chip>
        </div>
        <div className="app-store-grid">
          <button
            className="app-card app-card-live"
            onClick={() => ctx.goToView('flow')}
            data-x="NightFi is intentionally separate from MN Passport. It receives the account context and asks the custody contract to sign the deposit flow."
          >
            <span className="app-logo app-logo-night">N</span>
            <span className="app-copy">
              <strong>NightFi</strong>
              <small>Private yield deposits</small>
            </span>
            <span className="app-action">Open</span>
          </button>
          <button className="app-card" disabled>
            <span className="app-logo app-logo-city">MC</span>
            <span className="app-copy">
              <strong>Midnight City</strong>
              <small>Coming next</small>
            </span>
            <span className="app-action muted">Soon</span>
          </button>
          <button className="app-card" disabled>
            <span className="app-logo app-logo-sig">S</span>
            <span className="app-copy">
              <strong>Sig Network</strong>
              <small>C2C claim path</small>
            </span>
            <span className="app-action muted">Soon</span>
          </button>
        </div>
      </section>

      <section className="doc">
        <header className="doc-head">
          <span className="doc-authority">MN Passport · Localnet</span>
          <span className="doc-type">Private yield custody</span>
        </header>
        <span
          className="doc-chipmark"
          aria-hidden="true"
          data-x="MN Passport wallet cryptography: your device derives the key, the contract verifies the proof, and the app reads the result from ledger state."
        />
        <div className="doc-grid">
          <Field
            k="Holder"
            v={
              <X x="The owner label for this MN Passport wallet. The account is operated by whoever can prove knowledge of an enrolled device secret — derived from your passkey, never stored anywhere (P1).">
                {holder}
              </X>
            }
            big
          />
          <Field
            k="Status"
            v={
              <span data-x="Status derived from on-chain state. VALID means devices at the current epoch are enrolled; REISSUED means the account has been recovered and re-keyed at a new epoch.">
                <Chip stamp tone={reissued ? 'warn' : 'ok'}>
                  {reissued ? `reissued · epoch ${String(epoch)}` : 'valid'}
                </Chip>
              </span>
            }
          />
          <Field
            k="Custody account contract"
            v={
              <X x="The address of your personal MN Passport custody contract. Anyone can verify this wallet state against the ledger; no issuing authority is involved (P8).">
                <Mono v={session.accountAddress} short group />
              </X>
            }
            wide
          />
          <Field
            k="MN Passport ID registry"
            v={
              <X x="The identity registry contract that recorded this handle during onboarding. The readable alias is a UI label; the registry transaction binds it to the custody account contract.">
                <Mono v={session.identityRegistryAddress ?? 'deploying'} short group />
              </X>
            }
            wide
          />
          <Field
            k="Identity tx"
            v={
              <X x="The transaction that registered this Night ID to the MN Passport custody account.">
                <Mono v={session.identityRegistrationTxId ?? 'pending'} short group />
              </X>
            }
            wide
          />
          <Field
            k="Issuing round"
            v={
              <X x="The current ledger round. Every authorised operation bumps an internal round counter, so a captured transaction can never be replayed.">
                {ledger ? String(ledger.round) : '…'}
              </X>
            }
          />
          <Field
            k="Device epoch"
            v={
              <X x="Bumped by recovery: every device and grant from an earlier epoch instantly stops being honoured by the contract (P4, P5).">
                {String(epoch)}
              </X>
            }
          />
          <Field
            k="Devices"
            v={
              <X x="Devices enrolled at the current epoch. Every one is a first-class peer: any device can act, enrol another, or revoke one (P3).">
                {ledger ? String(activeDevices) : '…'}
              </X>
            }
          />
          <Field
            k="Active grants"
            v={
              <X x="Scoped credentials issued to dApps — operation × token colour × cumulative cap, enforced by the contract circuit, not by the dApp (P7).">
                {ledger ? String(activeGrants) : '…'}
              </X>
            }
          />
          <Field
            k="Recovery shares"
            v={
              <X x="The recovery secret is split 2-of-3. Any two shares reconstruct it, re-key the account, and retire every old device — total loss is survivable (P5).">
                {ledger ? `${shares} — any 2 of 3` : '…'}
              </X>
            }
          />
        </div>
        <div
          className="doc-mrz"
          data-x="Machine-readable wallet line — decorative here, derived from the holder, the contract address, the epoch, and the round."
        >
          <span>{mrz1}</span>
          <span>{mrz2}</span>
        </div>
      </section>

      <div className="tiles">
        <button
          className="tile"
          onClick={() => ctx.goToView('assets')}
          data-x="Assets held by your contract — custody is enforced by its circuits, not by this app. Balances are read live from the ledger."
        >
          <span className="tile-k">Holdings</span>
          <span className="tile-v">
            {ledger ? String(nightTotal) : '…'} <small>NIGHT</small>
          </span>
          <span className="tile-sub">
            {coinCount > 0 ? `+ ${coinCount} shielded asset${coinCount > 1 ? 's' : ''}` : 'no shielded assets yet'}
          </span>
        </button>
        <button
          className="tile"
          onClick={() => ctx.goToView('grants')}
          data-x="Connections are scoped credentials handed to dApps — like OAuth scopes, except the ledger itself enforces them at proof verification (P7)."
        >
          <span className="tile-k">Connections</span>
          <span className="tile-v">{ledger ? activeGrants : '…'}</span>
          <span className="tile-sub">active scoped grants</span>
        </button>
        <button
          className="tile"
          onClick={() => ctx.goToView('devices')}
          data-x="Every enrolled device is a first-class peer — no primary device, no backup hierarchy (P3)."
        >
          <span className="tile-k">Devices</span>
          <span className="tile-v">{ledger ? activeDevices : '…'}</span>
          <span className="tile-sub">enrolled at epoch {String(epoch)}</span>
        </button>
        <button
          className="tile"
          onClick={() => ctx.goToView('recovery')}
          data-x="Losing every device does not lose the account: any two of the three on-chain shares restore the same account — same name, balances, and history (P5)."
        >
          <span className="tile-k">Recovery</span>
          <span className="tile-v">
            2 <small>of</small> 3
          </span>
          <span className="tile-sub">{shares === 3 ? 'kit ready' : `${shares} shares on-chain`}</span>
        </button>
      </div>

      <section className="station-section explorer-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Local explorer</p>
            <h2>Account custody inspection</h2>
          </div>
          <Chip tone={ledger ? 'ok' : 'muted'}>
            {ledger ? `${explorerTxs.length} records synced` : 'syncing'}
          </Chip>
        </div>
        <div className="explorer-grid">
          <div className="explorer-ledger">
            <div className="explorer-kpis">
              <div>
                <span>Contract</span>
                <Mono v={session.accountAddress} short group />
              </div>
              <div>
                <span>Identity tx</span>
                <Mono v={session.identityRegistrationTxId ?? 'pending'} short group />
              </div>
              <div>
                <span>Devices</span>
                <strong>{ledger ? activeDevices : '...'}</strong>
              </div>
              <div>
                <span>Grants</span>
                <strong>{ledger ? activeGrants : '...'}</strong>
              </div>
            </div>
            <div className="explorer-timeline">
              <div className="explorer-subhead">
                <span>Transaction timeline</span>
                <small>latest first</small>
              </div>
              {explorerTxs.map((tx) => (
                <button
                  key={tx.id}
                  type="button"
                  className={`explorer-tx-card ${selectedExplorerTx?.id === tx.id ? 'active' : ''}`}
                  onClick={() => setSelectedExplorerTxId(tx.id)}
                >
                  <span className={`explorer-status ${tx.status}`}>{tx.status}</span>
                  <span className="explorer-tx-main">
                    <strong>{tx.title}</strong>
                    <small>{tx.circuit}</small>
                  </span>
                  <span className="explorer-tx-meta">
                    {tx.amount && <span>{tx.amount}</span>}
                    <Mono v={tx.txId} short />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <aside className="explorer-inspector">
            <div className="explorer-inspector-head">
              <div>
                <span className="explorer-inspector-label">Transaction inspector</span>
                <h3>{selectedExplorerTx.title}</h3>
              </div>
              <span className={`explorer-status ${selectedExplorerTx.status}`}>
                {selectedExplorerTx.status}
              </span>
            </div>
            <p>{selectedExplorerTx.summary}</p>
            <button
              type="button"
              className="explorer-hash explorer-hash-button"
              onClick={() => setExplorerModalTxId(selectedExplorerTx.id)}
              aria-label={`Open transaction ${selectedExplorerTx.txId} in the local explorer`}
            >
              <span>Tx hash</span>
              <Mono v={selectedExplorerTx.txId} short group />
              <small>Open explorer view</small>
            </button>
            <div className="explorer-detail-grid">
              {selectedExplorerTx.rows.map((row) => (
                <div key={`${selectedExplorerTx.id}-${row.k}`}>
                  <span>{row.k}</span>
                  {row.mono ? <Mono v={row.v} short group /> : <strong>{row.v}</strong>}
                </div>
              ))}
            </div>
            <details className="explorer-raw">
              <summary>Raw explorer payload</summary>
              <pre className="explorer-json">
                {JSON.stringify(
                  { selected_transaction: selectedExplorerTx.json, account_snapshot: explorerSnapshot },
                  null,
                  2,
                )}
              </pre>
            </details>
          </aside>
        </div>
      </section>

      {explorerModalTx && (
        <div
          className="explorer-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="explorer-modal-title"
          onClick={() => setExplorerModalTxId(null)}
        >
          <section className="explorer-modal" onClick={(event) => event.stopPropagation()}>
            <header className="explorer-modal-head">
              <div>
                <span className="explorer-inspector-label">Explorer transaction detail</span>
                <h3 id="explorer-modal-title">{explorerModalTx.title}</h3>
              </div>
              <button
                type="button"
                className="btn btn-ghost explorer-modal-close"
                onClick={() => setExplorerModalTxId(null)}
              >
                Close
              </button>
            </header>

            <div className="explorer-modal-hero">
              <span className={`explorer-status ${explorerModalTx.status}`}>
                {explorerModalTx.status}
              </span>
              <div className="explorer-modal-hash">
                <span>Full transaction hash</span>
                <code>{explorerModalTx.txId}</code>
              </div>
            </div>

            <p className="explorer-modal-summary">{explorerModalTx.summary}</p>

            <div className="explorer-modal-grid">
              {explorerModalTx.rows.map((row) => (
                <div key={`modal-${explorerModalTx.id}-${row.k}`}>
                  <span>{row.k}</span>
                  {row.mono ? <code>{row.v}</code> : <strong>{row.v}</strong>}
                </div>
              ))}
            </div>

            <details className="explorer-raw explorer-modal-raw" open>
              <summary>Local explorer payload</summary>
              <pre className="explorer-json explorer-modal-json">
                {JSON.stringify(
                  { selected_transaction: explorerModalTx.json, account_snapshot: explorerSnapshot },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        </div>
      )}

      <FlowDiagram ctx={ctx} />
    </>
  );
}
