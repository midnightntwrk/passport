import React from 'react';

import { ViewHeader, Mono, Chip, Field, X } from '../ui.js';
import { FlowDiagram } from './FlowDiagram.js';
import type { AppContext } from '../App.js';

// Machine-readable-zone line: uppercase, non-alphanumerics become fillers,
// padded to the classic 44 characters.
function mrzLine(s: string): string {
  return (s.toUpperCase().replace(/[^A-Z0-9]/g, '<') + '<'.repeat(44)).slice(0, 44);
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

  const mrz1 = mrzLine(`P<MN${holder}<<MIDNIGHT<PASSPORT`);
  const mrz2 = mrzLine(
    `${session.accountAddress.slice(0, 20)}<MN<E${String(epoch)}<R${ledger ? String(ledger.round) : ''}`,
  );

  return (
    <>
      <ViewHeader
        title="Your account is a contract"
        narration="A personal Compact contract on the Midnight ledger holds this account. Everything on this page is read live from chain state — hover any dotted term for what it means."
      />

      <section className="doc">
        <header className="doc-head">
          <span className="doc-authority">Midnight Network · Localnet</span>
          <span className="doc-type">Passport · Account custody</span>
        </header>
        <span
          className="doc-chipmark"
          aria-hidden="true"
          data-x="The e-passport chip mark, worn here as a badge: like a passport chip, the cryptography lives with the document — your device derives the key, the contract verifies the proof."
        />
        <div className="doc-grid">
          <Field
            k="Holder"
            v={
              <X x="The bearer of this passport. The account is operated by whoever can prove knowledge of an enrolled device secret — derived from your passkey, never stored anywhere (P1).">
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
            k="Document no. — account contract"
            v={
              <X x="The address of your personal account contract — the passport is the contract. Anyone can verify this document against the ledger; no issuing authority is involved (P8).">
                <Mono v={session.accountAddress} short group />
              </X>
            }
            wide
          />
          <Field
            k="Night ID registry"
            v={
              <X x="The shared Passport identity registry contract that recorded this handle during onboarding. The readable alias is a UI label; the registry transaction binds it to the account contract.">
                <Mono v={session.identityRegistryAddress ?? 'deploying'} short group />
              </X>
            }
            wide
          />
          <Field
            k="Identity tx"
            v={
              <X x="The transaction that registered this Night ID to the Passport account-management contract.">
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
          data-x="Machine-readable zone, as on a printed passport — decorative here, derived from the holder, the contract address, the epoch, and the round."
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

      <FlowDiagram ctx={ctx} />
    </>
  );
}
