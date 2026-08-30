import { ArrowRight, BadgeCheck, Fingerprint, Sparkles, Tag } from 'lucide-react'

import './identity.css'

/**
 * The first thing a brand-new Passport sees, and the only screen in the app
 * that exists purely to say what Passport IS.
 *
 * WHY IT EXISTS
 * -------------
 * Until now a passkey ceremony ended by dropping the user straight onto
 * "Choose your .night name" — a screen that assumes the reader already knows
 * what a Passport is, what a name is for, and who is paying. Two reviewers on
 * 2026/08/26 asked for the missing half: "an intro page… what is this, what am
 * I getting" (Hector, 09:47), and again at 11:35. Four lines, and then the
 * name step they were always going to reach.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a tour, not a carousel, and not a wall. There is one screen and one
 * action, and nobody is asked to read it twice: the dismissal is stored per
 * credential and survives a reload and a sign-out.
 *
 * WHY THERE IS NO SKIP
 * --------------------
 * There was one until 2026/08/30, sitting under the primary action and leading
 * to the same place, because the name step is not something a Passport may
 * walk past — the custody account is set up THROUGH the claim. A reviewer
 * pressed it on the deployed site and arrived at a mandatory screen, which is
 * what a skip promises not to do. A control whose label describes an escape
 * that does not exist is worse than no control: it costs a tap and it teaches
 * the reader that this app's words are approximate.
 *
 * Skipping the READING is not worth a button either — the four lines below are
 * shorter than the sentence explaining what pressing it would have done.
 *
 * If a name ever becomes optional, the control comes back and means it.
 *
 * It is shown ONLY to a Passport this session created. Signing in on a second
 * device is not a first impression, and being welcomed to something you have
 * been using for a week reads as an app that has forgotten you.
 *
 * Every line is a promise the build actually keeps today. Nothing here
 * describes a feature that is coming: an intro screen is the worst possible
 * place to over-claim, because it is read before anything can contradict it.
 */

export interface WelcomeProps {
  /** Continue to the name step. The only thing this screen does. */
  onChooseName: () => void
}

/** The four promises, each one a thing this build does today. */
const POINTS = [
  {
    icon: Fingerprint,
    title: 'An identity you hold',
    body: 'Your Passport lives on this device, behind the passkey you just made. Nobody issues it to you and nobody can take it back.',
  },
  {
    icon: Tag,
    title: 'A name, not an address',
    body: 'Pick a name people can actually send to and apps can recognise you by, instead of a long string you have to copy carefully.',
  },
  {
    icon: Sparkles,
    title: 'Fees are covered for you',
    body: 'You hold nothing and spend nothing to get started. Setting your Passport up is paid for on your behalf.',
  },
  {
    icon: BadgeCheck,
    title: 'Prove things privately',
    body: 'Share what an app genuinely needs to know about you — and nothing else. You are asked every time, and you can say no.',
  },
] as const

export default function WelcomeScreen({ onChooseName }: WelcomeProps) {
  return (
    <section className="mnid-screen">
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnid-step">Welcome</span>
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Your Passport is ready</p>
        <h1 className="mnid-title">Welcome to Passport</h1>
        <p className="mnid-lede">
          Your passkey now holds a Passport on this device. Here is what that gives you.
        </p>

        <ul className="mnid-points">
          {POINTS.map((point) => (
            <li key={point.title} className="mnid-point">
              <span className="mnid-point-mark" aria-hidden="true">
                <point.icon size={16} strokeWidth={2} />
              </span>
              <span className="mnid-point-text">
                <span className="mnid-point-title">{point.title}</span>
                <span className="mnid-point-body">{point.body}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mnid-actions" data-toast-clear>
          {/* One control, and it says where it goes. See "WHY THERE IS NO
              SKIP" above: the button that used to sit under this one led to
              the same mandatory screen. */}
          <button type="button" className="mnid-primary" onClick={onChooseName}>
            <ArrowRight size={17} aria-hidden="true" />
            Choose my name
          </button>
        </div>
      </div>
    </section>
  )
}
