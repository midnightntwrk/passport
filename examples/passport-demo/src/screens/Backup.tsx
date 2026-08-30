import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Database,
  Download,
  Info,
  KeyRound,
  LoaderCircle,
  TriangleAlert,
  Upload,
} from 'lucide-react'

import {
  collectPassportBackup,
  describeBackupCreatedAt,
  describeBackupPassword,
  describeExportOutcome,
} from '../identity/backup.js'
import type { PassportBackupExport, PassportBackupSummary } from '../identity/backup.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Backup — reached on demand from Home, and optional.
 *
 * WHAT THIS SCREEN HONESTLY DOES, AND NOTHING MORE
 * ------------------------------------------------
 * Two things already stand between the user and losing access, and the screen
 * still explains both because they are the parts that need no action:
 *
 *   1. the passkey is a platform credential, so it follows the user's devices
 *      wherever the platform syncs it (iCloud Keychain, Google Password
 *      Manager). Passport neither performs nor observes that sync;
 *   2. the encrypted Passport record already written in this browser
 *      (`IndexedDbPassportEncryptedRecordStore`), unlocked by that passkey.
 *
 * What is NEW here (2026/08/19) is the third thing, and it is the only one the
 * user has to do: exporting the private state this browser holds as ONE
 * password-encrypted file, and restoring it. See `../identity/backup.ts` for
 * exactly what goes in the file, what deliberately does not, and why.
 *
 * The two sentences this screen must never soften:
 *
 *   - lose the password and the backup is gone. Nothing stores it, nothing
 *     escrows it, and no part of Passport ever sees it;
 *   - the passkey is NOT in the file and cannot be. The file restores what
 *     this Passport did; it does not restore the ability to act as it.
 *
 * There is still no cloud backup and no seed phrase, because neither exists.
 */

export interface BackupProps {
  /**
   * Seals the allow-listed stores under `password` and hands the envelope to
   * the configured backend. Rejects with a message this screen shows verbatim.
   */
  onExport: (password: string) => Promise<PassportBackupExport>
  /** Opens a picked backup file and writes it into this browser. */
  onRestore: (file: File, password: string) => Promise<PassportBackupSummary>
  /** Leaves the screen. Nothing is uploaded, exported, or discarded by it. */
  onDone: () => void
}

type Busy = 'export' | 'restore' | null

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** What this browser actually holds, counted from the stores an export reads. */
interface Holdings {
  aliases: number
  passportContracts: number
  incentives: number
}

