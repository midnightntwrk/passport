import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

import {
  createGame,
  FIELD,
  formatScore,
  jump,
  pause,
  score,
  tick,
  type WaitingGameState,
} from '../lib/waitingGame.js'
import './waiting-game.css'

/**
 * The waiting game's canvas — a frame loop, two listeners, and a painter.
 *
 * IT HOLDS NO RULES. Where the runner is, where the obstacles are, whether
 * they have met, and what the score is are all decided by
 * `../lib/waitingGame.ts`, which is drilled; this file measures the frame,
 * hands the milliseconds over, and paints what comes back.
 *
 * WHAT IT MUST NEVER DO, which is the whole reason it is written this way:
 *
 *   It never covers anything. The panel is a sibling BENEATH the stepper in
 *   normal flow — no overlay, no fixed position, no portal — so the steps, the
 *   timer, and any prompt over them are exactly as reachable with it open as
 *   without it.
 *
 *   It stops dead when asked. `paused` stops the loop and takes the canvas out
 *   of the document in the same render, so the instant the host sees a passkey
 *   prompt the game is neither drawing nor on screen. The run itself survives
 *   in a ref, so coming back is coming back rather than starting again.
 *
 *   It never takes a key the screen wanted. Space is claimed only when the
 *   press did not land in a field, and a backgrounded tab pauses itself rather
 *   than integrating the gap the browser hands back on return.
 *
 * There is no audio and there are no assets: two rectangles and a line.
 */

/** Infared. The one accent, on the runner, so the eye has something to hold. */
const RUNNER = '#E52321'
const OBSTACLE = 'rgba(247, 249, 252, 0.62)'
const GROUND = 'rgba(247, 249, 252, 0.22)'
const SCORE_INK = 'rgba(247, 249, 252, 0.72)'

export interface WaitingGameProps {
  /**
   * True whenever the host needs the reader back — a prompt is up, or the wait
   * it was offered against is over. The loop stops and the canvas leaves the
   * document; the run is kept.
   */
  paused: boolean
  /** Puts the game away for the rest of this wait. */
  onDismiss: () => void
}

export default function WaitingGame({ paused, onDismiss }: WaitingGameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const gameRef = useRef<WaitingGameState>(createGame())
  /* The only thing React re-renders for. The score is painted onto the canvas
     with the rest of the frame, so a running game does not re-render at all. */
  const [status, setStatus] = useState<WaitingGameState['status']>('ready')
  const [hidden, setHidden] = useState(false)

  const press = useCallback(() => {
    gameRef.current = jump(gameRef.current)
    setStatus(gameRef.current.status)
  }, [])

  /* A tab put in the background is handed a gap of seconds when it returns.
     The rule clamps a frame, but there is nothing to be gained by running at
     all where nobody is looking. */
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const stopped = paused || hidden

  useEffect(() => {
    if (stopped) {
      gameRef.current = pause(gameRef.current)
      setStatus(gameRef.current.status)
      return undefined
    }
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d') ?? null
    if (canvas === null || context === null) return undefined

    /* Drawn at the device's own resolution, so a 14px runner is not four grey
       pixels on a phone. */
    const ratio = window.devicePixelRatio || 1
    canvas.width = FIELD.width * ratio
    canvas.height = FIELD.height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)

    let frame = 0
    let last = performance.now()
    const draw = (state: WaitingGameState) => {
      context.clearRect(0, 0, FIELD.width, FIELD.height)
      context.fillStyle = GROUND
      context.fillRect(0, FIELD.groundY, FIELD.width, 1)
      context.fillStyle = OBSTACLE
      for (const obstacle of state.obstacles) {
        context.fillRect(
          obstacle.x,
          FIELD.groundY - obstacle.height,
          FIELD.obstacleWidth,
          obstacle.height,
        )
      }
      context.fillStyle = RUNNER
      context.fillRect(
        FIELD.runnerX,
        FIELD.groundY - FIELD.runnerSize - state.y,
        FIELD.runnerSize,
        FIELD.runnerSize,
      )
      context.fillStyle = SCORE_INK
      context.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'right'
      context.fillText(formatScore(score(state)), FIELD.width - 8, 16)
    }

    const step = (now: number) => {
      const elapsed = now - last
      last = now
      gameRef.current = tick(gameRef.current, elapsed)
      draw(gameRef.current)
      setStatus((previous) =>
        previous === gameRef.current.status ? previous : gameRef.current.status,
      )
      frame = window.requestAnimationFrame(step)
    }
    frame = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frame)
  }, [stopped])

  useEffect(() => {
    if (stopped) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' && event.key !== 'ArrowUp') return
      /* Never taken out of a field. Nothing on this screen is editable while a
         claim runs, but a game must not be the reason that ever bites. */
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return
      // Space scrolls a page; here it jumps and does nothing else.
      event.preventDefault()
      press()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, stopped])

  if (stopped) return null

  const prompt =
    status === 'over'
      ? 'Caught. Press to go again'
      : status === 'ready'
        ? 'Press space, or tap, to jump'
        : `Best ${formatScore(gameRef.current.best)}`

  return (
    <div className="mngame">
      <div className="mngame-head">
        <span className="mngame-title">While you wait</span>
        <button
          type="button"
          className="mngame-close"
          onClick={onDismiss}
          aria-label="Close the game"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      {/* The canvas carries no information a person needs, so it is hidden
          from assistive technology entirely rather than described badly. The
          claim's own progress is the live region above it, and it stays that
          way. */}
      <canvas
        ref={canvasRef}
        className="mngame-canvas"
        width={FIELD.width}
        height={FIELD.height}
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault()
          press()
        }}
      />
      <p className="mngame-prompt">{prompt}</p>
    </div>
  )
}
