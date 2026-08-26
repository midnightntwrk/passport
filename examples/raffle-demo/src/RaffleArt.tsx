/* ---------------------------------------------------------------------------
 * VENDORED — kept in step with the Passport app.
 *
 * Source: midnight-passport-dynamic-signing,
 *         examples/passport-demo/src/screens/RaffleArt.tsx
 * Vendored: 2026/08/06
 * ------------------------------------------------------------------------- */

/**
 * The raffle illustration — a torn-stub raffle ticket with a small prize
 * starburst, drawn inline.
 *
 * Inline SVG, deliberately: no image asset to ship, no external request to
 * make, and no third-party mark anywhere in it. Every colour comes from a
 * `tokens.css` custom property, so the drawing follows the theme instead of
 * fighting it — a flat PNG would be legible in exactly one of the two.
 */
export default function RaffleArt({
  className,
  title,
}: {
  className?: string
  /** Accessible name. Omit on decorative uses; the SVG then hides itself. */
  title?: string
}) {
  return (
    <svg
      className={className ? `mnraffle-art ${className}` : 'mnraffle-art'}
      viewBox="0 0 96 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Ticket body. The notches are drawn as two circles knocked out of the
          plate, which keeps the stub edge crisp at any size. */}
      <defs>
        <mask id="mnraffle-notches">
          <rect x="0" y="0" width="96" height="64" fill="#fff" />
          <circle cx="60" cy="14" r="5" fill="#000" />
          <circle cx="60" cy="50" r="5" fill="#000" />
        </mask>
      </defs>

      <g mask="url(#mnraffle-notches)">
        <rect
          x="8"
          y="14"
          width="74"
          height="36"
          rx="7"
          className="mnraffle-plate"
        />
        <rect
          x="8"
          y="14"
          width="74"
          height="36"
          rx="7"
          className="mnraffle-edge"
        />
      </g>

      {/* The tear line between ticket and stub. */}
      <path d="M60 21v6M60 31v6M60 41v6" className="mnraffle-tear" />

      {/* Three copy rules standing in for the ticket's own text. */}
      <path d="M18 26h30M18 32h22M18 38h26" className="mnraffle-rules" />

      {/* Prize starburst on the stub. */}
      <path
        d="M71 28.5v7M67.5 32h7M69 29.5l4 5M73 29.5l-4 5"
        className="mnraffle-spark"
      />
      <circle cx="71" cy="32" r="9.5" className="mnraffle-halo" />
    </svg>
  )
}
