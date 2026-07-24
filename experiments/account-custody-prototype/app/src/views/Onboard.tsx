import React, { useEffect, useState } from 'react';
import type { MidnightWallet } from '@dynamic-labs/midnight';

import { PassportAccount } from '../../../src/wallet/account.js';
import { deviceCommitment } from '../../../src/wallet/contract.js';
import { randomBytes32 } from '../../../src/wallet/hex.js';

import type { Midnight } from '../lib/midnight.js';
import {
  accountForIdentity,
  registerIdentity,
  runPassportTransaction,
} from '../lib/midnight.js';
import { compiledAccountContract } from '../lib/providers.js';
import { createPasskey, deriveDeviceSecret, deriveDevModeSecret } from '../lib/passkey.js';
import {
  loadPasskeyForAlias,
  normalizeAlias,
  saveAlias,
  savePasskeyRecord,
} from '../lib/session.js';
import type { Session } from '../lib/session.js';
import { ActionButton, Chip } from '../ui.js';

const LOCAL_DEMO_SECRET = 'mn-passport-foundations-local-demo';

function dynamicWalletKey(wallet: MidnightWallet): string {
  return wallet.id || wallet.address;
}

function usesAutomationSecret(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('automation') === '1' || navigator.webdriver === true;
}

/** Resolves to true iff a contract exists at `address` on the current chain.
    Guards against connecting to a session from a reset or changed network — that
    connect would otherwise wait forever for indexer state that never comes. */
async function contractExists(mid: Midnight, address: string): Promise<boolean> {
  try {
    const state = await mid.accountProviders.publicDataProvider.queryContractState(address);
    return state != null;
  } catch (error) {
    throw new Error(
      `Could not verify the account contract on ${mid.networkId}: ${String(
        (error as Error)?.message ?? error,
      )}`,
    );
  }
}

