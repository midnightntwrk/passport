import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react'

import type { PassportContractRecord } from '../identity/passportContractStore.js'
import { explorerTxUrl, isLedgerTxHash } from '../lib/networks.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import './identity.css'

/**
 * The Passport account-custody contract card — the C1 surface on Home.
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
   * Runs the real deployment. Omit (with no disabled reason) to hide the
   * action entirely — a button that cannot work should not be on screen.
   */
  onDeploy?: () => void
  /** True while a deployment is genuinely in flight. */
  busy?: boolean
  /** Live phase while the deployment is in flight. */
  phase?: PassportContractPhase | null
  /**
   * When set, the deploy action renders disabled with this sentence beneath
   * it — the honest reason it cannot run right now (wallet still opening, no
   * DUST and no sponsor, unsupported network).
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
  const { network, record, onDeploy, busy, phase, disabledReason, feeNote } = props

  const deployed = record?.status === 'deployed'
  const explorer = deployed && record.deployTxId ? explorerTxUrl(record.network, record.deployTxId) : null
  /* The id is real; whether it is the thing an EXPLORER can resolve is a
     separate question. midnight-js answers a submit with a 33-byte transaction
     identifier and the indexer maps it to the 32-byte ledger hash; when that
     mapping had not happened yet, what is stored is the identifier, and a link
     built from it lands on "transaction not found". So it is rendered as text
     with the reason, and `App.tsx` asks the indexer again in the background. */
  const txIdUnresolved = Boolean(deployed && record.deployTxId && !isLedgerTxHash(record.deployTxId))
  /* The action is offered whenever there is no deployed contract. A failed
     record keeps it, because retrying is exactly what the user wants there. */
  const showAction = !deployed && (Boolean(onDeploy) || Boolean(disabledReason))

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
          {busy ? 'Deploying…' : 'No contract on this network yet'}
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

      {record?.status === 'failed' ? <p className="mnid-reason">{record.failureReason}</p> : null}

      {showAction ? (
        <div className="mnid-panel-actions mnid-register-row">
          <button
            type="button"
            className="mnid-register"
            onClick={onDeploy}
            disabled={Boolean(busy || disabledReason || !onDeploy)}
          >
            {busy ? (
              <Loader2 className="mnid-register-spinner" size={14} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
            {busy
              ? PHASE_LABELS[phase ?? 'deploying']
              : record?.status === 'failed'
                ? 'Try deploying again'
                : 'Deploy contract'}
          </button>
          {disabledReason ? (
            <p className="mnid-reason mnid-register-reason">{disabledReason}</p>
          ) : feeNote && !busy ? (
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
  if (busy) return <span className="mnid-pill mnid-pill-queued">Deploying…</span>
  if (record?.status === 'deployed') {
    return (
      <span className="mnid-pill mnid-pill-registered">
        {record.ledgerConfirmed === false
          ? 'Submitted — awaiting the indexer'
          : `Active on ${NETWORK_LABELS[network]}`}
      </span>
    )
  }
  if (record?.status === 'failed') {
    return <span className="mnid-pill mnid-pill-failed">Deployment failed</span>
  }
  return <span className="mnid-pill mnid-pill-queued">Not deployed</span>
}
