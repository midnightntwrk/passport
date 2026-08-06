import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { RAFFLE_DEMO_APP, type RegistryApp } from '../lib/registry'
import RaffleArt from './RaffleArt.js'
import './app-folder.css'

/**
 * iOS-style app folder for the Passport app grid — a closed preview tile
 * (three large tiles plus a 2x2 mini-grid) that springs open into the full
 * grid, with the mini-grid tiles morphing via shared layoutIds and the rest
 * staggering in from the folder's centre.
 *
 * Adapted from the owner's reference implementation; restyled to the token
 * system (both themes), wired to RegistryApp, and with reduced-motion respect
 * via MotionConfig. Tapping a tile in the open state opens the app; tapping
 * the backdrop closes the folder.
 */

const layoutSpring = {
  type: 'spring',
  stiffness: 200,
  damping: 22,
  bounce: 0,
} as const

interface FolderItem extends RegistryApp {
  layoutId?: string
}

function toFolderItems(apps: RegistryApp[]): FolderItem[] {
  // The first three apps render as the large preview tiles; the next four
  // live in the mini-grid and morph open via shared layout animations.
  return apps.map((app, index) => ({
    ...app,
    layoutId: index >= 3 && index < 7 ? `mnfold-${app.id}` : undefined,
  }))
}

function TileImage({
  app,
  layoutId,
}: {
  app: RegistryApp
  layoutId?: string
}) {
  const [broken, setBroken] = useState(false)
  /* Our own entry, so our own drawing rather than a bare letter tile. */
  if (app.id === RAFFLE_DEMO_APP.id) {
    return (
      <motion.span
        className="mnfold-tile mnfold-tile-art"
        aria-label={app.name}
        layoutId={layoutId}
      >
        <RaffleArt />
      </motion.span>
    )
  }
  if (broken || !app.icon) {
    return (
      <motion.span
        className="mnfold-tile mnfold-tile-letter"
        aria-label={app.name}
        layoutId={layoutId}
      >
        {app.name.slice(0, 1).toUpperCase()}
      </motion.span>
    )
  }
  return (
    <motion.img
      className="mnfold-tile"
      src={app.icon}
      alt={app.name}
      referrerPolicy="no-referrer"
      draggable={false}
      layoutId={layoutId}
      onError={() => setBroken(true)}
    />
  )
}

function OpenGridItem({
  item,
  idx,
  items,
  itemRefs,
  itemOffsets,
  offsetsReady,
  onOpenApp,
}: {
  item: FolderItem
  idx: number
  items: FolderItem[]
  itemRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  itemOffsets: Record<string, { x: number; y: number }>
  offsetsReady: boolean
  onOpenApp: (app: RegistryApp) => void
}) {
  const off = itemOffsets[item.id] ?? { x: 0, y: 0 }
  const hasLayout = Boolean(item.layoutId)

  const nonLayoutTotal = items.filter((i) => !i.layoutId).length
  const nonLayoutIdx = items.slice(0, idx).filter((i) => !i.layoutId).length

  const openDelay = offsetsReady
    ? item.layoutId
      ? 0
      : -0.025 + nonLayoutIdx * 0.025
    : 0
  const closeDelay = offsetsReady
    ? item.layoutId
      ? 0
      : -0.095 + (nonLayoutTotal - 1 - nonLayoutIdx) * 0.025
    : 0

  return (
    <motion.div
      className="mnfold-open-item"
      ref={(el) => {
        itemRefs.current[item.id] = el
      }}
      initial={
        hasLayout
          ? { opacity: 1 }
          : offsetsReady
            ? { opacity: 0, scale: 0.2, x: off.x, y: off.y }
            : { opacity: 0 }
      }
      animate={
        hasLayout
          ? { opacity: 1 }
          : offsetsReady
            ? { opacity: 1, scale: 1, x: 0, y: 0 }
            : { opacity: 0 }
      }
      exit={
        hasLayout
          ? { opacity: 1 }
          : {
              opacity: 0,
              scale: 0.2,
              x: off.x,
              y: off.y,
              transition: {
                type: 'spring',
                stiffness: 200,
                damping: 22,
                delay: closeDelay,
                opacity: { delay: 0.05 },
              },
            }
      }
      transition={{ type: 'spring', stiffness: 200, damping: 22, delay: openDelay }}
    >
      <button
        type="button"
        className="mnfold-open-tile-box"
        aria-label={`Open ${item.name}`}
        onClick={(event) => {
          event.stopPropagation()
          onOpenApp(item)
        }}
      >
        <TileImage app={item} layoutId={item.layoutId} />
      </button>

      {item.layoutId ? (
        <motion.div layoutId={`label-${item.layoutId}`} className="mnfold-open-label">
          {item.name}
        </motion.div>
      ) : (
        <div className="mnfold-open-label">{item.name}</div>
      )}
    </motion.div>
  )
}

