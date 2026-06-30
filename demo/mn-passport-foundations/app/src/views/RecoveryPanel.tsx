import React, { useState } from 'react';

import { PassportAccount } from '../../../src/wallet/account.js';
import { reconstruct } from '../../../src/wallet/shamir.js';
import { randomBytes32 } from '../../../src/wallet/hex.js';
import { recoveryCommitment, deviceCommitment } from '../../../src/wallet/contract.js';

import { createPasskey, deriveDeviceSecret, deriveDevModeSecret } from '../lib/passkey.js';
import type { Session } from '../lib/session.js';
import { ViewHeader, Panel, ActionButton, Chip, StatTile } from '../ui.js';
import type { AppContext } from '../App.js';

export function RecoveryPanel(props: {
  ctx: AppContext;
  onRecovered: (s: Session, a: PassportAccount, commitment?: string) => void;
}) {
  const { ctx } = props;
  const { ledger, log, session } = ctx;
  const [devMode, setDevMode] = useState(false);
  const [passphrase, setPassphrase] = useState('');

  const shareCount = ledger ? Number(ledger.recovery_shares.size()) : 0;

  return (
    <>
      <ViewHeader
        title="Recovery"
        narration="If every device is gone, two of the three shares reconstruct the recovery secret; the recover circuit proves knowledge of it, bumps the device epoch — retiring every device and grant — and registers a fresh device."
      />

      <Panel
        title="Recovery shares"
        sub="The recovery secret is split 2-of-3 at onboarding; any two shares reconstruct it."
        x="The recovery secret is split 2-of-3 over GF(256) (Shamir): any two shares reconstruct it; any single share is information-theoretically useless (I-6.4). Recovery re-keys the account — same name, balances, and history (I-5.3)."
      >
        <div className="share-row">
          {[1, 2, 3].map((i) => (
            <div className={`share-slot ${i <= shareCount ? 'share-live' : ''}`} key={i}>
              <span className="share-n">{i}</span>
              <span className="share-k">share</span>
              <span className="share-v">{i <= shareCount ? 'on-chain' : '—'}</span>
            </div>
          ))}
          <div className="share-meta">
            <StatTile label="threshold" value="2 of 3" />
            <StatTile label="device epoch" value={ledger ? String(ledger.device_epoch) : '…'} />
          </div>
        </div>
        <div className="caveat">
          <Chip tone="warn">local demo</Chip>
          <p>
            In this local demo the shares sit in <em>plaintext public ledger state</em>. The
            production design encrypts each share to a recovery helper and publishes correctness
            proofs instead.
          </p>
        </div>
      </Panel>

      <Panel
        title="Simulate the disaster"
        sub="Pretend every device is lost: reconstruct the secret from on-chain shares 1 and 2, prove it, re-key the account."
      >
        <label className="devmode-row">
          <input
            type="checkbox"
            checked={devMode}
            onChange={(e) => setDevMode(e.target.checked)}
          />
          dev mode — recover with a passphrase instead of a passkey
        </label>
        {devMode && (
          <label className="field">
            <span className="field-label">new passphrase</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
        )}
        <ActionButton
          label="Simulate total loss & recover"
          busyLabel="recovering…"
          kind="danger"
          block
          task={{ label: 'Recovering the account', circuit: 'recover' }}
          onRun={async () => {
            if (!ledger) throw new Error('ledger not loaded yet');

            log('TOTAL LOSS — reconstructing the recovery secret from on-chain shares 1+2…');
            const secret = reconstruct([
              { index: 1, value: ledger.recovery_shares.lookup(1n) },
              { index: 2, value: ledger.recovery_shares.lookup(2n) },
            ]);
            if (recoveryCommitment(secret) !== ledger.recovery) {
              throw new Error('reconstructed secret does not match the on-chain commitment');
            }
            log('reconstructed secret matches the on-chain commitment.');

            let newDeviceSecret: Uint8Array;
            let newSession: Session;
            if (devMode) {
              if (!passphrase) throw new Error('enter a new dev-mode passphrase');
              newDeviceSecret = await deriveDevModeSecret(passphrase);
              newSession = { accountAddress: session.accountAddress, devMode: true };
            } else {
              const ref = await createPasskey('recovered-device');
              newDeviceSecret = await deriveDeviceSecret(ref);
              newSession = { accountAddress: session.accountAddress, passkey: ref };
            }

            const newRecoverySecret = randomBytes32();
            const recoverer = await ctx.reconnect({ recoverySecret: secret });
            const r = await recoverer.recover(newDeviceSecret, newRecoverySecret);
            log(`recover → tx ${r.txId} — old devices and grants are now dead.`);

            const account = await ctx.reconnect({ deviceSecret: newDeviceSecret });
            props.onRecovered(newSession, account, deviceCommitment(newDeviceSecret).toString());
            await ctx.refreshLedger();
            return r.txId;
          }}
        />
      </Panel>
    </>
  );
}
