import { BadgeCheck, LoaderCircle, UserRound } from 'lucide-react'

import { useDynamicSession } from '../lib/dynamic.js'

/**
 * "Continue with Google, Discord, Microsoft, or X" — the secondary way in,
 * and the whole of stage 1 of passport-demo #20 on the welcome screen.
 *
 * IT RENDERS NOTHING IN EVERY BUILD SHIPPED TODAY
 * -----------------------------------------------
 * `useDynamicSession()` reports `disabled` unless the build was given a
 * `VITE_DYNAMIC_ENVIRONMENT_ID`, and `disabled` returns `null` on the first
 * line. That is why this is a component rather than four props threaded down
 * from `App.tsx`: the flag is read where the flag is used, and a build without
 * it renders the same DOM it rendered before this file existed.
 *
 * WHY IT DOES NOT REPLACE THE PASSKEY
 * -----------------------------------
 * Signing in here proves WHO somebody is to Dynamic. It does not give this
 * Passport a key it can act with: the passkey on this device is still what
 * every call is authorised by, unchanged by this slice. So the primary button
 * above stays the way forward, and a signed-in person is told plainly that
 * there is still a passkey to make — the alternative is a screen that accepts
 * a sign-in and then asks for a fingerprint with no explanation, which reads
 * as the app having forgotten what just happened.
 *
 * Whether Google, Discord, Microsoft, and X are actually offered inside the
 * overlay is a Dynamic dashboard setting, not something this file decides. See
 * `docs/demo/dynamic-integration.md`.
 */
export default function ContinueWithSocial() {
  const session = useDynamicSession()

  if (session.status === 'disabled') return null

  if (session.status === 'loading') {
    return (
      <p className="mnob-social-note" role="status">
        <LoaderCircle size={13} className="mnob-social-spin" aria-hidden="true" />
        Getting the other ways in ready
      </p>
    )
  }

  if (session.status === 'signed-in') {
    const who = session.handle ?? 'your account'
    const via = session.provider ? ` with ${session.provider}` : ''
    return (
      <p className="mnob-social-note" role="status">
        <BadgeCheck size={13} aria-hidden="true" />
        {/* Says what happened AND what is still required, in one sentence,
            because the button above has not changed and needs to not look
            like a mistake. */}
        Signed in{via} as {who}. Finish with your passkey above.
      </p>
    )
  }

  return (
    <button type="button" className="mnob-social" onClick={session.openAuthFlow}>
      <UserRound size={15} strokeWidth={2} aria-hidden="true" />
      <span>Continue with Google, Discord, Microsoft, or X</span>
    </button>
  )
}
