import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ExternalLink, Info, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import './toast-stack.css'

/**
 * Stacked toasts — adapted from the owner's reference. The stack sits above
 * the bottom nav, newest on top, older cards receding by offset/scale/opacity.
 * Additions over the reference: a module-level store so any code can push a
 * toast without prop drilling, auto-dismiss with pause-on-hover, tone icons,
 * a polite live region, and token styling for both themes.
 *
 * Usage: mount <PassportToasts /> once, then from anywhere:
 *   pushToast({ tone: 'success', title: 'Passkey created', body: '…' })
 */

export type ToastTone = 'success' | 'error' | 'info'

/**
 * An outbound link carried by a toast — since 2026/08/06 this is how a
 * transaction reaches its explorer entry, in place of a modal popup.
 *
 * The caller decides whether there is a link at all: a network with no public
 * explorer must pass none rather than be given one that resolves nowhere.
 */
export interface PassportToastLink {
  label: string
  href: string
}

export interface PassportToast {
  id: number
  tone: ToastTone
  title: string
  body?: string
  link?: PassportToastLink
}

type Listener = (toasts: PassportToast[]) => void

/**
 * How many cards are painted at once, and why it is two rather than four.
 *
 * The stack is pinned to the bottom of a phone, which is where a screen's
 * primary action is. Every card it paints is screen the action has to share,
 * and the ones behind the front are already down at 0.8 and 0.6 opacity —
 * they carry "there is another" and not much else. Two says that and costs
 * ten pixels; four cost the height of a button.
 */
const MAX_VISIBLE = 2
const AUTO_DISMISS_MS = 5000
/** A toast carrying a link has to survive long enough to be aimed at. */
const LINKED_DISMISS_MS = 12000

/** Clear air between the top of the stack and whatever it is keeping clear. */
const CLEARANCE_PX = 12
/**
 * How far up the screen the stack may be pushed before the cure is worse than
 * the complaint. A notification pinned to the bottom edge is a notification; one
 * floating in the middle of the page is a dialog nobody asked for.
 */
const HIGHEST_STACK_TOP = 0.45

let nextId = 0
let queue: PassportToast[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener(queue)
}

export function pushToast(toast: Omit<PassportToast, 'id'>): number {
  const id = ++nextId
  queue = [{ ...toast, id }, ...queue]
  emit()
  return id
}

export function dismissToast(id: number) {
  queue = queue.filter((t) => t.id !== id)
  emit()
}

/* Development only: a handle for driving the stack from a test harness, so a
   toast — including its explorer link — can be exercised without first making
   a real transaction. Stripped from production builds by the DEV guard. */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __passportPushToast?: typeof pushToast }).__passportPushToast =
    pushToast
}

const TONE_ICON = {
  success: Check,
  error: AlertTriangle,
  info: Info,
} as const

