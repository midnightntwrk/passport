import { useState } from 'react'
import { BadgeCheck, Check, Copy, LoaderCircle, PenLine } from 'lucide-react'

import { useDynamicSession } from '../lib/dynamic.js'
import { DYNAMIC_TEST_MESSAGE, shortEvmAddress } from '../lib/dynamicSession.js'
import './dynamic-identity.css'

/**
 * The signed-in identity, on Home, beside "Back up or restore".
 *
 * WHAT IT IS FOR
 * --------------
 * Two things, and it says both of them on screen. First, a person who signed
 * in with a provider can see that Passport knows it — an identity that is
 * accepted and then never mentioned again is indistinguishable from one that
 * was dropped. Second, "Sign a test message" is the EVIDENCE the next slice
 * runs on: it is the only way to see, from the outside, what this signer
 * actually returns for a known pre-image, and whether it returns the same
 * thing twice. `docs/demo/dynamic-integration.md` says what is still open.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a control over anything this Passport does. Nothing about how this
 * account is authorised changed in this slice: the passkey on this device is
 * still the key behind every call, and the key named here has never signed one
 * — which is why the copy below calls the signature "a test" and stops there
 * rather than implying it is in the loop.
 *
 * Renders nothing unless this build was given a `VITE_DYNAMIC_ENVIRONMENT_ID`
 * and somebody has signed in, which is no build shipped today.
 */
export default function DynamicIdentity() {
  const session = useDynamicSession()
  const [signing, setSigning] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  /* Only a signed-in session has anything to show. `loading` and `signed-out`
     both render nothing here: Home is not the place to explain a sign-in
     nobody has started — the welcome screen already offered it. */
  if (session.status !== 'signed-in') return null

  const runSignTest = async () => {
    setSigning(true)
    setError(null)
    setSignature(null)
    setCopied(false)
    try {
      setSignature(await session.signMessage(DYNAMIC_TEST_MESSAGE))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSigning(false)
    }
  }

  const copySignature = () => {
    if (!signature) return
    void navigator.clipboard?.writeText(signature)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_600)
  }

  return (
    <section className="mndyn" aria-label="Signed-in identity">
      <p className="mndyn-who">
        <BadgeCheck size={14} aria-hidden="true" />
        <span>
          {session.provider ? `${session.provider} · ` : ''}
          {session.handle ?? 'Signed in'}
        </span>
      </p>

      {session.evmAddress ? (
        /* `title` carries the whole thing, because the shortened form is for
           recognising at a glance and the full one is what anybody checking
           against another screen needs. */
        <p className="mndyn-addr" title={session.evmAddress}>
          Ethereum address {shortEvmAddress(session.evmAddress)}
        </p>
      ) : (
        <p className="mndyn-addr">Setting up your Ethereum address</p>
      )}

      <button
        type="button"
        className="mnhome-support mndyn-action"
        onClick={() => void runSignTest()}
        disabled={signing}
      >
        {signing ? (
          <LoaderCircle size={14} className="mndyn-spin" aria-hidden="true" />
        ) : (
          <PenLine size={14} aria-hidden="true" />
        )}
        <span>{signing ? 'Signing' : 'Sign a test message'}</span>
      </button>

      {error ? (
        <p className="mndyn-note mndyn-note-error" role="alert">
          {error}
        </p>
      ) : null}

      {signature ? (
        <div className="mndyn-result">
          <p className="mndyn-note">
            Signed “{DYNAMIC_TEST_MESSAGE}”. This is a test only — nothing in your Passport is held
            by this key.
          </p>
          <p className="mndyn-sig">{signature}</p>
          <button type="button" className="mndyn-copy" onClick={copySignature}>
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span>{copied ? 'Copied' : 'Copy signature'}</span>
          </button>
        </div>
      ) : null}
    </section>
  )
}
