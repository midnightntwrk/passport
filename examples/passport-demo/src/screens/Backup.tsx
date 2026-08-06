import { ArrowRight, Database, Info, KeyRound } from 'lucide-react'

import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Backup — onboarding step 3, optional.
 *
 * What backup HONESTLY is today, and nothing more:
 *
 *   1. the passkey is a platform credential, so it follows the user's devices
 *      wherever the platform syncs it (iCloud Keychain, Google Password
 *      Manager). Passport neither performs nor observes that sync;
 *   2. the encrypted Passport record already written in this browser
 *      (`IndexedDbPassportEncryptedRecordStore`), unlocked by that passkey.
 *
 * There is deliberately no cloud backup, no seed phrase, no export, and no
 * "backup complete" claim — because none of those things happen here. The
 * screen's only job is to tell the truth about where recovery stands.
 */

export interface BackupProps {
  /** True when an encrypted Passport record genuinely exists in this browser. */
  hasEncryptedRecord: boolean
  onUnderstood: () => void
  onLater: () => void
}

export default function BackupScreen(props: BackupProps) {
  const { hasEncryptedRecord, onUnderstood, onLater } = props

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
          Two things stand between you and losing access. Both already exist — this step
          only explains them, and neither depends on Passport holding a copy of anything.
        </p>

        <ul className="mnid-bullets">
          <li className="mnid-bullet">
            <span className="mnid-bullet-mark">
              <KeyRound size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Your passkey follows your devices</strong>
              <small>
                The passkey you just created is a platform credential. If your device syncs
                passkeys — iCloud Keychain on Apple devices, Google Password Manager on
                Android and Chrome — it is already on your other devices, and signing in
                there re-derives the same Midnight wallet. Passport does not run that sync
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
              <strong>
                {hasEncryptedRecord
                  ? 'Your Passport state is encrypted in this browser'
                  : 'Passport state is encrypted in this browser as you use it'}
              </strong>
              <small>
                Passport&apos;s private state is stored in this browser&apos;s IndexedDB,
                encrypted under a key that only a live passkey assertion can produce.
                Clearing this browser&apos;s site data deletes it. It is not copied
                anywhere else — there is no server holding it for you.
              </small>
            </div>
          </li>
        </ul>

        <div className="mnid-panel">
          <p className="mnid-panel-head">
            <Info size={15} aria-hidden="true" />
            What this step does not do
          </p>
          <p>
            Nothing is uploaded or exported by pressing Understood. There is no recovery phrase to
            write down in this demo, and Passport will never claim your Passport has been copied to
            a cloud service — because it has not been.
          </p>
        </div>

        <div className="mnid-actions">
          <button type="button" className="mnid-primary" onClick={onUnderstood}>
            <ArrowRight size={17} aria-hidden="true" />
            Understood
          </button>
          <button type="button" className="mnid-secondary" onClick={onLater}>
            Do this later
          </button>
        </div>
      </div>
    </section>
  )
}