export default function BackupScreen(props: BackupProps) {
  const { onExport, onRestore, onDone } = props

  const [busy, setBusy] = useState<Busy>(null)

  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [exportError, setExportError] = useState<string | null>(null)
  const [exported, setExported] = useState<PassportBackupExport | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File | null>(null)
  const [restorePassword, setRestorePassword] = useState('')
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restored, setRestored] = useState<PassportBackupSummary | null>(null)

  /**
   * Whether there is anything to back up, asked of the STORES an export
   * actually serialises.
   *
   * This used to be a `hasEncryptedRecord` prop, and the only caller could
   * fill it with nothing better than "is a profile open" — so it was constant
   * true, its false branch was unreachable copy, and the export button was
   * gated on a session rather than on the records it writes. `collectPassportBackup`
   * takes no arguments and reads exactly those records, so it can answer the
   * question the screen is really asking. Re-read after a restore, because a
   * restore is the thing most likely to change the answer.
   */
  const [holdings, setHoldings] = useState<Holdings | null>(null)
  const [holdingsProblem, setHoldingsProblem] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void collectPassportBackup()
      .then((contents) => {
        if (cancelled) return
        setHoldingsProblem(null)
        setHoldings({
          aliases: Object.keys(contents.aliases).length,
          passportContracts: Object.keys(contents.passportContracts).length,
          incentives: contents.incentives.length,
        })
      })
      .catch((cause: unknown) => {
        /* Storage denied, or a record this build refuses to put in a file.
           Either way the honest answer is that the records could not be read —
           not "there is nothing here", which is a different fact. */
        if (cancelled) return
        setHoldings(null)
        setHoldingsProblem(errorMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [restored])

  const heldRecords =
    holdings === null ? null : holdings.aliases + holdings.passportContracts + holdings.incentives

  const hint = password ? describeBackupPassword(password) : null
  const mismatch = confirmation.length > 0 && confirmation !== password
  const canExport =
    !busy && password.length >= 8 && confirmation === password && (heldRecords ?? 0) > 0

  /* Cleared in `finally`, not on the success path: a sealing or writing error
     used to leave the plaintext password sitting in React state and in the
     input's `value` until the user navigated away. Retyping it is the price,
     and it is a small one next to a password left in the DOM. */
  const runExport = async () => {
    setBusy('export')
    setExportError(null)
    setExported(null)
    try {
      setExported(await onExport(password))
    } catch (cause) {
      setExportError(errorMessage(cause))
    } finally {
      setPassword('')
      setConfirmation('')
      setBusy(null)
    }
  }

  const runRestore = async () => {
    if (!picked) return
    setBusy('restore')
    setRestoreError(null)
    setRestored(null)
    try {
      setRestored(await onRestore(picked, restorePassword))
    } catch (cause) {
      setRestoreError(errorMessage(cause))
    } finally {
      setRestorePassword('')
      setBusy(null)
    }
  }

  return (
    <section className="mnid-screen">
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        {/* Off the onboarding chain since 2026/08/06 — it is reached on
            demand, so it no longer numbers itself against a wizard. */}
        <span className="mnid-step">Optional</span>
        <ThemeToggle size="sm" className="mnid-theme" />
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Optional</p>
        <h1 className="mnid-title">Where your Passport lives</h1>
        <p className="mnid-lede">
          Two things already stand between you and losing access, and neither needs anything
          from you. The third — a file you keep — is below.
        </p>

        <ul className="mnid-bullets">
          <li className="mnid-bullet">
            <span className="mnid-bullet-mark">
              <KeyRound size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Your passkey follows your devices</strong>
              <small>
                The passkey you created is a platform credential. If your device syncs
                passkeys — iCloud Keychain on Apple devices, Google Password Manager on
                Android and Chrome — it is already on your other devices, and signing in
                there reopens the same Passport. Passport does not run that sync
                and cannot see it: if your platform does not sync passkeys, this passkey
                exists on this device only.
              </small>
            </div>
          </li>
          <li className="mnid-bullet">
            <span className="mnid-bullet-mark">
              <Database size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Passport state is encrypted in this browser as you use it</strong>
              <small>
                Passport&apos;s private state is stored in this browser&apos;s IndexedDB,
                encrypted under a key that only a live passkey assertion can produce.
                Clearing this browser&apos;s site data deletes it. It is not copied
                anywhere else — there is no server holding it for you.
              </small>
            </div>
          </li>
        </ul>

        {/* --- Export ------------------------------------------------------ */}
        <div className="mnid-card">
          <div className="mnid-card-head">
            <p className="mnid-kicker">Back up this Passport</p>
          </div>
          <p className="mnid-lede">
            One encrypted file holding what this browser knows and cannot work out again:
            the name you claimed, your account, and anything apps have granted you.
            Chain sync state is left out — a new device rebuilds it from the
            chain.
          </p>

          <div className="mnid-field">
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Password for this backup"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setExportError(null)
              }}
              disabled={busy !== null}
              aria-label="Password for this backup"
            />
          </div>
          <div className={mismatch ? 'mnid-field mnid-field-invalid' : 'mnid-field'}>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Type it again"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy !== null}
              aria-label="Confirm the backup password"
            />
          </div>

          {mismatch ? (
            <p className="mnid-status mnid-status-taken">
              <span className="mnid-status-dot" aria-hidden="true" />
              The two passwords do not match yet.
            </p>
          ) : hint ? (
            <p className={`mnid-status mnid-hint-${hint.level}`}>
              <span className="mnid-status-dot" aria-hidden="true" />
              {hint.message}
            </p>
          ) : null}

          <div className="mnid-panel">
            <p className="mnid-panel-head">
              <TriangleAlert size={15} aria-hidden="true" />
              Lose this password and the backup is gone
            </p>
            <p>
              The password is used on this device and nowhere else. Passport does not store
              it, cannot recover it, and never sends it anywhere. If you forget it, the file
              is unreadable — by you and by everyone else.
            </p>
            <p>
              Your passkey is not in this file and cannot be. The file restores what your
              Passport did; it does not restore the ability to act as it. That still comes
              from your passkey.
            </p>
          </div>

          <div className="mnid-actions" data-toast-clear>
            <button
              type="button"
              className="mnid-primary"
              onClick={() => void runExport()}
              disabled={!canExport}
            >
              {busy === 'export' ? (
                <LoaderCircle className="mnid-spin" size={17} aria-hidden="true" />
              ) : (
                <Download size={17} aria-hidden="true" />
              )}
              {busy === 'export' ? 'Encrypting' : 'Export encrypted backup'}
            </button>
          </div>

          {holdingsProblem ? (
            <p className="mnid-foot">
              <Info size={13} aria-hidden="true" />
              What this browser holds could not be read, so there is nothing to seal:{' '}
              {holdingsProblem}
            </p>
          ) : holdings === null ? null : heldRecords === 0 ? (
            <p className="mnid-foot">
              <Info size={13} aria-hidden="true" />
              This browser holds no name, no account, and no rewards yet, so there
              is nothing to back up.
            </p>
          ) : (
            <p className="mnid-foot">
              <Info size={13} aria-hidden="true" />
              This browser holds {holdings.aliases}{' '}
              {holdings.aliases === 1 ? 'name claim' : 'name claims'}, {holdings.passportContracts}{' '}
              {holdings.passportContracts === 1 ? 'account record' : 'account records'}, and{' '}
              {holdings.incentives} {holdings.incentives === 1 ? 'reward' : 'rewards'}.
            </p>
          )}

          {exportError ? (
            <p className="mnid-status mnid-status-error">
              <span className="mnid-status-dot" aria-hidden="true" />
              {exportError}
            </p>
          ) : null}

          {exported ? (
            <div className="mnid-panel">
              {/* The words come from `describeExportOutcome`, because the two
                  write paths differ in the one thing a user acts on and this
                  panel used to flatten them. `showSaveFilePicker` resolves only
                  once the bytes are on disk; an `<a download>` click is the
                  same non-event whether the file was written, the dialog
                  cancelled, or the download blocked by policy. "Saved as" over
                  the second is a claim this app cannot make, and a user may
                  delete local data on the strength of it. The copy is a pure
                  function in `../identity/backup.ts` so it can be drilled —
                  there is no jsdom here to hold a `.tsx` to a test. */}
              <p className="mnid-panel-head">
                <Info size={15} aria-hidden="true" />
                {describeExportOutcome(exported.outcome).headline}
              </p>
              <p>
                {describeExportOutcome(exported.outcome).detail} It carries{' '}
                {exported.counts.aliases}{' '}
                {exported.counts.aliases === 1 ? 'name claim' : 'name claims'},{' '}
                {exported.counts.passportContracts}{' '}
                {exported.counts.passportContracts === 1 ? 'account record' : 'account records'},
                and {exported.counts.incentives}{' '}
                {exported.counts.incentives === 1 ? 'reward' : 'rewards'}.
              </p>
            </div>
          ) : null}
        </div>

        {/* --- Restore ----------------------------------------------------- */}
        <div className="mnid-card">
          <div className="mnid-card-head">
            <p className="mnid-kicker">Restore a backup</p>
          </div>
          <p className="mnid-lede">
            Choose a backup file and give its password. Records already in this browser that
            are newer than the ones in the file are kept, and the summary says exactly what
            was written.
          </p>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="mnid-file-input"
            onChange={(event) => {
              setPicked(event.target.files?.[0] ?? null)
              setRestoreError(null)
              setRestored(null)
            }}
            aria-label="Backup file to restore"
          />
          <div className="mnid-actions" data-toast-clear>
            <button
              type="button"
              className="mnid-secondary"
              onClick={() => fileInput.current?.click()}
              disabled={busy !== null}
            >
              <Upload size={17} aria-hidden="true" />
              {picked ? picked.name : 'Choose a backup file'}
            </button>
          </div>

          <div className="mnid-field">
            <input
              type="password"
              autoComplete="off"
              placeholder="Password for that backup"
              value={restorePassword}
              onChange={(event) => {
                setRestorePassword(event.target.value)
                setRestoreError(null)
              }}
              disabled={busy !== null}
              aria-label="Password for the backup being restored"
            />
          </div>

          <div className="mnid-actions" data-toast-clear>
            <button
              type="button"
              className="mnid-primary"
              onClick={() => void runRestore()}
              disabled={busy !== null || !picked || restorePassword.length === 0}
            >
              {busy === 'restore' ? (
                <LoaderCircle className="mnid-spin" size={17} aria-hidden="true" />
              ) : (
                <Download size={17} aria-hidden="true" />
              )}
              {busy === 'restore' ? 'Opening' : 'Restore from this file'}
            </button>
          </div>

          {restoreError ? (
            <p className="mnid-status mnid-status-error">
              <span className="mnid-status-dot" aria-hidden="true" />
              {restoreError}
            </p>
          ) : null}

          {restored ? (
            <div className="mnid-panel">
              <p className="mnid-panel-head">
                <Info size={15} aria-hidden="true" />
                {/* The date is the file's, and only a file this app wrote is
                    certain to carry one it can read. `describeBackupCreatedAt`
                    answers null for anything else, and the headline drops the
                    clause rather than printing "Invalid Date" over a restore
                    that actually worked. */}
                {describeBackupCreatedAt(restored.createdAt)
                  ? `Restored from the backup taken ${describeBackupCreatedAt(restored.createdAt)}`
                  : 'Restored from this backup file, which carries no readable date'}
              </p>
              <p>
                Names: {restored.aliases.restored} of {restored.aliases.found}. Accounts:{' '}
                {restored.passportContracts.restored} of {restored.passportContracts.found}.
                Rewards: {restored.incentives.restored} of {restored.incentives.found}.
              </p>
              {[
                ...restored.aliases.skipped,
                ...restored.passportContracts.skipped,
                ...restored.incentives.skipped,
              ].map((skipped, index) => (
                /* The INDEX, because the list is static for one summary and
                   two skips can be identical: a file listing one reward three
                   times produces two settled deferred skips with the same key
                   and the same sentence, and `key:reason` collided on them.
                   React then logged a duplicate key and was free to drop one
                   of the rows on a re-render — a silent drop, in the list this
                   module exists to make sure never happens silently. */
                <p key={index}>
                  <code>{skipped.key}</code> was not written: {skipped.reason}.
                </p>
              ))}
              {/* What the chain actually said about the contract records this
                  restore wrote. A restored record is a claim made by a file;
                  only an indexer read turns it into evidence, and where that
                  read could not happen this says so rather than implying it
                  did. See `confirmRestoredContracts` in App.tsx. */}
              {restored.ledgerCheck === undefined ? (
                <p>
                  The restored account records were not re-checked against the network, so
                  each is a record, not a proof.
                </p>
              ) : restored.ledgerCheck.ran ? (
                <p>
                  Checked against {restored.ledgerCheck.network}:{' '}
                  {restored.ledgerCheck.confirmed} account record(s) confirmed by the network
                  {restored.ledgerCheck.unconfirmed > 0
                    ? `, ${restored.ledgerCheck.unconfirmed} not answered for and now marked as awaiting an answer — a record, not a proof`
                    : ''}
                  {restored.ledgerCheck.otherNetworks > 0
                    ? `, ${restored.ledgerCheck.otherNetworks} left unchecked because they belong to another network`
                    : ''}
                  .
                </p>
              ) : (
                <p>
                  The restored account records were not re-checked against the network:{' '}
                  {restored.ledgerCheck.reason} Until the network answers for one, it is a
                  record, not a proof.
                </p>
              )}
              {/* And the same for a restored NAME. A file can say a name was
                  confirmed; only the registry can. See `confirmRestoredAliases`
                  in `../identity/backup.ts`. */}
              {restored.registryCheck === undefined || !restored.registryCheck.ran ? null : (
                <p>
                  Names re-checked: {restored.registryCheck.confirmed}{' '}
                  confirmed
                  {restored.registryCheck.unconfirmed > 0
                    ? `, ${restored.registryCheck.unconfirmed} still awaiting confirmation — restored as a record, not as a confirmed identity`
                    : ''}
                  {restored.registryCheck.otherNetworks > 0
                    ? `, ${restored.registryCheck.otherNetworks} on a network Passport does not read names from`
                    : ''}
                  {/* The fourth bucket, so the line accounts for every name the
                      restore wrote. A queued or failed claim has no
                      registration for the registry to answer for, and this used
                      to be passed over in silence while "Names: 2 of 2" stood
                      above it. */}
                  {restored.registryCheck.notRegistered > 0
                    ? `, ${restored.registryCheck.notRegistered} with no registration to confirm`
                    : ''}
                  .
                </p>
              )}
              {restored.registryCheck?.ran
                ? (restored.registryCheck.notRegisteredReasons ?? []).map((entry) => (
                    <p key={`not-registered-${entry.network}`}>
                      <code>{entry.network}</code> was not looked up: {entry.reason}.
                    </p>
                  ))
                : null}
              {/* A count cannot tell "the indexer was down" from "that name
                  belongs to somebody else now", and the second is the one the
                  user has to act on. Each unconfirmed name says which. */}
              {restored.registryCheck?.ran
                ? (restored.registryCheck.unconfirmedReasons ?? []).map((entry) => (
                    <p key={`registry-${entry.network}`}>
                      <code>{entry.network}</code> was not confirmed: {entry.reason}.
                    </p>
                  ))
                : null}
            </div>
          ) : null}
        </div>

        <div className="mnid-actions" data-toast-clear>
          <button type="button" className="mnid-secondary" onClick={onDone}>
            <ArrowRight size={17} aria-hidden="true" />
            Done
          </button>
        </div>
      </div>
    </section>
  )
}
