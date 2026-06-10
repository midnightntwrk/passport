import React from 'react';

import { ViewHeader, Panel, Mono, Chip, Field } from '../ui.js';
import type { AppContext } from '../App.js';

// Machine-readable-zone line: uppercase, non-alphanumerics become fillers,
// padded to the classic 44 characters.
function mrzLine(s: string): string {
  return (s.toUpperCase().replace(/[^A-Z0-9]/g, '<') + '<'.repeat(44)).slice(0, 44);
}

export function OverviewView({ ctx }: { ctx: AppContext }) {
  const { session, ledger } = ctx;
  const grants = ledger ? [...ledger.grants] : [];
  const activeGrants = grants.filter(([, g]) => g.active).length;
  const shares = ledger ? Number(ledger.recovery_shares.size()) : 0;
  const epoch = ledger ? ledger.device_epoch : 0n;
  const holder = (session.devMode ? 'bearer' : (session.passkey?.label ?? 'bearer')).toUpperCase();
  const reissued = epoch > 0n;

  const mrz1 = mrzLine(`P<MN${holder}<<MIDNIGHT<PASSPORT`);
  const mrz2 = mrzLine(
    `${session.accountAddress.slice(0, 20)}<MN<E${String(epoch)}<R${ledger ? String(ledger.round) : ''}`,
  );

  return (
    <>
      <ViewHeader
        numeral="01"
        title="Your account is a contract"
        narration="Onboarding created a passkey, split a recovery secret 2-of-3, and deployed a personal Compact contract. This page reads your document live from the Midnight ledger."
      />

      <section className="doc">
        <header className="doc-head">
          <span className="doc-authority">Midnight Network · Localnet</span>
          <span className="doc-type">Passport · Account custody</span>
        </header>
        <span className="doc-chipmark" aria-hidden="true" />
        <div className="doc-grid">
          <Field k="Holder" v={holder} big />
          <Field
            k="Status"
            v={
              <Chip stamp tone={reissued ? 'warn' : 'ok'}>
                {reissued ? `reissued · epoch ${String(epoch)}` : 'valid'}
              </Chip>
            }
          />
          <Field
            k="Document no. — account contract"
            v={<Mono v={session.accountAddress} short group />}
            wide
          />
          <Field k="Issuing round" v={ledger ? String(ledger.round) : '…'} />
          <Field k="Device epoch" v={String(epoch)} />
          <Field k="Devices" v={ledger ? String(ledger.device_count) : '…'} />
          <Field k="Active grants" v={ledger ? String(activeGrants) : '…'} />
          <Field k="Recovery shares" v={ledger ? `${shares} — any 2 of 3` : '…'} />
        </div>
        <div className="doc-mrz" title="machine-readable zone — decorative, derived from the document">
          <span>{mrz1}</span>
          <span>{mrz2}</span>
        </div>
      </section>

      <Panel
        title="How custody works here"
        sub="Three commitments in public state; every move is a proved circuit call."
      >
        <div className="explain-row">
          <div className="explain">
            <Chip tone="ok">devices</Chip>
            <p>
              Each device's secret is committed on-chain. Any active device authorises moves
              (1-of-n). A device epoch bump invalidates all of them at once.
            </p>
          </div>
          <div className="explain">
            <Chip tone="info">grants</Chip>
            <p>
              A grant is a scoped credential for a dApp: one operation, one token colour, a
              cumulative cap. The contract enforces the scope — not the dApp.
            </p>
          </div>
          <div className="explain">
            <Chip tone="warn">recovery</Chip>
            <p>
              Losing every device is survivable: 2 of 3 shares reconstruct the recovery secret,
              which re-keys the account and orphans everything else.
            </p>
          </div>
        </div>
        <div className="next-cue">
          <button className="btn btn-primary" onClick={() => ctx.goToStep(2)}>
            Next — fund the account →
          </button>
        </div>
      </Panel>
    </>
  );
}
