import { AlertTriangle, Coins, Gem, Layers, Moon, RefreshCw } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

/* Naming a colour, ordering a balance list, and deciding which of the two
   shelves a holding belongs on. All pure, all drilled, and all free of the
   wallet SDK — see `lib/colour.ts`. */
import {
  describeColours,
  describeItem,
  type ItemArt,
  NIGHT_COLOUR_HEX,
  nftTitle,
  sortTokenHoldings,
  splitHoldings,
  TOKENS_VISIBLE,
} from '../lib/colour.js'
import { type PassportNetwork } from './NetworkSwitcher.js'
import ThemeToggle from './ThemeToggle.js'
import type { HomeScreenProps } from './Home.js'
import {
  assetsOnTheWay,
  assetsOnTheWayLine,
  type OnTheWayCandidate,
} from './assetsOnTheWay.js'
/* Whether the opening balance is still coming. Pure — see `lib/activation.ts`. */
import { openingBalanceOnTheWay } from '../lib/activation.js'
/* When to read the account again, so a figure that moves on the chain moves on
   this screen without a reload. Rules in `lib/balanceWatch.ts`, wiring in
   `useBalanceWatch.ts`. */
import { accountHoldsSomething, holdingsSignature } from '../lib/balanceWatch.js'
import { useBalanceWatch } from './useBalanceWatch.js'
import './assets.css'

/**
 * Assets — everything this Passport holds, on two shelves.
 *
 * "I want to access that so I can see all the assets my passport holds. Those
 * assets can be NFTs and tokens" (2026/08/31). Home shows a strip of balance
 * cards because a balance is context for the two things Home is FOR, sending
 * and receiving; it was never a place to go and look at what you have. This
 * screen is that place, and it is the reason the bar grew a third tab.
 *
 * WHAT IT SHOWS, AND WHOSE MONEY IT IS
 * ------------------------------------
 * The account-custody contract's own ledger, exactly as Home shows it — the
 * same `account` prop, off the same read. It is NOT the passkey wallet's
 * balances: the wallet is the signer and the fee payer, and is machinery a
 * Passport user is never shown. Nothing on this screen prints an address, a
 * colour in full, or the word DUST.
 *
 * WHY TWO SHELVES, AND WHY THEY LOOK DIFFERENT
 * --------------------------------------------
 * A quantity you spend down and a thing you either have or do not are read
 * differently, and a one-of-a-kind item listed among balances looks like a
 * rounding error. That difference is now in the FORM as well as the section:
 * tokens are a table of line items and items are cards. "The way we show
 * assets on the assets page is not like cards. We show them like line items,
 * so it's a table, and then NFTs can be shown as cards" (2026/09/01, said
 * twice). `classifyHolding` in `lib/colour.ts` is the single authority
 * on which is which, so Home's cards, this screen, and the Send picker cannot
 * disagree about the same holding. The NFTs section is a real section with an
 * honest empty state rather than a hidden one: a person who has been told
 * their Passport can hold items should be able to see the shelf they would
 * land on.
 */

/** The account ledger this screen reads — the same one Home is handed. */
export type AssetsAccount = NonNullable<HomeScreenProps['account']>

export interface AssetsScreenProps {
  /**
   * What the account holds. `null` when this Passport has no account yet —
   * the shelves are then absent rather than showing zeros against something
   * that does not exist, and one line says so.
   */
  account: AssetsAccount | null
  /** Selected network context, mirroring the other tabs' top bars. */
  network?: PassportNetwork
  /**
   * Accepted and ignored since 2026/09/03, when the network switcher went.
   * Kept so the host does not have to change to stop passing it; nothing on
   * this screen can change the network any more. See `NetworkSwitcher.tsx`.
   */
  onSelectNetwork?: (network: PassportNetwork) => void
  /**
   * Re-reads the account's ledger. Offered here because this is the screen a
   * person opens to check what arrived; omit it and no control appears.
   */
  onRefresh?: () => void
  /**
   * The activity trail, so this screen can say what is on its way but has not
   * landed. Optional: omit it and no such line appears.
   */
  activity?: readonly OnTheWayCandidate[]
}

