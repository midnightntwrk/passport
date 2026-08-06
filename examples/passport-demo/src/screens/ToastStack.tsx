import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ExternalLink, Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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

const MAX_VISIBLE = 4
const AUTO_DISMISS_MS = 5000
/** A toast carrying a link has to survive long enough to be aimed at. */
const LINKED_DISMISS_MS = 12000

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

  useEffect(() => {
    const listener: Listener = (next) => setToasts([...next])
    listeners.add(listener)
    listener(queue)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return (
    <div className="mntoast-viewport" role="status" aria-live="polite">
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
