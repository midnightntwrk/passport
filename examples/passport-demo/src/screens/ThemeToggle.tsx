import { Monitor, Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import {
  DEFAULT_THEME,
  getThemePreference,
  setTheme,
  subscribeToTheme,
  type ThemePreference,
} from '../lib/theme.js'
import './theme-toggle.css'

/**
 * Theme control for the Passport top bar.
 *
 * Drop it into the Home header beside the refresh and sign-out buttons:
 *
 * ```tsx
 * <div className="mnhome-bar-actions">
 *   <ThemeToggle />
 *   …
 * </div>
 * ```
 *
 * It owns nothing: the preference lives in `../lib/theme.ts` and is persisted
 * under the localStorage key 'passport-theme'. Any number of these can be
 * mounted and they stay in step.
 */

export interface ThemeToggleProps {
  /** Both sizes share the 34px control height; `sm` narrows the segments. */
  size?: 'sm' | 'md'
  /** Extra class names, appended to the control's own. */
  className?: string
  /** Accessible name for the group. */
  label?: string
}

const OPTIONS: {
  value: ThemePreference
  label: string
  icon: typeof Sun
}[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
]

function subscribe(onChange: () => void): () => void {
  return subscribeToTheme(onChange)
}

function getSnapshot(): ThemePreference {
  return getThemePreference()
}

function getServerSnapshot(): ThemePreference {
  return DEFAULT_THEME
}

export default function ThemeToggle(props: ThemeToggleProps) {
  const { size = 'md', className, label = 'Colour theme' } = props
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const classes = ['mnthemetoggle']
  if (size === 'sm') classes.push('mnthemetoggle-sm')
  if (className) classes.push(className)

  return (
    <div className={classes.join(' ')} role="group" aria-label={label}>
      {OPTIONS.map((option) => {
        const Icon = option.icon
        const on = option.value === preference
        return (
          <button
            key={option.value}
            type="button"
            className={on ? 'mnthemetoggle-option mnthemetoggle-option-on' : 'mnthemetoggle-option'}
            onClick={() => setTheme(option.value)}
            aria-pressed={on}
            aria-label={option.label}
            title={option.label}
          >
            <Icon size={size === 'sm' ? 13 : 15} strokeWidth={on ? 2.2 : 1.8} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
