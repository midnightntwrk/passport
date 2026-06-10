import React, { useState } from 'react';

import { createPasskey, deriveDeviceSecret, deriveDevModeSecret } from '../lib/passkey.js';
import { ViewHeader, Panel, ActionButton, Mono, Chip } from '../ui.js';
import type { AppContext } from '../App.js';

export function DevicesPanel({ ctx }: { ctx: AppContext }) {
  const { ledger, account, log } = ctx;
  const [devPassphrase, setDevPassphrase] = useState('');

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
        sub="Hash-preimage auth — the prototype stand-in for C5's JubJub Schnorr. Any active device is admin (1-of-n). Removing your own device locks this browser out."
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
                  <Chip tone="info">this device</Chip>
                )}
                <ActionButton
                  label="remove"
                  busyLabel="removing…"
                  kind="danger"
                  disabled={active.length <= 1}
                  task={{ label: 'Removing the device', circuit: 'remove_device' }}
                  onRun={async () => {
                    const r = await account.removeDeviceByCommitment(commitment);
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
        <div className="row controls">
          <ActionButton
            label="Add device (new passkey)"
            busyLabel="adding…"
            task={{ label: 'Registering a new device', circuit: 'add_device' }}
            onRun={async () => {
              const ref = await createPasskey(`device-${Date.now() % 10_000}`);
              const secret = await deriveDeviceSecret(ref);
              const r = await account.addDevice(secret);
              log(`add_device (passkey ${ref.label}) → tx ${r.txId}`);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
          <span className="ctrl-gap" />
          <label className="field field-inline">
            <span className="field-label">or dev-mode passphrase</span>
            <input
              type="password"
              value={devPassphrase}
              onChange={(e) => setDevPassphrase(e.target.value)}
              size={14}
            />
          </label>
          <ActionButton
            label="Add (dev mode)"
            busyLabel="adding…"
            kind="ghost"
            disabled={!devPassphrase}
            task={{ label: 'Registering a new device', circuit: 'add_device' }}
            onRun={async () => {
              const secret = await deriveDevModeSecret(devPassphrase);
              const r = await account.addDevice(secret);
              log(`add_device (dev mode) → tx ${r.txId}`);
              setDevPassphrase('');
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
        </div>
      </Panel>
    </>
  );
}
