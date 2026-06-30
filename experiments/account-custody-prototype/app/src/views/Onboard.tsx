import React, { useEffect, useState } from 'react';

import { PassportAccount } from '../../../src/wallet/account.js';
import { deviceCommitment } from '../../../src/wallet/contract.js';
import { randomBytes32 } from '../../../src/wallet/hex.js';

import type { Midnight } from '../lib/midnight.js';
import { compiledAccountContract } from '../lib/providers.js';
import { createPasskey, deriveDeviceSecret, deriveDevModeSecret } from '../lib/passkey.js';
import type { Session } from '../lib/session.js';
import { ActionButton, Chip } from '../ui.js';

/** Resolves to true iff a contract exists at `address` on the current chain.
    Guards against connecting to a session from a reset localnet — that
    connect would otherwise wait forever for indexer state that never comes. */
async function contractExists(mid: Midnight, address: string): Promise<boolean> {
  try {
    const state = await mid.accountProviders.publicDataProvider.queryContractState(address);
    return state != null;
  } catch {
    // Indexer hiccup — do not block the unlock attempt on it.
    return true;
  }
}

export function OnboardView(props: {
  mid: Midnight;
  session: Session | null;
  log: (m: string) => void;
  onConnected: (s: Session, a: PassportAccount, commitment?: string) => void;
  onReset: () => void;
}) {
  const { mid, session, log } = props;
  const [label, setLabel] = useState('alice');
  const [address, setAddress] = useState('');
  const [devMode, setDevMode] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionStale, setSessionStale] = useState(false);

  // Proactively check that the remembered account still exists — a reset
  // localnet keeps the browser session but loses the contract.
  useEffect(() => {
    if (!session) return;
    let stop = false;
    contractExists(mid, session.accountAddress).then((exists) => {
      if (!stop && !exists) setSessionStale(true);
    });
    return () => {
      stop = true;
    };
  }, [mid, session]);

  const deviceSecretForOnboarding = async (): Promise<{
    secret: Uint8Array;
    session: Omit<Session, 'accountAddress'>;
  }> => {
    if (devMode) {
      if (!passphrase) throw new Error('enter a dev-mode passphrase');
      log('dev mode: deriving device secret from passphrase (SHA-256)…');
      return { secret: await deriveDevModeSecret(passphrase), session: { devMode: true } };
    }
    log('creating passkey…');
    const ref = await createPasskey(label || 'passport-user');
    log('passkey created — evaluating PRF for the device secret…');
    const secret = await deriveDeviceSecret(ref);
    log('device secret derived from WebAuthn PRF.');
    return { secret, session: { passkey: ref } };
  };

  // Session exists but the page was reloaded: re-derive the device secret
  // and reconnect — nothing secret survives a reload by design.
  if (session) {
    return (
      <div className="onboard-grid onboard-grid-narrow">
        <div className="onboard-copy">
          <p className="eyebrow">Welcome back</p>
          <h1 className="hero-title">Unlock your passport.</h1>
          <p className="lede">
            Account <code className="mono">{session.accountAddress.slice(0, 16)}…</code> — the
            device secret is re-derived from your{' '}
            {session.devMode ? 'dev-mode passphrase' : 'passkey'} on every visit. Nothing secret is
            stored on this machine.
          </p>
        </div>
        <div className="onboard-cards">
          <div className="panel onboard-card">
            {sessionStale && (
              <div className="caveat">
                <Chip tone="warn">not on this chain</Chip>
                <p>
                  No contract exists at this address on the current localnet — the chain was
                  probably reset since this account was created. Forget this account below and
                  create a new one.
                </p>
              </div>
            )}
            {session.devMode && (
              <label className="field">
                <span className="field-label">passphrase</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
            )}
            <ActionButton
              label={session.devMode ? 'Unlock (dev mode)' : 'Unlock with passkey'}
              busyLabel="unlocking…"
              block
              onError={setError}
              onRun={async () => {
                setError(null);
                if (!(await contractExists(mid, session.accountAddress))) {
                  throw new Error(
                    'account contract not found on this chain — the localnet was reset; forget this account and onboard again',
                  );
                }
                const secret = session.devMode
                  ? await deriveDevModeSecret(passphrase)
                  : await deriveDeviceSecret(session.passkey);
                log('connecting to the account contract…');
                const account = await PassportAccount.connect(
                  mid.accountProviders,
                  compiledAccountContract(),
                  session.accountAddress,
                  { deviceSecret: secret },
                );
                log(`connected to ${account.address}`);
                props.onConnected(session, account, deviceCommitment(secret).toString());
              }}
            />
            {error && <p className="error">{error}</p>}
            <button className="linkish" onClick={props.onReset}>
              forget this account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="onboard-grid">
      <div className="onboard-copy">
        {/* Verbatim heading — the e2e harness waits for its uppercased text. */}
        <p className="eyebrow">Create your passport</p>
        <h1 className="hero-title">One passkey becomes an on-chain account.</h1>
        <p className="lede">
          No seed phrase. Your device's passkey derives the secret, and a personal Compact
          contract on Midnight holds the assets and enforces who may move them.
        </p>
        <ol className="hero-steps">
          <li>
            <span className="hero-step-n">1</span>
            <span>
              A WebAuthn passkey is created; its PRF output becomes this device's secret —
              biometric-gated, never written down.
            </span>
          </li>
          <li>
            <span className="hero-step-n">2</span>
            <span>
              A fresh recovery secret is split 2-of-3; the shares go on-chain (prototype
              placeholder for PVSS).
            </span>
          </li>
          <li>
            <span className="hero-step-n">3</span>
            <span>
              Your account-custody contract deploys — devices, grants, and recovery are
              enforced by the ledger, not by a server.
            </span>
          </li>
        </ol>
      </div>

      <div className="onboard-cards">
        <div className="panel onboard-card">
          <h2 className="eyebrow">New account</h2>
          <label className="field">
            <span className="field-label">name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="alice" />
          </label>
          {devMode && (
            <label className="field">
              <span className="field-label">passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          )}
          <ActionButton
            label={devMode ? 'Create account (dev mode)' : 'Create passkey & deploy account'}
            busyLabel="deploying account contract…"
            block
            task={{ label: 'Deploying your account contract', circuit: 'deploy account' }}
            onError={setError}
            onRun={async () => {
              setError(null);
              const { secret, session: partial } = await deviceSecretForOnboarding();
              const recoverySecret = randomBytes32();
              log('deploying the account-custody contract…');
              const account = await PassportAccount.deploy(
                mid.accountProviders,
                compiledAccountContract(),
                { deviceSecret: secret, recoverySecret },
              );
              log(`account deployed @ ${account.address}`);
              props.onConnected(
                { accountAddress: account.address, ...partial },
                account,
                deviceCommitment(secret).toString(),
              );
            }}
          />
          {error && <p className="error">{error}</p>}
          <label className="devmode-row">
            <input
              type="checkbox"
              checked={devMode}
              onChange={(e) => setDevMode(e.target.checked)}
            />
            dev mode — derive the device secret from a passphrase instead of a passkey
          </label>
        </div>

        <div className="panel onboard-card onboard-card-secondary">
          <h2 className="eyebrow">Connect to an existing account</h2>
          <p className="panel-sub">
            Paste an account contract address; the device secret comes from any resident passkey
            for this origin{devMode ? ' (or the dev-mode passphrase above)' : ''}.
          </p>
          <div className="row">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0200…"
              className="grow"
            />
            <ActionButton
              label="Connect"
              busyLabel="connecting…"
              kind="ghost"
              disabled={!address}
              onError={setError}
              onRun={async () => {
                setError(null);
                if (!(await contractExists(mid, address.trim()))) {
                  throw new Error('no contract found at this address on the current chain');
                }
                const secret = devMode
                  ? await deriveDevModeSecret(passphrase)
                  : await deriveDeviceSecret();
                const account = await PassportAccount.connect(
                  mid.accountProviders,
                  compiledAccountContract(),
                  address.trim(),
                  { deviceSecret: secret },
                );
                log(`connected to ${account.address}`);
                props.onConnected(
                  { accountAddress: address.trim(), devMode: devMode || undefined },
                  account,
                  deviceCommitment(secret).toString(),
                );
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
