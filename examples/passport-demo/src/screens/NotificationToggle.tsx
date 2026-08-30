import { Bell, BellOff, BellRing } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'

import {
  notificationPermission,
  notificationsEnabled,
  notify,
  requestNotificationPermission,
  setNotificationsEnabled,
  subscribeToNotifications,
} from '../lib/notifications.js'
import './notification-toggle.css'

/**
 * The one control for system notifications, for the quiet row at the foot of
 * Home beside "Back up or restore".
 *
 * It owns nothing: the permission belongs to the browser and the mute switch
 * to `../lib/notifications.ts`. Any number of these can be mounted and they
 * stay in step.
 *
 * What each state says, and why
 * -----------------------------
 * - No API at all → the control renders NOTHING. An iOS Safari tab cannot
 *   raise a notification however hard it is asked, and a dead switch would
 *   only invite someone to press it.
 * - Never asked → "Turn on notifications". The tap is the user gesture every
 *   browser requires before a permission prompt, which is the whole reason
 *   this is a control rather than something the app does at startup.
 * - Granted → a real toggle, because permission is one-way. The browser will
 *   not take a grant back, so muting is recorded locally and honoured by
 *   `notify()`.
 * - Denied → the button goes flat and the browser-settings sentence appears.
 *   It never asks again: a denied origin cannot be re-prompted from script, so
 *   a control that kept trying would be lying about what a tap can do.
 *
 * Scope: this is the in-app Notification API, not background Web Push. A
 * closed Passport notifies nobody. See the scope note in
 * `../lib/notifications.ts` before promising anyone otherwise.
 */

function getServerPermission(): ReturnType<typeof notificationPermission> {
  return 'unsupported'
}

function getServerEnabled(): boolean {
  return true
}

export interface NotificationToggleProps {
  /** Extra class names, appended to the control's own. */
  className?: string
}

export default function NotificationToggle(props: NotificationToggleProps) {
  const { className } = props
  /* Two subscriptions rather than one state object: `useSyncExternalStore`
     compares snapshots by identity, and a freshly built object every read
     would re-render for ever. */
  const permission = useSyncExternalStore(
    subscribeToNotifications,
    notificationPermission,
    getServerPermission,
  )
  const enabled = useSyncExternalStore(
    subscribeToNotifications,
    notificationsEnabled,
    getServerEnabled,
  )
  const [asking, setAsking] = useState(false)

  if (permission === 'unsupported') return null

  const on = permission === 'granted' && enabled
  const denied = permission === 'denied'

  const onTap = () => {
    if (denied || asking) return
    if (permission === 'granted') {
      setNotificationsEnabled(!enabled)
      return
    }
    setAsking(true)
    void requestNotificationPermission()
      .then((answer) => {
        /* One confirming notification on the grant. It is the only honest
           proof the permission works on this device — the shade either opens
           or it does not — and it costs the user exactly one buzz. */
        if (answer === 'granted') {
          void notify(
            'Notifications are on',
            'Passport will tell you when NIGHT arrives, and when your name and your account are ready.',
            { tag: 'passport-notifications-on' },
          )
        }
      })
      .finally(() => setAsking(false))
  }

  const Icon = denied ? BellOff : on ? BellRing : Bell
  const label = denied
    ? 'Notifications blocked'
    : asking
      ? 'Asking your browser…'
      : permission === 'granted'
        ? on
          ? 'Notifications on'
          : 'Notifications off'
        : 'Turn on notifications'

  const classes = ['mnhome-support', 'mnnotify-button']
  if (on) classes.push('mnnotify-button-on')
  if (className) classes.push(className)

  return (
    <div className="mnnotify">
      <button
        type="button"
        className={classes.join(' ')}
        onClick={onTap}
        disabled={denied || asking}
        aria-pressed={permission === 'granted' ? on : undefined}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {denied ? (
        <p className="mnnotify-note">
          Your browser is blocking notifications for Passport. This page cannot ask again — turn
          them back on in the browser's site settings for this address.
        </p>
      ) : null}
    </div>
  )
}
