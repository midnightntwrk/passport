import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react'

import type { PassportContractRecord } from '../identity/passportContractStore.js'
import { explorerTxUrl, isLedgerTxHash } from '../lib/networks.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import './identity.css'

/**
 * The Passport account-custody contract card — the C1 surface on Home.
 *
 * STATUS, NOT A CHOICE (2026/08/19)
 * ---------------------------------
 * Hector, at the check-in: "this has to be completely transparent for the user.
 * The user shouldn't choose to deploy the contract. It should automatically
 * happen." So the "Deploy contract" button is gone. Claiming a `.night` name
 * deploys this contract as part of the same single user action, and binds the
 * name to its address; this card reports what that produced.
 *
 * The one action that remains is a RETRY, and only on a record that says a
 * previous automatic deploy FAILED — the single state where the user has a
 * genuine decision rather than a chore the app should have done for them.
 *
 * Deliberately the identity card's sibling: same `identity.css`, same status
 * pill, same transaction row, so the contract reads as part of the same
 * identity story rather than as a developer panel bolted on. It sits directly
 * beneath the name card on Home.
 *
 * The status pill is load-bearing, exactly as it is on the identity card. A
 * deployed contract shows its real address and its real deployment transaction,
 * linked to the explorer where one exists. Anything else says what it actually
 * is — not deployed, deploying, or failed with the reason. There is no state
 * that shows an address the chain did not give us.
 */

export type PassportContractPhase = 'deriving' | 'deploying' | 'confirming'

const PHASE_LABELS: Record<PassportContractPhase, string> = {
  deriving: 'Preparing your device key…',
  deploying: 'Deploying on-chain…',
  confirming: 'Confirming…',
}

export interface PassportContractCardProps {
  /** The network whose contract this card is about. */
  network: PassportNetwork
  /** The stored record for this credential and network, or null when none. */
  record: PassportContractRecord | null
  /**
   * Re-runs a deployment that FAILED automatically. Offered on nothing else:
   * there is no first-run deploy action, because the first run is the name
   * claim's job. Omit (with no disabled reason) to hide the affordance.
   */
  onRetry?: () => void
  /** True while a deployment is genuinely in flight. */
  busy?: boolean
  /** Live phase while the deployment is in flight. */
  phase?: PassportContractPhase | null
  /**
   * When set, the retry renders disabled with this sentence beneath it — the
   * honest reason it cannot run right now (wallet still opening, no DUST and no
   * sponsor, unsupported network).
   */
  disabledReason?: string | null
  /**
   * How the fee will be paid, in the send sheet's own words. Passed through
   * verbatim so the two surfaces never tell different stories about fees.
   */
  feeNote?: string | null
}

