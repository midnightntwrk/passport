import React, { useState } from 'react';

import { hexToBytes, bytesToHex, randomBytes32 } from '../../../src/wallet/hex.js';

import { userAddressBytes } from '../lib/providers.js';
import { ViewHeader, Panel, ActionButton, Mono, Chip, CapBar } from '../ui.js';
import type { AppContext } from '../App.js';

export function GrantsPanel({ ctx }: { ctx: AppContext }) {
  const { ledger, account, mid, log, nightColor } = ctx;
  const [cap, setCap] = useState('300');
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [dappSecret, setDappSecret] = useState('');
  const [dappAmount, setDappAmount] = useState('50');

  const epoch = ledger?.device_epoch ?? 0n;
  const grants = ledger ? [...ledger.grants] : [];

  return (
    <>
      <ViewHeader
        title="Connections"
        narration="A connection is a scoped credential: one operation, one token colour, a cumulative cap. The dApp holds the secret; the contract — not the dApp — enforces the boundary, and revocation makes the secret worthless."
      />

      <Panel
        title="Grants on-chain"
        sub="Live from the ledger: each grant's cumulative spend against its cap, and whether the contract still honours it."
        x="Each row is a scoped grant in public ledger state — operation × token colour × cumulative cap, enforced by the contract circuit at proof verification, not by the dApp's goodwill (P7). An OAuth scope the ledger itself checks."
      >
        <div className="list">
          {grants.length === 0 && <p className="dim">no grants issued yet</p>}
          {grants.map(([commitment, info]) => (
            <div className="listrow" key={String(commitment)}>
              <div className="listrow-id">
                <span className="docfield-k">credential</span>
                <Mono v={commitment.toString(16)} short group />
              </div>
              <div className="listrow-meter">
                <span className="docfield-k">spent / cap</span>
                <CapBar spent={info.spent} cap={info.cap} />
              </div>
              <div className="listrow-side">
                {!info.active ? (
                  <Chip stamp tone="danger">revoked</Chip>
                ) : info.epoch !== epoch ? (
                  <Chip stamp tone="muted">stale epoch</Chip>
                ) : (
                  <Chip stamp tone="ok">active</Chip>
                )}
                {info.active && (
                  <ActionButton
                    label="revoke"
                    busyLabel="revoking…"
                    kind="danger"
                    task={{ label: 'Revoking the grant', circuit: 'revoke_grant' }}
                    onRun={async () => {
                      const r = await account.revokeGrantByCommitment(commitment);
                      log(`revoke_grant → tx ${r.txId}`);
                      await ctx.refreshLedger();
                      return r.txId;
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="row controls">
          <label className="field field-inline">
            <span className="field-label">cap</span>
            <input value={cap} onChange={(e) => setCap(e.target.value)} size={8} />
          </label>
          <ActionButton
            label="Issue grant (Night, capped)"
            busyLabel="issuing…"
            task={{ label: 'Issuing a scoped grant', circuit: 'add_grant' }}
            onRun={async () => {
              const grantSecret = randomBytes32();
              const r = await account.addGrant(grantSecret, nightColor, BigInt(cap));
              setIssuedSecret(bytesToHex(grantSecret));
              log(`add_grant cap=${cap} → tx ${r.txId}`);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
        </div>
        {issuedSecret && (
          <div
            className="secret-callout"
            data-x="The grant secret is the entire credential — hand it over once. The holder cannot widen its own scope (I-7.5), and on-chain revocation makes it worthless whatever the dApp still stores (I-7.6)."
          >
            <div className="secret-head">
              <Chip tone="warn">grant secret — shown once</Chip>
              <span className="dim">hand this to the dApp; it is the entire credential</span>
            </div>
            <Mono v={issuedSecret} />
          </div>
        )}
      </Panel>

      <Panel
        title="The dApp's console"
        sub="A separate connection holding only the grant secret — exactly what a dApp backend would hold. No device key, no recovery secret."
        tone="dapp"
        x="The other side of the connection: a session holding ONLY the grant secret. Its witness structurally cannot produce device-authorised proofs — spending over the cap or after revocation fails in the circuit (C7, P7)."
      >
        <div className="row controls">
          <label className="field field-inline grow">
            <span className="field-label">grant secret</span>
            <input value={dappSecret} onChange={(e) => setDappSecret(e.target.value)} />
          </label>
          <input value={dappAmount} onChange={(e) => setDappAmount(e.target.value)} size={6} />
          <ActionButton
            label="Spend via grant"
            busyLabel="spending…"
            disabled={!dappSecret}
            task={{ label: 'dApp spending through the grant', circuit: 'grant_withdraw_night' }}
            onRun={async () => {
              // A separate connection holding ONLY the grant secret — exactly
              // what a dApp backend would hold.
              const dapp = await ctx.reconnect({ grantSecret: hexToBytes(dappSecret.trim()) });
              const r = await dapp.grantWithdrawNight(
                nightColor,
                BigInt(dappAmount),
                userAddressBytes(mid.walletCtx),
              );
              log(`grant_withdraw_night ${dappAmount} → tx ${r.txId}`);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
        </div>
        <p className="dim">
          Spending over the cap, or after revocation, fails in the circuit — try it.
        </p>
      </Panel>
    </>
  );
}
