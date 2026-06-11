import React from 'react';

import { Panel, Mono } from '../ui.js';
import { useTxTask } from '../lib/txTracker.js';
import { BROWSER_PROVER } from '../lib/providers.js';
import type { AppContext } from '../App.js';

/**
 * Live architecture map: bearer → (biometrics) → device → (zk proof) →
 * account-custody contract on chain. The prover box sits inside the device
 * and lights up during the real prove phase (txTracker), so the audience
 * sees the cryptographic work happening on their machine.
 */
export function FlowDiagram({ ctx }: { ctx: AppContext }) {
  const { session, ledger } = ctx;
  const task = useTxTask();
  const phase = task && task.phase !== 'error' ? task.phase : null;
  const deviceLive = phase === 'build' || phase === 'prove';
  const holder = session.devMode ? 'bearer' : (session.passkey?.label ?? 'bearer');
  const epoch = ledger?.device_epoch ?? 0n;
  const deviceCount = ledger
    ? [...ledger.devices].filter(([, e]) => e === epoch).length
    : 0;
  const grantCount = ledger
    ? [...ledger.grants].filter(([, g]) => g.active && g.epoch === epoch).length
    : 0;
  const others = Math.max(0, deviceCount - 1);

  return (
    <Panel
      title="How this account works"
      sub="A live map of the custody model — it animates whenever this tab acts on the contract."
      x="The whole model in one picture: your biometrics unlock a passkey on the device, the device proves its authority in zero knowledge, and the contract on chain enforces the rules. No server anywhere in the path (P8)."
    >
      <div className="flow">
        {/* the bearer */}
        <div
          className="flow-node flow-user"
          data-x="You — the bearer. Your face or fingerprint never leaves the device's secure hardware; it only unlocks the passkey. There is no username, no password, and no seed phrase (P1)."
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="8" r="3.6" />
            <path d="M5 20c.8-4 3.5-6 7-6s6.2 2 7 6" />
          </svg>
          <b>{holder}</b>
          <span className="flow-dim">the bearer</span>
        </div>

        {/* biometrics arrow */}
        <div
          className={`flow-link ${deviceLive ? 'flow-flowing' : ''}`}
          data-x="WebAuthn user verification: the biometric gesture unlocks the passkey, and the passkey's PRF output becomes the 32-byte device secret — re-derived on every visit, never written down, never uploaded (P1)."
        >
          <span className="flow-link-label">biometrics</span>
          <span className="flow-link-line" />
          <span className="flow-link-sub">Face ID · Touch ID unlocks the passkey</span>
        </div>

        {/* the device, with the prover inside */}
        <div
          className={`flow-node flow-device ${deviceLive ? 'flow-on' : ''}`}
          data-x="Your device — a first-class peer, not a 'main device' (P3). It stores nothing durable: the passkey re-derives the device secret when needed, and the secret never crosses the network boundary (P6)."
        >
          <div className="flow-node-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="5" width="13" height="9" rx="1.8" />
              <path d="M6.5 18h6M9.5 14v4" />
              <rect x="17" y="9" width="4.5" height="9" rx="1.4" />
            </svg>
            this device
            {others > 0 && (
              <span
                className="flow-more"
                data-x="Other devices enrolled at the current epoch. Each is an equal peer: any of them can act, enrol another, or revoke one (P3, P4)."
              >
                +{others} peer{others > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div
            className="flow-inner"
            data-x="The ledger stores only a commitment to the device secret. Every authorised call proves knowledge of the preimage in zero knowledge — the secret itself is the witness and stays here."
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="8.5" cy="11" r="4.5" />
              <path d="M12.5 12.5L20 20m-3-1l2-2m-5-1l2-2" />
            </svg>
            passkey → device secret
          </div>
          <div
            className={`flow-prover ${phase === 'prove' ? 'flow-proving' : ''}`}
            data-x={
              BROWSER_PROVER
                ? 'The zero-knowledge prover runs in this tab (wasm). When it lights up, your machine is doing the real cryptographic work — the witness (your secret) never leaves it. Nothing to intercept, no server to trust (P6).'
                : 'Server mode (?prover=server): proofs go to the local Docker proof server. The default is on-device proving in this tab.'
            }
          >
            {phase === 'prove' && <span className="flow-scan" />}
            <span className="flow-prover-dot" />
            <span className="flow-prover-words">
              <b>zk prover</b>
              <span>{BROWSER_PROVER ? 'in this browser' : 'local proof server'}</span>
            </span>
            <span className="flow-prover-state">
              {phase === 'prove' ? 'proving…' : phase === 'build' ? 'preparing' : 'idle'}
            </span>
          </div>
          <p className="flow-foot">the secret never leaves this device</p>
        </div>

        {/* authorisation arrow */}
        <div
          className={`flow-link ${phase === 'submit' ? 'flow-flowing' : ''}`}
          data-x="The only thing that travels: a transaction carrying a zero-knowledge proof. No key, no secret, no biometric is in it — anyone can verify the proof, no one can learn the witness from it (P6)."
        >
          <span className="flow-link-label">authorises</span>
          <span className="flow-link-line" />
          <span className="flow-link-sub">zero-knowledge proof → transaction</span>
        </div>

        {/* the chain */}
        <div
          className={`flow-node flow-chain ${phase === 'done' ? 'flow-landed' : ''}`}
          data-x="Only the Midnight chain is required to operate this account. Indexers and helpers are replaceable; no named operator sits on any critical path (P8)."
        >
          <div className="flow-node-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M3.5 9h17M3.5 15h17M12 3c2.7 2.6 2.7 15.4 0 18M12 3c-2.7 2.6-2.7 15.4 0 18" />
            </svg>
            Midnight ledger
          </div>
          <div
            className="flow-contract"
            data-x="Your account-custody contract. It holds the assets and enforces in-circuit who may move them — device commitments, grant scopes, caps, and epochs. The rules are code on chain, not policy on a server (P7, P8)."
          >
            <b>account-custody contract</b>
            <Mono v={session.accountAddress} short />
            <span className="flow-stats">
              epoch {String(epoch)} · {deviceCount} device{deviceCount === 1 ? '' : 's'} ·{' '}
              {grantCount} grant{grantCount === 1 ? '' : 's'}
            </span>
          </div>
          <p className="flow-foot">
            {phase === 'done' ? 'transaction landed ✓' : 'verifies the proof — rejects anything else'}
          </p>
        </div>
      </div>
      <p className="dim flow-hint">
        Run any action — a deposit, a grant, a revocation — then watch this map: the prover lights
        up on your machine, and only the finished proof travels to the chain.
      </p>
    </Panel>
  );
}