function Toast({
  toast,
  index,
  onClose,
}: {
  toast: PassportToast
  index: number
  onClose: () => void
}) {
  const isVisible = index < MAX_VISIBLE
  const timer = useRef<number | null>(null)
  const remaining = useRef(toast.link ? LINKED_DISMISS_MS : AUTO_DISMISS_MS)
  const startedAt = useRef(0)

  useEffect(() => {
    // Only the front card counts down; cards behind it wait their turn.
    if (index !== 0) return
    startedAt.current = Date.now()
    timer.current = window.setTimeout(onClose, remaining.current)
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      remaining.current = Math.max(
        1000,
        remaining.current - (Date.now() - startedAt.current),
      )
    }
  }, [index, onClose])

  const pause = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
      remaining.current = Math.max(
        1000,
        remaining.current - (Date.now() - startedAt.current),
      )
    }
  }
  const resume = () => {
    if (index !== 0 || timer.current !== null) return
    startedAt.current = Date.now()
    timer.current = window.setTimeout(onClose, remaining.current)
  }

  const Icon = TONE_ICON[toast.tone]

  return (
    <motion.div
      className={`mntoast mntoast-${toast.tone}`}
      style={{
        zIndex: MAX_VISIBLE - index,
        pointerEvents: isVisible ? 'auto' : 'none',
      }}
      initial={{ opacity: 0, y: 60, scale: 0.85 }}
      animate={{
        opacity: isVisible ? 1 - index * 0.2 : 0,
        y: -index * 10,
        scale: 1 - index * 0.06,
      }}
      exit={{
        opacity: 0,
        scale: 0.8,
        y: 20,
        transition: { duration: 0.2, ease: 'easeIn' },
      }}
      transition={{ type: 'spring', stiffness: 400, damping: 30, delay: index * 0.02 }}
      onPointerEnter={pause}
      onPointerLeave={resume}
    >
      <span className="mntoast-icon" aria-hidden="true">
        <Icon size={15} strokeWidth={2.4} />
      </span>
      <div className="mntoast-content">
        <p className="mntoast-title">{toast.title}</p>
        {toast.body ? <p className="mntoast-body">{toast.body}</p> : null}
        {toast.link ? (
          /* A tap on the link opens the explorer and leaves the stack alone:
             no dismissal of this toast, and none of the ones behind it. The
             countdown is already paused by the pointer being over the card. */
          <a
            className="mntoast-link"
            href={toast.link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            <span>{toast.link.label}</span>
            <ExternalLink size={13} strokeWidth={2.2} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <motion.button
        type="button"
        className="mntoast-close"
        whileTap={{ scale: 0.85 }}
        onClick={onClose}
        aria-label="Dismiss notification"
      >
        <X size={13} strokeWidth={2.2} />
      </motion.button>
    </motion.div>
  )
}

export default function PassportToasts() {
  const [toasts, setToasts] = useState<PassportToast[]>([])
  const viewport = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const listener: Listener = (next) => setToasts([...next])
    listeners.add(listener)
    listener(queue)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  /**
   * THE STACK GETS OUT OF THE WAY OF THE THING IT IS ABOUT.
   *
   * Pinned to the bottom of a 390×844 phone the stack sat exactly on top of
   * the name step's "Claim your name" button and the rules footnote under it,
   * and on Home it covered "Your account is ready" — the line a person is
   * waiting to read when the toast that covers it arrives. The workaround so
   * far was to withhold toasts on the screens where the collision was known
   * (see the `welcomeSeen` guard on the "Passport created" toast in App.tsx),
   * which fixes one toast at a time and loses the notification.
   *
   * So the stack measures instead. Anything marked `data-toast-clear` — a
   * screen's primary action block, the account line on Home — is asked where
   * it is, and if the stack's own band would cross it the stack is lifted by
   * a CSS custom property until it does not, with clear air in between.
   *
   * Measured rather than thresholded on viewport height: "under 700 px tall"
   * is a proxy for "the action is where the toast is", and the actual position
   * of the actual action is available for the asking. Nothing is lifted when
   * nothing would be covered, so the ordinary case — a toast over scrollable
   * page body — is untouched.
   *
   * Two clamps keep the remedy proportionate: only elements the stack would
   * REALLY cross count (an action scrolled up to the top of Home is not being
   * covered by anything), and the lift stops at
   * {@link HIGHEST_STACK_TOP} of the viewport.
   */
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const measure = () => {
      /* From a known zero every time: the lift is recomputed, not accumulated,
         so a screen that no longer needs one gets none. Reading a box below
         flushes the style change, which is what makes this honest. */
      node.style.setProperty('--mn-toast-lift', '0px')
      if (toasts.length === 0) return

      const anchor = node.getBoundingClientRect().bottom
      const front = node.querySelector<HTMLElement>('.mntoast')
      /* `offsetHeight`, not the client rect: the card may be mid-spring, and a
         scaled card would have the stack measure itself smaller than it is
         about to be. */
      const stackHeight = (front ? front.offsetHeight : 0) + (MAX_VISIBLE - 1) * 10
      const stackTop = anchor - stackHeight

      let lift = 0
      for (const element of document.querySelectorAll('[data-toast-clear]')) {
        const box = element.getBoundingClientRect()
        if (box.height === 0) continue
        // Not in the stack's band, so not being covered by it.
        if (box.top >= anchor || box.bottom <= stackTop) continue
        lift = Math.max(lift, anchor - box.top + CLEARANCE_PX)
      }
      if (lift === 0) return

      const ceiling = Math.max(0, stackTop - window.innerHeight * HIGHEST_STACK_TOP)
      node.style.setProperty('--mn-toast-lift', `${Math.min(lift, ceiling)}px`)
    }

    measure()
    if (toasts.length === 0) return

    /* A rotation moves the action; so does scrolling Home. Both are cheap to
       answer and only listened for while there is something on screen. */
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    /* AND THE SCREEN ITSELF CAN ARRIVE AFTER THE TOAST. "Welcome back" is
       pushed while the wallet is still opening, so the first measurement runs
       against a screen with no action on it at all and the name step mounts a
       moment later — measured here, that was the whole reason the first cut of
       this lifted nothing on the very screen it was written for. A short poll
       for as long as a toast is up costs four rect reads a second and needs no
       opinion about which of another screen's re-renders matters. */
    const poll = window.setInterval(measure, 250)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [toasts])

  return (
    <div className="mntoast-viewport" ref={viewport} role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.slice(0, MAX_VISIBLE + 2).map((toast, index) => (
          <Toast
            key={toast.id}
            toast={toast}
            index={index}
            onClose={() => dismissToast(toast.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}