/** One row on either shelf, already named and already classified. */
interface AssetRow {
  key: string
  icon: ReactNode
  /** The ticker, or the four-character handle — never the 64 characters. */
  label: string
  /** The amount, or `null` for a figure that is not known yet. */
  value: string | null
  /** The line beneath: what kind of thing this is, or the shortened colour. */
  unit: string
  /** True when that line is a colour rather than a word about the row. */
  unitIsColour: boolean
  /** Which shelf it landed on. See `classifyHolding`. */
  item: boolean
  /**
   * The picture and the name for a colour this build knows, or `null`.
   *
   * Always `null` on the token shelf: a balance row is a figure to compare,
   * and a picture beside one would be furniture. See `describeItem`.
   */
  art?: ItemArt | null
}

export default function AssetsScreen(props: AssetsScreenProps) {
  const { account, onRefresh, activity } = props

  /* What has been announced and has not landed. One line under the token
     shelf, from the trail, gone the moment the balances themselves say it —
     plus the opening balance, which is on its way from the moment this
     Passport has an account for it to land in and nothing in it yet. */
  const onTheWay = assetsOnTheWay(activity, {
    openingBalance: openingBalanceOnTheWay({
      hasAccount: Boolean(account),
      holdsNothing: !accountHoldsSomething(account),
      entries: activity ?? [],
    }),
  })
  const onTheWayLine = assetsOnTheWayLine(onTheWay)

  /* Read the account again on its own, so an amount that arrives while this
     shelf is open appears without anybody reloading the page. Home keeps the
     same watch; only one of the two screens is ever mounted. */
  useBalanceWatch({
    active: Boolean(account),
    refresh: onRefresh,
    signature: holdingsSignature(account),
    chaseKey: `${onTheWay.length}|${activity?.[0]?.id ?? ''}|${activity?.[0]?.status ?? ''}`,
  })

  /* Collapsed by default and never remembered, on the same rule Home keeps:
     the list is short for almost every Passport, and a preference that
     outlived the session would be one more thing to explain. */
  const [showAllTokens, setShowAllTokens] = useState(false)

  /**
   * Both shelves, named as ONE screenful.
   *
   * `describeColours` is called across the tokens AND the items together
   * rather than once per section, because the thing it prevents — two rows
   * carrying the same ticker over different money — is a property of what a
   * person can see at once, and both sections are on one screen.
   */
  const { tokens, nfts } = useMemo<{ tokens: AssetRow[]; nfts: AssetRow[] }>(() => {
    if (!account) return { tokens: [], nfts: [] }
    const sponsored = account.stablecoin
      ? { colourHex: account.stablecoin.colourHex, symbol: account.stablecoin.symbol }
      : null

    /* NIGHT, then the sponsor's own colour, then everything else in the order
       `sortTokenHoldings` puts it — the same order Home's strip uses, so a
       colour does not move between the two screens. */
    const held: {
      colourHex: string
      amount: bigint
      icon: ReactNode
      value: string | null
      item: boolean
    }[] = [
      {
        colourHex: NIGHT_COLOUR_HEX,
        amount: 0n,
        icon: <Moon size={14} aria-hidden="true" />,
        value: account.nightBalance,
        item: false,
      },
    ]
    if (account.stablecoin) {
      held.push({
        colourHex: account.stablecoin.colourHex,
        amount: account.stablecoin.amount,
        icon: <Coins size={14} aria-hidden="true" />,
        value: account.stablecoin.amount.toString(),
        item: false,
      })
    }
    /* Sorted FIRST, split second: the split preserves whatever order it is
       given, so the shelves inherit the order a reader can predict. */
    const sorted = sortTokenHoldings(account.otherShielded, sponsored)
    const shelved = splitHoldings(sorted, sponsored)
    for (const other of shelved.tokens) {
      held.push({
        colourHex: other.colourHex,
        amount: other.amount,
        icon: <Layers size={14} aria-hidden="true" />,
        value: other.amount.toString(),
        item: false,
      })
    }
    for (const item of shelved.nfts) {
      held.push({
        colourHex: item.colourHex,
        amount: item.amount,
        icon: <Gem size={14} aria-hidden="true" />,
        /* An item is not a quantity, so its card does not carry one. The
           amount IS one — that is what filed it here — and "1 of 1" is what
           says so without printing a balance beside a thing that has none. */
        value: '1 of 1',
        item: true,
      })
    }

    const identities = describeColours(
      held.map((row) => row.colourHex),
      sponsored,
    )
    const rows = held.map((row, index) => {
      /* The art, where this build has any for the colour. A registry hit is
         the exception — most items are colours nothing has ever heard of — so
         `null` is the ordinary answer and the generic card below is the
         ordinary card. See `describeItem`. */
      const art = row.item ? describeItem(row.colourHex) : null
      return {
      key: row.colourHex,
      icon: row.icon,
      art,
      /* A known item leads with its own name. Everything else is re-nouned off
         the SAME handle the naming authority gave the colour: on a card whose
         job is to say "one of a kind", the first word must not be "Token".
         See `nftTitle`. */
      label: art ? art.title : row.item ? nftTitle(identities[index].symbol) : identities[index].symbol,
      value: row.value,
      /* Both shelves take their subtitle from the naming authority: a ticker
         gets "stablecoin", a colour nobody can name gets the shortened colour,
         and NOTHING gets the 64 characters. A known item overrides it with a
         sentence about the thing, which is the same kind of answer the ticker
         rows get and a better one than four characters of colour. */
      unit: art ? art.description : identities[index].name,
      /* Which of those two the subtitle is, so the card can set a WORD like a
         label and DATA like data. See `.mnassets-card-unit-colour`. */
      unitIsColour: !art && !identities[index].known,
      item: row.item,
      }
    })
    return {
      tokens: rows.filter((row) => !row.item),
      nfts: rows.filter((row) => row.item),
    }
  }, [account])

  const visibleTokens = showAllTokens ? tokens : tokens.slice(0, TOKENS_VISIBLE)

  /* The account's own read, in the vocabulary the cards already speak: a
     figure still being read is 'Syncing', a read that failed is 'Unavailable',
     and neither is ever a zero. */
  /* Only while there is nothing to show. See Home for why: the account is
     re-read on a timer now, and every read passes through 'loading'. */
  const balancesLoading =
    account?.status === 'idle' || (account?.status === 'loading' && account.nightBalance === null)

  return (
    <section className="mnassets-screen" aria-busy={balancesLoading}>
      <header className="mnassets-bar">
        <img className="mnassets-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <div className="mnassets-bar-actions">
          {/* No network switcher since 2026/09/03 — see `NetworkSwitcher.tsx`. */}
          <ThemeToggle size="sm" />
          {onRefresh ? (
            <button
              type="button"
              className="mnassets-icon-button"
              onClick={onRefresh}
              aria-label="Refresh what your Passport holds"
              title="Refresh"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <header className="mnassets-head">
        <p className="mnassets-kicker">Your Passport</p>
        <h1 className="mnassets-title">Assets</h1>
        <p className="mnassets-lede">
          Everything your Passport holds, on this network. Tokens are balances you can spend;
          items are one of a kind.
        </p>
      </header>

      {account ? (
        <>
          <section className="mnassets-shelf" aria-labelledby="mnassets-tokens-heading">
            <div className="mnassets-shelf-head">
              <h2 className="mnassets-shelf-title" id="mnassets-tokens-heading">
                Tokens
              </h2>
              <span className="mnassets-count">{tokens.length}</span>
            </div>

            {/* LINE ITEMS, NOT CARDS (2026/09/01). "The way we show assets on
                the assets page is not like cards. We show them like line
                items, so it's a table, and then NFTs can be shown as cards" —
                said twice. A balance is one number per name, read down a
                column; a card gives each of them a box, a shadow, and half a
                screen, so six tokens became three scrolls of furniture. NFTs
                keep their cards below, because an item is a thing to look at
                rather than a figure to compare.

                A REAL `<table>`, not a stack of divs that looks like one. The
                column headings are for assistive technology only: the shelf
                heading above already says these are tokens, and a visible
                "Token | Balance" row would be furniture of the kind this
                change is removing — but a screen reader announcing a bare
                two-cell row has nothing to announce it AS. */}
            <table className="mnassets-table">
              <caption className="mnassets-sr">
                Tokens your Passport holds, and how much of each.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="mnassets-sr">
                    Token
                  </th>
                  <th scope="col" className="mnassets-sr">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleTokens.map((row) => (
                  <TokenLine
                    key={row.key}
                    icon={row.icon}
                    label={row.label}
                    value={row.value}
                    unit={row.unit}
                    unitIsColour={row.unitIsColour}
                    loading={balancesLoading}
                  />
                ))}
              </tbody>
            </table>

            {/* THE CAP, exactly as Home keeps it: five, then the rest on
                request and in place. A shelf that grew without bound would
                push the second shelf off the bottom of a phone, and the
                second shelf is half of what this screen is for. */}
            {/* Money that is on its way. Until now this shelf showed only what
                the network had already reported, so the gap between a grant or
                an incoming transfer being announced and the figure changing
                read as nothing happening. */}
            {onTheWayLine ? <p className="mnassets-notice">{onTheWayLine}</p> : null}

            {tokens.length > TOKENS_VISIBLE ? (
              <button
                type="button"
                className="mnassets-more"
                onClick={() => setShowAllTokens((shown) => !shown)}
                aria-expanded={showAllTokens}
              >
                {showAllTokens ? 'Show fewer' : `Show all (${tokens.length})`}
              </button>
            ) : null}

            {account.status === 'unavailable' ? (
              /* FIXED PROSE. The reader's own words go to the console, from
                 Home, where the same failed read is already logged once per
                 distinct message — see `HomeScreenProps.account.error`. */
              <p className="mnassets-notice">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  Your balances could not be read just now. They will refresh once the network
                  answers.
                </span>
              </p>
            ) : null}
          </section>

          <section className="mnassets-shelf" aria-labelledby="mnassets-nfts-heading">
            <div className="mnassets-shelf-head">
              <h2 className="mnassets-shelf-title" id="mnassets-nfts-heading">
                NFTs
              </h2>
              <span className="mnassets-count">{nfts.length}</span>
            </div>

            {nfts.length > 0 ? (
              <div className="mnassets-grid">
                {nfts.map((row) => (
                  <NftCard
                    key={row.key}
                    icon={row.icon}
                    art={row.art ?? null}
                    label={row.label}
                    value={row.value ?? ''}
                    unit={row.unit}
                    unitIsColour={row.unitIsColour}
                  />
                ))}
              </div>
            ) : (
              /* An EMPTY SHELF, not a hidden one. A person told their Passport
                 can hold items should be able to see where one would land —
                 and one sentence saying so is worth more than a section that
                 appears out of nowhere the day something arrives. */
              <p className="mnassets-empty">
                <Gem size={16} aria-hidden="true" />
                <span>No NFTs yet. When your Passport holds one, it appears here.</span>
              </p>
            )}
          </section>
        </>
      ) : (
        /* No account yet. The shelves are absent rather than showing zeros
           against something that does not exist — the same rule Home keeps
           for its balance strip. */
        <p className="mnassets-empty">
          <Gem size={16} aria-hidden="true" />
          <span>
            Your Passport account is still being set up. What it holds appears here as soon as
            it is ready.
          </span>
        </p>
      )}
    </section>
  )
}

interface TokenLineProps {
  icon: ReactNode
  label: string
  value: string | null
  unit: string
  /** True when `unit` is a shortened colour rather than a word about the row. */
  unitIsColour: boolean
  loading: boolean
}

/**
 * ONE TOKEN, ONE LINE.
 *
 * The name on the left with its subtitle under it, the balance hard right in
 * tabular figures. Right-aligned and tabular together are what let a column of
 * balances be COMPARED at a glance — the digits land on the same grid, so the
 * eye reads magnitude off the length of the number rather than off the words
 * beside it. A left-aligned or proportional column is a list of strings that
 * happen to be numeric.
 *
 * The `<th scope="row">` is not decoration: it is what makes a screen reader
 * announce "NIGHT, 0.002" rather than "0.002" on its own.
 */
function TokenLine(props: TokenLineProps) {
  const { icon, label, value, unit, unitIsColour, loading } = props
  const unknown = value === null
  return (
    <tr className="mnassets-row">
      <th scope="row" className="mnassets-row-name">
        <span className="mnassets-row-name-inner">
          <span className="mnassets-row-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="mnassets-row-text">
            <span className="mnassets-row-label">{label}</span>
            <span
              className={
                unitIsColour ? 'mnassets-row-unit mnassets-row-unit-colour' : 'mnassets-row-unit'
              }
              /* A colour is an identifier, not prose. Marked so a browser's
                 page translation leaves it alone — a "translated" hex string
                 would be a different colour, and this line is the only thing
                 telling two otherwise identical rows apart. */
              {...(unitIsColour ? { translate: 'no' as const } : {})}
            >
              {unit}
            </span>
          </span>
        </span>
      </th>
      <td className={`mnassets-row-value${unknown ? ' mnassets-row-value-muted' : ''}`}>
        {unknown ? (loading ? 'Syncing' : 'Unavailable') : value}
      </td>
    </tr>
  )
}

interface NftCardProps {
  icon: ReactNode
  /** The picture and the name, where this build knows the colour. */
  art: ItemArt | null
  label: string
  value: string
  unit: string
  /** True when `unit` is a shortened colour rather than a word about the row. */
  unitIsColour: boolean
}

/**
 * ONE ITEM, ONE CARD — the half of the shelf that stayed a card, deliberately.
 *
 * A balance is a figure to compare against the figure above it, which is what
 * the table is for. An item is not a figure at all: there is exactly one of it,
 * "1 of 1" is the whole of its quantity, and what a person wants from it is to
 * SEE the thing. A card gives it the surface to be seen on, and it is the only
 * thing on this screen that gets one.
 */
function NftCard(props: NftCardProps) {
  const { icon, art, label, value, unit, unitIsColour } = props
  return (
    <article className="mnassets-card mnassets-card-item">
      {/* The picture, where there is one. It leads the card because seeing the
          thing IS what an item card is for, and it is decorative in the
          accessibility sense — the name is right underneath it as text, and a
          screen reader announcing the same words twice is worse than one.
          Same-origin, so an installed Passport shows it offline. */}
      {art ? (
        <p className="mnassets-card-art">
          <img src={art.image} alt="" width={400} height={400} loading="lazy" decoding="async" />
        </p>
      ) : null}
      <p className="mnassets-card-head">
        {icon}
        <span className="mnassets-micro">{label}</span>
      </p>
      <p className="mnassets-card-value">{value}</p>
      <p
        className={
          unitIsColour ? 'mnassets-card-unit mnassets-card-unit-colour' : 'mnassets-card-unit'
        }
        {...(unitIsColour ? { translate: 'no' as const } : {})}
      >
        {unit}
      </p>
    </article>
  )
}