function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`
}

export default function PassportContractCard(props: PassportContractCardProps) {
  const { network, record, onRetry, busy, phase, disabledReason, feeNote } = props

  const deployed = record?.status === 'deployed'
  const explorer = deployed && record.deployTxId ? explorerTxUrl(record.network, record.deployTxId) : null
  /* The id is real; whether it is the thing an EXPLORER can resolve is a
     separate question. midnight-js answers a submit with a 33-byte transaction
     identifier and the indexer maps it to the 32-byte ledger hash; when that
     mapping had not happened yet, what is stored is the identifier, and a link
     built from it lands on "transaction not found". So it is rendered as text
     with the reason, and `App.tsx` asks the indexer again in the background. */
  const txIdUnresolved = Boolean(deployed && record.deployTxId && !isLedgerTxHash(record.deployTxId))
  const failed = record?.status === 'failed'
  /* The ONLY action: retrying an automatic deploy that failed. A Passport with
     no contract yet gets no button at all — the claim will deploy it. */
  const showRetry = failed && !busy && (Boolean(onRetry) || Boolean(disabledReason))

  return (
    <article className="mnid-card mnid-card-embedded">
      <div className="mnid-card-head">
        <p className="mnid-kicker">Your Passport contract on {NETWORK_LABELS[network]}</p>
        <StatusPill record={record} busy={Boolean(busy)} network={network} />
      </div>

      {deployed && record.address ? (
        <p className="mnid-alias" title={record.address}>
          <code>{shortHash(record.address)}</code>
        </p>
      ) : (
        <p className="mnid-alias mnid-alias-muted">
          {busy ? (
            <Loader2 className="mnid-register-spinner" size={14} aria-hidden="true" />
          ) : null}
          {busy
            ? PHASE_LABELS[phase ?? 'deploying']
            : failed
              ? 'No contract on this network yet'
              : /* Not an instruction and not a promise about timing — just what
                   will actually cause it to exist. */
                'Deploys with your Midnight name'}
        </p>
      )}

      {deployed && record.deployTxId ? (
        <ul className="mnid-txs">
          <li className="mnid-tx">
            <span className="mnid-tx-label">Deployment</span>
            {explorer ? (
              <a href={explorer} target="_blank" rel="noreferrer" title={record.deployTxId}>
                {shortHash(record.deployTxId)}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            ) : (
              /* No public explorer for this network, or an id the explorer
                 cannot resolve — shown without pretending it goes somewhere. */
              <code title={record.deployTxId}>{shortHash(record.deployTxId)}</code>
            )}
          </li>
        </ul>
      ) : null}

      {txIdUnresolved ? (
        <p className="mnid-reason">
          This is the transaction identifier the deployment returned. The indexer had not yet mapped
          it to the ledger hash an explorer resolves, so there is no link to it — reopen Passport to
          re-check.
        </p>
      ) : null}

      {/* Recovered from the passkey rather than deployed here. There is no
          transaction to show because this device never saw one, and saying so
          is the whole point — the address above was confirmed by the indexer
          before this record was allowed to exist. */}
      {deployed && record.recovered ? (
        <p className="mnid-reason">
          This contract was read from your passkey when you signed in here, and the indexer
          confirmed it on {NETWORK_LABELS[network]}. Its deployment happened on another device,
          so there is no transaction to link from this one.
        </p>
      ) : null}

      {/* Submitted, but the indexer had not caught up. The transaction id and
          address are real either way; this says which claim is being made. */}
      {deployed && record.ledgerConfirmed === false ? (
        <p className="mnid-reason">
          The deployment was submitted and returned a real address and transaction id. The indexer
          had not yet served the contract&apos;s state when this was written — reopen Passport to
          re-check.
        </p>
      ) : null}

      {deployed && record.feePaidBy ? (
        <p className="mnid-reason">
          {record.feePaidBy === 'sponsored'
            ? 'The deployment fee was covered by the fee sponsor.'
            : 'The deployment fee was paid from this wallet’s own DUST.'}
        </p>
      ) : null}

      {failed ? <p className="mnid-reason">{record.failureReason}</p> : null}

      {/* What makes the contract appear, said once, where a button used to be.
          Only in the state it is true of: no record at all, and nothing in
          flight. */}
      {!record && !busy ? (
        <p className="mnid-reason">
          Your Passport deploys this contract for you the first time you claim a Midnight name, and
          the name is registered pointing at it. There is nothing to press.
        </p>
      ) : null}

      {showRetry ? (
        <div className="mnid-panel-actions mnid-register-row">
          <button
            type="button"
            className="mnid-register"
            onClick={onRetry}
            disabled={Boolean(disabledReason || !onRetry)}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Try deploying again
          </button>
          {disabledReason ? (
            <p className="mnid-reason mnid-register-reason">{disabledReason}</p>
          ) : feeNote ? (
            <p className="mnid-reason mnid-register-reason">{feeNote}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function StatusPill({
  record,
  busy,
  network,
}: {
  record: PassportContractRecord | null
  busy: boolean
  network: PassportNetwork
}) {
  /* "via a claim" is the truthful attribution now: nothing else starts a
     deployment except a retry, which the failed record's own pill precedes. */
  if (busy) return <span className="mnid-pill mnid-pill-queued">Deploying…</span>
  if (record?.status === 'deployed') {
    return (
      <span className="mnid-pill mnid-pill-registered">
        {record.recovered
          ? /* Never "submitted": this device submitted nothing. A recovered
               record only exists once the indexer answered for it. */
            `Recovered on ${NETWORK_LABELS[network]}`
          : record.ledgerConfirmed === false
            ? 'Submitted — awaiting the indexer'
            : `Active on ${NETWORK_LABELS[network]}`}
      </span>
    )
  }
  if (record?.status === 'failed') {
    return <span className="mnid-pill mnid-pill-failed">Deployment failed</span>
  }
  return <span className="mnid-pill mnid-pill-queued">Not deployed yet</span>
}
