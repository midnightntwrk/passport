import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  aliasDomain,
  normalizePassportAlias,
  suggestAliasAlternatives,
  type AliasAvailability,
} from '../identity/midnames.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import './identity.css'

/**
 * Network-switch reclaim.
 *
 * Identity is claimed PER NETWORK: a `.night` name held on preview says nothing
 * about who holds it on pre-production. When the user switches networks,
 * Passport tries to reclaim the same name there; this modal only appears when
 * the target network's own registry says the name is already taken.
 *
 * The passkey is untouched by any of this. It is the login credential for every
 * network and is never re-enrolled or varied — only the name is per network.
 */

const DEBOUNCE_MS = 500

export interface AliasReclaimModalProps {
  targetNetwork: PassportNetwork
  /** The name already held elsewhere, which is taken on `targetNetwork`. */
  currentAlias: string
  checkAvailability: (alias: string) => Promise<AliasAvailability>
  onPick: (alias: string) => Promise<void>
  onKeepCurrent: () => void
  busy: boolean
  error: string | null
}

type FieldState =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'checking'; alias: string }
  | { kind: 'answered'; alias: string; availability: AliasAvailability }

export default function AliasReclaimModal(props: AliasReclaimModalProps) {
  const { targetNetwork, currentAlias, checkAvailability, onPick, onKeepCurrent, busy, error } =
    props

  const suggestions = useMemo(() => suggestAliasAlternatives(currentAlias), [currentAlias])
  const [value, setValue] = useState(suggestions[0] ?? '')
  const [field, setField] = useState<FieldState>({ kind: 'empty' })
  const probe = useRef(0)

  useEffect(() => {
    if (busy) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onKeepCurrent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onKeepCurrent])

  useEffect(() => {
    const raw = value.trim()
    if (!raw) {
      setField({ kind: 'empty' })
      return undefined
    }
    let alias: string
    try {
      alias = normalizePassportAlias(raw)
    } catch (cause) {
      setField({ kind: 'invalid', message: cause instanceof Error ? cause.message : String(cause) })
      return undefined
    }
    setField({ kind: 'checking', alias })
    const token = probe.current + 1
    probe.current = token
    const timer = window.setTimeout(() => {
      void checkAvailability(alias).then(
        (availability) => {
          if (probe.current === token) setField({ kind: 'answered', alias, availability })
        },
        (cause: unknown) => {
          if (probe.current !== token) return
          setField({
            kind: 'answered',
            alias,
            availability: {
              status: 'unreachable',
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          })
        },
      )
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [checkAvailability, value])

  const alias = field.kind === 'checking' || field.kind === 'answered' ? field.alias : null
  const availability = field.kind === 'answered' ? field.availability : null
  const canSubmit =
    !busy &&
    alias !== null &&
    availability !== null &&
    (availability.status === 'available' || availability.status === 'unreachable')

  const submit = useCallback(() => {
    if (!canSubmit || !alias) return
    void onPick(alias)
  }, [alias, canSubmit, onPick])

  return createPortal(
    <div className="mnid-scrim" role="presentation" onMouseDown={() => (busy ? null : onKeepCurrent())}>
      <div
        className="mnid-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a name on ${NETWORK_LABELS[targetNetwork]}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="mnid-kicker">Switching to {NETWORK_LABELS[targetNetwork]}</p>
        <h2 className="mnid-modal-title">
          {currentAlias} is taken on {NETWORK_LABELS[targetNetwork]}
        </h2>
        <p className="mnid-lede">
          Names are registered per network, and {aliasDomain(currentAlias)} already belongs to
          somebody else here. Pick another name for this network, or keep {currentAlias} where you
          already hold it. Your passkey and your account do not change either way.
        </p>

        {suggestions.length > 0 ? (
          <div className="mnid-suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={`mnid-chip${suggestion === value.trim() ? ' mnid-chip-active' : ''}`}
                disabled={busy}
                onClick={() => setValue(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        <div className={`mnid-field${field.kind === 'invalid' ? ' mnid-field-invalid' : ''}`}>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="anothername"
            aria-label={`Your name on ${NETWORK_LABELS[targetNetwork]}`}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) submit()
            }}
          />
          <span className="mnid-suffix">.night</span>
        </div>

        <ReclaimStatus field={field} targetNetwork={targetNetwork} />

        {error ? (
          <div className="mnid-panel" role="alert">
            <p className="mnid-panel-head">
              <AlertTriangle size={15} aria-hidden="true" />
              That did not work
            </p>
            <p>{error}</p>
          </div>
        ) : null}

        <div className="mnid-actions" data-toast-clear>
          <button type="button" className="mnid-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? (
              <Loader2 className="mnid-spin" size={17} aria-hidden="true" />
            ) : (
              <ArrowRight size={17} aria-hidden="true" />
            )}
            {busy
              ? 'Working…'
              : alias
                ? `Use ${aliasDomain(alias)} here`
                : 'Choose a name'}
          </button>
          <button type="button" className="mnid-secondary" onClick={onKeepCurrent} disabled={busy}>
            Keep {currentAlias} on its current network only
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ReclaimStatus({
  field,
  targetNetwork,
}: {
  field: FieldState
  targetNetwork: PassportNetwork
}) {
  if (field.kind === 'empty') {
    return (
      <p className="mnid-status mnid-status-checking">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>Type a name to check it on {NETWORK_LABELS[targetNetwork]}.</span>
      </p>
    )
  }
  if (field.kind === 'invalid') {
    return (
      <p className="mnid-status mnid-status-error" role="alert">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>{field.message}</span>
      </p>
    )
  }
  if (field.kind === 'checking') {
    return (
      <p className="mnid-status mnid-status-checking" role="status">
        <Loader2 className="mnid-spin" size={13} aria-hidden="true" />
        <span>Checking that name…</span>
      </p>
    )
  }
  if (field.availability.status === 'available') {
    return (
      <p className="mnid-status mnid-status-available" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>{aliasDomain(field.alias)} is free on {NETWORK_LABELS[targetNetwork]}.</span>
      </p>
    )
  }
  if (field.availability.status === 'taken') {
    return (
      <p className="mnid-status mnid-status-taken" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>
          {aliasDomain(field.alias)} is taken here too — someone else already holds it
        </span>
      </p>
    )
  }
  return (
    <p className="mnid-status mnid-status-error" role="status">
      <span className="mnid-status-dot" aria-hidden="true" />
      <span>Names cannot be checked right now; your name will be queued.</span>
    </p>
  )
}