export interface AppFolderProps {
  title: string
  apps: RegistryApp[]
  onOpenApp: (app: RegistryApp) => void
}

export default function AppFolder({ title, apps, onOpenApp }: AppFolderProps) {
  const items = toFolderItems(apps)
  const [isOpen, setIsOpen] = useState(false)
  const miniGridRef = useRef<HTMLDivElement>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [itemOffsets, setItemOffsets] = useState<Record<string, { x: number; y: number }>>({})

  const openFolder = useCallback(() => {
    const rect = miniGridRef.current?.getBoundingClientRect()
    if (rect) {
      setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    }
    setIsOpen(true)
  }, [])

  const closeFolder = useCallback(() => setIsOpen(false), [])

  useLayoutEffect(() => {
    if (!isOpen || !origin) return
    const next: Record<string, { x: number; y: number }> = {}
    for (const item of items) {
      const el = itemRefs.current[item.id]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      next[item.id] = {
        x: origin.x - (rect.left + rect.width / 2),
        y: origin.y - (rect.top + rect.height / 2),
      }
    }
    setItemOffsets(next)
    // items is derived 1:1 from the apps prop; origin/isOpen drive the measurement pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, origin])

  const offsetsReady = Boolean(
    isOpen && origin && Object.keys(itemOffsets).length === items.length,
  )

  return (
    <MotionConfig transition={layoutSpring} reducedMotion="user">
      <div className="mnfold-root">
        <AnimatePresence mode="popLayout" initial={false}>
          {!isOpen ? (
            <motion.button
              key="closed"
              type="button"
              className="mnfold-closed"
              onClick={openFolder}
              aria-label={`Open the ${title} folder`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 200, damping: 22 }}
            >
              <span className="mnfold-preview">
                <span className="mnfold-preview-grid">
                  {items
                    .filter((item) => !item.layoutId)
                    .slice(0, 3)
                    .map((item) => (
                      <TileImage key={item.id} app={item} />
                    ))}
                  <span className="mnfold-mini-grid" ref={miniGridRef as never}>
                    {items
                      .filter((item) => item.layoutId)
                      .slice(0, 4)
                      .map((item) => (
                        <span key={item.id} className="mnfold-mini-cell">
                          <TileImage app={item} layoutId={item.layoutId} />
                          <motion.span
                            layoutId={`label-${item.layoutId}`}
                            className="mnfold-mini-label"
                            style={{ opacity: 0 }}
                            aria-hidden="true"
                          >
                            {item.name}
                          </motion.span>
                        </span>
                      ))}
                  </span>
                </span>
              </span>
              <span className="mnfold-name">{title}</span>
            </motion.button>
          ) : null}
        </AnimatePresence>
        {/* Portalled to <body>: the screens animate in with an opacity
            keyframe, which makes them stacking contexts, so the fixed bottom
            nav (z 99/100) would otherwise paint over this fixed overlay no
            matter how high its own z-index went. Its own AnimatePresence
            keeps exit tracking working across the portal boundary. */}
        {createPortal(
          <AnimatePresence
            onExitComplete={() => {
              if (!isOpen) {
                setItemOffsets({})
                setOrigin(null)
              }
            }}
          >
            {isOpen ? (
            <motion.div
              key="open"
              className="mnfold-overlay"
              onClick={closeFolder}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { delay: 0.025 } }}
            >
              <motion.div className="mnfold-open-folder">
                <motion.div
                  className="mnfold-open-title"
                  initial={{ opacity: 0, y: 30, x: 10, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    y: 30,
                    x: 10,
                    scale: 0.8,
                    transition: { type: 'spring', stiffness: 300, damping: 22 },
                  }}
                  transition={{ type: 'spring', stiffness: 200, damping: 19 }}
                >
                  {title}
                </motion.div>
                <div className="mnfold-open-grid">
                  {items.map((item, idx) => (
                    <OpenGridItem
                      key={
                        item.layoutId
                          ? item.id
                          : `${item.id}-${offsetsReady ? 'ready' : 'wait'}`
                      }
                      item={item}
                      idx={idx}
                      items={items}
                      itemRefs={itemRefs}
                      itemOffsets={itemOffsets}
                      offsetsReady={offsetsReady}
                      onOpenApp={onOpenApp}
                    />
                  ))}
                </div>
              </motion.div>
            </motion.div>
            ) : null}
          </AnimatePresence>,
          document.body,
        )}
      </div>
    </MotionConfig>
  )
}
