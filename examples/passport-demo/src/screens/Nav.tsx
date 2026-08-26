import { House, LayoutGrid } from 'lucide-react'
import './nav.css'

/**
 * Bottom navigation for the mobile Passport experience.
 *
 * Both screens reserve bottom padding for the bar's zone. The bar sits at
 * z-index 100, beneath the PWA install and update actions at 105, so those
 * controls remain reachable.
 *
 * The bar is a floating card with a gap beneath it and gutters beside it, so
 * a sibling backdrop strip (z-index 99) spans the full viewport width behind
 * it, painted in the page surface. Scrolled content disappears cleanly at the
 * strip's top hairline instead of slicing through the gaps around the card.
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
    <>
      <div className="mnnav-backdrop" aria-hidden="true" />
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
    </>
  )
}
