import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect } from 'react'

import './sync-ring.css'

/**
 * Animated circular progress for the live wallet sync — motion pathLength
 * sweep with the percentage numeral sharpening out of a blur as the walk
 * completes. Adapted from the owner's reference: the Base UI wrapper is
 * dropped (plain markup with progressbar semantics), and instead of a fixed
 * one-shot 0→100 tween the ring glides toward each LIVE reading as
 * subscribeSyncProgress ticks (~1/sec).
 *
 * `tone` picks the stroke: 'sync' renders the muted walk gauge, 'charge' the
 * accent-blue DUST fill.
 */
export interface SyncRingProps {
  /** 0–100. The ring animates toward each new value. */
  percent: number
  tone: 'sync' | 'charge'
  /** Accessible label, e.g. "Wallet sync 43 per cent complete". */
  label: string
}

const RING_PATH = 'M50 10 A40 40 0 1 1 50 90 A40 40 0 1 1 50 10'

export default function SyncRing({ percent, tone, label }: SyncRingProps) {
  const progress = useMotionValue(0)
  const rounded = useTransform(() => Math.round(progress.get()))
  const pathLength = useTransform(progress, [0, 100], [0, 1])
  const strokeLinecap = useTransform(() => (pathLength.get() === 0 ? 'none' : 'round'))

  useEffect(() => {
    const clamped = Math.max(0, Math.min(100, percent))
    const controls = animate(progress, clamped, {
      duration: 0.6,
      ease: [0.31, 0.05, 0.28, 0.85],
    })
    return () => controls.stop()
  }, [percent, progress])

  return (
    <div
      className={`mnsync-ring mnsync-ring-${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
    >
      <svg className="mnsync-svg" viewBox="0 0 100 100" aria-hidden="true">
        <path
          className="mnsync-track"
          d={RING_PATH}
          fill="none"
          strokeWidth="8"
        />
        <motion.path
          className="mnsync-fill"
          d={RING_PATH}
          fill="none"
          strokeWidth="8"
          style={{ pathLength, strokeLinecap }}
        />
      </svg>
      <div className="mnsync-value-box">
        {/* The blur is a mount-in flourish only — the reference tied it to
            progress, which left the numeral illegible while a slow chain walk
            sat at low percentages. It must be readable at any percent. */}
        <motion.div
          className="mnsync-value"
          initial={{ opacity: 0, scale: 0.85, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          <motion.span>{rounded}</motion.span>
          <span className="mnsync-unit">%</span>
        </motion.div>
      </div>
    </div>
  )
}