export function OnboardView(props: {
  mid: Midnight;
  session: Session | null;
  dynamicIdentity: string;
  dynamicWallet: MidnightWallet;
  log: (m: string) => void;
  onConnected: (s: Session, a: PassportAccount, commitment?: string) => void;
  onReset: () => void;
}) {
  const { mid, session, log } = props;
  const [label, setLabel] = useState(props.dynamicIdentity);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionStale, setSessionStale] = useState(false);
  const automationMode = usesAutomationSecret();

  useEffect(() => {
    setLabel((current) => (current === 'alice' || current === 'bubbles' ? props.dynamicIdentity : current));
  }, [props.dynamicIdentity]);

  // Proactively check that the remembered account still exists. Browser
  // sessions survive a localnet reset or a network change.
  useEffect(() => {
    if (!session) return;
    if (session.networkId && session.networkId !== mid.networkId) {
      setSessionStale(true);
      return;
    }
    let stop = false;
    contractExists(mid, session.accountAddress)
      .then((exists) => {
        if (!stop) setSessionStale(!exists);
      })
      .catch((verificationError) => {
        if (!stop) setError(String(verificationError?.message ?? verificationError));
      });
    return () => {
      stop = true;
    };
  }, [mid, session]);

  const deviceSecretForOnboarding = async (alias: string): Promise<{
    secret: Uint8Array;
    session: Omit<Session, 'accountAddress'>;
  }> => {
    if (automationMode) {
      log('automation mode: deriving the isolated test device secret…');
      return { secret: await deriveDevModeSecret(LOCAL_DEMO_SECRET), session: { devMode: true } };
    }

    const stored = loadPasskeyForAlias(alias);
    let passkey = stored?.passkey;
    if (!passkey) {
      log(`creating a Passport passkey for ${alias}.night...`);
      passkey = await createPasskey(`${alias}.night`);
    }
    log(`unlocking Passport device authority for ${alias}.night...`);
    const secret = await deriveDeviceSecret(passkey);
    return {
      secret,
      session: {
        passkey,
        dynamicWalletId: dynamicWalletKey(props.dynamicWallet),
        dynamicWalletAddress: props.dynamicWallet.address,
        networkId: mid.networkId,
      },
    };
  };

  const deviceSecretForSession = async (currentSession: Session): Promise<Uint8Array> => {
    if (currentSession.devMode) return deriveDevModeSecret(LOCAL_DEMO_SECRET);
    return deriveDeviceSecret(currentSession.passkey);
  };

  // Session exists but the page was reloaded: re-derive the device secret
  // and reconnect — nothing secret survives a reload by design.
  if (session) {
    return (
      <div className="onboard-grid onboard-grid-narrow">
        <div className="onboard-copy">
          <PassportShowcase label={session.alias ?? 'foundations'} compact />
          <p className="eyebrow">Welcome back</p>
          <h1 className="hero-title">Unlock your MN Passport.</h1>
          <p className="lede">
            Custody account <code className="mono">{session.accountAddress.slice(0, 16)}…</code>{' '}
            re-derives its device secret in this browser on every visit. Identity{' '}
            <code className="mono">{session.alias ?? 'foundations'}.night</code> is registry-backed.
          </p>
        </div>
        <div className="onboard-cards">
          <div className="panel onboard-card">
            {sessionStale && (
              <div className="caveat">
                <Chip tone="warn">not on this chain</Chip>
                <p>
                  No contract exists at this address on the current {mid.networkId} network.
                  Switch back to the account's network or forget this account and create a new one.
                </p>
              </div>
            )}
            <ActionButton
              label="Unlock demo account"
              busyLabel="unlocking…"
              block
              onError={setError}
              onRun={async () => {
                setError(null);
                if (!(await contractExists(mid, session.accountAddress))) {
                  throw new Error(
                    'account contract not found on the current network; switch networks or forget this account and onboard again',
                  );
                }
                const secret = await deviceSecretForSession(session);
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

  const aliasPreview = normalizeAlias(label || 'mn-passport-user');
  const storedPasskey = !automationMode ? loadPasskeyForAlias(aliasPreview) : null;

  return (
    <div className="onboard-grid">
      <div className="onboard-copy">
        <PassportShowcase label={label || 'bubbles'} />
        <p className="eyebrow">Create your MN Passport</p>
        <h1 className="hero-title">Deploy a foundations account.</h1>
        {automationMode ? (
          <p className="lede">
            Automation mode derives a local device secret, deploys a MN Passport custody account on
            Midnight, and walks straight into the earn flow.
          </p>
        ) : (
          <p className="lede">
            Dynamic has authenticated the user and returned the embedded Midnight wallet. MN
            Passport now deploys the custody account on Midnight and walks straight into the earn
            flow.
          </p>
        )}
        <ol className="hero-steps">
          <li>
            <span className="hero-step-n">1</span>
            <span>
              {automationMode
                ? 'An isolated automation secret drives this browser test.'
                : 'Dynamic creates the embedded Midnight wallet, then a passkey protects Passport authority.'}
            </span>
          </li>
          <li>
            <span className="hero-step-n">2</span>
            <span>
              A fresh recovery secret is split 2-of-3 for account recovery on Midnight.
            </span>
          </li>
          <li>
            <span className="hero-step-n">3</span>
            <span>
              The account device secret deploys your MN Passport custody contract.
            </span>
          </li>
          <li>
            <span className="hero-step-n">4</span>
            <span>
              Your Night ID is created and bound to the MN Passport custody account.
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
          <ActionButton
            label={
              automationMode
                ? 'Deploy MN Passport account'
                : storedPasskey
                  ? 'Unlock passkey & deploy Passport'
                  : 'Create passkey & deploy Passport'
            }
            busyLabel={
              automationMode ? 'deploying MN Passport custody…' : 'authorizing & deploying Passport…'
            }
            block
            task={{
                label: automationMode
                  ? 'Deploying your MN Passport custody account'
                  : 'Deploying passkey-protected MN Passport custody',
              circuit: 'deploy account',
            }}
            onError={setError}
            onRun={async () => {
              setError(null);
              const alias = normalizeAlias(label || 'mn-passport-user');
              const existingAccount = await accountForIdentity(mid, alias);
              if (existingAccount) {
                throw new Error(`${alias}.night is already registered; choose a different Night ID`);
              }
              const { secret, session: partial } = await deviceSecretForOnboarding(alias);
              const recoverySecret = randomBytes32();
              log(
                mid.dynamicTransactions
                  ? 'proving the account constructor; Dynamic will finalize it, request exact-byte approval, and broadcast it…'
                  : 'deploying the MN Passport custody contract…',
              );
              const deployment = await runPassportTransaction(
                mid,
                {
                  contractAddress: 'new MN Passport custody account',
                  circuit: 'deploy account',
                  summary: `Deploy the MN Passport custody account for ${alias}.night`,
                  arguments: {
                    nightId: `${alias}.night`,
                    wallet: props.dynamicWallet.address,
                  },
                },
                () =>
                  PassportAccount.deploy(
                    mid.accountProviders,
                    compiledAccountContract(),
                    { deviceSecret: secret, recoverySecret },
                  ),
              );
              const account = deployment.result;
              if (deployment.receipt) {
                log(
                  `Dynamic broadcast ${deployment.receipt.txHash}; approval ${deployment.receipt.approvalSignatureFingerprint.slice(0, 16)}...`,
                );
              }
              log(`account deployed @ ${account.address}`);
              log(`registering ${alias}.night on the identity registry...`);
              const identity = await registerIdentity(mid, alias, account.address);
              log(`identity registered ${alias}.night -> ${account.address} tx ${identity.txId}`);
              saveAlias(alias, account.address, {
                identityRegistryAddress: identity.registryAddress,
                identityRegistrationTxId: identity.txId,
              });
              if (partial.passkey) {
                savePasskeyRecord(alias, partial.passkey, {
                  accountAddress: account.address,
                  identityRegistryAddress: identity.registryAddress,
                  identityRegistrationTxId: identity.txId,
                });
              }
              props.onConnected(
                {
                  accountAddress: account.address,
                  alias,
                  identityRegistryAddress: identity.registryAddress,
                  identityRegistrationTxId: identity.txId,
                  ...partial,
                },
                account,
                deviceCommitment(secret).toString(),
              );
            }}
          />
          {error && <p className="error">{error}</p>}
          <p className="hint">
            {automationMode
              ? 'Automation mode uses a local device secret.'
              : storedPasskey
                ? `Saved passkey reference found for ${aliasPreview}.night.`
                : `Dynamic wallet connected. Passport will create a separate passkey for contract authority.`}{' '}
            Night IDs are unique, so a handle like alice.night can only be registered once.
          </p>
        </div>

        <div className="panel onboard-card onboard-card-secondary">
          <h2 className="eyebrow">Connect existing MN Passport wallet</h2>
          <p className="panel-sub">
            Paste an account contract address; Passport asks for a resident passkey and re-derives
            the device witness only for this session.
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
                const secret = automationMode
                  ? await deriveDevModeSecret(LOCAL_DEMO_SECRET)
                  : await deriveDeviceSecret();
                const account = await PassportAccount.connect(
                  mid.accountProviders,
                  compiledAccountContract(),
                  address.trim(),
                  { deviceSecret: secret },
                );
                log(`connected to ${account.address}`);
                props.onConnected(
                  {
                    accountAddress: address.trim(),
                    networkId: mid.networkId,
                    devMode: automationMode || undefined,
                    dynamicWalletId: automationMode ? undefined : dynamicWalletKey(props.dynamicWallet),
                    dynamicWalletAddress: automationMode ? undefined : props.dynamicWallet.address,
                  },
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

function PassportShowcase(props: { label: string; compact?: boolean }) {
  const display = (props.label || 'bubbles').trim().slice(0, 24);
  return (
    <div className={`passport-showcase ${props.compact ? 'passport-showcase-compact' : ''}`}>
      <div className="passport-showcase-grid" />
      <div className="passport-rings" />
      <div className="passport-demo-card" aria-hidden="true">
        <div className="passport-demo-top">
          <span>MN PASSPORT</span>
          <span>WALLET</span>
        </div>
        <div className="passport-demo-mark">
          <span />
        </div>
        <div className="passport-demo-bottom">
          <small>NIGHT ID</small>
          <strong>{display}.night</strong>
        </div>
      </div>
      <div className="passport-flow-dots" aria-hidden="true">
        {['Dynamic auth', 'Custody', 'Night ID', 'Fund', 'Earn'].map((item, index) => (
          <span className={index <= 1 ? 'passport-flow-dot passport-flow-dot-active' : 'passport-flow-dot'} key={item}>
            <i />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
