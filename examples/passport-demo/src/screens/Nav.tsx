import { House, LayoutGrid } from 'lucide-react'
import './nav.css'

/**
 * Bottom navigation for the mobile Passport experience.
 *
 * Both screens reserve 76px of bottom padding, which is exactly the height of
 * this bar. It sits at z-index 100, beneath the PWA install and update actions
 * at 105, so those controls remain reachable.
 */

export type MobileTab = 'home' | 'apps'

export interface PassportNavProps {
  active: MobileTab
  onSelect: (tab: MobileTab) => void
}

const TABS: { key: MobileTab; label: string; icon: typeof House }[] = [
  { key: 'home', label: 'Home', icon: House },
  { key: 'apps', label: 'Apps', icon: LayoutGrid },
]

export default function PassportNav(props: PassportNavProps) {
  const { active, onSelect } = props

  return (
    <nav className="mnnav" aria-label="Passport sections">
      {TABS.map((tab) => {
        const Icon = tab.icon
        const current = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            className={current ? 'mnnav-tab mnnav-tab-active' : 'mnnav-tab'}
            onClick={() => onSelect(tab.key)}
            aria-current={current ? 'page' : undefined}
          >
            <Icon size={19} strokeWidth={current ? 2.2 : 1.8} aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
