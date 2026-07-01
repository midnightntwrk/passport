import React from 'react';

import { ViewHeader, Panel, ActionButton, Mono, Chip } from '../ui.js';
import type { AppContext } from '../App.js';

export function DevicesPanel({ ctx }: { ctx: AppContext }) {
  const { ledger, log } = ctx;

  const epoch = ledger?.device_epoch ?? 0n;
  const devices = ledger ? [...ledger.devices] : [];
  const active = devices.filter(([, e]) => e === epoch);
  const stale = devices.filter(([, e]) => e !== epoch);

  return (
    <>
      <ViewHeader
        title="Devices"
        narration="Each row is a device-secret commitment in public state, tagged with the epoch it was registered in. Only commitments at the current epoch authorise anything; recovery bumps the epoch and strands the rest."
      />

      <Panel
        title="Registered devices"
        sub="Hash-preimage auth for the local demo. Any active device is admin (1-of-n). Removing your own device locks this browser out."
        x="Each row is a device-secret commitment in public ledger state, tagged with its enrolment epoch. Only commitments at the current epoch authorise anything; recovery bumps the epoch and strands the rest (P3, P4)."
      >
        <div className="list">
          {active.map(([commitment, e]) => (
            <div className="listrow" key={String(commitment)}>
              <div className="listrow-id">
                <span className="docfield-k">commitment · epoch {String(e)}</span>
                <Mono v={commitment.toString(16)} short group />
              </div>
              <div className="listrow-side">
                <Chip stamp tone="ok">active</Chip>
                {ctx.deviceCommitment === commitment.toString() && (
                  <span data-x="This browser's device commitment — re-derived from your passkey via PRF moments ago and matched against the on-chain registry. The secret itself never left the device (P1, P6).">
                    <Chip tone="info">this device</Chip>
                  </span>
                )}
                <ActionButton
                  label="remove"
                  busyLabel="removing…"
                  kind="danger"
                  disabled={active.length <= 1}
                  task={{ label: 'Removing the device', circuit: 'remove_device' }}
                  onRun={async () => {
                    const signer = await ctx.authorizeDevice('Sign device removal');
                    const r = await signer.removeDeviceByCommitment(commitment);
                    log(`remove_device → tx ${r.txId}`);
                    await ctx.refreshLedger();
                    return r.txId;
                  }}
                />
              </div>
            </div>
          ))}
          {stale.map(([commitment, e]) => (
            <div className="listrow stale" key={String(commitment)}>
              <div className="listrow-id">
                <span className="docfield-k">commitment · epoch {String(e)}</span>
                <Mono v={commitment.toString(16)} short group />
              </div>
              <div className="listrow-side">
                <Chip stamp tone="muted">revoked — epoch {String(e)}</Chip>
              </div>
            </div>
          ))}
        </div>
        <div className="caveat">
          <Chip tone="info">demo scope</Chip>
          <p>
            Additional passkey enrollment is hidden in this branch so the Thursday flow stays on one
            Passport account and one active device. Recovery still demonstrates account re-keying.
          </p>
        </div>
      </Panel>
    </>
  );
}
