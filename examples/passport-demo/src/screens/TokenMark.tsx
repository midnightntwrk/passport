import { useSyncExternalStore, type ReactNode } from 'react'

import type { TokenIdentity, TokenMarkArt } from '../lib/colour.js'
import { getResolvedTheme, subscribeToTheme, type ResolvedTheme } from '../lib/theme.js'
import './token-mark.css'

/**
 * A token's own mark, on whichever surface it is standing on.
 *
 * WHY THIS EXISTS
 * ---------------
 * NIGHT and the two dollar stablecoins were drawn as generic `lucide` glyphs —
 * a moon, a stack of coins — chosen because they were to hand rather than
 * because they said anything. A moon is not the Midnight symbol and a stack of
 * coins is not a dollar: a reader who knows what these assets look like was
 * being asked to read the ticker to find out which one they were looking at,
 * which is the whole job the mark was there to do.
 *
 * So the three colours this build can name now carry their real artwork — the
 * brand pack's Midnight symbol and the USD-coin mark — and everything else
 * keeps the glyph it had. `lib/colour.ts` is the single authority on which is
 * which, exactly as it already is for the ticker and the subtitle, so Home,
 * Assets, and the Send sheet cannot disagree about the same holding.
 *
 * WHY IT SUBSCRIBES TO THE THEME
 * ------------------------------
 * The Midnight symbol is supplied as two files, black and white, and the row
 * it sits in has a card-coloured disc behind it: the black one vanishes on a
 * dark build and the white one vanishes on a light one. The mark is artwork
 * rather than a glyph, so it cannot be recoloured with `currentColor` — the
 * pack ships the colour way, and picking it is the only correct move.
 *
 * The preference is not simply read once: 'system' resolves through
 * `matchMedia`, so a reader who has never touched the control still flips when
 * their operating system does, and `subscribeToTheme` is what hears it. See
 * `lib/theme.ts`.
 */

export interface TokenMarkProps {
  /** The two colour ways, from `describeColour`. */
  mark: TokenMarkArt
  /**
   * The ticker, used as the image's alternative text.
   *
   * Every row in Passport that draws a mark also prints this ticker as text
   * immediately beside it, and those call sites hide the mark from assistive
   * technology so it is not announced twice. The alt is still the ticker
   * rather than empty, so a mark placed somewhere that does NOT repeat it
   * announces as the thing it is instead of as nothing.
   */
  symbol: string
  /** Edge length in CSS pixels. 18 sits well inside the 30 px row disc. */
  size?: number
}

function subscribe(onChange: () => void): () => void {
  return subscribeToTheme(onChange)
}

function getSnapshot(): ResolvedTheme {
  return getResolvedTheme()
}

/** Light, matching `DEFAULT_THEME` — see `lib/theme.ts`. */
function getServerSnapshot(): ResolvedTheme {
  return 'light'
}

export default function TokenMark(props: TokenMarkProps) {
  const { mark, symbol, size = 18 } = props
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return (
    <img
      className="mn-token-mark"
      src={theme === 'dark' ? mark.dark : mark.light}
      alt={symbol}
      width={size}
      height={size}
      decoding="async"
      draggable={false}
    />
  )
}

/**
 * The mark for an identity, or the glyph that surface drew before marks
 * existed.
 *
 * A one-line helper rather than a condition repeated at each call site: three
 * screens ask this same question about the same three colours, and the point
 * of `lib/colour.ts` owning the answer is undone by three slightly different
 * ways of asking it.
 */
export function tokenMarkFor(
  identity: TokenIdentity,
  fallback: ReactNode,
  size?: number,
): ReactNode {
  const { mark } = identity
  if (!mark) return fallback
  return <TokenMark mark={mark} symbol={identity.symbol} size={size} />
}
